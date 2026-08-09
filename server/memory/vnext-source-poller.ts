import { createLogger } from "../log";
import { createNamedSystemPrincipal, type Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { getPostgresErrorDetails } from "../postgres-errors";
import type { MemoryVnextSourceQueueRow, MemorySource } from "@shared/schema";
import { parseReferenceText } from "@shared/reference-parser";
import {
  bindNextSettledSourceRuntime,
  completeSourceForRuntime,
  withSourceRuntimeFence,
  resetLegacyStuckProcessing,
  cleanupAutonomousSessionSources,
} from "./vnext-source-queue";
import {
  chunkContent,
  hashContent,
  buildChunkHeader,
} from "./vnext-content-chunking";
import { applyObservation, memoryVnextClaimStorage } from "./vnext-claim-storage";
import {
  extractObservationFromChunk,
  deduplicateChunkClaims,
  type ClaimCandidate,
  type ObservationRelationshipCandidate,
} from "./vnext-claim-extraction";
import { loadSemanticSourceContent } from "./semantic-source-adapters";
import { replaceVnextSourceLinks } from "./vnext-source-linking";

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
// Source content loading (SemanticSourceAdapter registry)
// ---------------------------------------------------------------------------

interface SourceContent {
  content: string;
  fingerprint: string | null;
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
  const envelope = await loadSemanticSourceContent(row.sourceType, row.sourceId);
  if (!envelope) return null;

  return {
    content: envelope.content,
    fingerprint: envelope.fingerprint,
    title: envelope.title,
    topics: envelope.topics,
    splitMode: envelope.splitMode,
    sourceType: envelope.observationSource,
  };
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

export async function processSourceForRuntime(
  row: MemoryVnextSourceQueueRow,
  fence: { runId: string; attemptId: string; leaseEpoch: number },
  principal: Principal,
): Promise<ProcessSourceResult> {
  log.info(
    `processSource: start source=${row.sourceType}:${row.sourceId} queueId=${row.id}`,
  );

  const sourceContent = await loadSourceContent(row);
  if (!sourceContent) {
    log.info(
      `processSource: no content source=${row.sourceType}:${row.sourceId}, marking completed`,
    );
    if (!await completeSourceForRuntime(row.id, row.lastModifiedAt, fence, "empty", principal)) {
      throw Object.assign(new Error("Memory source Runtime fence changed before empty completion"), { code: "stale_fence" });
    }
    return { created: 0, reinforced: 0, skipped: 0, decayed: 0, retirementCandidates: 0 };
  }

  // Hash check — skip if content unchanged since last extraction
  const contentHash = hashContent(sourceContent.content);
  if (row.contentHash && row.contentHash === contentHash) {
    log.debug(
      `processSource: unchanged source=${row.sourceType}:${row.sourceId} hash=${contentHash.slice(0, 8)}`,
    );
    if (!await completeSourceForRuntime(row.id, row.lastModifiedAt, fence, contentHash, principal)) {
      throw Object.assign(new Error("Memory source Runtime fence changed before unchanged completion"), { code: "stale_fence" });
    }
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
    const persistResult = await withSourceRuntimeFence(
      row.id,
      row.lastModifiedAt,
      fence,
      principal,
      async () => {
        const persisted = await persistPollerObservation(observation, sourceContent, row);
        if (row.sourceType === "drive_file") {
          await replaceVnextSourceLinks({
            principal,
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            sourceRevision: sourceContent.fingerprint ?? hashContent(sourceContent.content),
            sourceAddress: `@file:${row.sourceId}`,
            content: sourceContent.content,
            claims: observation.claims.map(({ claim }) => claim),
            observedAt: row.lastModifiedAt,
          });
        }
        return persisted;
      },
    );
    result.created = persistResult.created;
    result.reinforced = persistResult.reinforced;
    result.skipped = persistResult.skipped;
  } else if (row.sourceType === "drive_file") {
    await withSourceRuntimeFence(row.id, row.lastModifiedAt, fence, principal, () =>
      replaceVnextSourceLinks({
        principal,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        sourceRevision: sourceContent.fingerprint ?? hashContent(sourceContent.content),
        sourceAddress: `@file:${row.sourceId}`,
        content: sourceContent.content,
        claims: [],
        observedAt: row.lastModifiedAt,
      }),
    );
  }

  // Absence from a re-extraction pass is not negative evidence. Existing claims,
  // certainty, lifecycle stage, and availability remain unchanged.

  if (!await completeSourceForRuntime(row.id, row.lastModifiedAt, fence, contentHash, principal)) {
    throw Object.assign(new Error("Memory source Runtime fence changed before completion"), { code: "stale_fence" });
  }

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
 * Enqueue settled source versions into the Autonomy Runtime Kernel.
 * Maintenance remains bounded here; execution ownership begins only when the
 * native short-worker handler claims a fenced Runtime attempt.
 */
export async function enqueueSettledSources(): Promise<{
  enqueued: number;
  existing: number;
  errors: number;
}> {
  const hashBackfill = await runWithPrincipal(
    createNamedSystemPrincipal("memory-maintenance"),
    () => memoryVnextClaimStorage.backfillOwnerScopedContentHashes(250),
  );
  if (hashBackfill > 0) {
    log.info(`enqueueSettledSources: owner-scoped content hashes updated=${hashBackfill}`);
  }

  let migrationErrors = 0;
  const { legacyMemoryQuarantineApplied } = await import(
    "./legacy-memory-quarantine"
  );
  if (!(await legacyMemoryQuarantineApplied())) {
    // Legacy Rule/Preference migration remains bounded until the quarantine
    // epoch applies. Afterward vNext and document storage are authoritative.
    const { migrateAuditedRules } = await import("./legacy-rule-migration");
    const ruleMigration = await migrateAuditedRules();
    if (
      ruleMigration.scanned > 0 ||
      ruleMigration.restored > 0 ||
      ruleMigration.errors > 0
    ) {
      log.info(
        `enqueueSettledSources: Rule audit scanned=${ruleMigration.scanned} retained=${ruleMigration.retained} restored=${ruleMigration.restored} deleted=${ruleMigration.deleted} errors=${ruleMigration.errors}`,
      );
    }

    const { migrateLegacyPreferences } = await import(
      "./legacy-preference-migration"
    );
    const preferenceMigration = await migrateLegacyPreferences();
    if (preferenceMigration.scanned > 0 || preferenceMigration.errors > 0) {
      log.info(
        `enqueueSettledSources: preference migration scanned=${preferenceMigration.scanned} migrated=${preferenceMigration.migrated} errors=${preferenceMigration.errors}`,
      );
    }
    migrationErrors = ruleMigration.errors + preferenceMigration.errors;
  }

  // Repair legacy active claims before new extraction. The backfill method is
  // bounded and runs inside each settled source owner's principal context.

  // Repair legacy autonomous rows before polling. This is bounded and
  // idempotent, and includes completed rows that would never be polled again.
  const cleanup = await cleanupAutonomousSessionSources(100);
  if (cleanup.removed > 0) {
    log.info(`enqueueSettledSources: autonomous cleanup scanned=${cleanup.scanned} removed=${cleanup.removed}`);
  }

  // Recover only pre-cutover legacy rows. Runtime-bound source projections are
  // reclaimed solely by the kernel's expired-attempt reconciliation.
  await resetLegacyStuckProcessing(STUCK_PROCESSING_TIMEOUT_MINUTES);

  let enqueued = 0;
  let existing = 0;
  let errors = migrationErrors;

  for (let index = 0; index < MAX_SOURCES_PER_RUN; index++) {
    let attemptedRow: MemoryVnextSourceQueueRow | null = null;
    try {
      const claimed = await bindNextSettledSourceRuntime(SETTLE_MINUTES, async (row) => {
        attemptedRow = row;
        const principal = buildOwnerPrincipal(row);
        return runWithPrincipal(principal, async () => {
          const { enqueueMemorySourceRuntimeRun } = await import("../runtime/proof-path-handlers");
          const result = await enqueueMemorySourceRuntimeRun(principal, row);
          return { runId: result.run.id, disposition: result.disposition };
        });
      });
      if (!claimed) break;
      if (claimed.disposition === "created") enqueued++;
      else existing++;
    } catch (err) {
      errors++;
      const errorDetails = getPostgresErrorDetails(err);
      log.error(JSON.stringify({
        event: "memory.vnext.source_enqueue_failed",
        sourceType: attemptedRow?.sourceType ?? "unknown",
        queueId: attemptedRow?.id ?? null,
        ...errorDetails,
      }));
      // The failed transaction releases this row unchanged. Stop this bounded
      // pass rather than selecting and failing the same oldest source again.
      break;
    }
  }

  if (enqueued === 0 && existing === 0) {
    log.debug("enqueueSettledSources: no settled sources");
  }
  log.info(`enqueueSettledSources: complete enqueued=${enqueued} existing=${existing} errors=${errors}`);
  return { enqueued, existing, errors };
}
