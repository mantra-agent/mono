import crypto from "crypto";
import { safeStringify } from "./utils/safe-stringify";

export type ConvergenceTerminalMove = "synthesize" | "blocked" | "fail";

export interface RunConvergenceConfig {
  maxNoProgressRefreshes: number;
  maxRepeatedSignature: number;
  maxNoProgressCycles: number;
}

export interface RunConvergenceState {
  refreshCount: number;
  noProgressRefreshes: number;
  noProgressCycles: number;
  signatureCounts: Map<string, number>;
  evidenceHashes: Set<string>;
  lastProgressEvidence: string[];
  terminalRequired: boolean;
  terminalReason?: string;
}

const boundedInt = (name: string, fallback: number, min = 1, max = 100): number => {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

export function getRunConvergenceConfig(): RunConvergenceConfig {
  return {
    maxNoProgressRefreshes: boundedInt("AGENT_CONVERGENCE_MAX_NO_PROGRESS_REFRESHES", 3),
    maxRepeatedSignature: boundedInt("AGENT_CONVERGENCE_MAX_REPEATED_SIGNATURE", 4),
    maxNoProgressCycles: boundedInt("AGENT_CONVERGENCE_MAX_NO_PROGRESS_CYCLES", 5),
  };
}

export function createRunConvergenceState(): RunConvergenceState {
  return {
    refreshCount: 0,
    noProgressRefreshes: 0,
    noProgressCycles: 0,
    signatureCounts: new Map(),
    evidenceHashes: new Set(),
    lastProgressEvidence: [],
    terminalRequired: false,
  };
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/^(toolCallId|requestId|runId|timestamp|ts|cursor|pageToken)$/i.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, normalize(child)]));
}

export function normalizedInvocationSignature(name: string, input: Record<string, unknown>): string {
  const canonical = `${name.trim().toLowerCase()}:${safeStringify(normalize(input), { maxBytes: 16_000 })}`;
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function evidenceHash(content: unknown): string {
  return crypto.createHash("sha256").update(safeStringify(content, { maxBytes: 32_000 })).digest("hex").slice(0, 16);
}

const READ_ACTIONS = /^(get|list|read|search|query|status|count|preview|resolve|lookup|find|fetch|current|forecast|hourly|alerts|historical|summary|metrics|records|holdings|transactions|budget|income|recurring)$/i;

export function isDurableMutation(name: string, input: Record<string, unknown>, failed: boolean): boolean {
  if (failed) return false;
  const action = typeof input.action === "string" ? input.action : "";
  if (action) return !READ_ACTIONS.test(action) && !/^(test|screenshot|analyze|eval)$/i.test(action);
  return /^(tasks|goals|people|library|git|plan|work|decisions|rules|timers|hooks|content|gmail|meetings|health|finance|platforms)/i.test(name);
}

export function terminalDirective(reason: string): string {
  return `[RUN CONVERGENCE CONTROL]\nA deterministic convergence threshold was reached (${reason}). Do not call another tool or request another context refresh. Make exactly one explicit terminal move now:\n1. Synthesize the best supported answer from admitted evidence;\n2. State the genuine blocked dependency or bounded clarification needed; or\n3. Fail explicitly with this convergence reason if no supported answer or real dependency exists.\nBe specific and do not imply work completed without evidence.`;
}
