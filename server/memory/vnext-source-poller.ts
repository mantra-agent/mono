import { createLogger } from "../log";
import { createNamedSystemPrincipal, createUserPrincipalFromUser, type Principal } from "../principal";
import { storage } from "../storage";
import { getUserEffectivePermissions } from "../permissions";
import { runWithPrincipal } from "../principal-context";
import { getPostgresErrorDetails } from "../postgres-errors";
import type { MemoryVnextSourceQueueRow, MemorySource } from "@shared/schema";
import { parseReferenceText } from "@shared/reference-parser";
import {
  pollSettledSources,
  resetStuckProcessing,
  cleanupAutonomousSessionSources,
  getByIdForRuntime,
  linkRuntimeRun,
  markCompletedForRuntime,
} from "./vnext-source-queue";
import {
  buildFullSessionContent,
  buildLibraryPageContent,
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

const log = createLogger("VnextSourcePoller");

/** How many minutes a source must be quiet before extraction */
const SETTLE_MINUTES = 30;

/** Max sources to process per poller run */
const MAX_SOURCES_PER_RUN = 10;

/** Max claims per source across all chunks */
const MAX_CLAIMS_PER_SOURCE = 3;

// Re-extraction absence is not contradiction, supersession, or evidence against a claim.

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
  effectIdempotencyKey: string,
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
      provenance: { queueId: row.id, sourceVersion: row.sourceVersion, effectIdempotencyKey, chunkLength: chunk.length },
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

export async function processRuntimeMemorySource(
  row: MemoryVnextSourceQueueRow,
  runtimeRunId: string,
  principal: Principal,
  effectIdempotencyKey: string,
): Promise<ProcessSourceResult & { contentHash: string }> {
  log.info(
    `processSource: start source=${row.sourceType}:${row.sourceId} queueId=${row.id}`,
  );

  const sourceContent = await loadSourceContent(row);
  if (!sourceContent) {
    log.info(
      `processSource: no content source=${row.sourceType}:${row.sourceId}, marking completed`,
    );
    const completed = await markCompletedForRuntime(row.id, row.sourceVersion, runtimeRunId, "empty", principal);
    if (!completed) throw Object.assign(new Error("Memory source version was superseded"), { code: "source_version_superseded" });
    return { created: 0, reinforced: 0, skipped: 0, decayed: 0, retirementCandidates: 0, contentHash: "empty" };
  }

  // Hash check — skip if content unchanged since last extraction
  const contentHash = hashContent(sourceContent.content);
  if (row.contentHash && row.contentHash === contentHash) {
    log.debug(
      `processSource: unchanged source=${row.sourceType}:${row.sourceId} hash=${contentHash.slice(0, 8)}`,
    );
    const completed = await markCompletedForRuntime(row.id, row.sourceVersion, runtimeRunId, contentHash, principal);
    if (!completed) throw Object.assign(new Error("Memory source version was superseded"), { code: "source_version_superseded" });
    return { created: 0, reinforced: 0, skipped: 0, decayed: 0, retirementCandidates: 0, contentHash };
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
  const currentBeforeMutation = await getByIdForRuntime(row.id, principal);
  if (
    !currentBeforeMutation ||
    currentBeforeMutation.sourceVersion !== row.sourceVersion ||
    currentBeforeMutation.runtimeRunId !== runtimeRunId
  ) {
    throw Object.assign(new Error("Memory source version was superseded"), { code: "source_version_superseded" });
  }

  if (observation.claims.length > 0) {
    const persistResult = await persistPollerObservation(observation, sourceContent, row, effectIdempotencyKey);
    result.created = persistResult.created;
    result.reinforced = persistResult.reinforced;
    result.skipped = persistResult.skipped;
  }

  // Absence from a re-extraction pass is not negative evidence. Existing claims,
  // certainty, lifecycle stage, and availability remain unchanged.

  const completed = await markCompletedForRuntime(
    row.id,
    row.sourceVersion,
    runtimeRunId,
    contentHash,
    principal,
  );
  if (!completed) {
    throw Object.assign(new Error("Memory source version was superseded after extraction"), { code: "source_version_superseded" });
  }

  log.info(
    `processSource: complete source=${row.sourceType}:${row.sourceId} created=${result.created} reinforced=${result.reinforced} skipped=${result.skipped} decayed=${result.decayed} retirementCandidates=${result.retirementCandidates}`,
  );

  return { ...result, contentHash };
}

// Re-extraction intentionally has no negative-evidence reconciliation. Explicit
// contradiction or supersession relationships own any future certainty change.

// ---------------------------------------------------------------------------
// Build principal from queue row ownership
// ---------------------------------------------------------------------------

async function buildOwnerPrincipal(row: MemoryVnextSourceQueueRow): Promise<Principal> {
  if (!row.ownerUserId || !row.accountId) {
    throw new Error(`Memory source ${row.id} has unresolved ownership`);
  }
  const user = await storage.getUser(row.ownerUserId);
  if (!user) throw new Error(`Memory source owner is missing: ${row.id}`);
  const principal = createUserPrincipalFromUser(user, row.accountId);
  principal.permissions = await getUserEffectivePermissions(user.id);
  return principal;
}

// ---------------------------------------------------------------------------
// Main poller entry point
// ---------------------------------------------------------------------------

/**
 * Discover settled source versions and enqueue their canonical runtime intents.
 * This service performs no extraction and owns no execution claim.
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
        `processSettledSources: Rule audit scanned=${ruleMigration.scanned} retained=${ruleMigration.retained} restored=${ruleMigration.restored} deleted=${ruleMigration.deleted} errors=${ruleMigration.errors}`,
      );
    }

    const { migrateLegacyPreferences } = await import(
      "./legacy-preference-migration"
    );
    const preferenceMigration = await migrateLegacyPreferences();
    if (preferenceMigration.scanned > 0 || preferenceMigration.errors > 0) {
      log.info(
        `processSettledSources: preference migration scanned=${preferenceMigration.scanned} migrated=${preferenceMigration.migrated} errors=${preferenceMigration.errors}`,
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
    log.info(`processSettledSources: autonomous cleanup scanned=${cleanup.scanned} removed=${cleanup.removed}`);
  }

  const repairedLegacyProcessing = await resetStuckProcessing(30);
  if (repairedLegacyProcessing > 0) {
    log.warn(`processSettledSources: repaired legacy processing rows=${repairedLegacyProcessing}`);
  }

  const sources = await pollSettledSources(SETTLE_MINUTES, MAX_SOURCES_PER_RUN);
  let enqueued = 0;
  let errors = migrationErrors;
  for (const row of sources) {
    try {
      if (row.runtimeRunId) continue;
      const principal = await buildOwnerPrincipal(row);
      await runWithPrincipal(principal, async () => {
        const backfill = await memoryVnextClaimStorage.backfillMissingActiveEmbeddings(25);
        if (backfill.errors > 0) {
          throw new Error(`vNext embedding backfill incomplete: ${backfill.errors} error(s)`);
        }
        const { enqueueRuntimeRun } = await import("../runtime");
        const result = await enqueueRuntimeRun(principal, {
          kind: "memory.source.process",
          handler: { key: "memory.source.process", version: 1 },
          source: { type: "memory_source", id: String(row.id) },
          idempotencyKey: `memory-source/${row.id}/version/${row.sourceVersion}`,
          deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          inputSchemaVersion: 1,
          input: { queueId: row.id, sourceVersion: row.sourceVersion },
          inputRefs: [],
          authorityPolicyVersionAtEnqueue: "memory-source-v1",
        });
        const linked = await linkRuntimeRun(row.id, row.sourceVersion, result.run.id, principal);
        if (!linked) {
          log.debug(`source enqueue superseded queueId=${row.id} version=${row.sourceVersion}`);
          return;
        }
        enqueued++;
      });
    } catch (err) {
      errors++;
      log.error(JSON.stringify({
        event: "memory.vnext.source_enqueue_failed",
        queueId: row.id,
        ...getPostgresErrorDetails(err),
      }));
    }
  }

  log.info(`processSettledSources: settled=${sources.length} enqueued=${enqueued} errors=${errors}`);
  return {
    processed: enqueued,
    totalCreated: 0,
    totalReinforced: 0,
    totalSkipped: 0,
    totalDecayed: 0,
    totalRetirementCandidates: 0,
    errors,
  };
}
