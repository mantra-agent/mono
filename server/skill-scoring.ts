import { eventBus } from "./event-bus";
import { chatFileStorage, type FileMessage } from "./chat-file-storage";
import { storage } from "./storage";
import { createLogger } from "./log";
import { extractJson } from "./utils/extract-json";
import type { ChecklistItem, CheckResult, ComparativeResult } from "@shared/schema";
import type { ToolCallInfo } from "@shared/models/chat";

const TRANSCRIPT_CHAR_BUDGET = 200000;
const ARTIFACT_CHAR_BUDGET = 60000;

function serializeToolCalls(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  const parts: string[] = [];
  for (const tc of toolCalls as ToolCallInfo[]) {
    if (!tc || typeof tc !== "object") continue;
    const name = tc.toolName || "unknown_tool";
    const args = tc.arguments !== undefined ? safeJson(tc.arguments) : "";
    let resultText = "";
    if (tc.result !== undefined && tc.result !== null) {
      resultText = typeof tc.result === "string" ? tc.result : safeJson(tc.result);
    } else if (typeof tc.output === "string") {
      resultText = tc.output;
    }
    const errText = tc.error
      ? (typeof tc.error === "string" ? tc.error : safeJson(tc.error))
      : "";
    parts.push(
      `[tool_call name=${name}${tc.status ? ` status=${tc.status}` : ""}]\n` +
      (args ? `arguments: ${args}\n` : "") +
      (resultText ? `result: ${resultText}\n` : "") +
      (errText ? `error: ${errText}\n` : "") +
      `[/tool_call]`
    );
  }
  return parts.join("\n");
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function serializeTranscript(initialSystemPrompt: string | null, messages: FileMessage[]): string {
  const segments: string[] = [];
  if (initialSystemPrompt && initialSystemPrompt.trim()) {
    segments.push(`<message role="system">\n${initialSystemPrompt}\n</message>`);
  }
  for (const m of messages) {
    const inner: string[] = [];
    if (m.thinking && m.thinking.trim()) {
      inner.push(`[thinking]\n${m.thinking}\n[/thinking]`);
    }
    if (m.content && m.content.trim()) {
      inner.push(m.content);
    }
    const tcText = serializeToolCalls(m.toolCalls);
    if (tcText) inner.push(tcText);
    if (inner.length === 0) continue;
    segments.push(`<message role="${m.role}">\n${inner.join("\n\n")}\n</message>`);
  }
  return segments.join("\n\n");
}

function hasAssistantActivity(messages: FileMessage[]): boolean {
  return messages.some((m) => {
    if (m.role !== "assistant") return false;
    if (m.content && m.content.trim()) return true;
    if (m.thinking && m.thinking.trim()) return true;
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) return true;
    return false;
  });
}

function truncateForBudget(transcript: string, budget = TRANSCRIPT_CHAR_BUDGET): string {
  if (transcript.length <= budget) return transcript;
  const remaining = transcript.length - budget;
  return transcript.slice(0, budget) + `\n\n[... transcript continues for ${remaining} more chars ...]`;
}

