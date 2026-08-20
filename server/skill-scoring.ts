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

/**
 * Quality evaluation home.
 *
 * Product quality is process-text review: the Skill's `process` is the sole
 * judgment specification. Leftover checklist rows with kind tool_invoked /
 * child_skill_invoked remain structural gates only (seeded automation), never
 * a separate product checklist the operator authors in the UI.
 */
export function extractSuccessfulToolInvocations(messages: FileMessage[]): Set<string> {
  const invoked = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.toolCalls)) continue;
    for (const tc of m.toolCalls as ToolCallInfo[]) {
      if (!tc || typeof tc.toolName !== "string") continue;
      // Prefer structural outcome (executor SSOT) when present. Fall back to
      // status==="done" for older messages that predate outcome persistence.
      if (tc.outcome) {
        if (tc.outcome !== "succeeded" && tc.outcome !== "degraded") continue;
      } else if (tc.status !== "done") {
        continue;
      }
      invoked.add(tc.toolName);
      const action = tc.arguments?.action;
      if (typeof action === "string" && action.trim()) invoked.add(`${tc.toolName}:${action.trim()}`);
    }
  }
  return invoked;
}

export interface StructuralRunEvidence {
  invokedTools: Set<string>;
  childSkillStatuses: Map<string, string[]>;
}

export async function buildStructuralRunEvidence(
  sessionId: string,
  messages: FileMessage[],
): Promise<StructuralRunEvidence> {
  const invokedTools = extractSuccessfulToolInvocations(messages);
  const childSkillStatuses = new Map<string, string[]>();
  const parentRun = await storage.getSkillRunBySessionId(sessionId);
  if (!parentRun) return { invokedTools, childSkillStatuses };
  const childRuns = await storage.getChildSkillRunsByParent(parentRun.id);
  for (const child of childRuns) {
    if (!child.parentToolCallId || child.parentSessionId !== sessionId) continue;
    const statuses = childSkillStatuses.get(child.skillName) ?? [];
    statuses.push(child.status);
    childSkillStatuses.set(child.skillName, statuses);
  }
  return { invokedTools, childSkillStatuses };
}

export function evaluateStructuralItem(item: ChecklistItem, evidence: StructuralRunEvidence): CheckResult | null {
  if (item?.kind === "tool_invoked" && typeof item.tool === "string") {
    const action = typeof item.action === "string" && item.action.trim() ? item.action.trim() : null;
    const invocation = action ? `${item.tool}:${action}` : item.tool;
    const passed = evidence.invokedTools.has(invocation);
    const label = action ? `tool action "${invocation}"` : `tool "${item.tool}"`;
    return {
      check: item.check,
      passed,
      evidence: passed
        ? `Deterministic: ${label} had a successful invocation.`
        : `Deterministic: no successful invocation of ${label} in this run.`,
    };
  }
  if (item?.kind === "child_skill_invoked" && typeof item.skill === "string") {
    const statuses = evidence.childSkillStatuses.get(item.skill) ?? [];
    const passed = statuses.length > 0 && statuses.every((status) => status === "succeeded");
    return {
      check: item.check,
      passed,
      evidence: passed
        ? `Deterministic: a fresh child SkillRun for "${item.skill}" succeeded under this parent run.`
        : statuses.length > 0
          ? `Deterministic: child SkillRun "${item.skill}" completed with status ${statuses.join(", ")}; every invocation must succeed.`
          : `Deterministic: no fresh child SkillRun for "${item.skill}" is linked to this parent run.`,
    };
  }
  return null;
}

export function evaluateDeterministicItem(item: ChecklistItem, invokedTools: Set<string>): CheckResult | null {
  return evaluateStructuralItem(item, { invokedTools, childSkillStatuses: new Map() });
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
  const skillRun = await storage.getSkillRunBySessionId(sessionId);
  if (!skillRun) return;
  const skill = await storage.getSkillByName(skillId);
  if (!skill) return;

  const leftoverChecklist: ChecklistItem[] = Array.isArray(skill.checklist)
    ? (skill.checklist as ChecklistItem[])
    : [];

  const { transcript, hasActivity, messages } = await buildSessionTranscript(sessionId);

  if (!hasActivity) {
    log.warn(`${skillId}: no output found in ${sessionId}, skipping`);
    return;
  }

  // Structural leftover gates (tool/child skill) still fail closed when present
  // on the seed. Judgment is always process-text review — never a separate list.
  const structuralEvidence = await buildStructuralRunEvidence(sessionId, messages);
  const structuralResults: CheckResult[] = [];
  for (const item of leftoverChecklist) {
    const result = evaluateStructuralItem(item, structuralEvidence);
    if (result) structuralResults.push(result);
  }

  const processText = typeof skill.process === "string" ? skill.process.trim() : "";
  const processResults = processText.length > 0
    ? await evaluateAgainstProcess(skillId, processText, transcript)
    : [{
        check: "Process",
        passed: false,
        evidence: "Skill has no process text to review against",
      }];

  const allParseErrors = processResults.every((r) => r.evidence === "Evaluation parse error");
  if (allParseErrors) {
    log.warn(`${skillId}: process review returned parse errors for ${sessionId}, skipping score recording`);
    return;
  }

  const checkResults: CheckResult[] = [...structuralResults, ...processResults];
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

/** Review run output against the Skill process text — sole product quality spec. */
async function evaluateAgainstProcess(
  skillId: string,
  processText: string,
  transcript: string,
): Promise<CheckResult[]> {
  const prompt = `You are evaluating a complete session transcript from an AI skill called "${skillId}".

The skill's Process is the sole quality specification. There is no separate checklist. Judge whether the run's output and actions followed that Process.

The transcript contains:
- A system prompt (the INPUT data and instructions the skill received)
- Assistant messages and thinking (the skill's REASONING)
- Tool calls with arguments and results (actions the skill took)
- <session_artifacts> blocks, if present (the skill's PRIMARY OUTPUT — Library pages, files, documents)

EVALUATION PRIORITY: If <session_artifacts> blocks are present, these are the skill's actual deliverables. Judge them against the Process first. Use assistant messages and tool calls as supporting evidence for process steps.

If no <session_artifacts> blocks are present, fall back to the assistant's direct output and tool results.

<process>
${truncateForBudget(processText, 12_000)}
</process>

<transcript>
${truncateForBudget(transcript)}
</transcript>

Return one overall judgment: did the run substantially follow the Process and produce output that matches it?

Respond with a JSON object:
{"results": [{"check": "Followed skill process", "passed": true/false, "evidence": "one sentence citing artifacts or actions"}]}

Return ONLY the JSON object, no other text.`;

  const { chatCompletion } = await import("./model-client");
  const response = await chatCompletion({
    activity: "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d",
    maxTokens: 2000,
    messages: [{ role: "user", content: prompt }],
    jsonMode: true,
    metadata: { source: "skill-scoring-process", skillId, activity: "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d" },
  });

  try {
    const raw = JSON.parse(extractJson(response.content));
    const parsed = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : null;
    if (!parsed || parsed.length === 0) {
      return [{ check: "Followed skill process", passed: false, evidence: "Evaluation returned unexpected format" }];
    }
    const item = parsed[0];
    return [{
      check: typeof item?.check === "string" ? item.check : "Followed skill process",
      passed: item?.passed === true,
      evidence: typeof item?.evidence === "string" ? item.evidence : "",
    }];
  } catch {
    log.warn(`${skillId}: failed to parse process eval response; content: ${response.content.slice(0, 500)}`);
    return [{ check: "Followed skill process", passed: false, evidence: "Evaluation parse error" }];
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
