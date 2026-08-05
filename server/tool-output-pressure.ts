import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "./db";
import { toolOutputAdmissions } from "@shared/schema";
import type { Principal } from "./principal";

const MAX_LIMIT = 50;
const MAX_OFFSET = 5_000;
const MAX_HOURS = 720;

export interface AdmissionMetadata {
  principal: Principal;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  toolName: string;
  action?: string;
  disposition: string;
  rawChars: number;
  rawTokens: number;
  injectedChars: number;
  injectedTokens: number;
}

export async function recordToolOutputAdmission(value: AdmissionMetadata): Promise<void> {
  await db.insert(toolOutputAdmissions).values({
    ownerAccountId: value.principal.accountId,
    ownerUserId: value.principal.userId,
    sessionId: value.sessionId || null,
    runId: value.runId || null,
    toolCallId: value.toolCallId || null,
    toolName: value.toolName.slice(0, 120),
    action: (value.action || "").slice(0, 120),
    disposition: value.disposition.slice(0, 32),
    rawChars: Math.max(0, value.rawChars),
    rawTokens: Math.max(0, value.rawTokens),
    injectedChars: Math.max(0, value.injectedChars),
    injectedTokens: Math.max(0, value.injectedTokens),
  });
}

export async function rankToolOutputPressure(args: {
  principal: Principal;
  hours?: number;
  limit?: number;
  offset?: number;
}) {
  const hours = Math.min(MAX_HOURS, Math.max(1, Math.floor(args.hours || 24)));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit || 20)));
  const offset = Math.min(MAX_OFFSET, Math.max(0, Math.floor(args.offset || 0)));
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const rows = await db.execute(sql`
    WITH scoped AS (
      SELECT tool_name, action, run_id, disposition, raw_chars, raw_tokens,
             injected_tokens, created_at
      FROM tool_output_admissions
      WHERE owner_account_id = ${args.principal.accountId}
        AND owner_user_id = ${args.principal.userId}
        AND created_at >= ${since}
    ), ranked AS (
      SELECT tool_name, action,
        count(*)::int AS result_count,
        count(DISTINCT run_id)::int AS affected_run_count,
        coalesce(sum(raw_tokens), 0)::bigint AS total_raw_tokens,
        coalesce(sum(injected_tokens), 0)::bigint AS total_injected_tokens,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY raw_chars)::int AS p95_result_chars,
        max(raw_chars)::int AS max_result_chars,
        round(avg((disposition <> 'inline')::int)::numeric, 4) AS archive_rate
      FROM scoped GROUP BY tool_name, action
    ), repeats AS (
      SELECT tool_name, action, coalesce(sum(result_count - 1), 0)::int AS repeated_result_count
      FROM (
        SELECT tool_name, action, run_id, count(*)::int AS result_count
        FROM scoped WHERE run_id IS NOT NULL
        GROUP BY tool_name, action, run_id HAVING count(*) > 1
      ) r GROUP BY tool_name, action
    )
    SELECT ranked.*, coalesce(repeats.repeated_result_count, 0)::int AS repeated_result_count
    FROM ranked LEFT JOIN repeats USING (tool_name, action)
    ORDER BY total_raw_tokens DESC, max_result_chars DESC, tool_name, action
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    windowHours: hours,
    limit,
    offset,
    nextOffset: rows.rows.length === limit && offset + limit <= MAX_OFFSET ? offset + limit : null,
    correlation: { workingContextRefresh: "unavailable", reason: "No deterministic admission-to-refresh event key is persisted." },
    offenders: rows.rows,
  };
}
