import { createLogger } from "../log";
import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import type { MemoryVnextSourceQueueRow, MemorySource } from "@shared/schema";
import {
  pollSettledSources,
  markProcessing,
  markCompleted,
  resetStuckProcessing,
} from "./vnext-source-queue";
import {
  buildFullSessionContent,
  buildLibraryPageContent,
  chunkContent,
  hashContent,
  buildChunkHeader,
} from "./vnext-content-chunking";
import {
  memoryVnextClaimStorage,
  executeVnextClaimSemanticSearch,
  type VnextClaimSourceInput,
} from "./vnext-claim-storage";
import {
  extractClaimsFromChunk,
  deduplicateChunkClaims,
  type ClaimCandidate,
} from "./memory-enrichment";
import { resolveVnextEntityMentions } from "./vnext-entity-resolution";

const log = createLogger("VnextSourcePoller");

/** How many minutes a source must be quiet before extraction */
const SETTLE_MINUTES = 30;

/** Max sources to process per poller run */
const MAX_SOURCES_PER_RUN = 10;

/** Max claims per source across all chunks */
const MAX_CLAIMS_PER_SOURCE = 3;

/** Similarity threshold for semantic deduplication */
const CLAIM_DEDUP_SIMILARITY_THRESHOLD = 0.9;

/** Stuck processing timeout in minutes */
const STUCK_PROCESSING_TIMEOUT_MINUTES = 30;

// ---------------------------------------------------------------------------
// Source content loading
// ---------------------------------------------------------------------------

interface SourceContent {
  content: string;
  title: string;
  topics: string[];
  splitMode: "message" | "paragraph";
  sourceType: MemorySource;
}

async function loadSourceContent(
  row: MemoryVnextSourceQueueRow,
): Promise<SourceContent | null> {
  if (row.sourceType === "session") {
    const result = await buildFullSessionContent(row.sourceId);
    if (!result.content.trim()) {
      log.debug(`loadSourceContent: empty session id=${row.sourceId}`);
      return null;
    }

    const titleMatch = result.content.match(/^Session title: (.+)$/m);
    const topicsMatch = result.content.match(/^Topics: (.+)$/m);
    const title = titleMatch?.[1] || "Untitled Session";
    const topics = topicsMatch?.[1]?.split(", ") || [];

    return {
      content: result.content,
      title,
      topics,
      splitMode: "message",
      sourceType: "chat_journal",
    };
  }

  if (row.sourceType === "library_page") {
    const result = await buildLibraryPageContent(row.sourceId);
    if (!result.content.trim()) {
      log.debug(`loadSourceContent: empty library page id=${row.sourceId}`);
      return null;
    }

    const titleMatch = result.content.match(/^Page title: (.+)$/m);
    const tagsMatch = result.content.match(/^Tags: (.+)$/m);
    const title = titleMatch?.[1] || "Untitled Page";
    const topics = tagsMatch?.[1]?.split(", ") || [];

    return {
      content: result.content,
      title,
      topics,
      splitMode: "paragraph",
      sourceType: "library",
    };
  }

  log.warn(`loadSourceContent: unknown source type=${row.sourceType}`);
  return null;
}

// ---------------------------------------------------------------------------
// Claim extraction from chunks
// ---------------------------------------------------------------------------

