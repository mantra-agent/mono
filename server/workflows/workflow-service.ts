import crypto from "crypto";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { getCurrentPrincipal, getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import { createLogger, getRecentLogs } from "../log";
import {
  workflowArtifacts,
  workflowGates,
  workflowRuns,
  workflowSessions,
  workflowStageAttempts,
  workflowTemplates,
  workflowTransitions,
  type WorkflowArtifact,
  type WorkflowGate,
  type WorkflowRun,
  type WorkflowStageAttempt,
  type WorkflowTemplate,
  type WorkflowTransition,
  type WorkflowTransitionTrigger,
  workflowAttemptResultSchema,
  workflowAutonomyModeSchema,
  workflowGateStatusSchema,
  workflowRunStatusSchema,
  workflowTemplateDefinitionSchema,
  workflowTemplateStatusSchema,
  workflowTransitionTriggerSchema,
  type WorkflowStageDefinition,
} from "@shared/schema";
import {
  environmentContextArtifacts,
  environmentHostingBindings,
  environmentSourceBindings,
  platformProductEnvironments,
  platformProducts,
  platforms,
  providerConnections,
  type EnvironmentHostingBinding,
  type EnvironmentSourceBinding,
  type ProviderConnection,
} from "@shared/models/platforms";
import { libraryPages } from "@shared/models/info";
import { isParseableReferenceType, serializeReference } from "@shared/references";
import { getProviderCredential } from "../provider-credential-store";
import { extractDeploymentMeta, fetchDeployments, getLatestDeploymentByToken } from "../integrations/railway/client";
import { getCloudflareLatestDeployment } from "../services/provider-connection-service";
import { buildWorkflowRunPageContent, buildWorkflowStages, parseWorkflowDefinition, type WorkflowEnvironmentTruth, type WorkflowRunDetail } from "./workflow-renderer";
import { monitorChildSession, truncateOutput, type MonitorResult } from "../child-session-monitor";
import { chatFileStorage } from "../chat-file-storage";

const log = createLogger("WorkflowService");

/** Default idle timeout for workflow stage children: 15 minutes */
const WORKFLOW_STAGE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ACCEPTANCE_DEPLOY_WAIT_TIMEOUT_MS = 12 * 60 * 1000;
const ACCEPTANCE_DEPLOY_POLL_INTERVAL_MS = 15 * 1000;

const templateScopeColumns = { scope: workflowTemplates.scope, ownerUserId: workflowTemplates.ownerUserId, accountId: workflowTemplates.accountId };
const runScopeColumns = { scope: workflowRuns.scope, ownerUserId: workflowRuns.ownerUserId, accountId: workflowRuns.accountId };
const attemptScopeColumns = { scope: workflowStageAttempts.scope, ownerUserId: workflowStageAttempts.ownerUserId, accountId: workflowStageAttempts.accountId };
const transitionScopeColumns = { scope: workflowTransitions.scope, ownerUserId: workflowTransitions.ownerUserId, accountId: workflowTransitions.accountId };
const artifactScopeColumns = { scope: workflowArtifacts.scope, ownerUserId: workflowArtifacts.ownerUserId, accountId: workflowArtifacts.accountId };
const gateScopeColumns = { scope: workflowGates.scope, ownerUserId: workflowGates.ownerUserId, accountId: workflowGates.accountId };
const sessionScopeColumns = { scope: workflowSessions.scope, ownerUserId: workflowSessions.ownerUserId, accountId: workflowSessions.accountId };
const platformScopeColumns = { scope: platforms.scope, ownerUserId: platforms.ownerUserId, accountId: platforms.accountId };

const ACCEPTANCE_GATE_KEYS = [
  "stageDeployGreen",
  "targetUrlHealthy",
  "targetRouteBrowserLoaded",
  "screenshotCaptured",
  "clientLogsChecked",
  "serverLogsChecked",
  "authSessionEstablished",
] as const;

type AcceptanceGateKey = typeof ACCEPTANCE_GATE_KEYS[number];

type AcceptanceEvidencePacket = {
  capturedAt: string;
  configSnapshot: Record<string, unknown>;
  targetUrl: string | null;
  routePath: string;
  healthCheckPath: string;
  gates: Record<AcceptanceGateKey, boolean>;
  auth: { mode: string; attempted: boolean; established: boolean; verified: boolean; status?: number | null; userId?: string | null; error?: string | null };
  browserSession?: Record<string, unknown> | null;
  health: { ok: boolean; status?: number; error?: string };
  browserError?: string | null;
  optionalSmokeAttempted: boolean;
  deployment: WorkflowEnvironmentTruth["deployment"] | null;
  deploymentReadiness?: DeploymentReadiness;
  screenshot?: { path: string; width: number; height: number; truncated: boolean } | null;
  logs: {
    client: Array<{ ts: number; level: string; source: string; message: string }>;
    server: Array<{ ts: number; level: string; source: string; message: string }>;
  };
  failurePacket?: Record<string, unknown>;
};

function visible<T>(columns: T, predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), columns as any, predicate); }
function writable<T>(columns: T, predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), columns as any, predicate); }
function owner<T>(columns: T) { return ownedInsertValues(getCurrentPrincipalOrSystem(), columns as any); }

function environmentKind(name: string): "development" | "staging" | "production" | "custom" {
  const normalized = name.trim().toLowerCase();
  if (["dev", "development"].includes(normalized)) return "development";
  if (["stage", "staging"].includes(normalized)) return "staging";
  if (["prod", "production", "live"].includes(normalized)) return "production";
  return "custom";
}

function sanitizeConnection(connection: ProviderConnection | null | undefined) {
  if (!connection) return null;
  return { id: connection.id, provider: connection.provider, label: connection.label, status: connection.status, lastVerifiedAt: connection.lastVerifiedAt };
}

function sanitizeSourceBinding(source: EnvironmentSourceBinding | null | undefined, connection: ProviderConnection | null | undefined) {
  if (!source) return null;
  return {
    id: source.id,
    provider: source.provider,
    connectionId: source.connectionId,
    connection: sanitizeConnection(connection),
    owner: source.owner,
    repo: source.repo,
    branch: source.branch,
    autoDeploy: source.autoDeploy,
    inferred: false,
    updatedAt: source.updatedAt,
  };
}

function sanitizeHostingBinding(hosting: EnvironmentHostingBinding | null | undefined, connection: ProviderConnection | null | undefined) {
  if (!hosting) return null;
  return {
    id: hosting.id,
    provider: hosting.provider,
    connectionId: hosting.connectionId,
    connection: sanitizeConnection(connection),
    projectId: hosting.projectId,
    projectName: hosting.projectName,
    providerEnvironmentId: hosting.providerEnvironmentId,
    providerEnvironmentName: hosting.providerEnvironmentName,
    serviceId: hosting.serviceId,
    serviceName: hosting.serviceName,
    publicUrl: hosting.publicUrl,
    staticUrl: hosting.staticUrl,
    inferred: false,
    updatedAt: hosting.updatedAt,
  };
}

function generateWorkflowRunId(): string {
  return `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_WORKFLOW_MAX_ATTEMPTS = 10;

type RetryPolicyLike = {
  maxAttemptsPerStage?: unknown;
  maxRetries?: unknown;
};

type WorkflowArtifactBrief = { id: number; kind: string; title: string; refType: string; refId: string | null; url: string | null; summary: string };

type WorkflowRetryContext = {
  failedStageKey: string;
  failedStageTitle: string;
  failedAttemptId: number;
  failedAttemptNumber: number;
  status: string;
  result: string | null;
  outputSummary: string | null;
  failureContext: unknown;
  evidence: unknown;
  childSessionId: string | null;
  artifacts: WorkflowArtifactBrief[];
  runFailurePacket: unknown;
  instruction: string;
};

type WorkflowStageInputContext = {
  workflowRunId: string;
  workflowTitle: string;
  objective: string;
  stageKey: string;
  stageTitle: string;
  attemptNumber: number;
  retryCount: number;
  maxAttempts: number;
  previousFailurePacket?: unknown;
  retryContext?: WorkflowRetryContext;
  relevantArtifacts: WorkflowArtifactBrief[];
  entryCriteria?: string[];
  exitCriteria?: string[];
  evidenceRequirements?: string[];
  allowedTransitions?: Array<{ toStageKey: string | null; on: string; reason?: string }>;
  governingArtifacts?: Array<{ kind: string; libraryPageId: string; title: string }>;
  purpose: string;
};

function getMaxAttempts(detail: WorkflowRunDetail): number {
  const runPolicy = (detail.run.retryPolicy || {}) as RetryPolicyLike & { maxAttempts?: unknown };
  const templatePolicy = (detail.template.defaultAutonomyPolicy || {}) as RetryPolicyLike & { maxAttempts?: unknown };
  const candidate = Number(runPolicy.maxAttemptsPerStage ?? runPolicy.maxRetries ?? runPolicy.maxAttempts ?? templatePolicy.maxAttemptsPerStage ?? templatePolicy.maxRetries ?? templatePolicy.maxAttempts ?? DEFAULT_WORKFLOW_MAX_ATTEMPTS);
  return Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : DEFAULT_WORKFLOW_MAX_ATTEMPTS;
}

function truncateText(text: string, maxLen = 700): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 3)}...`;
}

function failedAttempts(attempts: WorkflowStageAttempt[]): WorkflowStageAttempt[] {
  return attempts
    .filter((attempt) => ["failed", "blocked"].includes(attempt.status) || ["failed", "blocked"].includes(String(attempt.result || "")))
    .sort((a, b) => b.attemptNumber - a.attemptNumber);
}

function buildPreviousFailurePacket(attempts: WorkflowStageAttempt[]): unknown | undefined {
  const latestFailure = failedAttempts(attempts)[0];
  if (!latestFailure) return undefined;
  return {
    attemptId: latestFailure.id,
    stageKey: latestFailure.stageKey,
    stageTitle: latestFailure.stageTitle,
    attemptNumber: latestFailure.attemptNumber,
    status: latestFailure.status,
    result: latestFailure.result,
    outputSummary: latestFailure.outputSummary,
    failureContext: latestFailure.failureContext,
    evidence: latestFailure.evidence,
    childSessionId: latestFailure.childSessionId,
  };
}

function stageArtifacts(detail: WorkflowRunDetail, stageKey: string): WorkflowArtifactBrief[] {
  const attemptIds = new Set(detail.stages.find((stage) => stage.key === stageKey)?.attempts.map((attempt) => attempt.id) || []);
  return detail.artifacts
    .filter((artifact) => artifact.stageAttemptId == null || attemptIds.has(artifact.stageAttemptId))
    .map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      refType: artifact.refType,
      refId: artifact.refId,
      url: artifact.url,
      summary: artifact.summary,
    }));
}

function attemptArtifacts(detail: WorkflowRunDetail, attemptId: number): WorkflowArtifactBrief[] {
  return detail.artifacts
    .filter((artifact) => artifact.stageAttemptId === attemptId)
    .map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      refType: artifact.refType,
      refId: artifact.refId,
      url: artifact.url,
      summary: artifact.summary,
    }));
}

function buildRetryContext(detail: WorkflowRunDetail, stageKey: string, stageTitle: string, attempts: WorkflowStageAttempt[]): WorkflowRetryContext | undefined {
  const latestFailure = failedAttempts(attempts)[0];
  if (!latestFailure) return undefined;
  return {
    failedStageKey: latestFailure.stageKey || stageKey,
    failedStageTitle: latestFailure.stageTitle || stageTitle,
    failedAttemptId: latestFailure.id,
    failedAttemptNumber: latestFailure.attemptNumber,
    status: latestFailure.status,
    result: latestFailure.result,
    outputSummary: latestFailure.outputSummary,
    failureContext: latestFailure.failureContext,
    evidence: latestFailure.evidence,
    childSessionId: latestFailure.childSessionId,
    artifacts: attemptArtifacts(detail, latestFailure.id),
    runFailurePacket: detail.run.failurePacket || null,
    instruction: "Address this failure directly. Do not redo unrelated discovery or repeat the failed approach unless the changed premise is explicit.",
  };
}

