/**
 * Plan utilities — YAML frontmatter parser/serializer, types, and helpers.
 *
 * Plans are Library pages with YAML frontmatter containing machine state
 * and a markdown body containing human-readable step instructions.
 */
import { createLogger } from "../log";

const log = createLogger("PlanUtils");

// ─── Types ───────────────────────────────────────────────────────────

export type PlanStatus = "created" | "executing" | "paused" | "needs_review" | "completed" | "completed_with_failures" | "failed" | "aborted";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "blocked" | "needs_review";

export interface PlanStep {
  id: string;
  title: string;
  status: StepStatus;
  duration?: number;       // seconds
  sessionId?: string;
  outcome?: string;
  error?: string;
  startedAt?: string;      // ISO8601
  completedAt?: string;    // ISO8601
}

export interface PlanMeta {
  id: string;
  status: PlanStatus;
  createdAt: string;       // ISO8601
  updatedAt: string;       // ISO8601
  originSessionId: string;
  goalId?: string;
  projectId?: number;
  workspace?: string;      // Git repo URL
  workspaceDir?: string;   // Cloned directory name
  blocking: boolean;
  steps: PlanStep[];
}

export interface PlanCreateInput {
  title: string;
  steps: Array<{ title: string; instructions: string }>;
  originSessionId: string;
  goalId?: string;
  projectId?: number;
  workspace?: string;
  blocking?: boolean;
}

// ─── Unified Completion Semantics ────────────────────────────────────

/**
 * A step is resolved when it has reached a terminal state. Used everywhere
 * to determine "is this step done?" — replaces three prior inline definitions.
 */
export function isStepResolved(step: { status: string }): boolean {
  return step.status === "completed" || step.status === "skipped" || step.status === "failed";
}

/** A step has finished executing even when its output still requires human review. */
export function isStepProgressed(step: { status: string }): boolean {
  return isStepResolved(step) || step.status === "needs_review";
}

/**
 * A plan is done when every step has reached a terminal state (including failed).
 */
export function isPlanDone(steps: Array<{ status: string }>): boolean {
  return steps.length > 0 && steps.every(isStepResolved);
}

// ─── ID Generation ───────────────────────────────────────────────────

let planCounter = 0;

export function generatePlanId(): string {
  return `plan_${Date.now().toString(36)}_${(++planCounter).toString(36)}`;
}

export function generateStepId(index: number): string {
  return `step_${index + 1}`;
}

// ─── YAML Frontmatter ────────────────────────────────────────────────

/**
 * Serialize plan metadata to YAML frontmatter string.
 * We write a minimal YAML serializer to avoid a heavy dependency.
 */
export function serializePlanYaml(meta: PlanMeta): string {
  const lines: string[] = [];
  lines.push("plan:");
  lines.push(`  id: ${meta.id}`);
  lines.push(`  status: ${meta.status}`);
  lines.push(`  createdAt: ${meta.createdAt}`);
  lines.push(`  updatedAt: ${meta.updatedAt}`);
  lines.push(`  originSessionId: ${meta.originSessionId}`);
  if (meta.goalId) lines.push(`  goalId: ${meta.goalId}`);
  if (meta.projectId != null) lines.push(`  projectId: ${meta.projectId}`);
  if (meta.workspace) lines.push(`  workspace: ${meta.workspace}`);
  if (meta.workspaceDir) lines.push(`  workspaceDir: ${meta.workspaceDir}`);
  lines.push(`  blocking: ${meta.blocking}`);
  lines.push("  steps:");
  for (const step of meta.steps) {
    lines.push(`    - id: ${step.id}`);
    lines.push(`      title: ${yamlEscape(step.title)}`);
    lines.push(`      status: ${step.status}`);
    if (step.duration != null) lines.push(`      duration: ${step.duration}`);
    if (step.sessionId) lines.push(`      sessionId: ${step.sessionId}`);
    if (step.outcome) lines.push(`      outcome: ${yamlEscape(step.outcome)}`);
    if (step.error) lines.push(`      error: ${yamlEscape(step.error)}`);
    if (step.startedAt) lines.push(`      startedAt: ${step.startedAt}`);
    if (step.completedAt) lines.push(`      completedAt: ${step.completedAt}`);
  }
  return lines.join("\n");
}

