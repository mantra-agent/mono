import crypto from "crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, runWithDatabaseTransaction } from "../db";
import { getCurrentPrincipal, requireCurrentPrincipal, runWithPrincipal } from "../principal-context";
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
  accounts,
  users,
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
  environmentHostingBindings,
  environmentSourceBindings,
  platformProductEnvironments,
  products,
  platforms,
  providerConnections,
  type EnvironmentHostingBinding,
  type EnvironmentSourceBinding,
  type ProviderConnection,
} from "@shared/models/platforms";
import { libraryPages } from "@shared/models/info";
import { isParseableReferenceType, serializeReference } from "@shared/references";
import { getProviderCredential } from "../provider-credential-store";
import { resolvePlatformBindingSessionSecret } from "../platforms/platform-binding-browser-auth";
import { extractDeploymentMeta, fetchDeploymentsForEnvironment, getLatestDeploymentByToken, type LatestDeployment } from "../integrations/railway/client";
import { compareRefs } from "../integrations/github-pr";
import { getCloudflareLatestDeployment } from "../services/provider-connection-service";
import { buildWorkflowRunPageContent, buildWorkflowStages, parseWorkflowDefinition, type WorkflowEnvironmentTruth, type WorkflowRunDetail } from "./workflow-renderer";
import { abortAndConfirmChildTermination, monitorChildSession, truncateOutput } from "../child-session-monitor";
import { chatFileStorage } from "../chat-file-storage";
import { getArtifactsBySession } from "../session-artifacts";
import { canonicalExecutionArtifactAddress } from "../execution-provenance-address";
import { linkWorkflowArtifactProduced } from "../execution-provenance-links";
import { requireModWorkflowAccess } from "../mods/mod-access";
import {
  createNamedSystemPrincipal,
  createUserPrincipalFromUser,
  tryResolveUserIdentityFoundation,
} from "../principal";

const log = createLogger("WorkflowService");

/** Default idle timeout for workflow stage children: 15 minutes */
const WORKFLOW_STAGE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ACCEPTANCE_DEPLOY_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
const ACCEPTANCE_DEPLOY_POLL_INTERVAL_MS = 15 * 1000;
export const WORKFLOW_ATTEMPT_LEASE_MS = 2 * 60 * 1000;
const WORKFLOW_RECOVERY_JOB = "workflow-recovery";

type ActiveWorkflowMonitor = {
  abortController: AbortController;
  leaseId: string;
};

const activeWorkflowMonitors = new Map<number, ActiveWorkflowMonitor>();

function workflowRuntimeInstanceId(): string {
  return process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || "local";
}

function workflowRuntimeBootId(): string {
  return process.env.WATCHDOG_BOOT_ID || `pid:${process.pid}`;
}

function workflowMonitorOwner(runId: string): string {
  return `${workflowRuntimeInstanceId()}@${workflowRuntimeBootId()}:${runId}`;
}

function ownedByCurrentWorkflowRuntime(ownerValue: string | null): boolean {
  return Boolean(ownerValue?.startsWith(`${workflowRuntimeInstanceId()}@${workflowRuntimeBootId()}:`));
}

function ownedByPriorWorkflowBoot(ownerValue: string | null): boolean {
  return Boolean(ownerValue?.startsWith(`${workflowRuntimeInstanceId()}@`) && !ownedByCurrentWorkflowRuntime(ownerValue));
}

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

function visible<T>(columns: T, predicate?: SQL): SQL { return combineWithVisibleScope(requireCurrentPrincipal(), columns as any, predicate); }
function writable<T>(columns: T, predicate?: SQL): SQL { return combineWithWritableScope(requireCurrentPrincipal(), columns as any, predicate); }
function owner<T>(columns: T) { return ownedInsertValues(requireCurrentPrincipal(), columns as any); }

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

type WorkflowRevisionContext = {
  sourceStageKey: string;
  sourceStageTitle: string;
  sourceAttemptId: number;
  verdict: string;
  transitionReason: string;
  outputSummary: string | null;
  evidence: unknown;
  artifacts: WorkflowArtifactBrief[];
  instruction: string;
};

type WorkflowStageInputContext = {
  workflowRunId: string;
  workflowTitle: string;
  objective: string;
  stageKey: string;
  stageTitle: string;
  attemptNumber: number;
  executionAttemptNumber: number;
  retryCount: number;
  maxAttempts: number;
  previousFailurePacket?: unknown;
  retryContext?: WorkflowRetryContext;
  revisionContext?: WorkflowRevisionContext;
  relevantArtifacts: WorkflowArtifactBrief[];
  originatingRequest?: string;
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
    .filter((attempt) => attempt.status === "failed" || attempt.result === "failed")
    .sort((a, b) => {
      const completedDelta = (b.completedAt?.getTime() || b.updatedAt?.getTime() || 0) - (a.completedAt?.getTime() || a.updatedAt?.getTime() || 0);
      return completedDelta || b.id - a.id;
    });
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

function stageDefinitionFor(detail: WorkflowRunDetail, stageKey: string): WorkflowStageDefinition | undefined {
  return parseWorkflowDefinition(detail.template).stages.find((stage) => stage.key === stageKey);
}

function stageArtifacts(detail: WorkflowRunDetail, stageKey: string): WorkflowArtifactBrief[] {
  const sourceStageKeys = stageDefinitionFor(detail, stageKey)?.inputSources ?? [stageKey];
  const attemptIds = new Set(
    detail.stages
      .filter((stage) => sourceStageKeys.includes(stage.key))
      .flatMap((stage) => stage.attempts.map((attempt) => attempt.id)),
  );
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

function originatingRequest(detail: WorkflowRunDetail): string | undefined {
  const artifact = detail.artifacts.find((candidate) => candidate.kind === "originating_request");
  const metadata = artifact?.metadata && typeof artifact.metadata === "object"
    ? artifact.metadata as Record<string, unknown>
    : {};
  const content = typeof metadata.content === "string" ? metadata.content.trim() : "";
  return content || undefined;
}

// The stage verdict has exactly one source of truth: the structured
// complete_stage_attempt row (enum-validated, atomically claimed, drives the
// transition). There is deliberately no prose fallback. A child that ends
// without recording a verdict has not decided anything the engine may act on;
// the monitor fails that attempt for retry rather than guessing from markdown.

async function projectSessionArtifactsToWorkflow(
  workflowRunId: string,
  attempt: WorkflowStageAttempt,
  createdBySessionId?: string,
): Promise<void> {
  const childSessionId = attempt.childSessionId || createdBySessionId;
  if (!childSessionId) return;
  const sessionArtifacts = await getArtifactsBySession(childSessionId);
  for (const sessionArtifact of sessionArtifacts) {
    const refType = sessionArtifact.artifactType;
    const refId = sessionArtifact.artifactId;
    const kind = attempt.stageKey === "scope" && refType === "library_page"
      ? "spec"
      : attempt.stageKey === "documentation" && refType === "library_page"
        ? "docs"
        : refType;
    const metadata = sessionArtifact.metadata && typeof sessionArtifact.metadata === "object"
      ? sessionArtifact.metadata as Record<string, unknown>
      : {};
    const principal = getCurrentPrincipal();
    if (!principal) throw new Error("Workflow artifact projection requires a user principal");
    const artifactMetadata = { ...metadata, sourceSessionArtifactId: sessionArtifact.id };
    const artifactAddress = sessionArtifact.artifactAddress
      || await canonicalExecutionArtifactAddress(principal, refType, refId, artifactMetadata);
    const created = await db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.WORKFLOW_ARTIFACTS, `${workflowRunId}:${attempt.id}`);
      const [existing] = await tx.select({ id: workflowArtifacts.id }).from(workflowArtifacts).where(visible(artifactScopeColumns, and(
        eq(workflowArtifacts.workflowRunId, workflowRunId),
        eq(workflowArtifacts.stageAttemptId, attempt.id),
        eq(workflowArtifacts.refType, refType),
        eq(workflowArtifacts.refId, refId),
      ))).limit(1);
      if (existing) return null;
      const [inserted] = await tx.insert(workflowArtifacts).values({
        workflowRunId,
        stageAttemptId: attempt.id,
        kind,
        title: typeof metadata.title === "string" && metadata.title.trim()
          ? metadata.title
          : `${kind}: ${refId}`,
        refType,
        refId,
        artifactAddress,
        url: null,
        summary: typeof metadata.summary === "string" ? metadata.summary : "",
        metadata: artifactMetadata,
        createdBySessionId: childSessionId,
        ...owner(artifactScopeColumns),
      }).returning();
      return inserted || null;
    });
    if (created && artifactAddress) await linkWorkflowArtifactProduced(principal, created);
  }
}

async function reconcilePriorStageSessionArtifacts(detail: WorkflowRunDetail, stageKey: string): Promise<WorkflowRunDetail> {
  const sourceStageKeys = stageDefinitionFor(detail, stageKey)?.inputSources ?? [];
  if (sourceStageKeys.length === 0) return detail;
  for (const stage of detail.stages.filter((candidate) => sourceStageKeys.includes(candidate.key))) {
    for (const attempt of stage.attempts.filter((candidate) => candidate.completedAt && candidate.childSessionId)) {
      await projectSessionArtifactsToWorkflow(detail.run.id, attempt);
    }
  }
  return (await getWorkflowRun(detail.run.id)) || detail;
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
    instruction: "Address this execution failure directly. Do not redo unrelated discovery or repeat the failed approach unless the changed premise is explicit.",
  };
}

