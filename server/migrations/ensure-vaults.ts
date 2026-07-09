import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("EnsureVaults");

/**
 * Idempotent vault schema bootstrap + backfill.
 *
 * 1. Create `vaults` table if not exists
 * 2. Add `active_vault_id` and `visible_vault_ids` to `users`
 * 3. Add `vault_id` to all Phase-1 owned tables
 * 4. Create a "Personal" vault for every account that lacks one
 * 5. Backfill vault_id on all owned rows to the account's Personal vault
 * 6. Set users.active_vault_id and visible_vault_ids defaults
 *
 * All operations are additive and idempotent (safe to re-run).
 */
export async function ensureVaults(): Promise<void> {
  const t0 = Date.now();
  try {
    // ── 1. Vaults table ────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vaults (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        icon TEXT,
        color TEXT,
        purpose TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_default BOOLEAN NOT NULL DEFAULT false,
        is_archived BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, name)
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_vaults_account ON vaults(account_id)`,
    );

    // ── 2. Users table vault columns ───────────────────────────────
    await pool.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS active_vault_id TEXT`,
    );
    await pool.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS visible_vault_ids TEXT[] DEFAULT '{}'::text[]`,
    );

    // ── 3. vault_id on Phase-1 owned tables ────────────────────────
    const vaultIdTables = [
      "sessions",
      "messages",
      "workspace_documents",
      "memory_entries",
      "library_pages",
      "emotional_states",
      "personas",
      "skills",
      "skill_runs",
      "theses",
      "signal_sources",
      "signal_items",
    ];

    for (const table of vaultIdTables) {
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS vault_id TEXT`,
      );
    }

    // Add indexes (idempotent)
    const indexedTables = [
      { table: "sessions", idx: "idx_sessions_vault" },
      { table: "workspace_documents", idx: "idx_ws_doc_vault" },
      { table: "memory_entries", idx: "idx_memory_vault" },
      { table: "library_pages", idx: "idx_library_pages_vault" },
    ];
    for (const { table, idx } of indexedTables) {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${idx} ON ${table}(vault_id)`,
      );
    }

    // ── 4. Create "Personal" vault per account ─────────────────────
    // Uses accounts table as the canonical account registry.
    // The Personal vault is the default vault for each account.
    const { rowCount: createdCount } = await pool.query(`
      INSERT INTO vaults (account_id, name, icon, color, position, is_default)
      SELECT a.id, 'Personal', 'P', '#828A96', 0, true
      FROM accounts a
      WHERE NOT EXISTS (
        SELECT 1 FROM vaults v
        WHERE v.account_id = a.id AND v.is_default = true
      )
    `);
    if (createdCount && createdCount > 0) {
      log.log(`Created ${createdCount} Personal vault(s)`);
    }

    // ── 5. Backfill vault_id on all owned rows ─────────────────────
    // For each table, set vault_id to the account's default vault
    // where vault_id is currently NULL and account_id is populated.
    const backfillTables = [
      { table: "sessions", accountCol: "account_id" },
      { table: "messages", accountCol: "account_id" },
      { table: "workspace_documents", accountCol: "account_id" },
      { table: "memory_entries", accountCol: "account_id" },
      { table: "library_pages", accountCol: "account_id" },
      { table: "emotional_states", accountCol: "account_id" },
      { table: "personas", accountCol: "account_id" },
      { table: "skills", accountCol: "account_id" },
      { table: "skill_runs", accountCol: "account_id" },
      { table: "theses", accountCol: "account_id" },
      { table: "signal_sources", accountCol: "account_id" },
      { table: "signal_items", accountCol: "account_id" },
    ];

    for (const { table, accountCol } of backfillTables) {
      const { rowCount } = await pool.query(`
        UPDATE ${table} t
        SET vault_id = v.id
        FROM vaults v
        WHERE v.account_id = t.${accountCol}
          AND v.is_default = true
          AND t.vault_id IS NULL
          AND t.${accountCol} IS NOT NULL
      `);
      if (rowCount && rowCount > 0) {
        log.log(`Backfilled ${rowCount} rows in ${table}`);
      }
    }

    // ── 6. Set users.active_vault_id and visible_vault_ids ─────────
    // For each user whose active_vault_id is NULL, set it to the
    // Personal vault of their account (via memberships).
    const { rowCount: usersUpdated } = await pool.query(`
      UPDATE users u
      SET
        active_vault_id = v.id,
        visible_vault_ids = ARRAY[v.id]
      FROM memberships m
      JOIN vaults v ON v.account_id = m.account_id AND v.is_default = true
      WHERE m.user_id = u.id
        AND u.active_vault_id IS NULL
    `);
    if (usersUpdated && usersUpdated > 0) {
      log.log(`Set active_vault_id for ${usersUpdated} user(s)`);
    }

    const elapsed = Date.now() - t0;
    log.log(`Vault schema ensured in ${elapsed}ms`);
  } catch (err) {
    log.error("Failed to ensure vault schema", err);
  }
}
