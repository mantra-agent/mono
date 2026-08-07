import type { PoolClient } from "pg";
import {
  DOCUMENT_STORE_CHAT_SEARCH_INDEXES,
  RETIRED_DOCUMENT_STORE_CHAT_SEARCH_INDEXES,
  SESSION_SEARCH_SEGMENT_INDEX,
} from "@shared/models/memory";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import {
  buildLiteralSubstringPattern,
  buildTargetSessionSearchQuery,
} from "./session-search-query";

const log = createLogger("DocumentSearchIndexes");

const LOCK_KEY = "document_store_chat_trigram_indexes_v3";
const START_DELAY_MS = 15_000;
const RETRY_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 15;
const OPERATIONAL_PROBE_TIMEOUT_MS = 10_000;

const SEARCH_INDEXES = [
  {
    name: DOCUMENT_STORE_CHAT_SEARCH_INDEXES.title,
    table: "document_store_documents",
    method: "GIN",
    expression: "title gin_trgm_ops",
    predicate: "WHERE document_type = 'chat'",
    fastUpdate: "on",
  },
  {
    name: DOCUMENT_STORE_CHAT_SEARCH_INDEXES.content,
    table: "document_store_documents",
    method: "GIN",
    expression: "content gin_trgm_ops",
    predicate: "WHERE document_type = 'chat'",
    fastUpdate: "off",
  },
  {
    name: SESSION_SEARCH_SEGMENT_INDEX,
    table: "session_search_segments",
    method: "GIN",
    expression: "content gin_trgm_ops",
    predicate: "",
    fastUpdate: "off",
  },
] as const;

type EnsureOutcome = "ready" | "busy";
type SearchIndexDefinition = (typeof SEARCH_INDEXES)[number];

type IndexState = {
  valid: boolean;
  relOptions: string[];
};

type VerificationScope = {
  ownerUserId: string;
  accountId: string;
  vaultId: string | null;
  searchTerm: string;
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)
    ? code
    : undefined;
}

/**
 * Stable, machine-classifiable failure for document-store search-index
 * maintenance. `code` is the single discriminant the error-telemetry
 * classifier keys off (probe failed vs indexes not confirmed); the raw
 * PostgreSQL SQLSTATE is preserved separately as safe operational context
 * and never overwrites the stable discriminant.
 */
class DocumentSearchIndexError extends Error {
  readonly code: string;
  readonly sqlState?: string;

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; sqlState?: string } = {},
  ) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "DocumentSearchIndexError";
    this.code = code;
    this.sqlState = options.sqlState;
  }
}

function maintenanceSqlState(error: unknown): string | undefined {
  return error instanceof DocumentSearchIndexError
    ? error.sqlState
    : errorCode(error);
}

async function readIndexState(
  client: PoolClient,
  indexName: string,
): Promise<IndexState | null> {
  const result = await client.query<{
    indisvalid: boolean;
    reloptions: string[] | null;
  }>(
    `SELECT i.indisvalid, c.reloptions
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indexrelid = to_regclass($1)`,
    [indexName],
  );
  const row = result.rows[0];
  return row
    ? { valid: row.indisvalid, relOptions: row.reloptions ?? [] }
    : null;
}

function hasExpectedFastUpdate(
  state: IndexState,
  definition: SearchIndexDefinition,
): boolean {
  const configured = state.relOptions.find((option) =>
    option.startsWith("fastupdate="),
  );
  if (definition.fastUpdate === "off") return configured === "fastupdate=off";
  return configured === undefined || configured === "fastupdate=on";
}

async function convergeFastUpdate(
  client: PoolClient,
  definition: SearchIndexDefinition,
): Promise<void> {
  await client.query(
    `ALTER INDEX "${definition.name}" SET (fastupdate = ${definition.fastUpdate})`,
  );
  if (definition.fastUpdate === "off") {
    await client.query("SELECT gin_clean_pending_list(to_regclass($1))", [
      definition.name,
    ]);
  }
}

