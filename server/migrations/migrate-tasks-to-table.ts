import { db } from "../db";
import { tasks } from "@shared/schema";
import { sql } from "drizzle-orm";
import { documentStorage } from "../memory/document-storage";
import { createLogger } from "../log";

const log = createLogger("MigrateTasks");

/**
 * One-time boot migration: moves task definitions from workspace_documents
 * (doc_type = 'task') into the dedicated `tasks` table.
 *
 * Idempotent — skips if tasks table already has data.
 */
export async function migrateTasksToTable(): Promise<void> {
  try {
    // Ensure the table exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "tasks" (
        "id" serial PRIMARY KEY NOT NULL,
        "title" text NOT NULL,
        "description" text DEFAULT '' NOT NULL,
        "status" text DEFAULT 'ready' NOT NULL,
        "priority" text DEFAULT 'mid' NOT NULL,
        "impact" text DEFAULT 'mid' NOT NULL,
        "effort" text DEFAULT 'mid' NOT NULL,
        "owner" text DEFAULT 'me' NOT NULL,
        "requires_review" boolean DEFAULT false NOT NULL,
        "project_id" integer,
        "milestone_id" integer,
        "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "deliverable" text DEFAULT '' NOT NULL,
        "acceptance_criteria" text DEFAULT '' NOT NULL,
        "context" text DEFAULT '' NOT NULL,
        "output" text DEFAULT '' NOT NULL,
        "estimate_low" real,
        "estimate_high" real,
        "deadline" text,
        "token_estimate" integer,
        "scope" text DEFAULT 'user' NOT NULL,
        "owner_user_id" text,
        "account_id" text,
        "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // Ensure indexes exist
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_tasks_status" ON "tasks" ("status")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_tasks_project" ON "tasks" ("project_id")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_tasks_scope_owner" ON "tasks" ("scope", "owner_user_id")`);

    // Check if already migrated
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(tasks);
    if (countResult && Number(countResult.count) > 0) {
      log.log("Tasks table already has data, skipping migration");
      return;
    }

    // Read all task docs from workspace_documents
    const docs = await documentStorage.getDocumentsByType("task");
    if (docs.length === 0) {
      log.log("No task documents found, nothing to migrate");
      return;
    }

    log.log(`Found ${docs.length} task documents to migrate`);

    let migrated = 0;
    const seen = new Set<number>();

    for (const doc of docs) {
      try {
        const meta = (doc.metadata || {}) as Record<string, unknown>;
        const id = Number(meta.id);
        if (!id || isNaN(id) || seen.has(id)) continue;
        seen.add(id);

        // Map legacy "push" status to "on_hold"
        let status = String(meta.status || "ready");
        if (status === "push") status = "on_hold";

        await db.execute(sql`
          INSERT INTO "tasks" ("id", "title", "description", "status", "priority", "impact", "effort",
            "owner", "requires_review", "project_id", "milestone_id", "tags", "deliverable",
            "acceptance_criteria", "context", "output", "estimate_low", "estimate_high",
            "deadline", "token_estimate", "created_at", "updated_at")
          VALUES (
            ${id},
            ${String(meta.title || "Untitled")},
            ${String(meta.description || "")},
            ${status},
            ${String(meta.priority || "mid")},
            ${String(meta.impact || "mid")},
            ${String(meta.effort || "mid")},
            ${String(meta.owner || "me")},
            ${Boolean(meta.requiresReview)},
            ${meta.projectId != null ? Number(meta.projectId) : null},
            ${meta.milestoneId != null ? Number(meta.milestoneId) : null},
            ${JSON.stringify(Array.isArray(meta.tags) ? meta.tags : [])}::jsonb,
            ${String(meta.deliverable || "")},
            ${String(meta.acceptanceCriteria || "")},
            ${String(meta.context || "")},
            ${String(meta.output || "")},
            ${meta.estimateLow != null ? Number(meta.estimateLow) : null},
            ${meta.estimateHigh != null ? Number(meta.estimateHigh) : null},
            ${meta.deadline ? String(meta.deadline) : null},
            ${meta.tokenEstimate != null ? Number(meta.tokenEstimate) : null},
            ${meta.createdAt ? new Date(String(meta.createdAt)) : new Date()},
            ${meta.updatedAt ? new Date(String(meta.updatedAt)) : new Date()}
          )
          ON CONFLICT DO NOTHING
        `);

        migrated++;
      } catch (err) {
        log.error(`Failed to migrate task doc docId=${doc.docId}`, err);
      }
    }

    // Reset the serial sequence to max id
    if (migrated > 0) {
      await db.execute(sql`SELECT setval(pg_get_serial_sequence('tasks', 'id'), (SELECT COALESCE(MAX(id), 1) FROM tasks))`);
    }

    log.log(`Task migration complete: migrated ${migrated} tasks from ${docs.length} documents`);

    // Clean up old task documents from workspace_documents
    if (migrated > 0) {
      let cleaned = 0;
      for (const doc of docs) {
        try {
          await documentStorage.deleteDocument("task", doc.docId);
          cleaned++;
        } catch {
          // Non-fatal — old docs will just sit unused
        }
      }
      log.log(`Cleaned up ${cleaned} old task documents from workspace_documents`);
    }
  } catch (err) {
    log.error("Task migration failed (non-fatal)", err);
  }
}
