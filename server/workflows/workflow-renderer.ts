import type {
  WorkflowArtifact,
  WorkflowGate,
  WorkflowRun,
  WorkflowSession,
  WorkflowStageAttempt,
  WorkflowTemplate,
  WorkflowTemplateDefinition,
  WorkflowTransition,
} from "@shared/schema";
import { workflowTemplateDefinitionSchema } from "@shared/schema";

export type WorkflowEnvironmentTruth = {
  platform: { id: number; name: string } | null;
  product: { id: number; name: string } | null;
  environment: { id: number; name: string; kind: string; status: string } | null;
  source: Record<string, unknown> | null;
  hosting: Record<string, unknown> | null;
  deployment: { provider: string; available: boolean; reason?: string; latest: Record<string, unknown> | null; publicUrl?: string | null; urlReachable?: boolean | null; checkedAt: string } | null;
};

export type WorkflowRunDetail = {
  run: WorkflowRun;
  template: WorkflowTemplate;
  stages: Array<{
    key: string;
    title: string;
    autonomyMode: string;
    status: string;
    attempts: WorkflowStageAttempt[];
    latestAttempt?: WorkflowStageAttempt;
  }>;
  transitions: WorkflowTransition[];
  artifacts: WorkflowArtifact[];
  gates: WorkflowGate[];
  sessions: WorkflowSession[];
  linked: {
    projectId?: number | null;
    platformId?: number | null;
    productId?: number | null;
    environmentId?: number | null;
    libraryPageId?: string | null;
    planId?: string | null;
  };
  environmentTruth?: WorkflowEnvironmentTruth | null;
  lifecycleSnapshot?: unknown;
};

export function parseWorkflowDefinition(template: WorkflowTemplate): WorkflowTemplateDefinition {
  const parsed = workflowTemplateDefinitionSchema.safeParse(template.definition || {});
  if (parsed.success) return parsed.data;
  return { stages: [], terminalStatuses: ["completed", "failed", "canceled"] };
}

export function buildWorkflowStages(detail: Omit<WorkflowRunDetail, "stages" | "linked">): WorkflowRunDetail["stages"] {
  const definition = parseWorkflowDefinition(detail.template);
  const attemptsByStage = new Map<string, WorkflowStageAttempt[]>();
  for (const attempt of detail.attempts || []) {
    const list = attemptsByStage.get(attempt.stageKey) || [];
    list.push(attempt);
    attemptsByStage.set(attempt.stageKey, list);
  }

  return definition.stages
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((stage) => {
      const attempts = (attemptsByStage.get(stage.key) || []).slice().sort((a, b) => a.attemptNumber - b.attemptNumber);
      const latestAttempt = attempts.at(-1);
      const status = latestAttempt?.status || (detail.run.currentStageKey === stage.key ? "active" : "pending");
      return {
        key: stage.key,
        title: stage.title,
        autonomyMode: stage.autonomyMode,
        status,
        attempts,
        latestAttempt,
      };
    });
}

