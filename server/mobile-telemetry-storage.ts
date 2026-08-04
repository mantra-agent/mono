import { desc } from "drizzle-orm";
import { mobileStartupTelemetry, type InsertMobileStartupTelemetry } from "@shared/schema";
import { db } from "./db";
import { enqueueTelemetryWrite } from "./telemetry-write";

export type MobileStartupTelemetryWrite = InsertMobileStartupTelemetry;

async function writeMobileStartupTelemetry(row: MobileStartupTelemetryWrite): Promise<void> {
  await db.insert(mobileStartupTelemetry).values(row);
}

/**
 * Accept a validated mobile startup sample onto the shared telemetry log-sink.
 * Callers must not await durability on the request path.
 */
export function enqueueMobileStartupTelemetry(row: MobileStartupTelemetryWrite): void {
  enqueueTelemetryWrite("mobile-startup-telemetry.ingest", () => writeMobileStartupTelemetry(row));
}

export async function listRecentMobileStartupTelemetry(limit: number) {
  const bounded = Math.max(1, Math.min(100, limit));
  return db
    .select()
    .from(mobileStartupTelemetry)
    .orderBy(desc(mobileStartupTelemetry.receivedAt))
    .limit(bounded);
}
