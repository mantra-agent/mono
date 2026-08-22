/**
 * Feature Test availability projection.
 *
 * One Stage clock per Product. Stage already attests activeCommitSha + lifecycle.state
 * via composeStageLifecycleStatus. Features join through stamped enter-room
 * feature_history.change_sha against activeCommitSha. Environment ready is a
 * different discriminant. Client never derives commit identity. Fail closed to unknown.
 *
 * Spec: @page:a4072542-81c0-4311-b003-3190b78a4b42
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  FEATURE_PIPELINE,
  type FeatureAvailabilityProjection,
  type FeatureAvailabilityState,
  type FeatureStage,
} from "@shared/feature-pipeline";
import {
  environmentSourceBindings,
  platformProductEnvironments,
} from "@shared/models/platforms";
import { mergedPullRequests, platformDeploymentObservations } from "@shared/schema";
import { db } from "./db";
import { compareRefs } from "./integrations/github-pr";
import { getEnvironmentBuildLifecycleConfig } from "./platforms/build-lifecycle-service";
import { readStageSyncStatus } from "./stage-sync";
import { createLogger } from "./log";

const log = createLogger("FeatureAvailability");

const SHA_RE = /^[a-f0-9]{7,64}$/i;

export function normalizeChangeSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sha = value.trim().toLowerCase();
  return SHA_RE.test(sha) ? sha : null;
}

export function roomDeclaresChangeShaIdentity(stage: string | null | undefined): boolean {
  if (!stage || !(stage in FEATURE_PIPELINE)) return false;
  const room = FEATURE_PIPELINE[stage as FeatureStage];
  return room.availability?.identity === "change_sha";
}

export function featureRoomDeclaresAvailability(stage: string | null | undefined): boolean {
  if (!stage || !(stage in FEATURE_PIPELINE)) return false;
  return FEATURE_PIPELINE[stage as FeatureStage].availability != null;
}

/** Stages whose room contract declares a change_sha identity stamp. */
export function stagesRequiringChangeShaStamp(): FeatureStage[] {
  return (Object.keys(FEATURE_PIPELINE) as FeatureStage[]).filter((stage) =>
    roomDeclaresChangeShaIdentity(stage),
  );
}

