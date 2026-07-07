import { db } from "./db";
import { plaidTransactions, transferPairOverrides } from "@shared/schema";
import { and, eq, gte, isNull, or, inArray, sql } from "drizzle-orm";
import { createLogger } from "./log";
import { randomUUID } from "crypto";

const log = createLogger("InternalTransfers");

const DEFAULT_DATE_WINDOW_DAYS = 3;
const AMOUNT_EPSILON = 0.005;

export interface PairingResult {
  scanned: number;
  pairs: number;
  unpaired: number;
}

interface TxnRow {
  transactionId: string;
  accountId: string;
  date: string;
  amount: number;
  isInternalTransfer: boolean;
  transferPairId: string | null;
  transferPairSource: string | null;
}

function daysBetween(a: string, b: string): number {
  const aD = new Date(a + "T00:00:00Z").getTime();
  const bD = new Date(b + "T00:00:00Z").getTime();
  return Math.abs(aD - bD) / 86400000;
}

function bucketKey(amount: number): string {
  return Math.round(Math.abs(amount) * 100).toString();
}

/**
 * Pair candidate transactions across DIFFERENT accounts where amounts are
 * equal-and-opposite within a date window. Skips any transaction that already
 * has a manual override (mark/unmark/forced pair).
 *
 * Strategy: bucket eligible txns by |amount|; within each bucket, greedily pair
 * one positive (outflow) with one negative (inflow) from a different account
 * if dates fall within `dateWindowDays`. Pairs are written under a fresh UUID
 * and both rows flagged `isInternalTransfer=true`, source='auto'.
 */
async function pairTransactions(opts: { startDate?: string; dateWindowDays?: number }): Promise<PairingResult> {
  const dateWindowDays = opts.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;

  // Pull manual override transactionIds we must skip / honor specially.
  const overrides = await db.select().from(transferPairOverrides);
  const skipIds = new Set<string>();
  for (const o of overrides) {
    skipIds.add(o.transactionId);
    if (o.pairWithTransactionId) skipIds.add(o.pairWithTransactionId);
  }

  // Load candidate transactions (auto-pairable). Honor optional startDate.
  const conds = [
    or(eq(plaidTransactions.transferPairSource, "auto"), isNull(plaidTransactions.transferPairSource))!,
  ];
  if (opts.startDate) conds.push(gte(plaidTransactions.date, opts.startDate));

  const rows = await db
    .select({
      transactionId: plaidTransactions.transactionId,
      accountId: plaidTransactions.accountId,
      date: plaidTransactions.date,
      amount: plaidTransactions.amount,
      isInternalTransfer: plaidTransactions.isInternalTransfer,
      transferPairId: plaidTransactions.transferPairId,
      transferPairSource: plaidTransactions.transferPairSource,
    })
    .from(plaidTransactions)
    .where(and(...conds));

  // First, clear any STALE auto pairings whose counterpart is missing or whose
  // amount/date no longer matches — keeps the pairing self-healing across
  // Plaid revisions.
  const byId = new Map<string, TxnRow>();
  for (const r of rows) byId.set(r.transactionId, r as TxnRow);

  const toUnpair: string[] = [];
  for (const r of rows) {
    if (!r.transferPairId || r.transferPairSource !== "auto") continue;
    if (skipIds.has(r.transactionId)) continue;
    const partner = rows.find(
      x => x.transferPairId === r.transferPairId && x.transactionId !== r.transactionId,
    );
    const valid =
      partner &&
      partner.accountId !== r.accountId &&
      Math.abs(partner.amount + r.amount) < AMOUNT_EPSILON &&
      daysBetween(partner.date, r.date) <= dateWindowDays;
    if (!valid) toUnpair.push(r.transactionId);
  }
  if (toUnpair.length > 0) {
    await db
      .update(plaidTransactions)
      .set({ transferPairId: null, isInternalTransfer: false, transferPairSource: null })
      .where(inArray(plaidTransactions.transactionId, toUnpair));
    for (const id of toUnpair) {
      const row = byId.get(id);
      if (row) {
        row.transferPairId = null;
        row.isInternalTransfer = false;
        row.transferPairSource = null;
      }
    }
  }

  // Bucket unpaired (or stale-cleared) eligible candidates.
  const buckets = new Map<string, { positives: TxnRow[]; negatives: TxnRow[] }>();
  for (const r of rows) {
    if (skipIds.has(r.transactionId)) continue;
    if (r.transferPairId) continue; // already paired (auto, valid)
    if (Math.abs(r.amount) < AMOUNT_EPSILON) continue;
    const key = bucketKey(r.amount);
    let b = buckets.get(key);
    if (!b) {
      b = { positives: [], negatives: [] };
      buckets.set(key, b);
    }
    if (r.amount > 0) b.positives.push(r);
    else b.negatives.push(r);
  }

  const newPairs: Array<{ a: TxnRow; b: TxnRow; pairId: string }> = [];

  for (const { positives, negatives } of Array.from(buckets.values())) {
    if (positives.length === 0 || negatives.length === 0) continue;
    positives.sort((x, y) => x.date.localeCompare(y.date));
    negatives.sort((x, y) => x.date.localeCompare(y.date));
    const usedNeg = new Set<number>();
    for (const pos of positives) {
      let bestIdx = -1;
      let bestDelta = Infinity;
      for (let i = 0; i < negatives.length; i++) {
        if (usedNeg.has(i)) continue;
        const neg = negatives[i];
        if (neg.accountId === pos.accountId) continue;
        const delta = daysBetween(pos.date, neg.date);
        if (delta > dateWindowDays) continue;
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        usedNeg.add(bestIdx);
        const neg = negatives[bestIdx];
        newPairs.push({ a: pos, b: neg, pairId: randomUUID() });
      }
    }
  }

  for (const { a, b, pairId } of newPairs) {
    await db
      .update(plaidTransactions)
      .set({ transferPairId: pairId, isInternalTransfer: true, transferPairSource: "auto" })
      .where(inArray(plaidTransactions.transactionId, [a.transactionId, b.transactionId]));
  }

  // Apply manual overrides AFTER auto pairing so overrides win.
  await applyManualOverrides(overrides);

  const unpaired = rows.length - toUnpair.length - newPairs.length * 2;
  log.log(`pairing: scanned=${rows.length} new_pairs=${newPairs.length} cleared_stale=${toUnpair.length}`);
  return { scanned: rows.length, pairs: newPairs.length, unpaired };
}

