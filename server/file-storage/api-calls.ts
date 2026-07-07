import { pool } from "../db";
import type { ApiCall, InsertApiCall } from "@shared/schema";
import { createLogger } from "../log";
import { getSetting } from "../system-settings";
import { storageBackend, PRIVATE_PREFIX } from "../object_storage/objectStorage";
import type { QueryResultRow } from "pg";

const log = createLogger("StoreApiCalls");

const INFERENCE_DEBUG_KEY = "system.inference_debug";
const S3_PREFIX = `${PRIVATE_PREFIX}inference/`;

interface ApiCallRow extends QueryResultRow {
  id: number;
  timestamp: Date;
  model: string;
  provider: string;
  profile: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number;
  cost_input: number;
  cost_output: number;
  cost_total: number;
  session_key: string | null;
  session_id: number | null;
  duration_ms: number | null;
  stop_reason: string | null;
  metadata?: Record<string, unknown>;
}

interface SummaryRow extends QueryResultRow {
  total_calls: number;
  total_cost: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
}

interface DateAggRow extends QueryResultRow {
  date: Date | string;
  calls: number;
  cost: string;
  tokens: number;
}

interface HourAggRow extends QueryResultRow {
  hour: Date | string;
  calls: number;
  cost: string;
  tokens: number;
}

interface ModelAggRow extends QueryResultRow {
  provider: string;
  model: string;
  calls: number;
  cost: string;
  tokens: number;
  avg_duration: string | null;
  input_tokens: number;
  output_tokens: number;
}

interface ModelDateRow extends QueryResultRow {
  date: Date | string;
  model: string;
  cost: string;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
}

interface ModelHourRow extends QueryResultRow {
  hour: Date | string;
  model: string;
  cost: string;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
}

interface ProfileAggRow extends QueryResultRow {
  profile: string;
  calls: number;
  cost: string;
  tokens: number;
  avg_duration: string | null;
  total_duration: number;
  input_tokens: number;
  output_tokens: number;
}

interface SessionAggRow extends QueryResultRow {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost: string;
  peak_input_tokens: number;
}

interface CountRow extends QueryResultRow {
  cnt: number;
}

export interface TokenUsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  peakInputTokens: number;
}

let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(() => {}, () => {});
  return result;
}

function rowToApiCall(row: ApiCallRow): ApiCall {
  return {
    id: row.id,
    timestamp: row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp),
    provider: row.provider || "",
    model: row.model || "",
    profile: row.profile ?? null,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? null,
    cacheWriteTokens: row.cache_write_tokens ?? null,
    totalTokens: row.total_tokens ?? 0,
    costInput: row.cost_input ?? 0,
    costOutput: row.cost_output ?? 0,
    costTotal: row.cost_total ?? 0,
    sessionKey: row.session_key ?? null,
    sessionId: row.session_id ?? null,
    requestContent: null,
    responseContent: null,
    durationMs: row.duration_ms ?? null,
    stopReason: row.stop_reason ?? null,
    metadata: row.metadata ?? null,
  };
}

function rowToApiCallLight(row: ApiCallRow): Omit<ApiCall, 'requestContent' | 'responseContent'> {
  return {
    id: row.id,
    timestamp: row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp),
    provider: row.provider || "",
    model: row.model || "",
    profile: row.profile ?? null,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? null,
    cacheWriteTokens: row.cache_write_tokens ?? null,
    totalTokens: row.total_tokens ?? 0,
    costInput: row.cost_input ?? 0,
    costOutput: row.cost_output ?? 0,
    costTotal: row.cost_total ?? 0,
    sessionKey: row.session_key ?? null,
    sessionId: row.session_id ?? null,
    durationMs: row.duration_ms ?? null,
    stopReason: row.stop_reason ?? null,
    metadata: row.metadata ?? null,
  };
}