async function ensureSearchIndex(
  client: PoolClient,
  definition: SearchIndexDefinition,
): Promise<void> {
  const state = await readIndexState(client, definition.name);
  if (state?.valid === true) {
    if (!hasExpectedFastUpdate(state, definition)) {
      log.warn(
        `converging GIN update policy index=${definition.name} fastupdate=${definition.fastUpdate}`,
      );
      await convergeFastUpdate(client, definition);
    }
    return;
  }

  if (state?.valid === false) {
    log.warn(`dropping invalid concurrent index ${definition.name} before retry`);
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${definition.name}"`);
  }

  log.info(
    `building concurrent index ${definition.name} fastupdate=${definition.fastUpdate}`,
  );
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS "${definition.name}"
    ON ${definition.table} USING ${definition.method} (${definition.expression})
    WITH (fastupdate = ${definition.fastUpdate})
    ${definition.predicate}
  `);

  const createdState = await readIndexState(client, definition.name);
  if (!createdState?.valid || !hasExpectedFastUpdate(createdState, definition)) {
    throw new Error(`Concurrent index ${definition.name} did not become ready`);
  }
}

async function readVerificationScope(
  client: PoolClient,
  cutoffIso: string,
): Promise<VerificationScope | null> {
  const result = await client.query<{
    owner_user_id: string;
    account_id: string;
    vault_id: string | null;
    probe_term: string;
  }>(
    `SELECT recent.owner_user_id,
            recent.account_id,
            recent.vault_id,
            substring(recent.segment_content FROM '([[:alnum:]][[:alnum:]_-]{4,31})') AS probe_term
       FROM (
         SELECT document.owner_user_id,
                document.account_id,
                document.vault_id,
                segment.content AS segment_content,
                document.updated_at
           FROM document_store_documents AS document
           JOIN session_search_segments AS segment
             ON segment.document_store_id = document.id
          WHERE document.document_type = 'chat'
            AND document.scope = 'user'
            AND document.owner_user_id IS NOT NULL
            AND document.account_id IS NOT NULL
            AND coalesce(document.metadata->>'updatedAt', document.updated_at::text, document.created_at::text) >= $1
            AND coalesce((document.metadata->>'messageCount')::int, 0) > 0
          ORDER BY document.updated_at DESC
          LIMIT 50
       ) AS recent
      WHERE substring(recent.segment_content FROM '([[:alnum:]][[:alnum:]_-]{4,31})') IS NOT NULL
      LIMIT 1`,
    [cutoffIso],
  );
  const row = result.rows[0];
  return row
    ? {
        ownerUserId: row.owner_user_id,
        accountId: row.account_id,
        vaultId: row.vault_id,
        searchTerm: row.probe_term,
      }
    : null;
}

function verificationPrincipal(scope: VerificationScope): Principal {
  const visibleVaultIds = scope.vaultId ? [scope.vaultId] : [];
  return {
    actorType: "user",
    userId: scope.ownerUserId,
    accountId: scope.accountId,
    role: "owner",
    scopes: ["user:read"],
    permissions: [],
    isAdmin: false,
    impersonation: null,
    source: "session",
    visibleVaultIds,
    activeVaultId: scope.vaultId ?? undefined,
  };
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

function numericField(
  value: Record<string, unknown> | undefined,
  key: string,
): number {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : 0;
}

async function verifyOperationalQuery(client: PoolClient): Promise<"verified" | "unavailable"> {
  const cutoffIso = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const scope = await readVerificationScope(client, cutoffIso);
  if (!scope) {
    log.warn(
      "session search operational probe unavailable reason=no_recent_authorized_scope",
    );
    return "unavailable";
  }

  const productionQuery = buildTargetSessionSearchQuery(
    verificationPrincipal(scope),
    cutoffIso,
    scope.searchTerm,
    50,
  ).toSQL();
  const searchPattern = buildLiteralSubstringPattern(scope.searchTerm);
  await client.query(`SET statement_timeout TO '${OPERATIONAL_PROBE_TIMEOUT_MS}ms'`);
  const startedAt = performance.now();

  try {
    // Keep physical index usability separate from the production planner's chosen
    // join order. A narrow authorized scope may truthfully enter through the
    // document FK index, so requiring the trigram index in that exact plan creates
    // a false failure even when both the index and query are healthy.
    await client.query("SET enable_seqscan TO off");
    const capabilityResult = await client.query<Record<string, unknown>>(
      `EXPLAIN (FORMAT JSON)
       SELECT id
         FROM session_search_segments
        WHERE content ILIKE $1 ESCAPE '!'`,
      [searchPattern],
    );
    const rawCapabilityPlan = capabilityResult.rows[0]?.["QUERY PLAN"];
    const capabilityPlan =
      typeof rawCapabilityPlan === "string"
        ? JSON.parse(rawCapabilityPlan)
        : rawCapabilityPlan;
    const capabilityIndexes = collectIndexNames(capabilityPlan);
    if (!capabilityIndexes.has(SESSION_SEARCH_SEGMENT_INDEX)) {
      const error = new Error(
        "Session search trigram index capability probe missed required index",
      ) as Error & { code: string; missingIndexes: string[] };
      error.code = "SESSION_SEARCH_REQUIRED_INDEX_UNUSED";
      error.missingIndexes = [SESSION_SEARCH_SEGMENT_INDEX];
      throw error;
    }
    await client.query("SET enable_seqscan TO on");

    const result = await client.query<Record<string, unknown>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${productionQuery.sql}`,
      productionQuery.params,
    );
    const rawPlan = result.rows[0]?.["QUERY PLAN"];
    const payload = typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan;
    const statement = Array.isArray(payload)
      ? (payload[0] as Record<string, unknown> | undefined)
      : undefined;
    const rootPlan = statement?.Plan as Record<string, unknown> | undefined;

    log.info("session search operational probe verified", {
      outcome: "verified",
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      planningMs: numericField(statement, "Planning Time"),
      executionMs: numericField(statement, "Execution Time"),
      actualRows: numericField(rootPlan, "Actual Rows"),
      sharedHitBlocks: numericField(rootPlan, "Shared Hit Blocks"),
      sharedReadBlocks: numericField(rootPlan, "Shared Read Blocks"),
      indexes: SEARCH_INDEXES.map((definition) => ({
        name: definition.name,
        fastUpdate: definition.fastUpdate,
      })),
    });
    return "verified";
  } catch (error) {
    const sqlState = errorCode(error);
    const rawCode =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    const outcome =
      sqlState === "57014"
        ? "statement_timeout"
        : rawCode === "SESSION_SEARCH_REQUIRED_INDEX_UNUSED"
          ? "required_index_unused"
          : "query_failure";
    const probeError =
      error instanceof DocumentSearchIndexError
        ? error
        : new DocumentSearchIndexError(
            "SESSION_SEARCH_PROBE_FAILED",
            "Session search operational probe failed",
            { cause: error, sqlState },
          );
    log.error("session search operational probe failed", probeError, {
      outcome,
      sqlState,
      missingIndexes:
        error && typeof error === "object" && "missingIndexes" in error
          ? (error as { missingIndexes: unknown }).missingIndexes
          : undefined,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    });
    throw probeError;
  } finally {
    await client.query("SET enable_seqscan TO on");
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

    for (const definition of SEARCH_INDEXES) {
      await ensureSearchIndex(client, definition);
    }

    for (const indexName of RETIRED_DOCUMENT_STORE_CHAT_SEARCH_INDEXES) {
      log.info(`dropping retired concurrent index ${indexName}`);
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
    }

    const operationalProbe = await verifyOperationalQuery(client);
    log.info(
      `document-store chat substring indexes ready operationalProbe=${operationalProbe}`,
    );
    return "ready";
  } finally {
    let discardClient = false;
    try {
      await client.query("RESET lock_timeout");
      await client.query("RESET statement_timeout");
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
      }
    } catch (error) {
      discardClient = true;
      log.warn("failed to reset document search index maintenance session", {
        sqlState: errorCode(error),
      });
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
      log.debug(`index maintenance owned by another replica attempt=${attempt}`);
    } catch (error) {
      log.warn("document-store search index maintenance failed", {
        attempt,
        sqlState: maintenanceSqlState(error),
      });
    }

    if (attempt >= MAX_ATTEMPTS) {
      log.error(
        "document-store search indexes not confirmed",
        new DocumentSearchIndexError(
          "DOCUMENT_SEARCH_INDEXES_NOT_CONFIRMED",
          `Document-store search indexes not confirmed after ${MAX_ATTEMPTS} attempts`,
        ),
        { attempts: MAX_ATTEMPTS },
      );
      return;
    }
    setTimeout(run, RETRY_DELAY_MS).unref();
  };

  setTimeout(run, START_DELAY_MS).unref();
}