async function applyManualOverrides(
  overrides: Array<typeof transferPairOverrides.$inferSelect>,
): Promise<void> {
  for (const o of overrides) {
    if (o.forceUnmark) {
      await db
        .update(plaidTransactions)
        .set({ transferPairId: null, isInternalTransfer: false, transferPairSource: "manual" })
        .where(eq(plaidTransactions.transactionId, o.transactionId));
      continue;
    }

    if (o.pairWithTransactionId) {
      const partners = await db
        .select()
        .from(plaidTransactions)
        .where(inArray(plaidTransactions.transactionId, [o.transactionId, o.pairWithTransactionId]));
      if (partners.length !== 2) continue;
      const pairId = randomUUID();
      await db
        .update(plaidTransactions)
        .set({ transferPairId: pairId, isInternalTransfer: true, transferPairSource: "manual" })
        .where(inArray(plaidTransactions.transactionId, [o.transactionId, o.pairWithTransactionId]));
      continue;
    }

    if (o.forceMarkInternal) {
      await db
        .update(plaidTransactions)
        .set({ isInternalTransfer: true, transferPairSource: "manual" })
        .where(eq(plaidTransactions.transactionId, o.transactionId));
    }
  }
}

export async function pairAllTransactions(): Promise<PairingResult> {
  return pairTransactions({});
}

export async function pairRecentTransactions(windowDays = 30): Promise<PairingResult> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - windowDays);
  const startDate = cutoff.toISOString().slice(0, 10);
  return pairTransactions({ startDate });
}

/**
 * Manually mark a transaction as an internal transfer, optionally pairing
 * with a counterpart. Re-runs override-aware pairing afterwards so any UI
 * display is fully consistent.
 */
export async function markInternalTransfer(transactionId: string, pairWith?: string): Promise<void> {
  await db
    .insert(transferPairOverrides)
    .values({
      transactionId,
      pairWithTransactionId: pairWith ?? null,
      forceMarkInternal: true,
      forceUnmark: false,
    })
    .onConflictDoUpdate({
      target: transferPairOverrides.transactionId,
      set: {
        pairWithTransactionId: pairWith ?? null,
        forceMarkInternal: true,
        forceUnmark: false,
        updatedAt: new Date(),
      },
    });
  if (pairWith) {
    // Mirror the override on the partner so subsequent auto-runs respect it
    // even if the user only marked one side.
    await db
      .insert(transferPairOverrides)
      .values({
        transactionId: pairWith,
        pairWithTransactionId: transactionId,
        forceMarkInternal: true,
        forceUnmark: false,
      })
      .onConflictDoUpdate({
        target: transferPairOverrides.transactionId,
        set: {
          pairWithTransactionId: transactionId,
          forceMarkInternal: true,
          forceUnmark: false,
          updatedAt: new Date(),
        },
      });
  }
  await pairRecentTransactions(365);
}

