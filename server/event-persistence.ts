import { pool } from "./db";
import type { BusEvent } from "./event-bus";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import type { Principal } from "./principal";

const log = createLogger("EventPersistence");

export async function persistEvent(busEvent: BusEvent): Promise<number | undefined> {
  try {
    const result = await pool.query(
      `INSERT INTO system_events (event_id, boot_id, category, event, payload, run_id, session_key, scope, owner_user_id, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        busEvent.id,
        busEvent.bootId || null,
        busEvent.category,
        busEvent.event,
        JSON.stringify(busEvent.payload || {}),
        busEvent.runId || null,
        busEvent.sessionKey || null,
        busEvent.audience.scope,
        busEvent.audience.scope === "user" ? busEvent.audience.ownerUserId : null,
        busEvent.audience.scope === "user" ? busEvent.audience.accountId : null,
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
  principal?: Principal;
}

function appendVisibleEventScope(conditions: string[], params: unknown[], principal: Principal): void {
  if (principal.actorType === "system") return;
  if (principal.actorType !== "user" || !principal.accountId) {
    conditions.push("FALSE");
    return;
  }
  const accountParam = params.length + 1;
  params.push(principal.accountId);
  const canReadSystem = principal.permissions.includes("system:read");
  conditions.push(`(scope = 'global' OR (scope = 'user' AND account_id = $${accountParam})${canReadSystem ? " OR scope = 'system'" : ""})`);
}

export async function queryEvents(filters: EventQueryFilters): Promise<{ events: any[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  const principal = filters.principal ?? getCurrentPrincipalOrSystem();
  appendVisibleEventScope(conditions, params, principal);
  let paramIdx = params.length + 1;

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
    `SELECT id, event_id, boot_id, category, event, payload, run_id, session_key, scope, owner_user_id, account_id, created_at
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
    audience: row.scope === "user"
      ? { scope: "user", ownerUserId: row.owner_user_id, accountId: row.account_id }
      : { scope: row.scope },
    createdAt: row.created_at,
  }));

  return { events, total };
}


export interface EventReplayResult {
  events: BusEvent[];
  cursorFound: boolean;
}

export async function replayVisibleEvents(input: {
  afterEventId?: string;
  category?: string;
  payloadQuery?: Record<string, unknown>;
  limit?: number;
  principal: Principal;
}): Promise<EventReplayResult> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  appendVisibleEventScope(conditions, params, input.principal);
  let cursorFound = !input.afterEventId;

  if (input.afterEventId) {
    const cursorConditions = ["event_id = $1"];
    const cursorParams: unknown[] = [input.afterEventId];
    appendVisibleEventScope(cursorConditions, cursorParams, input.principal);
    const cursor = await pool.query(
      `SELECT id FROM system_events WHERE ${cursorConditions.join(" AND ")} LIMIT 1`,
      cursorParams,
    );
    if (cursor.rows.length > 0) {
      cursorFound = true;
      params.push(cursor.rows[0].id);
      conditions.push(`id > $${params.length}`);
    }
  }

  if (input.category) {
    params.push(input.category);
    conditions.push(`category = $${params.length}`);
  }
  if (input.payloadQuery && Object.keys(input.payloadQuery).length > 0) {
    params.push(JSON.stringify(input.payloadQuery));
    conditions.push(`payload @> $${params.length}::jsonb`);
  }

  const limit = Math.min(Math.max(input.limit ?? 200, 1), 200);
  params.push(limit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = cursorFound && input.afterEventId ? "ASC" : "DESC";
  const result = await pool.query(
    `SELECT event_id, boot_id, category, event, payload, run_id, session_key, scope, owner_user_id, account_id, created_at
     FROM system_events ${where}
     ORDER BY id ${order}
     LIMIT $${params.length}`,
    params,
  );
  const rows = cursorFound && input.afterEventId ? result.rows : [...result.rows].reverse();
  return {
    cursorFound,
    events: rows.map((row) => ({
      id: row.event_id,
      timestamp: new Date(row.created_at).getTime(),
      category: row.category,
      event: row.event,
      payload: row.payload || {},
      runId: row.run_id || undefined,
      sessionKey: row.session_key || undefined,
      bootId: row.boot_id || undefined,
      audience: row.scope === "user"
        ? { scope: "user", ownerUserId: row.owner_user_id, accountId: row.account_id }
        : { scope: row.scope },
    })),
  };
}

export async function getEventByDbId(dbId: number, principal: Principal = getCurrentPrincipalOrSystem()): Promise<any | undefined> {
  return getEventByColumn("id", dbId, principal);
}

export async function getEventByEventId(eventId: string, principal: Principal = getCurrentPrincipalOrSystem()): Promise<any | undefined> {
  return getEventByColumn("event_id", eventId, principal);
}

async function getEventByColumn(column: "id" | "event_id", value: number | string, principal: Principal): Promise<any | undefined> {
  try {
    const conditions = [`${column} = $1`];
    const params: unknown[] = [value];
    appendVisibleEventScope(conditions, params, principal);
    const result = await pool.query(
      `SELECT id, event_id, boot_id, category, event, payload, run_id, session_key, scope, owner_user_id, account_id, created_at
       FROM system_events WHERE ${conditions.join(" AND ")} LIMIT 1`,
      params,
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
      audience: row.scope === "user"
        ? { scope: "user", ownerUserId: row.owner_user_id, accountId: row.account_id }
        : { scope: row.scope },
      dbId: row.id,
    };
  } catch (error) {
    log.error("event lookup failed", {
      column,
      error: error instanceof Error ? error.message : String(error),
    });
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