function yamlEscape(s: string): string {
  // Quote if value contains special chars
  if (/[:#{}[\],&*?|>!%@`'"\n]/.test(s) || s.trim() !== s) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return s;
}

/**
 * Parse YAML frontmatter from a library page's plainTextContent.
 * Returns null if the page doesn't have plan frontmatter.
 */
export function parsePlanFromContent(content: string): { meta: PlanMeta; body: string } | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;

  const yamlStr = fmMatch[1];
  const body = fmMatch[2];

  try {
    const meta = parseYamlToPlanMeta(yamlStr);
    if (!meta) return null;
    return { meta, body };
  } catch (err) {
    log.warn(`Failed to parse plan YAML: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Minimal YAML parser for our known plan structure.
 * Not a general-purpose YAML parser — handles only plan frontmatter.
 */
function parseYamlToPlanMeta(yaml: string): PlanMeta | null {
  // TipTap roundtrip inserts blank lines between YAML lines; strip them
  const lines = yaml.split("\n").filter(l => l.trim() !== "");
  if (!lines[0]?.trim().startsWith("plan:")) return null;

  const meta: Partial<PlanMeta> = { steps: [] };
  let currentStep: Partial<PlanStep> | null = null;
  let inSteps = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Skip blank lines
    if (!trimmed) continue;

    // Detect steps array start
    if (trimmed.match(/^\s{2}steps:\s*$/)) {
      inSteps = true;
      continue;
    }

    if (inSteps) {
      // New step item
      if (trimmed.match(/^\s{4}-\s+/)) {
        if (currentStep?.id) {
          meta.steps!.push(currentStep as PlanStep);
        }
        currentStep = {};
        const kv = parseYamlKV(trimmed.replace(/^\s{4}-\s+/, ""));
        if (kv) setStepField(currentStep, kv.key, kv.value);
        continue;
      }
      // Step field continuation
      if (trimmed.match(/^\s{6}\w/) && currentStep) {
        const kv = parseYamlKV(trimmed.trim());
        if (kv) setStepField(currentStep, kv.key, kv.value);
        continue;
      }
    }

    // Top-level plan fields (indented 2 spaces)
    if (!inSteps && trimmed.match(/^\s{2}\w/)) {
      const kv = parseYamlKV(trimmed.trim());
      if (kv) setPlanField(meta, kv.key, kv.value);
    }
  }

  // Push last step
  if (currentStep?.id) {
    meta.steps!.push(currentStep as PlanStep);
  }

  if (!meta.id || !meta.status) return null;

  return {
    id: meta.id!,
    status: meta.status as PlanStatus,
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: meta.updatedAt || new Date().toISOString(),
    originSessionId: meta.originSessionId || "",
    goalId: meta.goalId,
    projectId: meta.projectId,
    workspace: meta.workspace,
    workspaceDir: meta.workspaceDir,
    blocking: meta.blocking ?? true,
    steps: meta.steps || [],
  };
}

function parseYamlKV(line: string): { key: string; value: string } | null {
  const match = line.match(/^(\w+):\s*(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  // Strip quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return { key: match[1], value };
}

function setPlanField(meta: Partial<PlanMeta>, key: string, value: string): void {
  switch (key) {
    case "id": meta.id = value; break;
    case "status": meta.status = value as PlanStatus; break;
    case "createdAt": meta.createdAt = value; break;
    case "updatedAt": meta.updatedAt = value; break;
    case "originSessionId": meta.originSessionId = value; break;
    case "goalId": meta.goalId = value; break;
    case "projectId": meta.projectId = parseInt(value, 10) || undefined; break;
    case "workspace": meta.workspace = value; break;
    case "workspaceDir": meta.workspaceDir = value; break;
    case "blocking": meta.blocking = value === "true"; break;
  }
}

function setStepField(step: Partial<PlanStep>, key: string, value: string): void {
  switch (key) {
    case "id": step.id = value; break;
    case "title": step.title = value; break;
    case "status": step.status = value as StepStatus; break;
    case "duration": step.duration = parseInt(value, 10) || undefined; break;
    case "sessionId": step.sessionId = value; break;
    case "outcome": step.outcome = value; break;
    case "error": step.error = value; break;
    case "startedAt": step.startedAt = value; break;
    case "completedAt": step.completedAt = value; break;
  }
}

// ─── Content Assembly ────────────────────────────────────────────────

/**
 * Build full Library page content (frontmatter + body) from plan meta + step instructions.
 */
export function buildPlanPageContent(meta: PlanMeta, stepInstructions: Array<{ title: string; instructions: string }>): string {
  const yaml = serializePlanYaml(meta);
  const bodyParts: string[] = [`# Plan: ${meta.steps[0]?.title ? meta.steps.map(s => s.title).join(", ").slice(0, 60) : "Untitled"}`];

  // Use the plan title from the first step's parent context if available
  bodyParts[0] = `# Plan`;

  for (let i = 0; i < stepInstructions.length; i++) {
    const si = stepInstructions[i];
    bodyParts.push(`\n## Step ${i + 1}: ${si.title}\n\n${si.instructions}`);
  }

  return `---\n${yaml}\n---\n\n${bodyParts.join("\n")}`;
}

/**
 * Extract step instructions from the markdown body of a plan page.
 * Returns a map of step index (0-based) → instructions text.
 */
export function extractStepInstructions(body: string): Map<number, string> {
  const instructions = new Map<number, string>();
  const stepPattern = /^## Step (\d+):\s*.+$/gm;
  const matches: Array<{ index: number; stepNum: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = stepPattern.exec(body)) !== null) {
    matches.push({ index: match.index + match[0].length, stepNum: parseInt(match[1], 10) });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? body.lastIndexOf("\n## Step", matches[i + 1].index) : body.length;
    const text = body.slice(start, end).trim();
    instructions.set(matches[i].stepNum - 1, text); // 0-indexed
  }

  return instructions;
}

/**
 * Update plan metadata in page content without touching the markdown body.
 */
export function updatePlanMetaInContent(content: string, meta: PlanMeta): string {
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  const body = fmMatch ? fmMatch[1] : content;
  const yaml = serializePlanYaml(meta);
  return `---\n${yaml}\n---\n${body}`;
}

/**
 * Add new step sections to the markdown body.
 */
export function appendStepSections(
  content: string,
  existingStepCount: number,
  newSteps: Array<{ title: string; instructions: string }>,
): string {
  const sections: string[] = [];
  for (let i = 0; i < newSteps.length; i++) {
    const stepNum = existingStepCount + i + 1;
    sections.push(`\n## Step ${stepNum}: ${newSteps[i].title}\n\n${newSteps[i].instructions}`);
  }
  return content + sections.join("\n");
}

/**
 * Build the warm-start brief for a step's child session.
 */
export function buildStepBrief(
  planTitle: string,
  step: PlanStep,
  stepIndex: number,
  totalSteps: number,
  instructions: string,
  priorOutcomes: Array<{ title: string; outcome: string }>,
  workspaceDir?: string,
  retryContext?: { attempt: number; priorOutput?: string },
  planContext?: { planId: string; stepId: string; attemptId: number; planPageRef: string },
): string {
  const priorSection = priorOutcomes.length > 0
    ? `### Prior Steps\n${priorOutcomes.map(o => `- **${o.title}**: ${o.outcome}`).join("\n")}`
    : "### Prior Steps\nNone yet — you are the first step.";

  const workspaceSection = workspaceDir
    ? `### Workspace\nFiles are in repos/${workspaceDir}/. Changes you make will be visible to subsequent steps.`
    : "### Workspace\nNo shared workspace.";

  const retrySection = retryContext
    ? `### Retry Context\nThis is attempt ${retryContext.attempt}. A prior attempt did not complete successfully.${retryContext.priorOutput ? `\n\n**Prior attempt output:**\n${retryContext.priorOutput.slice(0, 1000)}` : ""}\n\nPick up where the previous attempt left off. Check existing progress before redoing work.`
    : "";

  const planContextSection = planContext
    ? `### Plan Context\nPlan ID: ${planContext.planId}\nStep ID: ${planContext.stepId}\nAttempt ID: ${planContext.attemptId}\nPlan document: ${planContext.planPageRef}\n\nRead the plan document for context if needed. Do not edit the plan document's managed Run History section; the parent executor owns that projection.`
    : "";

  return `## Plan: ${planTitle}

You are executing step ${stepIndex + 1} of ${totalSteps}.

### Your Task
${instructions}

${priorSection}

${workspaceSection}
${planContextSection ? `\n${planContextSection}\n` : ""}${retrySection ? `\n${retrySection}\n` : ""}
### Important
- Complete your task fully, then end your session.
- If you discover the plan needs additional steps, call plan(action: "add_steps") with the planId.
- If you cannot complete this step, explain what went wrong clearly so the plan can recover.`.trim();
}

/**
 * Format a plan summary for display.
 */
export function formatPlanSummary(meta: PlanMeta, title: string): string {
  const completed = meta.steps.filter(s => s.status === "completed").length;
  const needsReview = meta.steps.filter(s => s.status === "needs_review").length;
  const skipped = meta.steps.filter(s => s.status === "skipped").length;
  const failed = meta.steps.filter(s => s.status === "failed").length;
  const resolved = completed + skipped + failed + needsReview;
  const total = meta.steps.length;
  const totalDuration = meta.steps.reduce((sum, s) => sum + (s.duration || 0), 0);

  const statusIcon = {
    created: "📋",
    executing: "⏳",
    paused: "⏸️",
    needs_review: "👀",
    completed: "✅",
    completed_with_failures: "⚠️",
    failed: "❌",
    aborted: "🚫",
  }[meta.status] || "📋";

  const stepLines = meta.steps.map((s, i) => {
    const icon = { pending: "□", running: "⏳", completed: "✅", failed: "❌", skipped: "⏭️", blocked: "⛔", needs_review: "👀" }[s.status] || "□";
    const duration = s.duration ? ` (${formatDuration(s.duration)})` : "";
    return `  ${i + 1}. ${icon} ${s.title}${duration}`;
  });

  const breakdown: string[] = [];
  if (needsReview > 0) breakdown.push(`${needsReview} needs review`);
  if (skipped > 0) breakdown.push(`${skipped} skipped`);
  if (failed > 0) breakdown.push(`${failed} failed`);
  const breakdownStr = breakdown.length > 0 ? ` (${breakdown.join(", ")})` : "";
  return `${statusIcon} **${title}** — ${resolved}/${total} steps${breakdownStr} · ${formatDuration(totalDuration)}\n\n${stepLines.join("\n")}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : `${mins}m`;
}