async function buildSessionTranscript(sessionId: string): Promise<{ transcript: string; hasActivity: boolean }> {
  const { getArtifactsBySession, resolveArtifactContent } = await import("./session-artifacts");

  const [messages, initialSystemPrompt, artifacts] = await Promise.all([
    chatFileStorage.getMessagesBySession(sessionId),
    chatFileStorage.getInitialContext(sessionId),
    getArtifactsBySession(sessionId),
  ]);

  // Build artifact content FIRST so it gets guaranteed space.
  // Artifacts are the skill's primary output — they must not be crowded out
  // by a large system prompt (e.g. large reflection preContext).
  let artifactBlocks = "";
  if (artifacts.length > 0) {
    try {
      const blocks = await resolveArtifactContent(artifacts, ARTIFACT_CHAR_BUDGET);
      if (blocks) {
        artifactBlocks = "\n\n" + blocks;
      }
    } catch (err) {
      log.warn(`buildSessionTranscript: artifact content fetch failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Build full transcript, then truncate to fit remaining budget.
  // Truncation cuts from the end of the transcript (system prompt fills early),
  // preserving assistant messages and tool calls near the tail.
  const fullTranscript = serializeTranscript(initialSystemPrompt, messages);
  const transcriptBudget = TRANSCRIPT_CHAR_BUDGET - artifactBlocks.length;
  const transcript = truncateForBudget(fullTranscript, transcriptBudget) + artifactBlocks;

  return { transcript, hasActivity: hasAssistantActivity(messages) || artifacts.length > 0, messages };
}

const log = createLogger("SkillScoring");

const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { check: "Skill produced meaningful output relevant to its purpose", weight: 1 },
  { check: "No error indicators in output", weight: 1 },
];

/**
 * Single quality-evaluation home. The checklist is the only specification of
 * run quality: deterministic items (kind "tool_invoked") are evaluated here in
 * code, judgment items by the LLM evaluator below. The runner invokes these
 * same deterministic functions at run terminal, so early gating and async
 * scoring can never disagree on an objective check.
 */
export function extractSuccessfulToolInvocations(messages: FileMessage[]): Set<string> {
  const invoked = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.toolCalls)) continue;
    for (const tc of m.toolCalls as ToolCallInfo[]) {
      if (tc && typeof tc.toolName === "string" && tc.status === "done") invoked.add(tc.toolName);
    }
  }
  return invoked;
}

export function evaluateDeterministicItem(item: ChecklistItem, invokedTools: Set<string>): CheckResult | null {
  if (item?.kind !== "tool_invoked" || typeof item.tool !== "string") return null;
  const passed = invokedTools.has(item.tool);
  return {
    check: item.check,
    passed,
    evidence: passed
      ? `Deterministic: tool "${item.tool}" had a successful invocation.`
      : `Deterministic: no successful invocation of tool "${item.tool}" in this run.`,
  };
}

export function registerSkillScoringListener(): void {
  eventBus.on("event", async (busEvent: { event: string; payload: Record<string, unknown> }) => {
    if (busEvent.event !== "chat.autonomous.completed") return;

    const { sessionId, skillId } = busEvent.payload as {
      sessionId?: string;
      skillId?: string;
    };

    if (!sessionId || !skillId) return;

    log.log(`${skillId}: autonomous completed for session ${sessionId} — will score on saved status transition`);
  });

  eventBus.on("event", async (busEvent: { event: string; payload: Record<string, unknown> }) => {
    if (busEvent.event !== "chat.session.status_changed") return;

    const { sessionId, status, previousStatus } = busEvent.payload as {
      sessionId?: string;
      status?: string;
      previousStatus?: string;
    };

    if (!sessionId || status !== "saved" || previousStatus === "saved") return;

    const skillRun = await storage.getSkillRunBySessionId(sessionId);
    if (!skillRun) {
      log.log(`No skill_runs record for session ${sessionId} — skipping scoring`);
      return;
    }

    if (skillRun.passRate != null) {
      log.log(`${skillRun.skillName}: session ${sessionId} already scored, skipping`);
      return;
    }

    try {
      log.log(`${skillRun.skillName}: scoring session ${sessionId} after completion (from skill_runs)`);
      await scoreSkillRun(skillRun.skillName, skillRun.skillName, sessionId, skillRun.durationMs ?? undefined);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to score ${skillRun.skillName} (${sessionId}): ${msg}`);
    }
  });
}

