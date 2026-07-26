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
function meetingLockKey(namespace: "transport" | "occurrence" | "native", identity: string): bigint {
  const hash = createHash("sha256").update(`meeting-${namespace}:${identity}`).digest();
  let key = 0n;
  for (let index = 0; index < 8; index += 1) {
    key = (key << 8n) | BigInt(hash[index]);
  }
  return key & 0x7fffffffffffffffn;
}

/** Serialize transport-control mutations for one meeting across processes. */
async function withMeetingLock<T>(
  namespace: "transport" | "occurrence" | "native",
  identity: string,
  operation: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const key = meetingLockKey(namespace, identity);
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key.toString()]);
    return await operation();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
    } catch {
      log.warn(`failed to release meeting lock namespace=${namespace}`);
    }
    client.release();
  }
}

export function withMeetingTransportLock<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withMeetingLock("transport", sessionId, operation);
}

/** Serialize calendar occurrence get-or-create and Recall dispatch across replicas. */
export function withMeetingOccurrenceLock<T>(
  occurrenceKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withMeetingLock("occurrence", occurrenceKey, operation);
}

/** Serialize native meeting creation for one owner-provided idempotency key. */
export function withNativeMeetingCreationLock<T>(
  ownerUserId: string,
  idempotencyKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withMeetingLock("native", `${ownerUserId}:${idempotencyKey}`, operation);
}
