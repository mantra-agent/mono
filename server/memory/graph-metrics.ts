import { sql } from "drizzle-orm";
import { db, withQueryAttributionAsync } from "../db";
import { eventBus } from "../event-bus";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithWritableScope } from "../scoped-storage";

const claimAliasScopeColumns = {
  scope: sql`c.scope`,
  ownerUserId: sql`c.owner_user_id`,
  accountId: sql`c.account_id`,
};

const linkAliasScopeColumns = {
  scope: sql`l.scope`,
  ownerUserId: sql`l.owner_user_id`,
  accountId: sql`l.account_id`,
};

const plainClaimScopeColumns = {
  scope: sql`memory_vnext_claims.scope`,
  ownerUserId: sql`memory_vnext_claims.owner_user_id`,
  accountId: sql`memory_vnext_claims.account_id`,
};

const log = createLogger("GraphMetrics");

export interface GSIScore {
  overall: number;
  connectivity: number;
  linkQuality: number;
  orphanRate: number;
  clusterBalance: number;
  decayHealth: number;
  computedAt: string;
  details: Record<string, unknown>;
}

const WEIGHTS = {
  connectivity: 0.25,
  linkQuality: 0.2,
  orphanRate: 0.2,
  clusterBalance: 0.15,
  decayHealth: 0.2,
} as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Shannon entropy of a bucketed distribution, normalized to [0,1]. */
function normalizedEntropy(buckets: number[]): number {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  const probabilities = buckets.filter((count) => count > 0).map((count) => count / total);
  if (probabilities.length <= 1) return 0;
  const entropy = -probabilities.reduce((sum, p) => sum + p * Math.log2(p), 0);
  return clamp01(entropy / Math.log2(buckets.length));
}

/**
 * Graph Structure Index over the vNext claim graph. Components:
 * - connectivity: share of active claims with at least one claim link or entity link
 * - linkQuality: mean claim-link strength
 * - orphanRate: inverted share of active claims with no links and no source refs
 * - clusterBalance: entropy of the per-claim degree distribution (penalizes hub-and-spoke)
 * - decayHealth: entropy of the confidence distribution (penalizes collapse to one band)
 *
 * Report-only: publishes an event and returns the score. No memory writes.
 */
