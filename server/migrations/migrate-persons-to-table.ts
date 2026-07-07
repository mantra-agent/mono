import { db } from "../db";
import { persons } from "@shared/schema";
import { sql } from "drizzle-orm";
import { documentStorage } from "../memory/document-storage";
import { createLogger } from "../log";

const log = createLogger("MigratePersons");

/**
 * One-time boot migration: moves person profiles from workspace_documents
 * (doc_type = 'person') into the dedicated `persons` table.
 *
 * Idempotent — skips if persons table already has data.
 */
export async function migratePersonsToTable(): Promise<void> {
  try {
    // Ensure the table exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "persons" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "nicknames" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "cabinet_level" text DEFAULT 'network' NOT NULL,
        "photo" text,
        "birthday" text,
        "company" text,
        "role" text,
        "professional_relations" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "relation" text,
        "introduced_by" text,
        "familiarity" text,
        "trust" text,
        "met" text,
        "social_profiles" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "contact_info" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "important_dates" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "interactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "ai_summary" text,
        "quick_summary" text,
        "identity_content" text,
        "relationship_profile" jsonb,
        "network_profile" jsonb,
        "daily_contact" boolean DEFAULT false NOT NULL,
        "private" boolean DEFAULT false NOT NULL,
        "scope" text DEFAULT 'user' NOT NULL,
        "owner_user_id" text,
        "account_id" text,
        "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // Ensure indexes exist
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_persons_cabinet_level" ON "persons" ("cabinet_level")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_persons_scope_owner" ON "persons" ("scope", "owner_user_id")`);

    // Check if already migrated
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(persons);
    if (countResult && Number(countResult.count) > 0) {
      log.log("Persons table already has data, skipping migration");
      return;
    }

    // Read all person docs from workspace_documents
    const SPECIAL_DOC_IDS = new Set(["cabinet-config", "trust-config", "time-budgets", "gmail-skip-list"]);
    const docs = await documentStorage.getDocumentsByType("person");
    const personDocs = docs.filter(d => !SPECIAL_DOC_IDS.has(d.docId));

    if (personDocs.length === 0) {
      log.log("No person documents found, nothing to migrate");
      return;
    }

    log.log(`Found ${personDocs.length} person documents to migrate`);

    let migrated = 0;
    const seen = new Set<string>();

    for (const doc of personDocs) {
      try {
        const meta = (doc.metadata || {}) as Record<string, any>;
        const id = String(meta.id || doc.docId);
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const name = String(meta.name || "Unknown");
        if (!name || name === "Unknown") {
          log.warn(`Skipping person doc docId=${doc.docId} — no name`);
          continue;
        }

        await db.execute(sql`
          INSERT INTO "persons" (
            "id", "name", "nicknames", "cabinet_level", "photo", "birthday",
            "company", "role", "professional_relations", "relation", "introduced_by",
            "familiarity", "trust", "met", "social_profiles", "contact_info",
            "important_dates", "notes", "interactions", "tags",
            "ai_summary", "quick_summary", "identity_content",
            "relationship_profile", "network_profile",
            "daily_contact", "private", "created_at", "updated_at"
          ) VALUES (
            ${id},
            ${name},
            ${JSON.stringify(Array.isArray(meta.nicknames) ? meta.nicknames : [])}::jsonb,
            ${String(meta.cabinetLevel || "network")},
            ${meta.photo ? String(meta.photo) : null},
            ${meta.birthday ? String(meta.birthday) : null},
            ${meta.company ? String(meta.company) : null},
            ${meta.role ? String(meta.role) : null},
            ${JSON.stringify(Array.isArray(meta.professionalRelations) ? meta.professionalRelations : [])}::jsonb,
            ${meta.relation ? String(meta.relation) : null},
            ${meta.introducedBy ? String(meta.introducedBy) : null},
            ${meta.familiarity ? String(meta.familiarity) : null},
            ${meta.trust ? String(meta.trust) : null},
            ${meta.met ? String(meta.met) : null},
            ${JSON.stringify(meta.socialProfiles || {})}::jsonb,
            ${JSON.stringify(Array.isArray(meta.contactInfo) ? meta.contactInfo : [])}::jsonb,
            ${JSON.stringify(Array.isArray(meta.importantDates) ? meta.importantDates : [])}::jsonb,
            ${JSON.stringify(Array.isArray(meta.notes) ? meta.notes : [])}::jsonb,
            ${JSON.stringify(Array.isArray(meta.interactions) ? meta.interactions : [])}::jsonb,
            ${JSON.stringify(Array.isArray(meta.tags) ? meta.tags : [])}::jsonb,
            ${meta.aiSummary ? String(meta.aiSummary) : null},
            ${meta.quickSummary ? String(meta.quickSummary) : null},
            ${meta.identityContent ? String(meta.identityContent) : null},
            ${meta.relationshipProfile ? JSON.stringify(meta.relationshipProfile) : null}::jsonb,
            ${meta.networkProfile ? JSON.stringify(meta.networkProfile) : null}::jsonb,
            ${Boolean(meta.dailyContact)},
            ${Boolean(meta.private)},
            ${meta.createdAt ? new Date(String(meta.createdAt)) : new Date()},
            ${meta.updatedAt ? new Date(String(meta.updatedAt)) : new Date()}
          )
          ON CONFLICT DO NOTHING
        `);

        migrated++;
      } catch (err) {
        log.error(`Failed to migrate person doc docId=${doc.docId}`, err);
      }
    }

    log.log(`Person migration complete: migrated ${migrated} persons from ${personDocs.length} documents`);

    // Clean up old person documents from workspace_documents
    if (migrated > 0) {
      let cleaned = 0;
      for (const doc of personDocs) {
        try {
          await documentStorage.deleteDocument("person", doc.docId);
          cleaned++;
        } catch {
          // Non-fatal — old docs will just sit unused
        }
      }
      log.log(`Cleaned up ${cleaned} old person documents from workspace_documents`);
    }
  } catch (err) {
    log.error("Person migration failed (non-fatal)", err);
  }
}
