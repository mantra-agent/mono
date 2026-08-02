import { and, desc, eq, isNull } from "drizzle-orm";
import {
  buildDeploymentHomeProjections,
  platformDeploymentObservations,
} from "@shared/schema";
import type { Principal } from "../principal";
import {
  ADVISORY_LOCK_NS,
  acquireAdvisoryTransactionLock,
  db,
  runWithDatabaseTransaction,
} from "../db";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
  type ScopeColumns,
} from "../scoped-storage";
import { hasActiveBuildAccess } from "./build-access";

const observationScope: ScopeColumns = {
  scope: platformDeploymentObservations.scope,
  ownerUserId: platformDeploymentObservations.ownerUserId,
  accountId: platformDeploymentObservations.accountId,
};
const projectionScope: ScopeColumns = {
  scope: buildDeploymentHomeProjections.scope,
  ownerUserId: buildDeploymentHomeProjections.ownerUserId,
  accountId: buildDeploymentHomeProjections.accountId,
};

const MAX_DEPLOYMENTS_PER_OBSERVATION = 20;
const MAX_HOME_DEPLOYMENT_ITEMS = 100;

export interface SuccessfulRailwayDeploymentObservation {
  providerDeploymentId: string;
  deployedAt: Date;
  commitSha: string | null;
}

export interface BuildDeploymentEnvironmentIdentity {
  platformEnvironmentId: number;
  platformName: string;
  productName: string;
  environmentName: string;
}

export interface BuildDeploymentHomeItemRecord {
  projectionId: string;
  observationId: string;
  reasonKey: string;
  platformEnvironmentId: number;
  providerDeploymentId: string;
  deploymentState: "SUCCESS";
  platformName: string;
  productName: string;
  environmentName: string;
  commitSha: string | null;
  deployedAt: Date;
  observedAt: Date;
}

function requireOwner(principal: Principal): { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Build deployment persistence requires an explicit user+account principal");
  }
  return { userId: principal.userId, accountId: principal.accountId };
}

function boundedText(value: string, max: number): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) return null;
  return normalized;
}

function deploymentReasonKey(environmentId: number, providerDeploymentId: string): string {
  return `build:railway-deployment:${environmentId}:${providerDeploymentId}`;
}

/**
 * Persist successful provider evidence and its Home projection under the same
 * account+Build lock used by lifecycle transitions. Railway I/O happens before
 * this boundary; active Build is rechecked inside the short transaction.
 */
export async function recordSuccessfulRailwayDeployments(
  principal: Principal,
  environment: BuildDeploymentEnvironmentIdentity,
  deployments: SuccessfulRailwayDeploymentObservation[],
): Promise<{ observationsCreated: number; projectionsCreated: number }> {
  const owner = requireOwner(principal);
  const platformName = boundedText(environment.platformName, 200);
  const productName = boundedText(environment.productName, 200);
  const environmentName = boundedText(environment.environmentName, 200);
  if (!Number.isInteger(environment.platformEnvironmentId) || environment.platformEnvironmentId <= 0) {
    throw new Error("platformEnvironmentId must be a positive integer");
  }
  if (!platformName || !productName || !environmentName) {
    throw new Error("Platform, product, and environment names must be 1-200 characters");
  }

  const canonicalDeployments = deployments.slice(0, MAX_DEPLOYMENTS_PER_OBSERVATION).flatMap((deployment) => {
    const providerDeploymentId = boundedText(deployment.providerDeploymentId, 200);
    const commitSha = deployment.commitSha ? boundedText(deployment.commitSha, 200) : null;
    if (!providerDeploymentId || Number.isNaN(deployment.deployedAt.getTime())) return [];
    return [{ providerDeploymentId, commitSha, deployedAt: deployment.deployedAt }];
  });
  if (canonicalDeployments.length === 0) return { observationsCreated: 0, projectionsCreated: 0 };

  return db.transaction((tx) => runWithDatabaseTransaction(tx, async () => {
    await acquireAdvisoryTransactionLock(
      tx,
      ADVISORY_LOCK_NS.MOD_LIFECYCLE,
      `${owner.accountId}:build`,
    );
    if (!(await hasActiveBuildAccess(principal))) {
      return { observationsCreated: 0, projectionsCreated: 0 };
    }

    let observationsCreated = 0;
    let projectionsCreated = 0;
    for (const deployment of canonicalDeployments) {
      const [insertedObservation] = await tx
        .insert(platformDeploymentObservations)
        .values({
          platformEnvironmentId: environment.platformEnvironmentId,
          provider: "railway",
          providerDeploymentId: deployment.providerDeploymentId,
          deploymentState: "SUCCESS",
          platformName,
          productName,
          environmentName,
          commitSha: deployment.commitSha,
          deployedAt: deployment.deployedAt,
          ...ownedInsertValues(principal, observationScope),
          createdByUserId: owner.userId,
        })
        .onConflictDoNothing()
        .returning({ id: platformDeploymentObservations.id });

      const observationId = insertedObservation?.id ?? (await tx
        .select({ id: platformDeploymentObservations.id })
        .from(platformDeploymentObservations)
        .where(combineWithVisibleScope(
          principal,
          observationScope,
          and(
            eq(platformDeploymentObservations.platformEnvironmentId, environment.platformEnvironmentId),
            eq(platformDeploymentObservations.provider, "railway"),
            eq(platformDeploymentObservations.providerDeploymentId, deployment.providerDeploymentId),
          ),
        ))
        .limit(1))[0]?.id;
      if (!observationId) throw new Error("Successful Railway deployment observation did not converge");
      if (insertedObservation) observationsCreated += 1;

      const [insertedProjection] = await tx
        .insert(buildDeploymentHomeProjections)
        .values({
          observationId,
          reasonKey: deploymentReasonKey(environment.platformEnvironmentId, deployment.providerDeploymentId),
          ...ownedInsertValues(principal, projectionScope),
          createdByUserId: owner.userId,
        })
        .onConflictDoNothing()
        .returning({ id: buildDeploymentHomeProjections.id });
      if (insertedProjection) projectionsCreated += 1;
    }

    return { observationsCreated, projectionsCreated };
  }));
}