const BUILD_STAGE_PURPOSES: Record<string, string> = {
  scope: "Define the implementation design and its success conditions against the target product, environment, and governing context.",
  design_review: "Find defects, omissions, unjustified complexity, and governing-context violations in the proposed design before implementation begins.",
  implement: "Implement the approved design completely, preserve its constraints, and produce build and change evidence.",
  code_review: "Find defects, inconsistencies, technical debt, and governing-context violations in the resulting implementation and every affected system. This is an implementation review, not merely a code or build check.",
  acceptance: "Determine whether the deployed result satisfies the approved design and user-visible success criteria in the target environment.",
  calibration: "Determine what this run revealed about the product, implementation process, and workflow, then record the changes that should follow.",
  documentation: "Preserve the final implemented truth, evidence, decisions, and remaining gates in durable project documentation.",
};

const BUILD_STAGE_ARTIFACT_KINDS: Record<string, string[]> = {
  scope: ["design_system", "product_definition"],
  design_review: ["design_system", "product_definition"],
  implement: ["coding_process", "product_definition"],
  code_review: ["coding_process", "product_definition"],
  acceptance: ["design_system", "product_definition"],
  calibration: ["product_definition"],
  documentation: ["product_definition"],
};

async function resolveGoverningArtifacts(environmentId: number | null, stageKey: string): Promise<Array<{ kind: string; libraryPageId: string; title: string }>> {
  if (!environmentId) return [];
  const relevantKinds = BUILD_STAGE_ARTIFACT_KINDS[stageKey] || [];
  if (relevantKinds.length === 0) return [];
  const rows = await db
    .select({
      kind: environmentContextArtifacts.kind,
      libraryPageId: environmentContextArtifacts.libraryPageId,
      title: libraryPages.title,
    })
    .from(environmentContextArtifacts)
    .innerJoin(libraryPages, eq(environmentContextArtifacts.libraryPageId, libraryPages.id))
    .where(and(
      eq(environmentContextArtifacts.environmentId, environmentId),
      inArray(environmentContextArtifacts.kind, relevantKinds),
      visible({ scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId }),
    ))
    .orderBy(environmentContextArtifacts.kind, libraryPages.title);
  return rows.map((row) => ({
    kind: row.kind,
    libraryPageId: row.libraryPageId,
    title: row.title,
  }));
}


async function buildStageInputContext(detail: WorkflowRunDetail, stageKey: string, stageDef: WorkflowStageDefinition, attemptNumber: number, extraContext?: unknown): Promise<WorkflowStageInputContext & { extraContext?: unknown; environmentTruth?: WorkflowEnvironmentTruth | null; lifecycleSnapshot?: unknown }> {
  const priorAttempts = detail.stages.find((stage) => stage.key === stageKey)?.attempts || [];
  const retryCount = Math.max(0, attemptNumber - 1);
  const previousFailurePacket = buildPreviousFailurePacket(priorAttempts);
  const retryContext = retryCount > 0 ? buildRetryContext(detail, stageKey, stageDef.title, priorAttempts) : undefined;
  const governingArtifacts = detail.template.id === BUILD_WORKFLOW_TEMPLATE_ID
    ? await resolveGoverningArtifacts(detail.run.linkedEnvironmentId, stageKey)
    : [];
  return {
    workflowRunId: detail.run.id,
    workflowTitle: detail.run.title,
    objective: detail.run.objective,
    stageKey,
    stageTitle: stageDef.title,
    attemptNumber,
    retryCount,
    maxAttempts: getMaxAttempts(detail),
    previousFailurePacket,
    retryContext,
    relevantArtifacts: stageArtifacts(detail, stageKey),
    entryCriteria: stageDef.entryCriteria,
    exitCriteria: stageDef.exitCriteria,
    evidenceRequirements: stageDef.evidenceRequirements,
    allowedTransitions: stageDef.allowedTransitions,
    governingArtifacts,
    purpose: BUILD_STAGE_PURPOSES[stageKey] || `Complete the ${stageDef.title} stage.`,
    environmentTruth: detail.environmentTruth || null,
    lifecycleSnapshot: detail.lifecycleSnapshot || detail.run.lifecycleSnapshot || null,
    ...(extraContext !== undefined ? { extraContext } : {}),
  };
}

function workflowArtifactReference(artifact: WorkflowArtifactBrief): string {
  if (!artifact.refId) return artifact.url || "";
  const referenceType = artifact.refType === "library_page" ? "page" : artifact.refType;
  if (isParseableReferenceType(referenceType)) {
    return serializeReference({ type: referenceType, id: artifact.refId });
  }
  return [artifact.refType, artifact.refId, artifact.url].filter(Boolean).join(": ");
}

function buildStageBrief(context: WorkflowStageInputContext & { extraContext?: unknown; environmentTruth?: WorkflowEnvironmentTruth | null; lifecycleSnapshot?: unknown }): string {
  const lines: string[] = [
    `# ${context.stageTitle}`,
    "",
    `Workflow Run ID: ${context.workflowRunId}`,
    ...("stageAttemptId" in context && Number.isSafeInteger((context as WorkflowStageInputContext & { stageAttemptId?: number }).stageAttemptId)
      ? [`Stage Attempt ID: ${(context as WorkflowStageInputContext & { stageAttemptId: number }).stageAttemptId}`]
      : []),
    "",
    `## Purpose`,
    context.purpose,
    "",
    `Work adversarially against this purpose. Do not let completed prior work, a passing build, or lifecycle progress substitute for the judgment this stage exists to make.`,
    "",
    `## Workflow Objective`,
    context.objective || "No objective recorded.",
  ];

  if (context.governingArtifacts?.length) {
    lines.push("", "## Governing Context");
    lines.push("Before doing stage work, load each relevant environment-linked artifact below with the Library tool. These pages are authoritative. Apply their contents directly rather than restating or guessing their rules. Do not proceed until they are loaded.");
    for (const artifact of context.governingArtifacts) {
      lines.push(`- ${artifact.kind}: @page:${artifact.libraryPageId} (${artifact.title})`);
    }
  }

  lines.push("", "## Stage Inputs");
  if (context.relevantArtifacts.length === 0) lines.push("- No prior workflow artifacts attached.");
  for (const artifact of context.relevantArtifacts) {
    const ref = workflowArtifactReference(artifact);
    lines.push(`- ${artifact.kind}: ${artifact.title}${ref ? ` — ${ref}` : ""}${artifact.summary ? ` — ${artifact.summary}` : ""}`);
  }

  if (context.retryCount > 0) {
    lines.push("", "## Retry Assignment");
    lines.push("Address the prior failure directly with a materially different approach. Do not repeat unrelated discovery.");
    lines.push("```json", JSON.stringify(context.retryContext || context.previousFailurePacket || null, null, 2), "```");
  }

  if (context.entryCriteria?.length) {
    lines.push("", "## Before Starting");
    for (const criterion of context.entryCriteria) lines.push(`- ${criterion}`);
  }
  if (context.evidenceRequirements?.length) {
    lines.push("", "## Required Evidence");
    for (const requirement of context.evidenceRequirements) lines.push(`- ${requirement}`);
  }
  if (context.exitCriteria?.length) {
    lines.push("", "## Pass Standard");
    for (const criterion of context.exitCriteria) lines.push(`- ${criterion}`);
  }

  const needsEnvironmentTruth = ["scope", "implement", "acceptance"].includes(context.stageKey);
  if (needsEnvironmentTruth && context.environmentTruth) {
    lines.push("", "## Target Environment", "```json", JSON.stringify(context.environmentTruth, null, 2), "```");
  }
  if (context.stageKey === "acceptance" && context.lifecycleSnapshot) {
    lines.push("", "## Acceptance Configuration", "```json", JSON.stringify(context.lifecycleSnapshot, null, 2), "```");
  }
  if (context.extraContext !== undefined) {
    lines.push("", "## Stage-Specific Context", "```json", JSON.stringify(context.extraContext, null, 2), "```");
  }

  if (context.allowedTransitions?.length) {
    lines.push("", "## Outcomes");
    for (const transition of context.allowedTransitions) {
      const target = transition.toStageKey ? `→ ${transition.toStageKey}` : "→ terminal";
      lines.push(`- **${transition.on}** ${target}${transition.reason ? `: ${transition.reason}` : ""}`);
    }
  }

  lines.push("", "## Completion", `Workflow run: ${context.workflowRunId}. Attempt ${context.attemptNumber}/${context.maxAttempts}.`, "State the outcome, cite the evidence created, and name the next required action for any failure or blocker.");
  return lines.join("\n");
}

async function ensureWorkflowParentSession(detail: WorkflowRunDetail): Promise<string> {
  if (detail.run.parentSessionId) {
    await linkWorkflowSession({ workflowRunId: detail.run.id, sessionId: detail.run.parentSessionId, role: "parent" });
    return detail.run.parentSessionId;
  }
  const { chatFileStorage } = await import("../chat-file-storage");
  const title = `Workflow: ${detail.run.title}`;
  const session = await chatFileStorage.createAutonomousSession(
    title,
    "agent",
    `workflow:${detail.run.id}`,
    undefined,
    undefined,
    { triggerType: "plan", triggerId: detail.run.id, triggerName: title },
  );
  await db.update(workflowRuns).set({ parentSessionId: session.id, updatedAt: new Date() }).where(writable(runScopeColumns, eq(workflowRuns.id, detail.run.id)));
  await linkWorkflowSession({ workflowRunId: detail.run.id, sessionId: session.id, role: "parent" });
  const isDraft = detail.run.status === "draft";
  await notifyWorkflowProgress(
    session.id,
    detail.run.id,
    isDraft
      ? `Workflow draft created: **${detail.run.title}**. Preview only. No stages, implementation, builds, deploys, or acceptance actions are running until the workflow is started.`
      : `Workflow started: **${detail.run.title}**. Progress will checkpoint to the workflow run artifact.`,
  );
  return session.id;
}

async function notifyWorkflowProgress(parentSessionId: string | null | undefined, runId: string, message: string): Promise<void> {
  if (!parentSessionId) return;
  try {
    const { chatFileStorage } = await import("../chat-file-storage");
    await chatFileStorage.createMessage(parentSessionId, "assistant", message, undefined, undefined, "workflow-executor");
  } catch (err) {
    log.warn(`[${runId}] Failed to write workflow progress message: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function acceptanceStageContext(detail: WorkflowRunDetail): Record<string, unknown> | undefined {
  if (detail.template.id !== BUILD_WORKFLOW_TEMPLATE_ID || detail.run.currentStageKey !== "acceptance") return undefined;
  const truth = detail.environmentTruth || null;
  const publicUrl = typeof truth?.deployment?.publicUrl === "string" && truth.deployment.publicUrl
    ? (truth.deployment.publicUrl.startsWith("http") ? truth.deployment.publicUrl : `https://${truth.deployment.publicUrl}`)
    : null;
  return {
    v1AcceptanceEvidenceContract: {
      requiredGates: ACCEPTANCE_GATE_KEYS,
      targetUrl: publicUrl,
      deploymentStatus: truth?.deployment?.latest ? String(truth.deployment.latest.status || "unknown") : null,
      routePathDefault: "/workflows",
      routePathSelection: "Prefer a route explicitly named in scope or changed files. Otherwise load /workflows because this workflow system is the product surface under acceptance.",
      logPolicy: "Check structured client and server logs after browser load. Treat relevant error-level entries as gate failures unless clearly unrelated.",
      smokePolicy: "Attempt the smallest safe feature path. If no non-destructive path exists, mark optional smoke attempted=false with reason rather than blocking.",
      failurePacketRequiredOnFail: ["failedGates", "targetUrl", "routePath", "deployment", "screenshot", "clientLogErrors", "serverLogErrors", "nextSuggestedFix"],
    },
  };
}

function calibrationStageContext(detail: WorkflowRunDetail): Record<string, unknown> | undefined {
  if (detail.template.id !== BUILD_WORKFLOW_TEMPLATE_ID || detail.run.currentStageKey !== "calibration") return undefined;
  const acceptanceArtifacts = detail.artifacts.filter((artifact) => artifact.kind === "acceptance" || artifact.kind === "screenshot" || artifact.kind === "logs").slice(-10);

  // Detect repeated identical acceptance failures — if the same gate keys failed ≥2 consecutive times, escalate to user gate
  const acceptanceAttempts = detail.stages.find((s) => s.key === "acceptance")?.attempts || [];
  const failedAttempts = acceptanceAttempts.filter((a) => a.status === "completed" && a.result === "failed").slice(-3);
  let repeatedFailureEscalation: Record<string, unknown> | undefined;
  if (failedAttempts.length >= 2) {
    const getFailedGates = (a: typeof failedAttempts[0]) => {
      const fc = a.failureContext as Record<string, unknown> | null;
      const gates = (fc?.failedGates as string[]) || [];
      return gates.sort().join(",");
    };
    const lastTwo = failedAttempts.slice(-2);
    if (lastTwo[0] && lastTwo[1] && getFailedGates(lastTwo[0]) === getFailedGates(lastTwo[1]) && getFailedGates(lastTwo[0]) !== "") {
      repeatedFailureEscalation = {
        detected: true,
        consecutiveIdenticalFailures: lastTwo.length,
        repeatedFailedGates: getFailedGates(lastTwo[0]).split(","),
        directive: "MANDATORY: The same acceptance gates have failed identically ≥2 consecutive times. This indicates a tooling or infrastructure issue that code changes cannot fix. You MUST open a user gate (complete with result 'needs_review') so the user can inspect and decide. Do NOT loop back to implement.",
      };
    }
  }

  return {
    calibrationContract: {
      compareAgainst: "Build workflow v1 spec: Design → Design Review → Implement → Implementation Review → Acceptance Test → Calibration → Documentation.",
      inspectArtifacts: acceptanceArtifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, title: artifact.title, summary: artifact.summary, metadata: artifact.metadata })),
      requiredDecision: "Pass only if acceptance evidence is complete enough and no hard gate remains. Fail back to implementation for product defects. Block/surface gate only for hard user gates, danger/security/privacy, principle conflict, production release, or exhausted retries.",
      documentationUpdatePolicy: "Attach a calibration artifact recording workflow/spec/doc updates needed or made. Do not create a user gate for routine documentation updates.",
      ...(repeatedFailureEscalation ? { repeatedFailureEscalation } : {}),
    },
  };
}