async function scoreSkillRun(
  skillId: string,
  skillName: string,
  sessionId: string,
  durationMs?: number,
): Promise<void> {
  const skill = await storage.getSkillByName(skillId);
  if (!skill) return;

  const skillChecklist: ChecklistItem[] = Array.isArray(skill.checklist) ? skill.checklist as ChecklistItem[] : [];
  const checklist: ChecklistItem[] = skillChecklist.length > 0 ? skillChecklist : DEFAULT_CHECKLIST;

  if (skillChecklist.length === 0) {
    log.log(`${skillId}: no custom checklist defined, using default checklist`);
  }

  const { transcript, hasActivity, messages } = await buildSessionTranscript(sessionId);

  if (!hasActivity) {
    log.warn(`${skillId}: no output found in ${sessionId}, skipping`);
    return;
  }

  // One checklist, two evaluator kinds: deterministic items are computed in
  // code from persisted tool calls; only judgment items go to the LLM. Results
  // merge back in checklist order into a single passRate.
  const invokedTools = extractSuccessfulToolInvocations(messages);
  const deterministicByIndex = new Map<number, CheckResult>();
  checklist.forEach((item, i) => {
    const result = evaluateDeterministicItem(item, invokedTools);
    if (result) deterministicByIndex.set(i, result);
  });
  const judgmentIndexes = checklist.map((_, i) => i).filter((i) => !deterministicByIndex.has(i));
  const judgmentResults = judgmentIndexes.length > 0
    ? await evaluateChecklist(skillId, judgmentIndexes.map((i) => checklist[i]), transcript)
    : [];

  const allParseErrors = judgmentResults.length > 0 && judgmentResults.every((r) => r.evidence === "Evaluation parse error");
  if (allParseErrors) {
    log.warn(`${skillId}: all judgment checklist items returned parse errors for ${sessionId}, skipping score recording`);
    return;
  }

  const checkResults: CheckResult[] = checklist.map((item, i) => {
    const deterministic = deterministicByIndex.get(i);
    if (deterministic) return deterministic;
    const j = judgmentIndexes.indexOf(i);
    return judgmentResults[j] ?? { check: item.check, passed: false, evidence: "No evaluation result" };
  });

  const passed = checkResults.filter((r) => r.passed).length;
  const total = checkResults.length;
  const passRate = total > 0 ? passed / total : 0;

  let comparativeVsId: number | null = null;
  let comparativeWinner: ComparativeResult["winner"] | null = null;
  let comparativeReason: string | null = null;

  const priorRun = await storage.getLatestScoredSkillRun(skillId);
  const priorSessionId = priorRun?.sessionId ?? null;
  const priorId = priorRun?.id ?? null;

  if (priorSessionId) {
    try {
      const prior = await buildSessionTranscript(priorSessionId);

      if (prior.hasActivity) {
        const comparison = await compareOutputs(skillId, skill.description, prior.transcript, transcript);
        comparativeVsId = priorId;
        comparativeWinner = comparison.winner;
        comparativeReason = comparison.reason;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`${skillId}: comparative eval failed: ${msg}`);
    }
  }

  const updated = await storage.updateSkillRunScore(sessionId, {
    passRate,
    checklistTotal: total,
    checklistPassed: passed,
    checklistResults: checkResults,
    comparativeVsId,
    comparativeWinner,
    comparativeReason,
  });

  if (!updated) {
    log.warn(`${skillId}: no skill_runs record found for ${sessionId}, score discarded`);
  }

  if (passRate > 0.5) {
    await storage.incrementSkillSuccess(skill.id);
  } else {
    await storage.incrementSkillFailure(skill.id);
  }

  await reconcileBelowThreshold(skill, skillId, sessionId, passed, total, passRate);

  log.log(
    `${skillId}: ${passed}/${total} checks passed (${Math.round(passRate * 100)}%)` +
      (comparativeWinner ? ` | vs prior: ${comparativeWinner}` : ""),
  );
}

/**
 * Couple async checklist scoring back into terminal run/timer status. A skill
 * may declare scoreThreshold (0-1); a scored pass rate below it reconciles a
 * "succeeded" skill run — and the timer run that launched it — to "degraded".
 * Guarded transitions keep this idempotent, and a reconciliation failure must
 * never lose the already-recorded score.
 */
