import { db } from "../db";
import { projects } from "@shared/schema";
import { sql } from "drizzle-orm";
import { documentStorage } from "../memory/document-storage";
import { createLogger } from "../log";

const log = createLogger("MigrateProjects");

/**
 * One-time boot migration: moves project definitions from workspace_documents
 * (doc_type = 'project') into the dedicated `projects` table.
 *
 * Idempotent — skips if projects table already has data.
 */
export async function migrateProjectsToTable(): Promise<void> {
  try {
    // Ensure the table exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "projects" (
        "id" serial PRIMARY KEY NOT NULL,
        "title" text NOT NULL,
        "description" text DEFAULT '' NOT NULL,
        "status" text DEFAULT 'idea' NOT NULL,
        "priority" text DEFAULT 'mid' NOT NULL,
        "owner" text DEFAULT 'me' NOT NULL,
        "requires_review" boolean DEFAULT false NOT NULL,
        "due_date" text,
        "spec" text DEFAULT '' NOT NULL,
        "goal_id" text,
        "milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "people" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "files" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "activity" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "scope" text DEFAULT 'user' NOT NULL,
        "owner_user_id" text,
        "account_id" text,
        "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // Ensure indexes exist
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_projects_status" ON "projects" ("status")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_projects_scope_owner" ON "projects" ("scope", "owner_user_id")`);

    // Check if already migrated
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(projects);
    if (countResult && Number(countResult.count) > 0) {
      log.log("Projects table already has data, skipping migration");
      return;
    }

    // Read all project docs from workspace_documents
    const docs = await documentStorage.getDocumentsByType("project");
    if (docs.length === 0) {
      log.log("No project documents found, nothing to migrate");
      return;
    }

    log.log(`Found ${docs.length} project documents to migrate`);

    let migrated = 0;
    const seen = new Set<number>();

    for (const doc of docs) {
      try {
        const meta = (doc.metadata || {}) as Record<string, unknown>;
        const id = Number(meta.id);
        if (!id || isNaN(id) || seen.has(id)) continue;
        seen.add(id);

        // Normalize legacy "planned" status to "planning"
        let status = String(meta.status || "idea");
        if (status === "planned") status = "planning";

        // Parse milestones
        const milestones = Array.isArray(meta.milestones)
          ? (meta.milestones as Record<string, unknown>[]).map((m, idx) => ({
              id: m.id ?? idx + 1,
              name: m.name || "Unnamed",
              status: m.status || "planned",
              order: m.order ?? idx,
              startDate: m.startDate || null,
              dueDate: m.dueDate || null,
            }))
          : [];

        // Parse notes
        const notes = Array.isArray(meta.notes)
          ? (meta.notes as Record<string, unknown>[]).map(n => ({
              id: n.id || "",
              content: n.content || "",
              createdAt: n.createdAt || new Date().toISOString(),
              updatedAt: n.updatedAt || n.createdAt || new Date().toISOString(),
            }))
          : [];

        // Parse files
        const files = Array.isArray(meta.files)
          ? (meta.files as Record<string, unknown>[]).map(f => ({
              id: f.id || "",
              name: f.name || "",
              mimeType: f.mimeType || "application/octet-stream",
              objectKey: f.objectKey || "",
              size: f.size || 0,
              uploadedAt: f.uploadedAt || new Date().toISOString(),
            }))
          : [];

        // Parse activity
        const activity = Array.isArray(meta.activity)
          ? (meta.activity as Record<string, unknown>[]).map(a => ({
              timestamp: a.timestamp || new Date().toISOString(),
              author: a.author || "me",
              message: a.message || "",
            }))
          : [];

        // Spec may be in metadata or in content body
        const spec = typeof meta.spec === "string" ? meta.spec : "";

        // Description from content body (content field of document)
        const description = doc.content || "";

        await db.execute(sql`
          INSERT INTO "projects" ("id", "title", "description", "status", "priority", "owner",
            "requires_review", "due_date", "spec", "goal_id", "milestones", "tags", "people",
            "notes", "files", "activity", "created_at", "updated_at")
          VALUES (
            ${id},
            ${String(meta.title || "Untitled")},
            ${description},
            ${status},
            ${String(meta.priority || "mid")},
            ${String(meta.owner || "me")},
            ${Boolean(meta.requiresReview)},
            ${meta.dueDate ? String(meta.dueDate) : null},
            ${spec},
            ${meta.goalId ? String(meta.goalId) : null},
            ${JSON.stringify(milestones)}::jsonb,
            ${JSON.stringify(Array.isArray(meta.tags) ? meta.tags : [])}::jsonb,
            ${JSON.stringify(Array.isArray(meta.people) ? meta.people : [])}::jsonb,
            ${JSON.stringify(notes)}::jsonb,
            ${JSON.stringify(files)}::jsonb,
            ${JSON.stringify(activity)}::jsonb,
            ${meta.createdAt ? new Date(String(meta.createdAt)) : new Date()},
            ${meta.updatedAt ? new Date(String(meta.updatedAt)) : new Date()}
          )
          ON CONFLICT DO NOTHING
        `);

        migrated++;
      } catch (err) {
        log.error(`Failed to migrate project doc docId=${doc.docId}`, err);
      }
    }

    // Reset the serial sequence to max id
    if (migrated > 0) {
      await db.execute(sql`SELECT setval(pg_get_serial_sequence('projects', 'id'), (SELECT COALESCE(MAX(id), 1) FROM projects))`);
    }

    log.log(`Project migration complete: migrated ${migrated} projects from ${docs.length} documents`);

    // Clean up old project documents from workspace_documents
    if (migrated > 0) {
      let cleaned = 0;
      for (const doc of docs) {
        try {
          await documentStorage.deleteDocument("project", doc.docId);
          cleaned++;
        } catch {
          // Non-fatal — old docs will just sit unused
        }
      }
      log.log(`Cleaned up ${cleaned} old project documents from workspace_documents`);
    }
  } catch (err) {
    log.error("Project migration failed (non-fatal)", err);
  }
}
