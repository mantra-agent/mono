import { isDeepStrictEqual } from "node:util";
import { db } from "./db";
import { systemSettings } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import { createLogger } from "./log";
import { safeTruncate } from "./utils/safe-stringify";

const log = createLogger("SystemSettings");
const SLOW_SETTING_OPERATION_MS = 1_000;
const SETTING_KEY_LOG_CHARS = 160;

type SettingWriteOutcome = "unchanged" | "updated" | "inserted" | "retry_updated" | "failed";

function logSlowSettingWrite(key: string, startedAt: number, outcome: SettingWriteOutcome): void {
  const durationMs = Math.round(performance.now() - startedAt);
  if (durationMs <= SLOW_SETTING_OPERATION_MS) return;

  // Keys identify the operational state owner; values may contain secrets or user data
  // and must never enter logs. Disable truncation warnings to avoid doubling slow-path noise.
  const settingKey = safeTruncate(key, SETTING_KEY_LOG_CHARS, "systemSettings.key", false);
  log.warn(`slow write durationMs=${durationMs} outcome=${outcome} key=${JSON.stringify(settingKey)}`);
}

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0].value as T;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const startedAt = performance.now();
  let outcome: SettingWriteOutcome = "failed";

  try {
    // Same-value writes thrash the single-row hot path under load. Skip when
    // the persisted JSON already matches — no write, no updatedAt churn.
    const existing = await getSetting(key);
    if (existing !== null && isDeepStrictEqual(existing, value)) {
      outcome = "unchanged";
      return;
    }

    const updated = await db
      .update(systemSettings)
      .set({ value, updatedAt: new Date() })
      .where(eq(systemSettings.key, key));

    if ((updated.rowCount ?? 0) > 0) {
      outcome = "updated";
      return;
    }

    try {
      await db.insert(systemSettings).values({ key, value, updatedAt: new Date() });
      outcome = "inserted";
    } catch (err) {
      // If another request inserted the key between our update and insert, retry the update.
      // This also avoids relying on ON CONFLICT, because some live DBs are missing the
      // schema-declared unique constraint on system_settings.key.
      const retry = await db
        .update(systemSettings)
        .set({ value, updatedAt: new Date() })
        .where(eq(systemSettings.key, key));
      if ((retry.rowCount ?? 0) > 0) {
        outcome = "retry_updated";
        return;
      }
      throw err;
    }
  } finally {
    logSlowSettingWrite(key, startedAt, outcome);
  }
}

export async function deleteSetting(key: string): Promise<boolean> {
  const result = await db
    .delete(systemSettings)
    .where(eq(systemSettings.key, key));
  return (result.rowCount ?? 0) > 0;
}

export async function getSettings(keys: string[]): Promise<Map<string, unknown>> {
  const result = new Map<string, unknown>();
  if (keys.length === 0) return result;
  const rows = await db
    .select()
    .from(systemSettings)
    .where(inArray(systemSettings.key, keys));
  for (const row of rows) {
    result.set(row.key, row.value);
  }
  return result;
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(systemSettings);
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export async function getSettingWithFallback<T>(
  key: string,
  fileFallback: () => Promise<T | null>
): Promise<T | null> {
  const existing = await getSetting<T>(key);
  if (existing !== null) return existing;

  const fromFile = await fileFallback();
  if (fromFile !== null) {
    await setSetting(key, fromFile);
  }
  return fromFile;
}