async function reconcileBelowThreshold(
  skill: { scoreThreshold?: number | null },
  skillId: string,
  sessionId: string,
  passed: number,
  total: number,
  passRate: number,
): Promise<void> {
  const threshold = typeof skill.scoreThreshold === "number" ? skill.scoreThreshold : null;
  if (threshold == null || passRate >= threshold) return;
  const reason = `checklist_below_threshold: ${passed}/${total} checks passed (${Math.round(passRate * 100)}% < ${Math.round(threshold * 100)}%)`;
  try {
    const reconciledRun = await storage.reconcileSkillRunStatus(sessionId, "succeeded", "degraded", reason);
    const { timerStorage } = await import("./file-storage");
    const reconciledTimer = await timerStorage.reconcileRunStatusBySession(sessionId, "success", "degraded", reason);
    log.warn(
      `${skillId}: ${reason}` +
      ` | skillRun=${reconciledRun ? "degraded" : "unchanged"}` +
      ` | timerRun=${reconciledTimer ? `degraded (${reconciledTimer.runId})` : "unchanged"}`,
    );
    eventBus.publish({
      category: "skill",
      event: "skill.run.degraded",
      payload: {
        sessionId,
        skillId,
        reason: "checklist_below_threshold",
        passRate,
        threshold,
        ...(reconciledTimer ? { timerRunId: reconciledTimer.runId, timerId: reconciledTimer.timerId } : {}),
      },
    });
    if (reconciledTimer) {
      eventBus.publish({
        category: "timer",
        event: "timer.run.degraded",
        payload: { runId: reconciledTimer.runId, timerId: reconciledTimer.timerId, status: "degraded", reason, reconciled: true },
      });
    }
  } catch (err) {
    log.warn(`${skillId}: below-threshold reconciliation failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function evaluateChecklist(
  skillId: string,
  checklist: ChecklistItem[],
  transcript: string,
): Promise<CheckResult[]> {
  const checklistText = checklist.map((c, i) => `${i + 1}. ${c.check}`).join("\n");

  const prompt = `You are evaluating a complete session transcript from an AI skill called "${skillId}".

The transcript contains:
- A system prompt (the INPUT data and instructions the skill received)
- Assistant messages and thinking (the skill's REASONING and process)
- Tool calls with arguments and results (actions the skill took)
- <session_artifacts> blocks, if present (the skill's PRIMARY OUTPUT — Library pages, files, documents, etc. that the skill produced as durable deliverables)

EVALUATION PRIORITY: If <session_artifacts> blocks are present, these are the skill's actual deliverables. Evaluate checklist items against artifact content first. Use the assistant messages and tool calls as supporting evidence for process-oriented checks (e.g., did the skill cross-reference sources, did it archive correctly). Consider everything in totality — artifacts, reasoning, and tool actions — but artifacts represent what the skill actually produced.

If no <session_artifacts> blocks are present, fall back to evaluating the assistant's direct output and tool call results as the skill's output.

<transcript>
${truncateForBudget(transcript)}
</transcript>

Evaluate each of these quality checks against the session transcript. For each check, determine if it PASSES (true) or FAILS (false), and provide brief evidence (one sentence) citing the relevant message or tool call when possible.

Checks:
${checklistText}

Respond with a JSON object containing a "results" array:
{"results": [{"check": "...", "passed": true/false, "evidence": "..."}]}

Return ONLY the JSON object, no other text.`;

  const { chatCompletion } = await import("./model-client");
  const response = await chatCompletion({
    activity: "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d",
    maxTokens: 2000,
    messages: [{ role: "user", content: prompt }],
    jsonMode: true,
    metadata: { source: "skill-scoring-checklist", skillId, activity: "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d" },
  });

  try {
    const raw = JSON.parse(extractJson(response.content));
    const parsed = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : null;
    if (!parsed) {
      return checklist.map((c) => ({ check: c.check, passed: false, evidence: "Evaluation returned unexpected format" }));
    }
    const resultMap = new Map<number, CheckResult>();
    for (let i = 0; i < parsed.length && i < checklist.length; i++) {
      const item = parsed[i];
      if (item && typeof item === "object") {
        resultMap.set(i, {
          check: typeof item.check === "string" ? item.check : checklist[i].check,
          passed: item.passed === true,
          evidence: typeof item.evidence === "string" ? item.evidence : "",
        });
      }
    }
    return checklist.map((c, i) =>
      resultMap.get(i) ?? { check: c.check, passed: false, evidence: "No evaluation result" },
    );
  } catch {
    log.warn(`${skillId}: failed to parse checklist eval response; content: ${response.content.slice(0, 500)}`);
    return checklist.map((c) => ({ check: c.check, passed: false, evidence: "Evaluation parse error" }));
  }
}

async function compareOutputs(
  skillId: string,
  skillDescription: string,
  priorTranscript: string,
  currentTranscript: string,
): Promise<ComparativeResult> {
  const prompt = `You are comparing two complete session transcripts from the same AI skill "${skillId}".

Each transcript below is the FULL conversation for one run: the initial system prompt, every user and assistant message, assistant thinking, and all tool calls (with arguments) and tool results. Use tool calls and tool results as primary evidence of the work done — do not judge solely by assistant prose.

Skill purpose: ${skillDescription}

<transcript_prior>
${truncateForBudget(priorTranscript)}
</transcript_prior>

<transcript_current>
${truncateForBudget(currentTranscript)}
</transcript_current>

Which run is better for the skill's purpose? Consider: accuracy, completeness, clarity, and usefulness — based on actual work evidence in the tool calls and tool results.
Use the labels "PRIOR" and "CURRENT" to refer to the runs.

Respond with a JSON object: {"winner": "current" or "prior" or "tie", "reason": "One sentence explaining why."}
Return ONLY the JSON object, no other text.`;

  const { chatCompletion } = await import("./model-client");
  const response = await chatCompletion({
    activity: "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d",
    maxTokens: 500,
    messages: [{ role: "user", content: prompt }],
    jsonMode: true,
    metadata: { source: "skill-scoring-compare", skillId, activity: "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d" },
  });

  try {
    const parsed = JSON.parse(extractJson(response.content));
    const winner = parsed.winner === "prior" ? "prior" : parsed.winner === "current" ? "current" : "tie";
    return { winner, reason: parsed.reason || "" };
  } catch {
    return { winner: "tie", reason: "Comparison parse error" };
  }
}
