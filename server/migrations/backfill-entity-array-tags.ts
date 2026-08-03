import { pool, db } from "../db";
import { eq } from "drizzle-orm";
import { users } from "@shared/schema";
import { createLogger } from "../log";
import { createUserPrincipalFromUser } from "../principal";
import type { Principal } from "../principal";
import { tagService } from "../tag-service";

const log = createLogger("BackfillEntityArrayTags");

/**
 * One-time backfill of canonical tag assignments for domains that carry their own
 * `tags[]` array but were never part of the legacy JSON registry (and therefore are
 * not covered by TagService.ensureLegacyAdopted): Companies and Theses.
 *
 * Idempotent and safe to re-run:
 *  - Each (account, domain) pair is gated by a tag_migrations record.
 *  - Each entity is synced through TagService.replaceEntityTags, which deletes and
 *    re-inserts its assignments, so repeated runs converge to the same state.
 *  - Domains whose table does not yet exist (e.g. theses is created lazily on first
 *    write) are skipped and retried on a later boot instead of being marked complete.
 */

interface EntityTagRow {
  id: string;
  title: string | null;
  tags: string[] | null;
}

interface DomainSpec {
  migrationKey: string;
  table: string;
  entityType: string;
  titleColumn: string;
}

const DOMAINS: DomainSpec[] = [
  { migrationKey: "entity-array-tags-company-v1", table: "companies", entityType: "company", titleColumn: "name" },
  { migrationKey: "entity-array-tags-thesis-v1", table: "theses", entityType: "thesis", titleColumn: "title" },
];

async function tableExists(table: string): Promise<boolean> {
  const result = await pool.query<{ reg: string | null }>(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
  return Boolean(result.rows[0]?.reg);
}

async function alreadyRun(accountId: string, migrationKey: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM tag_migrations WHERE account_id = $1 AND migration_key = $2`,
    [accountId, migrationKey],
  );
  return Boolean(result.rowCount);
}

async function backfillDomain(
  accountId: string,
  ownerUserId: string,
  principal: Principal,
  domain: DomainSpec,
): Promise<void> {
  if (!(await tableExists(domain.table))) return;
  if (await alreadyRun(accountId, domain.migrationKey)) return;

  // Table and column names are hardcoded constants, not user input.
  const rows = await pool.query<EntityTagRow>(
    `SELECT id, ${domain.titleColumn} AS title, tags
     FROM ${domain.table}
     WHERE account_id = $1 AND owner_user_id = $2 AND array_length(tags, 1) > 0`,
    [accountId, ownerUserId],
  );

  let count = 0;
  for (const row of rows.rows) {
    await tagService.replaceEntityTags(domain.entityType, row.id, row.title || "", row.tags || [], principal);
    count += 1;
  }

  await pool.query(
    `INSERT INTO tag_migrations(account_id, migration_key, status, detail)
     VALUES ($1, $2, 'completed', $3::jsonb)
     ON CONFLICT (account_id, migration_key) DO NOTHING`,
    [accountId, domain.migrationKey, JSON.stringify({ count })],
  );
  log.info("entity-array tag backfill completed", { accountId, table: domain.table, count });
}

export async function backfillEntityArrayTags(): Promise<void> {
  if (!(await tableExists("tag_migrations"))) {
    log.warn("tag_migrations table missing; skipping entity-array tag backfill");
    return;
  }

  const accounts = await pool.query<{ account_id: string; owner_user_id: string | null }>(
    `SELECT id AS account_id, owner_user_id FROM accounts ORDER BY created_at ASC`,
  );

  for (const account of accounts.rows) {
    if (!account.owner_user_id) continue;
    const [user] = await db.select().from(users).where(eq(users.id, account.owner_user_id)).limit(1);
    if (!user) continue;
    const principal = createUserPrincipalFromUser(user, account.account_id);

    for (const domain of DOMAINS) {
      try {
        await backfillDomain(account.account_id, account.owner_user_id, principal, domain);
      } catch (err) {
        log.error("entity-array tag backfill failed", {
          accountId: account.account_id,
          table: domain.table,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
