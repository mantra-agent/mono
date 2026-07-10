import { db } from "./db";
import { eq } from "drizzle-orm";
import {
  transactionAmortizations,
  plaidTransactions,
  type TransactionAmortization,
  type InsertTransactionAmortization,
} from "@shared/schema";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithSensitiveVisible, combineWithSensitiveWritable, sensitiveOwnershipValues } from "./sensitive-scope";

const log = createLogger("Finance");

const amortizationScopeColumns = {
  ownerUserId: transactionAmortizations.ownerUserId,
  principalAccountId: transactionAmortizations.principalAccountId,
  vaultId: transactionAmortizations.vaultId,
};
const transactionScopeColumns = {
  ownerUserId: plaidTransactions.ownerUserId,
  principalAccountId: plaidTransactions.principalAccountId,
  vaultId: plaidTransactions.vaultId,
};

export interface AmortizationWithTxn {
  id: number;
  transactionId: string;
  originalAmount: number;
  spreadMonths: number;
  startMonth: string;
  category: string;
  isActive: boolean;
  notes: string | null;
  createdAt: Date;
  txnMonth: string | null;
  txnName: string | null;
  txnMerchantName: string | null;
  orphaned: boolean;
}

function monthOf(dateStr: string | null | undefined): string | null {
  if (!dateStr || dateStr.length < 7) return null;
  return dateStr.substring(0, 7);
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function spreadCovers(amort: { startMonth: string; spreadMonths: number }, month: string): boolean {
  if (month < amort.startMonth) return false;
  const end = addMonths(amort.startMonth, amort.spreadMonths - 1);
  return month <= end;
}

export async function listAmortizations(opts: { activeOnly?: boolean } = {}): Promise<TransactionAmortization[]> {
  const principal = getCurrentPrincipalOrSystem();
  const predicate = opts.activeOnly
    ? combineWithSensitiveVisible(amortizationScopeColumns, eq(transactionAmortizations.isActive, true), principal)
    : combineWithSensitiveVisible(amortizationScopeColumns, undefined, principal);
  return await db.select().from(transactionAmortizations).where(predicate);
}

export async function listAmortizationsWithTxn(opts: { activeOnly?: boolean } = {}): Promise<AmortizationWithTxn[]> {
  const [amorts, txns] = await Promise.all([
    listAmortizations(opts),
    db.select().from(plaidTransactions).where(combineWithSensitiveVisible(transactionScopeColumns, undefined, getCurrentPrincipalOrSystem())),
  ]);
  const txnById = new Map(txns.map(t => [t.transactionId, t]));
  return amorts.map(a => {
    const txn = txnById.get(a.transactionId);
    if (!txn && a.isActive) {
      log.warn(`[Finance] Orphaned amortization id=${a.id} txnId=${a.transactionId} — transaction no longer in Plaid data`);
    }
    return {
      id: a.id,
      transactionId: a.transactionId,
      originalAmount: a.originalAmount,
      spreadMonths: a.spreadMonths,
      startMonth: a.startMonth,
      category: a.category,
      isActive: a.isActive,
      notes: a.notes,
      createdAt: a.createdAt,
      txnMonth: monthOf(txn?.date),
      txnName: txn?.name ?? null,
      txnMerchantName: txn?.merchantName ?? null,
      orphaned: !txn,
    };
  });
}

export async function createAmortization(data: InsertTransactionAmortization): Promise<TransactionAmortization> {
  const [row] = await db.insert(transactionAmortizations).values({
    ...data,
    ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()),
  }).returning();
  log.log(`[Finance] Created amortization id=${row.id} txnId=${row.transactionId} amount=${row.originalAmount} months=${row.spreadMonths}`);
  return row;
}

export async function updateAmortization(id: number, patch: Partial<Pick<TransactionAmortization, "spreadMonths" | "isActive" | "startMonth" | "category" | "notes">>): Promise<TransactionAmortization | null> {
  const [row] = await db.update(transactionAmortizations)
    .set(patch)
    .where(combineWithSensitiveWritable(amortizationScopeColumns, eq(transactionAmortizations.id, id), getCurrentPrincipalOrSystem()))
    .returning();
  if (row) log.log(`[Finance] Updated amortization id=${id}`);
  return row ?? null;
}

export async function softDeleteAmortization(id: number): Promise<boolean> {
  const [row] = await db.update(transactionAmortizations)
    .set({ isActive: false })
    .where(combineWithSensitiveWritable(amortizationScopeColumns, eq(transactionAmortizations.id, id), getCurrentPrincipalOrSystem()))
    .returning();
  if (row) log.log(`[Finance] Soft-deleted amortization id=${id}`);
  return !!row;
}

/**
 * Pure function that overlays amortization adjustments on top of a per-category
 * spending map for a single month.
 *
 * Semantics for each active, non-orphaned amortization A:
 *   - Always remove the lump from the txn's own month:
 *       If A.txnMonth === month: subtract A.originalAmount from spending[A.category]
 *   - Distribute slices across the spread:
 *       If A.startMonth <= month < A.startMonth + A.spreadMonths:
 *         add (A.originalAmount / A.spreadMonths) to spending[A.category]
 *
 * The lump is removed from the txn month regardless of where the spread starts
 * (before, equal to, or after the txn month). Amortizing a transaction means
 * "treat this as deferred spend": the original cash outflow is replaced by the
 * monthly slices that represent it, no matter the chosen start month.
 *
 * Orphaned amortizations (txnMonth === null) are skipped with a warning. The
 * caller can choose what `category` keys to use — raw plaid keys or normalized
 * display names — as long as `amortizations[i].category` matches the rawSpending
 * key space.
 */
export function getAmortizedSpendingForMonth(
  month: string,
  rawSpending: Record<string, number>,
  amortizations: AmortizationWithTxn[],
): Record<string, number> {
  const out: Record<string, number> = { ...rawSpending };
  for (const a of amortizations) {
    if (!a.isActive) continue;
    if (a.orphaned || !a.txnMonth) continue;

    if (a.txnMonth === month) {
      out[a.category] = (out[a.category] || 0) - a.originalAmount;
    }
    if (spreadCovers(a, month)) {
      const monthly = a.originalAmount / a.spreadMonths;
      out[a.category] = (out[a.category] || 0) + monthly;
    }
  }
  // Drop categories that have collapsed to ~0 (clean-up only — keep negatives if any)
  for (const k of Object.keys(out)) {
    if (Math.abs(out[k]) < 0.005) delete out[k];
  }
  return out;
}

/**
 * Returns true if amortization is active and currently spreading (start <= now < start + spread).
 */
export function isAmortizationCurrentlyActive(a: AmortizationWithTxn, currentMonth: string): boolean {
  return a.isActive && !a.orphaned && spreadCovers(a, currentMonth);
}