function parsePrAddress(address: string): { owner: string; repo: string; number: number } | null {
  const raw = address.trim();
  const body = raw.startsWith("@pr:") ? raw.slice(4) : raw.startsWith("pr:") ? raw.slice(3) : raw;
  const parts = body.split("/").filter(Boolean);
  if (parts.length === 3) {
    const number = Number(parts[2]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return {
      owner: parts[0].toLowerCase(),
      repo: parts[1].toLowerCase().replace(/\.git$/i, ""),
      number,
    };
  }
  if (parts.length === 2) {
    const number = Number(parts[1]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return {
      owner: "",
      repo: parts[0].toLowerCase().replace(/\.git$/i, ""),
      number,
    };
  }
  return null;
}

/**
 * Resolve merge commit SHA for stamping when stage advances into a change_sha room.
 * Order: explicit changeSha → newest @pr on the Feature via merged_pull_requests → null.
 */
export async function resolveChangeShaForStamp(args: {
  featureId: string;
  productId: number;
  explicitChangeSha?: unknown;
}): Promise<string | null> {
  const explicit = normalizeChangeSha(args.explicitChangeSha);
  if (explicit) return explicit;

  const source = await resolveProductStageSource(args.productId);
  if (!source) return null;

  const prAddresses = await listNewestFeaturePrAddresses(args.featureId, 25);
  for (const address of prAddresses) {
    const parsed = parsePrAddress(address);
    if (!parsed) continue;
    const owner = parsed.owner || source.owner;
    const repo = parsed.repo;
    if (owner !== source.owner || repo !== source.repo) continue;
    const [row] = await db
      .select({ mergeCommitSha: mergedPullRequests.mergeCommitSha })
      .from(mergedPullRequests)
      .where(
        and(
          eq(mergedPullRequests.owner, owner),
          eq(mergedPullRequests.repo, repo),
          eq(mergedPullRequests.number, parsed.number),
        ),
      )
      .limit(1);
    const sha = normalizeChangeSha(row?.mergeCommitSha);
    if (sha) return sha;
  }
  return null;
}

async function listNewestFeaturePrAddresses(featureId: string, limit: number): Promise<string[]> {
  // Occurrences where the Feature is the source (authored on Feature-linked content)
  // or the target (session/history mentioning the Feature) and the other side is a @pr.
  const featureAddress = `@feature:${featureId}`;
  // Newest @pr addresses linked to this Feature: occurrences on Feature-linked
  // sources, occurrences targeting the Feature, and session artifacts produced
  // while working the Feature that themselves are @pr addresses.
  const result = await db.execute(sql`
    SELECT address, observed_at FROM (
      SELECT target_address AS address, observed_at
      FROM reference_occurrences
      WHERE source_address = ${featureAddress}
        AND target_address LIKE '@pr:%'
      UNION ALL
      SELECT source_address AS address, observed_at
      FROM reference_occurrences
      WHERE target_address = ${featureAddress}
        AND source_address LIKE '@pr:%'
      UNION ALL
      SELECT ro.target_address AS address, ro.observed_at
      FROM session_artifacts sa
      INNER JOIN reference_occurrences ro
        ON ro.source_address = ('@session:' || sa.session_id)
      WHERE sa.artifact_type = 'feature'
        AND sa.artifact_id = ${featureId}
        AND ro.target_address LIKE '@pr:%'
    ) prs
    ORDER BY observed_at DESC
    LIMIT ${limit}
  `);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of result.rows as Array<{ address?: string | null }>) {
    const address = typeof row.address === "string" ? row.address.trim() : "";
    if (!address.startsWith("@pr:") || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

type ProductStageSource = {
  environmentId: number;
  environmentName: string;
  owner: string;
  repo: string;
  branch: string;
};

async function resolveProductStageSource(productId: number): Promise<ProductStageSource | null> {
  if (!Number.isInteger(productId) || productId <= 0) return null;
  const rows = await db
    .select({
      environmentId: platformProductEnvironments.id,
      environmentName: platformProductEnvironments.name,
      owner: environmentSourceBindings.owner,
      repo: environmentSourceBindings.repo,
      branch: environmentSourceBindings.branch,
    })
    .from(platformProductEnvironments)
    .leftJoin(
      environmentSourceBindings,
      eq(environmentSourceBindings.environmentId, platformProductEnvironments.id),
    )
    .where(eq(platformProductEnvironments.productId, productId));

  const stage = rows.find((row) => row.environmentName?.trim().toLowerCase() === "stage");
  if (!stage) return null;
  const owner = stage.owner?.trim().toLowerCase() || "";
  const repo = stage.repo?.trim().toLowerCase().replace(/\.git$/i, "") || "";
  const branch = stage.branch?.trim() || "";
  if (!owner || !repo) {
    return {
      environmentId: stage.environmentId,
      environmentName: stage.environmentName,
      owner,
      repo,
      branch,
    };
  }
  return {
    environmentId: stage.environmentId,
    environmentName: stage.environmentName,
    owner,
    repo,
    branch,
  };
}

type StageClockSnapshot = {
  state: string | null;
  activeCommitSha: string | null;
  owner: string | null;
  repo: string | null;
};

async function loadProductStageClock(productId: number): Promise<StageClockSnapshot | null> {
  const source = await resolveProductStageSource(productId);
  if (!source) return null;

  try {
    const [lifecycleResult, warmSyncResult, deploymentResult] = await Promise.allSettled([
      getEnvironmentBuildLifecycleConfig(source.environmentId, { includeDisabled: true }),
      readStageSyncStatus(source.environmentId),
      db
        .select({ commitSha: platformDeploymentObservations.commitSha })
        .from(platformDeploymentObservations)
        .where(and(
          eq(platformDeploymentObservations.platformEnvironmentId, source.environmentId),
          eq(platformDeploymentObservations.provider, "railway"),
          eq(platformDeploymentObservations.deploymentState, "SUCCESS"),
        ))
        .orderBy(
          desc(platformDeploymentObservations.deployedAt),
          desc(platformDeploymentObservations.observedAt),
        )
        .limit(1),
    ]);

    const warmSync = warmSyncResult.status === "fulfilled" ? warmSyncResult.value : null;
    const lifecycleConfig = lifecycleResult.status === "fulfilled" ? lifecycleResult.value?.config : null;
    const deployPolicy =
      lifecycleConfig?.deployPolicy &&
      typeof lifecycleConfig.deployPolicy === "object" &&
      !Array.isArray(lifecycleConfig.deployPolicy)
        ? (lifecycleConfig.deployPolicy as Record<string, unknown>)
        : {};
    const deployedCommitSha = deploymentResult.status === "fulfilled"
      ? deploymentResult.value[0]?.commitSha ?? null
      : null;
    const activeCommitSha = deployPolicy.runtimeMode === "warm_workspace"
      ? normalizeChangeSha(warmSync?.activeCommitSha) ?? normalizeChangeSha(deployedCommitSha)
      : normalizeChangeSha(deployedCommitSha);

    return {
      state: activeCommitSha ? "ready" : null,
      activeCommitSha,
      owner: source.owner || null,
      repo: source.repo || null,
    };
  } catch (error) {
    log.warn(
      `stage_clock_unavailable productId=${productId} env=${source.environmentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      state: null,
      activeCommitSha: null,
      owner: source.owner || null,
      repo: source.repo || null,
    };
  }
}

/**
 * Newest enter-room change_sha for each Feature among rooms that declare the identity.
 * Enter = to_stage in the declaring set and from_stage distinct from to_stage.
 * Status-only writes (same room) are not identity. One query per product batch.
 */
async function loadNewestChangeShas(
  featureIds: string[],
  toStages: FeatureStage[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (featureIds.length === 0 || toStages.length === 0) return out;

  const result = await db.execute(sql`
    SELECT DISTINCT ON (feature_id) feature_id, change_sha
    FROM feature_history
    WHERE feature_id IN (${sql.join(featureIds.map((id) => sql`${id}`), sql`, `)})
      AND change_sha IS NOT NULL
      AND btrim(change_sha) <> ''
      AND to_stage IN (${sql.join(toStages.map((s) => sql`${s}`), sql`, `)})
      AND from_stage IS DISTINCT FROM to_stage
    ORDER BY feature_id, created_at DESC
  `);

  for (const row of result.rows as Array<{ feature_id?: string; change_sha?: string | null }>) {
    const id = typeof row.feature_id === "string" ? row.feature_id : "";
    const sha = normalizeChangeSha(row.change_sha);
    if (id && sha) out.set(id, sha);
  }
  return out;
}

async function proveAncestorOrEqual(args: {
  owner: string;
  repo: string;
  changeSha: string;
  activeCommitSha: string;
  cache: Map<string, boolean | null>;
}): Promise<boolean | null> {
  const change = normalizeChangeSha(args.changeSha);
  const active = normalizeChangeSha(args.activeCommitSha);
  if (!change || !active) return null;
  if (change === active) return true;
  // Prefix equality when one is a short SHA of the other.
  const n = Math.min(change.length, active.length);
  if (n >= 7 && change.slice(0, n) === active.slice(0, n)) return true;

  const key = `${args.owner}/${args.repo}:${change}:${active}`;
  if (args.cache.has(key)) return args.cache.get(key) ?? null;

  try {
    // compare(base=change, head=active): identical | ahead means active contains change.
    const result = await compareRefs({ owner: args.owner, repo: args.repo }, change, active);
    const ok = result.status === "identical" || result.status === "ahead";
    args.cache.set(key, ok);
    return ok;
  } catch (error) {
    log.warn(
      `ancestry_unproved ${args.owner}/${args.repo} change=${change.slice(0, 7)} active=${active.slice(0, 7)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    args.cache.set(key, null);
    return null;
  }
}

async function loadLocalMergeAncestry(args: {
  owner: string;
  repo: string;
  changeShas: string[];
  activeCommitSha: string;
}): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const active = normalizeChangeSha(args.activeCommitSha);
  const changes = [...new Set(
    args.changeShas
      .map(normalizeChangeSha)
      .filter((sha): sha is string => Boolean(sha)),
  )];
  if (!active || changes.length === 0) return out;

  for (const change of changes) {
    const n = Math.min(change.length, active.length);
    if (n >= 7 && change.slice(0, n) === active.slice(0, n)) out.set(change, true);
  }

  const unresolved = changes.filter((sha) => !out.has(sha));
  if (unresolved.length === 0) return out;
  const rows = await db
    .select({
      mergeCommitSha: mergedPullRequests.mergeCommitSha,
      mergedAt: mergedPullRequests.mergedAt,
    })
    .from(mergedPullRequests)
    .where(and(
      eq(mergedPullRequests.owner, args.owner),
      eq(mergedPullRequests.repo, args.repo),
      inArray(mergedPullRequests.mergeCommitSha, [...unresolved, active]),
    ));
  const mergedAtBySha = new Map<string, number>();
  for (const row of rows) {
    const sha = normalizeChangeSha(row.mergeCommitSha);
    if (sha) mergedAtBySha.set(sha, row.mergedAt.getTime());
  }
  const activeMergedAt = mergedAtBySha.get(active);
  for (const change of unresolved) {
    const changeMergedAt = mergedAtBySha.get(change);
    out.set(change, activeMergedAt != null && changeMergedAt != null
      ? changeMergedAt <= activeMergedAt
      : null);
  }
  return out;
}

function deriveAvailabilityState(args: {
  changeSha: string | null;
  clock: StageClockSnapshot | null;
  ancestry: boolean | null;
}): FeatureAvailabilityState {
  if (!args.changeSha) return "unknown";
  if (!args.clock) return "unknown";
  // Environment ready (Active == Target/main) is a different discriminant.
  // on_stage is ancestry against the served tree SHA, even while Warm is syncing.
  if (!args.clock.activeCommitSha) return "waiting";
  if (args.ancestry === true) return "on_stage";
  if (args.ancestry === false) return "waiting";
  return "unknown";
}

/**
 * Project availability onto Feature rows for list/get.
 * One Stage read per Product that has at least one declaring-room Feature.
 * Omits the field when the room did not declare a clock. Never puts SHAs on the payload.
 */
export async function projectFeatureAvailability<T extends Record<string, unknown>>(
  rows: T[],
  options: { refreshAncestry?: boolean } = {},
): Promise<Array<T & { availability?: FeatureAvailabilityProjection }>> {
  if (rows.length === 0) return rows;

  const stampStages = stagesRequiringChangeShaStamp();
  const byProduct = new Map<number, T[]>();
  for (const row of rows) {
    const stage = typeof row.stage === "string" ? row.stage : "";
    if (!featureRoomDeclaresAvailability(stage)) continue;
    const productId = Number(row.product_id ?? row.productId);
    if (!Number.isInteger(productId) || productId <= 0) continue;
    const list = byProduct.get(productId) ?? [];
    list.push(row);
    byProduct.set(productId, list);
  }

  if (byProduct.size === 0) {
    return rows.map((row) => {
      if (!featureRoomDeclaresAvailability(typeof row.stage === "string" ? row.stage : "")) {
        return row;
      }
      return { ...row, availability: { state: "unknown" as const } };
    });
  }

  const availabilityByFeatureId = new Map<string, FeatureAvailabilityState>();
  const ancestryCache = new Map<string, boolean | null>();

  for (const [productId, productRows] of byProduct) {
    const featureIds = productRows
      .map((row) => (typeof row.id === "string" ? row.id : ""))
      .filter(Boolean);
    const [clock, changeShas] = await Promise.all([
      loadProductStageClock(productId),
      loadNewestChangeShas(featureIds, stampStages),
    ]);

    // Distinct SHAs only for ancestry compares on this Product.
    const distinctShas = [...new Set([...changeShas.values()])];
    const ancestryBySha = clock?.activeCommitSha && clock.owner && clock.repo
      ? await loadLocalMergeAncestry({
          owner: clock.owner,
          repo: clock.repo,
          changeShas: distinctShas,
          activeCommitSha: clock.activeCommitSha,
        })
      : new Map<string, boolean | null>();
    if (clock?.activeCommitSha && clock.owner && clock.repo && distinctShas.length > 0) {
      const unproved = distinctShas.filter((sha) => ancestryBySha.get(sha) == null);
      if (options.refreshAncestry) await Promise.all(
        unproved.map(async (sha) => {
          const proved = await proveAncestorOrEqual({
            owner: clock.owner!,
            repo: clock.repo!,
            changeSha: sha,
            activeCommitSha: clock.activeCommitSha!,
            cache: ancestryCache,
          });
          ancestryBySha.set(sha, proved);
        }),
      );
    }

    for (const row of productRows) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) continue;
      const changeSha = changeShas.get(id) ?? null;
      const ancestry = changeSha ? ancestryBySha.get(changeSha) ?? null : null;
      availabilityByFeatureId.set(
        id,
        deriveAvailabilityState({ changeSha, clock, ancestry }),
      );
    }
  }

  return rows.map((row) => {
    const stage = typeof row.stage === "string" ? row.stage : "";
    if (!featureRoomDeclaresAvailability(stage)) return row;
    const id = typeof row.id === "string" ? row.id : "";
    const state = (id && availabilityByFeatureId.get(id)) || "unknown";
    return { ...row, availability: { state } };
  });
}
