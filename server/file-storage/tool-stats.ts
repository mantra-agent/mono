// Use createLogger for logging ONLY
import { getSetting, setSetting } from "../system-settings";
import { createLogger } from "../log";

const log = createLogger("ToolStats");

const DB_KEY = "tool_stats";

interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  totalDuration: number;
  durationCount: number;
}

interface ToolStatsStore {
  tools: Record<string, ToolStat>;
  pendingCalls: Record<string, { toolName: string; startTime: number }>;
}

let store: ToolStatsStore | null = null;
let dbInitialized = false;

async function initFromDb(): Promise<void> {
  if (dbInitialized) return;
  try {
    const fromDb = await getSetting<{ tools: Record<string, ToolStat> }>(DB_KEY);
    if (fromDb && fromDb.tools) {
      store = { tools: fromDb.tools, pendingCalls: store?.pendingCalls || {} };
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
        store = { tools: raw.tools || {}, pendingCalls: store?.pendingCalls || {} };
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

export function recordToolCallEnd(toolCallId: string, isError?: boolean) {
  const s = load();
  const pending = s.pendingCalls[toolCallId];
  if (!pending) return;

  const duration = Date.now() - pending.startTime;
  const name = pending.toolName;
  delete s.pendingCalls[toolCallId];

  if (!s.tools[name]) {
    s.tools[name] = { name, calls: 0, errors: 0, totalDuration: 0, durationCount: 0 };
  }
  const stat = s.tools[name];
  stat.calls++;
  if (isError) stat.errors++;
  stat.totalDuration += duration;
  stat.durationCount++;

  save().catch(err => log.warn("background save failed", err));
}

export function getToolStats(): Array<{ name: string; calls: number; avgDuration: number | null; errors: number }> {
  const s = load();
  return Object.values(s.tools)
    .map(t => ({
      name: t.name,
      calls: t.calls,
      avgDuration: t.durationCount > 0 ? Math.round(t.totalDuration / t.durationCount) : null,
      errors: t.errors,
    }))
    .sort((a, b) => b.calls - a.calls);
}
