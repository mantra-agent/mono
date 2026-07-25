import type { PoolClient } from "pg";
import {
  DOCUMENT_STORE_CHAT_SEARCH_INDEXES,
  RETIRED_DOCUMENT_STORE_CHAT_SEARCH_INDEXES,
} from "@shared/models/memory";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { buildTargetSessionSearchQuery } from "./session-search-query";

const log = createLogger("DocumentSearchIndexes");

const LOCK_KEY = "document_store_chat_trigram_indexes_v1";
const START_DELAY_MS = 15_000;
const RETRY_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 15;

const SEARCH_INDEXES = [
  {
    name: DOCUMENT_STORE_CHAT_SEARCH_INDEXES.title,
    method: "GIN",
    expression: "title gin_trgm_ops",
  },
  {
    name: DOCUMENT_STORE_CHAT_SEARCH_INDEXES.content,
    method: "GIN",
    expression: "content gin_trgm_ops",
  },
] as const;

type EnsureOutcome = "ready" | "busy";

const PLAN_VERIFICATION_PRINCIPAL: Principal = {
  actorType: "user",
  userId: "plan-verification-user",
  accountId: "plan-verification-account",
  role: "owner",
  scopes: ["user:read"],
  permissions: [],
  isAdmin: false,
  impersonation: null,
  source: "session",
  visibleVaultIds: ["plan-verification-vault"],
  activeVaultId: "plan-verification-vault",
};

async function readIndexValidity(
  client: PoolClient,
  indexName: string,
): Promise<boolean | null> {
  const result = await client.query<{ indisvalid: boolean }>(
    "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)",
    [indexName],
  );
  return result.rows[0]?.indisvalid ?? null;
}

async function ensureSearchIndex(
  client: PoolClient,
  definition: (typeof SEARCH_INDEXES)[number],
): Promise<void> {
  const validity = await readIndexValidity(client, definition.name);
  if (validity === true) return;

  if (validity === false) {
    log.warn(`dropping invalid concurrent index ${definition.name} before retry`);
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${definition.name}"`);
  }

  log.info(`building concurrent index ${definition.name}`);
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS "${definition.name}"
    ON document_store_documents USING ${definition.method} (${definition.expression})
    WHERE document_type = 'chat'
  `);

  if (await readIndexValidity(client, definition.name) !== true) {
    throw new Error(`Concurrent index ${definition.name} did not become valid`);
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

    // Explain the exact canonical production query shape without executing it.
    // Runtime search and this probe share one builder so verification cannot drift.
    try {
      const cutoffIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
      const productionQuery = buildTargetSessionSearchQuery(
        PLAN_VERIFICATION_PRINCIPAL,
        cutoffIso,
        "%production%",
        50,
      ).toSQL();
      const planResult = await client.query<Record<string, string>>(
        `EXPLAIN ${productionQuery.sql}`,
        productionQuery.params,
      );
      const planText = planResult.rows
        .map((row) => row["QUERY PLAN"])
        .filter((line) => typeof line === "string")
        .join("\n");
      const missingIndexes = SEARCH_INDEXES
        .map((definition) => definition.name)
        .filter((indexName) => !planText.includes(indexName));
      if (missingIndexes.length > 0) {
        log.warn(
          `session search plan missing trigram indexes indexes=${missingIndexes.join(",")}: ${planText}`,
        );
      } else {
        log.info(
          `session search plan verified indexes=${SEARCH_INDEXES.map((definition) => definition.name).join(",")}`,
        );
      }
    } catch (error) {
      log.warn(
        `session search plan verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    log.info("document-store chat substring indexes ready");
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
      log.warn(
        `failed to reset document search index maintenance session: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      log.warn(
        `document-store search index maintenance failed attempt=${attempt}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (attempt >= MAX_ATTEMPTS) {
      log.error(`document-store search indexes not confirmed after ${MAX_ATTEMPTS} attempts`);
      return;
    }
    setTimeout(run, RETRY_DELAY_MS).unref();
  };

  setTimeout(run, START_DELAY_MS).unref();
}
