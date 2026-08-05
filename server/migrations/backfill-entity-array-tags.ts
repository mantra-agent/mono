import { pool, db } from "../db";
import { eq } from "drizzle-orm";
import { users } from "@shared/schema";
import { createLogger } from "../log";
import { createUserPrincipalFromUser } from "../principal";
import type { Principal } from "../principal";
import { tagService } from "../tag-service";
import { semanticLibraryTags } from "@shared/library-tags";

const log = createLogger("BackfillEntityArrayTags");

/**
 * One-time backfill of canonical tag assignments for domains that carry their own
 * `tags[]` array and therefore need domain-owned migration into canonical
 * TagService assignments: Companies and Theses.
 *
 * Idempotent and safe to re-run:
 *  - Each (account, domain) pair is gated by a tag_migrations record.
 *  - Each entity is synced through TagService.replaceEntityTags, which deletes and
 *    re-inserts its assignments, so repeated runs converge to the same state.
 *  - Domains whose table does not yet exist (e.g. theses is created lazily on first
 *    write) are skipped and retried on a later boot instead of being marked complete.
 *
 * `tagsKind` is the single discriminant for the non-empty predicate:
 *  - jsonb  → jsonb_array_length(tags) > 0  (companies)
 *  - text[] → array_length(tags, 1) > 0     (theses)
 * Mixing those functions is undefined_function 42883 on every boot.
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
  /** Storage type of the domain's tags column — drives the non-empty SQL predicate. */
  tagsKind: "jsonb" | "text[]";
  normalize?: (raw: unknown) => string[];
}

const DOMAINS: DomainSpec[] = [
  {
    migrationKey: "entity-array-tags-company-v1",
    table: "companies",
    entityType: "company",
    titleColumn: "name",
    tagsKind: "jsonb",
  },
  {
    migrationKey: "entity-array-tags-thesis-v1",
    table: "theses",
    entityType: "thesis",
    titleColumn: "title",
    tagsKind: "text[]",
  },
  {
    migrationKey: "entity-array-tags-person-v1",
    table: "persons",
    entityType: "person",
    titleColumn: "name",
    tagsKind: "jsonb",
  },
  {
    migrationKey: "entity-array-tags-library-v1",
    table: "library_pages",
    entityType: "page",
    titleColumn: "title",
    tagsKind: "text[]",
    normalize: (raw) => semanticLibraryTags(normalizeTags(raw)),
  },
];

function nonEmptyTagsPredicate(tagsKind: DomainSpec["tagsKind"]): string {
  return tagsKind === "jsonb" ? "jsonb_array_length(tags) > 0" : "array_length(tags, 1) > 0";
}

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

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => (typeof value === "string" ? value : String(value ?? "")).trim())
    .filter((value) => value.length > 0);
}

async function backfillDomain(
  accountId: string,
  ownerUserId: string,
  principal: Principal,
  domain: DomainSpec,
): Promise<void> {
  if (!(await tableExists(domain.table))) return;
  if (await alreadyRun(accountId, domain.migrationKey)) return;

  // Table/column names and tagsKind predicates are hardcoded constants, not user input.
  const rows = await pool.query<EntityTagRow>(
    `SELECT id, ${domain.titleColumn} AS title, tags
     FROM ${domain.table}
     WHERE account_id = $1 AND owner_user_id = $2 AND ${nonEmptyTagsPredicate(domain.tagsKind)}`,
    [accountId, ownerUserId],
  );

  let count = 0;
  for (const row of rows.rows) {
    const tags = domain.normalize ? domain.normalize(row.tags) : normalizeTags(row.tags);
    if (tags.length === 0) continue;
    await tagService.replaceEntityTags(domain.entityType, row.id, row.title || "", tags, principal);
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
