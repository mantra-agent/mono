import type { ContinuationCapsule } from "@shared/models/chat";
import { parseReferenceText } from "@shared/reference-parser";
import { safeStringify } from "./utils/safe-stringify";

export interface ContinuationCapsuleEntry {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolName?: string;
  toolArguments?: unknown;
  toolResult?: unknown;
  toolCallId?: string;
  isError?: boolean;
}

const CAPSULE_VERSION = 1 as const;
const MAX_SOURCE_CHARS = 8_000;
const MAX_EXCERPT_CHARS = 520;
const MAX_ACTIONS = 18;
const MAX_SECTION_ITEMS = 8;
const MAX_REFERENCES = 40;

const DECISION_PATTERN = /\b(decided|decision|approved|selected|chose|conclusion|verdict|recommend(?:ed|ation)|correct (?:repair|approach)|will use|we will)\b/i;
const FAILURE_PATTERN = /\b(error|failed|failure|timeout|timed out|blocked|interrupted|aborted|unavailable|could not)\b/i;
const OPEN_LOOP_PATTERN = /\b(next|todo|remaining|pending|follow[- ]?up|open loop|open question|blocker|resume|still need|not yet|needs review|awaiting)\b/i;
const STATE_CHANGE_PATTERN = /\b(created|updated|deleted|removed|merged|deployed|published|saved|completed|closed|opened|renamed|migrated|activated|disabled|enabled|status|commit|branch|pull request|\bpr\b|issue|task|timer|hook)\b/i;
const MUTATION_ACTION_PATTERN = /^(create|update|delete|remove|add|merge|set|complete|close|open|save|publish|deploy|activate|disable|enable|rename|link|unlink|resolve|reopen|lock|cancel|trigger|apply|write|edit)/i;
function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "authorization"
    || normalized === "password"
    || normalized.includes("secret")
    || normalized.includes("credential")
    || normalized.includes("privatekey")
    || normalized.includes("apikey")
    || normalized.includes("accesstoken")
    || normalized.includes("refreshtoken")
    || normalized.endsWith("token")
    || normalized.endsWith("cookie");
}

function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth >= 5 || value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 24).map((item) => redactSensitiveValue(item, depth + 1));
  }
  if (typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
    result[key] = isSensitiveKey(key)
      ? "[REDACTED]"
      : redactSensitiveValue(item, depth + 1);
  }
  return result;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function boundedSource(value: unknown, label: string): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value == null) {
    return "";
  } else {
    text = safeStringify(redactSensitiveValue(value), {
      maxBytes: MAX_SOURCE_CHARS,
      maxDepth: 5,
      maxKeys: 24,
      maxArrayItems: 24,
      maxStrLen: 1_200,
      label,
    });
  }
  if (text.length <= MAX_SOURCE_CHARS) return text;
  const headLength = Math.floor(MAX_SOURCE_CHARS * 0.65);
  const tailLength = MAX_SOURCE_CHARS - headLength;
  return `${text.slice(0, headLength)}\n…[middle omitted; exact source archived]…\n${text.slice(-tailLength)}`;
}

function excerpt(value: unknown, label: string, limit = MAX_EXCERPT_CHARS): string {
  const text = collapseWhitespace(boundedSource(value, label));
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function withoutTimestamp(value: string): string {
  return value
    .replace(/^\[[^\]]+\](?:\s+\[page:[^\]]+\])?\s*/i, "")
    .trim();
}

function addUnique(target: string[], value: string | undefined, limit: number): void {
  if (!value || target.length >= limit) return;
  const normalized = collapseWhitespace(value);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (target.some((item) => item.toLowerCase() === key)) return;
  target.push(normalized);
}

function candidateLines(value: string): string[] {
  const bounded = boundedSource(value, "continuation-capsule.message");
  return bounded
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9@\[])/)
    .map((line) => excerpt(withoutTimestamp(line), "continuation-capsule.line"))
    .filter((line) => line.length >= 12);
}

function collectReferences(value: string, references: string[]): void {
  if (references.length >= MAX_REFERENCES * 2) return;
  for (const part of parseReferenceText(boundedSource(value, "continuation-capsule.references"))) {
    if (part.kind !== "reference") continue;
    addUnique(references, part.ref.canonical, MAX_REFERENCES * 2);
  }
}

function actionLabel(entry: ContinuationCapsuleEntry): string {
  const name = entry.toolName || "tool";
  const args = excerpt(entry.toolArguments, "continuation-capsule.tool-args", 280);
  const result = excerpt(entry.toolResult, "continuation-capsule.tool-result", 420);
  const status = entry.isError ? "ERROR" : entry.toolResult == null ? "pending" : "ok";
  return `${name}${args ? `(${args})` : ""} → ${status}${result ? `: ${result}` : ""}`;
}

function mutationLabel(entry: ContinuationCapsuleEntry): string | undefined {
  if (!entry.toolName || entry.isError) return undefined;
  const args = entry.toolArguments && typeof entry.toolArguments === "object"
    ? entry.toolArguments as Record<string, unknown>
    : undefined;
  const action = typeof args?.action === "string" ? args.action : undefined;
  if (!action || !MUTATION_ACTION_PATTERN.test(action)) return undefined;
  const result = excerpt(entry.toolResult, "continuation-capsule.mutation-result", 360);
  return `${entry.toolName}.${action}${result ? `: ${result}` : ""}`;
}

function trimToRecent(values: string[], limit: number): string[] {
  if (values.length <= limit) return values;
  return values.slice(-limit);
}

