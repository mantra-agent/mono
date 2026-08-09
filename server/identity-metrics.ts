import { and, count, gte, isNotNull, lt, min } from "drizzle-orm";
import { users } from "@shared/schema";
import { db } from "./db";

export interface NewUsersCoverage {
  status: "partial";
  availableFrom: string | null;
  historicalRows: "unclassified";
}

export interface IdentityRangeSample {
  newUsers: number;
  newUsersCoverage: NewUsersCoverage;
}

/**
 * Authentication-owned aggregate of proven password signups in one half-open
 * interval. NULL provenance is historical uncertainty, never zero evidence.
 */
export async function sampleIdentityRange(start: Date, end: Date): Promise<IdentityRangeSample> {
  const [[range], [coverage]] = await Promise.all([
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
  ]);

  const availableFrom = coverage?.availableFrom;
  return {
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
