import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("BackfillRelationshipTypes");

const BATCH_SIZE = 500;

interface QueryResult {
  rows: Array<Record<string, string | number>>;
  rowCount: number;
}

export async function ensureRelationshipTypeColumn(): Promise<void> {
  log.log("Ensuring relationship_type column exists on memory_links...");

  const client = await pool.connect();
  try {
    const colCheck: any = await client.query(`
      /* associative:backfill */
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'memory_links' AND column_name = 'relationship_type'
    `);

    if (colCheck.rows.length === 0) {
      await client.query(`
        /* associative:backfill */
        ALTER TABLE memory_links
        ADD COLUMN relationship_type text DEFAULT 'related'
      `);
      log.log("relationship_type column added as nullable with DEFAULT 'related' (for backfill).");
    } else {
      log.log("relationship_type column already exists.");
    }
  } finally {
    client.release();
  }
}

export async function ensureRelationshipTypeIndexes(): Promise<void> {
  log.log("Ensuring associative retrieval indexes...");

  const client = await pool.connect();
  try {
    await client.query(`
      /* associative:backfill */
      CREATE INDEX IF NOT EXISTS idx_memory_links_relationship_type
      ON memory_links (relationship_type)
    `);

    await client.query(`
      /* associative:backfill */
      CREATE INDEX IF NOT EXISTS idx_memory_layer_created_at
      ON memory_entries (layer, created_at DESC)
    `);

    await client.query(`
      /* associative:backfill */
      CREATE INDEX IF NOT EXISTS idx_memory_tags_gin
      ON memory_entries USING GIN (tags)
    `);

    log.log("All associative retrieval indexes ensured.");
  } finally {
    client.release();
  }
}

export async function backfillRelationshipTypes(): Promise<{ updated: number; batches: number }> {
  log.log("Starting relationship_type backfill (idempotent, WHERE relationship_type IS NULL OR 'related')...");

  const client = await pool.connect();
  try {
    const countResult: any = await client.query(`
      /* associative:backfill */
      SELECT COUNT(*) as cnt FROM memory_links WHERE (relationship_type IS NULL OR relationship_type = 'related') AND LENGTH(relationship) > 20
    `);
    const pendingCount = Number(countResult.rows[0]?.cnt ?? 0);
    if (pendingCount === 0) {
      log.log("No links need backfilling (all have relationship_type set).");
      return { updated: 0, batches: 0 };
    }
    log.log(`Found ${pendingCount} links with NULL or 'related' relationship_type (LENGTH > 20) to backfill`);

    const maxIdResult: any = await client.query(
      `/* associative:backfill */ SELECT MAX(id) as max_id FROM memory_links`
    );
    const maxId = Number(maxIdResult.rows[0]?.max_id ?? 0);
    if (maxId === 0) {
      return { updated: 0, batches: 0 };
    }

    let updated = 0;
    let batches = 0;

    for (let startId = 0; startId <= maxId; startId += BATCH_SIZE) {
      const endId = startId + BATCH_SIZE;
      const result: any = await client.query(`
        /* associative:backfill */
        UPDATE memory_links
        SET relationship_type = CASE
          WHEN relationship ILIKE '%led to%' OR relationship ILIKE '%led_to%' THEN 'led_to'
          WHEN relationship ILIKE '%caused%' OR relationship ILIKE '%result%in%' OR relationship ILIKE '%trigger%' THEN 'causal'
          WHEN relationship ILIKE '%contradict%' OR relationship ILIKE '%oppos%' OR relationship ILIKE '%conflict%' OR relationship ILIKE '%disagree%' THEN 'contradicts'
          WHEN relationship ILIKE '%support%' OR relationship ILIKE '%reinforc%' OR relationship ILIKE '%confirm%' OR relationship ILIKE '%align%' THEN 'supports'
          WHEN relationship ILIKE '%block%' OR relationship ILIKE '%prevent%' OR relationship ILIKE '%hinder%' THEN 'blocks'
          WHEN relationship ILIKE '%depend%' OR relationship ILIKE '%require%' OR relationship ILIKE '%need%' THEN 'depends_on'
          WHEN relationship ILIKE '%evolv%' OR relationship ILIKE '%updat%' OR relationship ILIKE '%revis%' OR relationship ILIKE '%shift%' THEN 'evolves'
          WHEN relationship ILIKE '%temporal%' OR relationship ILIKE '%same time%' OR relationship ILIKE '%concurrent%' THEN 'temporal'
          ELSE 'related'
        END
        WHERE id > $1 AND id <= $2
        AND (relationship_type IS NULL OR relationship_type = 'related') AND LENGTH(relationship) > 20
      `, [startId, endId]);

      updated += result.rowCount;
      batches++;

      if (batches % 10 === 0) {
        log.log(`Backfill progress: batch ${batches}, updated ${updated} links so far`);
      }
    }

    log.log(`Backfill complete: ${updated} links updated in ${batches} batches`);
    return { updated, batches };
  } finally {
    client.release();
  }
}

/** Catches any remaining NULLs after the reclassification pass and enforces NOT NULL. */
async function finalizeColumn(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      /* associative:backfill */
      UPDATE memory_links SET relationship_type = 'related' WHERE relationship_type IS NULL
    `);

    await client.query(`
      /* associative:backfill */
      ALTER TABLE memory_links ALTER COLUMN relationship_type SET DEFAULT 'related'
    `);

    await client.query(`
      /* associative:backfill */
      ALTER TABLE memory_links ALTER COLUMN relationship_type SET NOT NULL
    `);

    log.log("relationship_type column finalized: DEFAULT 'related', NOT NULL.");
  } finally {
    client.release();
  }
}

export async function runRelationshipTypeMigration(): Promise<void> {
  await ensureRelationshipTypeColumn();
  await backfillRelationshipTypes();
  await finalizeColumn();
  await ensureRelationshipTypeIndexes();
}