/** Database-only Home collector; never probes Railway or decrypts credentials. */
export async function listBuildDeploymentHomeItems(
  principal: Principal,
): Promise<BuildDeploymentHomeItemRecord[]> {
  requireOwner(principal);
  if (!(await hasActiveBuildAccess(principal))) return [];

  const rows = await db
    .select({
      projectionId: buildDeploymentHomeProjections.id,
      observationId: platformDeploymentObservations.id,
      reasonKey: buildDeploymentHomeProjections.reasonKey,
      platformEnvironmentId: platformDeploymentObservations.platformEnvironmentId,
      providerDeploymentId: platformDeploymentObservations.providerDeploymentId,
      deploymentState: platformDeploymentObservations.deploymentState,
      platformName: platformDeploymentObservations.platformName,
      productName: platformDeploymentObservations.productName,
      environmentName: platformDeploymentObservations.environmentName,
      commitSha: platformDeploymentObservations.commitSha,
      deployedAt: platformDeploymentObservations.deployedAt,
      observedAt: platformDeploymentObservations.observedAt,
    })
    .from(buildDeploymentHomeProjections)
    .innerJoin(
      platformDeploymentObservations,
      eq(platformDeploymentObservations.id, buildDeploymentHomeProjections.observationId),
    )
    .where(and(
      combineWithVisibleScope(principal, projectionScope),
      combineWithVisibleScope(principal, observationScope),
      isNull(buildDeploymentHomeProjections.dismissedAt),
    ))
    .orderBy(desc(platformDeploymentObservations.deployedAt))
    .limit(MAX_HOME_DEPLOYMENT_ITEMS);

  return rows.flatMap((row) => row.deploymentState === "SUCCESS"
    ? [{ ...row, deploymentState: "SUCCESS" as const }]
    : []);
}

/** Durable dismissal preserves both provider evidence and projection history. */
export async function dismissBuildDeploymentHomeItem(
  principal: Principal,
  projectionId: string,
  reasonKey: string,
): Promise<boolean> {
  const owner = requireOwner(principal);
  const canonicalProjectionId = boundedText(projectionId, 200);
  const canonicalReasonKey = boundedText(reasonKey, 500);
  if (!canonicalProjectionId || !canonicalReasonKey) throw new Error("projectionId and reasonKey are required");

  return db.transaction((tx) => runWithDatabaseTransaction(tx, async () => {
    await acquireAdvisoryTransactionLock(
      tx,
      ADVISORY_LOCK_NS.MOD_LIFECYCLE,
      `${owner.accountId}:build`,
    );
    if (!(await hasActiveBuildAccess(principal))) return false;

    const [updated] = await tx
      .update(buildDeploymentHomeProjections)
      .set({
        dismissedAt: new Date(),
        dismissedByUserId: owner.userId,
        updatedAt: new Date(),
      })
      .where(combineWithWritableScope(
        principal,
        projectionScope,
        and(
          eq(buildDeploymentHomeProjections.id, canonicalProjectionId),
          eq(buildDeploymentHomeProjections.reasonKey, canonicalReasonKey),
          isNull(buildDeploymentHomeProjections.dismissedAt),
        ),
      ))
      .returning({ id: buildDeploymentHomeProjections.id });
    return Boolean(updated);
  }));
}