function buildSinceQuery(baseQuery: string, since: Date | undefined): { query: string; params: Array<Date | number> } {
  const params: Array<Date | number> = [];
  let query = baseQuery;
  if (since) {
    params.push(since);
    query += ` WHERE timestamp >= $${params.length}`;
  }
  return { query, params };
}

function buildWhereParams(since: Date | undefined, params: Array<Date | string | number>): string {
  if (!since) return "";
  params.push(since);
  return `WHERE timestamp >= $${params.length}`;
}

export class FileApiCallStorage {
  async createApiCall(call: InsertApiCall): Promise<ApiCall> {
    return enqueueWrite(async () => {
      const result = await pool.query<ApiCallRow>(
        `INSERT INTO api_calls (timestamp, model, provider, profile, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, cost_input, cost_output, cost_total,
          session_key, session_id, duration_ms, stop_reason, metadata)
        VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING *`,
        [
          call.model, call.provider, call.profile ?? null,
          call.inputTokens ?? 0, call.outputTokens ?? 0,
          call.cacheReadTokens ?? null, call.cacheWriteTokens ?? null,
          call.totalTokens ?? 0, call.costInput ?? 0, call.costOutput ?? 0, call.costTotal ?? 0,
          call.sessionKey ?? null, call.sessionId ?? null,
          call.durationMs ?? null, call.stopReason ?? null,
          call.metadata ? JSON.stringify(call.metadata) : null,
        ]
      );
      const full = rowToApiCall(result.rows[0]);
      log.log(`createApiCall id=${full.id} model=${full.model} provider=${full.provider} cost=${full.costTotal}`);

      // Fire-and-forget: write content to S3 if inference debug is enabled
      if (call.requestContent || call.responseContent) {
        getSetting<boolean>(INFERENCE_DEBUG_KEY).then((enabled) => {
          if (!enabled) return;
          const key = `${S3_PREFIX}${full.id}.json`;
          const body = JSON.stringify({
            requestContent: call.requestContent ?? null,
            responseContent: call.responseContent ?? null,
          });
          storageBackend.putObject(key, body, { contentType: "application/json" }).catch((err) => {
            log.error(`Failed to write inference content to S3 for id=${full.id}:`, err);
          });
        }).catch((err) => {
          log.error(`Failed to check inference_debug setting:`, err);
        });
      }

      return full;
    });
  }

  async getApiCalls(limit = 50, offset = 0, since?: Date): Promise<ApiCall[]> {
    const { query: baseQuery, params } = buildSinceQuery(
      `SELECT id, timestamp, model, provider, profile, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, cost_input, cost_output, cost_total,
        session_key, session_id, duration_ms, stop_reason, metadata
        FROM api_calls`,
      since
    );
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;
    const query = `${baseQuery} ORDER BY timestamp DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

    const result = await pool.query<ApiCallRow>(query, params);
    const calls = result.rows.map(rowToApiCallLight);
    log.log(`getApiCalls count=${calls.length} limit=${limit} offset=${offset}`);
    return calls as ApiCall[];
  }

  async getApiCall(id: number): Promise<ApiCall | undefined> {
    const result = await pool.query<ApiCallRow>(`SELECT * FROM api_calls WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      log.log(`getApiCall id=${id} not-found`);
      return undefined;
    }
    log.log(`getApiCall id=${id} found`);
    const call = rowToApiCall(result.rows[0]);

    // Try to fetch content from S3
    const content = await this.fetchContentFromS3(id);
    if (content) {
      call.requestContent = content.requestContent;
      call.responseContent = content.responseContent;
    }