function latestInboundStageTransition(detail: WorkflowRunDetail, stageKey: string) {
  return [...detail.transitions]
    .filter((transition) => transition.toStageKey === stageKey && transition.fromStageKey !== stageKey)
    .sort((a, b) => b.id - a.id)[0];
}

function attemptsInCurrentStageVisit(detail: WorkflowRunDetail, stageKey: string): WorkflowStageAttempt[] {
  const stageAttempts = detail.stages.find((stage) => stage.key === stageKey)?.attempts || [];
  const inbound = latestInboundStageTransition(detail, stageKey);
  if (!inbound?.fromAttemptId) return stageAttempts;
  return stageAttempts.filter((attempt) => attempt.id > inbound.fromAttemptId!);
}

function buildRevisionContext(detail: WorkflowRunDetail, stageKey: string): WorkflowRevisionContext | undefined {
  const inbound = latestInboundStageTransition(detail, stageKey);
  if (!inbound?.fromAttemptId || !inbound.fromStageKey) return undefined;
  const sourceAttempt = detail.stages
    .flatMap((stage) => stage.attempts)
    .find((attempt) => attempt.id === inbound.fromAttemptId);
  const verdict = String(sourceAttempt?.result || "");
  if (!sourceAttempt || !verdict || verdict === "passed") return undefined;
  return {
    sourceStageKey: sourceAttempt.stageKey,
    sourceStageTitle: sourceAttempt.stageTitle,
    sourceAttemptId: sourceAttempt.id,
    verdict,
    transitionReason: inbound.reason || "",
    outputSummary: sourceAttempt.outputSummary,
    evidence: sourceAttempt.evidence,
    artifacts: attemptArtifacts(detail, sourceAttempt.id),
    instruction: "Apply the requested domain revision directly. This is not an execution failure and does not consume the execution retry budget.",
  };
}

async function resolveGoverningArtifacts(environmentId: number | null, kinds: string[] | undefined): Promise<Array<{ kind: string; libraryPageId: string; title: string }>> {
  if (!environmentId) return [];
  const relevantKinds = kinds ?? [];
  if (relevantKinds.length === 0) return [];
  const { listVisibleProductContextPages } = await import("../platforms/context-artifact-access");
  const rows = await listVisibleProductContextPages(relevantKinds, environmentId);
  return rows.map((row) => ({
    kind: row.kind,
    libraryPageId: row.libraryPageId,
    title: row.title,
  }));
}


async function buildStageInputContext(detail: WorkflowRunDetail, stageKey: string, stageDef: WorkflowStageDefinition, attemptNumber: number, extraContext?: unknown): Promise<WorkflowStageInputContext & { extraContext?: unknown; environmentTruth?: WorkflowEnvironmentTruth | null; lifecycleSnapshot?: unknown }> {
  const visitAttempts = attemptsInCurrentStageVisit(detail, stageKey);
  const executionFailures = failedAttempts(visitAttempts);
  const retryCount = executionFailures.length;
  const executionAttemptNumber = retryCount + 1;
  const previousFailurePacket = buildPreviousFailurePacket(visitAttempts);
  const retryContext = retryCount > 0 ? buildRetryContext(detail, stageKey, stageDef.title, visitAttempts) : undefined;
  const revisionContext = buildRevisionContext(detail, stageKey);
  const governingArtifacts = await resolveGoverningArtifacts(detail.run.linkedEnvironmentId, stageDef.governingArtifactKinds);
  return {
    workflowRunId: detail.run.id,
    workflowTitle: detail.run.title,
    objective: detail.run.objective,
    stageKey,
    stageTitle: stageDef.title,
    attemptNumber,
    executionAttemptNumber,
    retryCount,
    maxAttempts: getMaxAttempts(detail),
    previousFailurePacket,
    retryContext,
    revisionContext,
    relevantArtifacts: stageArtifacts(detail, stageKey),
    originatingRequest: originatingRequest(detail),
    entryCriteria: stageDef.entryCriteria,
    exitCriteria: stageDef.exitCriteria,
    evidenceRequirements: stageDef.evidenceRequirements,
    allowedTransitions: stageDef.allowedTransitions,
    governingArtifacts,
    purpose: stageDef.purpose || `Complete the ${stageDef.title} stage.`,
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
    context.stageKey === "design_review"
      ? `Apply the review boundary literally. A rejection without an exact specification citation and an exact provision from a named governing standard is invalid.`
      : `Work adversarially against this purpose. Do not let completed prior work, a passing build, or lifecycle progress substitute for the judgment this stage exists to make.`,
    "",
    `## Originating Request`,
    context.originatingRequest || "No separate originating request was captured; use the objective below without expanding it.",
    "The request is the scope authority. The workflow objective may clarify the desired outcome, but it cannot prescribe or widen the solution beyond what the request and repository evidence require.",
    "",
    `## Workflow Objective`,
    context.objective || "No objective recorded.",
  ];

  if (context.governingArtifacts?.length) {
    lines.push("", "## Governing Context");
    lines.push("Load a governing artifact when the originating request or repository evidence implicates the domain it governs. Apply loaded rules directly, but do not broaden the design merely because a linked artifact exists.");
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

  if (context.revisionContext) {
    lines.push("", "## Revision Assignment");
    lines.push("Apply the prior stage's requested revision directly. This is a declared domain transition, not an execution failure.");
    lines.push("```json", JSON.stringify(context.revisionContext, null, 2), "```");
  }

  if (context.retryCount > 0) {
    const retryAssignment = context.retryContext || context.previousFailurePacket;
    if (!retryAssignment) {
      throw new Error(`Workflow ${context.workflowRunId} cannot start ${context.stageTitle} execution retry ${context.executionAttemptNumber} without failure evidence.`);
    }
    lines.push("", "## Execution Retry Assignment");
    lines.push("Address the prior execution failure directly with a materially different approach. Do not repeat unrelated discovery.");
    lines.push("```json", JSON.stringify(retryAssignment, null, 2), "```");
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

  const stageAttemptIdForCompletion = "stageAttemptId" in context && Number.isSafeInteger((context as WorkflowStageInputContext & { stageAttemptId?: number }).stageAttemptId)
    ? (context as WorkflowStageInputContext & { stageAttemptId: number }).stageAttemptId
    : null;
  lines.push(
    "",
    "## Completion",
    `Workflow run: ${context.workflowRunId}.${stageAttemptIdForCompletion !== null ? ` Stage attempt: ${stageAttemptIdForCompletion}.` : ""} Execution attempt ${context.executionAttemptNumber}/${context.maxAttempts}.`,
    "Execute only this assigned stage. Do not create or start another workflow; this workflow owns downstream orchestration.",
    `Your terminal action MUST be a single \`complete_stage_attempt\` call that records this attempt's verdict as structured data: pass the workflow run ID, the stage attempt ID above, and \`result\` set to one of this stage's declared Outcomes${context.allowedTransitions?.length ? ` (${context.allowedTransitions.map((transition) => transition.on).join(", ")})` : ""}. Use \`failed\` only for execution faults such as a tool failure, crash, timeout, missing/malformed verdict, or lost session/lease; use \`blocked\`, \`needs_review\`, or \`skipped\` only when the domain is intentionally held. Include the evidence produced and, for faults or holds, the reason and next required action.`,
    "Do not report the verdict only as prose. A stage attempt that ends without a `complete_stage_attempt` call records no verdict, is treated as a failed attempt, and holds the workflow on this stage for explicit recovery.",
  );
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
  return session.id;
}

async function claimWorkflowAttemptMonitor(
  attemptId: number,
  ownerValue: string,
  leaseMs = WORKFLOW_ATTEMPT_LEASE_MS,
  staleOwner?: string | null,
): Promise<{ claimed: true; leaseId: string } | { claimed: false }> {
  const leaseId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const rows = await db.update(workflowStageAttempts).set({
    executionLeaseId: leaseId,
    executionLeaseOwner: ownerValue,
    executionLeaseExpiresAt: expiresAt,
    executionClaimedAt: now,
    updatedAt: now,
  }).where(writable(attemptScopeColumns, and(
    eq(workflowStageAttempts.id, attemptId),
    eq(workflowStageAttempts.status, "active"),
    isNull(workflowStageAttempts.completedAt),
    or(
      isNull(workflowStageAttempts.executionLeaseExpiresAt),
      lt(workflowStageAttempts.executionLeaseExpiresAt, now),
      staleOwner ? eq(workflowStageAttempts.executionLeaseOwner, staleOwner) : undefined,
    ),
  ))).returning({ id: workflowStageAttempts.id });
  return rows.length ? { claimed: true, leaseId } : { claimed: false };
}

async function renewWorkflowAttemptMonitor(attemptId: number, leaseId: string): Promise<boolean> {
  const rows = await db.update(workflowStageAttempts).set({
    executionLeaseExpiresAt: new Date(Date.now() + WORKFLOW_ATTEMPT_LEASE_MS),
    updatedAt: new Date(),
  }).where(writable(attemptScopeColumns, and(
    eq(workflowStageAttempts.id, attemptId),
    eq(workflowStageAttempts.status, "active"),
    eq(workflowStageAttempts.executionLeaseId, leaseId),
  ))).returning({ id: workflowStageAttempts.id });
  return rows.length > 0;
}

async function releaseWorkflowAttemptMonitor(attemptId: number, leaseId: string): Promise<void> {
  await db.update(workflowStageAttempts).set({
    executionLeaseId: null,
    executionLeaseOwner: null,
    executionLeaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(writable(attemptScopeColumns, and(
    eq(workflowStageAttempts.id, attemptId),
    eq(workflowStageAttempts.executionLeaseId, leaseId),
  )));
}

function acceptanceStageContext(detail: WorkflowRunDetail): Record<string, unknown> | undefined {
  const stageKey = detail.run.currentStageKey;
  if (!stageKey) return undefined;
  const contract = stageDefinitionFor(detail, stageKey)?.acceptanceContract;
  if (!contract) return undefined;
  const truth = detail.environmentTruth || null;
  const publicUrl = typeof truth?.deployment?.publicUrl === "string" && truth.deployment.publicUrl
    ? (truth.deployment.publicUrl.startsWith("http") ? truth.deployment.publicUrl : `https://${truth.deployment.publicUrl}`)
    : null;
  return {
    v1AcceptanceEvidenceContract: {
      ...contract,
      requiredGates: ACCEPTANCE_GATE_KEYS,
      targetUrl: publicUrl,
      deploymentStatus: truth?.deployment?.latest ? String(truth.deployment.latest.status || "unknown") : null,
    },
  };
}

function calibrationStageContext(detail: WorkflowRunDetail): Record<string, unknown> | undefined {
  const stageKey = detail.run.currentStageKey;
  if (!stageKey) return undefined;
  const contract = stageDefinitionFor(detail, stageKey)?.calibrationContract;
  if (!contract) return undefined;
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
        directive: "MANDATORY: The same acceptance gates have failed identically ≥2 consecutive times. Complete with result 'blocked' and preserve the repeated failure diagnosis for user inspection. Do not route backward or continue automatically.",
      };
    }
  }

  return {
    calibrationContract: {
      ...contract,
      inspectArtifacts: acceptanceArtifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, title: artifact.title, summary: artifact.summary, metadata: artifact.metadata })),
      ...(repeatedFailureEscalation ? { repeatedFailureEscalation } : {}),
    },
  };
}

