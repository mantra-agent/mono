import { pool } from "./db";
import type { BusEvent } from "./event-bus";
import { createLogger } from "./log";

const log = createLogger("EventPersistence");

export async function persistEvent(busEvent: BusEvent): Promise<number | undefined> {
  try {
    const result = await pool.query(
      `INSERT INTO system_events (event_id, boot_id, category, event, payload, run_id, session_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        busEvent.id,
        busEvent.bootId || null,
        busEvent.category,
        busEvent.event,
        JSON.stringify(busEvent.payload || {}),
        busEvent.runId || null,
        busEvent.sessionKey || null,
      ]
    );
    return result.rows[0]?.id;
  } catch (err: any) {
    log.error(`event persistence failed event=${busEvent.event} eventId=${busEvent.id}: ${err.message}`);
    return undefined;
  }
}

export interface EventQueryFilters {
  category?: string;
  event?: string;
  startDate?: string;
  endDate?: string;
  runId?: string;
  sessionKey?: string;
  payloadQuery?: Record<string, any>;
  limit?: number;
  offset?: number;
}

export async function queryEvents(filters: EventQueryFilters): Promise<{ events: any[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (filters.category) {
    conditions.push(`category = $${paramIdx++}`);
    params.push(filters.category);
  }
  if (filters.event) {
    conditions.push(`event ILIKE $${paramIdx++}`);
    params.push(`%${filters.event}%`);
  }
  if (filters.startDate) {
    conditions.push(`created_at >= $${paramIdx++}`);
    params.push(filters.startDate);
  }
  if (filters.endDate) {
    conditions.push(`created_at <= $${paramIdx++}`);
    params.push(filters.endDate);
  }
  if (filters.runId) {
    conditions.push(`run_id = $${paramIdx++}`);
    params.push(filters.runId);
  }
  if (filters.sessionKey) {
    conditions.push(`session_key = $${paramIdx++}`);
    params.push(filters.sessionKey);
  }
  if (filters.payloadQuery && typeof filters.payloadQuery === "object" && Object.keys(filters.payloadQuery).length > 0) {
    conditions.push(`payload @> $${paramIdx++}::jsonb`);
    params.push(JSON.stringify(filters.payloadQuery));
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters.limit || 100, 500);
  const offset = filters.offset || 0;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM system_events ${whereClause}`,
    params
  );
  const total = countResult.rows[0]?.total || 0;

  const dataResult = await pool.query(
    `SELECT id, event_id, boot_id, category, event, payload, run_id, session_key, created_at
     FROM system_events ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset]
  );

  const events = dataResult.rows.map(row => ({
    id: row.id,
    eventId: row.event_id,
    bootId: row.boot_id,
    category: row.category,
    event: row.event,
    payload: row.payload,
    runId: row.run_id,
    sessionKey: row.session_key,
    createdAt: row.created_at,
  }));

  return { events, total };
}

export async function getEventByDbId(dbId: number): Promise<any | undefined> {
  try {
    const result = await pool.query(
      `SELECT id, event_id, boot_id, category, event, payload, run_id, session_key, created_at
       FROM system_events WHERE id = $1`,
      [dbId]
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0];
    return {
      id: row.event_id,
      timestamp: new Date(row.created_at).getTime(),
      category: row.category,
      event: row.event,
      payload: row.payload || {},
      runId: row.run_id,
      sessionKey: row.session_key,
      bootId: row.boot_id,
      dbId: row.id,
    };
  } catch {
    return undefined;
  }
}

export async function getEventByEventId(eventId: string): Promise<any | undefined> {
  try {
    const result = await pool.query(
      `SELECT id, event_id, boot_id, category, event, payload, run_id, session_key, created_at
       FROM system_events WHERE event_id = $1 LIMIT 1`,
      [eventId]
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0];
    return {
      id: row.event_id,
      timestamp: new Date(row.created_at).getTime(),
      category: row.category,
      event: row.event,
      payload: row.payload || {},
      runId: row.run_id,
      sessionKey: row.session_key,
      bootId: row.boot_id,
      dbId: row.id,
    };
  } catch {
    return undefined;
  }
}

export async function cleanupOldEvents(retentionDays: number = 7): Promise<number> {
  try {
    let totalDeleted = 0;
    // Loop in batches of 10,000 until no rows remain past retention
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await pool.query(
        `DELETE FROM system_events
         WHERE id IN (
           SELECT id FROM system_events
           WHERE created_at < NOW() - INTERVAL '1 day' * $1
           LIMIT 10000
         )`,
        [retentionDays]
      );
      const deleted = result.rowCount || 0;
      if (deleted === 0) break;
      totalDeleted += deleted;
    }
    if (totalDeleted > 0) {
      log.log(`cleanup: deleted ${totalDeleted} events older than ${retentionDays} days`);
    }
    return totalDeleted;
  } catch (err: any) {
    log.warn(`cleanup failed: ${err.message}`);
    return 0;
  }
}