function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function buildWorkflowRunPageContent(detail: WorkflowRunDetail): string {
  const lines: string[] = [];
  lines.push(`# Workflow: ${detail.run.title}`);
  lines.push("");
  lines.push(`**Workflow Run ID:** ${detail.run.id}`);
  lines.push(`**Template:** ${detail.template.name} (${detail.template.id})`);
  lines.push(`**Status:** ${detail.run.status}`);
  lines.push(`**Current Stage:** ${detail.run.currentStageKey || "none"}`);
  lines.push(`**Updated:** ${fmtDate(detail.run.updatedAt)}`);
  lines.push("");
  lines.push("## Objective");
  lines.push(detail.run.objective || "No objective recorded.");
  lines.push("");
  lines.push("## Links");
  lines.push(`- Library page: ${detail.run.linkedLibraryPageId || "none"}`);
  lines.push(`- Plan: ${detail.run.linkedPlanId || "none"}`);
  lines.push(`- Project: ${detail.run.linkedProjectId ?? "none"}`);
  lines.push(`- Platform/Product/Environment: ${detail.run.linkedPlatformId ?? "none"} / ${detail.run.linkedProductId ?? "none"} / ${detail.run.linkedEnvironmentId ?? "none"}`);
  if (detail.environmentTruth?.environment) {
    const truth = detail.environmentTruth;
    lines.push(`- Environment truth: ${truth.platform?.name || "unknown"} / ${truth.product?.name || "unknown"} / ${truth.environment.name} (${truth.environment.kind}, ${truth.environment.status})`);
    if (truth.source) lines.push(`- Source truth: ${String(truth.source.owner || "")}/${String(truth.source.repo || "")} @ ${String(truth.source.branch || "")}${truth.source.autoDeploy ? " (auto-deploy)" : ""}`);
    if (truth.hosting) lines.push(`- Hosting truth: ${String(truth.hosting.provider || "railway")} project=${String(truth.hosting.projectName || truth.hosting.projectId || "")} service=${String(truth.hosting.serviceName || truth.hosting.serviceId || "")}`);
    if (truth.deployment?.latest) lines.push(`- Latest deployment: ${String(truth.deployment.latest.id || "")} · ${String(truth.deployment.latest.status || "unknown")} · commit ${String(truth.deployment.latest.commitSha || "unknown")}`);
    else if (truth.deployment && !truth.deployment.available) lines.push(`- Latest deployment: unavailable — ${truth.deployment.reason || "unknown"}`);
  }
  if (detail.lifecycleSnapshot && typeof detail.lifecycleSnapshot === "object") {
    const snapshot = detail.lifecycleSnapshot as Record<string, unknown>;
    const config = snapshot.config && typeof snapshot.config === "object" ? snapshot.config as Record<string, unknown> : {};
    const deployPolicy = config.deployPolicy && typeof config.deployPolicy === "object" ? config.deployPolicy as Record<string, unknown> : {};
    lines.push(`- Lifecycle snapshot: ${String(config.workflowTemplateId || detail.run.templateId)} / ${String(config.providerKind || "provider")} / ${String(deployPolicy.mode || "manual")}`);
    const acceptance = config.acceptance && typeof config.acceptance === "object" ? config.acceptance as Record<string, unknown> : null;
    if (acceptance) lines.push(`- Acceptance config: ${acceptance.configured === true ? "configured" : "not configured"} / ${String(acceptance.authMode || config.authMode || "none")} / ${String(acceptance.targetUrl || "no target URL")}`);
  }
  lines.push("");
  lines.push("## Stages");
  for (const stage of detail.stages) {
    const marker = detail.run.currentStageKey === stage.key ? "▶" : stage.status === "passed" ? "✓" : stage.status === "failed" ? "✕" : "□";
    lines.push(`- ${marker} **${stage.title}** (${stage.key}) — ${stage.status}; attempts: ${stage.attempts.length}`);
    const latest = stage.latestAttempt;
    if (latest?.outputSummary) lines.push(`  - latest: ${latest.outputSummary}`);
    if (latest?.childSessionId) lines.push(`  - session: ${latest.childSessionId}`);
  }
  lines.push("");
  lines.push("## Open Gates");
  const openGates = detail.gates.filter((g) => g.status === "open");
  if (openGates.length === 0) lines.push("No open gates.");
  for (const gate of openGates) lines.push(`- [${gate.id}] ${gate.gateType}: ${gate.prompt}`);
  lines.push("");
  lines.push("## Transitions");
  if (detail.transitions.length === 0) lines.push("No transitions recorded.");
  for (const t of detail.transitions) lines.push(`- ${fmtDate(t.createdAt)} · ${t.fromStageKey || "start"} → ${t.toStageKey || "terminal"} · ${t.trigger}${t.reason ? ` · ${t.reason}` : ""}`);
  lines.push("");
  lines.push("## Artifacts");
  if (detail.artifacts.length === 0) lines.push("No artifacts attached.");
  for (const artifact of detail.artifacts) {
    const ref = [artifact.refType, artifact.refId, artifact.url].filter(Boolean).join(": ");
    lines.push(`- **${artifact.kind}: ${artifact.title}**${ref ? ` — ${ref}` : ""}${artifact.summary ? ` — ${artifact.summary}` : ""}`);
  }
  lines.push("");
  lines.push("## Sessions");
  if (detail.sessions.length === 0) lines.push("No sessions linked.");
  for (const session of detail.sessions) lines.push(`- ${session.role}: ${session.sessionId}${session.stageAttemptId ? ` (attempt ${session.stageAttemptId})` : ""}`);
  lines.push("");
  lines.push("---");
  lines.push("Rendered checkpoint only. Execution state lives in PostgreSQL workflow tables.");
  return lines.join("\n");
}
