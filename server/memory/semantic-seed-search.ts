import { sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { generateEmbedding, isEmbeddingsAvailable } from "./embedding";
import { mapRawRowToEntry, memoryKnowledgeEligibleSql } from "./memory-storage";
import type { MemoryEntry, MemoryLayer } from "@shared/schema";

const log = createLogger("SemanticSeedSearch");
const SEMANTIC_SEED_DB_TIMEOUT_MS = 450;

export interface SemanticSeedSearchOptions {
  query: string;
  limit?: number;
  layers?: MemoryLayer[];
  queryTag?: string;
}

export interface SemanticSeedSearchResult {
  entry: MemoryEntry;
  score: number;
}

/**
 * Purpose-built seed retrieval for memory.graph context assembly.
 *
 * This intentionally does only embedding generation + a bounded vector search.
 * It must not grow into the full user-facing retrieval pipeline: no text scan,
 * no graph expansion, no event/link enrichment. The graph resolver handles graph
 * traversal after this returns cheap topical seed IDs.
 */
export async function semanticSeedSearch(
  options: SemanticSeedSearchOptions,
): Promise<SemanticSeedSearchResult[]> {
  const query = options.query.trim();
  if (!query) return [];
  if (!isEmbeddingsAvailable()) {
    log.verbose(() => "semanticSeedSearch skipped: embeddings unavailable");
    return [];
  }

  const limit = Math.max(1, Math.min(options.limit ?? 12, 80));
  const layers = options.layers?.length ? options.layers : null;
  const start = Date.now();
  const embedding = await generateEmbedding(query);
  if (!embedding || embedding.length === 0) return [];

  const embeddingStr = `[${embedding.join(",")}]`;
  const principal = getCurrentPrincipalOrSystem();
  const visibilityCondition = principal.actorType === "system"
    ? sql``
    : sql`AND (scope = 'global' OR owner_user_id = ${principal.userId} OR account_id = ${principal.accountId})`;
  const tagComment = options.queryTag ? sql.raw(`/* ${options.queryTag} */`) : sql``;

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${String(SEMANTIC_SEED_DB_TIMEOUT_MS)}, true)`);
    return tx.execute(sql`
      ${tagComment}
      SELECT id, layer, integration_stage, content, summary, content_hash, source, source_id, path, title, one_liner, metadata, tags, graphed, pinned, created_at, processed_at,
        1 - (embedding <=> ${embeddingStr}::vector) AS similarity
      FROM memory_entries
      WHERE embedding IS NOT NULL
        ${visibilityCondition}
        ${layers ? sql`AND layer = ANY(${`{${layers.join(",")}}`}::text[])` : sql``}
        AND (${memoryKnowledgeEligibleSql})
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `);
  });

  const results = (rows.rows as any[]).map((row) => ({
    entry: mapRawRowToEntry(row),
    score: parseFloat(String(row.similarity ?? "0")),
  }));
  log.debug(() => `semanticSeedSearch returned ${results.length} seeds in ${Date.now() - start}ms limit=${limit} layers=${layers ? layers.join(",") : "all"} dbTimeout=${SEMANTIC_SEED_DB_TIMEOUT_MS}ms`);
  return results;
}
