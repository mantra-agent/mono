import { resolveScratchResourcePath, scratchResourceKey, scratchResourceLabel } from "./scratch-paths";
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
};

function scratchAction(toolName: string, args: Record<string, unknown>): "read" | "edit" | null {
  if (toolName === "read_scratch") return "read";
  if (toolName === "edit_scratch") return "edit";
  if (toolName !== "scratch") return null;

  const action = typeof args.action === "string" ? args.action : "";
  return action === "read" || action === "edit" ? action : null;
}

export async function resolveScratchOperation(
  toolName: string,
  args: Record<string, unknown>,
): Promise<ScratchOperation | null> {
  const kind = scratchAction(toolName, args);
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!kind || !path) return null;

  const resolvedPath = await resolveScratchResourcePath(path);
  if (!resolvedPath) return null;

  return { kind, resourceKey: scratchResourceKey(resolvedPath) };
}

/**
 * Run-scoped state machine for deterministic scratch.edit conflicts.
 * One instance belongs to one AgentExecutor run, so state needs no TTL or LRU:
 * it is released with the run and must never silently reopen quarantine mid-run.
 */
export class ToolOperationRecovery {
  private readonly states = new Map<string, RecoveryState>();
  private readonly operationTails = new Map<string, Promise<void>>();

  async execute<T extends RecoverableToolResult>(
    toolName: string,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
  ): Promise<T | RecoverableToolResult> {
    const operation = await resolveScratchOperation(toolName, args);
    if (!operation) return execute();

    const previous = this.operationTails.get(operation.resourceKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.operationTails.set(operation.resourceKey, tail);

    await previous;
    try {
      const blocked = this.beforeExecution(operation);
      if (blocked) return blocked;

      const result = await execute();
      this.afterExecution(operation, result);
      return result;
    } finally {
      release();
      if (this.operationTails.get(operation.resourceKey) === tail) {
        this.operationTails.delete(operation.resourceKey);
      }
    }
  }

  private beforeExecution(operation: ScratchOperation): RecoverableToolResult | null {
    if (operation.kind !== "edit") return null;

    const state = this.states.get(operation.resourceKey);
    if (!state || state.phase === "retry_allowed") return null;

    if (state.phase === "read_required") {
      return {
        result:
          `scratch.edit is blocked for ${scratchResourceLabel(operation.resourceKey)} until scratch.read succeeds on the same file. ` +
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
        `scratch.edit is quarantined for ${scratchResourceLabel(operation.resourceKey)} for the remainder of the run after two exact-match conflicts. ` +
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

  private afterExecution(operation: ScratchOperation, result: RecoverableToolResult): void {
    const current = this.states.get(operation.resourceKey);

    if (operation.kind === "read") {
      if (!result.error && current?.phase === "read_required") {
        this.states.set(operation.resourceKey, { ...current, phase: "retry_allowed" });
      }
      return;
    }

    if (!result.error) {
      this.states.delete(operation.resourceKey);
      return;
    }

    if (
      result.failure?.code !== "scratch_edit_not_found" &&
      result.failure?.code !== "scratch_edit_ambiguous"
    ) {
      return;
    }

    const conflictCount = (current?.conflictCount ?? 0) + 1;
    this.states.set(operation.resourceKey, {
      phase: conflictCount >= 2 ? "quarantined" : "read_required",
      conflictCount,
    });
  }
}
