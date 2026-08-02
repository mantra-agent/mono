import crypto from "crypto";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  issueRegressionContractInputSchema,
  issueRegressionContracts,
  issueRegressionResults,
  regressionResultStatusSchema,
  regressionRuns,
  type IssueRegressionContract,
  type IssueRegressionContractInput,
  type IssueRegressionResult,
  type RegressionRun,
} from "@shared/models/regression";
import type { Issue } from "@shared/schema";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db } from "../db";
import { fileIssueStorage } from "../file-storage/issues";
import { createLogger } from "../log";
import { resolvePlanByIdOrPage } from "../plan-service";
import { getCurrentPrincipal } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import { getVisibleEnvironment } from "../platforms/platform-access";

const log = createLogger("RegressionService");
const MAX_CANDIDATES = 500;
const MAX_HISTORY = 20;

const runScope = { scope: regressionRuns.scope, ownerUserId: regressionRuns.ownerUserId, accountId: regressionRuns.accountId };
const contractScope = { scope: issueRegressionContracts.scope, ownerUserId: issueRegressionContracts.ownerUserId, accountId: issueRegressionContracts.accountId };
const resultScope = { scope: issueRegressionResults.scope, ownerUserId: issueRegressionResults.ownerUserId, accountId: issueRegressionResults.accountId };

function principal() {
  const value = getCurrentPrincipal();
  if (!value?.userId || !value.accountId || value.actorType !== "user") {
    throw new Error("Regression operations require an explicit user principal");
  }
  return value;
}
function visible(columns: typeof runScope | typeof contractScope | typeof resultScope, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal(), columns, predicate);
}
function writable(columns: typeof runScope | typeof contractScope | typeof resultScope, predicate?: SQL): SQL {
  return combineWithWritableScope(principal(), columns, predicate);
}
function owned(columns: typeof runScope | typeof contractScope | typeof resultScope) {
  const current = principal();
  return { ...ownedInsertValues(current, columns), createdByUserId: current.userId };
}
function boundedIssueId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Issue ID must be a positive safe integer");
  return parsed;
}
function boundedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), max)) : fallback;
}

export type RegressionCandidateSnapshot = {
  snapshottedAt: string;
  environmentId: number;
  candidates: Array<{ issueId: number; title: string; issueStatus: string; contractVersion: number | null; contractState: "enabled" | "missing" | "invalid" }>;
  exclusions: Array<{ issueId: number; reasonCode: "environment_mismatch" | "not_applicable" | "resolved_without_contract"; reason: string }>;
};

function parseContract(row: IssueRegressionContract | null): { row: IssueRegressionContract | null; valid: boolean } {
  if (!row) return { row: null, valid: false };
  const parsed = issueRegressionContractInputSchema.safeParse({
    disposition: row.disposition,
    exclusionReason: row.exclusionReason,
    environmentIds: row.environmentIds,
    routePath: row.routePath,
    steps: row.steps,
    expectedOutcome: row.expectedOutcome,
    setupNotes: row.setupNotes,
  });
  return { row, valid: parsed.success };
}

async function contractsByIssueIds(issueIds: number[]): Promise<Map<number, IssueRegressionContract>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db.select().from(issueRegressionContracts).where(visible(contractScope, inArray(issueRegressionContracts.issueId, issueIds)));
  return new Map(rows.map((row) => [row.issueId, row]));
}

function classifyCandidate(issue: Issue, contract: IssueRegressionContract | undefined, environmentId: number) {
  const parsed = parseContract(contract || null);
  if (contract?.disposition === "not_applicable") {
    return { excluded: true as const, reasonCode: "not_applicable" as const, reason: contract.exclusionReason || "Explicitly not applicable" };
  }
  if (contract && Array.isArray(contract.environmentIds) && contract.environmentIds.length > 0 && !contract.environmentIds.includes(environmentId)) {
    return { excluded: true as const, reasonCode: "environment_mismatch" as const, reason: `Contract does not apply to environment ${environmentId}` };
  }
  if (issue.status === "resolved" && (!contract || contract.disposition !== "enabled")) {
    return { excluded: true as const, reasonCode: "resolved_without_contract" as const, reason: "Resolved issue has no enabled regression contract" };
  }
  return {
    excluded: false as const,
    contractState: !contract ? "missing" as const : parsed.valid ? "enabled" as const : "invalid" as const,
    contractVersion: contract?.version || null,
  };
}