export async function unmarkInternalTransfer(transactionId: string): Promise<void> {
  // Find the existing pair so we clear both sides cleanly.
  const [row] = await db
    .select({ transferPairId: plaidTransactions.transferPairId })
    .from(plaidTransactions)
    .where(eq(plaidTransactions.transactionId, transactionId));

  const partnerIds: string[] = [transactionId];
  if (row?.transferPairId) {
    const partners = await db
      .select({ transactionId: plaidTransactions.transactionId })
      .from(plaidTransactions)
      .where(eq(plaidTransactions.transferPairId, row.transferPairId));
    for (const p of partners) if (!partnerIds.includes(p.transactionId)) partnerIds.push(p.transactionId);
  }

  for (const id of partnerIds) {
    await db
      .insert(transferPairOverrides)
      .values({
        transactionId: id,
        pairWithTransactionId: null,
        forceMarkInternal: false,
        forceUnmark: true,
      })
      .onConflictDoUpdate({
        target: transferPairOverrides.transactionId,
        set: {
          pairWithTransactionId: null,
          forceMarkInternal: false,
          forceUnmark: true,
          updatedAt: new Date(),
        },
      });
  }

  await db
    .update(plaidTransactions)
    .set({ transferPairId: null, isInternalTransfer: false, transferPairSource: "manual" })
    .where(inArray(plaidTransactions.transactionId, partnerIds));
}

/**
 * Lookup partner metadata for a set of transactionIds — used by the
 * transactions endpoint to decorate rows with pair info for the UI badge.
 */
export async function getPairCounterparts(
  transactionIds: string[],
): Promise<Map<string, { transactionId: string; accountId: string; date: string; amount: number; name: string }>> {
  const result = new Map<string, { transactionId: string; accountId: string; date: string; amount: number; name: string }>();
  if (transactionIds.length === 0) return result;

  const rows = await db
    .select({
      transactionId: plaidTransactions.transactionId,
      transferPairId: plaidTransactions.transferPairId,
      accountId: plaidTransactions.accountId,
      date: plaidTransactions.date,
      amount: plaidTransactions.amount,
      name: plaidTransactions.name,
    })
    .from(plaidTransactions)
    .where(inArray(plaidTransactions.transactionId, transactionIds));

  const pairIds = rows.map(r => r.transferPairId).filter((x): x is string => !!x);
  if (pairIds.length === 0) return result;

  const partners = await db
    .select({
      transactionId: plaidTransactions.transactionId,
      transferPairId: plaidTransactions.transferPairId,
      accountId: plaidTransactions.accountId,
      date: plaidTransactions.date,
      amount: plaidTransactions.amount,
      name: plaidTransactions.name,
    })
    .from(plaidTransactions)
    .where(inArray(plaidTransactions.transferPairId, pairIds));

  const byPair = new Map<string, typeof partners>();
  for (const p of partners) {
    if (!p.transferPairId) continue;
    const arr = byPair.get(p.transferPairId) ?? [];
    arr.push(p);
    byPair.set(p.transferPairId, arr);
  }

  for (const r of rows) {
    if (!r.transferPairId) continue;
    const group = byPair.get(r.transferPairId) ?? [];
    const partner = group.find(p => p.transactionId !== r.transactionId);
    if (partner) {
      result.set(r.transactionId, {
        transactionId: partner.transactionId,
        accountId: partner.accountId,
        date: partner.date,
        amount: partner.amount,
        name: partner.name,
      });
    }
  }

  return result;
}

// Avoid stacking concurrent pair runs from rapid Plaid sync chains.
let _activePairRun: Promise<PairingResult> | null = null;
export async function schedulePairingAfterSync(windowDays = 30): Promise<PairingResult> {
  if (_activePairRun) return _activePairRun;
  _activePairRun = pairRecentTransactions(windowDays).finally(() => {
    _activePairRun = null;
  });
  return _activePairRun;
}
