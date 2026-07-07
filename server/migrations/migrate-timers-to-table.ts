import { db } from "../db";
import { timers } from "@shared/schema";
import { sql, eq } from "drizzle-orm";
import { documentStorage } from "../memory/document-storage";
import { timerTypes } from "@shared/models/timers";
import { createLogger } from "../log";

const log = createLogger("MigrateTimers");

/**
 * One-time boot migration: moves timer definitions from workspace_documents
 * (doc_type = 'responsibility') into the dedicated `timers` table.
 *
 * Filters out stale operational artifacts: meta-*, runs-*, and run_log entries.
 * Idempotent — skips if timers table already has data.
 */
export async function migrateTimersToTable(): Promise<void> {
  try {
    // Ensure the table exists (Drizzle push or prior boot should have created it)
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "timers" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "description" text DEFAULT '' NOT NULL,
        "type" text NOT NULL,
        "prompt" text DEFAULT '' NOT NULL,
        "skill_id" text,
        "schedules" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "enabled" boolean DEFAULT true NOT NULL,
        "timezone" text DEFAULT 'America/New_York' NOT NULL,
        "scope" text DEFAULT 'user' NOT NULL,
        "owner_user_id" text,
        "account_id" text,
        "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // Ensure indexes exist
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_timers_scope_owner" ON "timers" ("scope", "owner_user_id")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_timers_account" ON "timers" ("account_id")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_timers_type" ON "timers" ("type")`);

    // Check if already migrated
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(timers);
    if (countResult && Number(countResult.count) > 0) {
      log.log("Timers table already has data, skipping migration");
      return;
    }

    // Read all responsibility docs from workspace_documents
    const docs = await documentStorage.getDocumentsByType("responsibility");
    if (docs.length === 0) {
      log.log("No responsibility documents found, nothing to migrate");
      return;
    }

    log.log(`Found ${docs.length} responsibility documents, filtering valid timers`);

    let migrated = 0;
    const seen = new Set<string>();

    for (const doc of docs) {
      try {
        // Skip operational artifacts
        if (doc.docId.startsWith("meta-")) continue;
        if (doc.docId.startsWith("runs-")) continue;

        const meta = (doc.metadata || {}) as Record<string, unknown>;
        if (meta.type === "run_log") continue;

        const id = String(meta.id || doc.docId);
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const typeVal = String(meta.type || "me");
        const validType = (timerTypes as readonly string[]).includes(typeVal) ? typeVal : "me";

        await db.insert(timers).values({
          id,
          name: String(meta.name || ""),
          description: String(meta.description || ""),
          type: validType,
          prompt: String(meta.prompt || ""),
          skillId: meta.skillId ? String(meta.skillId) : null,
          schedules: (meta.schedules as unknown[]) || [],
          enabled: meta.enabled !== undefined ? Boolean(meta.enabled) : true,
          timezone: String(meta.timezone || "America/New_York"),
        }).onConflictDoNothing();

        migrated++;
      } catch (err) {
        log.error(`Failed to migrate timer doc docId=${doc.docId}`, err);
      }
    }

    log.log(`Timer migration complete: migrated ${migrated} timers from ${docs.length} documents`);

    // Clean up old responsibility documents from workspace_documents
    if (migrated > 0) {
      let cleaned = 0;
      for (const doc of docs) {
        try {
          await documentStorage.deleteDocument("responsibility", doc.docId);
          cleaned++;
        } catch {
          // Non-fatal — old docs will just sit unused
        }
      }
      log.log(`Cleaned up ${cleaned} old responsibility documents from workspace_documents`);
    }
  } catch (err) {
    log.error("Timer migration failed (non-fatal)", err);
  }
}
