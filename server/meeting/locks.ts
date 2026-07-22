import { createHash } from "crypto";
import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("MeetingLocks");

/**
 * One advisory-lock key per meeting session for ALL transport-control
 * mutations (leave, reset/rejoin). A single key means leave and reset are
 * mutually exclusive for the same meeting, so a recovery attempt can never
 * race a departure into two conflicting bot lifecycles.
 */
function transportLockKey(sessionId: string): bigint {
  const hash = createHash("sha256").update(`meeting-transport:${sessionId}`).digest();
  let key = 0n;
  for (let index = 0; index < 8; index += 1) {
    key = (key << 8n) | BigInt(hash[index]);
  }
  return key & 0x7fffffffffffffffn;
}

/** Serialize transport-control mutations for one meeting across processes. */
export async function withMeetingTransportLock<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const key = transportLockKey(sessionId);
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key.toString()]);
    return await operation();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
    } catch {
      log.warn(`failed to release transport lock sessionId=${sessionId}`);
    }
    client.release();
  }
}
