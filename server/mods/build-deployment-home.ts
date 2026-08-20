import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type {
  BuildDeploymentTimingEnvironment,
  BuildDeploymentTimingSummary,
} from "@shared/models/build-deployments";
import {
  buildDeploymentHomeProjections,
  environmentPromotionReleases,
  platformDeploymentObservations,
} from "@shared/schema";
import { createReferenceRef, type ReferenceRef } from "@shared/references";
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
import { hasActiveModAccess } from "./mod-access";
const hasActiveBuildAccess = (principal: Principal) => hasActiveModAccess(principal, "build");

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
const MAX_TIMING_ROWS = 100;
const MAX_TIMING_SAMPLES_PER_ENVIRONMENT = 20;
const TIMING_WINDOW_DAYS = 30;

export interface SuccessfulRailwayDeploymentObservation {
  providerDeploymentId: string;
  deployedAt: Date;
  startedAt: Date | null;
  durationMs: number | null;
  commitSha: string | null;
}

export interface BuildDeploymentEnvironmentIdentity {
  platformEnvironmentId: number;
  platformName: string;
  productName: string;
  environmentName: string;
}

export interface BuildDeploymentCompletion {
  observationId: string;
  platformEnvironmentId: number;
  reference: ReferenceRef;
  label: string;
  deployedAt: Date;
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
  version: string | null;
  label: string;
  deployedAt: Date;
  observedAt: Date;
}

export interface BuildDeploymentLabelParts {
  platformName: string;
  productName: string;
  environmentName: string;
  version?: string | null;
  commitSha?: string | null;
}

/** Identifiable build chip label: version when promoted, else short commit. */
export function formatBuildDeploymentLabel(parts: BuildDeploymentLabelParts): string {
  const base = `${parts.platformName} / ${parts.productName} / ${parts.environmentName}`;
  const version = parts.version?.trim();
  if (version) {
    return version.startsWith("v") ? `${base} ${version}` : `${base} v${version}`;
  }
  const commit = parts.commitSha?.trim();
  if (commit) return `${base} #${commit.slice(0, 7)}`;
  return base;
}

async function latestReleaseVersionsByEnvironment(
  environmentIds: number[],
): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(environmentIds.filter((id) => Number.isInteger(id) && id > 0))];
  const versionByEnv = new Map<number, string>();
  if (uniqueIds.length === 0) return versionByEnv;

  const rows = await db
    .select({
      environmentId: environmentPromotionReleases.environmentId,
      version: environmentPromotionReleases.version,
    })
    .from(environmentPromotionReleases)
    .where(inArray(environmentPromotionReleases.environmentId, uniqueIds))
    .orderBy(desc(environmentPromotionReleases.promotedAt));

  for (const row of rows) {
    if (!versionByEnv.has(row.environmentId) && row.version?.trim()) {
      versionByEnv.set(row.environmentId, row.version.trim());
    }
  }
  return versionByEnv;
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

function deploymentReasonKey(environmentId: number): string {
  return `build:railway-environment:${environmentId}`;
}

