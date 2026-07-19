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
import {
  memoryVnextClaimStorage,
  persistClaimCandidates,
} from "./vnext-claim-storage";
import {
  extractClaimsFromChunk,
  deduplicateChunkClaims,
  type ClaimCandidate,
} from "./vnext-claim-extraction";

const log = createLogger("VnextSourcePoller");

/** How many minutes a source must be quiet before extraction */
const SETTLE_MINUTES = 30;

/** Max sources to process per poller run */
const MAX_SOURCES_PER_RUN = 10;

/** Max claims per source across all chunks */
const MAX_CLAIMS_PER_SOURCE = 3;

/** Confidence decay per re-extraction miss */
const RECONCILIATION_DECAY_DELTA = 0.1;

/** Confidence at or below which claims become retirement candidates */
const RETIREMENT_CONFIDENCE_THRESHOLD = 0.1;

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

async function extractClaimsFromChunks(
  chunks: string[],
  source: string,
  title: string,
): Promise<ExtractedChunkClaim[]> {
  const extracted: ExtractedChunkClaim[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const claims = await extractClaimsFromChunk(
        chunks[i],
        i,
        chunks.length,
        source,
        title,
      );
      extracted.push(...claims.map((claim) => ({ claim, chunk: chunks[i] })));
    } catch (err) {
      log.warn(
        `extractClaimsFromChunks: chunk ${i + 1}/${chunks.length} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const deduplicatedClaims = deduplicateChunkClaims(extracted.map(({ claim }) => claim));
  return deduplicatedClaims
    .map((claim) => extracted.find((item) => item.claim === claim))
    .filter((item): item is ExtractedChunkClaim => !!item)
    .slice(0, MAX_CLAIMS_PER_SOURCE);
}

// ---------------------------------------------------------------------------
// Claim persistence — delegates to canonical persistClaimCandidates
// ---------------------------------------------------------------------------

async function persistPollerClaims(
  extractedClaims: ExtractedChunkClaim[],
  sourceContent: SourceContent,
  row: MemoryVnextSourceQueueRow,
): Promise<{ created: number; reinforced: number; skipped: number }> {
  const totals = { created: 0, reinforced: 0, skipped: 0 };

  for (const { claim, chunk } of extractedClaims) {
    const sourceRefs = [
      {
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        relationship: "extracted_from",
        context: `Extracted by vNext source poller from ${row.sourceType}`,
        strength: 1,
      },
      ...(row.sourceType === "session" ? buildSessionPageSourceRefs(chunk) : []),
    ];
    const result = await persistClaimCandidates({
      claims: [claim],
      source: sourceContent.sourceType,
      sourceId: row.sourceId,
      sourceMemoryId: null,
      sourceRefs,
      metadata: { extractedBy: "vnext-source-poller" },
      logPrefix: "pollerPersist",
    });
    totals.created += result.created;
    totals.reinforced += result.reinforced;
    totals.skipped += result.skipped;
  }

  return totals;
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

  // Detect re-extraction: if lastExtractedAt is set, this source was previously processed
  const isReExtraction = !!row.lastExtractedAt;

  // Collect existing claim content hashes before extraction for reconciliation
  let preExistingClaimIds: Set<number> | undefined;
  if (isReExtraction) {
    const existingClaims = await memoryVnextClaimStorage.findClaimsBySourceOrigin(
      sourceContent.sourceType,
      row.sourceId,
    );
    preExistingClaimIds = new Set(existingClaims.map((c) => c.id));
    log.info(
      `processSource: re-extraction detected, ${preExistingClaimIds.size} existing claims for source=${row.sourceType}:${row.sourceId}`,
    );
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

  const extractedClaims = await extractClaimsFromChunks(
    chunks,
    row.sourceType,
    sourceContent.title,
  );

  log.info(
    `processSource: extracted ${extractedClaims.length} claims from source=${row.sourceType}:${row.sourceId}`,
  );

  let result: ProcessSourceResult = { created: 0, reinforced: 0, skipped: 0, decayed: 0, retirementCandidates: 0 };
  if (extractedClaims.length > 0) {
    const persistResult = await persistPollerClaims(extractedClaims, sourceContent, row);
    result.created = persistResult.created;
    result.reinforced = persistResult.reinforced;
    result.skipped = persistResult.skipped;
  }

  // Reconciliation: decay claims that were NOT re-produced during re-extraction
  if (isReExtraction && preExistingClaimIds && preExistingClaimIds.size > 0) {
    const reconcileResult = await reconcileStaleClaimsAfterReExtraction(
      preExistingClaimIds,
      sourceContent.sourceType,
      row.sourceId,
    );
    result.decayed = reconcileResult.decayed;
    result.retirementCandidates = reconcileResult.retirementCandidates;
  }

  await markCompleted(row.id, contentHash);

  log.info(
    `processSource: complete source=${row.sourceType}:${row.sourceId} created=${result.created} reinforced=${result.reinforced} skipped=${result.skipped} decayed=${result.decayed} retirementCandidates=${result.retirementCandidates}`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Reconciliation: decay unreproduced claims after re-extraction
// ---------------------------------------------------------------------------

/**
 * After re-extracting claims from an edited source, compare the current
 * set of claims from that source against the pre-existing set.
 *
 * Claims that were reinforced during persistence (semantic dedup match)
 * will have a bumped recallCount/lastRecalledAt. Claims that were NOT
 * re-produced get their confidence decayed. Claims at or below the
 * retirement threshold become candidates for retirement.
 */
async function reconcileStaleClaimsAfterReExtraction(
  preExistingClaimIds: Set<number>,
  source: string,
  sourceId: string,
): Promise<{ decayed: number; retirementCandidates: number }> {
  // Re-fetch the claims to see which ones were reinforced (updated recently)
  const currentClaims = await memoryVnextClaimStorage.findClaimsBySourceOrigin(
    source,
    sourceId,
  );

  // Claims that were reinforced will have lastRecalledAt updated during this run
  // We use a 5-minute window to detect "just reinforced"
  const recentThreshold = new Date(Date.now() - 5 * 60 * 1000);

  let decayed = 0;
  let retirementCandidates = 0;

  for (const claim of currentClaims) {
    if (!preExistingClaimIds.has(claim.id)) {
      // Newly created claim, not a pre-existing one
      continue;
    }

    // Check if this claim was reinforced during the current extraction
    const wasReinforced =
      claim.lastRecalledAt && claim.lastRecalledAt > recentThreshold;

    if (wasReinforced) {
      log.debug(
        `reconcile: claim #${claim.id} reinforced, skipping decay`,
      );
      continue;
    }

    // This pre-existing claim was NOT re-produced — decay confidence
    const updated = await memoryVnextClaimStorage.decayClaimConfidence(
      claim.id,
      RECONCILIATION_DECAY_DELTA,
    );

    if (updated) {
      decayed++;
      if (updated.confidence <= RETIREMENT_CONFIDENCE_THRESHOLD) {
        retirementCandidates++;
        log.info(
          `reconcile: claim #${claim.id} confidence=${updated.confidence.toFixed(2)} is retirement candidate`,
        );
      } else {
        log.debug(
          `reconcile: claim #${claim.id} confidence decayed to ${updated.confidence.toFixed(2)}`,
        );
      }
    }
  }

  if (decayed > 0) {
    log.info(
      `reconcile: source=${source}:${sourceId} decayed=${decayed} retirementCandidates=${retirementCandidates}`,
    );
  }

  return { decayed, retirementCandidates };
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
