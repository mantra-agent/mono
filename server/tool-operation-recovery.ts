import { createHash } from "crypto";
import { resolveWorkspacePath } from "./fs-utils";
import { isDeterministicToolFailure, type ToolFailure } from "./tool-failure";

export type ToolRecoveryDecision =
  | "none"
  | "read_required"
  | "retry_allowed"
  | "quarantined";

export interface RecoverableToolResult {
  result: string;
  error?: boolean;
  failure?: ToolFailure;
  recoveryDecision?: ToolRecoveryDecision;
}

type ScratchRecoveryPhase = "read_required" | "retry_allowed" | "quarantined";

interface ScratchConflictState {
  fingerprint: string;
  phase: ScratchRecoveryPhase;
  path: string;
  readVersion?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function operationFingerprint(
  toolName: string,
  args: Record<string, unknown>,
  failure: ToolFailure,
): string {
  const action = typeof args.action === "string" ? args.action : "";
  const resourceKey = ["id", "taskId", "path", "resource", "target", "filePath"]
    .map((key) => args[key])
    .find((value) => typeof value === "string" || typeof value === "number");
  const normalized = JSON.stringify(canonicalize(args));
  return createHash("sha256")
    .update(`${toolName}:${action}:${String(resourceKey ?? "")}:${failure.code}:${normalized}`)
    .digest("hex");
}

function scratchTargetIdentity(args: Record<string, unknown>): string | null {
  if (typeof args.path !== "string") return null;
  return resolveWorkspacePath(args.path);
}

function scratchConflictFingerprint(
  path: string,
  args: Record<string, unknown>,
  failure: ToolFailure,
): string {
  const oldString = typeof args.old_string === "string" ? args.old_string : "";
  const replaceAll = args.replace_all === true ? "1" : "0";
  return createHash("sha256")
    .update(`${path}:${failure.code}:${replaceAll}:${oldString}`)
    .digest("hex");
}

function blockedRepeatMessage(toolName: string, failure: ToolFailure): string {
  return `The ${toolName} operation was not retried because the same non-retryable ${failure.kind} failure (${failure.code}) is already quarantined for this run.`;
}

function isScratchConflict(failure: ToolFailure | undefined): failure is ToolFailure {
  return failure?.code === "scratch_edit_not_found" || failure?.code === "scratch_edit_ambiguous";
}

function scratchReadRequiredMessage(path: string): string {
  return `Scratch edit conflict for ${path}. Read the current file before retrying this exact edit once.`;
}

function scratchQuarantinedMessage(path: string): string {
  return `Scratch edit conflict for ${path} persisted after a current read and one retry. This exact operation is quarantined for the rest of the run; do not retry it again.`;
}

export class ToolOperationRecovery {
  private readonly scratchStates = new Map<string, ScratchConflictState>();
  private readonly quarantinedOperations = new Map<string, ToolFailure>();
  private readonly operationQueues = new Map<string, Promise<void>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 256) {
    this.maxEntries = maxEntries;
  }

  async execute(
    runId: string,
    toolName: string,
    args: Record<string, unknown>,
    execute: () => Promise<RecoverableToolResult>,
  ): Promise<RecoverableToolResult> {
    const queueKey = this.queueKey(runId, toolName, args);
    return this.serialize(queueKey, async () => {
      if (toolName === "scratch" && args.action === "read") {
        const result = await execute();
        if (!result.error) this.recordScratchRead(runId, args);
        return { ...result, recoveryDecision: "none" };
      }

      if (toolName === "scratch" && args.action === "edit") {
        return this.executeScratchEdit(runId, args, execute);
      }

      const result = await execute();
      if (!result.error || !isDeterministicToolFailure(result.failure)) {
        return { ...result, recoveryDecision: "none" };
      }

      const fingerprint = operationFingerprint(toolName, args, result.failure);
      const existing = this.quarantinedOperations.get(fingerprint);
      if (existing) {
        return {
          result: blockedRepeatMessage(toolName, existing),
          error: true,
          failure: existing,
          recoveryDecision: "quarantined",
        };
      }

      this.setBounded(this.quarantinedOperations, fingerprint, result.failure);
      return { ...result, recoveryDecision: "quarantined" };
    });
  }

  private async executeScratchEdit(
    runId: string,
    args: Record<string, unknown>,
    execute: () => Promise<RecoverableToolResult>,
  ): Promise<RecoverableToolResult> {
    const target = scratchTargetIdentity(args);
    const result = await execute();
    if (!target || !result.error || !isScratchConflict(result.failure)) {
      if (result.error && isDeterministicToolFailure(result.failure)) {
        const fingerprint = operationFingerprint("scratch", args, result.failure);
        this.setBounded(this.quarantinedOperations, fingerprint, result.failure);
        return { ...result, recoveryDecision: "quarantined" };
      }
      return { ...result, recoveryDecision: "none" };
    }

    const key = `${runId}:${target}`;
    const fingerprint = scratchConflictFingerprint(target, args, result.failure);
    const existing = this.scratchStates.get(key);

    if (!existing || existing.fingerprint !== fingerprint) {
      this.setBounded(this.scratchStates, key, {
        fingerprint,
        phase: "read_required",
        path: target,
      });
      return {
        result: `${result.result}\n\n${scratchReadRequiredMessage(target)}`,
        error: true,
        failure: result.failure,
        recoveryDecision: "read_required",
      };
    }

    if (existing.phase === "read_required") {
      return {
        result: scratchReadRequiredMessage(target),
        error: true,
        failure: result.failure,
        recoveryDecision: "read_required",
      };
    }

    if (existing.phase === "retry_allowed") {
      existing.phase = "quarantined";
      this.scratchStates.set(key, existing);
      return {
        result: `${result.result}\n\n${scratchQuarantinedMessage(target)}`,
        error: true,
        failure: result.failure,
        recoveryDecision: "quarantined",
      };
    }

    return {
      result: scratchQuarantinedMessage(target),
      error: true,
      failure: result.failure,
      recoveryDecision: "quarantined",
    };
  }

  private recordScratchRead(runId: string, args: Record<string, unknown>): void {
    const target = scratchTargetIdentity(args);
    if (!target) return;

    const key = `${runId}:${target}`;
    const state = this.scratchStates.get(key);
    if (!state || state.phase !== "read_required") return;

    state.phase = "retry_allowed";
    state.readVersion = new Date().toISOString();
    this.scratchStates.set(key, state);
  }

  private queueKey(runId: string, toolName: string, args: Record<string, unknown>): string {
    if (toolName === "scratch") {
      const target = scratchTargetIdentity(args);
      if (target) return `${runId}:scratch:${target}`;
    }
    return `${runId}:${toolName}:${typeof args.action === "string" ? args.action : ""}`;
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.operationQueues.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.operationQueues.get(key) === tail) this.operationQueues.delete(key);
    }
  }

  private setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
    if (!map.has(key) && map.size >= this.maxEntries) {
      const oldest = map.keys().next().value as K | undefined;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
  }
}
