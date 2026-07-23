import { z } from "zod";

const normalizedEmailSchema = z.string().trim().email().transform(value => value.toLowerCase());

/** Canonical claim and authentication email key. Deliberately independent of People. */
export function normalizeEmailAddress(value: string): string {
  return normalizedEmailSchema.parse(value);
}
