import { db } from "../db";
import { memoryEntries } from "@shared/schema";
import { sql } from "drizzle-orm";
import { sanitizeSummary } from "../utils/sanitize-summary";
import { createLogger } from "../log";

const log = createLogger("SanitizeSummaries");

export async function sanitizeRawJsonSummaries(): Promise<{ fixed: number }> {
  const rows = await db
    .select({ id: memoryEntries.id, summary: memoryEntries.summary })
    .from(memoryEntries)
    .where(sql`${memoryEntries.summary} LIKE '{%' AND ${memoryEntries.summary} LIKE '%"summary"%'`);

  let fixed = 0;
  for (const row of rows) {
    if (!row.summary) continue;
    const cleaned = sanitizeSummary(row.summary);
    if (cleaned !== row.summary) {
      await db
        .update(memoryEntries)
        .set({ summary: cleaned })
        .where(sql`${memoryEntries.id} = ${row.id}`);
      fixed++;
      log.log(`Fixed summary for entry #${row.id}`);
    }
  }
  return { fixed };
}
