import { createHash } from "crypto";
import { readFile } from "fs/promises";
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

function isScratchConflict(failure: ToolFailure | null | undefined): failure is ToolFailure {
  return failure?.code === "scratch_edit_not_found" || failure?.code === "scratch_edit_ambiguous";
}

const SCRATCH_CONFLICT_EXCERPT_RADIUS = 4;
const SCRATCH_CONFLICT_EXCERPT_MAX_CHARS = 900;

function scratchReadRequiredMessage(path: string): string {
  return [
    `Scratch edit conflict for ${path}.`,
    "Do not retry this same old_string.",
    "Call scratch(action: \"read\") on this path, rebuild old_string from the current file bytes, then edit once.",
  ].join(" ");
}

function scratchQuarantinedMessage(path: string): string {
  return `Scratch edit conflict for ${path} persisted after a current read and one retry. This exact operation is quarantined for the rest of the run; do not retry it again.`;
}

/** Prefer a locus near the intended old_string; fall back to file head. */
function buildScratchConflictExcerpt(content: string, oldString: string): string {
  const lines = content.split("\n");
  if (lines.length === 0) return "(empty file)";

  const needle = oldString.trim();
  let center = 0;
  if (needle.length > 0) {
    const firstNeedleLine = needle.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
    if (firstNeedleLine.length > 0) {
      const hit = lines.findIndex((line) => line.includes(firstNeedleLine));
      if (hit >= 0) center = hit;
    }
  }

  const start = Math.max(0, center - SCRATCH_CONFLICT_EXCERPT_RADIUS);
  const end = Math.min(lines.length, center + SCRATCH_CONFLICT_EXCERPT_RADIUS + 1);
  let excerpt = lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}|${line}`)
    .join("\n");
  if (excerpt.length > SCRATCH_CONFLICT_EXCERPT_MAX_CHARS) {
    excerpt = `${excerpt.slice(0, SCRATCH_CONFLICT_EXCERPT_MAX_CHARS)}\n…`;
  }
  return `Current file excerpt (lines ${start + 1}-${end} of ${lines.length}):\n${excerpt}`;
}

async function appendScratchConflictExcerpt(
  result: RecoverableToolResult,
  args: Record<string, unknown>,
  path: string,
): Promise<RecoverableToolResult> {
  try {
    const content = await readFile(path, "utf-8");
    const oldString = typeof args.old_string === "string" ? args.old_string : "";
    const excerpt = buildScratchConflictExcerpt(content, oldString);
    return {
      ...result,
      result: `${result.result}\n\n${excerpt}`,
    };
  } catch {
    return result;
  }
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
      return this.classifyDeterministicFailure(toolName, args, result);
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
      return this.classifyDeterministicFailure("scratch", args, result);
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
      return appendScratchConflictExcerpt(
        {
          result: `${result.result}\n\n${scratchReadRequiredMessage(target)}`,
          error: true,
          failure: result.failure,
          recoveryDecision: "read_required",
        },
        args,
        target,
      );
    }

    if (existing.phase === "read_required") {
      // Blind retry before a fresh read — hard non-retry signal with locus.
      return appendScratchConflictExcerpt(
        {
          result: scratchReadRequiredMessage(target),
          error: true,
          failure: result.failure,
          recoveryDecision: "read_required",
        },
        args,
        target,
      );
    }

    if (existing.phase === "retry_allowed") {
      existing.phase = "quarantined";
      this.scratchStates.set(key, existing);
      return appendScratchConflictExcerpt(
        {
          result: `${result.result}\n\n${scratchQuarantinedMessage(target)}`,
          error: true,
          failure: result.failure,
          recoveryDecision: "quarantined",
        },
        args,
        target,
      );
    }

    return {
      result: scratchQuarantinedMessage(target),
      error: true,
      failure: result.failure,
      recoveryDecision: "quarantined",
    };
  }

  /**
   * First-hit vs exact-repeat classification for deterministic tool failures.
   *
   * - Exact repeat of a remembered fingerprint → quarantine (circuit breaker).
   * - First observation of a permission failure → quarantine immediately
   *   (rewriting args cannot restore authority inside this run).
   * - First observation of an input failure → surface as a normal tool error
   *   and remember the fingerprint so an identical retry quarantines.
   *
   * Quarantine is operation-local for input failures (including shell_policy_denied
   * exact-repeats): AgentExecutor must refuse the repeat without stopping the run.
   * Only permission quarantine is run-terminal — authority cannot be restored in-run.
   */
  private classifyDeterministicFailure(
    toolName: string,
    args: Record<string, unknown>,
    result: RecoverableToolResult,
  ): RecoverableToolResult {
    if (!result.error || !isDeterministicToolFailure(result.failure) || !result.failure) {
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
    if (result.failure.kind === "permission") {
      return { ...result, recoveryDecision: "quarantined" };
    }
    return { ...result, recoveryDecision: "none" };
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
