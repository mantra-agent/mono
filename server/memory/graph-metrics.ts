import { memoryStorage } from "./memory-storage";
import { createLogger } from "../log";
import { eventBus } from "../event-bus";
import { db } from "../db";
import { sql } from "drizzle-orm";

const log = createLogger("GSI");

export interface GSIScore {
  overall: number;
  connectivity: number;
  linkQuality: number;
  orphanRate: number;
  clusterBalance: number;
  decayHealth: number;
  entryId: number | null;
  computedAt: string;
  details: Record<string, unknown>;
}

function computeEntropy(values: number[]): number {
  if (values.length === 0) return 0;

  const bucketCount = 10;
  const buckets = new Array(bucketCount).fill(0);
  for (const v of values) {
    const idx = Math.min(Math.floor(v * bucketCount), bucketCount - 1);
    buckets[idx]++;
  }

  const total = values.length;
  let entropy = 0;
  for (const count of buckets) {
    if (count === 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  const maxEntropy = Math.log2(bucketCount);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

export async function computeGSI(): Promise<GSIScore> {
  const startTime = Date.now();
  log.log("[GSI] Computing Graph Structural Integrity score");

  const metrics = await memoryStorage.getGraphMetrics();

  const connectivity = metrics.totalEntries > 0
    ? Math.min(1.0, metrics.linkedEntries / metrics.totalEntries)
    : 0;

  const linkQuality = metrics.totalLinks > 0
    ? Math.min(1.0, metrics.avgLinkStrength)
    : 0;

  const orphanRate = metrics.totalEntries > 0
    ? Math.max(0, Math.min(1.0, 1.0 - (metrics.orphanEntries / metrics.totalEntries)))
    : 1.0;

  let clusterBalance = 0;
  try {
    const clusterRows = await db.execute(sql`
      SELECT linked_id, COUNT(*)::int AS link_count
      FROM (
        SELECT from_id AS linked_id FROM memory_links
        UNION ALL
        SELECT to_id AS linked_id FROM memory_links
      ) sub
      GROUP BY linked_id
      ORDER BY link_count DESC
    `);

    const linkCounts = (clusterRows.rows as Array<{ linked_id: number; link_count: number }>)
      .map(r => r.link_count);

    if (linkCounts.length > 1) {
      const maxCount = linkCounts[0];
      const avgCount = linkCounts.reduce((a, b) => a + b, 0) / linkCounts.length;
      const variance = linkCounts.reduce((sum, c) => sum + Math.pow(c - avgCount, 2), 0) / linkCounts.length;
      const cv = avgCount > 0 ? Math.sqrt(variance) / avgCount : 0;
      clusterBalance = Math.max(0, 1.0 - Math.min(1.0, cv / 3));
    } else if (linkCounts.length === 1) {
      clusterBalance = 0.5;
    }
  } catch (err: unknown) {
    log.warn(`[GSI] Cluster balance computation failed: ${err instanceof Error ? err.message : String(err)}`);
    clusterBalance = 0.5;
  }

  let decayHealth = 0;
  try {
    const distribution = await memoryStorage.getDecayScoreDistribution();
    const scores = distribution.map(d => Number(d.score));

    if (scores.length > 0) {
      const normalizedEntropy = computeEntropy(scores);
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      decayHealth = Math.max(0, Math.min(1.0, 0.5 * normalizedEntropy + 0.5 * avgScore));
    }
  } catch (err: unknown) {
    log.warn(`[GSI] Decay health computation failed: ${err instanceof Error ? err.message : String(err)}`);
    decayHealth = 0.5;
  }

  const weights = {
    connectivity: 0.25,
    linkQuality: 0.20,
    orphanRate: 0.20,
    clusterBalance: 0.15,
    decayHealth: 0.20,
  };

  const overall = Math.min(1.0, Math.max(0,
    weights.connectivity * connectivity +
    weights.linkQuality * linkQuality +
    weights.orphanRate * orphanRate +
    weights.clusterBalance * clusterBalance +
    weights.decayHealth * decayHealth
  ));

  const computedAt = new Date().toISOString();

  const gsiContent = [
    `# Graph Structural Integrity Report`,
    `Computed: ${computedAt}`,
    "",
    `## Overall GSI Score: ${(overall * 100).toFixed(1)}%`,
    "",
    `## Component Scores`,
    `- Connectivity: ${(connectivity * 100).toFixed(1)}% (${metrics.linkedEntries}/${metrics.totalEntries} entries linked)`,
    `- Link Quality: ${(linkQuality * 100).toFixed(1)}% (avg strength: ${metrics.avgLinkStrength.toFixed(3)}, ${metrics.weakLinks} weak, ${metrics.strongLinks} strong)`,
    `- Orphan Rate: ${(orphanRate * 100).toFixed(1)}% (${metrics.orphanEntries} orphans)`,
    `- Cluster Balance: ${(clusterBalance * 100).toFixed(1)}%`,
    `- Decay Health: ${(decayHealth * 100).toFixed(1)}%`,
    "",
    `## Raw Metrics`,
    `- Total entries: ${metrics.totalEntries}`,
    `- Total links: ${metrics.totalLinks}`,
    `- Linked entries: ${metrics.linkedEntries}`,
    `- Orphan entries: ${metrics.orphanEntries}`,
  ].join("\n");

  const sourceId = `gsi-${computedAt.slice(0, 10)}`;
  let entryId: number | null = null;

  try {
    const gsiEntry = await memoryStorage.ingest(
      gsiContent,
      "memory",
      sourceId,
      {
        type: "gsi_report",
        overall,
        connectivity,
        linkQuality,
        orphanRate,
        clusterBalance,
        decayHealth,
        totalEntries: metrics.totalEntries,
        totalLinks: metrics.totalLinks,
        computed_at: computedAt,
      },
      ["gsi", "graph-health", "system-metrics"],
      `GSI Report — ${(overall * 100).toFixed(1)}%`,
    );
    entryId = gsiEntry.id;
    log.log(`[GSI] Report stored as memory entry #${entryId}`);
  } catch (err: unknown) {
    log.error(`[GSI] Failed to store GSI report: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result: GSIScore = {
    overall,
    connectivity,
    linkQuality,
    orphanRate,
    clusterBalance,
    decayHealth,
    entryId,
    computedAt,
    details: {
      totalEntries: metrics.totalEntries,
      totalLinks: metrics.totalLinks,
      linkedEntries: metrics.linkedEntries,
      orphanEntries: metrics.orphanEntries,
      avgLinkStrength: metrics.avgLinkStrength,
      weakLinks: metrics.weakLinks,
      strongLinks: metrics.strongLinks,
    },
  };

  const elapsed = Date.now() - startTime;
  log.log(`[GSI] Computed in ${elapsed}ms: overall=${(overall * 100).toFixed(1)}% connectivity=${(connectivity * 100).toFixed(1)}% linkQuality=${(linkQuality * 100).toFixed(1)}% orphanRate=${(orphanRate * 100).toFixed(1)}% clusterBalance=${(clusterBalance * 100).toFixed(1)}% decayHealth=${(decayHealth * 100).toFixed(1)}%`);

  eventBus.publish({
    category: "system",
    event: "sleep:gsi_computed",
    payload: { overall, entryId, computedAt },
  });

  return result;
}
