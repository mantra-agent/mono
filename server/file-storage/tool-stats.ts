// Use createLogger for logging ONLY
import { getSetting, setSetting } from "../system-settings";
import { createLogger } from "../log";
import { isClassifiedToolFailureKind } from "@shared/tool-failure";

const log = createLogger("ToolStats");

const DB_KEY = "tool_stats";

interface ToolStat {
  name: string;
  calls: number;
  /** Total failed completions (amber + unclassified). */
  errors: number;
  /** Known/avoidable classified failures (input|permission|transient|internal). */
  amberFailures: number;
  /** Failures missing failureKind or with an unknown kind. */
  unclassifiedErrors: number;
  totalDuration: number;
  durationCount: number;
}

interface ToolStatsStore {
  tools: Record<string, ToolStat>;
  pendingCalls: Record<string, { toolName: string; startTime: number }>;
}

let store: ToolStatsStore | null = null;
let dbInitialized = false;

function emptyStat(name: string): ToolStat {
  return {
    name,
    calls: 0,
    errors: 0,
    amberFailures: 0,
    unclassifiedErrors: 0,
    totalDuration: 0,
    durationCount: 0,
  };
}

function normalizeStat(name: string, raw: Partial<ToolStat> | undefined): ToolStat {
  const base = emptyStat(name);
  if (!raw || typeof raw !== "object") return base;
  const errors = Number(raw.errors ?? 0) || 0;
  const amberFailures = Number(raw.amberFailures ?? 0) || 0;
  // Legacy rows only have `errors`. Until classified counts exist, treat the
  // whole error total as unclassified so the UI still shows the red bucket.
  const unclassifiedErrors =
    raw.unclassifiedErrors != null || raw.amberFailures != null
      ? Number(raw.unclassifiedErrors ?? 0) || 0
      : Math.max(0, errors - amberFailures);
  return {
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : name,
    calls: Number(raw.calls ?? 0) || 0,
    errors,
    amberFailures,
    unclassifiedErrors,
    totalDuration: Number(raw.totalDuration ?? 0) || 0,
    durationCount: Number(raw.durationCount ?? 0) || 0,
  };
}

async function initFromDb(): Promise<void> {
  if (dbInitialized) return;
  try {
    const fromDb = await getSetting<{ tools: Record<string, Partial<ToolStat>> }>(DB_KEY);
    if (fromDb && fromDb.tools) {
      const tools: Record<string, ToolStat> = {};
      for (const [name, value] of Object.entries(fromDb.tools)) {
        tools[name] = normalizeStat(name, value);
      }
      store = { tools, pendingCalls: store?.pendingCalls || {} };
      dbInitialized = true;
      return;
    }

    try {
      const { access, readFile } = await import("fs/promises");
      const { join } = await import("path");
      const filePath = join(".openclaw", "workspace", "perf", "tool_stats.json");
      try {
        await access(filePath);
        const raw = JSON.parse(await readFile(filePath, "utf-8"));
        const tools: Record<string, ToolStat> = {};
        for (const [name, value] of Object.entries(raw.tools || {})) {
          tools[name] = normalizeStat(name, value as Partial<ToolStat>);
        }
        store = { tools, pendingCalls: store?.pendingCalls || {} };
        await setSetting(DB_KEY, { tools: store.tools });
        log.log("Migrated tool_stats.json to DB");
        dbInitialized = true;
        return;
      } catch { /* file doesn't exist, skip migration */ }
    } catch (err) { log.warn("legacy migration parse error", err); }

    if (!store) store = { tools: {}, pendingCalls: {} };
    dbInitialized = true;
  } catch (err: any) {
    log.error("DB init failed:", err.message, err.stack);
    if (!store) store = { tools: {}, pendingCalls: {} };
    dbInitialized = false;
  }
}

function load(): ToolStatsStore {
  if (store) return store;
  store = { tools: {}, pendingCalls: {} };
  initFromDb().catch(err => log.warn("init from DB failed", err));
  return store;
}

async function save(): Promise<void> {
  const s = load();
  await setSetting(DB_KEY, { tools: s.tools });
}

export function recordToolCallStart(toolCallId: string, toolName: string) {
  const s = load();
  s.pendingCalls[toolCallId] = { toolName, startTime: Date.now() };
}

export function recordToolCallEnd(
  toolCallId: string,
  isError?: boolean,
  failureKind?: string | null,
) {
  const s = load();
  const pending = s.pendingCalls[toolCallId];
  if (!pending) return;

  const duration = Date.now() - pending.startTime;
  const name = pending.toolName;
  delete s.pendingCalls[toolCallId];

  if (!s.tools[name]) {
    s.tools[name] = emptyStat(name);
  } else {
    s.tools[name] = normalizeStat(name, s.tools[name]);
  }
  const stat = s.tools[name];
  stat.calls++;
  if (isError) {
    stat.errors++;
    if (isClassifiedToolFailureKind(failureKind)) {
      stat.amberFailures++;
    } else {
      stat.unclassifiedErrors++;
    }
  }
  stat.totalDuration += duration;
  stat.durationCount++;

  save().catch(err => log.warn("background save failed", err));
}

export function getToolStats(): Array<{
  name: string;
  calls: number;
  avgDuration: number | null;
  errors: number;
  amberFailures: number;
  unclassifiedErrors: number;
}> {
  const s = load();
  return Object.values(s.tools)
    .map((raw) => {
      const t = normalizeStat(raw.name, raw);
      return {
        name: t.name,
        calls: t.calls,
        avgDuration: t.durationCount > 0 ? Math.round(t.totalDuration / t.durationCount) : null,
        errors: t.errors,
        amberFailures: t.amberFailures,
        unclassifiedErrors: t.unclassifiedErrors,
      };
    })
    .sort((a, b) => b.calls - a.calls);
}