async function spawnWorkflowStageChild(parentSessionId: string, detail: WorkflowRunDetail, stageKey: string, stageTitle: string, personaName: WorkflowStageDefinition["persona"], attemptNumber: number, inputContext: WorkflowStageInputContext & { extraContext?: unknown }): Promise<string> {
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
    admissionTier: "realtime",
    lineageId: parentSessionId,
    workflowRunId: detail.run.id,
    workflowStageAttemptId: inputContext.stageAttemptId,
    personaName,
    onSessionCreated: async (sessionId) => {
      await linkWorkflowSession({
        workflowRunId: detail.run.id,
        stageAttemptId: inputContext.stageAttemptId,
        sessionId,
        role: "stage_attempt",
        spawnReason,
      });
    },
  });
  return result.sessionId;
}

/**
 * Reconcile every terminal workflow child through the canonical stage-attempt
 * completion boundary. The child may checkpoint first, but it never owns the
 * invariant that a terminal child must have a terminal attempt.
 */
async function monitorWorkflowChild(
  attemptId: number,
  childSessionId: string,
  parentSessionId: string | null,
  runId: string,
  stageKey: string,
  stageTitle: string,
  attemptNumber: number,
  options: { staleOwner?: string | null } = {},
): Promise<void> {
  const existingLocal = activeWorkflowMonitors.get(attemptId);
  if (existingLocal) return;
  const lease = await claimWorkflowAttemptMonitor(attemptId, workflowMonitorOwner(runId), WORKFLOW_ATTEMPT_LEASE_MS, options.staleOwner);
  if (!lease.claimed) {
    log.debug(`[monitor] Workflow attempt ${attemptId} is owned by another monitor`);
    return;
  }

  const abortController = new AbortController();
  activeWorkflowMonitors.set(attemptId, { abortController, leaseId: lease.leaseId });
  const renewal = setInterval(() => {
    void renewWorkflowAttemptMonitor(attemptId, lease.leaseId).then((renewed) => {
      if (!renewed) abortController.abort("workflow_monitor_lease_lost");
    }).catch((error) => {
      log.warn(`[monitor] Workflow attempt ${attemptId} lease renewal failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, Math.floor(WORKFLOW_ATTEMPT_LEASE_MS / 3));
  renewal.unref?.();

  try {
    const stageIdleTimeoutMs = stageKey === "acceptance"
      ? ACCEPTANCE_DEPLOY_WAIT_TIMEOUT_MS + WORKFLOW_STAGE_IDLE_TIMEOUT_MS
      : WORKFLOW_STAGE_IDLE_TIMEOUT_MS;
    const result = await monitorChildSession(
      childSessionId,
      stageIdleTimeoutMs,
      abortController.signal,
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
      // Reached only when the child session ended while its attempt was still
      // active — i.e. it never recorded a verdict through complete_stage_attempt
      // (had it done so, the status check above would have short-circuited). We
      // do not infer the verdict from prose: an unrecorded verdict is a failed
      // attempt that holds the run on this stage. Explicit resume creates the
      // fresh recovery attempt; the run never advances on a guessed pass.
      log.warn(`[monitor] Workflow child ${childSessionId} ended without recording a verdict for ${stageTitle} #${attemptNumber}; failing attempt ${attemptId} as missing_verdict and holding the stage`);
      await completeStageAttempt(runId, attemptId, {
        result: "failed",
        outputSummary: truncateOutput(result.output, 500),
        failureContext: {
          reason: "missing_verdict",
          source: "child-session-monitor",
          childSessionId,
          nextSuggestedFix: "End the retry with a single complete_stage_attempt call recording the structured verdict.",
        },
      });
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
    case "termination_unconfirmed": {
      log.error(
        `[monitor] Workflow child ${childSessionId} termination unconfirmed after ${result.waitedMs}ms ` +
        `for ${stageTitle} #${attemptNumber}; blocking without retry`,
      );
      await completeStageAttempt(runId, attemptId, {
        result: "blocked",
        outputSummary: truncateOutput(result.message, 500),
        failureContext: {
          reason: "termination_unconfirmed",
          abortReason: result.abortReason,
          waitedMs: result.waitedMs,
          message: result.message,
          source: "child-session-monitor",
        },
      });
      break;
    }
  }
  } finally {
    clearInterval(renewal);
    activeWorkflowMonitors.delete(attemptId);
    await releaseWorkflowAttemptMonitor(attemptId, lease.leaseId).catch(() => undefined);
  }
}


async function runAsWorkflowOwner<T>(
  run: { ownerUserId: string | null; accountId: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  if (!run.ownerUserId || !run.accountId) throw new Error("Workflow recovery requires durable owner identity");
  const [identity] = await db.select({ user: users })
    .from(users)
    .innerJoin(accounts, and(
      eq(accounts.id, run.accountId),
      eq(accounts.kind, "personal"),
      eq(accounts.ownerUserId, run.ownerUserId),
    ))
    .where(eq(users.id, run.ownerUserId))
    .limit(1);
  if (!identity) throw new Error(`Workflow owner identity is no longer valid for account ${run.accountId}`);
  const foundation = await tryResolveUserIdentityFoundation(identity.user.id);
  return runWithPrincipal(
    createUserPrincipalFromUser(
      identity.user,
      run.accountId,
      foundation?.accountId === run.accountId ? foundation.instanceId : null,
    ),
    fn,
  );
}

async function recoverWorkflowAttempt(
  detail: WorkflowRunDetail,
  attempt: WorkflowStageAttempt,
  options: { staleOwner?: string | null; forceCurrentRuntime?: boolean } = {},
): Promise<boolean> {
  if (attempt.status !== "active" || attempt.completedAt) return false;

  const localMonitor = activeWorkflowMonitors.get(attempt.id);
  if (localMonitor && options.forceCurrentRuntime) {
    localMonitor.abortController.abort("workflow_resume_recovery");
  }
  if (attempt.executionLeaseExpiresAt && attempt.executionLeaseExpiresAt.getTime() > Date.now()) {
    if (!localMonitor || !options.forceCurrentRuntime) return false;
    const deadline = Date.now() + 15_000;
    while (activeWorkflowMonitors.has(attempt.id) && Date.now() < deadline) {
      await sleep(250);
    }
    const refreshed = await getWorkflowRun(detail.run.id);
    const refreshedAttempt = refreshed?.stages.flatMap((stage) => stage.attempts).find((candidate) => candidate.id === attempt.id);
    if (!refreshedAttempt || refreshedAttempt.status !== "active") return true;
    if (activeWorkflowMonitors.has(attempt.id)) {
      throw new Error(`Workflow attempt ${attempt.id} is still settling after pause; retry resume once termination completes.`);
    }
  }

  const lease = await claimWorkflowAttemptMonitor(
    attempt.id,
    `recovery:${workflowRuntimeInstanceId()}@${workflowRuntimeBootId()}`,
    WORKFLOW_ATTEMPT_LEASE_MS,
    options.staleOwner,
  );
  if (!lease.claimed) return false;

  try {
    const currentDetail = await getWorkflowRun(detail.run.id);
    const currentAttempt = currentDetail?.stages.flatMap((stage) => stage.attempts).find((candidate) => candidate.id === attempt.id);
    if (!currentDetail || !currentAttempt || currentAttempt.status !== "active" || currentAttempt.completedAt) return false;
    if (currentDetail.run.currentStageKey !== currentAttempt.stageKey) {
      const completedAt = new Date();
      const staleFailure = {
        attemptId: currentAttempt.id,
        stageKey: currentAttempt.stageKey,
        stageTitle: currentAttempt.stageTitle,
        attemptNumber: currentAttempt.attemptNumber,
        result: "failed",
        outputSummary: "Workflow recovery retired a stale stage attempt after the run moved beyond its stage.",
        failureContext: {
          reason: "stale_stage_attempt",
          source: WORKFLOW_RECOVERY_JOB,
          currentStageKey: currentDetail.run.currentStageKey,
          childSessionId: currentAttempt.childSessionId,
        },
        evidence: currentAttempt.evidence || {},
        childSessionId: currentAttempt.childSessionId,
      };
      const [retiredAttempt] = await db.update(workflowStageAttempts).set({
        status: "failed",
        result: "failed",
        outputSummary: staleFailure.outputSummary,
        failureContext: staleFailure,
        completedAt,
        durationSeconds: currentAttempt.startedAt
          ? Math.max(0, Math.round((completedAt.getTime() - currentAttempt.startedAt.getTime()) / 1000))
          : null,
        executionLeaseId: null,
        executionLeaseOwner: null,
        executionLeaseExpiresAt: null,
        updatedAt: completedAt,
      }).where(writable(attemptScopeColumns, and(
        eq(workflowStageAttempts.workflowRunId, currentDetail.run.id),
        eq(workflowStageAttempts.id, currentAttempt.id),
        eq(workflowStageAttempts.status, "active"),
        isNull(workflowStageAttempts.completedAt),
        eq(workflowStageAttempts.executionLeaseId, lease.leaseId),
      ))).returning();
      if (retiredAttempt) {
        log.warn(`[recovery] Retired stale Workflow attempt ${currentAttempt.id}: attempt stage ${currentAttempt.stageKey}, current stage ${currentDetail.run.currentStageKey || "none"}`);
      }
      return Boolean(retiredAttempt);
    }

    let result: "failed" | "blocked" = "failed";
    let reason = "interrupted_by_process_restart";
    let message = "Workflow stage monitoring was interrupted before a structured verdict was recorded.";
    if (currentAttempt.childSessionId) {
      const child = await chatFileStorage.getSession(currentAttempt.childSessionId).catch(() => null);
      if ((child as { status?: string } | null)?.status === "saved") {
        reason = "missing_verdict";
        message = "Workflow child completed without recording the required structured stage verdict.";
      } else {
        const termination = await abortAndConfirmChildTermination(currentAttempt.childSessionId, "cancelled");
        if (!termination.confirmed) {
          result = "blocked";
          reason = "termination_unconfirmed";
          message = `Interrupted Workflow child could not be proven terminated after ${termination.waitedMs}ms; retry is fenced.`;
        }
      }
    } else {
      reason = "child_session_missing";
      message = "Workflow attempt was interrupted before its child session was persisted.";
    }

    await completeStageAttempt(currentDetail.run.id, currentAttempt.id, {
      result,
      outputSummary: message,
      failureContext: {
        reason,
        source: WORKFLOW_RECOVERY_JOB,
        childSessionId: currentAttempt.childSessionId,
        nextSuggestedFix: result === "blocked"
          ? "Confirm the prior child is terminal before resuming."
          : "Resume the workflow to start a fresh attempt with the preserved failure packet.",
      },
    });
    return true;
  } finally {
    await releaseWorkflowAttemptMonitor(attempt.id, lease.leaseId).catch(() => undefined);
  }
}

const scheduledWorkflowRecoveries = new Map<number, NodeJS.Timeout>();

function scheduleWorkflowRecovery(attemptId: number, expiresAt: Date): void {
  const existing = scheduledWorkflowRecoveries.get(attemptId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    scheduledWorkflowRecoveries.delete(attemptId);
    void recoverInterruptedWorkflows();
  }, Math.max(1_000, expiresAt.getTime() - Date.now() + 1_000));
  timer.unref?.();
  scheduledWorkflowRecoveries.set(attemptId, timer);
}

export async function recoverInterruptedWorkflows(): Promise<number> {
  return runWithPrincipal(createNamedSystemPrincipal(WORKFLOW_RECOVERY_JOB), async () => {
    const activeAttempts = await db.select({ attempt: workflowStageAttempts, run: workflowRuns })
      .from(workflowStageAttempts)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStageAttempts.workflowRunId))
      .where(and(
        eq(workflowStageAttempts.status, "active"),
        isNull(workflowStageAttempts.completedAt),
      ))
      .limit(100);

    let recovered = 0;
    for (const row of activeAttempts) {
      if (ownedByCurrentWorkflowRuntime(row.attempt.executionLeaseOwner) && activeWorkflowMonitors.has(row.attempt.id)) continue;
      const staleOwner = ownedByPriorWorkflowBoot(row.attempt.executionLeaseOwner)
        ? row.attempt.executionLeaseOwner
        : null;
      if (!staleOwner && row.attempt.executionLeaseExpiresAt && row.attempt.executionLeaseExpiresAt.getTime() > Date.now()) {
        scheduleWorkflowRecovery(row.attempt.id, row.attempt.executionLeaseExpiresAt);
        continue;
      }
      const didRecover = await runAsWorkflowOwner(row.run, async () => {
        const detail = await getWorkflowRun(row.run.id);
        const attempt = detail?.stages.flatMap((stage) => stage.attempts).find((candidate) => candidate.id === row.attempt.id);
        if (!detail || !attempt) return false;
        return recoverWorkflowAttempt(detail, attempt, { staleOwner });
      }).catch((error) => {
        log.warn(`[recovery] Workflow attempt ${row.attempt.id} failed to recover: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      });
      if (didRecover) recovered += 1;
    }
    if (recovered > 0) log.log(`[recovery] Recovered ${recovered} interrupted Workflow attempt(s)`);
    return recovered;
  });
}

export const BUILD_WORKFLOW_TEMPLATE_ID = "build-v1";

async function assertBuildWorkflowAccess(templateId: string): Promise<void> {
  const principal = getCurrentPrincipal();
  if (!principal) throw new Error(`Workflow ${templateId} requires an explicit user principal`);
  await requireModWorkflowAccess(principal, templateId);
}

const buildDefinition = workflowTemplateDefinitionSchema.parse({
  stages: [
    {
      key: "scope", title: "Design", position: 0, autonomyMode: "autonomous", persona: "Architect",
      purpose: "Produce the durable specification for the smallest coherent change that satisfies the originating request. Inspect repository and runtime evidence here, name every governing standard the specification relies on, and expand only when evidence proves the narrower design cannot preserve a named invariant.",
      governingArtifactKinds: ["design_system", "product_definition"],
      entryCriteria: ["Start from the originating request. Inspect the repository and runtime only as needed to identify the failed invariant, the smallest coherent repair, and the named governing standards the specification must satisfy."],
      evidenceRequirements: ["A durable specification artifact (`kind: spec`) that names the smallest coherent implementation, success conditions, target truth, verification path, terminal state, and every governing standard relied upon. Any expansion beyond the request must cite the repository evidence and invariant that require it."],
      exitCriteria: ["The specification satisfies the request without speculative systems, migrations, abstractions, or adjacent improvements and is complete enough for implementation without Design Review adding architecture or requirements."],
      allowedTransitions: [{ toStageKey: "design_review", on: "passed" }],
    },
    {
      key: "design_review", title: "Design Review", position: 1, autonomyMode: "requires_agent_review", persona: "Architect",
      purpose: "Review only the Design-produced specification against its named governing standards. Reject only concrete violations cited to a specific standard; do not perform fresh architecture or repository discovery, and do not introduce requirements absent from those standards.",
      inputSources: ["scope"],
      governingArtifactKinds: ["design_system", "product_definition"],
      entryCriteria: ["Load the Design-produced specification and the named governing standards from Stage Inputs. Do not perform fresh architecture, repository, runtime, or dependency discovery."],
      evidenceRequirements: ["For each rejection, cite the exact specification statement and the exact named governing-standard provision it violates. Do not introduce a requirement that is absent from those standards. Security review remains authoritative: concrete violations of named SECURITY.md requirements may reject the specification."],
      exitCriteria: ["Pass unless the specification contains a concrete cited violation of a named governing standard. Unsupported preferences, newly discovered architecture concerns, and uncited best practices are not rejection grounds."],
      allowedTransitions: [
        { toStageKey: "implement", on: "passed" },
        { toStageKey: "scope", on: "changes_requested", reason: "revise_design" },
      ],
    },
    {
      key: "implement", title: "Implement", position: 2, autonomyMode: "autonomous", persona: "Engineer",
      purpose: "Implement the approved design completely, preserve its constraints, and produce build and change evidence.",
      inputSources: ["scope", "design_review"],
      governingArtifactKinds: ["coding_process", "product_definition"],
      entryCriteria: ["Load and implement the approved specification from Stage Inputs."],
      evidenceRequirements: ["Implementation evidence, build result, impact/change-scope evidence, and branch/commit references proving the approved specification was executed under the loaded governing context."],
      allowedTransitions: [{ toStageKey: "code_review", on: "passed" }],
    },
    {
      key: "code_review", title: "Implementation Review", position: 3, autonomyMode: "requires_agent_review", persona: "Engineer",
      purpose: "Find defects, inconsistencies, technical debt, and governing-context violations in the resulting implementation and every affected system. This is an implementation review, not merely a code or build check.",
      inputSources: ["scope", "design_review", "implement"],
      governingArtifactKinds: ["coding_process", "product_definition"],
      entryCriteria: ["Inspect the complete implementation, affected systems, approved design, and every loaded governing artifact before judging readiness."],
      evidenceRequirements: ["Find and report material defects, inconsistencies, technical debt, and governing-context violations in the resulting implementation. State required cures, residual risk, and acceptance readiness."],
      exitCriteria: ["Pass only when no material implementation or governing-context violation remains."],
      allowedTransitions: [
        { toStageKey: "acceptance", on: "passed" },
        { toStageKey: "implement", on: "changes_requested", reason: "revise_implementation" },
      ],
    },
    {
      key: "acceptance", title: "Acceptance Test", position: 4, autonomyMode: "autonomous", persona: "Engineer",
      purpose: "Confirm the deployed system boots successfully and does what the approved specification says it must do in the target environment.",
      inputSources: ["scope", "design_review", "implement", "code_review"],
      governingArtifactKinds: [],
      acceptanceContract: {
        routePathDefault: "/home",
        routePathSelection: "Prefer a route explicitly named in scope or changed files. Otherwise load /home. The Workflows screen is deprecated and is not a product surface.",
        logPolicy: "Check structured client and server logs after browser load. Treat relevant error-level entries as gate failures unless clearly unrelated.",
        smokePolicy: "Attempt the smallest safe feature path. If no non-destructive path exists, mark optional smoke attempted=false with reason rather than blocking.",
        failurePacketRequiredOnFail: ["failedGates", "targetUrl", "routePath", "deployment", "screenshot", "clientLogErrors", "serverLogErrors", "nextSuggestedFix"],
      },
      entryCriteria: ["Load the approved specification from Stage Inputs, then confirm the merged implementation is deployed and healthy in the target environment."],
      evidenceRequirements: ["Deployment, boot/health, target-route, screenshot, runtime-log, and safe feature-path evidence sufficient to determine whether the deployed result does what the approved specification requires."],
      exitCriteria: ["Pass only when the deployed system boots successfully and satisfies the approved specification."],
      allowedTransitions: [
        { toStageKey: "calibration", on: "passed" },
        { toStageKey: "implement", on: "product_failure", reason: "correct_product" },
        { toStageKey: "scope", on: "specification_failure", reason: "correct_specification" },
      ],
    },
    {
      key: "calibration", title: "Calibration", position: 5, autonomyMode: "autonomous", persona: "Architect",
      purpose: "Determine what this run revealed about the product, implementation process, and workflow, then record the changes that should follow.",
      inputSources: ["scope", "design_review", "acceptance"],
      governingArtifactKinds: ["product_definition"],
      calibrationContract: {
        compareAgainst: "Build workflow v1 spec: Design → Design Review → Implement → Implementation Review → Acceptance Test → Calibration → Documentation.",
        requiredDecision: "Emit exactly one declared Calibration decision: continue, update_docs, gate, or fail_back. The template owns the corresponding transition; do not report a domain decision as executor failure.",
        documentationUpdatePolicy: "Attach a calibration artifact recording workflow/spec/doc updates needed or made. Do not create a user gate for routine documentation updates.",
      },
      entryCriteria: ["Load the approved specification and acceptance evidence from Stage Inputs."],
      evidenceRequirements: ["Compare the approved specification, implementation outcome, retries, and acceptance evidence to identify what the run taught us about the product and what should change next."],
      allowedTransitions: [
        { toStageKey: "documentation", on: "continue" },
        { toStageKey: "documentation", on: "update_docs", reason: "record_calibration_updates" },
        { toStageKey: "calibration", on: "gate", reason: "await_calibration_gate" },
        { toStageKey: "scope", on: "fail_back", reason: "recalibrate_design" },
      ],
    },
    {
      key: "documentation", title: "Documentation", position: 6, autonomyMode: "autonomous", persona: "Engineer",
      purpose: "Preserve the final implemented truth, evidence, decisions, and remaining gates in durable project documentation.",
      inputSources: ["scope", "design_review", "implement", "code_review", "acceptance", "calibration"],
      governingArtifactKinds: ["product_definition"],
      evidenceRequirements: ["Durable final documentation that records the implemented truth, linked evidence, decisions, handoff, and any remaining gates under the loaded governing context."],
      allowedTransitions: [{ toStageKey: null, on: "passed", reason: "complete" }],
    },
  ],
  terminalStatuses: ["completed", "failed", "canceled"],
});

const buildRetryPolicy = {
  // Retries are explicit human recovery actions, never autonomous failure routes.
  // The second attempt leaves room to resume a stopped stage once without
  // turning the workflow into an unbounded orchestration loop.
  maxAttemptsPerStage: 2,
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
    version: "1.1",
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

export async function getWorkflowEnvironmentTruth(runIdOrEnvironmentId: string | number, expectedCommitSha?: string | null, notBefore?: Date | null): Promise<WorkflowEnvironmentTruth | null> {
  let environmentId: number | null = typeof runIdOrEnvironmentId === "number" ? runIdOrEnvironmentId : null;
  if (typeof runIdOrEnvironmentId === "string") {
    const [run] = await db.select({ environmentId: workflowRuns.linkedEnvironmentId }).from(workflowRuns).where(visible(runScopeColumns, eq(workflowRuns.id, runIdOrEnvironmentId))).limit(1);
    environmentId = run?.environmentId ?? null;
  }
  if (!environmentId) return null;

  const [row] = await db
    .select({
      platform: platforms,
      product: products,
      environment: platformProductEnvironments,
    })
    .from(platformProductEnvironments)
    .innerJoin(products, eq(platformProductEnvironments.productId, products.id))
    .innerJoin(platforms, eq(platformProductEnvironments.platformId, platforms.id))
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
            const latestProviderDeployment = await getLatestDeploymentByToken(token, hostingRow.projectId, hostingRow.serviceId, hostingRow.providerEnvironmentId);
            let selected = latestProviderDeployment;
            let attribution: Record<string, unknown> | null = null;
            if (expectedCommitSha || notBefore) {
              const deployments = await fetchDeploymentsForEnvironment(hostingRow.projectId, hostingRow.serviceId, hostingRow.providerEnvironmentId, 25, token);
              const candidates = deployments
                .map((candidate) => {
                  const meta = extractDeploymentMeta(candidate.meta);
                  return {
                    deployment: candidate,
                    latest: {
                      id: candidate.id,
                      status: candidate.status,
                      commitHash: meta.commitHash || null,
                      commitMessage: meta.commitMessage || null,
                      createdAt: candidate.createdAt || null,
                    } satisfies LatestDeployment,
                  };
                })
                .sort((left, right) => {
                  const rank = (status: string) => deploymentStatusCategory(status) === "green" ? 0 : deploymentStatusCategory(status) === "pending" ? 1 : 2;
                  return rank(left.latest.status) - rank(right.latest.status) || Date.parse(right.latest.createdAt || "") - Date.parse(left.latest.createdAt || "");
                });

              selected = null;
              let ancestryError: string | null = null;
              for (const candidate of candidates) {
                const candidateSha = candidate.latest.commitHash;
                let containsExpectedCommit = !expectedCommitSha;
                let containmentMethod = expectedCommitSha ? "unproven" : "deployment_time";
                if (expectedCommitSha && candidateSha) {
                  if (commitMatches(expectedCommitSha, candidateSha)) {
                    containsExpectedCommit = true;
                    containmentMethod = "exact_commit";
                  } else if (sourceRow?.owner && sourceRow.repo) {
                    try {
                      const comparison = await compareRefs({ owner: sourceRow.owner, repo: sourceRow.repo }, expectedCommitSha, candidateSha);
                      containsExpectedCommit = comparison.status === "ahead" || comparison.status === "identical";
                      containmentMethod = containsExpectedCommit ? "github_ancestry" : `github_${comparison.status}`;
                    } catch (error) {
                      ancestryError = error instanceof Error ? error.message : String(error);
                      containmentMethod = "github_compare_failed";
                    }
                  }
                }
                const createdAtMs = Date.parse(candidate.latest.createdAt || "");
                const afterBoundary = expectedCommitSha
                  ? true
                  : !notBefore || (Number.isFinite(createdAtMs) && createdAtMs >= notBefore.getTime());
                if (containsExpectedCommit && afterBoundary) {
                  selected = candidate.latest;
                  attribution = {
                    expectedCommitSha: expectedCommitSha || null,
                    selectedCommitSha: candidateSha,
                    containsExpectedCommit,
                    method: containmentMethod,
                    notBefore: notBefore?.toISOString() || null,
                    selectedDeploymentId: candidate.latest.id,
                    latestProviderDeploymentId: latestProviderDeployment?.id || null,
                  };
                  break;
                }
              }
              if (!selected) {
                deployment = unavailableDeployment(
                  expectedCommitSha
                    ? `No bounded Railway deployment can be proven to contain workflow commit ${expectedCommitSha}. Checked ${deployments.length} deployments for ${sourceRow?.owner || "unknown"}/${sourceRow?.repo || "unknown"}.${ancestryError ? ` GitHub ancestry check failed: ${ancestryError}` : ""}`
                    : `No bounded Railway deployment was created after workflow boundary ${notBefore?.toISOString() || "unknown"}.`,
                );
              }
            }
            if (!deployment) {
              deployment = {
                ...deploymentBase,
                available: true,
                latest: selected ? { id: selected.id, status: selected.status, commitSha: selected.commitHash, commitMessage: selected.commitMessage, deployedAt: selected.createdAt, attribution } : null,
                urlReachable,
              };
            }
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

export type WorkflowStageCapability = {
  workflowRunId: string;
  stageAttemptId: number;
  stageKey: string;
  status: string;
};

export async function resolveWorkflowStageCapability(sessionId: string): Promise<WorkflowStageCapability | null> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return null;
  const [row] = await db
    .select({
      workflowRunId: workflowSessions.workflowRunId,
      stageAttemptId: workflowSessions.stageAttemptId,
      stageKey: workflowStageAttempts.stageKey,
      status: workflowStageAttempts.status,
    })
    .from(workflowSessions)
    .innerJoin(workflowStageAttempts, and(
      eq(workflowStageAttempts.workflowRunId, workflowSessions.workflowRunId),
      eq(workflowStageAttempts.id, workflowSessions.stageAttemptId),
    ))
    .where(and(
      visible(sessionScopeColumns, and(
        eq(workflowSessions.sessionId, normalizedSessionId),
        eq(workflowSessions.role, "stage_attempt"),
      )),
      visible(attemptScopeColumns),
    ))
    .limit(1);
  if (!row || row.stageAttemptId === null) return null;
  return {
    workflowRunId: row.workflowRunId,
    stageAttemptId: row.stageAttemptId,
    stageKey: row.stageKey,
    status: row.status,
  };
}

function assertWorkflowEnvironmentRequirement(template: WorkflowTemplate, linkedEnvironmentId?: number | null): void {
  const definition = parseWorkflowDefinition(template);
  const requiresEnvironment = definition.stages.some((stage) => stage.key === "acceptance");
  if (requiresEnvironment && !linkedEnvironmentId) {
    throw new Error(
      `Workflow template "${template.name}" includes an acceptance stage and requires linkedEnvironmentId. ` +
      "Create environment-backed Build runs through platforms.start_build_workflow with the target Platform Environment; incomplete runs are not persisted.",
    );
  }
}

async function assertWorkflowCreationSessionsCanOrchestrate(sessionIds: Array<string | undefined>): Promise<void> {
  const normalizedSessionIds = [...new Set(sessionIds.map((id) => id?.trim()).filter((id): id is string => Boolean(id)))];
  if (normalizedSessionIds.length === 0) return;
  const [stageSession] = await db
    .select({
      sessionId: workflowSessions.sessionId,
      workflowRunId: workflowSessions.workflowRunId,
    })
    .from(workflowSessions)
    .where(visible(sessionScopeColumns, and(
      inArray(workflowSessions.sessionId, normalizedSessionIds),
      eq(workflowSessions.role, "stage_attempt"),
    )))
    .limit(1);
  if (!stageSession) return;
  throw new Error(
    `Workflow stage session ${stageSession.sessionId} cannot create a nested workflow. ` +
    `Complete its assigned stage in workflow ${stageSession.workflowRunId} instead.`,
  );
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
  await assertBuildWorkflowAccess(templateId);
  const template = await getWorkflowTemplate(templateId) || (templateId === BUILD_WORKFLOW_TEMPLATE_ID ? await seedBuildWorkflowTemplate() : null);
  if (!template) throw new Error(`Workflow template not found: ${templateId}`);
  if (!input.title?.trim()) throw new Error("Workflow title is required");
  if (!input.objective?.trim()) throw new Error("Workflow objective is required");
  assertWorkflowEnvironmentRequirement(template, input.linkedEnvironmentId);
  await assertWorkflowCreationSessionsCanOrchestrate([input.parentSessionId, input.createdBySessionId]);
  const lifecycleSnapshot = input.lifecycleSnapshot ?? (
    templateId === BUILD_WORKFLOW_TEMPLATE_ID && input.linkedEnvironmentId
      ? await (await import("../platforms/build-lifecycle-service")).buildEnvironmentLifecycleSnapshot(input.linkedEnvironmentId)
      : null
  );

  const id = generateWorkflowRunId();
  const initialContent = `# Workflow: ${input.title}\n\nCreating checkpoint...`;
  const { createFiledLibraryPage } = await import("../library-save");
  const page = await createFiledLibraryPage({
    title: `Workflow: ${input.title}`,
    markdown: initialContent,
    canonicalFolder: "workflows",
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
    lifecycleSnapshot,
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
  const requestSourceSessionId = input.createdBySessionId || input.parentSessionId;
  if (requestSourceSessionId) {
    const messages = await chatFileStorage.getMessagesBySession(requestSourceSessionId);
    const requestMessage = [...messages].reverse().find((message) => message.role === "user" && message.content.trim());
    if (requestMessage) {
      await attachWorkflowArtifact({
        workflowRunId: id,
        kind: "originating_request",
        title: "Originating user request",
        refType: "session_message",
        refId: `${requestSourceSessionId}:${requestMessage.id}`,
        summary: "The user request that authorizes and bounds this workflow.",
        metadata: {
          content: requestMessage.content,
          sessionId: requestSourceSessionId,
          messageId: requestMessage.id,
          createdAt: requestMessage.createdAt,
        },
        createdBySessionId: requestSourceSessionId,
        render: false,
      });
    }
  }
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
  await assertBuildWorkflowAccess(detail.template.id);
  if (!["draft", "paused", "blocked"].includes(detail.run.status)) throw new Error(`Workflow run status is ${detail.run.status}; cannot start.`);
  await assertNoOpenGate(runId);

  // Retain the invariant at start for legacy drafts created before creation-time validation.
  assertWorkflowEnvironmentRequirement(detail.template, detail.run.linkedEnvironmentId);
  await ensureWorkflowParentSession(detail);
  await db.update(workflowRuns).set({ status: "active", updatedAt: new Date() }).where(writable(runScopeColumns, eq(workflowRuns.id, runId)));
  const stageKey = detail.run.currentStageKey;
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

function abortWorkflowRunMonitors(detail: WorkflowRunDetail, reason: string): void {
  for (const attempt of detail.stages.flatMap((stage) => stage.attempts)) {
    if (attempt.status !== "active") continue;
    activeWorkflowMonitors.get(attempt.id)?.abortController.abort(reason);
  }
}

export async function pauseWorkflowRun(runId: string, reason = "paused"): Promise<WorkflowRunDetail> {
  const detail = await getWorkflowRun(runId);
  if (!detail) throw new Error(`Workflow run not found: ${runId}`);
  await recordTransition({ workflowRunId: runId, fromStageKey: detail.run.currentStageKey, toStageKey: detail.run.currentStageKey, trigger: "manual", reason, render: false });
  const paused = await updateWorkflowRun(runId, { status: "paused" });
  abortWorkflowRunMonitors(detail, "workflow_paused");
  return paused;
}

export async function resumeWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  const detail = await getWorkflowRun(runId);
  if (!detail) throw new Error(`Workflow run not found: ${runId}`);
  const activeAttempt = detail.stages.flatMap((stage) => stage.attempts).find((attempt) => attempt.status === "active" && !attempt.completedAt);
  if (activeAttempt) {
    await recoverWorkflowAttempt(detail, activeAttempt, { forceCurrentRuntime: true });
  }
  return startWorkflowRun(runId);
}

export async function cancelWorkflowRun(runId: string, reason = "canceled"): Promise<WorkflowRunDetail> {
  const detail = await getWorkflowRun(runId);
  if (!detail) throw new Error(`Workflow run not found: ${runId}`);
  await recordTransition({ workflowRunId: runId, fromStageKey: detail.run.currentStageKey, toStageKey: null, trigger: "manual", reason, render: false });
  const canceled = await updateWorkflowRun(runId, { status: "canceled", currentStageKey: null });
  abortWorkflowRunMonitors(detail, "workflow_canceled");
  return canceled;
}

function stageFor(detail: WorkflowRunDetail, stageKey: string) {
  const def = parseWorkflowDefinition(detail.template).stages.find((s) => s.key === stageKey);
  if (!def) throw new Error(`Stage ${stageKey} not found in template ${detail.template.id}`);
  return def;
}

export async function startStageAttempt(runId: string, stageKey?: string, options: { childSessionId?: string; linkedPlanId?: string; inputContext?: unknown; createdBySessionId?: string; spawnChildSession?: boolean } = {}): Promise<WorkflowStageAttempt> {
  const initialDetail = await getWorkflowRun(runId);
  if (!initialDetail) throw new Error(`Workflow run not found: ${runId}`);
  await assertBuildWorkflowAccess(initialDetail.template.id);
  await assertNoOpenGate(runId);
  const key = stageKey || initialDetail.run.currentStageKey;
  if (!key) throw new Error(`Workflow run ${runId} has no current stage.`);
  const detail = await reconcilePriorStageSessionArtifacts(initialDetail, key);
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
  const executionAttemptNumber = failedAttempts(attemptsInCurrentStageVisit(detail, key)).length + 1;
  if (executionAttemptNumber > maxAttempts) throw new Error(`Workflow run ${runId} stage ${key} exceeded max execution attempts (${maxAttempts}) in its current visit.`);

  const parentSessionId = await ensureWorkflowParentSession(detail);
  const stageSpecificContext = acceptanceStageContext(detail) || calibrationStageContext(detail);
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
    childSessionId = childSessionId || (options.spawnChildSession === false ? null : await spawnWorkflowStageChild(parentSessionId, detail, key, stage.title, stage.persona, attemptNumber, persistedInputContext));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(workflowStageAttempts).set({ status: "failed", result: "failed", outputSummary: `Failed to spawn workflow child: ${message}`, failureContext: { reason: "child_spawn_failed", message }, completedAt: new Date(), updatedAt: new Date() }).where(writable(attemptScopeColumns, and(eq(workflowStageAttempts.workflowRunId, runId), eq(workflowStageAttempts.id, attempt.id))));
    throw error;
  }
  await db.update(workflowStageAttempts).set({ childSessionId, inputContext: persistedInputContext, updatedAt: new Date() }).where(writable(attemptScopeColumns, and(eq(workflowStageAttempts.workflowRunId, runId), eq(workflowStageAttempts.id, attempt.id))));
  if (childSessionId) await linkWorkflowSession({ workflowRunId: runId, stageAttemptId: attempt.id, sessionId: childSessionId, role: "stage_attempt", spawnReason: `workflow:${runId}:${key}:attempt-${attemptNumber}` });
  if (key === "acceptance" && childSessionId) {
    const expected = expectedAcceptanceDeployment(detail);
    const truth = await getWorkflowEnvironmentTruth(runId, expected.commitSha, expected.notBefore);
    if (!deploymentIsCurrent(truth?.deployment, expected) || deploymentStatusCategory(normalizedDeploymentStatus(truth?.deployment)) === "pending") {
      await chatFileStorage.updateSessionStatus(childSessionId, "waiting");
    }
  }
  await db.update(workflowRuns).set({ status: "active", currentStageKey: key, updatedAt: new Date() }).where(writable(runScopeColumns, eq(workflowRuns.id, runId)));
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

/**
 * Retired dual-dispatch path.
 *
 * Post-build Regression is owned exclusively by the managed fireOnNextBuild
 * Timer (`build-managed-resources` + `timer-scheduler.fireBootReminders`).
 * Exactly-once is the run-row claim under a build-scoped scheduled slot —
 * not a second pending row written from acceptance completion.
 *
 * Keeping this as a no-op preserves the call site shape so acceptance
 * completion stays a single transaction without a second launcher.
 */
async function enqueueAcceptedBuildRegression(
  _tx: import("../db").DrizzleTx,
  _detail: WorkflowRunDetail,
  _attempt: WorkflowStageAttempt,
  _evidence: unknown,
  _acceptedAt: Date,
): Promise<void> {
  return;
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
    : { reason: "acceptance_gate_failure", failedGates, gates, nextSuggestedFix: "Fix the failed condition, publish if needed, then resume and rerun Acceptance Test." };
}

export async function completeStageAttempt(workflowRunId: string, attemptId: number, resultInput: { result: string; outputSummary?: string; evidence?: unknown; failureContext?: unknown; createdBySessionId?: string }): Promise<WorkflowRunDetail> {
  if (!workflowRunId.trim()) throw new Error("completeStageAttempt requires workflowRunId");
  if (!Number.isSafeInteger(attemptId) || attemptId <= 0) throw new Error(`Invalid stage attempt ID: ${String(attemptId)}`);
  const requestedResult = workflowAttemptResultSchema.parse(resultInput.result);
  const [attempt] = await db.select().from(workflowStageAttempts).where(visible(attemptScopeColumns, and(eq(workflowStageAttempts.workflowRunId, workflowRunId), eq(workflowStageAttempts.id, attemptId)))).limit(1);
  if (!attempt) throw new Error(`Stage attempt ${attemptId} not found in workflow run ${workflowRunId}`);
  const beforeDetail = await getWorkflowRun(workflowRunId);
  if (!beforeDetail) throw new Error(`Workflow run not found: ${workflowRunId}`);
  await assertBuildWorkflowAccess(beforeDetail.template.id);
  if (attempt.status !== "active" || attempt.completedAt) {
    log.log(`completeStageAttempt received replay for terminal attempt ${attemptId}; returning current workflow state.`);
    return beforeDetail;
  }
  if (beforeDetail.run.currentStageKey !== attempt.stageKey) throw new Error(`Stage attempt ${attemptId} is stale for workflow run ${workflowRunId}: attempt stage ${attempt.stageKey}, current stage ${beforeDetail.run.currentStageKey || "none"}`);
  const forcedAcceptanceFailure = acceptanceGateFailureFromEvidence(attempt, requestedResult, resultInput.evidence || attempt.evidence || {});
  const result = forcedAcceptanceFailure
    ? forcedAcceptanceFailure.reason === "acceptance_gate_failure" ? "product_failure" : "failed"
    : requestedResult;
  const stage = stageFor(beforeDetail, attempt.stageKey);
  const transitionDef = stage.allowedTransitions.find((transition) => transition.on === result);
  const executionFault = result === "failed";
  const heldVerdict = result === "blocked" || result === "needs_review" || result === "skipped";
  if (!executionFault && !heldVerdict && !transitionDef) {
    throw new Error(`Malformed workflow verdict: stage ${attempt.stageKey} does not declare transition ${result}`);
  }
  const status = executionFault ? "failed" : heldVerdict ? result : "passed";
  const durationSeconds = attempt.startedAt ? Math.max(0, Math.round((Date.now() - attempt.startedAt.getTime()) / 1000)) : null;
  const failurePacket = executionFault || status === "blocked"
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

  // Claim completion in one transaction. Post-build Regression is launched by
  // the managed fireOnNextBuild Timer on the next process boot for the new
  // deploy — not dual-enqueued from acceptance (see enqueueAcceptedBuildRegression).
  const completion = await db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    const acceptedAt = new Date();
    const [completedAttempt] = await tx.update(workflowStageAttempts).set({
      status,
      result,
      outputSummary: resultInput.outputSummary || null,
      evidence: resultInput.evidence || attempt.evidence || {},
      failureContext: failurePacket || resultInput.failureContext || null,
      completedAt: acceptedAt,
      durationSeconds,
      updatedAt: acceptedAt,
    }).where(writable(attemptScopeColumns, and(
      eq(workflowStageAttempts.workflowRunId, workflowRunId),
      eq(workflowStageAttempts.id, attemptId),
      eq(workflowStageAttempts.status, "active"),
      isNull(workflowStageAttempts.completedAt),
    ))).returning();
    if (!completedAttempt) return null;
    if (result === "passed") {
      await enqueueAcceptedBuildRegression(
        tx,
        beforeDetail,
        completedAttempt,
        resultInput.evidence || attempt.evidence || {},
        acceptedAt,
      );
    }
    return completedAttempt;
  }));
  if (!completion) {
    log.log(`completeStageAttempt lost completion claim for attempt ${attemptId}; another path already completed it.`);
    return (await getWorkflowRun(attempt.workflowRunId))!;
  }
  const completedAttempt = completion;
  if (failurePacket) await db.update(workflowRuns).set({ failurePacket, updatedAt: new Date() }).where(writable(runScopeColumns, eq(workflowRuns.id, attempt.workflowRunId)));
  if (resultInput.evidence) await attachWorkflowArtifact({ workflowRunId: attempt.workflowRunId, stageAttemptId: attempt.id, kind: attempt.stageKey === "calibration" ? "calibration" : attempt.stageKey === "acceptance" ? "acceptance" : result === "passed" ? "acceptance" : "other", title: `${attempt.stageTitle} attempt ${result}`, summary: resultInput.outputSummary || "", metadata: resultInput.evidence, createdBySessionId: resultInput.createdBySessionId, render: false });
  await projectSessionArtifactsToWorkflow(workflowRunId, completedAttempt, resultInput.createdBySessionId);

  return advanceWorkflowRun(workflowRunId, executionFault || heldVerdict ? "system" : "autonomous", attempt.id, result, resultInput.outputSummary || "");
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
  // Preemption boundary. Workflow stage children stream to completion with no
  // mid-inference abort (see monitorWorkflowChild), so the only safe place to
  // enforce a human hold is the stage transition boundary. The caller has
  // already recorded this attempt's terminal result and evidence; if a human has
  // since paused or canceled the run, record the held result but never overwrite
  // that status or spawn the next stage. Resuming (startWorkflowRun) re-activates
  // and continues. This fires only for already-held runs, so active runs are
  // unaffected; reverting this block restores the prior always-advance behavior.
  if (detail.run.status === "paused" || detail.run.status === "canceled") {
    log.warn(`advanceWorkflowRun: run ${runId} is ${detail.run.status}; recording ${result} for stage ${current} without advancing or spawning the next stage.`);
    await recordTransition({
      workflowRunId: runId,
      fromStageKey: current,
      toStageKey: detail.run.currentStageKey ?? null,
      fromAttemptId,
      trigger: "system",
      reason: `Stage result ${result} recorded while run ${detail.run.status}; run held, not advancing.`,
      render: false,
    });
    return (await getWorkflowRun(runId)) ?? detail;
  }
  if (["failed", "blocked", "needs_review", "skipped"].includes(result)) {
    await recordTransition({
      workflowRunId: runId,
      fromStageKey: current,
      toStageKey: current,
      fromAttemptId,
      trigger: "system",
      reason: reason || `Stage result ${result}; run held on ${current} for explicit recovery.`,
      render: false,
    });
    await db.update(workflowRuns).set({
      status: "blocked",
      completedAt: null,
      updatedAt: new Date(),
    }).where(writable(runScopeColumns, eq(workflowRuns.id, runId)));
    await renderWorkflowRunPage(runId);
    return (await getWorkflowRun(runId))!;
  }

  const stage = stageFor(detail, current);
  const transitionDef = stage.allowedTransitions.find((transition) => transition.on === result);
  if (!transitionDef) {
    const failurePacket = {
      reason: "undeclared_stage_verdict",
      stageKey: current,
      verdict: result,
      fromAttemptId: fromAttemptId || null,
      nextSuggestedFix: `Declare verdict ${result} on stage ${current}; undeclared verdicts are malformed execution.`,
    };
    log.error(`Workflow ${runId} received undeclared verdict ${result} for ${current}; blocking as malformed execution`);
    await recordTransition({
      workflowRunId: runId,
      fromStageKey: current,
      toStageKey: current,
      fromAttemptId,
      trigger: "system",
      reason: `Undeclared verdict ${result}; run blocked as malformed execution.`,
      evidence: failurePacket,
      render: false,
    });
    await db.update(workflowRuns).set({
      status: "blocked",
      failurePacket,
      completedAt: null,
      updatedAt: new Date(),
    }).where(writable(runScopeColumns, eq(workflowRuns.id, runId)));
    await renderWorkflowRunPage(runId);
    return (await getWorkflowRun(runId))!;
  }
  const next = transitionDef.toStageKey;
  await recordTransition({ workflowRunId: runId, fromStageKey: current, toStageKey: next, fromAttemptId, trigger, reason: reason || transitionDef.reason || "pass" });
  const nextStatus = next ? "active" : "completed";
  await db.update(workflowRuns).set({ status: nextStatus, completedAt: next ? null : new Date(), updatedAt: new Date() }).where(writable(runScopeColumns, eq(workflowRuns.id, runId)));
  await renderWorkflowRunPage(runId);
  const updated = (await getWorkflowRun(runId))!;

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
  const principal = getCurrentPrincipal();
  if (!principal) throw new Error("Workflow artifact attachment requires a user principal");
  const refType = input.refType || "text";
  const refId = input.refId || null;
  const metadata = input.metadata || {};
  const artifactAddress = await canonicalExecutionArtifactAddress(principal, refType, refId, metadata);
  const [artifact] = await db.insert(workflowArtifacts).values({
    workflowRunId,
    stageAttemptId: input.stageAttemptId ?? null,
    kind: input.kind,
    title: defaultArtifactTitle(input),
    refType,
    refId,
    artifactAddress,
    url: input.url || null,
    summary: input.summary || "",
    metadata,
    createdBySessionId: input.createdBySessionId || null,
    ...owner(artifactScopeColumns),
  }).returning();
  if (artifactAddress) await linkWorkflowArtifactProduced(principal, artifact);
  if (input.render !== false) await renderWorkflowRunPage(workflowRunId);
  return artifact;
}


export async function capturePublishToStageEvidence(input: { workflowRunId: string; stageAttemptId?: number | null; createdBySessionId?: string; summary?: string }): Promise<WorkflowArtifact> {
  const detail = await getWorkflowRun(input.workflowRunId);
  if (!detail) throw new Error(`Workflow run not found: ${input.workflowRunId}`);
  const expected = expectedAcceptanceDeployment(detail);
  const truth = await getWorkflowEnvironmentTruth(input.workflowRunId, expected.commitSha, expected.notBefore);
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

function waitableDeploymentUnavailability(reason: string | undefined): boolean {
  if (!reason) return false;
  return /provider cooldown|rate limit(?:ed)?|retry after \d+s|no bounded .* deployment can be proven to contain workflow commit|no bounded .* deployment was created after workflow boundary/i.test(reason);
}

function deploymentRetryDelayMs(reason: string | undefined, remainingMs: number): number {
  const retryAfterSeconds = reason?.match(/retry after\s+(\d+)s/i)?.[1];
  const providerDelayMs = retryAfterSeconds ? Number(retryAfterSeconds) * 1_000 + 1_000 : ACCEPTANCE_DEPLOY_POLL_INTERVAL_MS;
  return Math.max(0, Math.min(providerDelayMs, remainingMs));
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

function expectedAcceptanceDeployment(detail: WorkflowRunDetail): { commitSha: string | null; notBefore: Date | null; source: string } {
  const review = detail.stages.find((stage) => stage.key === "code_review")?.attempts
    .filter((attempt) => attempt.result === "passed" && attempt.completedAt)
    .sort((a, b) => (b.completedAt?.getTime() || 0) - (a.completedAt?.getTime() || 0))[0];
  const implement = detail.stages.find((stage) => stage.key === "implement")?.attempts
    .filter((attempt) => attempt.result === "passed" && attempt.completedAt)
    .sort((a, b) => (b.completedAt?.getTime() || 0) - (a.completedAt?.getTime() || 0))[0];
  const evidenceCommit = findCommitSha(review?.evidence) || findCommitSha(implement?.evidence);
  const snapshot = detail.lifecycleSnapshot && typeof detail.lifecycleSnapshot === "object" ? detail.lifecycleSnapshot as Record<string, unknown> : {};
  const source = snapshot.source && typeof snapshot.source === "object" ? snapshot.source as Record<string, unknown> : {};
  const snapshottedCommit = typeof source.targetCommitSha === "string" && /^[a-f0-9]{7,40}$/i.test(source.targetCommitSha.trim())
    ? source.targetCommitSha.trim().toLowerCase()
    : null;
  return {
    commitSha: evidenceCommit || snapshottedCommit,
    notBefore: evidenceCommit ? review?.completedAt || implement?.completedAt || null : source.targetCommitResolvedAt ? new Date(String(source.targetCommitResolvedAt)) : detail.run.createdAt,
    source: evidenceCommit ? "stage_evidence" : snapshottedCommit ? "lifecycle_snapshot" : "time_boundary",
  };
}

function deploymentIsCurrent(
  deployment: WorkflowEnvironmentTruth["deployment"] | null | undefined,
  expected: { commitSha: string | null; notBefore: Date | null },
): boolean {
  const observedCommit = deploymentCommitSha(deployment);
  const latest = deployment?.latest && typeof deployment.latest === "object" ? deployment.latest as Record<string, unknown> : {};
  const attribution = latest.attribution && typeof latest.attribution === "object" ? latest.attribution as Record<string, unknown> : {};
  if (expected.commitSha) return commitMatches(expected.commitSha, observedCommit) || attribution.containsExpectedCommit === true;
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
    truth = await getWorkflowEnvironmentTruth(runId, expected.commitSha, expected.notBefore);
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
      if (waitableDeploymentUnavailability(deployment?.reason) && waitedMs < ACCEPTANCE_DEPLOY_WAIT_TIMEOUT_MS) {
        await sleep(deploymentRetryDelayMs(deployment?.reason, ACCEPTANCE_DEPLOY_WAIT_TIMEOUT_MS - waitedMs));
        continue;
      }
      const status = waitableDeploymentUnavailability(deployment?.reason) ? "timeout" : "unavailable";
      const readiness: DeploymentReadiness = { status, ...base, message: deployment?.reason || "Deployment status is unavailable." };
      if (status === "timeout") readiness.message = deploymentReadinessMessage(readiness, deployment?.provider || "hosting");
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
    nextSuggestedFix: "Fix the first failed required gate, publish if needed, then resume and rerun Acceptance Test with this packet.",
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
  const routePath = safeRoutePath(input.routePath || acceptanceTarget.routePath || acceptanceTarget.screenshotRoutePath, "/home");
  const healthCheckPath = safeRoutePath(acceptanceTarget.healthCheckPath, "/");
  const acceptanceExplicitRouteDisabled =
    process.env.WORKFLOW_ACCEPTANCE_EXPLICIT_ROUTE_DISABLED === "true" ||
    process.env.WORKFLOW_ACCEPTANCE_EXPLICIT_ROUTE_DISABLED === "1";
  const screenshotRoutePath = acceptanceExplicitRouteDisabled
    ? safeRoutePath(acceptanceTarget.screenshotRoutePath || routePath, routePath)
    : safeRoutePath(input.routePath || acceptanceTarget.screenshotRoutePath || acceptanceTarget.routePath, routePath);
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
        if (authMode !== "platform_binding") {
          throw new Error(`Acceptance auth invariant failed: auth mode '${authMode}' has no browser-session establishment contract`);
        }
        if (!detail.run.ownerUserId) {
          throw new Error("Platform-binding auth invariant failed: workflow run has no owner user ID");
        }
        const sessionSecret = await resolvePlatformBindingSessionSecret(lifecycleSnapshot);
        const sessionEvidence = await captureBrowserSessionEvidence(directUrl, {
          expectedRoutePath: screenshotRoutePath,
          viewport: "desktop",
          fullPage: true,
          delay: 1500,
          authenticate: true,
          authentication: { mode: "platform_binding", userId: detail.run.ownerUserId, sessionSecret },
        });
        browserSession = sessionEvidence as unknown as Record<string, unknown>;
        screenshot = sessionEvidence.screenshot;
        browserError = sessionEvidence.error;
        auth.established = sessionEvidence.authVerified && !sessionEvidence.loginScreenDetected && !sessionEvidence.error;
        auth.verified = sessionEvidence.authVerified;
        auth.status = sessionEvidence.authStatus;
        auth.userId = sessionEvidence.authUserId;
        auth.error = auth.established ? null : sessionEvidence.authError || sessionEvidence.error || `Auth verification failed with status ${sessionEvidence.authStatus ?? "unknown"}`;
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
    const principal = requireCurrentPrincipal();
    await db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
      const [page] = await tx.update(libraryPages).set({ content: synced.content, plainTextContent: synced.plainTextContent, updatedAt: sql`CURRENT_TIMESTAMP` }).where(writable({ scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, vaultId: libraryPages.vaultId }, eq(libraryPages.id, detail.run.linkedLibraryPageId))).returning();
      if (!page) return;
      const { indexLibraryPageReferences } = await import("../library-reference-index");
      await indexLibraryPageReferences(principal, page);
    }));
  } catch (err) {
    log.warn(`Failed to render workflow ${runId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
