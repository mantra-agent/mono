/**
 * One-shot backfill: copy parentSessionId from chat document metadata into the
 * indexed session_tree table. Idempotent — safe to re-run.
 *
 * Usage: tsx scripts/backfill-session-tree.ts
 */
import { db } from "../server/db";
import { memoryEntries, sessionTree } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";

async function main() {
  const startedAt = Date.now();
  const rows = await db
    .select({
      sourceId: memoryEntries.sourceId,
      metadata: memoryEntries.metadata,
    })
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.layer, "workspace"),
        eq(memoryEntries.source, "chat"),
        sql`${memoryEntries.metadata}->>'parentSessionId' IS NOT NULL`,
      ),
    );

  console.log(`[backfill-session-tree] candidates=${rows.length}`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const sessionId = row.sourceId || "";
    if (!sessionId) {
      skipped++;
      continue;
    }
    const meta = (row.metadata as Record<string, unknown>) || {};
    const parentSessionId = (meta.parentSessionId as string) || null;
    const spawnReason = (meta.spawnReason as string) || null;
    const spawnerTool = (meta.spawnerTool as string) || null;
    const spawnerSkillRun = (meta.spawnerSkillRun as string) || null;

    try {
      const existing = await db.select().from(sessionTree).where(eq(sessionTree.sessionId, sessionId)).limit(1);
      if (existing.length > 0) {
        const e = existing[0];
        if (e.parentSessionId === parentSessionId && e.spawnReason === spawnReason) {
          skipped++;
          continue;
        }
        await db
          .update(sessionTree)
          .set({ parentSessionId, spawnReason, spawnerTool, spawnerSkillRun, updatedAt: new Date() })
          .where(eq(sessionTree.sessionId, sessionId));
        updated++;
      } else {
        await db.insert(sessionTree).values({
          sessionId,
          parentSessionId,
          spawnReason,
          spawnerTool,
          spawnerSkillRun,
        });
        inserted++;
      }
    } catch (err: unknown) {
      errors++;
      console.warn(`[backfill-session-tree] error for session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[backfill-session-tree] done in ${elapsedMs}ms — inserted=${inserted} updated=${updated} skipped=${skipped} errors=${errors} candidates=${rows.length} delta=${inserted + updated}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-session-tree] fatal", err);
  process.exit(1);
});