async function spawnWorkflowStageChild(parentSessionId: string, detail: WorkflowRunDetail, stageKey: string, stageTitle: string, attemptNumber: number, inputContext: WorkflowStageInputContext & { extraContext?: unknown }): Promise<string> {
  const { spawnChildSession } = await import("../sessions/tree");
  const spawnReason = `workflow:${detail.run.id}:${stageKey}:attempt-${attemptNumber}`;
  const result = await spawnChildSession(parentSessionId, {
    spawnReason,
    spawnerTool: "workflow-executor",
    spawnerSkillRun: `workflow:${detail.run.id}`,
    preContext: buildStageBrief(inputContext),
    waitForCompletion: false,
    titleOverride: `Workflow: ${stageTitle} #${attemptNumber}`,
    sessionKeyOverride: `workflow:${detail.run.id}:${stageKey}`,
  });
  return result.sessionId;
}

/**
 * Monitor a workflow stage child session for executor failures.
 * Successful child completion is not stage completion. The explicit
 * completeStageAttempt checkpoint is the sole transition owner.
 */
async function monitorWorkflowChild(
  attemptId: number,
  childSessionId: string,
  parentSessionId: string | null,
  runId: string,
  stageKey: string,
  stageTitle: string,
  attemptNumber: number,
): Promise<void> {
  const result = await monitorChildSession(
    childSessionId,
    WORKFLOW_STAGE_IDLE_TIMEOUT_MS,
    undefined, // no abort signal — workflows don't have a pause/abort mechanism yet
    parentSessionId || undefined,
  );

  // Check if the attempt was already completed by the child's own tool call.
  // The idempotency guard in completeStageAttempt will no-op, but we can
  // skip the call entirely to avoid noisy logs.
  const [currentAttempt] = await db.select().from(workflowStageAttempts)
    .where(and(eq(workflowStageAttempts.workflowRunId, runId), eq(workflowStageAttempts.id, attemptId))).limit(1);
  if (currentAttempt && currentAttempt.status !== "active") {
    log.log(`[monitor] Workflow attempt ${attemptId} (${stageTitle} #${attemptNumber}) already ${currentAttempt.status} — monitor no-op`);
    return;
  }

  switch (result.status) {
    case "completed": {
      log.warn(`[monitor] Workflow child ${childSessionId} completed without checkpointing ${stageTitle} #${attemptNumber}; leaving attempt ${attemptId} active for explicit completion`);
      break;
    }
    case "failed": {
      log.warn(`[monitor] Workflow child ${childSessionId} failed [${result.reason}]: ${result.message}`);
      await completeStageAttempt(runId, attemptId, {
        result: "failed",
        outputSummary: truncateOutput(result.message, 500),
        failureContext: { reason: result.reason, message: result.message, source: "child-session-monitor" },
      });
      break;
    }
    case "idle_timeout": {
      log.warn(`[monitor] Workflow child ${childSessionId} idle timeout after ${result.idleMinutes}m for ${stageTitle} #${attemptNumber}`);
      await completeStageAttempt(runId, attemptId, {
        result: "failed",
        outputSummary: `Stage child went idle for ${result.idleMinutes}m without completing. ${result.message}`,
        failureContext: { reason: "idle_timeout", idleMinutes: result.idleMinutes, message: result.message, source: "child-session-monitor" },
      });
      break;
    }
  }
}


export const BUILD_WORKFLOW_TEMPLATE_ID = "build-v1";

const buildDefinition = workflowTemplateDefinitionSchema.parse({
  stages: [
    {
      key: "scope", title: "Design", position: 0, autonomyMode: "autonomous",
      evidenceRequirements: ["A complete implementation design with success conditions, target truth, verification path, and terminal state, grounded in the loaded governing context."],
      allowedTransitions: [{ toStageKey: "design_review", on: "pass" }, { toStageKey: null, on: "blocked" }],
    },
    {
      key: "design_review", title: "Design Review", position: 1, autonomyMode: "requires_agent_review",
      entryCriteria: ["Inspect the proposed design, the current user-visible artifact or system, and every loaded governing artifact relevant to the design."],
      evidenceRequirements: ["Find and report material defects, omissions, unjustified complexity, and governing-context violations. Require structural cures before passing."],
      exitCriteria: ["Pass only when the proposed design is coherent, complete, and compliant with the loaded governing context."],
      allowedTransitions: [{ toStageKey: "implement", on: "pass" }, { toStageKey: "scope", on: "fail" }],
    },
    {
      key: "implement", title: "Implement", position: 2, autonomyMode: "autonomous",
      evidenceRequirements: ["Implementation evidence, build result, impact/change-scope evidence, and branch/commit references proving the approved design was executed under the loaded governing context."],
      allowedTransitions: [{ toStageKey: "code_review", on: "pass" }, { toStageKey: "design_review", on: "blocked" }],
    },
    {
      key: "code_review", title: "Implementation Review", position: 3, autonomyMode: "requires_agent_review",
      entryCriteria: ["Inspect the complete implementation, affected systems, approved design, and every loaded governing artifact before judging readiness."],
      evidenceRequirements: ["Find and report material defects, inconsistencies, technical debt, and governing-context violations in the resulting implementation. State required cures, residual risk, and acceptance readiness."],
      exitCriteria: ["Pass only when no material implementation or governing-context violation remains."],
      allowedTransitions: [{ toStageKey: "acceptance", on: "pass" }, { toStageKey: "implement", on: "fail" }, { toStageKey: "design_review", on: "blocked" }],
    },
    {
      key: "acceptance", title: "Acceptance Test", position: 4, autonomyMode: "autonomous",
      entryCriteria: ["Confirm the merged implementation is deployed and healthy in the target environment before testing the user-visible result."],
      evidenceRequirements: ["Deployment, health, target-route, screenshot, runtime-log, and safe feature-path evidence sufficient to determine whether the deployed result satisfies the approved design and success conditions."],
      exitCriteria: ["Pass only when the deployed result satisfies the approved design and user-visible success conditions."],
      allowedTransitions: [{ toStageKey: "calibration", on: "pass" }, { toStageKey: "implement", on: "fail" }, { toStageKey: "implement", on: "blocked" }],
    },
    {
      key: "calibration", title: "Calibration", position: 5, autonomyMode: "autonomous",
      evidenceRequirements: ["A comparison of the run, retries, and acceptance evidence against the workflow and loaded governing context, with any product, process, or protocol changes identified."],
      allowedTransitions: [{ toStageKey: "documentation", on: "pass" }, { toStageKey: "implement", on: "fail" }, { toStageKey: "scope", on: "blocked" }, { toStageKey: null, on: "needs_review", reason: "hard gate" }],
    },
    {
      key: "documentation", title: "Documentation", position: 6, autonomyMode: "autonomous",
      evidenceRequirements: ["Durable final documentation that records the implemented truth, linked evidence, decisions, handoff, and any remaining gates under the loaded governing context."],
      allowedTransitions: [{ toStageKey: null, on: "pass", reason: "complete" }, { toStageKey: "documentation", on: "fail" }],
    },
  ],
  terminalStatuses: ["completed", "failed", "canceled"],
});

const buildRetryPolicy = {
  maxAttemptsPerStage: 10,
  freshSessionPerRetry: true,
  requireDifferentApproachInstruction: true,
  escalateOnDanger: true,
  escalateOnSecurityOrPrivacyRisk: true,
  escalateOnCredentialNeed: true,
  escalateOnProductionRelease: true,
  escalateOnPrincipleConflict: true,
};

export async function seedBuildWorkflowTemplate(): Promise<WorkflowTemplate> {
  const [existing] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, BUILD_WORKFLOW_TEMPLATE_ID)).limit(1);
  const values = {
    name: "Build",
    type: "build",
    description: "Reusable software build lifecycle: scope, design review, implementation, code review, staged publish, acceptance, calibration, and documentation.",
    version: "1.0",
    status: "active",
    definition: buildDefinition,
    defaultAutonomyPolicy: buildRetryPolicy,
    enabled: true,
    // Built-in workflow templates must be visible to authenticated users.
    // scope='system' is intentionally private to system principals in scoped-storage;
    // scope='global' is the shared/template visibility boundary.
    scope: "global",
    updatedAt: new Date(),
  };
  if (existing) {
    const [updated] = await db.update(workflowTemplates).set(values).where(eq(workflowTemplates.id, BUILD_WORKFLOW_TEMPLATE_ID)).returning();
    return updated;
  }
  const [created] = await db.insert(workflowTemplates).values({ id: BUILD_WORKFLOW_TEMPLATE_ID, ...values }).returning();
  return created;
}

export async function listWorkflowTemplates(filters: { type?: string; status?: string; limit?: number } = {}): Promise<WorkflowTemplate[]> {
  const clauses: SQL[] = [];
  if (filters.type) clauses.push(eq(workflowTemplates.type, filters.type));
  if (filters.status) clauses.push(eq(workflowTemplates.status, workflowTemplateStatusSchema.parse(filters.status)));
  return db.select().from(workflowTemplates)
    .where(visible(templateScopeColumns, clauses.length ? and(...clauses) : undefined))
    .orderBy(desc(workflowTemplates.updatedAt))
    .limit(Math.min(filters.limit || 50, 100));
}

export async function getWorkflowTemplate(templateId: string): Promise<WorkflowTemplate | null> {
  const [template] = await db.select().from(workflowTemplates).where(visible(templateScopeColumns, eq(workflowTemplates.id, templateId))).limit(1);
  return template || null;
}

