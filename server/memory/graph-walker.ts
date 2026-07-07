import { memoryStorage } from "./memory-storage";
import type { MemoryEntry, MemoryLink } from "@shared/schema";
import { createLogger } from "../log";

const log = createLogger("GraphWalker");

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function recencyDecay(createdAt: Date, now: Date = new Date()): number {
  const ageMs = now.getTime() - createdAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-0.05 * ageDays);
}

export interface RankedEntry {
  entry: MemoryEntry;
  relevance: number;
  linkStrength: number;
  recency: number;
  score: number;
  hop: number;
  linkRelationshipType?: string;
}

export interface WalkGraphOptions {
  seedEntryIds: number[];
  focusEmbedding: number[];
  maxHops?: number;
  minRelevance?: number;
  maxResults?: number;
  excludeIds?: Set<number>;
  relationshipTypes?: string[];
  queryTag?: string;
}

export async function walkGraph(options: WalkGraphOptions): Promise<RankedEntry[]> {
  const {
    seedEntryIds,
    focusEmbedding,
    maxHops = 2,
    minRelevance = 0.3,
    maxResults = 20,
    excludeIds = new Set<number>(),
    relationshipTypes: relTypeFilter,
    queryTag,
  } = options;

  log.log(`walkGraph start seeds=${seedEntryIds.length} seedIds=[${seedEntryIds.join(",")}] maxHops=${maxHops} minRelevance=${minRelevance} maxResults=${maxResults} excludeIds=${excludeIds.size}${queryTag ? ` tag=${queryTag}` : ""}`);

  const visited = new Set<number>(Array.from(excludeIds));
  const ranked: RankedEntry[] = [];
  const now = new Date();

  let frontier: Array<{ entryId: number; hop: number; incomingLinkStrength: number }> = [];
  for (const seedId of seedEntryIds) {
    visited.add(seedId);
    frontier.push({ entryId: seedId, hop: 0, incomingLinkStrength: 1.0 });
  }

  for (let hop = 0; hop <= maxHops && frontier.length > 0; hop++) {
    const nextFrontier: Array<{ entryId: number; hop: number; incomingLinkStrength: number }> = [];

    for (const { entryId, incomingLinkStrength } of frontier) {
      let linkedResults;
      try {
        linkedResults = await memoryStorage.getLinksWithEntries(entryId, queryTag);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`Error fetching links for entry #${entryId}: ${errMsg}`);
        continue;
      }

      for (const { link, entry } of linkedResults) {
        if (visited.has(entry.id)) continue;
        const linkRelType: string = link.relationshipType || "related";
        if (relTypeFilter && relTypeFilter.length > 0) {
          if (!relTypeFilter.includes(linkRelType)) continue;
        }
        visited.add(entry.id);

        const hasFocusEmbedding = focusEmbedding.length > 0;
        const embedding = null;
        const canComputeSimilarity = hasFocusEmbedding && embedding && embedding.length > 0;
        const relevance = canComputeSimilarity
          ? cosineSimilarity(embedding, focusEmbedding)
          : 1.0;

        if (canComputeSimilarity && relevance < minRelevance) continue;

        const linkStrength = link.strength * incomingLinkStrength;
        const recency = recencyDecay(entry.createdAt, now);
        const meta = (entry.metadata || {}) as Record<string, unknown>;
        const decayScore = Number(meta.decay_score ?? 1.0);
        const score = relevance * linkStrength * recency * decayScore;

        ranked.push({
          entry,
          relevance,
          linkStrength,
          recency,
          score,
          hop: hop + 1,
          linkRelationshipType: linkRelType,
        });

        if (hop + 1 < maxHops) {
          nextFrontier.push({
            entryId: entry.id,
            hop: hop + 1,
            incomingLinkStrength: linkStrength,
          });
        }
      }
    }

    frontier = nextFrontier;
    log.log(`walkGraph hop=${hop} frontierSize=${nextFrontier.length} rankedSoFar=${ranked.length} visited=${visited.size}`);
  }

  ranked.sort((a, b) => b.score - a.score);
  const final = ranked.slice(0, maxResults);
  log.log(`walkGraph complete totalVisited=${visited.size} totalRanked=${ranked.length} returned=${final.length} topScore=${final[0]?.score?.toFixed(4) || "n/a"}`);
  return final;
}