async function extractClaimsFromChunks(
  chunks: string[],
  source: string,
  title: string,
): Promise<ClaimCandidate[]> {
  const allClaims: ClaimCandidate[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const claims = await extractClaimsFromChunk(
        chunks[i],
        i,
        chunks.length,
        source,
        title,
      );
      allClaims.push(...claims);
    } catch (err) {
      log.warn(
        `extractClaimsFromChunks: chunk ${i + 1}/${chunks.length} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Deduplicate across chunks and cap
  return deduplicateChunkClaims(allClaims).slice(0, MAX_CLAIMS_PER_SOURCE);
}

// ---------------------------------------------------------------------------
// Claim persistence with dedup/reinforcement
// ---------------------------------------------------------------------------

async function persistClaims(
  claims: ClaimCandidate[],
  sourceContent: SourceContent,
  row: MemoryVnextSourceQueueRow,
): Promise<{ created: number; reinforced: number; skipped: number }> {
  const { generateEmbedding } = await import("./embedding");

  let created = 0;
  let reinforced = 0;
  let skipped = 0;

  const createdClaimIds = new Map<number, number>();

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    try {
      const embedding = await generateEmbedding(claim.content);

      // Semantic dedup against existing vNext claims
      let nearDuplicate: { id: number; similarity: number } | undefined;
      try {
        const similar = await executeVnextClaimSemanticSearch(embedding, 3);
        const match = similar.find(
          (s) => s.similarity >= CLAIM_DEDUP_SIMILARITY_THRESHOLD,
        );
        if (match) {
          nearDuplicate = { id: match.row.id, similarity: match.similarity };
        }
      } catch (err) {
        log.warn(
          `persistClaims: semantic dedup failed open for "${claim.content.slice(0, 80)}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (nearDuplicate) {
        await memoryVnextClaimStorage.reinforceClaim(nearDuplicate.id);
        log.debug(
          `persistClaims: reinforced claim #${nearDuplicate.id} (similarity=${nearDuplicate.similarity.toFixed(3)}) for "${claim.content.slice(0, 60)}"`,
        );
        reinforced++;
        continue;
      }

      // Create new claim with source ref pointing to the queue source
      const sourceRefs: VnextClaimSourceInput[] = [
        {
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          relationship: "extracted_from",
          context: `Extracted by vNext source poller from ${row.sourceType}`,
          strength: 1,
        },
      ];

      const claimEntry = await memoryVnextClaimStorage.createClaim({
        claim,
        sourceMemoryId: 0, // No legacy memory entry parent
        source: sourceContent.sourceType,
        sourceId: row.sourceId,
        embedding,
        metadata: {
          confidence: claim.confidence,
          claimType: claim.claimType,
          extractedBy: "vnext-source-poller",
        },
        sourceRefs,
      });

      // Entity linking
      const resolvedEntities = await resolveVnextEntityMentions(
        claim.entityMentions,
      );
      for (const entity of resolvedEntities) {
        try {
          await memoryVnextClaimStorage.linkClaimToEntity(
            claimEntry.id,
            entity.entityType,
            entity.entityId,
          );
        } catch (entityErr) {
          log.debug(
            `persistClaims: entity link failed claim #${claimEntry.id} → ${entity.entityType}:${entity.entityId}: ${entityErr instanceof Error ? entityErr.message : String(entityErr)}`,
          );
        }
      }

      // Intra-batch causal linking
      if (
        claim.sourceClaimIndex != null &&
        createdClaimIds.has(claim.sourceClaimIndex)
      ) {
        const parentClaimId = createdClaimIds.get(claim.sourceClaimIndex)!;
        try {
          await memoryVnextClaimStorage.linkClaims(
            parentClaimId,
            claimEntry.id,
            "causes",
          );
        } catch (linkErr) {
          log.debug(
            `persistClaims: causal link failed #${parentClaimId} → #${claimEntry.id}: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`,
          );
        }
      }

      createdClaimIds.set(i, claimEntry.id);
      created++;
    } catch (err) {
      log.warn(
        `persistClaims: failed claim "${claim.content.slice(0, 80)}": ${err instanceof Error ? err.message : String(err)}`,
      );
      skipped++;
    }
  }

  return { created, reinforced, skipped };
}

// ---------------------------------------------------------------------------
// Single source processing
// ---------------------------------------------------------------------------

