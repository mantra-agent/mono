import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { accounts, users } from "@shared/schema";
import { platformProductEnvironments, platformProducts, platforms } from "@shared/models/platforms";
import { db } from "../db";
import { getLatestDeploymentByToken } from "../integrations/railway/client";
import { createLogger } from "../log";
import { getUserEffectivePermissions } from "../permissions";
import { createNamedSystemPrincipal, createUserPrincipalFromUser } from "../principal";
import { getCurrentPrincipal, runWithPrincipal } from "../principal-context";
import { resolvePlatformEnvironment } from "../platform-environment-resolver";
import { snapshotEnvironmentBuildLifecycle } from "../platforms/build-lifecycle-service";
import { getRuntimeIdentity } from "../runtime-identity";
import { createRegressionRun, deploymentRegressionTriggerKey, getRegressionRun } from "./regression-service";

const log = createLogger("RegressionAdmission");
const SUCCESS_STATUSES = new Set(["SUCCESS"]);

export type RegressionAdmissionMode = "deployment" | "manual";

async function latestSuccessfulDeployment(environmentId: number) {
  const resolved = await resolvePlatformEnvironment(environmentId);
  if (!resolved) throw new Error(`Environment ${environmentId} has no Railway hosting binding`);
  const latest = await getLatestDeploymentByToken(
    resolved.credential,
    resolved.providerConfiguration.projectId,
    resolved.providerConfiguration.serviceId,
    resolved.providerConfiguration.environmentId,
  );
  if (!latest) throw new Error(`Environment ${environmentId} has no deployment`);
  if (!SUCCESS_STATUSES.has(latest.status.trim().toUpperCase())) {
    throw new Error(`Latest deployment ${latest.id} is not successful (${latest.status})`);
  }
  const revision = latest.commitHash?.trim().toLowerCase();
  if (!revision) throw new Error(`Successful deployment ${latest.id} has no source revision`);
  return { deployment: latest, revision };
}

export async function admitRegressionRun(input: {
  mode: RegressionAdmissionMode;
  environmentId?: number;
  expectedRevision?: string | null;
}) {
  const current = getCurrentPrincipal();
  if (!current?.userId || !current.accountId || current.actorType !== "user") {
    throw new Error("Regression admission requires an explicit user principal");
  }
  const runtime = await getRuntimeIdentity();
  const environmentId = input.environmentId ?? runtime.platformEnvironmentId;
  if (!environmentId) throw new Error("Regression environment is required outside a bound runtime");

  const lifecycleSnapshot = await snapshotEnvironmentBuildLifecycle(environmentId);
  const { deployment, revision } = await latestSuccessfulDeployment(environmentId);
  const expectedRevision = input.expectedRevision?.trim().toLowerCase();
  if (expectedRevision && expectedRevision !== revision) {
    throw new Error(`Latest successful deployment revision ${revision} does not match expected runtime revision ${expectedRevision}`);
  }

  const triggerKey = input.mode === "deployment"
    ? deploymentRegressionTriggerKey(environmentId, deployment.id, revision)
    : `manual:${environmentId}:${deployment.id}:${revision}:${Date.now()}:${crypto.randomUUID()}`;
  const run = await createRegressionRun({
    triggerKey,
    environmentId,
    acceptedDeploymentId: deployment.id,
    acceptedRevision: revision,
    lifecycleSnapshot,
    dueAt: new Date(),
  });
  log.info("regression.admitted", {
    mode: input.mode,
    runId: run.id,
    environmentId,
    deploymentId: deployment.id,
    revision,
  });
  return run;
}

async function runtimeEnvironmentOwner(environmentId: number) {
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
    const owner = await runtimeEnvironmentOwner(runtime.platformEnvironmentId);
    return runWithPrincipal(owner, async () => {
      const run = await admitRegressionRun({
        mode: "deployment",
        environmentId: runtime.platformEnvironmentId!,
        expectedRevision: runtime.gitCommit,
      });
      return {
        outcome: "admitted" as const,
        runId: run.id,
        environmentId: run.environmentId,
        deploymentId: run.acceptedDeploymentId,
        revision: run.acceptedRevision,
      };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.debug("regression.runtime_admission.not_ready", {
      environmentId: runtime.platformEnvironmentId,
      revision: runtime.gitCommit,
      reason,
    });
    return { outcome: "not_ready", reason };
  }
}
