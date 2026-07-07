import { db } from "../db";
import { principles } from "@shared/schema";
import { sql } from "drizzle-orm";
import { documentStorage } from "../memory/document-storage";
import { createLogger } from "../log";

const log = createLogger("MigratePrinciples");

/**
 * One-time boot migration: moves principle definitions from workspace_documents
 * (doc_type = 'principle') into the dedicated `principles` table.
 *
 * Idempotent — skips if principles table already has data.
 */
export async function migratePrinciplesToTable(): Promise<void> {
  try {
    // Ensure the table exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "principles" (
        "id" text PRIMARY KEY NOT NULL,
        "title" text NOT NULL,
        "layer1" text DEFAULT '' NOT NULL,
        "layer2" text DEFAULT '' NOT NULL,
        "auto_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "manual_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "related_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "scope" text DEFAULT 'user' NOT NULL,
        "owner_user_id" text,
        "account_id" text,
        "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // Ensure indexes exist
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_principles_scope_owner" ON "principles" ("scope", "owner_user_id")`);

    // Check if already migrated
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(principles);
    if (countResult && Number(countResult.count) > 0) {
      log.log("Principles table already has data, skipping migration");
      return;
    }

    // Read all principle docs from workspace_documents
    const docs = await documentStorage.getDocumentsByType("principle");
    if (docs.length === 0) {
      log.log("No principle documents found, nothing to migrate");
      return;
    }

    log.log(`Found ${docs.length} principle documents to migrate`);

    let migrated = 0;
    const seen = new Set<string>();

    for (const doc of docs) {
      try {
        const meta = (doc.metadata || {}) as Record<string, unknown>;
        const id = String(meta.id || doc.docId || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);

        await db.execute(sql`
          INSERT INTO "principles" ("id", "title", "layer1", "layer2", "auto_tags", "manual_tags",
            "related_ids", "created_at", "updated_at")
          VALUES (
            ${id},
            ${String(meta.title || "Untitled")},
            ${String(meta.layer1 || "")},
            ${String(meta.layer2 || "")},
            ${JSON.stringify(Array.isArray(meta.autoTags) ? meta.autoTags : [])}::jsonb,
            ${JSON.stringify(Array.isArray(meta.manualTags) ? meta.manualTags : [])}::jsonb,
            ${JSON.stringify(Array.isArray(meta.relatedIds) ? meta.relatedIds : [])}::jsonb,
            ${meta.createdAt ? new Date(String(meta.createdAt)) : new Date()},
            ${meta.updatedAt ? new Date(String(meta.updatedAt)) : new Date()}
          )
          ON CONFLICT DO NOTHING
        `);

        migrated++;
      } catch (err) {
        log.error(`Failed to migrate principle doc docId=${doc.docId}`, err);
      }
    }

    log.log(`Principle migration complete: migrated ${migrated} principles from ${docs.length} documents`);

    // Clean up old principle documents from workspace_documents
    if (migrated > 0) {
      let cleaned = 0;
      for (const doc of docs) {
        try {
          await documentStorage.deleteDocument("principle", doc.docId);
          cleaned++;
        } catch {
          // Non-fatal — old docs will just sit unused
        }
      }
      log.log(`Cleaned up ${cleaned} old principle documents from workspace_documents`);
    }
  } catch (err) {
    log.error("Principle migration failed (non-fatal)", err);
  }
}
