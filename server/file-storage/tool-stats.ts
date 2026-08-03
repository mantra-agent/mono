// Use createLogger for logging ONLY
import { getSetting, setSetting } from "../system-settings";
import { createLogger } from "../log";
import { isClassifiedToolFailureKind } from "@shared/tool-failure";

const log = createLogger("ToolStats");

const DB_KEY = "tool_stats";

interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  /** Classified/avoidable failures (input|permission|transient|internal). */
  amberFailures: number;
  /** True surprises missing failureKind. */
  unclassifiedErrors: number;
  totalDuration: number;
  durationCount: number;
}

interface ToolStatsStore {
  tools: Record<string, ToolStat>;
  pendingCalls: Record<string, { toolName: string; startTime: number }>;
}

export interface ToolStatSummary {
  name: string;
  calls: number;
  avgDuration: number | null;
  errors: number;
  amberFailures: number;
  unclassifiedErrors: number;
}

let store: ToolStatsStore | null = null;
let dbInitialized = false;

function normalizeToolStat(raw: Partial<ToolStat> & { name: string }): ToolStat {
  const errors = typeof raw.errors === "number" ? raw.errors : 0;
  const amberFailures = typeof raw.amberFailures === "number" ? raw.amberFailures : 0;
  // Legacy rows only tracked `errors` — treat historical errors as unclassified until
  // new classified recordings rebalance the split.
  const unclassifiedErrors =
    typeof raw.unclassifiedErrors === "number"
      ? raw.unclassifiedErrors
      : Math.max(0, errors - amberFailures);
  return {
    name: raw.name,
    calls: typeof raw.calls === "number" ? raw.calls : 0,
    errors,
    amberFailures,
    unclassifiedErrors,
    totalDuration: typeof raw.totalDuration === "number" ? raw.totalDuration : 0,
    durationCount: typeof raw.durationCount === "number" ? raw.durationCount : 0,
  };
}

async function initFromDb(): Promise<void> {
  if (dbInitialized) return;
  try {
    const fromDb = await getSetting<{ tools: Record<string, Partial<ToolStat> & { name?: string }> }>(DB_KEY);
    if (fromDb && fromDb.tools) {
      const tools: Record<string, ToolStat> = {};
      for (const [name, raw] of Object.entries(fromDb.tools)) {
        tools[name] = normalizeToolStat({ ...raw, name: raw.name || name });
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
          tools[name] = normalizeToolStat({
            ...(value as Partial<ToolStat>),
            name: (value as Partial<ToolStat>).name || name,
          });
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

/**
 * Close a pending tool call.
 * @param failureKind classified kind when known — drives amber vs red split.
 */
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
    s.tools[name] = {
      name,
      calls: 0,
      errors: 0,
      amberFailures: 0,
      unclassifiedErrors: 0,
      totalDuration: 0,
      durationCount: 0,
    };
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

export function getToolStats(): ToolStatSummary[] {
  const s = load();
  return Object.values(s.tools)
    .map((t) => {
      const normalized = normalizeToolStat(t);
      return {
        name: normalized.name,
        calls: normalized.calls,
        avgDuration:
          normalized.durationCount > 0
            ? Math.round(normalized.totalDuration / normalized.durationCount)
            : null,
        errors: normalized.errors,
        amberFailures: normalized.amberFailures,
        unclassifiedErrors: normalized.unclassifiedErrors,
      };
    })
    .sort((a, b) => b.calls - a.calls);
}
