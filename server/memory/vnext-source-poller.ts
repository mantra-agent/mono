import { createLogger } from "../log";
import { createNamedSystemPrincipal, type Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import type { MemoryVnextSourceQueueRow, MemorySource } from "@shared/schema";
import { parseReferenceText } from "@shared/reference-parser";
import {
  pollSettledSources,
  markProcessing,
  markCompleted,
  resetStuckProcessing,
  cleanupAutonomousSessionSources,
} from "./vnext-source-queue";
import {
  buildFullSessionContent,
  buildLibraryPageContent,
  chunkContent,
  hashContent,
  buildChunkHeader,
} from "./vnext-content-chunking";
import { applyObservation } from "./vnext-claim-storage";
import {
  extractObservationFromChunk,
  deduplicateChunkClaims,
  type ClaimCandidate,
  type ObservationRelationshipCandidate,
} from "./vnext-claim-extraction";

const log = createLogger("VnextSourcePoller");

/** How many minutes a source must be quiet before extraction */
const SETTLE_MINUTES = 30;

/** Max sources to process per poller run */
const MAX_SOURCES_PER_RUN = 10;

/** Max claims per source across all chunks */
const MAX_CLAIMS_PER_SOURCE = 3;

// Re-extraction absence is not contradiction, supersession, or evidence against a claim.

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

interface ExtractedChunkClaim {
  claim: ClaimCandidate;
  chunk: string;
}

interface ExtractedSourceObservation {
  claims: ExtractedChunkClaim[];
  relationships: ObservationRelationshipCandidate[];
}

function buildSessionPageSourceRefs(chunk: string) {
  const pageIds = new Set(
    parseReferenceText(chunk)
      .filter((part) => part.kind === "reference" && part.ref.type === "page")
      .map((part) => part.kind === "reference" ? part.ref.id : ""),
  );

  return [...pageIds].map((pageId) => ({
    sourceType: "library_page",
    sourceId: pageId,
    relationship: "used_as_evidence",
    context: "Canonical page reference in the supporting session chunk",
    strength: 1,
  }));
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

async function extractObservationFromChunks(
  chunks: string[],
  source: string,
  title: string,
): Promise<ExtractedSourceObservation> {
  const extracted: ExtractedChunkClaim[] = [];
  const relationships: ObservationRelationshipCandidate[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const observation = await extractObservationFromChunk(
        chunks[i],
        i,
        chunks.length,
        source,
        title,
      );
      const indexOffset = extracted.length;
      extracted.push(...observation.claims.map((claim) => ({ claim, chunk: chunks[i] })));
      relationships.push(...observation.relationships.map((relationship) => ({
        ...relationship,
        fromClaimIndex: relationship.fromClaimIndex + indexOffset,
        toClaimIndex: relationship.toClaimIndex + indexOffset,
      })));
    } catch (err) {
      log.warn(
        `extractObservationFromChunks: chunk ${i + 1}/${chunks.length} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const deduplicatedClaims = deduplicateChunkClaims(extracted.map(({ claim }) => claim));
  const claims = deduplicatedClaims
    .map((claim) => extracted.find((item) => item.claim === claim))
    .filter((item): item is ExtractedChunkClaim => !!item)
    .slice(0, MAX_CLAIMS_PER_SOURCE);
  const survivingIndexByOriginal = new Map<number, number>();
  claims.forEach((item, index) => survivingIndexByOriginal.set(extracted.indexOf(item), index));
  return {
    claims,
    relationships: relationships.flatMap((relationship) => {
      const fromClaimIndex = survivingIndexByOriginal.get(relationship.fromClaimIndex);
      const toClaimIndex = survivingIndexByOriginal.get(relationship.toClaimIndex);
      return fromClaimIndex == null || toClaimIndex == null
        ? []
        : [{ ...relationship, fromClaimIndex, toClaimIndex }];
    }),
  };
}

// ---------------------------------------------------------------------------
// Claim persistence — delegates to canonical persistClaimCandidates
// ---------------------------------------------------------------------------

async function persistPollerObservation(
  observation: ExtractedSourceObservation,
  sourceContent: SourceContent,
  row: MemoryVnextSourceQueueRow,
): Promise<{ created: number; reinforced: number; skipped: number }> {
  const sourceObservedAt = row.lastModifiedAt;
  const sourceRefsByClaim = Object.fromEntries(observation.claims.map(({ claim, chunk }, index) => [index, [
    {
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      relationship: "extracted_from",
      context: `Extracted by vNext source poller from ${row.sourceType}`,
      quote: claim.evidenceQuote || null,
      strength: 1,
      clarity: claim.clarity ?? claim.confidence,
      certainty: claim.confidence,
      sourceObservedAt,
      sourceLineageKey: `${row.sourceType}:${row.sourceId}`,
      independence: "unknown" as const,
      producerMethod: "claim_observation_extraction",
      derivationVersion: "vnext-observation-v1",
      provenance: { queueId: row.id, chunkLength: chunk.length },
    },
    ...(row.sourceType === "session" ? buildSessionPageSourceRefs(chunk) : []),
  ]]));
  const result = await applyObservation({
    claims: observation.claims.map(({ claim }) => claim),
    relationships: observation.relationships,
    source: sourceContent.sourceType,
    sourceId: row.sourceId,
    sourceMemoryId: null,
    sourceRefsByClaim,
    createdAt: sourceObservedAt,
    metadata: { extractedBy: "vnext-source-poller", observationSchema: "vnext-observation-v1" },
    logPrefix: "pollerObservation",
  });
  return { created: result.created, reinforced: result.reinforced, skipped: result.skipped };
}

// ---------------------------------------------------------------------------
// Single source processing
// ---------------------------------------------------------------------------

interface ProcessSourceResult {
  created: number;
  reinforced: number;
  skipped: number;
  decayed: number;
  retirementCandidates: number;
}

async function processSource(
  row: MemoryVnextSourceQueueRow,
): Promise<ProcessSourceResult> {
  log.info(
    `processSource: start source=${row.sourceType}:${row.sourceId} queueId=${row.id}`,
  );

  const sourceContent = await loadSourceContent(row);
  if (!sourceContent) {
    log.info(
      `processSource: no content source=${row.sourceType}:${row.sourceId}, marking completed`,
    );
    await markCompleted(row.id, "empty");
    return { created: 0, reinforced: 0, skipped: 0, decayed: 0, retirementCandidates: 0 };
  }

  // Hash check — skip if content unchanged since last extraction
  const contentHash = hashContent(sourceContent.content);
  if (row.contentHash && row.contentHash === contentHash) {
    log.debug(
      `processSource: unchanged source=${row.sourceType}:${row.sourceId} hash=${contentHash.slice(0, 8)}`,
    );
    await markCompleted(row.id, contentHash);
    return { created: 0, reinforced: 0, skipped: 0, decayed: 0, retirementCandidates: 0 };
  }

  if (row.lastExtractedAt) {
    log.debug(`processSource: re-extraction preserves unreproduced claims source=${row.sourceType}:${row.sourceId}`);
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

  const observation = await extractObservationFromChunks(
    chunks,
    row.sourceType,
    sourceContent.title,
  );

  log.info(
    `processSource: extracted ${observation.claims.length} claims and ${observation.relationships.length} relationships from source=${row.sourceType}:${row.sourceId}`,
  );

  let result: ProcessSourceResult = { created: 0, reinforced: 0, skipped: 0, decayed: 0, retirementCandidates: 0 };
  if (observation.claims.length > 0) {
    const persistResult = await persistPollerObservation(observation, sourceContent, row);
    result.created = persistResult.created;
    result.reinforced = persistResult.reinforced;
    result.skipped = persistResult.skipped;
  }

  // Absence from a re-extraction pass is not negative evidence. Existing claims,
  // certainty, lifecycle stage, and availability remain unchanged.

  await markCompleted(row.id, contentHash);

  log.info(
    `processSource: complete source=${row.sourceType}:${row.sourceId} created=${result.created} reinforced=${result.reinforced} skipped=${result.skipped} decayed=${result.decayed} retirementCandidates=${result.retirementCandidates}`,
  );

  return result;
}

// Re-extraction intentionally has no negative-evidence reconciliation. Explicit
// contradiction or supersession relationships own any future certainty change.

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
  totalDecayed: number;
  totalRetirementCandidates: number;
  errors: number;
}> {
  const hashBackfill = await runWithPrincipal(
    createNamedSystemPrincipal("memory-maintenance"),
    () => memoryVnextClaimStorage.backfillOwnerScopedContentHashes(250),
  );
  if (hashBackfill > 0) {
    log.info(`processSettledSources: owner-scoped content hashes updated=${hashBackfill}`);
  }

  // Migrate a bounded legacy Preference batch before normal extraction.
  // Each record restores its owning principal, persists through the canonical
  // vNext boundary, and is deleted only after durable admission succeeds.
  const { migrateAuditedRules } = await import("./legacy-rule-migration");
  const ruleMigration = await migrateAuditedRules();
  if (ruleMigration.scanned > 0 || ruleMigration.restored > 0 || ruleMigration.errors > 0) {
    log.info(
      `processSettledSources: Rule audit scanned=${ruleMigration.scanned} retained=${ruleMigration.retained} restored=${ruleMigration.restored} deleted=${ruleMigration.deleted} errors=${ruleMigration.errors}`,
    );
  }

  const { migrateLegacyPreferences } = await import("./legacy-preference-migration");
  const preferenceMigration = await migrateLegacyPreferences();
  if (preferenceMigration.scanned > 0 || preferenceMigration.errors > 0) {
    log.info(
      `processSettledSources: preference migration scanned=${preferenceMigration.scanned} migrated=${preferenceMigration.migrated} errors=${preferenceMigration.errors}`,
    );
  }

  // Repair legacy active claims before new extraction. The backfill method is
  // bounded and runs inside each settled source owner's principal context.

  // Repair legacy autonomous rows before polling. This is bounded and
  // idempotent, and includes completed rows that would never be polled again.
  const cleanup = await cleanupAutonomousSessionSources(100);
  if (cleanup.removed > 0) {
    log.info(`processSettledSources: autonomous cleanup scanned=${cleanup.scanned} removed=${cleanup.removed}`);
  }

  // Reset any stuck processing rows first (crash recovery)
  await resetStuckProcessing(STUCK_PROCESSING_TIMEOUT_MINUTES);

  const migrationErrors = ruleMigration.errors + preferenceMigration.errors;
  const sources = await pollSettledSources(SETTLE_MINUTES, MAX_SOURCES_PER_RUN);

  if (sources.length === 0) {
    log.debug("processSettledSources: no settled sources");
    return {
      processed: 0,
      totalCreated: 0,
      totalReinforced: 0,
      totalSkipped: 0,
      totalDecayed: 0,
      totalRetirementCandidates: 0,
      errors: migrationErrors,
    };
  }

  log.info(`processSettledSources: found ${sources.length} settled sources`);

  let processed = 0;
  let totalCreated = 0;
  let totalReinforced = 0;
  let totalSkipped = 0;
  let totalDecayed = 0;
  let totalRetirementCandidates = 0;
  let errors = migrationErrors;

  for (const row of sources) {
    try {
      await markProcessing(row.id);

      const principal = buildOwnerPrincipal(row);
      const result = await runWithPrincipal(principal, async () => {
        const backfill = await memoryVnextClaimStorage.backfillMissingActiveEmbeddings(25);
        if (backfill.errors > 0) {
          throw new Error(
            `vNext embedding backfill incomplete for owner=${principal.userId}: ${backfill.errors} error(s)`,
          );
        }
        return processSource(row);
      });

      processed++;
      totalCreated += result.created;
      totalReinforced += result.reinforced;
      totalSkipped += result.skipped;
      totalDecayed += result.decayed;
      totalRetirementCandidates += result.retirementCandidates;
    } catch (err) {
      errors++;
      log.error(
        `processSettledSources: failed source=${row.sourceType}:${row.sourceId} queueId=${row.id}: ${err instanceof Error ? (err.stack || err.message) : String(err)}`,
      );
      // Leave as "processing" — resetStuckProcessing will recover it next run
    }
  }

  log.info(
    `processSettledSources: complete processed=${processed} created=${totalCreated} reinforced=${totalReinforced} skipped=${totalSkipped} decayed=${totalDecayed} retirementCandidates=${totalRetirementCandidates} errors=${errors}`,
  );

  return {
    processed,
    totalCreated,
    totalReinforced,
    totalSkipped,
    totalDecayed,
    totalRetirementCandidates,
    errors,
  };
}