export async function getWorkflowEnvironmentTruth(runIdOrEnvironmentId: string | number, expectedCommitSha?: string | null): Promise<WorkflowEnvironmentTruth | null> {
  let environmentId: number | null = typeof runIdOrEnvironmentId === "number" ? runIdOrEnvironmentId : null;
  if (typeof runIdOrEnvironmentId === "string") {
    const [run] = await db.select({ environmentId: workflowRuns.linkedEnvironmentId }).from(workflowRuns).where(visible(runScopeColumns, eq(workflowRuns.id, runIdOrEnvironmentId))).limit(1);
    environmentId = run?.environmentId ?? null;
  }
  if (!environmentId) return null;

  const [row] = await db
    .select({
      platform: platforms,
      product: platformProducts,
      environment: platformProductEnvironments,
    })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(and(eq(platformProductEnvironments.id, environmentId), visible(platformScopeColumns)))
    .limit(1);
  if (!row) return null;

  const [sourceRow] = await db.select().from(environmentSourceBindings).where(eq(environmentSourceBindings.environmentId, environmentId)).limit(1);
  const [hostingRow] = await db.select().from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, environmentId)).limit(1);
  const connectionIds = [sourceRow?.connectionId, hostingRow?.connectionId].filter((id): id is number => typeof id === "number");
  const connections = connectionIds.length
    ? await db.select().from(providerConnections).where(visible({ scope: providerConnections.scope, ownerUserId: providerConnections.ownerUserId, accountId: providerConnections.accountId }, inArray(providerConnections.id, connectionIds)))
    : [];
  const connectionFor = (id: number | null | undefined) => connections.find((connection) => connection.id === id) || null;
  const source = sanitizeSourceBinding(sourceRow, connectionFor(sourceRow?.connectionId));
  const hosting = sanitizeHostingBinding(hostingRow, connectionFor(hostingRow?.connectionId));

  let deployment: WorkflowEnvironmentTruth["deployment"] = null;
  const hostingProvider = hostingRow?.provider || connectionFor(hostingRow?.connectionId)?.provider || "railway";
  const deploymentBase = {
    provider: hostingProvider,
    publicUrl: hostingRow?.publicUrl || null,
    checkedAt: new Date().toISOString(),
  };
  const unavailableDeployment = (reason: string): NonNullable<WorkflowEnvironmentTruth["deployment"]> => ({
    ...deploymentBase,
    available: false,
    reason,
    latest: null,
    urlReachable: null,
  });

  if (!hostingRow) {
    deployment = unavailableDeployment("Hosting binding is not configured");
  } else if (!hostingRow.connectionId) {
    deployment = unavailableDeployment(`${hostingProvider} hosting binding has no provider connection`);
  } else {
    const connection = connectionFor(hostingRow.connectionId);
    const token = connection?.credentialRef ? await getProviderCredential(connection.credentialRef) : null;
    if (!token) {
      deployment = unavailableDeployment(`Connection has no decryptable ${hostingProvider} credential`);
    } else {
      let urlReachable: boolean | null = null;
      if (hostingRow.publicUrl) {
        try {
          const healthUrl = hostingRow.publicUrl.startsWith("http") ? hostingRow.publicUrl : `https://${hostingRow.publicUrl}`;
          const res = await fetch(healthUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) });
          urlReachable = res.ok;
        } catch {
          urlReachable = false;
        }
      }
      try {
        if (hostingProvider === "cloudflare") {
          if (!hostingRow.projectId || !hostingRow.projectName) {
            deployment = unavailableDeployment("Cloudflare Pages hosting binding is incomplete (need accountId in projectId and project name in projectName)");
          } else {
            const latest = await getCloudflareLatestDeployment(token, hostingRow.projectId, hostingRow.projectName, hostingRow.providerEnvironmentId || "production");
            deployment = {
              ...deploymentBase,
              available: true,
              latest: latest ? { id: latest.id, status: latest.status, commitSha: latest.commitHash, commitMessage: latest.commitMessage, branch: latest.branch, url: latest.url, deployedAt: latest.createdAt } : null,
              urlReachable,
            };
          }
        } else if (hostingProvider === "railway") {
          if (!hostingRow.projectId || !hostingRow.serviceId || !hostingRow.providerEnvironmentId) {
            deployment = unavailableDeployment("Railway hosting binding is incomplete");
          } else {
            let latest = await getLatestDeploymentByToken(token, hostingRow.projectId, hostingRow.serviceId, hostingRow.providerEnvironmentId);
            if (expectedCommitSha && !commitMatches(expectedCommitSha, latest?.commitHash || null)) {
              const deployments = await fetchDeployments(hostingRow.projectId, hostingRow.serviceId, 25, token);
              const matching = deployments.find((candidate) => {
                if (candidate.environmentId !== hostingRow.providerEnvironmentId) return false;
                const meta = extractDeploymentMeta(candidate.meta);
                return commitMatches(expectedCommitSha, meta.commitHash || null);
              });
              if (matching) {
                const meta = extractDeploymentMeta(matching.meta);
                latest = {
                  id: matching.id,
                  status: matching.status,
                  commitHash: meta.commitHash || null,
                  commitMessage: meta.commitMessage || null,
                  createdAt: matching.createdAt,
                };
              }
            }
            deployment = {
              ...deploymentBase,
              available: true,
              latest: latest ? { id: latest.id, status: latest.status, commitSha: latest.commitHash, commitMessage: latest.commitMessage, deployedAt: latest.createdAt } : null,
              urlReachable,
            };
          }
        } else {
          deployment = unavailableDeployment(`Deployment status is unsupported for hosting provider ${hostingProvider}`);
        }
      } catch (err) {
        deployment = unavailableDeployment(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return {
    platform: { id: row.platform.id, name: row.platform.name },
    product: { id: row.product.id, name: row.product.name },
    environment: { id: row.environment.id, name: row.environment.name, kind: environmentKind(row.environment.name), status: source || hosting ? "configured" : "planned" },
    source,
    hosting,
    deployment,
  };
}

export async function createWorkflowRun(input: {
  templateId?: string;
  title: string;
  objective: string;
  autonomyPolicy?: unknown;
  retryPolicy?: unknown;
  lifecycleSnapshot?: unknown;
  parentSessionId?: string;
  linkedPlanId?: string;
  linkedProjectId?: number;
  linkedPlatformId?: number;
  linkedProductId?: number;
  linkedEnvironmentId?: number;
  createdBySessionId?: string;
}): Promise<WorkflowRunDetail> {
  const templateId = input.templateId || BUILD_WORKFLOW_TEMPLATE_ID;
  const template = await getWorkflowTemplate(templateId) || (templateId === BUILD_WORKFLOW_TEMPLATE_ID ? await seedBuildWorkflowTemplate() : null);
  if (!template) throw new Error(`Workflow template not found: ${templateId}`);
  if (!input.title?.trim()) throw new Error("Workflow title is required");
  if (!input.objective?.trim()) throw new Error("Workflow objective is required");

  const id = generateWorkflowRunId();
  const initialContent = `# Workflow: ${input.title}\n\nCreating checkpoint...`;
  const { createFiledLibraryPage } = await import("../library-save");
  const page = await createFiledLibraryPage({
    title: `Workflow: ${input.title}`,
    markdown: initialContent,
    purpose: "workflows",
    pageContext: "/workflows",
    contentSummary: `Workflow checkpoint for ${input.title}: ${input.objective}`,
    tags: ["workflow", "checkpoint"],
    createdBySessionId: input.createdBySessionId || input.parentSessionId,
    slugSuffix: Math.random().toString(36).slice(2, 7),
  });
  const definition = parseWorkflowDefinition(template);
  const firstStage = definition.stages.slice().sort((a, b) => a.position - b.position)[0];
  const ownerValues = owner(runScopeColumns);

  await db.insert(workflowRuns).values({
    id,
    templateId,
    title: input.title.trim(),
    objective: input.objective.trim(),
    status: "draft",
    currentStageKey: firstStage?.key || null,
    autonomyPolicy: input.autonomyPolicy || template.defaultAutonomyPolicy || {},
    retryPolicy: input.retryPolicy || buildRetryPolicy,
    lifecycleSnapshot: input.lifecycleSnapshot ?? null,
    parentSessionId: input.parentSessionId || null,
    linkedLibraryPageId: page.id,
    linkedPlanId: input.linkedPlanId || null,
    linkedProjectId: input.linkedProjectId ?? null,
    linkedPlatformId: input.linkedPlatformId ?? null,
    linkedProductId: input.linkedProductId ?? null,
    linkedEnvironmentId: input.linkedEnvironmentId ?? null,
    createdBySessionId: input.createdBySessionId || null,
    ...ownerValues,
  });

  if (input.parentSessionId) await linkWorkflowSession({ workflowRunId: id, sessionId: input.parentSessionId, role: "parent" });
  await recordTransition({ workflowRunId: id, fromStageKey: null, toStageKey: firstStage?.key || null, trigger: "system", reason: "run_created", createdBySessionId: input.createdBySessionId, render: false });
  const created = await getWorkflowRun(id);
  if (!created) throw new Error(`Workflow run disappeared after create: ${id}`);
  await ensureWorkflowParentSession(created);
  await renderWorkflowRunPage(id);
  const detail = await getWorkflowRun(id);
  if (!detail) throw new Error(`Workflow run disappeared after parent session creation: ${id}`);
  return detail;
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunDetail | null> {
  const [run] = await db.select().from(workflowRuns).where(visible(runScopeColumns, eq(workflowRuns.id, runId))).limit(1);
  if (!run) return null;
  const template = await getWorkflowTemplate(run.templateId);
  if (!template) throw new Error(`Workflow template missing: ${run.templateId}`);
  const [attempts, transitions, artifacts, gates, sessions] = await Promise.all([
    db.select().from(workflowStageAttempts).where(visible(attemptScopeColumns, eq(workflowStageAttempts.workflowRunId, run.id))).orderBy(workflowStageAttempts.stageKey, workflowStageAttempts.attemptNumber),
    db.select().from(workflowTransitions).where(visible(transitionScopeColumns, eq(workflowTransitions.workflowRunId, run.id))).orderBy(workflowTransitions.createdAt),
    db.select().from(workflowArtifacts).where(visible(artifactScopeColumns, eq(workflowArtifacts.workflowRunId, run.id))).orderBy(workflowArtifacts.createdAt),
    db.select().from(workflowGates).where(visible(gateScopeColumns, eq(workflowGates.workflowRunId, run.id))).orderBy(desc(workflowGates.openedAt)),
    db.select().from(workflowSessions).where(visible(sessionScopeColumns, eq(workflowSessions.workflowRunId, run.id))).orderBy(workflowSessions.createdAt),
  ]);
  const base = { run, template, attempts, transitions, artifacts, gates, sessions };
  const environmentTruth = await getWorkflowEnvironmentTruth(run.id);
  return {
    run,
    template,
    stages: buildWorkflowStages(base),
    transitions,
    artifacts,
    gates,
    sessions,
    linked: {
      projectId: run.linkedProjectId,
      platformId: run.linkedPlatformId,
      productId: run.linkedProductId,
      environmentId: run.linkedEnvironmentId,
      libraryPageId: run.linkedLibraryPageId,
      planId: run.linkedPlanId,
    },
    environmentTruth,
    lifecycleSnapshot: run.lifecycleSnapshot || null,
  };
}

export async function listWorkflowRuns(filters: { status?: string; templateId?: string; projectId?: number; platformId?: number; productId?: number; environmentId?: number; limit?: number } = {}): Promise<WorkflowRun[]> {
  const clauses: SQL[] = [isNull(workflowRuns.archivedAt)];
  if (filters.status) clauses.push(eq(workflowRuns.status, workflowRunStatusSchema.parse(filters.status)));
  if (filters.templateId) clauses.push(eq(workflowRuns.templateId, filters.templateId));
  if (filters.projectId) clauses.push(eq(workflowRuns.linkedProjectId, filters.projectId));
  if (filters.platformId) clauses.push(eq(workflowRuns.linkedPlatformId, filters.platformId));
  if (filters.productId) clauses.push(eq(workflowRuns.linkedProductId, filters.productId));
  if (filters.environmentId) clauses.push(eq(workflowRuns.linkedEnvironmentId, filters.environmentId));
  return db.select().from(workflowRuns).where(visible(runScopeColumns, and(...clauses))).orderBy(desc(workflowRuns.updatedAt)).limit(Math.min(filters.limit || 50, 100));
}

export async function updateWorkflowRun(runId: string, patch: Partial<{ title: string; objective: string; status: string; currentStageKey: string | null; linkedPlanId: string | null; linkedProjectId: number | null; linkedPlatformId: number | null; linkedProductId: number | null; linkedEnvironmentId: number | null; failurePacket: unknown }>): Promise<WorkflowRunDetail> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.objective !== undefined) updates.objective = patch.objective;
  if (patch.status !== undefined) updates.status = workflowRunStatusSchema.parse(patch.status);
  if (patch.currentStageKey !== undefined) updates.currentStageKey = patch.currentStageKey;
  if (patch.linkedPlanId !== undefined) updates.linkedPlanId = patch.linkedPlanId;
  if (patch.linkedProjectId !== undefined) updates.linkedProjectId = patch.linkedProjectId;
  if (patch.linkedPlatformId !== undefined) updates.linkedPlatformId = patch.linkedPlatformId;
  if (patch.linkedProductId !== undefined) updates.linkedProductId = patch.linkedProductId;
  if (patch.linkedEnvironmentId !== undefined) updates.linkedEnvironmentId = patch.linkedEnvironmentId;
  if (patch.failurePacket !== undefined) updates.failurePacket = patch.failurePacket;
  const [updated] = await db.update(workflowRuns).set(updates).where(writable(runScopeColumns, eq(workflowRuns.id, runId))).returning();
  if (!updated) throw new Error(`Workflow run not found or not writable: ${runId}`);
  await renderWorkflowRunPage(runId);
  return (await getWorkflowRun(runId))!;
}

