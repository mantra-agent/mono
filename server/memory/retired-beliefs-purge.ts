import { sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { tagRegistry } from "../file-storage/tags";

const log = createLogger("RetiredBeliefsPurge");
const MARKER_KEY = "migration.retired_beliefs.v1";

export async function purgeRetiredBeliefs(): Promise<void> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${MARKER_KEY}))`);
    const marker = await tx.execute(sql`SELECT 1 FROM system_settings WHERE key = ${MARKER_KEY} LIMIT 1`);
    if (marker.rows.length > 0) return null;

    const beliefMemoryIds = await tx.execute(sql`
      SELECT id FROM memory_entries WHERE source = 'belief'
    `);
    const derivedClaims = await tx.execute(sql`
      DELETE FROM memory_vnext_claims
      WHERE source = 'belief'
         OR source_memory_id IN (SELECT id FROM memory_entries WHERE source = 'belief')
         OR id IN (
           SELECT claim_id
           FROM memory_vnext_sources
           WHERE source_type = 'belief'
         )
    `);
    const queueRows = await tx.execute(sql`
      DELETE FROM memory_vnext_source_queue WHERE source_type = 'belief'
    `);
    const vnextRefs = await tx.execute(sql`
      DELETE FROM memory_vnext_sources WHERE source_type = 'belief'
    `);
    const legacyRefs = await tx.execute(sql`
      DELETE FROM memory_sources WHERE source_type = 'belief'
    `);
    const documents = await tx.execute(sql`
      DELETE FROM document_store_documents WHERE document_type = 'belief'
    `);
    const workspaceDocuments = await tx.execute(sql`
      DELETE FROM workspace_documents WHERE doc_type = 'belief'
    `);
    const memories = await tx.execute(sql`
      DELETE FROM memory_entries WHERE source = 'belief'
    `);

    const counts = {
      beliefMemoryIds: beliefMemoryIds.rows.length,
      derivedClaims: derivedClaims.rowCount ?? 0,
      queueRows: queueRows.rowCount ?? 0,
      vnextRefs: vnextRefs.rowCount ?? 0,
      legacyRefs: legacyRefs.rowCount ?? 0,
      documents: documents.rowCount ?? 0,
      workspaceDocuments: workspaceDocuments.rowCount ?? 0,
      memories: memories.rowCount ?? 0,
    };
    await tx.execute(sql`
      INSERT INTO system_settings(key, value, updated_at)
      VALUES (${MARKER_KEY}, ${JSON.stringify({ completedAt: new Date().toISOString(), ...counts })}::jsonb, NOW())
    `);
    return counts;
  });

  await tagRegistry.removeRetiredEntityTypeUsages("belief");
  if (result) log.info(`complete ${JSON.stringify(result)}`);
}
