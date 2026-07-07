import { createHmac, timingSafeEqual } from "crypto";
import type { Request } from "express";

const HEADER = "x-db-sync-import-auth";
const VERSION = "v1";
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;

function signingPayload(syncId: string, timestamp: string): string {
  return `db-sync-import:${VERSION}:${syncId}:${timestamp}`;
}

function sign(secret: string, syncId: string, timestamp: string): string {
  return createHmac("sha256", secret).update(signingPayload(syncId, timestamp)).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createDbSyncImportAuthHeader(secret: string, syncId: string, now = Date.now()): string {
  const timestamp = String(now);
  return `${VERSION}:${timestamp}:${syncId}:${sign(secret, syncId, timestamp)}`;
}

export function verifyDbSyncImportAuthHeader(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const raw = req.header(HEADER);
  if (!raw) return false;
  const [version, timestamp, syncId, signature, ...extra] = raw.split(":");
  if (extra.length > 0 || version !== VERSION || !timestamp || !syncId || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) return false;
  return safeEqualHex(signature, sign(secret, syncId, timestamp));
}

export function getDbSyncImportSecretFromEnv(): string | undefined {
  return process.env.DB_SYNC_IMPORT_TOKEN || process.env.SESSION_SECRET || undefined;
}
