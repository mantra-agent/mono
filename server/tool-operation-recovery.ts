import { resolveWorkspacePath } from "./fs-utils";
import type { ToolFailure } from "./tool-failure";

export interface RecoverableToolResult {
  result: string;
  error?: boolean;
  failure?: ToolFailure;
}

type ScratchOperation = {
  kind: "read" | "edit";
  resourceKey: string;
};

type RecoveryState = {
  phase: "read_required" | "retry_allowed" | "quarantined";
  conflictCount: number;
  updatedAt: number;
};

const RECOVERY_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_RECOVERY_ENTRIES = 256;

function scratchAction(toolName: string, args: Record<string, unknown>): "read" | "edit" | null {
  if (toolName === "read_scratch") return "read";
  if (toolName === "edit_scratch") return "edit";
  if (toolName !== "scratch") return null;

  const action = typeof args.action === "string" ? args.action : "";
  return action === "read" || action === "edit" ? action : null;
}

export function resolveScratchOperation(
  toolName: string,
  args: Record<string, unknown>,
): ScratchOperation | null {
  const kind = scratchAction(toolName, args);
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!kind || !path) return null;

  const resolvedPath = resolveWorkspacePath(path);
  if (!resolvedPath) return null;

  return {
    kind,
    resourceKey: `file:${resolvedPath}`,
  };
}

export class ToolOperationRecovery {
  private readonly states = new Map<string, RecoveryState>();
  private readonly operationTails = new Map<string, Promise<void>>();

  async execute<T extends RecoverableToolResult>(
    runId: string,
    toolName: string,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
  ): Promise<T | RecoverableToolResult> {
    const operation = resolveScratchOperation(toolName, args);
    if (!operation) return execute();

    const operationKey = this.key(runId, operation.resourceKey);
    const previous = this.operationTails.get(operationKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.operationTails.set(operationKey, tail);

    await previous;
    try {
      const blocked = this.beforeExecution(runId, toolName, args);
      if (blocked) return blocked;

      const result = await execute();
      this.afterExecution(runId, toolName, args, result);
      return result;
    } finally {
      release();
      if (this.operationTails.get(operationKey) === tail) {
        this.operationTails.delete(operationKey);
      }
    }
  }

  beforeExecution(
    runId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): RecoverableToolResult | null {
    this.prune();
    const operation = resolveScratchOperation(toolName, args);
    if (!operation || operation.kind !== "edit") return null;

    const state = this.states.get(this.key(runId, operation.resourceKey));
    if (!state || state.phase === "retry_allowed") return null;

    if (state.phase === "read_required") {
      return {
        result:
          "scratch.edit is blocked for this file until scratch.read succeeds on the same path. " +
          "Rebuild the replacement from the current file contents; do not guess another old_string.",
        error: true,
        failure: {
          code: "scratch_edit_read_required",
          kind: "deterministic_conflict",
          operation: "scratch.edit",
          resourceKey: operation.resourceKey,
          recovery: "read_then_retry",
        },
      };
    }

    return {
      result:
        "scratch.edit is quarantined for this file for the remainder of the run after two exact-match conflicts. " +
        "Continue with other work or report the unresolved edit; further edit attempts will not touch disk.",
      error: true,
      failure: {
        code: "scratch_edit_quarantined",
        kind: "deterministic_conflict",
        operation: "scratch.edit",
        resourceKey: operation.resourceKey,
        recovery: "quarantined",
      },
    };
  }

  afterExecution(
    runId: string,
    toolName: string,
    args: Record<string, unknown>,
    result: RecoverableToolResult,
  ): void {
    const operation = resolveScratchOperation(toolName, args);
    if (!operation) return;

    const stateKey = this.key(runId, operation.resourceKey);
    const current = this.states.get(stateKey);
    const now = Date.now();

    if (operation.kind === "read") {
      if (!result.error && current?.phase === "read_required") {
        this.states.set(stateKey, { ...current, phase: "retry_allowed", updatedAt: now });
      }
      return;
    }

    if (!result.error) {
      this.states.delete(stateKey);
      return;
    }

    if (
      result.failure?.code !== "scratch_edit_not_found" &&
      result.failure?.code !== "scratch_edit_ambiguous"
    ) {
      return;
    }

    const conflictCount = (current?.conflictCount ?? 0) + 1;
    this.states.set(stateKey, {
      phase: conflictCount >= 2 ? "quarantined" : "read_required",
      conflictCount,
      updatedAt: now,
    });
    this.prune();
  }

  private key(runId: string, resourceKey: string): string {
    return `${runId}:${resourceKey}`;
  }

  private prune(): void {
    const cutoff = Date.now() - RECOVERY_TTL_MS;
    for (const [key, state] of this.states) {
      if (state.updatedAt < cutoff) this.states.delete(key);
    }

    while (this.states.size > MAX_RECOVERY_ENTRIES) {
      const oldest = this.states.keys().next().value;
      if (typeof oldest !== "string") break;
      this.states.delete(oldest);
    }
  }
}
