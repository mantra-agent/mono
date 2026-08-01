import { and, eq, inArray, or, sql } from "drizzle-orm";
import { accounts, users } from "@shared/schema";
import { regressionRuns } from "@shared/models/regression";
import { db } from "../db";
import { createLogger } from "../log";
import { createUserPrincipalFromUser } from "../principal";
import { getUserEffectivePermissions } from "../permissions";
import { runWithPrincipal } from "../principal-context";
import { getPlanSteps } from "../plan-service";
import { executeAutonomousSkillRun } from "../autonomous-skill-runner";
import { CANONICAL_REGRESSION_SKILL_ID } from "../skill-identities";
import { getRegressionRun, listRegressionCandidates, reconcileRegressionRunStatus } from "./regression-service";

const log = createLogger("RegressionDispatcher");
const CLAIM_LIMIT = 1;
const CLAIM_STALE_MS = 35 * 60 * 1000;
const TERMINAL_STATUSES = ["completed", "partial", "failed", "skipped"] as const;

type DispatchableRun = typeof regressionRuns.$inferSelect;

async function claimDueRuns(runId?: string): Promise<DispatchableRun[]> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  return db.transaction(async (tx) => {
    const duePredicate = or(
      and(eq(regressionRuns.status, "queued"), sql`${regressionRuns.dueAt} <= ${now}`),
      and(eq(regressionRuns.status, "claimed"), sql`${regressionRuns.claimedAt} < ${staleBefore}`),
    );
    const due = await tx.select().from(regressionRuns).where(
      runId ? and(eq(regressionRuns.id, runId), duePredicate) : duePredicate,
    ).orderBy(regressionRuns.dueAt).limit(CLAIM_LIMIT).for("update", { skipLocked: true });
    const claimed: DispatchableRun[] = [];
    for (const run of due) {
      const [updated] = await tx.update(regressionRuns).set({
        status: "claimed",
        claimedAt: now,
        updatedAt: now,
      }).where(and(
        eq(regressionRuns.id, run.id),
        inArray(regressionRuns.status, ["queued", "claimed"]),
      )).returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

async function restoreOwner(run: DispatchableRun) {
  const [identity] = await db.select({ user: users }).from(users).innerJoin(
    accounts,
    and(eq(accounts.id, run.accountId), eq(accounts.kind, "personal"), eq(accounts.ownerUserId, run.ownerUserId)),
  ).where(eq(users.id, run.ownerUserId)).limit(1);
  if (!identity) throw new Error(`Regression run owner/account identity is no longer valid for ${run.id}`);
  return {
    ...createUserPrincipalFromUser(identity.user, run.accountId),
    permissions: await getUserEffectivePermissions(identity.user.id),
  };
}

async function markLaunchFailure(run: DispatchableRun, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.update(regressionRuns).set({
    status: "failed",
    failureContext: { reason: "skill_launch_failed", message: message.slice(0, 1_000) },
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(regressionRuns.id, run.id),
    inArray(regressionRuns.status, ["claimed", "planning", "executing"]),
  ));
  log.error("regression.dispatch.failed", { runId: run.id, reasonCode: "skill_launch_failed" });
}

async function launchClaimedRun(run: DispatchableRun): Promise<void> {
  try {
    const principal = await restoreOwner(run);
    await runWithPrincipal(principal, async () => {
      const result = await executeAutonomousSkillRun(CANONICAL_REGRESSION_SKILL_ID, {
        preContext: `Regression run ID: ${run.id}`,
        coordinationKey: `regression:${run.id}`,
        spawnReason: `regression:${run.id}`,
        spawnerTool: "regression-dispatcher",
        sessionKeyOverride: `regression:${run.id}`,
        titleOverride: `Regression ${run.acceptedRevision.slice(0, 8)}`,
        personaName: "Engineer",
        admissionTier: "background",
        workflowRunId: run.sourceWorkflowRunId || undefined,
        workflowStageAttemptId: run.acceptanceAttemptId || undefined,
        onSessionCreated: async (sessionId) => {
          await db.update(regressionRuns).set({
            skillSessionId: sessionId,
            startedAt: new Date(),
            updatedAt: new Date(),
          }).where(and(eq(regressionRuns.id, run.id), eq(regressionRuns.status, "claimed")));
          log.info("regression.skill.launched", { runId: run.id, sessionId });
        },
      });
      if (!result) throw new Error("Regression skill launch was deduplicated without a durable session result");
      if (result.status === "failed" || result.status === "yielded") {
        throw new Error(result.error || `Regression skill ended ${result.status}`);
      }
      const current = await getRegressionRun(run.id);
      if (!current) throw new Error(`Regression run disappeared after skill execution: ${run.id}`);
      const candidates = await listRegressionCandidates(run.id);
      if (current.planId) {
        const steps = await getPlanSteps(current.planId);
        if (steps.length !== candidates.candidates.length) {
          throw new Error(`Regression Plan step mismatch: expected ${candidates.candidates.length}, found ${steps.length}`);
        }
      } else if (candidates.candidates.length > 0) {
        throw new Error("Regression skill completed without associating a Plan");
      }
      const reconciled = await reconcileRegressionRunStatus(run.id);
      if (TERMINAL_STATUSES.includes(reconciled.status as typeof TERMINAL_STATUSES[number])) return;
      throw new Error(`Regression skill ended without terminal durable results: ${reconciled.status}`);
    });
  } catch (error) {
    await markLaunchFailure(run, error);
  }
}

export async function dispatchDueRegressionRuns(options: { runId?: string; wait?: boolean } = {}): Promise<number> {
  const runs = await claimDueRuns(options.runId);
  if (runs.length === 0) return 0;
  const launches = runs.map(launchClaimedRun);
  if (options.wait === false) {
    for (const launch of launches) void launch;
  } else {
    await Promise.all(launches);
  }
  return runs.length;
}
