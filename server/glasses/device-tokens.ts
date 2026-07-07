import crypto from "crypto";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { createLogger } from "../log";
const log = createLogger("GlassesDeviceTokens");

// ── Bootstrap table ──────────────────────────────────────────────
export async function ensureGlassesDeviceTokensTable(): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS glasses_device_tokens (
      id SERIAL PRIMARY KEY,
      token VARCHAR(64) NOT NULL UNIQUE,
      user_id VARCHAR NOT NULL,
      device_label VARCHAR(100) DEFAULT 'Ray-Ban Meta',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `));
  log.log("glasses_device_tokens table ensured");
}

// ── Token CRUD ───────────────────────────────────────────────────

/** Generate a new device token for a user. Replaces any existing token for that user. */
export async function issueDeviceToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");

  // Upsert: one active token per user (keep it simple for now)
  await db.execute(sql.raw(`
    DELETE FROM glasses_device_tokens WHERE user_id = '${userId.replace(/'/g, "''")}'
  `));
  await db.execute(sql.raw(`
    INSERT INTO glasses_device_tokens (token, user_id)
    VALUES ('${token}', '${userId.replace(/'/g, "''")}')
  `));

  log.log("Device token issued", { userId });
  return token;
}

/** Validate a device token and return the userId it belongs to, or null. */
export async function resolveDeviceToken(token: string): Promise<string | null> {
  if (!token || token.length !== 64) return null;

  const rows = await db.execute(sql.raw(`
    SELECT user_id FROM glasses_device_tokens
    WHERE token = '${token.replace(/'/g, "''")}'
    LIMIT 1
  `));

  const row = (rows as any).rows?.[0];
  if (!row) return null;

  // Touch last_used_at
  await db.execute(sql.raw(`
    UPDATE glasses_device_tokens SET last_used_at = CURRENT_TIMESTAMP
    WHERE token = '${token.replace(/'/g, "''")}'
  `)).catch(() => {});

  return row.user_id;
}

/** Get the first active authenticated user. For single-user auto-pairing. */
export async function getDefaultUser(): Promise<{ id: string } | null> {
  const rows = await db.execute(sql.raw(`
    SELECT id FROM users ORDER BY created_at ASC LIMIT 1
  `));
  const row = (rows as any).rows?.[0];
  if (!row) return null;
  return { id: row.id };
}

/** Get a human-readable label for the paired user. Prefer account name over email. */
export async function getUserDisplayName(userId: string): Promise<string> {
  const escapedUserId = userId.replace(/'/g, "''");
  const rows = await db.execute(sql.raw(`
    SELECT COALESCE(a.name, u.email, 'Unknown user') AS display_name
    FROM users u
    LEFT JOIN accounts a ON a.owner_user_id = u.id AND a.kind = 'personal'
    WHERE u.id = '${escapedUserId}'
    LIMIT 1
  `));
  const row = (rows as any).rows?.[0];
  return row?.display_name || "Unknown user";
}

/** Revoke all device tokens for a user. */
export async function revokeDeviceTokens(userId: string): Promise<void> {
  await db.execute(sql.raw(`
    DELETE FROM glasses_device_tokens WHERE user_id = '${userId.replace(/'/g, "''")}'
  `));
  log.log("Device tokens revoked", { userId });
}