export function deploymentRegressionTriggerKey(environmentId: number, deploymentId: string, revision: string): string {
  return ["deployment", environmentId, deploymentId.trim(), revision.trim().toLowerCase()].join(":");
}

export async function createRegressionRun(input: {
  triggerKey: string;
  environmentId: number;
  acceptedDeploymentId: string;
  acceptedRevision: string;
  lifecycleSnapshot: unknown;
  dueAt: Date;
  sourceWorkflowRunId?: string | null;
  acceptanceAttemptId?: number | null;
}): Promise<RegressionRun> {
  const triggerKey = z.string().trim().min(1).max(500).parse(input.triggerKey);
  const environmentId = z.number().int().positive().parse(input.environmentId);
  const deploymentId = z.string().trim().min(1).max(500).parse(input.acceptedDeploymentId);
  const revision = z.string().trim().min(1).max(200).parse(input.acceptedRevision).toLowerCase();
  if (!input.lifecycleSnapshot || typeof input.lifecycleSnapshot !== "object") throw new Error("Regression run requires an immutable lifecycle snapshot");
  if (!(input.dueAt instanceof Date) || !Number.isFinite(input.dueAt.getTime())) throw new Error("Regression run dueAt must be a valid Date");
  if (!await getVisibleEnvironment(environmentId)) throw new Error(`Environment ${environmentId} is not visible`);

  const runId = `reg_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const rows = await db.insert(regressionRuns).values({
    id: runId,
    triggerKey,
    environmentId,
    acceptedDeploymentId: deploymentId,
    acceptedRevision: revision,
    lifecycleSnapshot: input.lifecycleSnapshot,
    dueAt: input.dueAt,
    sourceWorkflowRunId: input.sourceWorkflowRunId || null,
    acceptanceAttemptId: input.acceptanceAttemptId || null,
    ...owned(runScope),
  }).onConflictDoNothing({ target: [regressionRuns.ownerUserId, regressionRuns.accountId, regressionRuns.triggerKey] }).returning();
  if (rows[0]) {
    log.info("regression.run.enqueued", { runId: rows[0].id, environmentId, deploymentId, revision });
    return rows[0];
  }
  const [existing] = await db.select().from(regressionRuns).where(visible(runScope, eq(regressionRuns.triggerKey, triggerKey))).limit(1);
  if (!existing) throw new Error("Regression run conflict did not resolve to a visible run");
  if (existing.status === "queued" && existing.dueAt.getTime() > input.dueAt.getTime()) {
    const [accelerated] = await db.update(regressionRuns).set({ dueAt: input.dueAt, updatedAt: new Date() })
      .where(writable(runScope, and(eq(regressionRuns.id, existing.id), eq(regressionRuns.status, "queued"))))
      .returning();
    if (accelerated) return accelerated;
  }
  const workflowAttribution = existing.sourceWorkflowRunId === null && input.sourceWorkflowRunId
    ? { sourceWorkflowRunId: input.sourceWorkflowRunId, acceptanceAttemptId: input.acceptanceAttemptId || null, updatedAt: new Date() }
    : null;
  if (workflowAttribution) {
    const [attributed] = await db.update(regressionRuns).set(workflowAttribution)
      .where(writable(runScope, and(eq(regressionRuns.id, existing.id), sql`${regressionRuns.sourceWorkflowRunId} IS NULL`)))
      .returning();
    if (attributed) return attributed;
  }
  return existing;
}

export async function getRegressionRun(runId: string): Promise<RegressionRun | null> {
  const [run] = await db.select().from(regressionRuns).where(visible(runScope, eq(regressionRuns.id, runId.trim()))).limit(1);
  return run || null;
}

export async function listRegressionCandidates(runId: string): Promise<RegressionCandidateSnapshot> {
  const run = await getRegressionRun(runId);
  if (!run) throw new Error(`Regression run not found: ${runId}`);
  if (run.candidateSnapshot) return run.candidateSnapshot as RegressionCandidateSnapshot;

  const issues = (await fileIssueStorage.getIssues()) as Issue[];
  if (issues.length > MAX_CANDIDATES) throw new Error(`Regression candidate budget exceeded: ${issues.length} issues (max ${MAX_CANDIDATES})`);
  const contracts = await contractsByIssueIds(issues.map((issue) => issue.id));
  const snapshot: RegressionCandidateSnapshot = { snapshottedAt: new Date().toISOString(), environmentId: run.environmentId, candidates: [], exclusions: [] };
  for (const issue of issues) {
    const classification = classifyCandidate(issue, contracts.get(issue.id), run.environmentId);
    if (classification.excluded) {
      snapshot.exclusions.push({ issueId: issue.id, reasonCode: classification.reasonCode, reason: classification.reason.slice(0, 1_000) });
    } else {
      snapshot.candidates.push({ issueId: issue.id, title: issue.title.slice(0, 500), issueStatus: issue.status, contractVersion: classification.contractVersion, contractState: classification.contractState });
    }
  }

  return db.transaction(async (tx) => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.REGRESSION_RUN, run.id);
    const [locked] = await tx.select().from(regressionRuns).where(writable(runScope, eq(regressionRuns.id, run.id))).limit(1);
    if (!locked) throw new Error(`Regression run not writable: ${run.id}`);
    if (locked.candidateSnapshot) return locked.candidateSnapshot as RegressionCandidateSnapshot;
    await tx.update(regressionRuns).set({ candidateSnapshot: snapshot, updatedAt: new Date() }).where(writable(runScope, eq(regressionRuns.id, run.id)));
    log.info("regression.candidates.snapshotted", { runId: run.id, candidateCount: snapshot.candidates.length, exclusionCount: snapshot.exclusions.length });
    return snapshot;
  });
}

export async function getIssueRegressionContract(issueIdInput: unknown): Promise<IssueRegressionContract | null> {
  const issueId = boundedIssueId(issueIdInput);
  const [row] = await db.select().from(issueRegressionContracts).where(visible(contractScope, eq(issueRegressionContracts.issueId, issueId))).limit(1);
  return row || null;
}

export async function upsertIssueRegressionContract(issueIdInput: unknown, input: IssueRegressionContractInput): Promise<IssueRegressionContract> {
  const issueId = boundedIssueId(issueIdInput);
  const issue = await fileIssueStorage.getIssue(issueId);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);
  const parsed = issueRegressionContractInputSchema.parse(input);
  for (const environmentId of parsed.environmentIds) {
    if (!await getVisibleEnvironment(environmentId)) throw new Error(`Environment ${environmentId} is not visible`);
  }

  return db.transaction(async (tx) => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.REGRESSION_CONTRACT, `${principal().accountId}:${issueId}`);
    const [existing] = await tx.select().from(issueRegressionContracts).where(visible(contractScope, eq(issueRegressionContracts.issueId, issueId))).limit(1);
    if (existing) {
      const [updated] = await tx.update(issueRegressionContracts).set({
        disposition: parsed.disposition,
        exclusionReason: parsed.disposition === "not_applicable" ? parsed.exclusionReason : null,
        environmentIds: parsed.environmentIds,
        routePath: parsed.disposition === "enabled" ? parsed.routePath : null,
        steps: parsed.disposition === "enabled" ? parsed.steps : [],
        expectedOutcome: parsed.disposition === "enabled" ? parsed.expectedOutcome : null,
        setupNotes: parsed.setupNotes || null,
        version: existing.version + 1,
        updatedAt: new Date(),
      }).where(writable(contractScope, eq(issueRegressionContracts.id, existing.id))).returning();
      if (!updated) throw new Error(`Regression contract not writable for issue ${issueId}`);
      log.info("regression.contract.updated", { issueId, contractId: updated.id, version: updated.version, disposition: updated.disposition });
      return updated;
    }
    const [created] = await tx.insert(issueRegressionContracts).values({
      issueId,
      disposition: parsed.disposition,
      exclusionReason: parsed.disposition === "not_applicable" ? parsed.exclusionReason : null,
      environmentIds: parsed.environmentIds,
      routePath: parsed.disposition === "enabled" ? parsed.routePath : null,
      steps: parsed.disposition === "enabled" ? parsed.steps : [],
      expectedOutcome: parsed.disposition === "enabled" ? parsed.expectedOutcome : null,
      setupNotes: parsed.setupNotes || null,
      ...owned(contractScope),
    }).returning();
    log.info("regression.contract.created", { issueId, contractId: created.id, version: created.version, disposition: created.disposition });
    return created;
  });
}

export async function getRegressionIssue(runId: string, issueIdInput: unknown) {
  const issueId = boundedIssueId(issueIdInput);
  const [run, issue, contract, results] = await Promise.all([
    getRegressionRun(runId),
    fileIssueStorage.getIssue(issueId),
    getIssueRegressionContract(issueId),
    getRegressionResults({ runId, issueId, limit: MAX_HISTORY }),
  ]);
  if (!run) throw new Error(`Regression run not found: ${runId}`);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);
  const snapshot = await listRegressionCandidates(runId);
  const candidate = snapshot.candidates.find((item) => item.issueId === issueId) || null;
  const exclusion = snapshot.exclusions.find((item) => item.issueId === issueId) || null;
  return { run, issue, contract, contractValid: parseContract(contract).valid, candidate, exclusion, latestResult: results[0] || null, resultHistory: results };
}

const appendResultSchema = z.object({
  runId: z.string().trim().min(1).max(100),
  issueId: z.number().int().positive(),
  status: regressionResultStatusSchema,
  reasonCode: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(2_000),
  planId: z.string().trim().max(100).nullable().optional(),
  planStepId: z.string().trim().max(100).nullable().optional(),
  sessionId: z.string().trim().max(100).nullable().optional(),
  contractVersion: z.number().int().positive().nullable().optional(),
  actionTrace: z.array(z.record(z.unknown())).max(20).default([]),
  assertions: z.array(z.record(z.unknown())).max(20).default([]),
  screenshots: z.array(z.object({ path: z.string().trim().min(1).max(500), width: z.number().int().positive(), height: z.number().int().positive(), truncated: z.boolean() }).strict()).max(3).default([]),
  browserEvidence: z.record(z.unknown()).default({}),
}).strict();
export type AppendRegressionResultInput = z.input<typeof appendResultSchema>;

export async function appendRegressionResult(input: AppendRegressionResultInput): Promise<IssueRegressionResult> {
  const parsed = appendResultSchema.parse(input);
  const run = await getRegressionRun(parsed.runId);
  if (!run) throw new Error(`Regression run not found: ${parsed.runId}`);
  const snapshot = await listRegressionCandidates(run.id);
  if (!snapshot.candidates.some((candidate) => candidate.issueId === parsed.issueId)) {
    throw new Error(`Issue ${parsed.issueId} is not a candidate in regression run ${run.id}`);
  }
  if (parsed.planId && run.planId && parsed.planId !== run.planId) throw new Error(`Result Plan ${parsed.planId} does not match regression run Plan ${run.planId}`);

  const rows = await db.transaction(async (tx) => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.REGRESSION_RESULT, `${run.id}:${parsed.issueId}`);
    const inserted = await tx.insert(issueRegressionResults).values({
      regressionRunId: run.id,
      issueId: parsed.issueId,
      status: parsed.status,
      reasonCode: parsed.reasonCode,
      planId: run.planId || parsed.planId || null,
      planStepId: parsed.planStepId || null,
      environmentId: run.environmentId,
      deploymentId: run.acceptedDeploymentId,
      revision: run.acceptedRevision,
      sessionId: parsed.sessionId || null,
      contractVersion: parsed.contractVersion || null,
      summary: parsed.summary,
      actionTrace: parsed.actionTrace,
      assertions: parsed.assertions,
      screenshots: parsed.screenshots,
      browserEvidence: parsed.browserEvidence,
      ...owned(resultScope),
    }).onConflictDoNothing({ target: [issueRegressionResults.ownerUserId, issueRegressionResults.accountId, issueRegressionResults.regressionRunId, issueRegressionResults.issueId] }).returning();
    if (inserted[0]) return inserted[0];
    const [existing] = await tx.select().from(issueRegressionResults).where(visible(resultScope, and(eq(issueRegressionResults.regressionRunId, run.id), eq(issueRegressionResults.issueId, parsed.issueId)))).limit(1);
    if (!existing) throw new Error("Regression result conflict did not resolve to a visible row");
    return existing;
  });
  await reconcileRegressionRunStatus(run.id);
  log.info("regression.issue.result", { runId: run.id, issueId: parsed.issueId, resultId: rows.id, status: rows.status, reasonCode: rows.reasonCode });
  return rows;
}

export async function getRegressionResults(filters: { runId?: string; issueId?: number; limit?: number } = {}): Promise<IssueRegressionResult[]> {
  const clauses: SQL[] = [];
  if (filters.runId) clauses.push(eq(issueRegressionResults.regressionRunId, filters.runId));
  if (filters.issueId) clauses.push(eq(issueRegressionResults.issueId, boundedIssueId(filters.issueId)));
  const predicate = clauses.length > 0 ? and(...clauses) : undefined;
  return db.select().from(issueRegressionResults).where(visible(resultScope, predicate)).orderBy(desc(issueRegressionResults.createdAt), desc(issueRegressionResults.id)).limit(boundedLimit(filters.limit, MAX_HISTORY, 100));
}

export async function associateRegressionPlan(runId: string, planIdInput: string): Promise<RegressionRun> {
  const plan = await resolvePlanByIdOrPage(planIdInput.trim());
  if (!plan) throw new Error(`Plan not found: ${planIdInput}`);
  return db.transaction(async (tx) => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.REGRESSION_RUN, runId);
    const [run] = await tx.select().from(regressionRuns).where(writable(runScope, eq(regressionRuns.id, runId))).limit(1);
    if (!run) throw new Error(`Regression run not found or not writable: ${runId}`);
    if (run.planId && run.planId !== plan.id) throw new Error(`Regression run ${runId} is already associated with Plan ${run.planId}`);
    if (run.planId === plan.id) return run;
    const [updated] = await tx.update(regressionRuns).set({ planId: plan.id, status: "planning", updatedAt: new Date() }).where(writable(runScope, eq(regressionRuns.id, runId))).returning();
    log.info("regression.plan.associated", { runId, planId: plan.id });
    return updated;
  });
}

export async function reconcileRegressionRunStatus(runId: string): Promise<RegressionRun> {
  const run = await getRegressionRun(runId);
  if (!run) throw new Error(`Regression run not found: ${runId}`);
  const snapshot = await listRegressionCandidates(runId);
  const results = await getRegressionResults({ runId, limit: MAX_CANDIDATES });
  let status = run.status;
  if (snapshot.candidates.length === 0) status = "completed";
  else if (results.some((result) => result.status === "failed")) status = "failed";
  else if (results.length >= snapshot.candidates.length && results.some((result) => result.status === "blocked")) status = "partial";
  else if (results.length >= snapshot.candidates.length && results.every((result) => result.status === "passed")) status = "completed";
  else if (results.length > 0) status = "executing";
  const terminal = ["completed", "partial", "failed", "skipped"].includes(status);
  const [updated] = await db.update(regressionRuns).set({ status, completedAt: terminal ? new Date() : null, updatedAt: new Date() }).where(writable(runScope, eq(regressionRuns.id, runId))).returning();
  if (!updated) throw new Error(`Regression run not writable: ${runId}`);
  return updated;
}
