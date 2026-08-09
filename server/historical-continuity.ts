import { createHash, randomUUID } from "crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "./db";
import { chatCompletion } from "./model-client";
import { ACTIVITY_FRAMING } from "./job-profiles";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal, runWithPrincipal } from "./principal-context";
import type { Principal } from "./principal";
import { estimateTokens } from "./context-builder";

const log = createLogger("HistoricalContinuity");
const TURN_MAX_INPUT_CHARS = 48_000;
const TURN_MAX_OUTPUT_TOKENS = 320;
const ROLLUP_MAX_OUTPUT_TOKENS = 600;
const HISTORY_TOKEN_BUDGET = 2_400;
const ROLLUP_LEVELS = ["hour", "day", "week", "month", "quarter", "year"] as const;
type RollupLevel = (typeof ROLLUP_LEVELS)[number];

interface TurnSummaryInput {
  sessionId: string;
  vaultId: string;
  assistantMessageId: string;
  turnId?: string;
  runId?: string;
  completedAt: string;
  userContent: string;
  assistantContent: string;
  toolCalls: Array<{ toolName: string; status: string; outcome?: string; result?: unknown; error?: string }>;
}

interface ContinuityRow {
  id: string;
  level: "turn" | RollupLevel;
  bucketStart: Date;
  bucketEnd: Date;
  summary: string;
  sourceStart: Date;
  sourceEnd: Date;
  sourceCount: number;
  sessionId: string | null;
  assistantMessageId: string | null;
}

function parseDatabaseDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeContinuityRow(raw: Record<string, unknown>): ContinuityRow | null {
  const bucketStart = parseDatabaseDate(raw.bucket_start);
  const bucketEnd = parseDatabaseDate(raw.bucket_end);
  const sourceStart = parseDatabaseDate(raw.source_start);
  const sourceEnd = parseDatabaseDate(raw.source_end);
  const level = String(raw.level);
  if (!bucketStart || !bucketEnd || !sourceStart || !sourceEnd || (level !== "turn" && !ROLLUP_LEVELS.includes(level as RollupLevel))) {
    log.warn("continuity.projection.row_skipped", {
      entryId: typeof raw.id === "string" ? raw.id : null,
      level,
      invalidFields: [
        !bucketStart && "bucket_start",
        !bucketEnd && "bucket_end",
        !sourceStart && "source_start",
        !sourceEnd && "source_end",
      ].filter(Boolean),
    });
    return null;
  }
  return {
    id: String(raw.id),
    level: level as ContinuityRow["level"],
    bucketStart,
    bucketEnd,
    summary: String(raw.summary),
    sourceStart,
    sourceEnd,
    sourceCount: Number(raw.source_count),
    sessionId: typeof raw.session_id === "string" ? raw.session_id : null,
    assistantMessageId: typeof raw.assistant_message_id === "string" ? raw.assistant_message_id : null,
  };
}

export async function ensureHistoricalContinuitySchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS historical_continuity_entries (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'user' CHECK (scope = 'user'),
      owner_user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      session_id TEXT,
      assistant_message_id TEXT,
      turn_id TEXT,
      run_id TEXT,
      level TEXT NOT NULL CHECK (level IN ('turn','hour','day','week','month','quarter','year')),
      timezone TEXT NOT NULL,
      bucket_start TIMESTAMPTZ(6) NOT NULL,
      bucket_end TIMESTAMPTZ(6) NOT NULL,
      source_start TIMESTAMPTZ(6) NOT NULL,
      source_end TIMESTAMPTZ(6) NOT NULL,
      source_count INTEGER NOT NULL CHECK (source_count > 0),
      source_entry_ids TEXT[] NOT NULL,
      summary TEXT NOT NULL,
      summary_sha256 TEXT NOT NULL,
      model_derived BOOLEAN NOT NULL DEFAULT TRUE,
      candidate_status TEXT NOT NULL DEFAULT 'candidate' CHECK (candidate_status = 'candidate'),
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT historical_continuity_source_span CHECK (source_start < source_end),
      CONSTRAINT historical_continuity_bucket_span CHECK (bucket_start < bucket_end)
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uk_historical_continuity_turn ON historical_continuity_entries(owner_user_id, account_id, session_id, assistant_message_id) WHERE level = 'turn'`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uk_historical_continuity_bucket ON historical_continuity_entries(owner_user_id, account_id, vault_id, level, timezone, bucket_start)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_historical_continuity_projection ON historical_continuity_entries(owner_user_id, account_id, vault_id, level, bucket_start DESC)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS historical_continuity_rollup_leases (
      lease_key TEXT PRIMARY KEY,
      owner_boot_id TEXT NOT NULL,
      lease_expires_at TIMESTAMPTZ(6) NOT NULL,
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.execute(sql`COMMENT ON TABLE historical_continuity_entries IS 'Immutable model-derived chronology. Raw transcripts remain authoritative; entries are continuity and memory-candidate evidence, never semantic truth.'`);
}

export async function emitCompletedTurnSummary(input: TurnSummaryInput): Promise<void> {
  const principal = requireCurrentUserPrincipal();
  if (!input.vaultId || !input.assistantMessageId || !input.sessionId) throw new Error("Turn summary requires vault, session, and assistant message provenance");
  const exists = await db.execute(sql`SELECT 1 FROM historical_continuity_entries WHERE owner_user_id=${principal.userId} AND account_id=${principal.accountId} AND session_id=${input.sessionId} AND assistant_message_id=${input.assistantMessageId} AND level='turn' LIMIT 1`);
  if (exists.rows.length) return;
  const completedAt = parseDatabaseDate(input.completedAt);
  if (!completedAt) throw new Error("Turn summary requires a valid completedAt timestamp");
  const renderedTools = input.toolCalls.map((tool) => `${tool.toolName}: ${tool.status}${tool.outcome ? ` (${tool.outcome})` : ""}${tool.error ? ` error=${tool.error}` : ""}`).join("\n");
  const source = `USER\n${input.userContent}\n\nTOOLS (completed before this summary)\n${renderedTools || "none"}\n\nASSISTANT\n${input.assistantContent}`.slice(-TURN_MAX_INPUT_CHARS);
  const result = await chatCompletion({
    activity: ACTIVITY_FRAMING,
    messages: [
      { role: "system", content: "Write one dense semantic-delta summary of this completed assistant turn. Capture only what changed: decisions, facts learned, actions completed, durable state changes, failures, commitments, and open loops. Preserve canonical references, IDs, dates, numbers, and uncertainty. Do not treat model inference as verified truth. No preamble; 3-8 short bullets." },
      { role: "user", content: source },
    ],
    maxTokens: TURN_MAX_OUTPUT_TOKENS,
    temperature: 0.1,
    metadata: { source: "historical-continuity.turn", sessionId: input.sessionId, runId: input.runId, turnId: input.turnId },
  });
  const summary = result.content.trim();
  if (!summary) throw new Error("Turn summary model returned empty content");
  const id = deterministicId("turn", principal.userId, principal.accountId, input.sessionId, input.assistantMessageId);
  const end = new Date(completedAt.getTime() + 1);
  await db.execute(sql`
    INSERT INTO historical_continuity_entries (id, owner_user_id, account_id, vault_id, session_id, assistant_message_id, turn_id, run_id, level, timezone, bucket_start, bucket_end, source_start, source_end, source_count, source_entry_ids, summary, summary_sha256)
    VALUES (${id}, ${principal.userId}, ${principal.accountId}, ${input.vaultId}, ${input.sessionId}, ${input.assistantMessageId}, ${input.turnId ?? null}, ${input.runId ?? null}, 'turn', ${principal.timezone || 'America/Chicago'}, ${completedAt}, ${end}, ${completedAt}, ${end}, 1, ARRAY[${id}]::text[], ${summary}, ${sha(summary)})
    ON CONFLICT DO NOTHING
  `);
  log.info("continuity.turn.persisted", { sessionId: input.sessionId, assistantMessageId: input.assistantMessageId, summaryLength: summary.length });
}

export async function runHistoricalContinuityRollups(): Promise<{ created: number }> {
  const bootId = process.env.RAILWAY_DEPLOYMENT_ID || process.env.RAILWAY_GIT_COMMIT_SHA || "local";
  const leaseKey = "historical-continuity:hourly";
  const claimed = await db.execute(sql`
    INSERT INTO historical_continuity_rollup_leases (lease_key, owner_boot_id, lease_expires_at)
    VALUES (${leaseKey}, ${bootId}, NOW() + INTERVAL '15 minutes')
    ON CONFLICT (lease_key) DO UPDATE SET owner_boot_id=EXCLUDED.owner_boot_id, lease_expires_at=EXCLUDED.lease_expires_at, updated_at=NOW()
    WHERE historical_continuity_rollup_leases.lease_expires_at < NOW() OR historical_continuity_rollup_leases.owner_boot_id=${bootId}
    RETURNING lease_key
  `);
  if (!claimed.rows.length) return { created: 0 };
  let created = 0;
  try {
    const owners = await db.execute(sql`SELECT DISTINCT owner_user_id, account_id, vault_id, timezone FROM historical_continuity_entries ORDER BY owner_user_id, account_id, vault_id LIMIT 500`);
    for (const raw of owners.rows as Array<Record<string, unknown>>) {
      const principal: Principal = { actorType: "user", userId: String(raw.owner_user_id), accountId: String(raw.account_id), role: "member", scopes: ["user:read", "user:write"], permissions: [], isAdmin: false, impersonation: { impersonatedByActorType: "system", reason: "historical continuity rollup" }, source: "system", visibleVaultIds: [String(raw.vault_id)], activeVaultId: String(raw.vault_id) };
      created += await runWithPrincipal(principal, () => rollupOwner(String(raw.vault_id), String(raw.timezone)));
    }
    return { created };
  } finally {
    await db.execute(sql`DELETE FROM historical_continuity_rollup_leases WHERE lease_key=${leaseKey} AND owner_boot_id=${bootId}`);
  }
}

async function rollupOwner(vaultId: string, timezone: string): Promise<number> {
  const principal = requireCurrentUserPrincipal();
  let created = 0;
  for (const level of ROLLUP_LEVELS) {
    const sourceLevel = level === "hour" ? "turn" : ROLLUP_LEVELS[ROLLUP_LEVELS.indexOf(level) - 1];
    const candidates = await db.execute(sql`
      WITH bucketed AS (
        SELECT id, bucket_start AS entry_bucket_start, source_start, source_end, summary,
               date_trunc(${level}, bucket_start AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone} AS rollup_bucket_start,
               (date_trunc(${level}, bucket_start AT TIME ZONE ${timezone}) + ('1 ' || ${level})::interval) AT TIME ZONE ${timezone} AS rollup_bucket_end
        FROM historical_continuity_entries
        WHERE owner_user_id=${principal.userId} AND account_id=${principal.accountId} AND vault_id=${vaultId} AND level=${sourceLevel}
      )
      SELECT rollup_bucket_start AS bucket_start, rollup_bucket_end AS bucket_end,
             array_agg(id ORDER BY entry_bucket_start) AS source_ids,
             min(source_start) AS source_start, max(source_end) AS source_end, count(*)::int AS source_count,
             string_agg(summary, E'\n\n' ORDER BY entry_bucket_start) AS source_text
      FROM bucketed
      WHERE rollup_bucket_end <= NOW()
      GROUP BY rollup_bucket_start, rollup_bucket_end
      ORDER BY rollup_bucket_start ASC LIMIT 100
    `);
    for (const row of candidates.rows as Array<Record<string, unknown>>) {
      const bucketStart = new Date(String(row.bucket_start));
      const bucketEnd = new Date(String(row.bucket_end));
      const existing = await db.execute(sql`SELECT 1 FROM historical_continuity_entries WHERE owner_user_id=${principal.userId} AND account_id=${principal.accountId} AND vault_id=${vaultId} AND level=${level} AND timezone=${timezone} AND bucket_start=${bucketStart} LIMIT 1`);
      if (existing.rows.length) continue;
      const sourceIds = normalizeSourceEntryIds(row.source_ids);
      if (!sourceIds.length) {
        log.warn("continuity.rollup.source_ids_skipped", {
          level,
          vaultId,
          bucketStart: bucketStart.toISOString(),
          sourceCount: Number(row.source_count) || null,
        });
        continue;
      }
      const result = await chatCompletion({ activity: ACTIVITY_FRAMING, messages: [{ role: "system", content: `Compress these ${sourceLevel} continuity entries into one ${level} chronology summary. Preserve decisions, durable changes, failures, commitments, uncertainty, exact references, dates, IDs, and numbers. Remove repetition. This is model-derived evidence, not truth. Dense markdown bullets; no preamble.` }, { role: "user", content: String(row.source_text).slice(0, 120_000) }], maxTokens: ROLLUP_MAX_OUTPUT_TOKENS, temperature: 0.1, metadata: { source: `historical-continuity.rollup.${level}` } });
      const summary = result.content.trim();
      if (!summary) continue;
      const id = deterministicId(level, principal.userId, principal.accountId, vaultId, timezone, bucketStart.toISOString());
      await db.execute(sql`INSERT INTO historical_continuity_entries (id, owner_user_id, account_id, vault_id, level, timezone, bucket_start, bucket_end, source_start, source_end, source_count, source_entry_ids, summary, summary_sha256) VALUES (${id}, ${principal.userId}, ${principal.accountId}, ${vaultId}, ${level}, ${timezone}, ${bucketStart}, ${bucketEnd}, ${new Date(String(row.source_start))}, ${new Date(String(row.source_end))}, ${Number(row.source_count)}, ${textArray(sourceIds)}, ${summary}, ${sha(summary)}) ON CONFLICT DO NOTHING`);
      created++;
    }
  }
  return created;
}

export async function renderHistoryProjection(tokenBudget = HISTORY_TOKEN_BUDGET): Promise<string> {
  const principal = requireCurrentUserPrincipal();
  const vaultIds = principal.visibleVaultIds?.length ? principal.visibleVaultIds : principal.activeVaultId ? [principal.activeVaultId] : [];
  if (!vaultIds.length) return "";
  const result = await db.execute(sql`
    WITH ranked AS (
      SELECT *, row_number() OVER (PARTITION BY level ORDER BY bucket_start DESC) AS rn
      FROM historical_continuity_entries
      WHERE owner_user_id=${principal.userId} AND account_id=${principal.accountId} AND vault_id = ANY(${textArray(vaultIds)})
    )
    SELECT id, level, bucket_start, bucket_end, summary, source_start, source_end, source_count, session_id, assistant_message_id
    FROM ranked WHERE (level='turn' AND rn<=24) OR (level='hour' AND rn<=48) OR (level='day' AND rn<=31) OR (level='week' AND rn<=16) OR (level='month' AND rn<=18) OR (level='quarter' AND rn<=12) OR (level='year' AND rn<=10)
    ORDER BY CASE level WHEN 'year' THEN 1 WHEN 'quarter' THEN 2 WHEN 'month' THEN 3 WHEN 'week' THEN 4 WHEN 'day' THEN 5 WHEN 'hour' THEN 6 ELSE 7 END, bucket_start ASC
  `);
  const rows = (result.rows as Array<Record<string, unknown>>)
    .map(normalizeContinuityRow)
    .filter((row): row is ContinuityRow => row !== null);
  const header = "# HISTORY.md\n\nModel-derived chronology for continuity. Raw transcripts remain authoritative; memory candidates require independent provenance and validation.\n";
  const sections: string[] = [];
  let used = estimateTokens(header);
  for (const level of ["year", "quarter", "month", "week", "day", "hour", "turn"] as const) {
    const entries = rows.filter((row) => row.level === level);
    if (!entries.length) continue;
    const lines: string[] = [`\n## ${level[0].toUpperCase()}${level.slice(1)}`];
    for (const entry of entries) {
      const line = `- ${entry.bucketStart.toISOString()} — ${entry.summary}`;
      const cost = estimateTokens(line);
      if (used + cost > tokenBudget) break;
      lines.push(line);
      used += cost;
    }
    if (lines.length > 1) sections.push(lines.join("\n"));
  }
  return header + sections.join("\n");
}

