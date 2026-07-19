import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { memoryEntries, type MemoryEntry } from "@shared/schema";
import { memoryEntryLightColumns, wrapLightEntry } from "./memory-storage";

const log = createLogger("LongTitleMaintenance");

export async function backfillLongTitles(options?: { batchDelayMs?: number }): Promise<{ updated: number; skipped: number; errors: string[] }> {
  const WORD_COUNT_THRESHOLD = 5;
  const BATCH_DELAY_MS = options?.batchDelayMs ?? 500;
  const result = { updated: 0, skipped: 0, errors: [] as string[] };

  const BATCH = 50;
  let lastId = 0;
  let hasMore = true;
  let batchNumber = 0;

  while (hasMore) {
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        and(
          or(eq(memoryEntries.layer, "mid"), eq(memoryEntries.layer, "long")),
          sql`COALESCE(${memoryEntries.title}, '') != ''`,
          sql`${memoryEntries.id} > ${lastId}`,
        ),
      )
      .orderBy(memoryEntries.id)
      .limit(BATCH);

    if (rows.length === 0) break;
    if (rows.length < BATCH) hasMore = false;
    const wrappedRows = rows.map((row) => wrapLightEntry(row as Omit<MemoryEntry, "embedding">));
    lastId = wrappedRows[wrappedRows.length - 1].id;
    batchNumber++;

    let batchUpdated = 0;
    for (const row of wrappedRows) {
      const title = (row.title || "").trim();
      const wordCount = title.split(/\s+/).filter(Boolean).length;
      if (wordCount <= WORD_COUNT_THRESHOLD) {
        result.skipped++;
        continue;
      }

      try {
        await db
          .update(memoryEntries)
          .set({ title: null, contentHash: null, processedAt: new Date() })
          .where(eq(memoryEntries.id, row.id));
        result.updated++;
        batchUpdated++;
      } catch (error) {
        const message = `Entry #${row.id}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(message);
        log.error(`backfillLongTitles error: ${message}`);
      }
    }

    if (batchUpdated > 0) {
      log.debug(`batch #${batchNumber}: nulled ${batchUpdated} titles (updated=${result.updated} skipped=${result.skipped})`);
    }
    if (hasMore && BATCH_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  log.debug(`complete updated=${result.updated} skipped=${result.skipped} errors=${result.errors.length}`);
  return result;
}

export async function logMemoryDiagnostics(): Promise<void> {
  try {
    const layerCounts = await db
      .select({ layer: memoryEntries.layer, count: sql<number>`count(*)::int` })
      .from(memoryEntries)
      .groupBy(memoryEntries.layer);
    const sourceCounts = await db
      .select({ source: memoryEntries.source, count: sql<number>`count(*)::int` })
      .from(memoryEntries)
      .groupBy(memoryEntries.source)
      .orderBy(sql`count(*) desc`)
      .limit(10);

    const total = layerCounts.reduce((sum, row) => sum + row.count, 0);
    const layerSummary = layerCounts.map((row) => `${row.layer}=${row.count}`).join(", ");
    const sourceSummary = sourceCounts.map((row) => `${row.source ?? "null"}=${row.count}`).join(", ");
    log.debug(`entries=${total} layers=[${layerSummary}] topSources=[${sourceSummary}]`);
  } catch (error) {
    log.error(`diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
