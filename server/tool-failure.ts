import { createHash } from "node:crypto";

export type ToolFailureKind = "input" | "permission" | "transient" | "internal";

export interface ToolFailure {
  kind: ToolFailureKind;
  code: string;
  retryable: boolean;
}

export class ToolFailureError extends Error {
  constructor(
    message: string,
    readonly failure: ToolFailure,
  ) {
    super(message);
    this.name = "ToolFailureError";
  }
}

export function toolFailureFromError(error: unknown): ToolFailure | undefined {
  return error instanceof ToolFailureError ? error.failure : undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function operationFailureKey(
  toolName: string,
  input: Record<string, unknown>,
  failure: ToolFailure,
): string {
  const stableTarget =
    input.id ??
    input.taskId ??
    input.projectId ??
    input.milestoneId ??
    input.sessionId ??
    input.title ??
    null;
  const payload = JSON.stringify({
    toolName,
    input: canonicalize(input),
    stableTarget,
    failureKind: failure.kind,
    failureCode: failure.code,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function isDeterministicToolFailure(failure: ToolFailure | undefined): failure is ToolFailure {
  return Boolean(failure && !failure.retryable && (failure.kind === "input" || failure.kind === "permission"));
}