export function buildContinuationCapsule(
  entries: ContinuationCapsuleEntry[],
  previous?: ContinuationCapsule,
): ContinuationCapsule {
  const actions: string[] = [];
  const systemsTouched: string[] = [];
  const decisions: string[] = [];
  const stateChanges: string[] = [];
  const failures: string[] = [];
  const openLoops: string[] = [];
  const references: string[] = [];
  const messageEntries = entries.filter((entry) => entry.role !== "tool" && entry.content?.trim());
  const toolEntries = entries.filter((entry) => entry.role === "tool" || entry.toolName);

  const firstUser = messageEntries.find((entry) => entry.role === "user");
  const firstNonSystem = messageEntries.find((entry) => entry.role !== "system");
  const objectiveSource = firstUser?.content || firstNonSystem?.content;
  const objective = previous?.objective || (objectiveSource
    ? excerpt(withoutTimestamp(objectiveSource), "continuation-capsule.objective", 700)
    : undefined);
  const initiator = previous?.initiator || (firstNonSystem?.role === "user"
    ? "User-directed"
    : firstNonSystem?.role === "assistant"
      ? "Agent-directed"
      : undefined);

  for (const action of previous?.actions || []) addUnique(actions, action, MAX_ACTIONS * 2);
  for (const system of previous?.systemsTouched || []) addUnique(systemsTouched, system, MAX_SECTION_ITEMS * 2);
  for (const decision of previous?.decisions || []) addUnique(decisions, decision, MAX_SECTION_ITEMS * 2);
  for (const change of previous?.stateChanges || []) addUnique(stateChanges, change, MAX_SECTION_ITEMS * 2);
  for (const failure of previous?.failures || []) addUnique(failures, failure, MAX_SECTION_ITEMS * 2);
  for (const openLoop of previous?.openLoops || []) addUnique(openLoops, openLoop, MAX_SECTION_ITEMS * 2);
  for (const reference of previous?.references || []) addUnique(references, reference, MAX_REFERENCES * 2);

  let latestAssistant: string | undefined;
  let latestUser: string | undefined;

  for (const entry of messageEntries) {
    const content = entry.content || "";
    collectReferences(content, references);
    const contentExcerpt = excerpt(withoutTimestamp(content), "continuation-capsule.message-excerpt", 700);
    if (entry.role === "assistant") latestAssistant = contentExcerpt || latestAssistant;
    if (entry.role === "user") latestUser = contentExcerpt || latestUser;

    for (const line of candidateLines(content)) {
      if (FAILURE_PATTERN.test(line)) addUnique(failures, line, MAX_SECTION_ITEMS * 2);
      if (DECISION_PATTERN.test(line)) addUnique(decisions, line, MAX_SECTION_ITEMS * 2);
      if (OPEN_LOOP_PATTERN.test(line)) addUnique(openLoops, line, MAX_SECTION_ITEMS * 2);
      if (STATE_CHANGE_PATTERN.test(line) && !FAILURE_PATTERN.test(line)) {
        addUnique(stateChanges, line, MAX_SECTION_ITEMS * 2);
      }
    }
  }

  for (const entry of toolEntries) {
    addUnique(systemsTouched, entry.toolName, MAX_SECTION_ITEMS * 2);
    collectReferences(boundedSource(entry.toolArguments, "continuation-capsule.tool-args-refs"), references);
    collectReferences(boundedSource(entry.toolResult, "continuation-capsule.tool-result-refs"), references);
    actions.push(actionLabel(entry));
    const mutation = mutationLabel(entry);
    if (mutation) addUnique(stateChanges, mutation, MAX_SECTION_ITEMS * 2);
    if (entry.isError) addUnique(failures, actionLabel(entry), MAX_SECTION_ITEMS * 2);
  }

  const boundedActions = trimToRecent(actions, MAX_ACTIONS);
  const boundedOpenLoops = trimToRecent(openLoops, MAX_SECTION_ITEMS);
  const resumePoint = boundedOpenLoops.at(-1)
    || latestAssistant
    || latestUser
    || previous?.resumePoint
    || (boundedActions.length > 0 ? `Continue after ${boundedActions.at(-1)}` : undefined);

  return {
    version: CAPSULE_VERSION,
    initiator,
    objective,
    actions: boundedActions,
    systemsTouched: trimToRecent(systemsTouched, MAX_SECTION_ITEMS),
    decisions: trimToRecent(decisions, MAX_SECTION_ITEMS),
    stateChanges: trimToRecent(stateChanges, MAX_SECTION_ITEMS),
    failures: trimToRecent(failures, MAX_SECTION_ITEMS),
    openLoops: boundedOpenLoops,
    references: trimToRecent(references, MAX_REFERENCES),
    resumePoint,
    sourceMessageCount: (previous?.sourceMessageCount || 0) + messageEntries.length,
    sourceActionCount: (previous?.sourceActionCount || 0) + toolEntries.length,
  };
}

function markdownList(title: string, values: string[]): string[] {
  if (values.length === 0) return [];
  return [`## ${title}`, ...values.map((value) => `- ${value}`), ""];
}

export function renderContinuationCapsule(capsule: ContinuationCapsule): string {
  const lines: string[] = ["[Continuation Capsule]", ""];
  if (capsule.initiator) lines.push("## Initiator", capsule.initiator, "");
  if (capsule.objective) lines.push("## Objective", capsule.objective, "");
  lines.push(...markdownList("Actions completed", capsule.actions));
  lines.push(...markdownList("Systems touched", capsule.systemsTouched));
  lines.push(...markdownList("Decisions", capsule.decisions));
  lines.push(...markdownList("State changes", capsule.stateChanges));
  lines.push(...markdownList("Failures and blockers", capsule.failures));
  lines.push(...markdownList("Open loops", capsule.openLoops));
  lines.push(...markdownList("References", capsule.references));
  if (capsule.resumePoint) lines.push("## Resume point", capsule.resumePoint, "");
  return lines.join("\n").trim();
}