function buildReference(
  observationId: string,
  environment: BuildDeploymentEnvironmentIdentity,
  identity?: { version?: string | null; commitSha?: string | null },
): ReferenceRef {
  const label = formatBuildDeploymentLabel({
    platformName: environment.platformName,
    productName: environment.productName,
    environmentName: environment.environmentName,
    version: identity?.version,
    commitSha: identity?.commitSha,
  });
  return createReferenceRef({
    type: "build",
    id: observationId,
    metadata: {
      label,
      href: `/platform-environments/${encodeURIComponent(environment.platformEnvironmentId)}`,
    },
  });
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
): Promise<{ observationsCreated: number; projectionsCreated: number; completions: BuildDeploymentCompletion[] }> {
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
    const timingIsValid = deployment.startedAt
      && !Number.isNaN(deployment.startedAt.getTime())
      && deployment.startedAt <= deployment.deployedAt
      && Number.isInteger(deployment.durationMs)
      && deployment.durationMs! >= 0;
    return [{
      providerDeploymentId,
      commitSha,
      deployedAt: deployment.deployedAt,
      startedAt: timingIsValid ? deployment.startedAt : null,
      durationMs: timingIsValid ? deployment.durationMs : null,
    }];
  });
  if (canonicalDeployments.length === 0) {
    return { observationsCreated: 0, projectionsCreated: 0, completions: [] };
  }

  return db.transaction((tx) => runWithDatabaseTransaction(tx, async () => {
    await acquireAdvisoryTransactionLock(
      tx,
      ADVISORY_LOCK_NS.MOD_LIFECYCLE,
      `${owner.accountId}:build`,
    );
    if (!(await hasActiveBuildAccess(principal))) {
      return { observationsCreated: 0, projectionsCreated: 0, completions: [] };
    }

    let observationsCreated = 0;
    let projectionsCreated = 0;
    const completions: BuildDeploymentCompletion[] = [];
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
          startedAt: deployment.startedAt,
          deployedAt: deployment.deployedAt,
          durationMs: deployment.durationMs,
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
    }

    const [latestObservation] = await tx
      .select({
        id: platformDeploymentObservations.id,
        deployedAt: platformDeploymentObservations.deployedAt,
        commitSha: platformDeploymentObservations.commitSha,
      })
      .from(platformDeploymentObservations)
      .where(combineWithVisibleScope(
        principal,
        observationScope,
        and(
          eq(platformDeploymentObservations.platformEnvironmentId, environment.platformEnvironmentId),
          eq(platformDeploymentObservations.provider, "railway"),
          eq(platformDeploymentObservations.deploymentState, "SUCCESS"),
        ),
      ))
      .orderBy(desc(platformDeploymentObservations.deployedAt), desc(platformDeploymentObservations.observedAt))
      .limit(1);
    if (!latestObservation) {
      return { observationsCreated, projectionsCreated, completions };
    }

    const [latestRelease] = await tx
      .select({ version: environmentPromotionReleases.version })
      .from(environmentPromotionReleases)
      .where(eq(environmentPromotionReleases.environmentId, environment.platformEnvironmentId))
      .orderBy(desc(environmentPromotionReleases.promotedAt))
      .limit(1);
    const version = latestRelease?.version?.trim() || null;

    const [currentProjection] = await tx
      .select({
        id: buildDeploymentHomeProjections.id,
        observationId: buildDeploymentHomeProjections.observationId,
      })
      .from(buildDeploymentHomeProjections)
      .where(combineWithWritableScope(
        principal,
        projectionScope,
        eq(buildDeploymentHomeProjections.platformEnvironmentId, environment.platformEnvironmentId),
      ))
      .limit(1);
    if (currentProjection?.observationId === latestObservation.id) {
      return { observationsCreated, projectionsCreated, completions };
    }

    const now = new Date();
    let projected = false;
    if (currentProjection) {
      const updated = await tx
        .update(buildDeploymentHomeProjections)
        .set({
          observationId: latestObservation.id,
          reasonKey: deploymentReasonKey(environment.platformEnvironmentId),
          // Clear both dismissal fields together; the check constraint rejects
          // dismissedAt=null with a leftover dismissedByUserId.
          dismissedAt: null,
          dismissedByUserId: null,
          updatedAt: now,
        })
        .where(combineWithWritableScope(
          principal,
          projectionScope,
          eq(buildDeploymentHomeProjections.id, currentProjection.id),
        ))
        .returning({ id: buildDeploymentHomeProjections.id });
      projected = updated.length > 0;
    } else {
      const inserted = await tx
        .insert(buildDeploymentHomeProjections)
        .values({
          observationId: latestObservation.id,
          platformEnvironmentId: environment.platformEnvironmentId,
          reasonKey: deploymentReasonKey(environment.platformEnvironmentId),
          ...ownedInsertValues(principal, projectionScope),
          createdByUserId: owner.userId,
        })
        .onConflictDoNothing()
        .returning({ id: buildDeploymentHomeProjections.id });
      projected = inserted.length > 0;
    }
    if (!projected) {
      return { observationsCreated, projectionsCreated, completions };
    }

    projectionsCreated = 1;
    const identity = {
      ...environment,
      platformName,
      productName,
      environmentName,
    };
    const label = formatBuildDeploymentLabel({
      ...identity,
      version,
      commitSha: latestObservation.commitSha,
    });
    completions.push({
      observationId: latestObservation.id,
      platformEnvironmentId: environment.platformEnvironmentId,
      reference: buildReference(latestObservation.id, identity, {
        version,
        commitSha: latestObservation.commitSha,
      }),
      label,
      deployedAt: latestObservation.deployedAt,
    });

    return { observationsCreated, projectionsCreated, completions };
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

  const successRows = rows.filter((row) => row.deploymentState === "SUCCESS");
  const versionByEnv = await latestReleaseVersionsByEnvironment(
    successRows.map((row) => row.platformEnvironmentId),
  );

  return successRows.map((row) => {
    const version = versionByEnv.get(row.platformEnvironmentId) ?? null;
    return {
      ...row,
      deploymentState: "SUCCESS" as const,
      version,
      label: formatBuildDeploymentLabel({
        platformName: row.platformName,
        productName: row.productName,
        environmentName: row.environmentName,
        version,
        commitSha: row.commitSha,
      }),
    };
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

/** Bounded database-only Performance projection; never probes Railway. */
export async function getBuildDeploymentTimingSummary(
  principal: Principal,
): Promise<BuildDeploymentTimingSummary> {
  requireOwner(principal);
  if (!(await hasActiveBuildAccess(principal))) {
    return { generatedAt: new Date().toISOString(), environments: [] };
  }

  const cutoff = new Date(Date.now() - TIMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      observationId: platformDeploymentObservations.id,
      platformEnvironmentId: platformDeploymentObservations.platformEnvironmentId,
      platformName: platformDeploymentObservations.platformName,
      productName: platformDeploymentObservations.productName,
      environmentName: platformDeploymentObservations.environmentName,
      commitSha: platformDeploymentObservations.commitSha,
      startedAt: platformDeploymentObservations.startedAt,
      deployedAt: platformDeploymentObservations.deployedAt,
      durationMs: platformDeploymentObservations.durationMs,
    })
    .from(platformDeploymentObservations)
    .where(combineWithVisibleScope(
      principal,
      observationScope,
      and(
        eq(platformDeploymentObservations.deploymentState, "SUCCESS"),
        gte(platformDeploymentObservations.deployedAt, cutoff),
      ),
    ))
    .orderBy(desc(platformDeploymentObservations.deployedAt))
    .limit(MAX_TIMING_ROWS);

  const grouped = new Map<number, BuildDeploymentTimingEnvironment>();
  for (const row of rows) {
    if (!row.startedAt || row.durationMs === null || row.durationMs < 0) continue;
    let environment = grouped.get(row.platformEnvironmentId);
    if (!environment) {
      environment = {
        platformEnvironmentId: row.platformEnvironmentId,
        platformName: row.platformName,
        productName: row.productName,
        environmentName: row.environmentName,
        sampleCount: 0,
        latestDurationMs: row.durationMs,
        medianDurationMs: row.durationMs,
        samples: [],
      };
      grouped.set(row.platformEnvironmentId, environment);
    }
    if (environment.samples.length >= MAX_TIMING_SAMPLES_PER_ENVIRONMENT) continue;
    environment.samples.push({
      observationId: row.observationId,
      durationMs: row.durationMs,
      startedAt: row.startedAt.toISOString(),
      deployedAt: row.deployedAt.toISOString(),
      commitSha: row.commitSha,
    });
  }

  const environments = Array.from(grouped.values()).map((environment) => ({
    ...environment,
    sampleCount: environment.samples.length,
    medianDurationMs: median(environment.samples.map((sample) => sample.durationMs)),
  }));
  return { generatedAt: new Date().toISOString(), environments };
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
    if (updated) return true;

    // Stale Home complete / double-click: already dismissed is success.
    const [existing] = await tx
      .select({
        id: buildDeploymentHomeProjections.id,
        dismissedAt: buildDeploymentHomeProjections.dismissedAt,
      })
      .from(buildDeploymentHomeProjections)
      .where(combineWithWritableScope(
        principal,
        projectionScope,
        and(
          eq(buildDeploymentHomeProjections.id, canonicalProjectionId),
          eq(buildDeploymentHomeProjections.reasonKey, canonicalReasonKey),
        ),
      ))
      .limit(1);
    return Boolean(existing?.dismissedAt);
  }));
}
