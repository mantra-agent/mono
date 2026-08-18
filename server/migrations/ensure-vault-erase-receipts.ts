import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("EnsureVaultEraseReceipts");

/** Idempotent bootstrap for holder vault-erase replay receipts. */
export async function ensureVaultEraseReceiptsTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vault_erase_receipts (
        id text PRIMARY KEY,
        account_id text NOT NULL,
        vault_id text NOT NULL,
        idempotency_key text NOT NULL,
        reminted boolean NOT NULL DEFAULT false,
        created_at timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vault_erase_receipts_account_vault_key
      ON vault_erase_receipts (account_id, vault_id, idempotency_key)
    `);
    log.log("Ensured vault_erase_receipts table exists");
  } catch (err) {
    log.error("Failed to ensure vault_erase_receipts table", err);
    throw err;
  }
}
