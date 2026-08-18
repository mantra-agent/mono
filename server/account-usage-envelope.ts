import { eq, sql } from "drizzle-orm";
import { accounts } from "@shared/schema";
import { db } from "./db";
import { fileApiCallStorage } from "./file-storage/api-calls";
import { emitOverageMeterEvent } from "./billing-meter-port";
import { createLogger } from "./log";

const log = createLogger("AccountUsageEnvelope");

export const USAGE_STATUSES = ["ok", "bar", "warn", "pause"] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

export class AccountUsageEnvelopeError extends Error {
  code = "ACCOUNT_USAGE_ENVELOPE_PAUSED";
  constructor(message: string, public accountId?: string) {
    super(message);
    this.name = "AccountUsageEnvelopeError";
  }
}

export interface AccountUsageEnvelope {
  accountId: string;
  routerId: string | null;
  includedTokens: number | null;
  grantedTokens: number;
  usagePeriod: string | null;
  periodTokens: number;
  emittedOverageTokens: number;
  usageStatus: UsageStatus | null;
}

const BAR_FRACTION = 0.8;
const WARN_FRACTION = 1;
const PAUSE_FRACTION = 1.2;

export function utcUsagePeriod(at = new Date()): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function usagePeriodBounds(period: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error(`Invalid usage period ${period}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

export function deriveUsageStatus(periodTokens: number, effectiveInclude: number): UsageStatus {
  if (periodTokens >= effectiveInclude * PAUSE_FRACTION) return "pause";
  if (periodTokens >= effectiveInclude * WARN_FRACTION) return "warn";
  if (periodTokens >= effectiveInclude * BAR_FRACTION) return "bar";
  return "ok";
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) return Number(value);
  return 0;
}

function asNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const next = asNumber(value);
  return Number.isFinite(next) ? next : null;
}

function mapEnvelope(row: {
  id: string;
  routerId: string | null;
  includedTokens: unknown;
  grantedTokens: unknown;
  usagePeriod: string | null;
  periodTokens: unknown;
  emittedOverageTokens: unknown;
  usageStatus: string | null;
}): AccountUsageEnvelope {
  const status = USAGE_STATUSES.includes(row.usageStatus as UsageStatus)
    ? (row.usageStatus as UsageStatus)
    : null;
  return {
    accountId: row.id,
    routerId: row.routerId ?? null,
    includedTokens: asNullableNumber(row.includedTokens),
    grantedTokens: asNumber(row.grantedTokens),
    usagePeriod: row.usagePeriod ?? null,
    periodTokens: asNumber(row.periodTokens),
    emittedOverageTokens: asNumber(row.emittedOverageTokens),
    usageStatus: status,
  };
}

const envelopeColumns = {
  id: accounts.id,
  routerId: accounts.routerId,
  includedTokens: accounts.includedTokens,
  grantedTokens: accounts.grantedTokens,
  usagePeriod: accounts.usagePeriod,
  periodTokens: accounts.periodTokens,
  emittedOverageTokens: accounts.emittedOverageTokens,
  usageStatus: accounts.usageStatus,
};

async function loadEnvelope(accountId: string): Promise<AccountUsageEnvelope | null> {
  const [row] = await db
    .select(envelopeColumns)
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row ? mapEnvelope(row) : null;
}

async function emitOverageDelta(envelope: AccountUsageEnvelope, overage: number): Promise<number> {
  if (overage <= envelope.emittedOverageTokens) return envelope.emittedOverageTokens;
  const period = envelope.usagePeriod ?? utcUsagePeriod();
  const quantity = overage - envelope.emittedOverageTokens;
  const idempotencyKey = `usage:${envelope.accountId}:${period}:${envelope.emittedOverageTokens}:${overage}`;
  const result = await emitOverageMeterEvent({
    accountId: envelope.accountId,
    quantity,
    period,
    idempotencyKey,
  });
  if (result.outcome === "emitted") return overage;
  log.warn(
    `meter emit ${result.outcome} account=${envelope.accountId} period=${period} quantity=${quantity}` +
      (result.outcome === "failed" ? ` error=${result.error}` : ""),
  );
  return envelope.emittedOverageTokens;
}

async function warnStampResidual(accountId: string, routerId: string, period: string): Promise<void> {
  const mismatch = await fileApiCallStorage.countAccountRouterStampResidual(accountId, routerId, period);
  if (mismatch > 0) {
    log.warn(
      `routerId stamp residual account=${accountId} router=${routerId} period=${period} mismatchedRows=${mismatch}`,
    );
  }
}

export async function getAccountUsageEnvelope(accountId: string): Promise<AccountUsageEnvelope | null> {
  return loadEnvelope(accountId);
}

export async function recomputeAccountUsageEnvelope(accountId: string): Promise<AccountUsageEnvelope | null> {
  const projected = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`account-usage:${accountId}`}))`);
    const [row] = await tx
      .select(envelopeColumns)
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!row) return null;
    const current = mapEnvelope(row);
    if (current.includedTokens == null) return current;

    const period = utcUsagePeriod();
    const rollover = current.usagePeriod !== period;
    const grantedTokens = rollover ? 0 : current.grantedTokens;
    const { start, end } = usagePeriodBounds(period);
    const periodTokens = await fileApiCallStorage.sumAccountPeriodTokens(accountId, start, end);
    const usageStatus = deriveUsageStatus(periodTokens, current.includedTokens + grantedTokens);
    const emittedOverageTokens = rollover ? 0 : current.emittedOverageTokens;

    await tx
      .update(accounts)
      .set({
        grantedTokens,
        usagePeriod: period,
        periodTokens,
        emittedOverageTokens,
        usageStatus,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(accounts.id, accountId));

    return {
      ...current,
      grantedTokens,
      usagePeriod: period,
      periodTokens,
      emittedOverageTokens,
      usageStatus,
    };
  });

  if (!projected || projected.includedTokens == null) return projected;

  const overage = Math.max(0, projected.periodTokens - (projected.includedTokens + projected.grantedTokens));
  const emittedOverageTokens = await emitOverageDelta(projected, overage);
  if (emittedOverageTokens !== projected.emittedOverageTokens) {
    await db
      .update(accounts)
      .set({ emittedOverageTokens, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(accounts.id, accountId));
    projected.emittedOverageTokens = emittedOverageTokens;
  }

  if (projected.routerId && projected.usagePeriod) {
    await warnStampResidual(accountId, projected.routerId, projected.usagePeriod);
  }
  return projected;
}

