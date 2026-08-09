import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { pool } from "../../db";
import { getCurrentPrincipal } from "../../principal-context";
import { createSerialQueue } from "../../utils/serial-async-delivery";

export interface RailwayAttributionContext {
  caller: string;
  platformEnvironmentId?: number | null;
  providerConnectionId?: number | null;
  sessionId?: string | null;
  runId?: string | null;
}

export interface RailwayDispatchReceipt { id: number; startedAt: number }

const contextStore = new AsyncLocalStorage<RailwayAttributionContext>();
const receiptWrites = createSerialQueue({ label: "railway-api-call-receipts" });

export function runWithRailwayAttribution<T>(context: RailwayAttributionContext, fn: () => T): T {
  return contextStore.run({ ...contextStore.getStore(), ...context }, fn);
}

export function getRailwayAttribution(): RailwayAttributionContext | null {
  return contextStore.getStore() ?? null;
}

export async function ensureRailwayRequestAttributionSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS railway_api_call_receipts (
      id BIGSERIAL PRIMARY KEY,
      dispatched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ,
      provider_connection_id INTEGER REFERENCES provider_connections(id) ON DELETE SET NULL,
      token_fingerprint TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_class TEXT NOT NULL CHECK (request_class IN ('observation', 'release')),
      caller TEXT NOT NULL,
      platform_environment_id INTEGER REFERENCES platform_product_environments(id) ON DELETE SET NULL,
      principal_scope TEXT NOT NULL CHECK (principal_scope IN ('user', 'system')),
      owner_user_id TEXT,
      account_id TEXT,
      session_id TEXT,
      run_id TEXT,
      outcome TEXT NOT NULL DEFAULT 'dispatched' CHECK (outcome IN ('dispatched', 'succeeded', 'provider_error', 'transport_error')),
      http_status INTEGER,
      duration_ms INTEGER,
      rate_limit_limit INTEGER,
      rate_limit_remaining INTEGER,
      rate_limit_reset TEXT,
      retry_after TEXT,
      CHECK ((principal_scope = 'user' AND owner_user_id IS NOT NULL AND account_id IS NOT NULL)
        OR (principal_scope = 'system' AND owner_user_id IS NULL AND account_id IS NULL))
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_railway_api_calls_connection_hour ON railway_api_call_receipts(provider_connection_id, dispatched_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_railway_api_calls_caller_hour ON railway_api_call_receipts(caller, operation, dispatched_at DESC)`);
}

export async function beginRailwayDispatch(input: { token: string; operation: string; requestClass: "observation" | "release" }): Promise<RailwayDispatchReceipt> {
  return receiptWrites.enqueueAndWait(async () => {
    const context = getRailwayAttribution();
    const principal = getCurrentPrincipal();
    const userOwned = principal?.actorType === "user" && !!principal.userId && !!principal.accountId;
    if (!userOwned && principal?.actorType !== "system") throw new Error("Railway dispatch requires explicit user or system principal attribution");
    const result = await pool.query<{ id: string }>(`
      INSERT INTO railway_api_call_receipts
        (provider_connection_id, token_fingerprint, operation, request_class, caller, platform_environment_id,
         principal_scope, owner_user_id, account_id, session_id, run_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
    `, [context?.providerConnectionId ?? null, crypto.createHash("sha256").update(input.token).digest("hex").slice(0, 24),
      input.operation, input.requestClass, context?.caller ?? principal?.jobName ?? input.operation,
      context?.platformEnvironmentId ?? null, userOwned ? "user" : "system", userOwned ? principal!.userId : null,
      userOwned ? principal!.accountId : null, context?.sessionId ?? null, context?.runId ?? null]);
    return { id: Number(result.rows[0].id), startedAt: Date.now() };
  });
}

function integerHeader(headers: Headers, name: string): number | null {
  const value = Number(headers.get(name));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function settleRailwayDispatch(receipt: RailwayDispatchReceipt, outcome: "succeeded" | "provider_error" | "transport_error", response?: Response): Promise<void> {
  await receiptWrites.enqueueAndWait(() => pool.query(`
    UPDATE railway_api_call_receipts SET completed_at=CURRENT_TIMESTAMP, outcome=$2, http_status=$3, duration_ms=$4,
      rate_limit_limit=$5, rate_limit_remaining=$6, rate_limit_reset=$7, retry_after=$8 WHERE id=$1
  `, [receipt.id, outcome, response?.status ?? null, Math.max(0, Date.now() - receipt.startedAt),
    response ? integerHeader(response.headers, "x-ratelimit-limit") : null,
    response ? integerHeader(response.headers, "x-ratelimit-remaining") : null,
    response?.headers.get("x-ratelimit-reset")?.slice(0, 100) ?? null,
    response?.headers.get("retry-after")?.slice(0, 100) ?? null]).then(() => undefined));
}
