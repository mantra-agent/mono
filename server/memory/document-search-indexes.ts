import type { PoolClient } from "pg";
import { and, eq, sql } from "drizzle-orm";
import {
  documentStoreDocuments,
  SESSION_SEARCH_SEGMENT_TEXT_INDEX,
  sessionSearchProjections,
} from "@shared/schema";
import { createLogger } from "../log";
import { createNamedSystemPrincipal, createUserPrincipalFromUser } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { db, runWithDatabaseTransaction } from "../db";
import { storage } from "../storage";
import {
  replaceSessionSearchProjection,
  SESSION_SEARCH_PROJECTION_VERSION,
  type SessionProjectionSource,
} from "./session-search-projection";
import { buildProjectionSessionSearchQuery } from "./session-search-query";

const log = createLogger("DocumentSearchIndexes");
const LOCK_KEY = "session_search_projection_v1";
const START_DELAY_MS = 15_000;
const RETRY_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 15;
const BACKFILL_BATCH_SIZE = 25;
const MAX_BACKFILL_DOCUMENTS_PER_ATTEMPT = 5_000;
const BACKFILL_CUTOFF_DAYS = 30;
const OPERATIONAL_PROBE_TIMEOUT_MS = 10_000;

type EnsureOutcome = "ready" | "busy" | "partial";

type BackfillCandidate = {
  id: number;
  documentId: string;
  ownerUserId: string;
  accountId: string;
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : undefined;
}

async function readIndexState(client: PoolClient): Promise<{ valid: boolean } | null> {
  const result = await client.query<{ indisvalid: boolean }>(
    `SELECT i.indisvalid
       FROM pg_index i
      WHERE i.indexrelid = to_regclass($1)`,
    [SESSION_SEARCH_SEGMENT_TEXT_INDEX],
  );
  return result.rows[0] ? { valid: result.rows[0].indisvalid } : null;
}