async function assertNoOpenGate(runId: string): Promise<void> {
  const [openGate] = await db.select({ id: workflowGates.id }).from(workflowGates).where(visible(gateScopeColumns, and(eq(workflowGates.workflowRunId, runId), eq(workflowGates.status, "open")))).limit(1);
  if (openGate) throw new Error(`Workflow run ${runId} has open gate ${openGate.id}; autonomous advancement is blocked.`);
}

export async function recordTransition(input: { workflowRunId: string; fromStageKey?: string | null; toStageKey?: string | null; fromAttemptId?: number | null; trigger: WorkflowTransitionTrigger | string; reason?: string; evidence?: unknown; createdBySessionId?: string; render?: boolean }): Promise<WorkflowTransition> {
  const trigger = workflowTransitionTriggerSchema.parse(input.trigger);
  const [transition] = await db.insert(workflowTransitions).values({
    workflowRunId: input.workflowRunId,
    fromStageKey: input.fromStageKey ?? null,
    toStageKey: input.toStageKey ?? null,
    fromAttemptId: input.fromAttemptId ?? null,
    trigger,
    reason: input.reason || "",
    evidence: input.evidence || {},
    createdBySessionId: input.createdBySessionId || null,
    ...owner(transitionScopeColumns),
  }).returning();
  await db.update(workflowRuns).set({ currentStageKey: input.toStageKey ?? null, updatedAt: new Date() }).where(writable(runScopeColumns, eq(workflowRuns.id, input.workflowRunId)));
  if (input.render !== false) await renderWorkflowRunPage(input.workflowRunId);
  return transition;
}

export async function startWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  const detail = await getWorkflowRun(runId);
  if (!detail) throw new Error(`Workflow run not found: ${runId}`);
  if (!["draft", "paused", "blocked"].includes(detail.run.status)) throw new Error(`Workflow run status is ${detail.run.status}; cannot start.`);
  await assertNoOpenGate(runId);

  // Require linkedEnvironmentId when the template includes an acceptance stage
  const definition = parseWorkflowDefinition(detail.template);
  const hasAcceptanceStage = definition.stages.some((s) => s.key === "acceptance");
  if (hasAcceptanceStage && !detail.run.linkedEnvironmentId) {
    throw new Error(`Workflow template "${detail.template.name}" includes an acceptance stage but no linkedEnvironmentId is set. Link a platform environment before starting.`);
  }
  const parentSessionId = await ensureWorkflowParentSession(detail);
  await db.update(workflowRuns).set({ status: "active", updatedAt: new Date() }).where(writable(runScopeColumns, eq(workflowRuns.id, runId)));
  const stageKey = detail.run.currentStageKey;
  await notifyWorkflowProgress(parentSessionId, runId, `Workflow active: **${detail.run.title}** at stage ${stageKey || "none"}.`);
  await renderWorkflowRunPage(runId);

  // Auto-kick the current stage if no active attempt exists yet
  if (stageKey) {
    const stageState = detail.stages.find((st) => st.key === stageKey);
    const hasActiveAttempt = stageState?.attempts.some((a) => a.status === "active");
    if (!hasActiveAttempt) {
      await startStageAttempt(runId, stageKey, { spawnChildSession: true });
    }
  }

  return (await getWorkflowRun(runId))!;
}

export async function pauseWorkflowRun(runId: string, reason = "paused"): Promise<WorkflowRunDetail> {
  await recordTransition({ workflowRunId: runId, fromStageKey: (await getWorkflowRun(runId))?.run.currentStageKey ?? null, toStageKey: (await getWorkflowRun(runId))?.run.currentStageKey ?? null, trigger: "manual", reason, render: false });
  return updateWorkflowRun(runId, { status: "paused" });
}

export async function resumeWorkflowRun(runId: string): Promise<WorkflowRunDetail> { return startWorkflowRun(runId); }
export async function cancelWorkflowRun(runId: string, reason = "canceled"): Promise<WorkflowRunDetail> {
  const detail = await getWorkflowRun(runId);
  await recordTransition({ workflowRunId: runId, fromStageKey: detail?.run.currentStageKey ?? null, toStageKey: null, trigger: "manual", reason, render: false });
  return updateWorkflowRun(runId, { status: "canceled", currentStageKey: null });
}

function stageFor(detail: WorkflowRunDetail, stageKey: string) {
  const def = parseWorkflowDefinition(detail.template).stages.find((s) => s.key === stageKey);
  if (!def) throw new Error(`Stage ${stageKey} not found in template ${detail.template.id}`);
  return def;
}

