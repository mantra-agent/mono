import { and, count, eq, gte, isNotNull, lt, min } from "drizzle-orm";
import { accounts, users } from "@shared/schema";
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

/**
 * Point-in-time identity stocks. Accounts are ordinary live rows
 * (`status = active`). Users are every registered login. Archived and
 * suspended accounts are excluded; presence and password-signup provenance
 * are different quantities.
 */
export async function sampleIdentityStock(): Promise<IdentityStockSample> {
  const [[accountStock], [userStock]] = await Promise.all([
    db
      .select({ value: count() })
      .from(accounts)
      .where(eq(accounts.status, "active")),
    db
      .select({ value: count() })
      .from(users),
  ]);

  return {
    accounts: Number(accountStock?.value ?? 0),
    registeredUsers: Number(userStock?.value ?? 0),
  };
}

/**
 * Authentication-owned aggregate of proven password signups in one half-open
 * interval, plus the current identity stocks. NULL signup provenance is
 * historical uncertainty, never zero evidence. Stocks ignore the interval.
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
