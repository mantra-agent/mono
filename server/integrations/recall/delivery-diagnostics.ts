import { pool } from "../../db";

export type RecallDeliveryDiagnostic = {
  receivedAt: string;
  path: "status" | "transcript";
  event: string;
  webhookId: string | null;
  accepted: boolean;
  responseStatus: number;
  reason?: string;
  providerStatus?: string;
  providerSubCode?: string;
};

let ensurePromise: Promise<void> | null = null;

async function ensureRecallDeliveryDiagnosticsTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = pool.query(`
      CREATE TABLE IF NOT EXISTS recall_webhook_delivery_diagnostics (
        id BIGSERIAL PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        path TEXT NOT NULL CHECK (path IN ('status', 'transcript')),
        event TEXT NOT NULL,
        webhook_id TEXT,
        accepted BOOLEAN NOT NULL,
        response_status INTEGER NOT NULL,
        reason TEXT,
        provider_status TEXT,
        provider_sub_code TEXT
      );
      ALTER TABLE recall_webhook_delivery_diagnostics
        ADD COLUMN IF NOT EXISTS provider_status TEXT;
      ALTER TABLE recall_webhook_delivery_diagnostics
        ADD COLUMN IF NOT EXISTS provider_sub_code TEXT;
      CREATE INDEX IF NOT EXISTS recall_webhook_delivery_diagnostics_received_at_idx
        ON recall_webhook_delivery_diagnostics (received_at DESC);
    `).then(() => undefined).catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}

export async function recordRecallDelivery(entry: RecallDeliveryDiagnostic): Promise<void> {
  await ensureRecallDeliveryDiagnosticsTable();
  await pool.query(
    `INSERT INTO recall_webhook_delivery_diagnostics
      (received_at, path, event, webhook_id, accepted, response_status, reason, provider_status, provider_sub_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.receivedAt,
      entry.path,
      entry.event,
      entry.webhookId,
      entry.accepted,
      entry.responseStatus,
      entry.reason ?? null,
      entry.providerStatus ?? null,
      entry.providerSubCode ?? null,
    ],
  );
}

export async function getRecallDeliveryDiagnostics(limit = 20): Promise<RecallDeliveryDiagnostic[]> {
  await ensureRecallDeliveryDiagnosticsTable();
  const boundedLimit = Math.min(100, Math.max(1, limit));
  const result = await pool.query(
    `SELECT received_at, path, event, webhook_id, accepted, response_status, reason, provider_status, provider_sub_code
       FROM recall_webhook_delivery_diagnostics
      ORDER BY received_at DESC
      LIMIT $1`,
    [boundedLimit],
  );
  return result.rows.map((row) => ({
    receivedAt: new Date(row.received_at).toISOString(),
    path: row.path,
    event: row.event,
    webhookId: row.webhook_id,
    accepted: row.accepted,
    responseStatus: row.response_status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.provider_status ? { providerStatus: row.provider_status } : {}),
    ...(row.provider_sub_code ? { providerSubCode: row.provider_sub_code } : {}),
  }));
}