export async function computeGSI(): Promise<GSIScore> {
  return withQueryAttributionAsync("memory-read", async () => {
    const principal = getCurrentPrincipalOrSystem();
    if (!principal.userId) throw new Error("vNext GSI requires a user principal");
    const [core] = (
      await db.execute(sql`
        SELECT
          count(*)::int AS active_claims,
          count(*) FILTER (
            WHERE EXISTS (SELECT 1 FROM memory_vnext_claim_links l WHERE (l.from_claim_id = c.id OR l.to_claim_id = c.id)
              AND l.owner_user_id IS NOT DISTINCT FROM c.owner_user_id
              AND l.account_id IS NOT DISTINCT FROM c.account_id)
               OR EXISTS (SELECT 1 FROM memory_vnext_entity_links e WHERE e.claim_id = c.id
              AND e.owner_user_id IS NOT DISTINCT FROM c.owner_user_id
              AND e.account_id IS NOT DISTINCT FROM c.account_id)
          )::int AS linked_claims,
          count(*) FILTER (
            WHERE NOT EXISTS (SELECT 1 FROM memory_vnext_claim_links l WHERE (l.from_claim_id = c.id OR l.to_claim_id = c.id)
              AND l.owner_user_id IS NOT DISTINCT FROM c.owner_user_id
              AND l.account_id IS NOT DISTINCT FROM c.account_id)
              AND NOT EXISTS (SELECT 1 FROM memory_vnext_entity_links e WHERE e.claim_id = c.id
              AND e.owner_user_id IS NOT DISTINCT FROM c.owner_user_id
              AND e.account_id IS NOT DISTINCT FROM c.account_id)
              AND NOT EXISTS (SELECT 1 FROM memory_vnext_sources s WHERE s.claim_id = c.id
              AND s.owner_user_id IS NOT DISTINCT FROM c.owner_user_id
              AND s.account_id IS NOT DISTINCT FROM c.account_id)
          )::int AS orphan_claims,
          count(*) FILTER (WHERE c.lifecycle_stage = 'canonical')::int AS canonical_claims
        FROM memory_vnext_claims c
        WHERE c.lifecycle_stage <> 'retired'
          AND ${combineWithWritableScope(principal, claimAliasScopeColumns, sql`TRUE`)}
      `)
    ).rows as unknown as Array<{
      active_claims: number;
      linked_claims: number;
      orphan_claims: number;
      canonical_claims: number;
    }>;

    const activeClaims = Number(core?.active_claims ?? 0);
    const linkedClaims = Number(core?.linked_claims ?? 0);
    const orphanClaims = Number(core?.orphan_claims ?? 0);
    const canonicalClaims = Number(core?.canonical_claims ?? 0);

    const [linkStats] = (
      await db.execute(sql`
        SELECT count(*)::int AS link_count, COALESCE(avg(strength), 0) AS avg_strength
        FROM memory_vnext_claim_links l
        JOIN memory_vnext_claims a ON a.id = l.from_claim_id AND a.lifecycle_stage <> 'retired'
        JOIN memory_vnext_claims b ON b.id = l.to_claim_id AND b.lifecycle_stage <> 'retired'
        WHERE ${combineWithWritableScope(principal, linkAliasScopeColumns, sql`TRUE`)}
          AND a.owner_user_id IS NOT DISTINCT FROM l.owner_user_id
          AND a.account_id IS NOT DISTINCT FROM l.account_id
          AND b.owner_user_id IS NOT DISTINCT FROM l.owner_user_id
          AND b.account_id IS NOT DISTINCT FROM l.account_id
      `)
    ).rows as unknown as Array<{ link_count: number; avg_strength: string | number }>;

    const degreeRows = (
      await db.execute(sql`
        SELECT degree_bucket, count(*)::int AS claim_count
        FROM (
          SELECT c.id, LEAST(4, (
            SELECT count(*) FROM memory_vnext_claim_links l
            WHERE (l.from_claim_id = c.id OR l.to_claim_id = c.id)
              AND l.owner_user_id IS NOT DISTINCT FROM c.owner_user_id
              AND l.account_id IS NOT DISTINCT FROM c.account_id
          )) AS degree_bucket
          FROM memory_vnext_claims c
          WHERE c.lifecycle_stage <> 'retired'
            AND ${combineWithWritableScope(principal, claimAliasScopeColumns, sql`TRUE`)}
        ) degrees
        GROUP BY degree_bucket
      `)
    ).rows as unknown as Array<{ degree_bucket: number; claim_count: number }>;

    const confidenceRows = (
      await db.execute(sql`
        SELECT width_bucket(confidence, 0, 1, 5) AS bucket, count(*)::int AS claim_count
        FROM memory_vnext_claims
        WHERE lifecycle_stage <> 'retired'
          AND ${combineWithWritableScope(principal, plainClaimScopeColumns, sql`TRUE`)}
        GROUP BY bucket
      `)
    ).rows as unknown as Array<{ bucket: number; claim_count: number }>;

    const connectivity = activeClaims > 0 ? clamp01(linkedClaims / activeClaims) : 0;
    const linkQuality = clamp01(Number(linkStats?.avg_strength ?? 0));
    const orphanRate = activeClaims > 0 ? clamp01(1 - orphanClaims / activeClaims) : 0;

    const degreeBuckets = [0, 0, 0, 0, 0];
    for (const row of degreeRows) {
      const bucket = Math.max(0, Math.min(4, Number(row.degree_bucket)));
      degreeBuckets[bucket] += Number(row.claim_count);
    }
    const clusterBalance = normalizedEntropy(degreeBuckets);

    const confidenceBuckets = [0, 0, 0, 0, 0];
    for (const row of confidenceRows) {
      const bucket = Math.max(1, Math.min(5, Number(row.bucket))) - 1;
      confidenceBuckets[bucket] += Number(row.claim_count);
    }
    const decayHealth = normalizedEntropy(confidenceBuckets);

    const overall = clamp01(
      connectivity * WEIGHTS.connectivity +
        linkQuality * WEIGHTS.linkQuality +
        orphanRate * WEIGHTS.orphanRate +
        clusterBalance * WEIGHTS.clusterBalance +
        decayHealth * WEIGHTS.decayHealth,
    );

    const score: GSIScore = {
      overall,
      connectivity,
      linkQuality,
      orphanRate,
      clusterBalance,
      decayHealth,
      computedAt: new Date().toISOString(),
      details: {
        activeClaims,
        linkedClaims,
        orphanClaims,
        canonicalClaims,
        claimLinkCount: Number(linkStats?.link_count ?? 0),
        degreeBuckets,
        confidenceBuckets,
      },
    };

    eventBus.publish({
      category: "system",
      event: "sleep:gsi_computed",
      payload: {
        overall: score.overall,
        connectivity: score.connectivity,
        linkQuality: score.linkQuality,
        orphanRate: score.orphanRate,
        clusterBalance: score.clusterBalance,
        decayHealth: score.decayHealth,
        activeClaims,
      },
    });

    log.log(
      `GSI computed over vNext graph: overall=${score.overall.toFixed(3)} ` +
        `(connectivity=${connectivity.toFixed(2)}, linkQuality=${linkQuality.toFixed(2)}, ` +
        `orphanRate=${orphanRate.toFixed(2)}, clusterBalance=${clusterBalance.toFixed(2)}, decayHealth=${decayHealth.toFixed(2)})`,
    );
    return score;
  });
}
