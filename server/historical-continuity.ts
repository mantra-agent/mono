import { createHash } from "crypto";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { vaults } from "@shared/models/vaults";
import { db } from "./db";
import { chatCompletion } from "./model-client";
import { ACTIVITY_FRAMING } from "./job-profiles";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";
import { estimateTokens } from "./context-builder";
import { getTimezone } from "./timezone";

const log = createLogger("HistoricalContinuity");
const TURN_MAX_INPUT_CHARS = 48_000;
const TURN_MAX_OUTPUT_TOKENS = 320;
const HISTORY_TOKEN_BUDGET = 9_600;
const DEFAULT_HISTORY_TIMEZONE = "America/Chicago";
const ROLLUP_LEVELS = ["hour", "day", "week", "month", "quarter", "year"] as const;
const HISTORY_PROJECTION_LEVELS = ["turn", "hour", "day", "week", "month", "quarter", "year"] as const;
type RollupLevel = (typeof ROLLUP_LEVELS)[number];
type ContinuityLevel = "turn" | RollupLevel;

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

interface VisibleVault {
  id: string;
  name: string;
}

interface ContinuityRow {
  id: string;
  vaultId: string;
  level: ContinuityLevel;
  timezone: string;
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

function resolveHistoryTimezone(value?: string | null): string {
  const candidate = (value || getTimezone() || DEFAULT_HISTORY_TIMEZONE).trim();
  try {
    Intl.DateTimeFormat(undefined, { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_HISTORY_TIMEZONE;
  }
}

function historyDateParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(date);
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

function historyZoneLabel(date: Date, timeZone: string): string {
  try {
    const generic = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value;
    if (generic && !/^GMT/i.test(generic) && !/^UTC/i.test(generic)) return generic;
  } catch {
    /* fall through */
  }
  const short = historyDateParts(date, timeZone).timeZoneName;
  return short || timeZone;
}

function historyCivilDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function historyDayHeading(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function historyClockLabel(date: Date, timeZone: string): string {
  const parts = historyDateParts(date, timeZone);
  const hour = parts.hour || "12";
  const minute = parts.minute || "00";
  const dayPeriod = (parts.dayPeriod || "").toUpperCase();
  const zone = historyZoneLabel(date, timeZone);
  return `${hour}:${minute} ${dayPeriod} ${zone}`.replace(/\s+/g, " ").trim();
}

function historyCompactDayLabel(date: Date, timeZone: string): string {
  const parts = historyDateParts(date, timeZone);
  return `${parts.weekday || ""} ${parts.month || ""} ${parts.day || ""}, ${parts.year || ""}`.replace(/\s+/g, " ").trim();
}

function formatHistoryAnchor(level: ContinuityLevel, start: Date, timeZone: string): string {
  const tz = resolveHistoryTimezone(timeZone);
  const parts = historyDateParts(start, tz);
  switch (level) {
    case "year":
      return parts.year || String(start.getUTCFullYear());
    case "quarter": {
      const month = Number(
        new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric" }).format(start),
      );
      const quarter = Number.isFinite(month) ? Math.floor((month - 1) / 3) + 1 : 1;
      return `${parts.year || start.getUTCFullYear()} Q${quarter}`;
    }
    case "month":
      return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", year: "numeric" }).format(start);
    case "week":
      return `Week of ${historyCompactDayLabel(start, tz)}`;
    case "day":
      return historyDayHeading(start, tz);
    case "hour":
      return `${historyCompactDayLabel(start, tz)} · ${historyClockLabel(start, tz)}`;
    case "turn":
      return `${historyCompactDayLabel(start, tz)} · ${historyClockLabel(start, tz)}`;
    default:
      return start.toISOString();
  }
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
  if (typeof raw.vault_id !== "string" || !raw.vault_id) return null;
  return {
    id: String(raw.id),
    vaultId: raw.vault_id,
    level: level as ContinuityRow["level"],
    timezone: resolveHistoryTimezone(typeof raw.timezone === "string" ? raw.timezone : null),
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
    // Completed-turn summaries are fixed framing work. Pin them to the cheap
    // framing tier so a session's max/high modelTier selection cannot inflate
    // this high-frequency per-turn call. sessionId stays in metadata for audit.
    semanticTierOverride: "fast",
    overrideReason: "Completed-turn summary is fixed framing work; pin to fast tier regardless of session modelTier",
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

export interface HistoryRollupCandidate {
  vaultId: string;
  vaultName: string;
  level: RollupLevel;
  sourceLevel: ContinuityLevel;
  timezone: string;
  bucketStart: string;
  bucketEnd: string;
  sourceStart: string;
  sourceEnd: string;
  sourceCount: number;
  sourceEntryIds: string[];
  sourceText: string;
}

export interface SaveHistoryRollupInput {
  vaultId: string;
  level: string;
  timezone: string;
  bucketStart: string;
  sourceEntryIds: string[];
  summary: string;
}

export async function listHistoryRollupCandidates(): Promise<{
  candidate: HistoryRollupCandidate | null;
  visibleVaultCount: number;
}> {
  const visibleVaults = await resolveVisibleVaults();
  for (const level of ROLLUP_LEVELS) {
    for (const vault of visibleVaults) {
      const timezones = await listHistoryTimezones(vault.id);
      for (const timezone of timezones) {
        const candidate = await loadHistoryRollupCandidate(vault, level, timezone);
        if (candidate) return { candidate, visibleVaultCount: visibleVaults.length };
      }
    }
  }
  return { candidate: null, visibleVaultCount: visibleVaults.length };
}

export async function saveHistoryRollup(input: SaveHistoryRollupInput): Promise<{
  outcome: "created" | "already_exists";
  entryId: string;
}> {
  const principal = requireCurrentUserPrincipal();
  if (!ROLLUP_LEVELS.includes(input.level as RollupLevel)) throw new Error("Invalid history rollup level");
  const level = input.level as RollupLevel;
  const timezone = resolveHistoryTimezone(input.timezone);
  if (timezone !== input.timezone) throw new Error("Invalid history rollup timezone");
  const summary = input.summary.trim();
  if (!summary || summary.length > 12_000) throw new Error("History rollup summary must contain 1-12000 characters");
  const bucketStart = parseDatabaseDate(input.bucketStart);
  if (!bucketStart) throw new Error("Invalid history rollup bucketStart");
  const vault = (await resolveVisibleVaults()).find((entry) => entry.id === input.vaultId);
  if (!vault) throw new Error("History rollup Vault is not visible");

  const existing = await db.execute(sql`
    SELECT id FROM historical_continuity_entries
    WHERE owner_user_id=${principal.userId} AND account_id=${principal.accountId}
      AND vault_id=${vault.id} AND level=${level} AND timezone=${timezone} AND bucket_start=${bucketStart}
    LIMIT 1
  `);
  const entryId = deterministicId(level, principal.userId, principal.accountId, vault.id, timezone, bucketStart.toISOString());
  if (existing.rows.length) return { outcome: "already_exists", entryId: String(existing.rows[0].id) };

  const candidate = await loadHistoryRollupCandidate(vault, level, timezone, bucketStart);
  if (!candidate) throw new Error("History rollup candidate is no longer current");
  if (!sameStringSet(candidate.sourceEntryIds, input.sourceEntryIds)) {
    throw new Error("History rollup source entries changed; list candidates again");
  }

  const inserted = await db.execute(sql`
    INSERT INTO historical_continuity_entries
      (id, owner_user_id, account_id, vault_id, level, timezone, bucket_start, bucket_end,
       source_start, source_end, source_count, source_entry_ids, summary, summary_sha256)
    VALUES
      (${entryId}, ${principal.userId}, ${principal.accountId}, ${vault.id}, ${level}, ${timezone},
       ${new Date(candidate.bucketStart)}, ${new Date(candidate.bucketEnd)}, ${new Date(candidate.sourceStart)},
       ${new Date(candidate.sourceEnd)}, ${candidate.sourceCount}, ${textArray(candidate.sourceEntryIds)},
       ${summary}, ${sha(summary)})
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const outcome = inserted.rows.length ? "created" : "already_exists";
  log.info("continuity.rollup.persisted", {
    entryId,
    vaultId: vault.id,
    level,
    sourceCount: candidate.sourceCount,
    outcome,
  });
  return { outcome, entryId };
}

async function listHistoryTimezones(vaultId: string): Promise<string[]> {
  const principal = requireCurrentUserPrincipal();
  const result = await db.execute(sql`
    SELECT DISTINCT timezone FROM historical_continuity_entries
    WHERE owner_user_id=${principal.userId} AND account_id=${principal.accountId} AND vault_id=${vaultId}
    ORDER BY timezone
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => resolveHistoryTimezone(String(row.timezone)));
}

async function loadHistoryRollupCandidate(
  vault: VisibleVault,
  level: RollupLevel,
  timezone: string,
  exactBucketStart?: Date,
): Promise<HistoryRollupCandidate | null> {
  const principal = requireCurrentUserPrincipal();
  const sourceLevel: ContinuityLevel = level === "hour" ? "turn" : ROLLUP_LEVELS[ROLLUP_LEVELS.indexOf(level) - 1];
  const candidates = await db.execute(sql`
    WITH bucketed AS (
      SELECT id, bucket_start AS entry_bucket_start, source_start, source_end, summary,
             date_trunc(${level}, bucket_start AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone} AS rollup_bucket_start,
             (date_trunc(${level}, bucket_start AT TIME ZONE ${timezone}) + ('1 ' || ${level})::interval) AT TIME ZONE ${timezone} AS rollup_bucket_end
      FROM historical_continuity_entries
      WHERE owner_user_id=${principal.userId} AND account_id=${principal.accountId}
        AND vault_id=${vault.id} AND level=${sourceLevel}
    )
    SELECT rollup_bucket_start AS bucket_start, rollup_bucket_end AS bucket_end,
           array_agg(id ORDER BY entry_bucket_start) AS source_ids,
           min(source_start) AS source_start, max(source_end) AS source_end,
           count(*)::int AS source_count,
           string_agg(summary, E'\n\n' ORDER BY entry_bucket_start) AS source_text
    FROM bucketed
    WHERE rollup_bucket_end <= NOW()
      AND (${exactBucketStart ?? null}::timestamptz IS NULL OR rollup_bucket_start=${exactBucketStart ?? null})
      AND NOT EXISTS (
        SELECT 1 FROM historical_continuity_entries existing
        WHERE existing.owner_user_id=${principal.userId} AND existing.account_id=${principal.accountId}
          AND existing.vault_id=${vault.id} AND existing.level=${level}
          AND existing.timezone=${timezone} AND existing.bucket_start=rollup_bucket_start
      )
    GROUP BY rollup_bucket_start, rollup_bucket_end
    ORDER BY rollup_bucket_start ASC
    LIMIT 1
  `);
  const row = candidates.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const sourceEntryIds = normalizeSourceEntryIds(row.source_ids);
  const bucketStart = parseDatabaseDate(row.bucket_start);
  const bucketEnd = parseDatabaseDate(row.bucket_end);
  const sourceStart = parseDatabaseDate(row.source_start);
  const sourceEnd = parseDatabaseDate(row.source_end);
  if (!sourceEntryIds.length || !bucketStart || !bucketEnd || !sourceStart || !sourceEnd) return null;
  return {
    vaultId: vault.id,
    vaultName: vault.name,
    level,
    sourceLevel,
    timezone,
    bucketStart: bucketStart.toISOString(),
    bucketEnd: bucketEnd.toISOString(),
    sourceStart: sourceStart.toISOString(),
    sourceEnd: sourceEnd.toISOString(),
    sourceCount: Number(row.source_count),
    sourceEntryIds,
    sourceText: String(row.source_text),
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...left].sort();
  const actual = [...right].sort();
  return expected.every((value, index) => value === actual[index]);
}

async function resolveVisibleVaults(): Promise<VisibleVault[]> {
  const principal = requireCurrentUserPrincipal();
  const visibleIds = Array.from(new Set(principal.visibleVaultIds ?? [])).filter(Boolean);
  if (!visibleIds.length) return [];
  return db
    .select({ id: vaults.id, name: vaults.name })
    .from(vaults)
    .where(and(
      eq(vaults.accountId, principal.accountId),
      eq(vaults.isArchived, false),
      inArray(vaults.id, visibleIds),
    ))
    .orderBy(vaults.position, vaults.createdAt);
}

function appendHistoryLine(
  lines: string[],
  line: string,
  budget: { used: number; tokenBudget: number },
): boolean {
  const cost = estimateTokens(line);
  if (budget.used + cost > budget.tokenBudget) return false;
  lines.push(line);
  budget.used += cost;
  return true;
}

function renderHistoryLevelSection(
  level: ContinuityLevel,
  entries: ContinuityRow[],
  budget: { used: number; tokenBudget: number },
): string | null {
  if (!entries.length) return null;
  const lines: string[] = [`\n## ${level[0].toUpperCase()}${level.slice(1)}`];
  const groupByDay = level === "hour" || level === "turn";

  if (!groupByDay) {
    for (const entry of entries) {
      const anchor = formatHistoryAnchor(level, entry.bucketStart, entry.timezone);
      if (!appendHistoryLine(lines, `- ${anchor} — ${entry.summary}`, budget)) break;
    }
  } else {
    let currentDayKey = "";
    for (const entry of entries) {
      const dayKey = historyCivilDateKey(entry.bucketStart, entry.timezone);
      if (dayKey !== currentDayKey) {
        currentDayKey = dayKey;
        const dayHeading = historyDayHeading(entry.bucketStart, entry.timezone);
        if (!appendHistoryLine(lines, `\n### ${dayHeading}`, budget)) break;
      }
      const clock = historyClockLabel(entry.bucketStart, entry.timezone);
      if (!appendHistoryLine(lines, `- ${clock} — ${entry.summary}`, budget)) break;
    }
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

export async function renderHistoryProjection(tokenBudget = HISTORY_TOKEN_BUDGET): Promise<string> {
  const principal = requireCurrentUserPrincipal();
  const visibleVaults = await resolveVisibleVaults();
  if (!visibleVaults.length) return "";
  const vaultIds = visibleVaults.map((vault) => vault.id);
  const result = await db.execute(sql`
    WITH ranked AS (
      SELECT *, row_number() OVER (PARTITION BY vault_id, level ORDER BY bucket_start DESC) AS rn
      FROM historical_continuity_entries
      WHERE owner_user_id=${principal.userId} AND account_id=${principal.accountId} AND vault_id = ANY(${textArray(vaultIds)})
    )
    SELECT id, vault_id, level, timezone, bucket_start, bucket_end, summary, source_start, source_end, source_count, session_id, assistant_message_id
    FROM ranked WHERE (level='turn' AND rn<=24) OR (level='hour' AND rn<=48) OR (level='day' AND rn<=31) OR (level='week' AND rn<=16) OR (level='month' AND rn<=18) OR (level='quarter' AND rn<=12) OR (level='year' AND rn<=10)
    ORDER BY vault_id, CASE level WHEN 'turn' THEN 1 WHEN 'hour' THEN 2 WHEN 'day' THEN 3 WHEN 'week' THEN 4 WHEN 'month' THEN 5 WHEN 'quarter' THEN 6 ELSE 7 END, bucket_start DESC
  `);
  const rows = (result.rows as Array<Record<string, unknown>>)
    .map(normalizeContinuityRow)
    .filter((row): row is ContinuityRow => row !== null);
  const vaultsWithRows = visibleVaults.filter((vault) => rows.some((row) => row.vaultId === vault.id));
  if (!vaultsWithRows.length) return "";

  const perVaultBudget = Math.max(1, Math.floor(tokenBudget / vaultsWithRows.length));
  const documents: string[] = [];
  for (const vault of vaultsWithRows) {
    const vaultRows = rows.filter((row) => row.vaultId === vault.id);
    const projectionTimezone = resolveHistoryTimezone(vaultRows[0]?.timezone || getTimezone());
    const header = `# HISTORY.md — ${vault.name}\n\nVault: ${vault.name}\nModel-derived chronology for continuity. Times are local to ${projectionTimezone}. Raw transcripts remain authoritative; memory candidates require independent provenance and validation.\n`;
    const budget = { used: estimateTokens(header), tokenBudget: perVaultBudget };
    const sections: string[] = [];
    for (const level of HISTORY_PROJECTION_LEVELS) {
      const section = renderHistoryLevelSection(
        level,
        vaultRows.filter((row) => row.level === level),
        budget,
      );
      if (section) sections.push(section);
    }
    if (sections.length) documents.push(header + sections.join("\n"));
  }
  return documents.join("\n\n---\n\n");
}

/** Destroy every History row owned by this holder in one vault. */
export async function deleteHistoricalContinuityForVault(vaultId: string): Promise<number> {
  const principal = requireCurrentUserPrincipal();
  const result = await db.execute(sql`
    DELETE FROM historical_continuity_entries
    WHERE owner_user_id=${principal.userId}
      AND account_id=${principal.accountId}
      AND vault_id=${vaultId}
  `);
  return Number(result.rowCount ?? 0);
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
  const result = await db.execute(sql`
    SELECT assistant_message_id, timezone, bucket_start, summary
    FROM historical_continuity_entries
    WHERE owner_user_id=${principal.userId}
      AND account_id=${principal.accountId}
      AND session_id=${sessionId}
      AND level='turn'
      AND assistant_message_id = ANY(${textArray(assistantMessageIds)})
    ORDER BY bucket_start
  `);
  if (result.rows.length !== assistantMessageIds.length) return null;
  return (result.rows as Array<Record<string, unknown>>)
    .map((row) => {
      const bucketStart = parseDatabaseDate(row.bucket_start) ?? new Date();
      const timezone = resolveHistoryTimezone(typeof row.timezone === "string" ? row.timezone : null);
      return `[${formatHistoryAnchor("turn", bucketStart, timezone)}] ${String(row.summary)}`;
    })
    .join("\n\n");
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