async function ensureProjectionSearchIndex(client: PoolClient): Promise<void> {
  const state = await readIndexState(client);
  if (state?.valid) return;
  if (state && !state.valid) {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${SESSION_SEARCH_SEGMENT_TEXT_INDEX}"`);
  }
  log.info(`building concurrent index ${SESSION_SEARCH_SEGMENT_TEXT_INDEX}`);
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS "${SESSION_SEARCH_SEGMENT_TEXT_INDEX}"
    ON session_search_segments USING GIN (text gin_trgm_ops)
  `);
  if (!(await readIndexState(client))?.valid) {
    throw new Error(`Concurrent index ${SESSION_SEARCH_SEGMENT_TEXT_INDEX} did not become ready`);
  }
}

async function readBackfillCandidates(limit: number): Promise<BackfillCandidate[]> {
  const cutoff = new Date(Date.now() - BACKFILL_CUTOFF_DAYS * 24 * 60 * 60 * 1_000);
  return runWithPrincipal(createNamedSystemPrincipal("session-search-backfill"), () =>
    db
      .select({
        id: documentStoreDocuments.id,
        documentId: documentStoreDocuments.documentId,
        ownerUserId: documentStoreDocuments.ownerUserId,
        accountId: documentStoreDocuments.accountId,
      })
      .from(documentStoreDocuments)
      .leftJoin(
        sessionSearchProjections,
        eq(sessionSearchProjections.documentId, documentStoreDocuments.id),
      )
      .where(
        and(
          eq(documentStoreDocuments.documentType, "chat"),
          sql`${documentStoreDocuments.scope} = 'user'`,
          sql`${documentStoreDocuments.ownerUserId} IS NOT NULL`,
          sql`${documentStoreDocuments.accountId} IS NOT NULL`,
          sql`coalesce((${documentStoreDocuments.metadata}->>'messageCount')::int, 0) > 0`,
          sql`${documentStoreDocuments.updatedAt} >= ${cutoff}`,
          sql`(
            ${sessionSearchProjections.documentId} IS NULL
            OR ${sessionSearchProjections.projectionVersion} <> ${SESSION_SEARCH_PROJECTION_VERSION}
            OR ${sessionSearchProjections.sourceUpdatedAt} <> (${documentStoreDocuments.metadata}->>'updatedAt')::timestamptz
          )`,
        ),
      )
      .orderBy(documentStoreDocuments.updatedAt)
      .limit(limit)
      .then((rows) => rows.filter((row): row is BackfillCandidate => Boolean(row.ownerUserId && row.accountId))),
  );
}

async function backfillCandidate(candidate: BackfillCandidate): Promise<"projected" | "skipped"> {
  const user = await runWithPrincipal(
    createNamedSystemPrincipal("session-search-backfill"),
    () => storage.getUser(candidate.ownerUserId),
  );
  if (!user) return "skipped";
  const principal = createUserPrincipalFromUser(user, candidate.accountId);
  return runWithPrincipal(principal, () =>
    db.transaction(async (transaction) =>
      runWithDatabaseTransaction(transaction, async () => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await transaction.execute(sql`SET LOCAL statement_timeout = '15s'`);
        const [document] = await transaction
          .select({
            id: documentStoreDocuments.id,
            documentId: documentStoreDocuments.documentId,
            ownerUserId: documentStoreDocuments.ownerUserId,
            accountId: documentStoreDocuments.accountId,
            content: documentStoreDocuments.content,
            updatedAt: documentStoreDocuments.updatedAt,
          })
          .from(documentStoreDocuments)
          .where(
            and(
              eq(documentStoreDocuments.id, candidate.id),
              eq(documentStoreDocuments.documentType, "chat"),
              eq(documentStoreDocuments.ownerUserId, candidate.ownerUserId),
              eq(documentStoreDocuments.accountId, candidate.accountId),
            ),
          )
          .limit(1)
          .for("update");
        if (!document) return "skipped" as const;
        let source: SessionProjectionSource;
        try {
          source = JSON.parse(document.content) as SessionProjectionSource;
        } catch {
          log.warn(`session search projection skipped invalid chat document id=${document.documentId}`);
          return "skipped" as const;
        }
        if (!Array.isArray(source.messages)) return "skipped" as const;
        await replaceSessionSearchProjection({
          documentId: document.id,
          source,
          sourceContent: document.content,
          sourceUpdatedAt: new Date(source.updatedAt),
        });
        return "projected" as const;
      }),
    ),
  );
}

async function backfillRecentProjection(): Promise<{ projected: number; skipped: number; remaining: boolean }> {
  let projected = 0;
  let skipped = 0;
  while (projected + skipped < MAX_BACKFILL_DOCUMENTS_PER_ATTEMPT) {
    const candidates = await readBackfillCandidates(BACKFILL_BATCH_SIZE);
    if (candidates.length === 0) return { projected, skipped, remaining: false };
    for (const candidate of candidates) {
      try {
        const outcome = await backfillCandidate(candidate);
        if (outcome === "projected") projected += 1;
        else skipped += 1;
      } catch (error) {
        skipped += 1;
        log.warn("session search projection backfill document failed", {
          documentId: candidate.documentId,
          sqlState: errorCode(error),
        });
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return { projected, skipped, remaining: (await readBackfillCandidates(1)).length > 0 };
}

function collectIndexNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectIndexNames(item, names);
    return names;
  }
  if (!value || typeof value !== "object") return names;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "Index Name" && typeof nested === "string") names.add(nested);
    else collectIndexNames(nested, names);
  }
  return names;
}

async function verifyOperationalQuery(client: PoolClient): Promise<"verified" | "unavailable"> {
  const cutoffIso = new Date(Date.now() - BACKFILL_CUTOFF_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const scope = await client.query<{
    owner_user_id: string;
    account_id: string;
    vault_id: string | null;
    probe_term: string;
  }>(
    `SELECT d.owner_user_id, d.account_id, d.vault_id,
            substring(s.text FROM '([[:alnum:]][[:alnum:]_-]{4,31})') AS probe_term
       FROM session_search_segments s
       JOIN session_search_projections p ON p.document_id = s.document_id
       JOIN document_store_documents d ON d.id = s.document_id
      WHERE d.document_type = 'chat'
        AND d.scope = 'user'
        AND d.owner_user_id IS NOT NULL
        AND d.account_id IS NOT NULL
        AND p.projection_version = $1
        AND p.source_updated_at = (d.metadata->>'updatedAt')::timestamptz
        AND d.updated_at >= $2
        AND substring(s.text FROM '([[:alnum:]][[:alnum:]_-]{4,31})') IS NOT NULL
      ORDER BY d.updated_at DESC
      LIMIT 1`,
    [SESSION_SEARCH_PROJECTION_VERSION, cutoffIso],
  );
  const row = scope.rows[0];
  if (!row) return "unavailable";
  const principal = {
    actorType: "user" as const,
    userId: row.owner_user_id,
    accountId: row.account_id,
    role: "owner",
    scopes: ["user:read"],
    permissions: [],
    isAdmin: false,
    impersonation: null,
    source: "session" as const,
    visibleVaultIds: row.vault_id ? [row.vault_id] : [],
    activeVaultId: row.vault_id ?? undefined,
  };
  const query = buildProjectionSessionSearchQuery(principal, cutoffIso, row.probe_term, 20).toSQL();
  await client.query(`SET statement_timeout TO '${OPERATIONAL_PROBE_TIMEOUT_MS}ms'`);
  const startedAt = performance.now();
  try {
    const result = await client.query<Record<string, unknown>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
      query.params,
    );
    const rawPlan = result.rows[0]?.["QUERY PLAN"];
    const payload = typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan;
    const indexes = collectIndexNames(payload);
    if (!indexes.has(SESSION_SEARCH_SEGMENT_TEXT_INDEX)) {
      throw new Error("Session projection query missed its trigram index");
    }
    log.info("session search projection operational probe verified", {
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      index: SESSION_SEARCH_SEGMENT_TEXT_INDEX,
    });
    return "verified";
  } finally {
    await client.query("SET statement_timeout TO '15min'");
  }
}

export async function ensureDocumentStoreSearchIndexes(): Promise<EnsureOutcome> {
  const { pool } = await import("../db");
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query("SET lock_timeout TO '30s'");
    await client.query("SET statement_timeout TO '15min'");
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [LOCK_KEY],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) return "busy";
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await ensureProjectionSearchIndex(client);
    const backfill = await backfillRecentProjection();
    const probe = await verifyOperationalQuery(client);
    log.info("session search projection maintenance complete", {
      projected: backfill.projected,
      skipped: backfill.skipped,
      remaining: backfill.remaining,
      probe,
    });
    return backfill.remaining ? "partial" : "ready";
  } finally {
    let discardClient = false;
    try {
      await client.query("RESET lock_timeout");
      await client.query("RESET statement_timeout");
      if (lockAcquired) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
    } catch (error) {
      discardClient = true;
      log.warn("failed to reset session search maintenance connection", { sqlState: errorCode(error) });
    } finally {
      client.release(discardClient);
    }
  }
}

let maintenanceStarted = false;

export function startDocumentStoreSearchIndexMaintenance(): void {
  if (maintenanceStarted) return;
  maintenanceStarted = true;
  let attempt = 0;
  const run = async () => {
    attempt += 1;
    try {
      const outcome = await ensureDocumentStoreSearchIndexes();
      if (outcome === "ready") return;
      log.debug(`session search maintenance outcome=${outcome} attempt=${attempt}`);
    } catch (error) {
      log.warn("session search projection maintenance failed", { attempt, sqlState: errorCode(error) });
    }
    if (attempt >= MAX_ATTEMPTS) {
      log.error(`session search projection not confirmed after ${MAX_ATTEMPTS} attempts`);
      return;
    }
    setTimeout(run, RETRY_DELAY_MS).unref();
  };
  setTimeout(run, START_DELAY_MS).unref();
}
