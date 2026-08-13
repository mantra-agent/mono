import { createLogger } from "./log";

const log = createLogger("MemoryInstanceSchema");
const MIGRATION_LOCK_KEY = "migration.memory-instance-ownership.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>>; rowCount?: number }>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Phase 2 first cut: stamp vNext claim graph with pinned Agent Instance.
 *
 * Additive only:
 * - nullable instance_id on claims + claim-graph children read without joining claims
 * - backfill from agent_instance_memberships (owner_user_id + account_id)
 * - leave instance_id null when no pin so rows stay owner-visible
 *
 * Dual-write/read lives in scoped-storage + claim storage. Do not empty tables.
 */
export async function ensureMemoryInstanceOwnershipSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);

    const tables = [
      "memory_vnext_claims",
      "memory_vnext_sources",
      "memory_vnext_entity_links",
      "memory_vnext_claim_links",
      "memory_vnext_claim_link_evidence",
    ] as const;

    for (const table of tables) {
      const exists = await client.query(
        `SELECT to_regclass('public.${table}') IS NOT NULL AS present`,
      );
      if (!exists.rows?.[0]?.present) continue;

      await client.query(`
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS instance_id VARCHAR
      `);

      await client.query(`
        DO $migration$
        BEGIN
          IF to_regclass('public.agent_instances') IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = '${table}_instance_id_fkey'
          ) THEN
            ALTER TABLE ${table}
              ADD CONSTRAINT ${table}_instance_id_fkey
              FOREIGN KEY (instance_id) REFERENCES agent_instances(id) ON DELETE SET NULL;
          END IF;
        END
        $migration$
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_${table}_instance
          ON ${table}(instance_id)
      `);
    }

    // Backfill claims from the writer's Account pin. Leave null when no membership.
    const claimsPresent = await client.query(
      `SELECT to_regclass('public.memory_vnext_claims') IS NOT NULL AS present`,
    );
    if (claimsPresent.rows?.[0]?.present) {
      const claimBackfill = await client.query(`
        UPDATE memory_vnext_claims c
        SET instance_id = m.instance_id
        FROM agent_instance_memberships m
        WHERE c.instance_id IS NULL
          AND c.owner_user_id IS NOT NULL
          AND c.account_id IS NOT NULL
          AND m.user_id = c.owner_user_id
          AND m.account_id = c.account_id
      `);

      // Children inherit from their claim when still null.
      const sourceBackfill = await client.query(`
        UPDATE memory_vnext_sources s
        SET instance_id = c.instance_id
        FROM memory_vnext_claims c
        WHERE s.instance_id IS NULL
          AND s.claim_id = c.id
          AND c.instance_id IS NOT NULL
      `);

      const entityBackfill = await client.query(`
        UPDATE memory_vnext_entity_links e
        SET instance_id = c.instance_id
        FROM memory_vnext_claims c
        WHERE e.instance_id IS NULL
          AND e.claim_id = c.id
          AND c.instance_id IS NOT NULL
      `);

      const linkBackfill = await client.query(`
        UPDATE memory_vnext_claim_links l
        SET instance_id = COALESCE(from_c.instance_id, to_c.instance_id)
        FROM memory_vnext_claims from_c, memory_vnext_claims to_c
        WHERE l.instance_id IS NULL
          AND l.from_claim_id = from_c.id
          AND l.to_claim_id = to_c.id
          AND COALESCE(from_c.instance_id, to_c.instance_id) IS NOT NULL
      `);

      const evidencePresent = await client.query(
        `SELECT to_regclass('public.memory_vnext_claim_link_evidence') IS NOT NULL AS present`,
      );
      let evidenceUpdated = 0;
      if (evidencePresent.rows?.[0]?.present) {
        const evidenceBackfill = await client.query(`
          UPDATE memory_vnext_claim_link_evidence e
          SET instance_id = l.instance_id
          FROM memory_vnext_claim_links l
          WHERE e.instance_id IS NULL
            AND e.claim_link_id = l.id
            AND l.instance_id IS NOT NULL
        `);
        evidenceUpdated = evidenceBackfill.rowCount ?? 0;
      }

      log.info("memory instance ownership convergence complete", {
        claims: claimBackfill.rowCount ?? 0,
        sources: sourceBackfill.rowCount ?? 0,
        entityLinks: entityBackfill.rowCount ?? 0,
        claimLinks: linkBackfill.rowCount ?? 0,
        claimLinkEvidence: evidenceUpdated,
      });
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