export async function settleAccountUsageEnvelope(accountId: string): Promise<void> {
  try {
    await recomputeAccountUsageEnvelope(accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`envelope settle failed account=${accountId}: ${message}`);
  }
}

export async function setAccountIncludedTokens(
  accountId: string,
  includedTokens: number | null,
): Promise<AccountUsageEnvelope> {
  if (includedTokens != null && (!Number.isInteger(includedTokens) || includedTokens < 0)) {
    throw new Error("includedTokens must be a non-negative integer or null");
  }
  const [updated] = await db
    .update(accounts)
    .set({ includedTokens, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id });
  if (!updated) throw new Error("Account not found");
  const next = await recomputeAccountUsageEnvelope(accountId);
  if (!next) throw new Error("Account not found");
  log.info(`set account include account=${accountId} includedTokens=${includedTokens ?? "null"} status=${next.usageStatus ?? "none"}`);
  return next;
}

export async function grantAccountUsageTokens(
  accountId: string,
  tokens: number,
): Promise<AccountUsageEnvelope> {
  if (!Number.isInteger(tokens) || tokens <= 0) {
    throw new Error("grant tokens must be a positive integer");
  }
  const current = await loadEnvelope(accountId);
  if (!current) throw new Error("Account not found");
  if (current.includedTokens == null) {
    throw new Error("Cannot grant usage on an Account with no include");
  }
  const period = utcUsagePeriod();
  const baseGranted = current.usagePeriod === period ? current.grantedTokens : 0;
  await db
    .update(accounts)
    .set({
      grantedTokens: baseGranted + tokens,
      usagePeriod: period,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(accounts.id, accountId));
  const next = await recomputeAccountUsageEnvelope(accountId);
  if (!next) throw new Error("Account not found");
  log.info(`granted account usage account=${accountId} added=${tokens} granted=${next.grantedTokens} status=${next.usageStatus}`);
  return next;
}

export async function assertAccountUsageDispatchAllowed(accountId: string | null | undefined): Promise<void> {
  if (!accountId) return;
  let envelope = await loadEnvelope(accountId);
  if (!envelope || envelope.includedTokens == null) return;
  if (envelope.usagePeriod !== utcUsagePeriod()) {
    envelope = await recomputeAccountUsageEnvelope(accountId);
    if (!envelope || envelope.includedTokens == null) return;
  }
  if (envelope.usageStatus === "pause") {
    throw new AccountUsageEnvelopeError(
      `Account ${accountId} is paused at ${envelope.periodTokens} tokens against include ${envelope.includedTokens + envelope.grantedTokens}`,
      accountId,
    );
  }
}
