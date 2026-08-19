import { and, count, countDistinct, eq, gte, isNotNull, lt, min, ne, or } from "drizzle-orm";
import { accounts, memberships, users } from "@shared/schema";
import { db } from "./db";

export interface NewUsersCoverage {
  status: "partial";
  availableFrom: string | null;
  historicalRows: "unclassified";
}

export interface IdentityStockSample {
  accounts: number;
  registeredUsers: number;
}

export interface IdentityRangeSample extends IdentityStockSample {
  newUsers: number;
  newUsersCoverage: NewUsersCoverage;
}

export const IDENTITY_STOCK_PARTIAL_REASON =
  "Reconstructed as of range.end from created and updated timestamps; lifecycle history is incomplete.";

/**
 * Point-in-time identity stocks. Accounts are ordinary live rows
 * (`status = active`). Users is the living identity base: distinct users with
 * at least one membership on an active Account. Users have no lifecycle field
 * of their own, so Account status is the sole discriminant — a user whose only
 * Accounts are archived or suspended is not counted. Presence and
 * password-signup provenance are different quantities.
 */
export async function sampleIdentityStock(): Promise<IdentityStockSample> {
  const [[accountStock], [userStock]] = await Promise.all([
    db
      .select({ value: count() })
      .from(accounts)
      .where(eq(accounts.status, "active")),
    db
      .select({ value: countDistinct(memberships.userId) })
      .from(memberships)
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .where(eq(accounts.status, "active")),
  ]);

  return {
    accounts: Number(accountStock?.value ?? 0),
    registeredUsers: Number(userStock?.value ?? 0),
  };
}

/**
 * Reconstruct identity stocks as of `at`.
 *
 * There is no SCD. An Account is treated as active at `at` when it existed
 * (`createdAt < at`) and is either still active, or left active later
 * (`status != active` and `updatedAt >= at`). Memberships use the same
 * existence cut. Permanent deletes and mid-life status flips that later
 * reverse are invisible — callers must mark historical coverage partial.
 */
export async function sampleIdentityStockAsOf(at: Date): Promise<IdentityStockSample> {
  const existedAndActiveAsOf = and(
    lt(accounts.createdAt, at),
    or(
      eq(accounts.status, "active"),
      and(ne(accounts.status, "active"), gte(accounts.updatedAt, at)),
    ),
  );

  const [[accountStock], [userStock]] = await Promise.all([
    db
      .select({ value: count() })
      .from(accounts)
      .where(existedAndActiveAsOf),
    db
      .select({ value: countDistinct(memberships.userId) })
      .from(memberships)
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .where(and(lt(memberships.createdAt, at), existedAndActiveAsOf)),
  ]);

  return {
    accounts: Number(accountStock?.value ?? 0),
    registeredUsers: Number(userStock?.value ?? 0),
  };
}

/**
 * Authentication-owned aggregate of proven password signups in one half-open
 * interval, plus the current identity stocks. NULL signup provenance is
 * historical uncertainty, never zero evidence. Stock fields on this result
 * remain live; historical stock reads go through sampleIdentityStockAsOf.
 */
export async function sampleIdentityRange(start: Date, end: Date): Promise<IdentityRangeSample> {
  const [[range], [coverage], stock] = await Promise.all([
    db
      .select({ value: count() })
      .from(users)
      .where(and(
        isNotNull(users.passwordSignupAt),
        gte(users.passwordSignupAt, start),
        lt(users.passwordSignupAt, end),
      )),
    db
      .select({ availableFrom: min(users.passwordSignupAt) })
      .from(users)
      .where(isNotNull(users.passwordSignupAt)),
    sampleIdentityStock(),
  ]);

  const availableFrom = coverage?.availableFrom;
  return {
    ...stock,
    newUsers: Number(range?.value ?? 0),
    newUsersCoverage: {
      status: "partial",
      availableFrom: availableFrom instanceof Date
        ? availableFrom.toISOString()
        : availableFrom ? new Date(availableFrom).toISOString() : null,
      historicalRows: "unclassified",
    },
  };
}