    return call;
  }

  async getApiCallSummary(since?: Date): Promise<{
    totalCalls: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
  }> {
    const { query, params } = buildSinceQuery(
      `SELECT COUNT(*)::int AS total_calls,
        COALESCE(SUM(cost_total), 0) AS total_cost,
        COALESCE(SUM(input_tokens), 0)::int AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS total_output_tokens,
        COALESCE(SUM(total_tokens), 0)::int AS total_tokens
        FROM api_calls`,
      since
    );
    const result = await pool.query<SummaryRow>(query, params);
    const row = result.rows[0];
    const summary = {
      totalCalls: row.total_calls || 0,
      totalCost: parseFloat(row.total_cost) || 0,
      totalInputTokens: row.total_input_tokens || 0,
      totalOutputTokens: row.total_output_tokens || 0,
      totalTokens: row.total_tokens || 0,
    };
    log.log(`getApiCallSummary totalCalls=${summary.totalCalls} totalCost=${summary.totalCost.toFixed(4)}`);
    return summary;
  }

  async getApiCallsByDay(since?: Date, tz?: string): Promise<Array<{ date: string; calls: number; cost: number; tokens: number }>> {
    const params: Array<Date | string | number> = [];
    const where = buildWhereParams(since, params);
    let dateExpr: string;
    let dateGroup: string;
    if (tz) {
      params.push(tz);
      const tzIdx = params.length;
      dateExpr = `to_char((timestamp AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx})::date, 'YYYY-MM-DD')`;
      dateGroup = `(timestamp AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx})::date`;
    } else {
      dateExpr = `to_char(DATE(timestamp), 'YYYY-MM-DD')`;
      dateGroup = `DATE(timestamp)`;
    }
    const result = await pool.query<DateAggRow>(
      `SELECT ${dateExpr} AS date, COUNT(*)::int AS calls,
        COALESCE(SUM(cost_total), 0) AS cost, COALESCE(SUM(total_tokens), 0)::int AS tokens
        FROM api_calls ${where} GROUP BY ${dateGroup} ORDER BY date`,
      params
    );
    return result.rows.map(r => ({
      date: String(r.date),
      calls: r.calls,
      cost: parseFloat(r.cost) || 0,
      tokens: r.tokens,
    }));
  }

  async getApiCallsByHour(since?: Date, tz?: string): Promise<Array<{ hour: string; calls: number; cost: number; tokens: number }>> {
    const params: Array<Date | string | number> = [];
    const where = buildWhereParams(since, params);
    let hourExpr: string;
    let hourGroup: string;
    if (tz) {
      params.push(tz);
      const tzIdx = params.length;
      hourExpr = `to_char(date_trunc('hour', timestamp AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx}), 'YYYY-MM-DD HH24:00')`;
      hourGroup = `date_trunc('hour', timestamp AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx})`;
    } else {
      hourExpr = `to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')`;
      hourGroup = `date_trunc('hour', timestamp)`;
    }
    const result = await pool.query<HourAggRow>(
      `SELECT ${hourExpr} AS hour, COUNT(*)::int AS calls,
        COALESCE(SUM(cost_total), 0) AS cost, COALESCE(SUM(total_tokens), 0)::int AS tokens
        FROM api_calls ${where} GROUP BY ${hourGroup} ORDER BY hour`,
      params
    );
    return result.rows.map(r => ({
      hour: String(r.hour),
      calls: r.calls,
      cost: parseFloat(r.cost) || 0,
      tokens: r.tokens,
    }));
  }

  async getApiCallsByModel(since?: Date): Promise<Array<{ provider: string; model: string; calls: number; cost: number; tokens: number; avgDuration: number | null; inputTokens: number; outputTokens: number }>> {
    const { query: baseQuery, params } = buildSinceQuery(
      `SELECT provider, model, COUNT(*)::int AS calls,
        COALESCE(SUM(cost_total), 0) AS cost, COALESCE(SUM(total_tokens), 0)::int AS tokens,
        AVG(duration_ms) AS avg_duration,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens
        FROM api_calls`,
      since
    );
    const result = await pool.query<ModelAggRow>(`${baseQuery} GROUP BY provider, model ORDER BY cost DESC`, params);
    return result.rows.map(r => ({
      provider: r.provider,
      model: r.model,
      calls: r.calls,
      cost: parseFloat(r.cost) || 0,
      tokens: r.tokens,
      avgDuration: r.avg_duration != null ? Math.round(parseFloat(r.avg_duration)) : null,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    }));
  }

  async getApiCallsByModelByDay(since?: Date, tz?: string): Promise<Array<{ date: string; model: string; cost: number; tokens: number; inputTokens: number; outputTokens: number }>> {
    const params: Array<Date | string | number> = [];
    const where = buildWhereParams(since, params);
    let dateExpr: string;
    let dateGroup: string;
    if (tz) {
      params.push(tz);
      const tzIdx = params.length;
      dateExpr = `to_char((timestamp AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx})::date, 'YYYY-MM-DD')`;
      dateGroup = `(timestamp AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx})::date`;
    } else {
      dateExpr = `to_char(DATE(timestamp), 'YYYY-MM-DD')`;
      dateGroup = `DATE(timestamp)`;
    }
    const result = await pool.query<ModelDateRow>(
      `SELECT ${dateExpr} AS date, model, COALESCE(SUM(cost_total), 0) AS cost,
        COALESCE(SUM(total_tokens), 0)::int AS tokens,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens
        FROM api_calls ${where} GROUP BY ${dateGroup}, model ORDER BY date`,
      params
    );
    return result.rows.map(r => ({
      date: String(r.date),
      model: r.model,
      cost: parseFloat(r.cost) || 0,
      tokens: r.tokens || 0,
      inputTokens: r.input_tokens || 0,
      outputTokens: r.output_tokens || 0,
    }));
  }

  async getApiCallsByModelByHour(since?: Date, tz?: string): Promise<Array<{ hour: string; model: string; cost: number; tokens: number; inputTokens: number; outputTokens: number }>> {
    const params: Array<Date | string | number> = [];
    const where = buildWhereParams(since, params);
    let hourExpr: string;
    let hourGroup: string;
    if (tz) {
      params.push(tz);
      const tzIdx = params.length;
      hourExpr = `to_char(date_trunc('hour', timestamp AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx}), 'YYYY-MM-DD HH24:00')`;
      hourGroup = `date_trunc('hour', timestamp AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx})`;
    } else {
      hourExpr = `to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')`;
      hourGroup = `date_trunc('hour', timestamp)`;
    }
    const result = await pool.query<ModelHourRow>(
      `SELECT ${hourExpr} AS hour, model, COALESCE(SUM(cost_total), 0) AS cost,
        COALESCE(SUM(total_tokens), 0)::int AS tokens,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens
        FROM api_calls ${where} GROUP BY ${hourGroup}, model ORDER BY hour`,
      params
    );
    return result.rows.map(r => ({
      hour: String(r.hour),
      model: r.model,
      cost: parseFloat(r.cost) || 0,
      tokens: r.tokens || 0,
      inputTokens: r.input_tokens || 0,
      outputTokens: r.output_tokens || 0,
    }));
  }

  async getApiCallsByProfile(since?: Date): Promise<Array<{ profile: string; calls: number; cost: number; tokens: number; avgDuration: number | null; totalDuration: number; inputTokens: number; outputTokens: number }>> {
    const { query: baseQuery, params } = buildSinceQuery(
      `SELECT COALESCE(profile, 'unknown') AS profile, COUNT(*)::int AS calls,
        COALESCE(SUM(cost_total), 0) AS cost, COALESCE(SUM(total_tokens), 0)::int AS tokens,
        AVG(duration_ms) AS avg_duration,
        COALESCE(SUM(duration_ms), 0)::int AS total_duration,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens
        FROM api_calls`,
      since
    );
    const result = await pool.query<ProfileAggRow>(`${baseQuery} GROUP BY profile ORDER BY cost DESC`, params);
    return result.rows.map(r => ({
      profile: r.profile,
      calls: r.calls,
      cost: parseFloat(r.cost) || 0,
      tokens: r.tokens,
      avgDuration: r.avg_duration != null ? Math.round(parseFloat(r.avg_duration)) : null,
      totalDuration: r.total_duration,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    }));
  }

  async getTotalApiCallCount(): Promise<number> {
    const result = await pool.query<CountRow>(`SELECT COUNT(*)::int AS cnt FROM api_calls`);
    return result.rows[0]?.cnt ?? 0;
  }

  async getApiCallsBySession(sessionKey: string): Promise<Omit<ApiCall, 'requestContent' | 'responseContent'>[]> {
    const result = await pool.query<ApiCallRow>(
      `SELECT id, timestamp, model, provider, profile, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, cost_input, cost_output, cost_total,
        session_key, session_id, duration_ms, stop_reason, metadata
      FROM api_calls WHERE session_key = $1 ORDER BY timestamp ASC`,
      [sessionKey]
    );
    return result.rows.map(rowToApiCallLight);
  }


  async getTokenUsageByRunId(runId: string): Promise<TokenUsageSummary> {
    const result = await pool.query<SessionAggRow>(
      `SELECT COUNT(*)::int AS calls,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
        COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
        COALESCE(SUM(cost_total), 0) AS cost,
        COALESCE(MAX(input_tokens), 0)::int AS peak_input_tokens
      FROM api_calls WHERE metadata->>'runId' = $1`,
      [runId]
    );
    return this.rowToTokenUsage(result.rows[0]);
  }

  async getTokenUsageByChatSession(sessionId: string, sessionKey?: string | null): Promise<TokenUsageSummary> {
    const keys = Array.from(new Set([sessionKey, sessionKey || `dashboard:${sessionId}`, `dashboard:${sessionId}`, sessionId].filter(Boolean))) as string[];
    const result = await pool.query<SessionAggRow>(
      `SELECT COUNT(*)::int AS calls,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
        COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
        COALESCE(SUM(cost_total), 0) AS cost,
        COALESCE(MAX(input_tokens), 0)::int AS peak_input_tokens
      FROM api_calls
      WHERE session_key = ANY($1::text[]) OR metadata->>'sessionId' = $2`,
      [keys, sessionId]
    );
    return this.rowToTokenUsage(result.rows[0]);
  }

  private rowToTokenUsage(row?: SessionAggRow): TokenUsageSummary {
    return {
      calls: row?.calls || 0,
      inputTokens: row?.input_tokens || 0,
      outputTokens: row?.output_tokens || 0,
      totalTokens: row?.total_tokens || 0,
      cost: parseFloat(row?.cost) || 0,
      peakInputTokens: row?.peak_input_tokens || 0,
    };
  }

  async getApiCallContent(id: number): Promise<{ requestContent: string | null; responseContent: string | null } | undefined> {
    // Verify the call exists
    const exists = await pool.query<{ id: number }>(`SELECT id FROM api_calls WHERE id = $1`, [id]);
    if (exists.rows.length === 0) return undefined;

    // Fetch content from S3
    const content = await this.fetchContentFromS3(id);
    return content ?? { requestContent: null, responseContent: null };
  }

  private async fetchContentFromS3(id: number): Promise<{ requestContent: string | null; responseContent: string | null } | null> {
    try {
      const key = `${S3_PREFIX}${id}.json`;
      const buf = await storageBackend.getObjectBuffer(key);
      const parsed = JSON.parse(buf.toString("utf-8"));
      return {
        requestContent: parsed.requestContent ?? null,
        responseContent: parsed.responseContent ?? null,
      };
    } catch {
      // S3 object doesn't exist or parse failed — content not available
      return null;
    }
  }

  async getTokenUsageBySession(sessionKey: string): Promise<TokenUsageSummary> {
    const result = await pool.query<SessionAggRow>(
      `SELECT COUNT(*)::int AS calls,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
        COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
        COALESCE(SUM(cost_total), 0) AS cost,
        COALESCE(MAX(input_tokens), 0)::int AS peak_input_tokens
      FROM api_calls WHERE session_key = $1`,
      [sessionKey]
    );
    return this.rowToTokenUsage(result.rows[0]);
  }
}

export const fileApiCallStorage = new FileApiCallStorage();