async function processSource(
  row: MemoryVnextSourceQueueRow,
): Promise<{ created: number; reinforced: number; skipped: number }> {
  log.info(
    `processSource: start source=${row.sourceType}:${row.sourceId} queueId=${row.id}`,
  );

  const sourceContent = await loadSourceContent(row);
  if (!sourceContent) {
    log.info(
      `processSource: no content source=${row.sourceType}:${row.sourceId}, marking completed`,
    );
    await markCompleted(row.id, "empty");
    return { created: 0, reinforced: 0, skipped: 0 };
  }

  // Hash check — skip if content unchanged since last extraction
  const contentHash = hashContent(sourceContent.content);
  if (row.contentHash && row.contentHash === contentHash) {
    log.debug(
      `processSource: unchanged source=${row.sourceType}:${row.sourceId} hash=${contentHash.slice(0, 8)}`,
    );
    await markCompleted(row.id, contentHash);
    return { created: 0, reinforced: 0, skipped: 0 };
  }

  // Chunk and extract
  const header = buildChunkHeader(sourceContent.title, sourceContent.topics);
  const chunks = chunkContent(
    sourceContent.content,
    undefined,
    sourceContent.splitMode,
    header,
  );

  log.info(
    `processSource: extracting source=${row.sourceType}:${row.sourceId} contentLen=${sourceContent.content.length} chunks=${chunks.length}`,
  );

  const claims = await extractClaimsFromChunks(
    chunks,
    row.sourceType,
    sourceContent.title,
  );

  log.info(
    `processSource: extracted ${claims.length} claims from source=${row.sourceType}:${row.sourceId}`,
  );

  let result = { created: 0, reinforced: 0, skipped: 0 };
  if (claims.length > 0) {
    result = await persistClaims(claims, sourceContent, row);
  }

  await markCompleted(row.id, contentHash);

  log.info(
    `processSource: complete source=${row.sourceType}:${row.sourceId} created=${result.created} reinforced=${result.reinforced} skipped=${result.skipped}`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Build principal from queue row ownership
// ---------------------------------------------------------------------------

function buildOwnerPrincipal(row: MemoryVnextSourceQueueRow): Principal {
  return {
    actorType: "user",
    userId: row.ownerUserId,
    accountId: row.accountId,
    role: "owner",
    scopes: ["user:read", "user:write"],
    permissions: [],
    isAdmin: false,
    impersonation: {
      impersonatedByActorType: "system",
      reason: "vnext-source-poller queue ownership",
    },
    source: "system",
  };
}

// ---------------------------------------------------------------------------
// Main poller entry point
// ---------------------------------------------------------------------------

/**
 * Process settled sources from the extraction queue.
 *
 * Called periodically (every 5 minutes) by a system timer.
 * For each settled source:
 * 1. Mark as processing (prevents concurrent extraction)
 * 2. Load full content, hash, chunk
 * 3. Extract claims from each chunk via v6 prompt
 * 4. Dedup against existing claims (semantic vector search)
 * 5. Create new claims or reinforce existing ones
 * 6. Mark as completed with content hash
 *
 * Each source is processed within its owning user's principal context
 * for multi-user data ownership safety.
 */
export async function processSettledSources(): Promise<{
  processed: number;
  totalCreated: number;
  totalReinforced: number;
  totalSkipped: number;
  errors: number;
}> {
  // Reset any stuck processing rows first (crash recovery)
  await resetStuckProcessing(STUCK_PROCESSING_TIMEOUT_MINUTES);

  const sources = await pollSettledSources(SETTLE_MINUTES, MAX_SOURCES_PER_RUN);

  if (sources.length === 0) {
    log.debug("processSettledSources: no settled sources");
    return {
      processed: 0,
      totalCreated: 0,
      totalReinforced: 0,
      totalSkipped: 0,
      errors: 0,
    };
  }

  log.info(`processSettledSources: found ${sources.length} settled sources`);

  let processed = 0;
  let totalCreated = 0;
  let totalReinforced = 0;
  let totalSkipped = 0;
  let errors = 0;

  for (const row of sources) {
    try {
      await markProcessing(row.id);

      const principal = buildOwnerPrincipal(row);
      const result = await runWithPrincipal(principal, () =>
        processSource(row),
      );

      processed++;
      totalCreated += result.created;
      totalReinforced += result.reinforced;
      totalSkipped += result.skipped;
    } catch (err) {
      errors++;
      log.error(
        `processSettledSources: failed source=${row.sourceType}:${row.sourceId} queueId=${row.id}: ${err instanceof Error ? (err.stack || err.message) : String(err)}`,
      );
      // Leave as "processing" — resetStuckProcessing will recover it next run
    }
  }

  log.info(
    `processSettledSources: complete processed=${processed} created=${totalCreated} reinforced=${totalReinforced} skipped=${totalSkipped} errors=${errors}`,
  );

  return {
    processed,
    totalCreated,
    totalReinforced,
    totalSkipped,
    errors,
  };
}
