import { sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { createNamedSystemPrincipal } from "../principal";
import { tagService } from "../tag-service";

const log = createLogger("RetiredBeliefsPurge");
const MARKER_KEY = "migration.retired_beliefs.v2.archival_only";
const MAINTENANCE_PRINCIPAL = createNamedSystemPrincipal("retired-beliefs-purge");

export async function purgeRetiredBeliefs(): Promise<void> {
  // Beliefs are retired product behavior. Do not migrate them into a new
  // generic store and do not delete archived legacy rows during the reader
  // retirement. Probabilistic knowledge belongs in vNext claims; deliberate
  // explanatory positions belong in Theses. This boot hook now records the
  // archival-only boundary and removes stale tag affordances only.
  const marker = await db.execute(sql`SELECT 1 FROM system_settings WHERE key = ${MARKER_KEY} LIMIT 1`);
  if (marker.rows.length === 0) {
    await db.execute(sql`
      INSERT INTO system_settings(key, value, updated_at)
      VALUES (${MARKER_KEY}, ${JSON.stringify({ completedAt: new Date().toISOString(), behavior: "beliefs_retired_archival_only", legacyRowsPreserved: true })}::jsonb, NOW())
    `);
    log.info("complete {\"behavior\":\"beliefs_retired_archival_only\",\"legacyRowsPreserved\":true}");
  }
  await tagService.removeRetiredEntityTypeUsages("belief", MAINTENANCE_PRINCIPAL);
}