export async function getCompletedTurnSummaryMap(sessionId: string, assistantMessageIds: string[]): Promise<Map<string, string>> {
  const principal = requireCurrentUserPrincipal();
  if (!assistantMessageIds.length) return new Map();
  const result = await db.execute(sql`
    SELECT assistant_message_id, summary
    FROM historical_continuity_entries
    WHERE owner_user_id=${principal.userId}
      AND account_id=${principal.accountId}
      AND vault_id = ANY(${textArray(principal.visibleVaultIds ?? [])})
      AND session_id=${sessionId}
      AND level='turn'
      AND assistant_message_id = ANY(${textArray(assistantMessageIds)})
  `);
  return new Map(
    (result.rows as Array<Record<string, unknown>>)
      .filter((row) => typeof row.assistant_message_id === "string" && typeof row.summary === "string")
      .map((row) => [String(row.assistant_message_id), String(row.summary)]),
  );
}

export async function getTurnSummariesForCompaction(sessionId: string, assistantMessageIds: string[]): Promise<string | null> {
  const principal = requireCurrentUserPrincipal();
  if (!assistantMessageIds.length) return null;
  const result = await db.execute(sql`SELECT assistant_message_id, bucket_start, summary FROM historical_continuity_entries WHERE owner_user_id=${principal.userId} AND account_id=${principal.accountId} AND session_id=${sessionId} AND level='turn' AND assistant_message_id = ANY(${textArray(assistantMessageIds)}) ORDER BY bucket_start`);
  if (result.rows.length !== assistantMessageIds.length) return null;
  return (result.rows as Array<Record<string, unknown>>).map((row) => `[${new Date(String(row.bucket_start)).toISOString()}] ${String(row.summary)}`).join("\n\n");
}

function normalizeSourceEntryIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "id" in entry && typeof (entry as { id: unknown }).id === "string") {
          return (entry as { id: string }).id;
        }
        return null;
      })
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return trimmed
        .slice(1, -1)
        .split(",")
        .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);
    }
    return [trimmed];
  }
  return [];
}

function textArray(values: string[]): SQL {
  if (!values.length) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

function deterministicId(...parts: string[]): string { return `hc_${createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32)}`; }
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