export async function startStageAttempt(runId: string, stageKey?: string, options: { childSessionId?: string; linkedPlanId?: string; inputContext?: unknown; createdBySessionId?: string; spawnChildSession?: boolean } = {}): Promise<WorkflowStageAttempt> {
  const detail = await getWorkflowRun(runId);
  if (!detail) throw new Error(`Workflow run not found: ${runId}`);
  await assertNoOpenGate(runId);
  const key = stageKey || detail.run.currentStageKey;
  if (!key) throw new Error(`Workflow run ${runId} has no current stage.`);
  const stage = stageFor(detail, key);
  const stageState = detail.stages.find((s) => s.key === key);
  // Idempotency guard: if an active attempt already exists for this stage, return it instead of creating a duplicate
  const existingActive = stageState?.attempts.find((a) => a.status === "active");
  if (existingActive) {
    log.warn(`startStageAttempt: active attempt ${existingActive.id} already exists for stage ${key} on run ${runId}. Returning existing.`);
    return existingActive;
  }
  const maxAttempt = Math.max(0, ...(stageState?.attempts.map((a) => a.attemptNumber) || [0]));
  const attemptNumber = maxAttempt + 1;
  const maxAttempts = getMaxAttempts(detail);
  if (attemptNumber > maxAttempts) throw new Error(`Workflow run ${runId} stage ${key} exceeded max attempts (${maxAttempts}).`);

  const parentSessionId = await ensureWorkflowParentSession(detail);
  const stageSpecificContext = key === "acceptance" ? acceptanceStageContext(detail) : key === "calibration" ? calibrationStageContext(detail) : undefined;
  const mergedInputContext = stageSpecificContext || options.inputContext !== undefined
    ? { ...(typeof stageSpecificContext === "object" ? stageSpecificContext : {}), ...(typeof options.inputContext === "object" && options.inputContext !== null ? options.inputContext as Record<string, unknown> : options.inputContext !== undefined ? { input: options.inputContext } : {}) }
    : undefined;
  const inputContext = await buildStageInputContext(detail, key, stage, attemptNumber, mergedInputContext);

  const [attempt] = await db.insert(workflowStageAttempts).values({
    workflowRunId: runId,
    stageKey: key,
    stageTitle: stage.title,
    attemptNumber,
    status: "active",
    autonomyMode: workflowAutonomyModeSchema.parse(stage.autonomyMode),
    childSessionId: options.childSessionId || null,
    linkedPlanId: options.linkedPlanId || null,
    inputContext: { ...inputContext, stageAttemptId: null },
    startedAt: new Date(),
    ...owner(attemptScopeColumns),
  }).returning();
  const persistedInputContext = { ...inputContext, stageAttemptId: attempt.id };
  let childSessionId = options.childSessionId || null;
  try {
    childSessionId = childSessionId || (options.spawnChildSession === false ? null : await spawnWorkflowStageChild(parentSessionId, detail, key, stage.title, attemptNumber, persistedInputContext));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(workflowStageAttempts).set({ status: "failed", result: "failed", outputSummary: `Failed to spawn workflow child: ${message}`, failureContext: { reason: "child_spawn_failed", message }, completedAt: new Date(), updatedAt: new Date() }).where(writable(attemptScopeColumns, and(eq(workflowStageAttempts.workflowRunId, runId), eq(workflowStageAttempts.id, attempt.id))));
    throw error;
  }
  await db.update(workflowStageAttempts).set({ childSessionId, inputContext: persistedInputContext, updatedAt: new Date() }).where(writable(attemptScopeColumns, and(eq(workflowStageAttempts.workflowRunId, runId), eq(workflowStageAttempts.id, attempt.id))));
  if (childSessionId) await linkWorkflowSession({ workflowRunId: runId, stageAttemptId: attempt.id, sessionId: childSessionId, role: "stage_attempt", spawnReason: `workflow:${runId}:${key}:attempt-${attemptNumber}` });
  if (key === "acceptance" && childSessionId) {
    const expected = expectedAcceptanceDeployment(detail);
    const truth = await getWorkflowEnvironmentTruth(runId, expected.commitSha);
    if (!deploymentIsCurrent(truth?.deployment, expected) || deploymentStatusCategory(normalizedDeploymentStatus(truth?.deployment)) === "pending") {
      await chatFileStorage.updateSessionStatus(childSessionId, "waiting");
    }
  }
  await db.update(workflowRuns).set({ status: "active", currentStageKey: key, updatedAt: new Date() }).where(writable(runScopeColumns, eq(workflowRuns.id, runId)));
  await notifyWorkflowProgress(parentSessionId, runId, `Started workflow stage **${stage.title}** attempt ${attemptNumber}/${maxAttempts}${childSessionId ? ` in child session ${childSessionId}` : ""}.`);
  await renderWorkflowRunPage(runId);

  // Fire-and-forget: monitor the child session and auto-complete the stage
  // when the child finishes. The child's own complete_stage_attempt tool call
  // becomes optional — the idempotency guard in completeStageAttempt handles
  // the case where both the child and the monitor try to complete.
  if (childSessionId) {
    monitorWorkflowChild(attempt.id, childSessionId, parentSessionId, runId, key, stage.title, attemptNumber).catch((err) => {
      log.error(`[monitor] Failed to monitor workflow child ${childSessionId} for attempt ${attempt.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return { ...attempt, childSessionId, inputContext: persistedInputContext };
}

function acceptanceGateFailureFromEvidence(attempt: WorkflowStageAttempt, result: string, evidence: unknown): Record<string, unknown> | null {
  if (attempt.stageKey !== "acceptance" || result !== "passed") return null;
  const packet = evidence && typeof evidence === "object" ? evidence as Record<string, any> : {};
  const gates = (packet.gates && typeof packet.gates === "object" ? packet.gates : packet.metadata?.gates && typeof packet.metadata.gates === "object" ? packet.metadata.gates : null) as Record<string, unknown> | null;
  if (!gates) {
    return {
      reason: "missing_acceptance_gate_packet",
      failedGates: ACCEPTANCE_GATE_KEYS,
      nextSuggestedFix: "Run capture_acceptance_evidence or provide an evidence.gates packet before passing acceptance.",
    };
  }
  const failedGates = ACCEPTANCE_GATE_KEYS.filter((key) => gates[key] !== true);
  if (failedGates.length === 0) return null;
  return packet.failurePacket && typeof packet.failurePacket === "object"
    ? packet.failurePacket as Record<string, unknown>
    : { reason: "acceptance_gate_failure", failedGates, gates, nextSuggestedFix: "Return to Implement, fix the failed gate, publish again, and rerun acceptance." };
}

export async function completeStageAttempt(workflowRunId: string, attemptId: number, resultInput: { result: string; outputSummary?: string; evidence?: unknown; failureContext?: unknown; createdBySessionId?: string }): Promise<WorkflowRunDetail> {
  if (!workflowRunId.trim()) throw new Error("completeStageAttempt requires workflowRunId");
  if (!Number.isSafeInteger(attemptId) || attemptId <= 0) throw new Error(`Invalid stage attempt ID: ${String(attemptId)}`);
  const requestedResult = workflowAttemptResultSchema.parse(resultInput.result);
  const [attempt] = await db.select().from(workflowStageAttempts).where(visible(attemptScopeColumns, and(eq(workflowStageAttempts.workflowRunId, workflowRunId), eq(workflowStageAttempts.id, attemptId)))).limit(1);
  if (!attempt) throw new Error(`Stage attempt ${attemptId} not found in workflow run ${workflowRunId}`);
  const beforeDetail = await getWorkflowRun(workflowRunId);
  if (!beforeDetail) throw new Error(`Workflow run not found: ${workflowRunId}`);
  if (beforeDetail.run.currentStageKey !== attempt.stageKey) throw new Error(`Stage attempt ${attemptId} is stale for workflow run ${workflowRunId}: attempt stage ${attempt.stageKey}, current stage ${beforeDetail.run.currentStageKey || "none"}`);
  const forcedAcceptanceFailure = acceptanceGateFailureFromEvidence(attempt, requestedResult, resultInput.evidence || attempt.evidence || {});
  const result = forcedAcceptanceFailure ? "failed" : requestedResult;
  const status = result === "passed" ? "passed" : result === "needs_review" ? "needs_review" : result === "blocked" ? "blocked" : result === "skipped" ? "skipped" : "failed";
  const durationSeconds = attempt.startedAt ? Math.max(0, Math.round((Date.now() - attempt.startedAt.getTime()) / 1000)) : null;
  const failurePacket = status === "failed" || status === "blocked"
    ? {
      attemptId: attempt.id,
      stageKey: attempt.stageKey,
      stageTitle: attempt.stageTitle,
      attemptNumber: attempt.attemptNumber,
      result,
      requestedResult,
      outputSummary: resultInput.outputSummary || null,
      failureContext: forcedAcceptanceFailure || resultInput.failureContext || null,
      evidence: resultInput.evidence || attempt.evidence || {},
      childSessionId: attempt.childSessionId,
    }
    : null;

  // Claim completion atomically. The child may call complete_stage_attempt while
  // the parent monitor observes the same terminal session state. Only the
  // winner may persist evidence or advance the workflow.
  const [completedAttempt] = await db.update(workflowStageAttempts).set({
    status,
    result,
    outputSummary: resultInput.outputSummary || null,
    evidence: resultInput.evidence || attempt.evidence || {},
    failureContext: failurePacket || resultInput.failureContext || null,
    completedAt: new Date(),
    durationSeconds,
    updatedAt: new Date(),
  }).where(writable(attemptScopeColumns, and(
    eq(workflowStageAttempts.workflowRunId, workflowRunId),
    eq(workflowStageAttempts.id, attemptId),
    eq(workflowStageAttempts.status, "active"),
    isNull(workflowStageAttempts.completedAt),
  ))).returning();
  if (!completedAttempt) {
    log.log(`completeStageAttempt lost completion claim for attempt ${attemptId}; another path already completed it.`);
    return (await getWorkflowRun(attempt.workflowRunId))!;
  }
  if (failurePacket) await db.update(workflowRuns).set({ failurePacket, updatedAt: new Date() }).where(writable(runScopeColumns, eq(workflowRuns.id, attempt.workflowRunId)));
  if (resultInput.evidence) await attachWorkflowArtifact({ workflowRunId: attempt.workflowRunId, stageAttemptId: attempt.id, kind: attempt.stageKey === "calibration" ? "calibration" : attempt.stageKey === "acceptance" ? "acceptance" : result === "passed" ? "acceptance" : "other", title: `${attempt.stageTitle} attempt ${result}`, summary: resultInput.outputSummary || "", metadata: resultInput.evidence, createdBySessionId: resultInput.createdBySessionId, render: false });

  const maxAttempts = getMaxAttempts(beforeDetail);
  const parentSessionId = beforeDetail.run.parentSessionId || null;
  await notifyWorkflowProgress(parentSessionId, attempt.workflowRunId, `Completed workflow stage **${attempt.stageTitle}** attempt ${attempt.attemptNumber}/${maxAttempts}: ${result}${resultInput.outputSummary ? ` — ${truncateText(resultInput.outputSummary, 180)}` : ""}.`);
  if ((status === "failed" || status === "blocked") && attempt.attemptNumber < maxAttempts) {
    await notifyWorkflowProgress(parentSessionId, attempt.workflowRunId, `Retry available for **${attempt.stageTitle}**. Next attempt will spawn a fresh child session with the failure packet and a different-approach instruction.`);
  }

  return advanceWorkflowRun(workflowRunId, result === "passed" ? "autonomous" : "system", attempt.id, result, resultInput.outputSummary || "");
}

export async function advanceWorkflowRun(runId: string, trigger: WorkflowTransitionTrigger | string = "autonomous", fromAttemptId?: number, result: string = "passed", reason = ""): Promise<WorkflowRunDetail> {
  const detail = await getWorkflowRun(runId);
  if (!detail) throw new Error(`Workflow run not found: ${runId}`);
  if (!(["system", "manual", "user_review"].includes(String(trigger)))) await assertNoOpenGate(runId);
  const current = detail.run.currentStageKey;
  if (!current) return detail;
  // Idempotency guard: if fromAttemptId belongs to a different stage than current, it's a stale signal
  if (fromAttemptId) {
    const [sourceAttempt] = await db.select().from(workflowStageAttempts).where(visible(attemptScopeColumns, and(eq(workflowStageAttempts.workflowRunId, runId), eq(workflowStageAttempts.id, fromAttemptId)))).limit(1);
    if (!sourceAttempt) throw new Error(`Stage attempt ${fromAttemptId} does not belong to workflow run ${runId}`);
    if (sourceAttempt.stageKey !== current) {
      log.warn(`advanceWorkflowRun: stale attempt ${fromAttemptId} (stage=${sourceAttempt.stageKey}) does not match current stage (${current}). No-op.`);
      return detail;
    }
  }
  const stage = stageFor(detail, current);
  const event = result === "passed" ? "pass" : result === "needs_review" ? "needs_review" : result === "blocked" ? "blocked" : result === "skipped" ? "manual" : "fail";
  const transitionDef = stage.allowedTransitions.find((t) => t.on === event) || stage.allowedTransitions.find((t) => t.on === "manual");
  if (!transitionDef) throw new Error(`No transition for ${current} on ${event}`);
  const next = transitionDef.toStageKey;
  await recordTransition({ workflowRunId: runId, fromStageKey: current, toStageKey: next, fromAttemptId, trigger, reason: reason || transitionDef.reason || event });
  const nextStatus = next ? (result === "blocked" || result === "needs_review" ? result : "active") : (result === "passed" ? "completed" : result === "blocked" ? "blocked" : "failed");
  await db.update(workflowRuns).set({ status: nextStatus, completedAt: next ? null : new Date(), updatedAt: new Date() }).where(writable(runScopeColumns, eq(workflowRuns.id, runId)));
  await renderWorkflowRunPage(runId);
  const updated = (await getWorkflowRun(runId))!;
  await notifyWorkflowProgress(updated.run.parentSessionId, runId, next ? `Workflow moved to stage ${next}. Status: ${nextStatus}.` : `Workflow ${nextStatus}: **${updated.run.title}**.`);

  // Auto-kick the next stage if advancing forward and no active attempt exists
  if (next && nextStatus === "active") {
    const nextStage = updated.stages.find((st) => st.key === next);
    const hasActiveAttempt = nextStage?.attempts.some((a) => a.status === "active");
    if (!hasActiveAttempt) {
      await startStageAttempt(runId, next, { spawnChildSession: true });
    }
  }

  return (await getWorkflowRun(runId))!;
}

type AttachWorkflowArtifactInput = {
  workflowRunId?: string;
  runId?: string;
  id?: string;
  stageAttemptId?: number | null;
  kind: string;
  title?: string;
  refType?: string;
  refId?: string;
  url?: string;
  summary?: string;
  metadata?: unknown;
  createdBySessionId?: string;
  render?: boolean;
};

async function resolveArtifactWorkflowRunId(input: AttachWorkflowArtifactInput): Promise<string> {
  const explicitRunId = String(input.workflowRunId || input.runId || input.id || "").trim();
  if (explicitRunId) {
    const detail = await getWorkflowRun(explicitRunId);
    if (!detail) throw new Error(`Workflow run not found or not visible: ${explicitRunId}`);
    return explicitRunId;
  }

  if (input.stageAttemptId !== undefined && input.stageAttemptId !== null) {
    const [attempt] = await db
      .select()
      .from(workflowStageAttempts)
      .where(visible(attemptScopeColumns, eq(workflowStageAttempts.id, input.stageAttemptId)))
      .limit(1);
    if (!attempt) throw new Error(`Workflow stage attempt not found or not visible: ${input.stageAttemptId}`);
    return attempt.workflowRunId;
  }

  throw new Error("attach_artifact requires workflowRunId, runId, id, or stageAttemptId.");
}

function defaultArtifactTitle(input: AttachWorkflowArtifactInput): string {
  const explicit = input.title?.trim();
  if (explicit) return explicit;
  if (input.kind === "spec" && input.refType === "library_page" && input.refId) return `Spec: ${input.refId}`;
  if (input.refId) return `${input.kind}: ${input.refId}`;
  if (input.url) return `${input.kind}: ${input.url}`;
  return input.kind || "Workflow artifact";
}

export async function attachWorkflowArtifact(input: AttachWorkflowArtifactInput): Promise<WorkflowArtifact> {
  const workflowRunId = await resolveArtifactWorkflowRunId(input);
  const [artifact] = await db.insert(workflowArtifacts).values({
    workflowRunId,
    stageAttemptId: input.stageAttemptId ?? null,
    kind: input.kind,
    title: defaultArtifactTitle(input),
    refType: input.refType || "text",
    refId: input.refId || null,
    url: input.url || null,
    summary: input.summary || "",
    metadata: input.metadata || {},
    createdBySessionId: input.createdBySessionId || null,
    ...owner(artifactScopeColumns),
  }).returning();
  if (input.render !== false) await renderWorkflowRunPage(workflowRunId);
  return artifact;
}


export async function capturePublishToStageEvidence(input: { workflowRunId: string; stageAttemptId?: number | null; createdBySessionId?: string; summary?: string }): Promise<WorkflowArtifact> {
  const detail = await getWorkflowRun(input.workflowRunId);
  if (!detail) throw new Error(`Workflow run not found: ${input.workflowRunId}`);
  const truth = detail.environmentTruth || await getWorkflowEnvironmentTruth(input.workflowRunId);
  if (!truth?.environment) throw new Error(`Workflow run ${input.workflowRunId} has no linked platform environment.`);
  const stage = detail.stages.find((item) => item.key === "acceptance") || detail.stages.find((item) => item.key === "publish_stage");
  const stageAttemptId = input.stageAttemptId ?? stage?.latestAttempt?.id ?? null;
  const latest = truth.deployment?.latest || null;
  const branch = typeof truth.source?.branch === "string" ? truth.source.branch : null;
  const title = latest?.id ? `Deployment evidence for ${truth.environment.name}: ${String(latest.id)}` : `Deployment evidence for ${truth.environment.name}`;
  const status = latest?.status ? String(latest.status) : truth.deployment?.available ? "no deployment found" : "unavailable";
  const deploymentProvider = truth.deployment?.provider || String(truth.hosting?.provider || "hosting");
  const summary = input.summary || `Stage environment ${truth.environment.name} sourced from ${branch || "unknown branch"}; ${deploymentProvider} deployment status ${status}.`;
  return attachWorkflowArtifact({
    workflowRunId: input.workflowRunId,
    stageAttemptId,
    kind: "deployment",
    title,
    refType: `${deploymentProvider}_deployment`,
    refId: latest?.id ? String(latest.id) : null,
    url: typeof truth.deployment?.publicUrl === "string" && truth.deployment.publicUrl ? (truth.deployment.publicUrl.startsWith("http") ? truth.deployment.publicUrl : `https://${truth.deployment.publicUrl}`) : undefined,
    summary,
    metadata: { environmentTruth: truth, sourceBranch: branch, deployment: truth.deployment },
    createdBySessionId: input.createdBySessionId,
  });
}


type DeploymentReadiness = {
  status: "green" | "pending" | "failed" | "unavailable" | "timeout";
  waitedMs: number;
  attempts: number;
  initialStatus: string | null;
  finalStatus: string | null;
  finalDeploymentId: string | null;
  expectedCommitSha: string | null;
  observedCommitSha: string | null;
  message: string;
};

function normalizedDeploymentStatus(deployment: WorkflowEnvironmentTruth["deployment"] | null | undefined): string {
  return deployment?.latest?.status ? String(deployment.latest.status).trim().toUpperCase() : "";
}

function deploymentStatusCategory(status: string): "green" | "pending" | "failed" | "unknown" {
  const s = status.trim().toUpperCase().split(":").at(-1) || "";
  if (!s) return "unknown";
  if (["SUCCESS", "SUCCEEDED", "COMPLETE", "COMPLETED", "DEPLOYED", "ACTIVE", "READY", "HEALTHY"].includes(s)) return "green";
  if (["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING", "PENDING", "REMOVING", "RESTARTING"].includes(s)) return "pending";
  if (["FAILED", "CRASHED", "REMOVED", "ERROR", "CANCELED", "CANCELLED", "SKIPPED"].includes(s)) return "failed";
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deploymentId(deployment: WorkflowEnvironmentTruth["deployment"] | null | undefined): string | null {
  const id = deployment?.latest?.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function deploymentReadinessMessage(readiness: DeploymentReadiness, provider: string): string {
  const status = readiness.finalStatus || "unknown";
  if (readiness.status === "green") return `${provider} deployment ${readiness.finalDeploymentId || "unknown"} reached ${status} after ${readiness.attempts} check(s).`;
  if (readiness.status === "timeout") return `Timed out after ${Math.round(readiness.waitedMs / 1000)}s waiting for ${provider} deployment${readiness.expectedCommitSha ? ` of ${readiness.expectedCommitSha.slice(0, 8)}` : ""}; final status ${status}${readiness.observedCommitSha ? ` on ${readiness.observedCommitSha.slice(0, 8)}` : ""}.`;
  if (readiness.status === "failed") return `Deployment ${readiness.finalDeploymentId || "unknown"} reached terminal failure status ${status}.`;
  if (readiness.status === "pending") return `Deployment ${readiness.finalDeploymentId || "unknown"} is still pending with status ${status}.`;
  return `Deployment status unavailable: ${status}.`;
}

function deploymentCommitSha(deployment: WorkflowEnvironmentTruth["deployment"] | null | undefined): string | null {
  const sha = deployment?.latest?.commitSha;
  return typeof sha === "string" && sha.trim() ? sha.trim().toLowerCase() : null;
}

function commitMatches(expected: string | null, observed: string | null): boolean {
  if (!expected) return true;
  if (!observed) return false;
  return expected.startsWith(observed) || observed.startsWith(expected);
}

function findCommitSha(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["mergeSha", "mergedCommitSha", "commitSha", "reviewedCommit"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && /^[a-f0-9]{7,40}$/i.test(candidate.trim())) return candidate.trim().toLowerCase();
  }
  for (const nested of Object.values(record)) {
    const found = findCommitSha(nested);
    if (found) return found;
  }
  return null;
}

function expectedAcceptanceDeployment(detail: WorkflowRunDetail): { commitSha: string | null; notBefore: Date | null } {
  const review = detail.stages.find((stage) => stage.key === "code_review")?.attempts
    .filter((attempt) => attempt.result === "passed" && attempt.completedAt)
    .sort((a, b) => (b.completedAt?.getTime() || 0) - (a.completedAt?.getTime() || 0))[0];
  const implement = detail.stages.find((stage) => stage.key === "implement")?.attempts
    .filter((attempt) => attempt.result === "passed" && attempt.completedAt)
    .sort((a, b) => (b.completedAt?.getTime() || 0) - (a.completedAt?.getTime() || 0))[0];
  return {
    commitSha: findCommitSha(review?.evidence) || findCommitSha(implement?.evidence),
    notBefore: review?.completedAt || implement?.completedAt || null,
  };
}

function deploymentIsCurrent(
  deployment: WorkflowEnvironmentTruth["deployment"] | null | undefined,
  expected: { commitSha: string | null; notBefore: Date | null },
): boolean {
  const observedCommit = deploymentCommitSha(deployment);
  if (expected.commitSha) return commitMatches(expected.commitSha, observedCommit);
  const deployedAt = deployment?.latest?.deployedAt;
  if (!expected.notBefore || typeof deployedAt !== "string") return false;
  const deployedAtMs = Date.parse(deployedAt);
  return Number.isFinite(deployedAtMs) && deployedAtMs >= expected.notBefore.getTime();
}

async function waitForAcceptanceDeploymentTruth(runId: string, initialTruth: WorkflowEnvironmentTruth | null): Promise<{ truth: WorkflowEnvironmentTruth | null; readiness: DeploymentReadiness }> {
  const detail = await getWorkflowRun(runId);
  if (!detail) throw new Error(`Workflow run not found: ${runId}`);
  const expected = expectedAcceptanceDeployment(detail);
  const activeAcceptanceAttempt = detail.stages.find((stage) => stage.key === "acceptance")?.attempts
    .find((attempt) => attempt.status === "active");
  const startedAt = activeAcceptanceAttempt?.startedAt?.getTime() || Date.now();
  let truth = initialTruth;
  let attempts = 0;
  const initialStatus = normalizedDeploymentStatus(truth?.deployment) || null;
  while (true) {
    attempts += 1;
    if (attempts > 1 || !truth) truth = await getWorkflowEnvironmentTruth(runId, expected.commitSha);
    const deployment = truth?.deployment || null;
    const status = normalizedDeploymentStatus(deployment);
    const category = deploymentStatusCategory(status);
    const waitedMs = Date.now() - startedAt;
    const base = {
      waitedMs,
      attempts,
      initialStatus,
      finalStatus: status || null,
      finalDeploymentId: deploymentId(deployment),
      expectedCommitSha: expected.commitSha,
      observedCommitSha: deploymentCommitSha(deployment),
    };

    if (!deployment?.available) {
      const readiness: DeploymentReadiness = { status: "unavailable", ...base, message: deployment?.reason || "Deployment status is unavailable." };
      return { truth, readiness };
    }
    if (category === "green" && deploymentIsCurrent(deployment, expected)) {
      const readiness: DeploymentReadiness = { status: "green", ...base, message: "" };
      readiness.message = deploymentReadinessMessage(readiness, deployment.provider);
      return { truth, readiness };
    }
    if (category === "failed" && deploymentIsCurrent(deployment, expected)) {
      const readiness: DeploymentReadiness = { status: "failed", ...base, message: "" };
      readiness.message = deploymentReadinessMessage(readiness, deployment.provider);
      return { truth, readiness };
    }
    if (category === "pending" || category === "green" || category === "failed" || !deployment.latest) {
      if (waitedMs >= ACCEPTANCE_DEPLOY_WAIT_TIMEOUT_MS) {
        const readiness: DeploymentReadiness = { status: "timeout", ...base, message: "" };
        readiness.message = deploymentReadinessMessage(readiness, deployment.provider);
        return { truth, readiness };
      }
      await sleep(Math.min(ACCEPTANCE_DEPLOY_POLL_INTERVAL_MS, ACCEPTANCE_DEPLOY_WAIT_TIMEOUT_MS - waitedMs));
      continue;
    }

    const readiness: DeploymentReadiness = { status: "pending", ...base, message: `Unknown ${deployment.provider} deployment status ${status}; leaving acceptance gate non-green.` };
    return { truth, readiness };
  }
}

function deploymentLooksGreen(deployment: WorkflowEnvironmentTruth["deployment"] | null | undefined): boolean {
  return Boolean(deployment?.available && deployment.latest && deploymentStatusCategory(normalizedDeploymentStatus(deployment)) === "green");
}

function publicUrlFromTruth(truth: WorkflowEnvironmentTruth | null | undefined): string | null {
  const raw = truth?.deployment?.publicUrl;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function joinUrl(base: string, routePath: string): string {
  const url = new URL(base);
  url.pathname = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return url.toString();
}

function safeRoutePath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) return fallback;
  return trimmed;
}

function lifecycleSnapshotConfig(snapshot: unknown): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object") return {};
  const config = (snapshot as Record<string, unknown>).config;
  return config && typeof config === "object" ? config as Record<string, unknown> : {};
}

function lifecycleAcceptanceTarget(snapshot: unknown): Record<string, unknown> {
  const config = lifecycleSnapshotConfig(snapshot);
  const acceptance = config.acceptance && typeof config.acceptance === "object" ? config.acceptance as Record<string, unknown> : {};
  const acceptanceTarget = acceptance.target && typeof acceptance.target === "object" ? acceptance.target as Record<string, unknown> : null;
  const target = acceptanceTarget || config.acceptanceTarget;
  return target && typeof target === "object" ? target as Record<string, unknown> : {};
}

function lifecycleAcceptanceConfig(snapshot: unknown): Record<string, unknown> {
  const config = lifecycleSnapshotConfig(snapshot);
  const acceptance = config.acceptance && typeof config.acceptance === "object" ? config.acceptance as Record<string, unknown> : {};
  return {
    configured: acceptance.configured === true,
    target: lifecycleAcceptanceTarget(snapshot),
    authMode: typeof acceptance.authMode === "string" ? acceptance.authMode : configuredAuthMode(snapshot),
    evidenceConfig: acceptance.evidenceConfig && typeof acceptance.evidenceConfig === "object" ? acceptance.evidenceConfig as Record<string, unknown> : {},
    missing: Array.isArray(acceptance.missing) ? acceptance.missing : [],
  };
}

function configuredTargetUrl(target: Record<string, unknown>, truth: WorkflowEnvironmentTruth | null | undefined): string | null {
  const raw = typeof target.url === "string" && target.url.trim() ? target.url.trim() : publicUrlFromTruth(truth);
  if (!raw) return null;
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function configuredAuthMode(snapshot: unknown): string {
  const mode = lifecycleSnapshotConfig(snapshot).authMode;
  return typeof mode === "string" && mode.trim() ? mode.trim() : "none";
}



async function checkUrlHealthy(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    if (response.ok) return { ok: true, status: response.status };
    const fallback = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10000) });
    return { ok: fallback.ok, status: fallback.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function summarizeLogs(source: "client" | "server", sinceTs: number) {
  return getRecentLogs({ source, level: "error", limit: 100 })
    .filter((entry) => entry.ts >= sinceTs)
    .slice(-25)
    .map((entry) => ({ ts: entry.ts, level: entry.level, source: entry.source, message: truncateText(entry.message, 500) }));
}

function buildAcceptanceFailurePacket(packet: AcceptanceEvidencePacket, health: { ok: boolean; status?: number; error?: string }, browserError: string | null): Record<string, unknown> | undefined {
  const failedGates = ACCEPTANCE_GATE_KEYS.filter((key) => !packet.gates[key]);
  if (failedGates.length === 0) return undefined;
  return {
    failedGates,
    targetUrl: packet.targetUrl,
    routePath: packet.routePath,
    health,
    browserSession: packet.browserSession,
    browserError,
    auth: packet.auth,
    acceptanceConfig: packet.configSnapshot,
    healthCheckPath: packet.healthCheckPath,
    deployment: packet.deployment,
    deploymentReadiness: packet.deploymentReadiness || null,
    screenshot: packet.screenshot || null,
    clientLogErrors: packet.logs.client,
    serverLogErrors: packet.logs.server,
    nextSuggestedFix: "Return to Implement with this packet. Fix the first failed required gate, then rerun publish/acceptance evidence instead of bypassing the gate.",
  };
}

export async function captureAcceptanceEvidence(input: { workflowRunId: string; stageAttemptId?: number | null; routePath?: string; createdBySessionId?: string; summary?: string; optionalSmokeAttempted?: boolean }): Promise<WorkflowArtifact> {
  const captureStartedAt = Date.now();
  const detail = await getWorkflowRun(input.workflowRunId);
  if (!detail) throw new Error(`Workflow run not found: ${input.workflowRunId}`);
  const initialTruth = detail.environmentTruth || await getWorkflowEnvironmentTruth(input.workflowRunId);
  let truth: WorkflowEnvironmentTruth | null;
  let deploymentReadiness: DeploymentReadiness;
  if (input.createdBySessionId) {
    await chatFileStorage.updateSessionStatus(input.createdBySessionId, "waiting");
  }
  try {
    ({ truth, readiness: deploymentReadiness } = await waitForAcceptanceDeploymentTruth(input.workflowRunId, initialTruth));
  } finally {
    if (input.createdBySessionId) {
      await chatFileStorage.updateSessionStatus(input.createdBySessionId, "streaming");
    }
  }
  const stage = detail.stages.find((item) => item.key === "acceptance");
  const stageAttemptId = input.stageAttemptId ?? stage?.latestAttempt?.id ?? null;
  const lifecycleSnapshot = detail.lifecycleSnapshot || detail.run.lifecycleSnapshot;
  const acceptanceConfig = lifecycleAcceptanceConfig(lifecycleSnapshot);
  const acceptanceTarget = lifecycleAcceptanceTarget(lifecycleSnapshot);
  const targetUrl = configuredTargetUrl(acceptanceTarget, truth);
  const routePath = safeRoutePath(input.routePath || acceptanceTarget.routePath || acceptanceTarget.screenshotRoutePath, "/workflows");
  const healthCheckPath = safeRoutePath(acceptanceTarget.healthCheckPath, "/");
  const screenshotRoutePath = safeRoutePath(acceptanceTarget.screenshotRoutePath || routePath, routePath);
  const targetRouteUrl = targetUrl ? joinUrl(targetUrl, screenshotRoutePath) : null;
  const healthUrl = targetUrl ? joinUrl(targetUrl, healthCheckPath) : null;
  const authMode = typeof acceptanceConfig.authMode === "string" && acceptanceConfig.authMode.trim() ? acceptanceConfig.authMode.trim() : configuredAuthMode(lifecycleSnapshot);
  const auth = { mode: authMode, attempted: authMode !== "none", established: authMode === "none", verified: authMode === "none", status: null as number | null, userId: null as string | null, error: null as string | null };
  const health = healthUrl ? await checkUrlHealthy(healthUrl) : { ok: false, error: "No public URL available from lifecycle acceptance target or linked environment truth" };
  let screenshot: AcceptanceEvidencePacket["screenshot"] = null;
  let browserError: string | null = null;

  let browserSession: AcceptanceEvidencePacket["browserSession"] = null;
  if (targetUrl && targetRouteUrl) {
    try {
      const { captureBrowserSessionEvidence, screenshotPage } = await import("../browser-manager");
      if (auth.attempted) {
        const directUrl = joinUrl(targetUrl, screenshotRoutePath);
        const sessionEvidence = await captureBrowserSessionEvidence(directUrl, { expectedRoutePath: screenshotRoutePath, viewport: "desktop", fullPage: true, delay: 1500, authenticate: true });
        browserSession = sessionEvidence as unknown as Record<string, unknown>;
        screenshot = sessionEvidence.screenshot;
        browserError = sessionEvidence.error;
        auth.established = sessionEvidence.authVerified && !sessionEvidence.loginScreenDetected && !sessionEvidence.error;
        auth.verified = sessionEvidence.authVerified;
        auth.status = sessionEvidence.authStatus;
        auth.userId = sessionEvidence.authUserId;
        auth.error = auth.established ? null : sessionEvidence.error || `Auth verification failed with status ${sessionEvidence.authStatus ?? "unknown"}`;
      } else {
        screenshot = await screenshotPage(targetRouteUrl, { viewport: "desktop", fullPage: true, delay: 1500 });
        auth.established = true;
        auth.verified = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      browserError = message;
      if (auth.attempted && !auth.established) auth.error = message;
    }
  }

  const clientLogs = summarizeLogs("client", captureStartedAt);
  const serverLogs = summarizeLogs("server", captureStartedAt);
  const gates: AcceptanceEvidencePacket["gates"] = {
    stageDeployGreen: deploymentLooksGreen(truth?.deployment),
    targetUrlHealthy: health.ok,
    targetRouteBrowserLoaded: Boolean(screenshot && !browserError),
    screenshotCaptured: Boolean(screenshot?.path),
    clientLogsChecked: true,
    serverLogsChecked: true,
    authSessionEstablished: auth.established && auth.verified,
  };
  const packet: AcceptanceEvidencePacket = {
    capturedAt: new Date().toISOString(),
    configSnapshot: acceptanceConfig,
    targetUrl,
    routePath: screenshotRoutePath,
    healthCheckPath,
    gates,
    auth,
    health,
    browserSession,
    browserError,
    optionalSmokeAttempted: Boolean(input.optionalSmokeAttempted),
    deployment: truth?.deployment || null,
    deploymentReadiness,
    screenshot,
    logs: { client: clientLogs, server: serverLogs },
  };
  const failurePacket = buildAcceptanceFailurePacket(packet, health, browserError);
  if (failurePacket) packet.failurePacket = failurePacket;
  const passed = !failurePacket;
  return attachWorkflowArtifact({
    workflowRunId: input.workflowRunId,
    stageAttemptId,
    kind: "acceptance",
    title: `Acceptance evidence: ${passed ? "passed" : "failed"}`,
    refType: "workflow_acceptance",
    refId: input.workflowRunId,
    url: targetRouteUrl || targetUrl || undefined,
    summary: input.summary || `Acceptance gates ${passed ? "passed" : "failed"}: ${ACCEPTANCE_GATE_KEYS.map((key) => `${key}=${gates[key] ? "yes" : "no"}`).join(", ")}. Deployment readiness: ${deploymentReadiness.message}`,
    metadata: packet,
    createdBySessionId: input.createdBySessionId,
  });
}


export async function captureCalibrationEvidence(input: { workflowRunId: string; stageAttemptId?: number | null; createdBySessionId?: string; summary?: string; decision?: string; documentationUpdated?: boolean; specDelta?: string; failureContext?: unknown }): Promise<WorkflowArtifact> {
  const detail = await getWorkflowRun(input.workflowRunId);
  if (!detail) throw new Error(`Workflow run not found: ${input.workflowRunId}`);
  const stage = detail.stages.find((item) => item.key === "calibration");
  const stageAttemptId = input.stageAttemptId ?? stage?.latestAttempt?.id ?? null;
  const acceptance = detail.artifacts.filter((artifact) => artifact.kind === "acceptance").at(-1) || null;
  const metadata = {
    calibratedAt: new Date().toISOString(),
    decision: input.decision || "continue",
    documentationUpdated: Boolean(input.documentationUpdated),
    specDelta: input.specDelta || "No spec delta recorded.",
    acceptanceArtifactId: acceptance?.id || null,
    acceptanceSummary: acceptance?.summary || null,
    hardStopConditions: ["hard_user_gate", "danger_or_security", "privacy_risk", "principle_conflict", "production_release", "exhausted_retries"],
    failureContext: input.failureContext || null,
  };
  return attachWorkflowArtifact({
    workflowRunId: input.workflowRunId,
    stageAttemptId,
    kind: "calibration",
    title: "Calibration decision",
    refType: "workflow_calibration",
    refId: input.workflowRunId,
    summary: input.summary || `Calibration decision: ${metadata.decision}; documentationUpdated=${metadata.documentationUpdated}.`,
    metadata,
    createdBySessionId: input.createdBySessionId,
  });
}

export async function openWorkflowGate(input: { workflowRunId: string; stageAttemptId?: number; gateType: string; prompt: string }): Promise<WorkflowGate> {
  const [gate] = await db.insert(workflowGates).values({ workflowRunId: input.workflowRunId, stageAttemptId: input.stageAttemptId ?? null, gateType: input.gateType, prompt: input.prompt, status: "open", ...owner(gateScopeColumns) }).returning();
  await updateWorkflowRun(input.workflowRunId, { status: "needs_review" });
  return gate;
}

export async function approveWorkflowGate(gateId: number, decisionReason = "approved"): Promise<WorkflowRunDetail> {
  const principal = getCurrentPrincipal();
  // Idempotency guard: fetch gate first to check if already resolved
  const [existing] = await db.select().from(workflowGates).where(eq(workflowGates.id, gateId)).limit(1);
  if (!existing) throw new Error(`Gate not found: ${gateId}`);
  if (existing.status !== "open") {
    log.warn(`approveWorkflowGate: gate ${gateId} already resolved (status=${existing.status}). No-op.`);
    return (await getWorkflowRun(existing.workflowRunId))!;
  }
  const [gate] = await db.update(workflowGates).set({ status: workflowGateStatusSchema.parse("approved"), decision: "approved", decisionReason, resolvedAt: new Date(), resolvedByUserId: principal?.userId || null }).where(writable(gateScopeColumns, eq(workflowGates.id, gateId))).returning();
  if (!gate) throw new Error(`Gate not found: ${gateId}`);
  await recordTransition({ workflowRunId: gate.workflowRunId, trigger: "user_review", reason: decisionReason });
  return updateWorkflowRun(gate.workflowRunId, { status: "active" });
}

export async function rejectWorkflowGate(gateId: number, decisionReason = "rejected"): Promise<WorkflowRunDetail> {
  const principal = getCurrentPrincipal();
  // Idempotency guard: fetch gate first to check if already resolved
  const [existing] = await db.select().from(workflowGates).where(eq(workflowGates.id, gateId)).limit(1);
  if (!existing) throw new Error(`Gate not found: ${gateId}`);
  if (existing.status !== "open") {
    log.warn(`rejectWorkflowGate: gate ${gateId} already resolved (status=${existing.status}). No-op.`);
    return (await getWorkflowRun(existing.workflowRunId))!;
  }
  const [gate] = await db.update(workflowGates).set({ status: workflowGateStatusSchema.parse("rejected"), decision: "rejected", decisionReason, resolvedAt: new Date(), resolvedByUserId: principal?.userId || null }).where(writable(gateScopeColumns, eq(workflowGates.id, gateId))).returning();
  if (!gate) throw new Error(`Gate not found: ${gateId}`);
  await recordTransition({ workflowRunId: gate.workflowRunId, trigger: "user_review", reason: decisionReason });
  return updateWorkflowRun(gate.workflowRunId, { status: "blocked" });
}

export async function linkWorkflowSession(input: { workflowRunId: string; stageAttemptId?: number | null; sessionId: string; role: string; spawnReason?: string }): Promise<void> {
  await db.insert(workflowSessions).values({ workflowRunId: input.workflowRunId, stageAttemptId: input.stageAttemptId ?? null, sessionId: input.sessionId, role: input.role, spawnReason: input.spawnReason || null, ...owner(sessionScopeColumns) }).onConflictDoNothing();
}

export async function renderWorkflowRunPage(runId: string): Promise<void> {
  try {
    const detail = await getWorkflowRun(runId);
    if (!detail?.run.linkedLibraryPageId) return;
    const { libraryPages } = await import("@shared/models/info");
    const { syncContentFields } = await import("@shared/markdown-tiptap");
    const content = buildWorkflowRunPageContent(detail);
    const synced = syncContentFields({ markdown: content });
    await db.update(libraryPages).set({ content: synced.content, plainTextContent: synced.plainTextContent, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(libraryPages.id, detail.run.linkedLibraryPageId));
  } catch (err) {
    log.warn(`Failed to render workflow ${runId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
