import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { accounts, users } from "@shared/schema";
import { platformProductEnvironments, platformProducts, platforms } from "@shared/models/platforms";
import { db } from "../db";
import { extractDeploymentMeta, fetchDeploymentsForEnvironment } from "../integrations/railway/client";
import { createLogger } from "../log";
import { getUserEffectivePermissions } from "../permissions";
import { createNamedSystemPrincipal, createUserPrincipalFromUser } from "../principal";
import { getCurrentPrincipal, runWithPrincipal } from "../principal-context";
import { resolvePlatformEnvironment } from "../platform-environment-resolver";
import { snapshotEnvironmentBuildLifecycle } from "../platforms/build-lifecycle-service";
import { getRuntimeIdentity } from "../runtime-identity";
import { createRegressionRun, deploymentRegressionTriggerKey, getRegressionRun } from "./regression-service";

const log = createLogger("RegressionAdmission");
const DEPLOYMENT_LOOKBACK = 20;

export type RegressionAdmissionMode = "deployment" | "manual";

type DeploymentSnapshot = {
  id: string;
  revision: string;
  lifecycleSnapshot: Record<string, unknown>;
};

function normalizeRevision(value: string): string {
  return value.trim().toLowerCase();
}

function snapshotEnvironmentId(snapshot: Record<string, unknown>): number | null {
  const environment = snapshot.environment;
  if (!environment || typeof environment !== "object") return null;
  const id = Number((environment as Record<string, unknown>).id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function latestSuccessfulDeployment(environmentId: number, expectedRevision?: string | null) {
  const resolved = await resolvePlatformEnvironment(environmentId);
  if (!resolved) throw new Error(`Environment ${environmentId} has no Railway hosting binding`);
  const deployments = await fetchDeploymentsForEnvironment(
    resolved.providerConfiguration.projectId,
    resolved.providerConfiguration.serviceId,
    resolved.providerConfiguration.environmentId,
    DEPLOYMENT_LOOKBACK,
    resolved.credential,
  );
  const expected = expectedRevision ? normalizeRevision(expectedRevision) : null;
  for (const deployment of deployments) {
    if (deployment.status.trim().toUpperCase() !== "SUCCESS") continue;
    const revision = normalizeRevision(extractDeploymentMeta(deployment.meta).commitHash || "");
    if (!revision || (expected && revision !== expected)) continue;
    return { deployment, revision };
  }
  if (expected) {
    throw new Error(`No successful deployment in the latest ${DEPLOYMENT_LOOKBACK} matches runtime revision ${expected}`);
  }
  throw new Error(`Environment ${environmentId} has no successful deployment in the latest ${DEPLOYMENT_LOOKBACK}`);
}

export async function admitRegressionRun(input: {
  mode: RegressionAdmissionMode;
  environmentId?: number;
  expectedRevision?: string | null;
  deployment?: DeploymentSnapshot;
  dueAt?: Date;
  sourceWorkflowRunId?: string | null;
  acceptanceAttemptId?: number | null;
}) {
  const current = getCurrentPrincipal();
  if (!current?.userId || !current.accountId || current.actorType !== "user") {
    throw new Error("Regression admission requires an explicit user principal");
  }
  const runtime = await getRuntimeIdentity();
  const environmentId = input.environmentId ?? runtime.platformEnvironmentId;
  if (!environmentId) throw new Error("Regression environment is required outside a bound runtime");
  const visibleEnvironment = await import("../platforms/platform-access").then(({ getVisibleEnvironment }) => getVisibleEnvironment(environmentId));
  if (!visibleEnvironment) throw new Error(`Environment ${environmentId} is not visible`);

  let deployment: DeploymentSnapshot;
  if (input.deployment) {
    if (input.expectedRevision && normalizeRevision(input.expectedRevision) !== normalizeRevision(input.deployment.revision)) {
      throw new Error("Regression deployment revision does not match the expected revision");
    }
    const lifecycleEnvironmentId = snapshotEnvironmentId(input.deployment.lifecycleSnapshot);
    if (lifecycleEnvironmentId !== environmentId) {
      throw new Error(`Regression lifecycle snapshot environment ${lifecycleEnvironmentId ?? "unknown"} does not match ${environmentId}`);
    }
    deployment = {
      id: input.deployment.id.trim(),
      revision: normalizeRevision(input.deployment.revision),
      lifecycleSnapshot: input.deployment.lifecycleSnapshot,
    };
  } else {
    const [lifecycleSnapshot, latest] = await Promise.all([
      snapshotEnvironmentBuildLifecycle(environmentId),
      latestSuccessfulDeployment(environmentId, input.expectedRevision),
    ]);
    deployment = {
      id: latest.deployment.id,
      revision: latest.revision,
      lifecycleSnapshot,
    };
  }
  if (!deployment.id || !deployment.revision) throw new Error("Regression deployment identity is incomplete");

  const dueAt = input.dueAt ?? new Date();
  const triggerKey = input.mode === "deployment"
    ? deploymentRegressionTriggerKey(environmentId, deployment.id, deployment.revision)
    : `manual:${environmentId}:${deployment.id}:${deployment.revision}:${Date.now()}:${crypto.randomUUID()}`;
  const run = await createRegressionRun({
    triggerKey,
    environmentId,
    acceptedDeploymentId: deployment.id,
    acceptedRevision: deployment.revision,
    lifecycleSnapshot: deployment.lifecycleSnapshot,
    dueAt,
    sourceWorkflowRunId: input.sourceWorkflowRunId,
    acceptanceAttemptId: input.acceptanceAttemptId,
  });
  log.info("regression.admitted", {
    mode: input.mode,
    runId: run.id,
    environmentId,
    deploymentId: deployment.id,
    revision: deployment.revision,
  });
  return run;
}

async function environmentOwnerPrincipal(environmentId: number) {
  if (!Number.isInteger(environmentId) || environmentId <= 0) {
    throw new Error("Regression Environment ID must be a positive integer");
  }
  const systemPrincipal = createNamedSystemPrincipal("regression-runtime-admission", ["system:read"]);
  return runWithPrincipal(systemPrincipal, async () => {
    const [row] = await db.select({ platform: platforms, user: users, account: accounts })
      .from(platformProductEnvironments)
      .innerJoin(platformProducts, eq(platformProducts.id, platformProductEnvironments.productId))
      .innerJoin(platforms, eq(platforms.id, platformProducts.platformId))
      .innerJoin(users, eq(users.id, platforms.ownerUserId))
      .innerJoin(accounts, and(
        eq(accounts.id, platforms.accountId),
        eq(accounts.kind, "personal"),
        eq(accounts.ownerUserId, platforms.ownerUserId),
      ))
      .where(and(
        eq(platformProductEnvironments.id, environmentId),
        eq(platforms.scope, "user"),
      ))
      .limit(1);
    if (!row?.platform.ownerUserId || !row.platform.accountId) {
      throw new Error(`Runtime environment ${environmentId} has no user-owned Platform principal`);
    }
    return {
      ...createUserPrincipalFromUser(row.user, row.account.id),
      permissions: await getUserEffectivePermissions(row.user.id),
    };
  });
}

export async function admitDeploymentRegressionForEnvironmentOwner(input: {
  environmentId: number;
  deploymentId?: string | null;
  revision?: string | null;
  lifecycleSnapshot?: Record<string, unknown> | null;
  expectedRevision?: string | null;
  dueAt?: Date;
  sourceWorkflowRunId?: string | null;
  acceptanceAttemptId?: number | null;
}) {
  const hasDeploymentIdentity = Boolean(input.deploymentId || input.revision);
  if (hasDeploymentIdentity && (!input.deploymentId || !input.revision)) {
    throw new Error("Deployment admission requires both deploymentId and revision");
  }
  const owner = await environmentOwnerPrincipal(input.environmentId);
  return runWithPrincipal(owner, async () => {
    let deployment: DeploymentSnapshot | undefined;
    if (input.deploymentId && input.revision) {
      deployment = {
        id: input.deploymentId,
        revision: input.revision,
        lifecycleSnapshot: input.lifecycleSnapshot ?? await snapshotEnvironmentBuildLifecycle(input.environmentId),
      };
    }
    return admitRegressionRun({
      mode: "deployment",
      environmentId: input.environmentId,
      expectedRevision: input.expectedRevision,
      deployment,
      dueAt: input.dueAt,
      sourceWorkflowRunId: input.sourceWorkflowRunId,
      acceptanceAttemptId: input.acceptanceAttemptId,
    });
  });
}

export async function startManualRegression(input: { environmentId?: number; wait?: boolean } = {}) {
  const run = await admitRegressionRun({ mode: "manual", environmentId: input.environmentId });
  const { dispatchDueRegressionRuns } = await import("./regression-dispatcher");
  const claimed = await dispatchDueRegressionRuns({ runId: run.id, wait: input.wait !== false });
  if (claimed === 0) throw new Error(`Regression run ${run.id} was admitted but could not be claimed`);
  return await getRegressionRun(run.id) || run;
}

export async function reconcileRunningDeploymentRegression(): Promise<
  | { outcome: "not_bound" | "not_ready"; reason: string }
  | { outcome: "admitted"; runId: string; environmentId: number; deploymentId: string; revision: string }
> {
  const runtime = await getRuntimeIdentity();
  if (!runtime.platformEnvironmentId || !runtime.gitCommit) {
    return { outcome: "not_bound", reason: "runtime deployment identity is incomplete" };
  }
  try {
    const run = await admitDeploymentRegressionForEnvironmentOwner({
      environmentId: runtime.platformEnvironmentId,
      expectedRevision: runtime.gitCommit,
    });
    return {
      outcome: "admitted",
      runId: run.id,
      environmentId: run.environmentId,
      deploymentId: run.acceptedDeploymentId,
      revision: run.acceptedRevision,
    };
  } catch (error) {
    const errorType = error instanceof Error ? error.name : typeof error;
    log.debug("regression.runtime_admission.not_ready", {
      environmentId: runtime.platformEnvironmentId,
      revision: runtime.gitCommit,
      errorType,
    });
    return { outcome: "not_ready", reason: "deployment truth is not ready for Regression admission" };
  }
}
