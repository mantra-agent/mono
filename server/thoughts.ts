import { db } from "./db";
import { pool } from "./db";
import { thoughts } from "@shared/schema";
import { eq, desc, gte, count, sql, and } from "drizzle-orm";
import { formatInTimezone, getTimezone } from "./timezone";
import { createLogger } from "./log";
import { getInstanceNameLower } from "@shared/instance-config";
import { TTLCache } from "./utils/ttl-cache";
import { eventBus } from "./event-bus";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import type { Thought } from "@shared/schema";

const ACTIVE_MAX_AGE_MS = 25 * 60 * 1000;
const log = createLogger("Thought");

const thoughtsCache = new TTLCache<Thought[]>("Thoughts", Infinity);

const thoughtScopeColumns = {
  scope: thoughts.scope,
  ownerUserId: thoughts.ownerUserId,
  accountId: thoughts.accountId,
};

function principalCacheKey(): string {
  const principal = getCurrentPrincipalOrSystem();
  return `${principal.actorType}:${principal.accountId || "no-account"}:${principal.userId || "no-user"}`;
}

export type { Thought };

let tableEnsured = false;

async function ensureThoughtsTable(): Promise<void> {
  if (tableEnsured) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS thoughts (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        occurred_at TIMESTAMP NOT NULL DEFAULT NOW(),
        context TEXT,
        type TEXT,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT
      )
    `);
    await pool.query(`ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user'`);
    await pool.query(`ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
    await pool.query(`ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS account_id TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_thoughts_scope_owner ON thoughts(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_thoughts_account ON thoughts(account_id)`);
    tableEnsured = true;
  } catch (err: unknown) {
    log.error(`ensureThoughtsTable failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function saveThought(text: string, context?: string, type?: string): Promise<Thought> {
  await ensureThoughtsTable();

  const id = `thought-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  try {
    const [row] = await db.insert(thoughts).values({
      id,
      text,
      context: context || null,
      type: type || null,
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), thoughtScopeColumns),
    }).returning();

    thoughtsCache.invalidateAll();
    activeCountCache.invalidateAll();
    eventBus.publish({ category: "system", event: "data:thoughts_changed", payload: { source: "thoughts", action: "save", thoughtId: row.id } });
    log.log(`Thought saved id=${row.id} type=${type || "reflect"}`);
    return row;
  } catch (err: unknown) {
    log.error(`saveThought FAILED id=${id}: ${err instanceof Error ? err.message : String(err)}`);

    const fallback: Thought = {
      id,
      text,
      occurredAt: new Date(),
      context: context || null,
      type: type || null,
    };

    return fallback;
  }
}

export async function getAllThoughts(): Promise<Thought[]> {
  await ensureThoughtsTable();
  return thoughtsCache.getOrFetch(`all:${principalCacheKey()}`, async () => {
    return db.select().from(thoughts)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), thoughtScopeColumns))
      .orderBy(desc(thoughts.occurredAt));
  });
}

export async function getRecentThoughts(maxAgeMs: number = ACTIVE_MAX_AGE_MS, limit: number = 5): Promise<Thought[]> {
  await ensureThoughtsTable();
  return thoughtsCache.getOrFetch(`recent:${principalCacheKey()}:${maxAgeMs}:${limit}`, async () => {
    const cutoff = new Date(Date.now() - maxAgeMs);
    return db.select().from(thoughts)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), thoughtScopeColumns, gte(thoughts.occurredAt, cutoff)))
      .orderBy(desc(thoughts.occurredAt))
      .limit(limit);
  });
}

const activeCountCache = new TTLCache<number>("ThoughtActiveCount", Infinity);

export async function getActiveThoughtCount(): Promise<number> {
  await ensureThoughtsTable();
  return activeCountCache.getOrFetch(`count:${principalCacheKey()}`, async () => {
    const cutoff = new Date(Date.now() - ACTIVE_MAX_AGE_MS);
    const [result] = await db.select({ value: count() }).from(thoughts)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), thoughtScopeColumns, gte(thoughts.occurredAt, cutoff)));
    return result?.value ?? 0;
  });
}

export async function deleteThought(id: string): Promise<boolean> {
  await ensureThoughtsTable();
  const result = await db.delete(thoughts).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), thoughtScopeColumns, eq(thoughts.id, id))).returning({ id: thoughts.id });
  if (result.length > 0) {
    thoughtsCache.invalidateAll();
    activeCountCache.invalidateAll();
    eventBus.publish({ category: "system", event: "data:thoughts_changed", payload: { source: "thoughts", action: "delete", thoughtId: id } });
    log.log(`Thought deleted id=${id}`);
    return true;
  }
  return false;
}

export async function deleteAllThoughts(): Promise<number> {
  await ensureThoughtsTable();
  const result = await db.delete(thoughts).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), thoughtScopeColumns)).returning({ id: thoughts.id });
  thoughtsCache.invalidateAll();
  activeCountCache.invalidateAll();
  eventBus.publish({ category: "system", event: "data:thoughts_changed", payload: { source: "thoughts", action: "delete_all" } });
  log.log(`All thoughts deleted count=${result.length}`);
  return result.length;
}

export async function getThoughtById(id: string): Promise<Thought | undefined> {
  await ensureThoughtsTable();
  const [row] = await db.select().from(thoughts).where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), thoughtScopeColumns, eq(thoughts.id, id))).limit(1);
  return row;
}

export function makeThoughtHeader(type: string): string {
  const now = new Date();
  const formattedDate = formatInTimezone(now, { year: "numeric", month: "2-digit", day: "2-digit" });
  const formattedTime = formatInTimezone(now, { hour: "numeric", minute: "2-digit", hour12: true });
  const knownLabels: Record<string, string> = {
    world: "WORLD",
    self: "SELF",
    us: "US",
    weekly_reflect: "WEEKLY REFLECT",
    monthly_reflect: "MONTHLY REFLECT",
    pattern: "PATTERN",
    gap: "GAP",
    change: "CHANGE",
    connection: "CONNECTION",
    opportunity: "OPPORTUNITY",
    thought: "THOUGHT",
  };
  const label = knownLabels[type] || type.toUpperCase();
  return `[${label} — ${formattedDate} ${formattedTime}]`;
}

export async function saveWeeklyReflectionToMemory(content: string): Promise<void> {
  try {
    const { memoryStorage } = await import("./memory/memory-storage");
    const sourceId = `weekly-reflect-${Date.now().toString(36)}`;
    await memoryStorage.upsertExchange(
      sourceId,
      content,
      "manual",
      { type: "weekly_reflection", date: new Date().toISOString().split("T")[0] },
      ["weekly_reflection"]
    );
    log.log(`[weekly_reflect] Saved reflection summary to memory sourceId=${sourceId}`);
  } catch (err: unknown) {
    log.error(`[weekly_reflect] Failed to save to memory:`, err instanceof Error ? err.message : String(err));
  }
}

export async function saveJournalToLibrary(
  content: string,
  title: string,
  tags: string[],
  parentSlug: string = "journals",
): Promise<void> {
  const { createFiledLibraryPage } = await import("./library-save");
  const page = await createFiledLibraryPage({
    title,
    markdown: content,
    purpose: parentSlug,
    pageContext: "/journal",
    contentSummary: `Journal artifact: ${title}`,
    tags,
  });

  log.log(`[journal] Saved journal page id=${page.id} title="${title}" tags=[${tags.join(",")}] under filingKey=${page.filingResolution.filingKey}`);
}

export async function buildDreamPreContext(): Promise<{ preContext: string } | null> {
  const { memoryStorage } = await import("./memory/memory-storage");
  const { walkGraph } = await import("./memory/graph-walker");

  const longEntries = await memoryStorage.getLayer("long", 50);
  if (longEntries.length < 2) {
    log.log(`[dream] Not enough long-term memories for dream mode`);
    return null;
  }

  const entriesWithEmbeddings = longEntries.filter(e => e.embedding != null);

  let sample: typeof longEntries;

  if (entriesWithEmbeddings.length >= 2) {
    const shuffled = [...entriesWithEmbeddings].sort(() => Math.random() - 0.5);
    const seedA = shuffled[0];
    const seedB = shuffled[Math.floor(shuffled.length / 2)];

    const clusterA = await walkGraph({
      seedEntryIds: [seedA.id],
      focusEmbedding: seedB.embedding as number[],
      maxHops: 3,
      minRelevance: 0.15,
      maxResults: 5,
      excludeIds: new Set([seedB.id]),
    });

    const excludeFromB = new Set([seedA.id, ...clusterA.map(r => r.entry.id)]);
    const clusterB = await walkGraph({
      seedEntryIds: [seedB.id],
      focusEmbedding: seedA.embedding as number[],
      maxHops: 3,
      minRelevance: 0.15,
      maxResults: 5,
      excludeIds: excludeFromB,
    });

    const combined = new Map<number, typeof longEntries[0]>();
    combined.set(seedA.id, seedA);
    combined.set(seedB.id, seedB);
    for (const r of clusterA) combined.set(r.entry.id, r.entry);
    for (const r of clusterB) combined.set(r.entry.id, r.entry);

    sample = Array.from(combined.values()).slice(0, 10);

    log.log(`[dream] Graph walker found ${clusterA.length} entries in cluster A, ${clusterB.length} in cluster B, ${sample.length} total`);
  } else {
    const shuffled = [...longEntries].sort(() => Math.random() - 0.5);
    sample = shuffled.slice(0, Math.min(8, shuffled.length));
    log.log(`[dream] Not enough embeddings for graph walk, using random sample of ${sample.length}`);
  }

  const preContext = sample.map(e =>
    `[Memory #${e.id}] "${e.title || '(untitled)'}":\n${e.summary || e.content.slice(0, 300)}\nTags: ${(e.tags || []).join(', ')}`
  ).join("\n\n");

  return { preContext };
}

export interface JournalEntry {
  id: string;
  date: string;
  title: string;
  content: string;
  createdAt: string;
}

export async function getJournalEntriesSince(daysAgo: number, tagFilter?: string[]): Promise<JournalEntry[]> {
  const { db: database } = await import("./db");
  const { libraryPages } = await import("@shared/models/info");
  const { eq, and, gte, desc, sql: dsql } = await import("drizzle-orm");

  let parentId: string;
  try {
    const { resolveLibraryParent } = await import("./library-index");
    parentId = await resolveLibraryParent("journals");
  } catch {
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysAgo);

  const filterTags = tagFilter || ["daily"];

  const cutoffDateStr = cutoff.toISOString().split("T")[0];

  const pages = await database.select().from(libraryPages).where(
    and(
      eq(libraryPages.parentId, parentId),
      dsql`${libraryPages.tags} @> ARRAY[${dsql.join(filterTags.map(t => dsql`${t}`), dsql`, `)}]::text[]`,
    )
  ).orderBy(desc(libraryPages.createdAt));

  return pages
    .map(p => {
      const dateMatch = p.title.match(/^\d{4}-\d{2}-\d{2}/);
      const date = dateMatch ? dateMatch[0] : p.createdAt.toISOString().split("T")[0];
      const titleSuffix = p.title.replace(/^\d{4}-\d{2}-\d{2}\s*—?\s*/, "").trim();
      return {
        id: p.id,
        date,
        title: titleSuffix || date,
        content: p.plainTextContent || "",
        createdAt: p.createdAt.toISOString(),
      };
    })
    .filter(e => e.date >= cutoffDateStr);
}

export async function buildDailyReflectPreContext(): Promise<{ preContext: string } | null> {
  const sections: string[] = [];

  try {
    const { memoryStorage } = await import("./memory/memory-storage");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const recentEntries = await memoryStorage.getLayer("short", 50);
    const todayEntries = recentEntries.filter(e => new Date(e.createdAt).getTime() >= today.getTime());
    if (todayEntries.length > 0) {
      sections.push(`## Today's Memory Entries\n\n${todayEntries.map(e => `- ${e.title || e.content.slice(0, 200)}`).join("\n")}`);
    }
  } catch (err: unknown) {
    log.warn(`[daily_reflect] Failed to gather memory entries: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const recentThoughts = await getRecentThoughts(24 * 60 * 60 * 1000, 20);
    if (recentThoughts.length > 0) {
      sections.push(`## Today's Thoughts & Observations\n\n${recentThoughts.map(t => `- [${t.type || "reflect"}] ${t.text}`).join("\n")}`);
    }
  } catch (err: unknown) {
    log.warn(`[daily_reflect] Failed to gather thoughts: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const { listAllEvents } = await import("./google-calendar");
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const { events: todayEvents } = await listAllEvents({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
    });
    if (todayEvents.length > 0) {
      const eventLines = todayEvents.slice(0, 20).map(e => {
        const time = e.start.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : "all-day";
        const attendees = (e.attendees || []).filter(a => !a.self).map(a => a.displayName || a.email).slice(0, 5);
        const attendeeStr = attendees.length > 0 ? ` (with: ${attendees.join(", ")})` : "";
        return `- [${time}] ${e.summary || "Untitled"}${attendeeStr}`;
      });
      sections.push(`## Today's Calendar Events\n\n${eventLines.join("\n")}`);
    }
  } catch (err: unknown) {
    log.warn(`[daily_reflect] Failed to gather calendar events: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const { goalsService } = await import("./goals-service");
    const goals = await goalsService.listAll();
    const activeGoals = goals.filter(g => g.status === "active" || g.status === "on_track").slice(0, 15);
    if (activeGoals.length > 0) {
      sections.push(`## Active Priorities\n\n${activeGoals.map(g => `- [${g.horizon}] ${g.shortName}`).join("\n")}`);
    }
  } catch (err: unknown) {
    log.warn(`[daily_reflect] Failed to gather goals: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Intentions section removed — autonomy skill handles autonomous work

  try {
    const { getRecentSessionSummaries } = await import("./chat-file-storage");
    const recentSessions = await getRecentSessionSummaries(24);
    if (recentSessions.length > 0) {
      const summaryLines = recentSessions.map(s => `- ${s.title}${s.snippet ? `: ${s.snippet.slice(0, 120)}` : ""}`);
      sections.push(`## Today's Session Summaries\n\n${summaryLines.join("\n")}`);
    }
  } catch (err: unknown) {
    log.warn(`[daily_reflect] Failed to gather session summaries: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (sections.length === 0) {
    log.log(`[daily_reflect] No data gathered for preContext — proceeding without preContext`);
    return null;
  }

  return { preContext: sections.join("\n\n") };
}

export async function buildWeeklyReflectPreContext(): Promise<{ preContext: string } | null> {
  const entries = await getJournalEntriesSince(7);
  if (entries.length < 1) {
    log.log(`[weekly_reflect] Not enough journal entries (${entries.length} < 1) — skipping`);
    return null;
  }

  const { goalsService } = await import("./goals-service");
  const { fileBeliefStorage } = await import("./file-storage/beliefs");

  const goals = await goalsService.listAll({ status: "active" } as any);
  const activeGoals = goals.slice(0, 20);
  const beliefs = await fileBeliefStorage.getAll();
  const activeBeliefs = beliefs.filter(b => b.status === "active").slice(0, 20);

  const journalSection = entries.map(e => {
    const title = e.title ? ` — ${e.title}` : "";
    return `[${e.date}${title}] ${e.content}`;
  }).join("\n\n");

  const goalsSection = activeGoals.length > 0
    ? activeGoals.map(g => `- [${g.horizon}] ${g.shortName}`).join("\n")
    : "No active goals.";

  const beliefsSection = activeBeliefs.length > 0
    ? activeBeliefs.map(b => `- [${b.domain}] ${b.claim} (confidence: ${b.confidence})`).join("\n")
    : "No active beliefs.";

  const preContext = `## Journal Entries (Past 7 Days)\n\n${journalSection}\n\n## Current Goals\n\n${goalsSection}\n\n## Current Beliefs\n\n${beliefsSection}`;

  return { preContext };
}

export async function buildMonthlyReflectPreContext(): Promise<{ preContext: string } | null> {
  const entries = await getJournalEntriesSince(30);
  if (entries.length < 3) {
    log.log(`[monthly_reflect] Not enough journal entries (${entries.length} < 3) — skipping`);
    return null;
  }

  const { goalsService } = await import("./goals-service");
  const { fileBeliefStorage } = await import("./file-storage/beliefs");
  const { peopleStorage } = await import("./people-storage");

  const goals = await goalsService.listAll({ status: "active" } as any);
  const activeGoals = goals.slice(0, 20);
  const beliefs = await fileBeliefStorage.getAll();
  const activeBeliefs = beliefs.filter(b => b.status === "active").slice(0, 20);

  const allPeople = await peopleStorage.listPeople();
  const xyzPerson = allPeople.find(p => p.cabinetLevel === "agent")
    || allPeople.find(p => p.cabinetLevel === "self" && p.name.toLowerCase() === getInstanceNameLower());
  let voiceSection = "No Voice note found.";
  if (xyzPerson) {
    const person = await peopleStorage.getPerson(xyzPerson.id);
    if (person && person.notes) {
      const voiceNote = person.notes.find(n => n.title?.toLowerCase() === "voice");
      if (voiceNote) {
        voiceSection = voiceNote.content;
      }
    }
  }

  const journalSection = entries.map(e => {
    const title = e.title ? ` — ${e.title}` : "";
    return `[${e.date}${title}] ${e.content}`;
  }).join("\n\n");

  const goalsSection = activeGoals.length > 0
    ? activeGoals.map(g => `- [${g.horizon}] ${g.shortName}`).join("\n")
    : "No active goals.";

  const beliefsSection = activeBeliefs.length > 0
    ? activeBeliefs.map(b => `- [${b.domain}] ${b.claim} (confidence: ${b.confidence})`).join("\n")
    : "No active beliefs.";

  let weeklyReflectionsSection = "No recent weekly reflections found.";
  try {
    const { db } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const result = await db.execute(sql`
      SELECT content, created_at
      FROM memory_entries
      WHERE 'weekly_reflection' = ANY(tags)
      ORDER BY created_at DESC
      LIMIT 4
    `);
    const rows = result.rows as Array<{ content: string; created_at: Date }>;
    if (rows.length > 0) {
      weeklyReflectionsSection = rows.map(r =>
        `[${new Date(r.created_at).toISOString().split("T")[0]}] ${r.content}`
      ).join("\n\n");
    }
  } catch { }

  let principlesSection = "No principles document found.";
  try {
    const { documentStorage } = await import("./memory/document-storage");
    const principlesDoc = await documentStorage.getDocument("workspace_file" as any, "PRINCIPLES.md");
    if (principlesDoc) {
      principlesSection = principlesDoc.content;
    }
  } catch { }

  const preContext = `## Journal Entries (Past 30 Days)\n\n${journalSection}\n\n## Current Voice\n\n${voiceSection}\n\n## Current Principles\n\n${principlesSection}\n\n## Recent Weekly Reflections\n\n${weeklyReflectionsSection}\n\n## Current Goals\n\n${goalsSection}\n\n## Current Beliefs\n\n${beliefsSection}`;

  return { preContext };
}

interface SourceResult {
  data: string | null;
  failed: boolean;
}

async function fetchWithTimeout(label: string, fn: () => Promise<string | null>, timeoutMs = 5000): Promise<SourceResult> {
  const briefLog = createLogger("DailyBrief");
  briefLog.log(`[${label}] START`);
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    briefLog.log(`[${label}] DONE`);
    return { data: result, failed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "timeout") {
      briefLog.log(`[${label}] TIMEOUT after ${timeoutMs}ms`);
    } else {
      briefLog.log(`[${label}] ERROR: ${msg}`);
    }
    return { data: null, failed: true };
  }
}

function getTzDateStr(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function getTzOffsetISO(tz: string): string {
  const now = new Date();
  const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = now.toLocaleString("en-US", { timeZone: tz });
  const diffMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  const sign = diffMs >= 0 ? "+" : "-";
  const absMins = Math.abs(Math.round(diffMs / 60000));
  const h = String(Math.floor(absMins / 60)).padStart(2, "0");
  const m = String(absMins % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

async function fetchCalendarEvents(isWeekend: boolean): Promise<string | null> {
  const { listAllEvents } = await import("./google-calendar");
  const tz = getTimezone();
  const todayStr = getTzDateStr(tz);
  const offset = getTzOffsetISO(tz);
  let { events } = await listAllEvents({
    timeMin: `${todayStr}T00:00:00${offset}`,
    timeMax: `${todayStr}T23:59:59${offset}`,
    maxResults: 20,
  });
  if (isWeekend) {
    events = events.filter(e => {
      const title = (e.summary || "").toLowerCase();
      return !title.includes("enklu") && !title.includes("mira");
    });
  }
  if (events.length === 0) return null;
  return events.map(e => {
    const time = e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "All day";
    const attendees = e.attendees?.map(a => a.displayName || a.email).join(", ") || "";
    const attendeeStr = attendees ? ` — with ${attendees}` : "";
    return `- ${time}: ${e.summary || "(no title)"}${attendeeStr}`;
  }).join("\n");
}

async function fetchPriorities(_isWeekend: boolean): Promise<string | null> {
  const { goalsService } = await import("./goals-service");
  const goals = await goalsService.listByHorizon("today");
  const active = goals.filter(g => g.status === "active" || g.status === "on_track" || g.status === "at_risk");
  if (active.length === 0) return null;
  return active.map((g, i) => {
    const parts = [`${i + 1}. ${g.shortName}`];
    if (g.status !== "active") parts.push(`(${g.status})`);
    return parts.join(" ");
  }).join("\n");
}

async function fetchTasks(isWeekend: boolean): Promise<string | null> {
  const { fileTaskStorage } = await import("./file-storage/tasks");
  const [readyTasks, blockedTasks, onHoldTasks] = await Promise.all([
    fileTaskStorage.getTasks({ status: "ready" }),
    fileTaskStorage.getTasks({ status: "blocked" }),
    fileTaskStorage.getTasks({ status: "on_hold" }),
  ]);

  const filterEnklu = (list: typeof readyTasks) => {
    if (!isWeekend) return list;
    return list.filter(t => {
      const tags = (t.tags || []).map(tg => tg.toLowerCase());
      const title = t.title.toLowerCase();
      return !tags.includes("enklu") && !tags.includes("mira") && !title.includes("enklu") && !title.includes("mira");
    });
  };

  const readyAll = filterEnklu(readyTasks);
  const blockedAll = filterEnklu(blockedTasks);
  const onHoldAll = filterEnklu(onHoldTasks);
  const totalCap = 20;
  const blockedCap = Math.min(blockedAll.length, 5);
  const onHoldCap = Math.min(onHoldAll.length, 5);
  const readyCap = Math.max(0, totalCap - blockedCap - onHoldCap);
  const ready = readyAll.slice(0, readyCap);
  const blocked = blockedAll.slice(0, blockedCap);
  const onHold = onHoldAll.slice(0, onHoldCap);

  if (ready.length === 0 && blocked.length === 0 && onHold.length === 0) return null;

  const lines: string[] = [];
  const highPriority = ready.filter(t => t.priority === "high");
  const normalPriority = ready.filter(t => t.priority !== "high");
  const { formatDeadlineCompact, getDeadlineProximity } = await import("@shared/models/work");
  let totalEstimatedHours = 0;
  for (const t of [...highPriority, ...normalPriority]) {
    const est = t.estimateLow != null && t.estimateHigh != null
      ? ` (~${((t.estimateLow + t.estimateHigh) / 2).toFixed(1)}h)`
      : '';
    let dl = '';
    if (t.deadline) {
      const prox = getDeadlineProximity(t.deadline);
      const compact = formatDeadlineCompact(t.deadline);
      dl = prox ? ` due ${compact} (${prox.label})` : ` due ${compact}`;
    }
    lines.push(`- [${t.priority}] ${t.title}${est}${dl}${t.projectId ? ` (project #${t.projectId})` : ""}`);
    if (t.estimateLow != null && t.estimateHigh != null) {
      totalEstimatedHours += (t.estimateLow + t.estimateHigh) / 2;
    }
  }
  if (blocked.length > 0) {
    lines.push("");
    lines.push("Blocked:");
    for (const t of blocked) {
      lines.push(`- [blocked] ${t.title}${t.updatedAt ? ` (since ${t.updatedAt.split("T")[0]})` : ""}`);
    }
  }
  if (onHold.length > 0) {
    lines.push("");
    lines.push("On Hold:");
    for (const t of onHold) {
      lines.push(`- [on_hold] ${t.title}${t.updatedAt ? ` (since ${t.updatedAt.split("T")[0]})` : ""}`);
    }
  }
  if (totalEstimatedHours > 0) {
    lines.push("");
    lines.push(`Total estimated: ~${totalEstimatedHours.toFixed(1)}h`);
  }
  return lines.join("\n");
}

async function fetchEmailSummary(isWeekend: boolean): Promise<string | null> {
  const { db } = await import("./db");
  const { emailMessages, connectedAccounts } = await import("@shared/schema");
  const { desc: descOp, gte: gteOp, eq: eqOp, and: andOp } = await import("drizzle-orm");

  try {
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000);

    const accounts = await db.select({ accountId: connectedAccounts.accountId })
      .from(connectedAccounts)
      .where(eqOp(connectedAccounts.provider, "gmail"));

    if (accounts.length === 0) return null;

    const lines: string[] = [];
    for (const acct of accounts) {
      try {
        const rows = await db.select().from(emailMessages)
          .where(andOp(
            eqOp(emailMessages.accountId, acct.accountId),
            gteOp(emailMessages.date, since),
          ))
          .orderBy(descOp(emailMessages.date))
          .limit(10);

        for (const row of rows) {
          const subject = row.subject || "(no subject)";
          const from = row.fromAddress || "unknown";
          if (isWeekend) {
            const combined = `${subject} ${from}`.toLowerCase();
            if (combined.includes("enklu") || combined.includes("mira")) continue;
          }
          lines.push(`- From: ${from} — ${subject}`);
        }
      } catch (acctErr) {
        const briefLog = createLogger("DailyBrief");
        briefLog.log(`[email] account ${acct.accountId} cache query error: ${acctErr instanceof Error ? acctErr.message : String(acctErr)}`);
      }
    }

    if (lines.length === 0) return null;
    return lines.join("\n");
  } catch (err) {
    const briefLog = createLogger("DailyBrief");
    briefLog.log(`[email] cache query error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchFinanceSnapshot(): Promise<string | null> {
  const { getTransactions, isPlaidConfigured } = await import("./plaid-service");
  if (!isPlaidConfigured()) return null;
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const today = new Date().toISOString().split("T")[0];
  const { transactions: recentTxns } = await getTransactions({ startDate: sevenDaysAgo, endDate: today, limit: 10 });
  if (recentTxns.length === 0) return null;
  const parts: string[] = [`Recent Transactions (last 7 days, top 10):`];
  for (const tx of recentTxns) {
    const amt = tx.amount != null ? `$${Math.abs(tx.amount).toFixed(2)}` : "";
    const cat = tx.categoryPrimary || "";
    parts.push(`- ${tx.date}: ${tx.merchantName || tx.name || "Unknown"} ${amt}${cat ? ` (${cat})` : ""}`);
  }
  return parts.join("\n");
}

async function fetchPeopleContext(): Promise<string | null> {
  const { peopleStorage } = await import("./people-storage");
  const people = await peopleStorage.listPeople();
  const recentInteractions = people
    .filter(p => p.lastInteractionDate)
    .sort((a, b) => new Date(b.lastInteractionDate!).getTime() - new Date(a.lastInteractionDate!).getTime())
    .slice(0, 5);
  if (recentInteractions.length === 0) return null;
  return recentInteractions.map(p =>
    `- ${p.name} (${p.cabinetLevel}) — last interaction: ${p.lastInteractionDate}`
  ).join("\n");
}

async function fetchAttendeePeopleContext(isWeekend: boolean): Promise<string | null> {
  const { peopleStorage } = await import("./people-storage");
  const { listAllEvents } = await import("./google-calendar");
  const tz = getTimezone();
  const todayStr = getTzDateStr(tz);
  const offset = getTzOffsetISO(tz);

  let { events } = await listAllEvents({
    timeMin: `${todayStr}T00:00:00${offset}`,
    timeMax: `${todayStr}T23:59:59${offset}`,
    maxResults: 20,
  });
  if (isWeekend) {
    events = events.filter(e => {
      const title = (e.summary || "").toLowerCase();
      return !title.includes("enklu") && !title.includes("mira");
    });
  }

  const attendeeNames = new Set<string>();
  for (const event of events) {
    for (const a of event.attendees || []) {
      if (!a.self && (a.displayName || a.email)) {
        attendeeNames.add((a.displayName || a.email || "").toLowerCase());
      }
    }
  }

  if (attendeeNames.size === 0) {
    return fetchPeopleContext();
  }

  const allPeople = await peopleStorage.listPeople();
  const attendeePeople = allPeople.filter(p => {
    const nameLower = p.name.toLowerCase();
    const nickLower = (p.nicknames || []).map(n => n.toLowerCase());
    return [...attendeeNames].some(attendee =>
      attendee.includes(nameLower) || nameLower.includes(attendee) ||
      nickLower.some(n => attendee.includes(n) || n.includes(attendee)) ||
      nameLower.split(/\s+/).some(w => w.length > 2 && attendee.includes(w))
    );
  });

  const matchedIds = new Set(attendeePeople.map(p => p.id));
  const recentInteractions = allPeople
    .filter(p => p.lastInteractionDate && !matchedIds.has(p.id))
    .sort((a, b) => new Date(b.lastInteractionDate!).getTime() - new Date(a.lastInteractionDate!).getTime())
    .slice(0, 3);

  const lines: string[] = [];

  const { computeRollup, getDefaultCadence, computeDueStatus } = await import("./people-storage");

  const obligationLines: string[] = [];
  const meetingContextLines: string[] = [];
  const driftLines: string[] = [];

  const skipLevels = new Set(["self", "agent", "user"]);
  for (const entry of allPeople) {
    if (skipLevels.has(entry.cabinetLevel)) continue;
    const person = await peopleStorage.getPerson(entry.id);
    if (!person) continue;

    const responseOwedIx = person.interactions.find(ix => ix.responseOwed);
    if (responseOwedIx) {
      const daysSince = Math.floor((Date.now() - new Date(responseOwedIx.date).getTime()) / 86400000);
      obligationLines.push(`- ${person.name}: Response owed (${daysSince}d) — ${responseOwedIx.summary.slice(0, 80)}`);
    }

    const openCommitments = person.networkProfile?.commitments?.filter(c => c.status === "open") || [];
    for (const c of openCommitments) {
      const age = Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 86400000);
      if (age > 7) {
        obligationLines.push(`- ${person.name}: Open commitment (${age}d) — ${c.description.slice(0, 80)}`);
      }
    }

    const cadence = person.relationshipProfile?.cadence || getDefaultCadence(person.cabinetLevel);
    const rollup = computeRollup(person.interactions);
    const dueStatus = computeDueStatus(rollup, cadence, person);
    if (dueStatus === "drifting" || dueStatus === "urgent") {
      const daysSince = rollup.lastMeaningfulAt
        ? Math.floor((Date.now() - new Date(rollup.lastMeaningfulAt).getTime()) / 86400000) : 365;
      driftLines.push(`- ${person.name}: ${daysSince}d since meaningful contact (${dueStatus})`);
    }
  }

  if (attendeePeople.length > 0) {
    meetingContextLines.push("**Meeting Relationship Context:**");
    for (const p of attendeePeople) {
      const person = await peopleStorage.getPerson(p.id);
      const parts = [`- **${p.name}** (${p.cabinetLevel})`];
      if (p.lastInteractionDate) parts.push(`last interaction: ${p.lastInteractionDate}`);
      if (person?.networkProfile?.capital?.balance) parts.push(`capital: ${person.networkProfile.capital.balance}`);
      if (person?.networkProfile?.expertise?.length) parts.push(`expertise: ${person.networkProfile.expertise.slice(0, 3).join(", ")}`);
      const openC = person?.networkProfile?.commitments?.filter(c => c.status === "open") || [];
      if (openC.length > 0) parts.push(`${openC.length} open commitment${openC.length > 1 ? "s" : ""}`);

      let posture = "neutral";
      if (person) {
        const temp = person.relationshipProfile?.state?.temperature;
        const capBal = person.networkProfile?.capital?.balance;
        const responseOwed = person.interactions.some(ix => ix.responseOwed);
        if (responseOwed) {
          posture = "acknowledge — you owe a response";
        } else if (capBal === "overdrawn" || capBal === "drawing") {
          posture = "deposit — invest before asking";
        } else if (temp === "cool" || temp === "cold") {
          posture = "warm — rebuild rapport before business";
        } else if (openC.length > 0) {
          posture = "follow-through — address open commitments";
        } else if (capBal === "invested") {
          posture = "leverage-ready — can make asks";
        } else {
          posture = "maintain — continue steady engagement";
        }
      }
      parts.push(`posture: ${posture}`);
      meetingContextLines.push(parts.join(" — "));
    }
  }

  if (obligationLines.length > 0) {
    lines.push("**Relationship Obligations:**");
    lines.push(...obligationLines.slice(0, 5));
    lines.push("");
  }

  if (meetingContextLines.length > 0) {
    lines.push(...meetingContextLines);
    lines.push("");
  } else if (attendeePeople.length > 0) {
    lines.push("**Today's Meeting Attendees:**");
    for (const p of attendeePeople) {
      const parts = [`- ${p.name} (${p.cabinetLevel})`];
      if (p.lastInteractionDate) parts.push(`last interaction: ${p.lastInteractionDate}`);
      lines.push(parts.join(" — "));
    }
    lines.push("");
  }

  if (driftLines.length > 0) {
    lines.push("**Drift Alerts:**");
    lines.push(...driftLines.slice(0, 5));
    lines.push("");
  }

  if (recentInteractions.length > 0) {
    lines.push("**Other Recent Interactions:**");
    for (const p of recentInteractions) {
      lines.push(`- ${p.name} (${p.cabinetLevel}) — last interaction: ${p.lastInteractionDate}`);
    }
  }

  if (lines.length === 0) return null;
  return lines.join("\n");
}

async function fetchGoalsAndPriorities(_isWeekend: boolean): Promise<string | null> {
  const { goalsService } = await import("./goals-service");

  const tz = getTimezone();
  const today = getTzDateStr(tz);
  const yesterday = getTzDateStr(tz, -1);
  const [todayPriorities, yesterdayPriorities] = await Promise.all([
    goalsService.listPrioritiesForPeriod("today", today),
    goalsService.listPrioritiesForPeriod("today", yesterday),
  ]);

  const parts: string[] = [];
  if (yesterdayPriorities.length > 0) {
    parts.push("Yesterday's Priorities:\n" + yesterdayPriorities.map((p) =>
      `- ${p.title}${p.urgency ? ` (${p.urgency})` : ""}`
    ).join("\n"));
  }
  if (todayPriorities.length > 0) {
    parts.push("Today's Priorities (already set):\n" + todayPriorities.map((p) =>
      `- ${p.title}`
    ).join("\n"));
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

async function fetchYesterdayJournal(isWeekend: boolean): Promise<string | null> {
  const entries = await getJournalEntriesSince(1);
  if (entries.length === 0) return null;
  let filtered = entries;
  if (isWeekend) {
    filtered = entries.filter(e => {
      const text = `${e.title || ""} ${e.content}`.toLowerCase();
      return !text.includes("enklu") && !text.includes("mira");
    });
  }
  if (filtered.length === 0) return null;
  return filtered.map(e => {
    const title = e.title ? ` — ${e.title}` : "";
    return `[${e.date}${title}] ${e.content}`;
  }).join("\n\n");
}

async function fetchWellnessStatus(): Promise<string | null> {
  const { queryActivityStatus } = await import("./routes/wellness");
  const activities = await queryActivityStatus();
  if (activities.length === 0) return null;

  const grouped: Record<string, typeof activities> = { overdue: [], due_soon: [], on_track: [], never_done: [] };
  for (const a of activities) {
    grouped[a.status]?.push(a);
  }

  grouped.overdue.sort((a, b) => b.urgency - a.urgency);
  grouped.due_soon.sort((a, b) => b.urgency - a.urgency);

  const lines: string[] = [];

  for (const a of grouped.overdue) {
    const overdueDays = a.daysUntilDue !== null ? Math.abs(a.daysUntilDue) : null;
    lines.push(`- ⚠️ OVERDUE: ${a.name}${overdueDays !== null ? ` (${overdueDays}d overdue)` : ""}`);
  }
  for (const a of grouped.due_soon) {
    lines.push(`- 🔔 DUE SOON: ${a.name}${a.daysUntilDue !== null ? ` (due in ${a.daysUntilDue}d)` : ""}`);
  }
  if (grouped.on_track.length > 0) {
    lines.push(`- ✅ ${grouped.on_track.length} activit${grouped.on_track.length === 1 ? "y" : "ies"} on track`);
  }
  if (grouped.never_done.length > 0) {
    lines.push(`- ⬜ ${grouped.never_done.length} activit${grouped.never_done.length === 1 ? "y" : "ies"} never done`);
  }

  return lines.join("\n");
}

export async function buildDailyBriefPreContext(): Promise<{ preContext: string } | null> {
  const briefLog = createLogger("DailyBrief");
  const startTime = Date.now();
  briefLog.log("Building daily brief preContext");

  const tz = getTimezone();
  const now = new Date();
  const dayOfWeek = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
  const dateStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "long", day: "numeric" }).format(now);
  const isWeekend = dayOfWeek === "Saturday" || dayOfWeek === "Sunday";

  const MASTER_TIMEOUT = 30_000;

  const sourceNames = ["calendar", "priorities", "weekly_priorities", "tasks", "email", "finance", "people", "goals", "journal", "wellness"] as const;
  const sourceFetchers: Promise<SourceResult>[] = [
    fetchWithTimeout("calendar", () => fetchCalendarEvents(isWeekend)),
    fetchWithTimeout("priorities", () => fetchPriorities(isWeekend)),
    fetchWithTimeout("weekly_priorities", async () => {
      const { goalsService } = await import("./goals-service");
      const todayStr = getTzDateStr(tz);
      const d = new Date(todayStr + "T12:00:00");
      const day = d.getDay();
      const diff = day === 0 ? 6 : day - 1;
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
      const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
      const priorities = await goalsService.listPrioritiesForPeriod("this_week", mondayStr);
      if (!priorities.length) return null;
      return priorities.map((p: { title: string; urgency?: string }) => `- ${p.title}${p.urgency ? ` (${p.urgency})` : ""}`).join("\n");
    }),
    fetchWithTimeout("tasks", () => fetchTasks(isWeekend)),
    fetchWithTimeout("email", () => fetchEmailSummary(isWeekend)),
    fetchWithTimeout("finance", () => fetchFinanceSnapshot()),
    fetchWithTimeout("people", () => fetchAttendeePeopleContext(isWeekend)),
    fetchWithTimeout("goals", () => fetchGoalsAndPriorities(isWeekend)),
    fetchWithTimeout("journal", () => fetchYesterdayJournal(isWeekend)),
    fetchWithTimeout("wellness", fetchWellnessStatus),
  ];

  const settled = await Promise.race([
    Promise.allSettled(sourceFetchers),
    new Promise<PromiseSettledResult<SourceResult>[]>((resolve) =>
      setTimeout(() => resolve(sourceNames.map(() => ({
        status: "rejected" as const,
        reason: "master timeout",
      }))), MASTER_TIMEOUT)
    ),
  ]);

  const results: SourceResult[] = settled.map(s =>
    s.status === "fulfilled" ? s.value : { data: null, failed: true }
  );

  const sections: string[] = [];
  sections.push(`# Daily Brief — ${dayOfWeek}, ${dateStr}`);
  sections.push(`Generated at ${now.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`);
  if (isWeekend) sections.push(`*Weekend mode — Enklu work content filtered out*`);

  const sectionTitles: Record<string, string> = {
    calendar: "Calendar",
    priorities: "Priority Stack",
    weekly_priorities: "Weekly Priorities",
    tasks: "Tasks",
    email: "Email (Last 12 Hours)",
    finance: "Finance Snapshot",
    people: "Recent People Interactions",
    goals: "Daily Goals & Priorities",
    journal: "Yesterday's Journal",
    wellness: "Wellness Activities",
  };

  let successCount = 0;
  for (let i = 0; i < sourceNames.length; i++) {
    const name = sourceNames[i];
    const result = results[i];
    if (!result.failed && result.data) {
      sections.push(`\n## ${sectionTitles[name]}\n\n${result.data}`);
      successCount++;
    } else if (result.failed) {
      sections.push(`\n## ${sectionTitles[name]}\n\n[source unavailable]`);
    }
  }

  const elapsed = Date.now() - startTime;
  briefLog.log(`Daily brief preContext built: ${successCount}/${sourceNames.length} sources in ${elapsed}ms`);

  if (successCount === 0) {
    briefLog.log("No sources returned data — skipping brief");
    return null;
  }

  return { preContext: sections.join("\n") };
}

export function isLastFridayOfMonth(): boolean {
  const tz = getTimezone();
  const now = new Date();
  const dayOfWeek = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  if (!dayOfWeek.startsWith("Fri")) return false;
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const currentMonth = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric" }).format(now);
  const nextWeekMonth = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric" }).format(nextWeek);
  return currentMonth !== nextWeekMonth;
}



export async function buildDailyReviewPreContext(): Promise<{ preContext: string } | null> {
  const reviewLog = createLogger("DailyReview");
  const startTime = Date.now();
  reviewLog.log("Building daily review preContext");

  const tz = getTimezone();
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "long", day: "numeric" }).format(now);
  const dayOfWeek = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);

  const MASTER_TIMEOUT = 25_000;
  const sections: string[] = [];
  sections.push(`# Evening Review — ${dayOfWeek}, ${dateStr}`);

  const hour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now));
  if (hour >= 23) {
    sections.push(`\n⚠️ **Bedtime Creep Alert**: It's past 11 PM. Consider wrapping up and getting rest.`);
  }

  const sourceNames = ["priorities", "calendar_tomorrow", "completed_work", "open_work", "wellness"] as const;
  const sourceFetchers: Promise<SourceResult>[] = [
    fetchWithTimeout("priorities", async () => {
      const { goalsService } = await import("./goals-service");
      const todayStr = getTzDateStr(tz);
      const priorities = await goalsService.listPrioritiesForPeriod("today", todayStr);
      if (!priorities.length) return null;
      return priorities.map((p: { title: string; urgency?: string }) =>
        `- ${p.urgency === "completed" ? "✅" : p.urgency === "partial" ? "🟡" : p.urgency === "missed" ? "❌" : "⬜"} ${p.title}${p.urgency ? ` (${p.urgency})` : ""}`
      ).join("\n");
    }),
    fetchWithTimeout("calendar_tomorrow", async () => {
      const { listAllEvents } = await import("./google-calendar");
      const offset = getTzOffsetISO(tz);
      const tomorrowStr = getTzDateStr(tz, 1);
      const { events } = await listAllEvents({
        timeMin: `${tomorrowStr}T00:00:00${offset}`,
        timeMax: `${tomorrowStr}T23:59:59${offset}`,
        maxResults: 15,
      });
      if (events.length === 0) return null;
      return events.map(e => {
        const time = e.start.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : "All day";
        const attendees = e.attendees?.filter(a => !a.self).map(a => a.displayName || a.email).slice(0, 3).join(", ") || "";
        return `- ${time}: ${e.summary || "(no title)"}${attendees ? ` (with ${attendees})` : ""}`;
      }).join("\n");
    }),
    fetchWithTimeout("completed_work", async () => null),
    fetchWithTimeout("open_work", async () => null),
    fetchWithTimeout("wellness", fetchWellnessStatus),
  ];

  const settled = await Promise.race([
    Promise.allSettled(sourceFetchers),
    new Promise<PromiseSettledResult<SourceResult>[]>((resolve) =>
      setTimeout(() => resolve(sourceNames.map(() => ({
        status: "rejected" as const,
        reason: "master timeout",
      }))), MASTER_TIMEOUT)
    ),
  ]);

  const results: SourceResult[] = settled.map(s =>
    s.status === "fulfilled" ? s.value : { data: null, failed: true }
  );

  const sectionTitles: Record<string, string> = {
    priorities: "Today's Priority Scorecard",
    calendar_tomorrow: "Tomorrow Preview",
    completed_work: "Completed Today",
    open_work: "Open Threads (Carry Forward)",
    wellness: "Wellness Activities",
  };

  let successCount = 0;
  for (let i = 0; i < sourceNames.length; i++) {
    const name = sourceNames[i];
    const result = results[i];
    if (!result.failed && result.data) {
      sections.push(`\n## ${sectionTitles[name]}\n\n${result.data}`);
      successCount++;
    }
  }

  const elapsed = Date.now() - startTime;
  reviewLog.log(`Daily review preContext built: ${successCount}/${sourceNames.length} sources in ${elapsed}ms`);

  if (successCount === 0) {
    reviewLog.log("No sources returned data — proceeding with minimal context");
  }

  return { preContext: sections.join("\n") };
}

export async function buildWeeklyPlanningPreContext(): Promise<{ preContext: string } | null> {
  const planLog = createLogger("WeeklyPlanning");
  const startTime = Date.now();
  planLog.log("Building weekly planning preContext");

  const tz = getTimezone();
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "long", day: "numeric" }).format(now);

  const MASTER_TIMEOUT = 30_000;
  const sections: string[] = [];
  sections.push(`# Weekly Planning — ${dateStr}`);

  const sourceNames = ["weekly_priorities", "monthly_priorities", "daily_reviews", "next_week_calendar", "tasks", "wellness", "people"] as const;
  const sourceFetchers: Promise<SourceResult>[] = [
    fetchWithTimeout("weekly_priorities", async () => {
      const { goalsService } = await import("./goals-service");
      const todayStr = getTzDateStr(tz);
      const d = new Date(todayStr + "T12:00:00");
      const day = d.getDay();
      const diff = day === 0 ? 6 : day - 1;
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
      const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
      const priorities = await goalsService.listPrioritiesForPeriod("this_week", mondayStr);
      if (!priorities.length) return null;
      return priorities.map((p: { title: string; urgency?: string }) =>
        `- ${p.urgency === "completed" ? "✅" : p.urgency === "partial" ? "🟡" : p.urgency === "missed" ? "❌" : "⬜"} ${p.title}${p.urgency ? ` (${p.urgency})` : ""}`
      ).join("\n");
    }),
    fetchWithTimeout("monthly_priorities", async () => {
      const { goalsService } = await import("./goals-service");
      const todayStr = getTzDateStr(tz);
      const d = new Date(todayStr + "T12:00:00");
      const firstOfMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
      const priorities = await goalsService.listPrioritiesForPeriod("this_month", firstOfMonth);
      if (!priorities.length) return null;
      return priorities.map((p: { title: string; urgency?: string }) => `- ${p.title}${p.urgency ? ` (${p.urgency})` : ""}`).join("\n");
    }),
    fetchWithTimeout("daily_reviews", async () => {
      try {
        const { resolveLibraryParent } = await import("./library-index");
        const parentId = await resolveLibraryParent("daily-reviews");
        const { db: database } = await import("./db");
        const { libraryPages } = await import("@shared/models/info");
        const { eq, desc } = await import("drizzle-orm");
        const pages = await database.select({
          title: libraryPages.title,
          plainTextContent: libraryPages.plainTextContent,
          createdAt: libraryPages.createdAt,
        }).from(libraryPages).where(
          eq(libraryPages.parentId, parentId)
        ).orderBy(desc(libraryPages.createdAt)).limit(7);
        if (pages.length === 0) return null;
        return pages.map(p => `### ${p.title}\n${(p.plainTextContent || "").slice(0, 500)}`).join("\n\n");
      } catch { return null; }
    }, 8000),
    fetchWithTimeout("next_week_calendar", async () => {
      const { listAllEvents } = await import("./google-calendar");
      const offset = getTzOffsetISO(tz);
      const todayStr = getTzDateStr(tz);
      const d = new Date(todayStr + "T12:00:00");
      const nextMonday = new Date(d.getTime() + ((8 - d.getDay()) % 7 || 7) * 86400000);
      const nextSunday = new Date(nextMonday.getTime() + 6 * 86400000);
      const mondayStr = `${nextMonday.getFullYear()}-${String(nextMonday.getMonth() + 1).padStart(2, "0")}-${String(nextMonday.getDate()).padStart(2, "0")}`;
      const sundayStr = `${nextSunday.getFullYear()}-${String(nextSunday.getMonth() + 1).padStart(2, "0")}-${String(nextSunday.getDate()).padStart(2, "0")}`;
      const { events } = await listAllEvents({
        timeMin: `${mondayStr}T00:00:00${offset}`,
        timeMax: `${sundayStr}T23:59:59${offset}`,
        maxResults: 50,
      });
      if (events.length === 0) return null;
      let totalHours = 0;
      const lines = events.map(e => {
        const date = e.start.dateTime ? new Date(e.start.dateTime).toLocaleDateString("en-US", { weekday: "short" }) : "All day";
        const time = e.start.dateTime ? new Date(e.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
        if (e.start.dateTime && e.end?.dateTime) {
          totalHours += (new Date(e.end.dateTime).getTime() - new Date(e.start.dateTime).getTime()) / 3600000;
        }
        return `- ${date} ${time}: ${e.summary || "(no title)"}`;
      });
      lines.unshift(`Total meeting hours: ~${Math.round(totalHours)}h`);
      return lines.join("\n");
    }, 8000),
    fetchWithTimeout("tasks", async () => {
      const { fileTaskStorage } = await import("./file-storage/tasks");
      const { formatDeadlineCompact, getDeadlineProximity } = await import("@shared/models/work");
      const readyTasks = await fileTaskStorage.getTasks({ status: "ready" });
      const top = readyTasks.slice(0, 15);
      if (top.length === 0) return null;
      let totalHours = 0;
      const lines = top.map(t => {
        const est = t.estimateLow != null && t.estimateHigh != null
          ? ` (~${((t.estimateLow + t.estimateHigh) / 2).toFixed(1)}h)`
          : '';
        let dl = '';
        if (t.deadline) {
          const prox = getDeadlineProximity(t.deadline);
          const compact = formatDeadlineCompact(t.deadline);
          dl = prox ? `, due ${compact} (${prox.label})` : `, due ${compact}`;
        }
        if (t.estimateLow != null && t.estimateHigh != null) {
          totalHours += (t.estimateLow + t.estimateHigh) / 2;
        }
        return `- [${t.priority}] ${t.title}${est}${dl}${t.projectId ? ` (project #${t.projectId})` : ""}`;
      });
      if (totalHours > 0) {
        lines.push("");
        lines.push(`Total estimated: ~${totalHours.toFixed(1)}h`);
      }
      return lines.join("\n");
    }),
    fetchWithTimeout("wellness", fetchWellnessStatus),
    fetchWithTimeout("people", async () => {
      const { peopleStorage, computeRollup, getDefaultCadence, computeDueStatus, computeAgendaSignals, computeMobilization } = await import("./people-storage");
      const allPeople = await peopleStorage.listPeople();
      const cabinetConfig = await peopleStorage.getCabinetConfig();
      const now = Date.now();

      const cabinetWeights: Record<string, number> = {};
      for (const level of cabinetConfig.levels) {
        cabinetWeights[level.id] = Math.max(1, 7 - level.order);
      }

      let upcomingAttendeeNames: Set<string> = new Set();
      try {
        const { listAllEvents } = await import("./google-calendar");
        const offset = getTzOffsetISO(tz);
        const todayStr = getTzDateStr(tz);
        const d = new Date(todayStr + "T12:00:00");
        const nextWeekEnd = new Date(d.getTime() + 7 * 86400000);
        const endStr = `${nextWeekEnd.getFullYear()}-${String(nextWeekEnd.getMonth() + 1).padStart(2, "0")}-${String(nextWeekEnd.getDate()).padStart(2, "0")}`;
        const { events } = await listAllEvents({
          timeMin: `${todayStr}T00:00:00${offset}`,
          timeMax: `${endStr}T23:59:59${offset}`,
          maxResults: 100,
        });
        for (const ev of events) {
          if (ev.attendees) {
            for (const a of ev.attendees) {
              if (a.displayName) upcomingAttendeeNames.add(a.displayName.toLowerCase());
              if (a.email) upcomingAttendeeNames.add(a.email.toLowerCase());
            }
          }
        }
      } catch {}


      const tierSummary: Record<string, { total: number; onTrack: number; due: number; drifting: number; urgent: number }> = {};
      const agingCommitments: string[] = [];
      const warmingCandidates: Array<{ name: string; reason: string; suggestedAction: string; score: number; mobilizationReady: boolean; hasUpcomingMeeting: boolean }> = [];

      const skipLevels2 = new Set(["self", "agent", "user"]);
      for (const entry of allPeople) {
        if (skipLevels2.has(entry.cabinetLevel)) continue;
        const person = await peopleStorage.getPerson(entry.id);
        if (!person) continue;

        const tier = person.cabinetLevel;
        if (!tierSummary[tier]) tierSummary[tier] = { total: 0, onTrack: 0, due: 0, drifting: 0, urgent: 0 };
        tierSummary[tier].total++;

        const cadence = person.relationshipProfile?.cadence || getDefaultCadence(tier);
        const rollup = computeRollup(person.interactions);
        const dueStatus = computeDueStatus(rollup, cadence, person);
        const statusKey = dueStatus === "on_track" ? "onTrack" : dueStatus;
        tierSummary[tier][statusKey]++;

        const openCommitments = person.networkProfile?.commitments?.filter(c => c.status === "open") || [];
        for (const c of openCommitments) {
          const age = Math.floor((now - new Date(c.createdAt).getTime()) / 86400000);
          if (age > 14) {
            agingCommitments.push(`- ${person.name}: "${c.description}" (${c.direction === "from_ray" ? "Ray promised" : "they offered"}, ${age}d old)`);
          }
        }

        const agendaItem = computeAgendaSignals(person, cabinetWeights, now);
        if (agendaItem && agendaItem.bucket === "invest") {
          const mob = computeMobilization(person);
          const nameLower = person.name.toLowerCase();
          const personEmails = person.contactInfo
            .filter(c => c.type === "email")
            .map(c => c.value.toLowerCase());
          const hasUpcomingMeeting = upcomingAttendeeNames.has(nameLower) ||
            personEmails.some(e => upcomingAttendeeNames.has(e));
          const calScore = hasUpcomingMeeting ? agendaItem.score + 30 : agendaItem.score;
          warmingCandidates.push({
            name: person.name,
            reason: agendaItem.reason,
            suggestedAction: hasUpcomingMeeting ? "Warm before upcoming meeting" : agendaItem.suggestedAction,
            score: calScore,
            mobilizationReady: mob.ready,
            hasUpcomingMeeting,
          });
        }
      }

      const parts: string[] = [];
      parts.push("**Health by Tier:**");
      for (const [tier, stats] of Object.entries(tierSummary)) {
        const issues: string[] = [];
        if (stats.drifting > 0) issues.push(`${stats.drifting} drifting`);
        if (stats.urgent > 0) issues.push(`${stats.urgent} urgent`);
        if (stats.due > 0) issues.push(`${stats.due} due`);
        parts.push(`- ${tier}: ${issues.length > 0 ? issues.join(", ") : "all on track"} (${stats.total} total)`);
      }

      if (agingCommitments.length > 0) {
        parts.push("");
        parts.push("**Aging Commitments (>14d):**");
        parts.push(...agingCommitments.slice(0, 5));
      }

      if (warmingCandidates.length > 0) {
        warmingCandidates.sort((a, b) => b.score - a.score);
        parts.push("");
        parts.push("**Strategic Warming Recommendations:**");
        for (const c of warmingCandidates.slice(0, 5)) {
          const mobNote = c.mobilizationReady ? "mobilization-ready" : "needs warming first";
          const calNote = c.hasUpcomingMeeting ? ", upcoming meeting this week" : "";
          parts.push(`- ${c.name}: ${c.reason} → ${c.suggestedAction} (${mobNote}${calNote})`);
        }
      }

      return parts.join("\n");
    }),
  ];

  const settled = await Promise.race([
    Promise.allSettled(sourceFetchers),
    new Promise<PromiseSettledResult<SourceResult>[]>((resolve) =>
      setTimeout(() => resolve(sourceNames.map(() => ({
        status: "rejected" as const,
        reason: "master timeout",
      }))), MASTER_TIMEOUT)
    ),
  ]);

  const results: SourceResult[] = settled.map(s =>
    s.status === "fulfilled" ? s.value : { data: null, failed: true }
  );

  const sectionTitles: Record<string, string> = {
    weekly_priorities: "This Week's Priority Scorecard",
    monthly_priorities: "Monthly Priorities (Alignment Target)",
    daily_reviews: "Daily Reviews This Week",
    next_week_calendar: "Next Week's Calendar",
    tasks: "Active Tasks",
    wellness: "Wellness Activities",
    people: "Relationship Health",
  };

  let successCount = 0;
  for (let i = 0; i < sourceNames.length; i++) {
    const name = sourceNames[i];
    const result = results[i];
    if (!result.failed && result.data) {
      sections.push(`\n## ${sectionTitles[name]}\n\n${result.data}`);
      successCount++;
    }
  }

  const elapsed = Date.now() - startTime;
  planLog.log(`Weekly planning preContext built: ${successCount}/${sourceNames.length} sources in ${elapsed}ms`);

  return successCount > 0 ? { preContext: sections.join("\n") } : null;
}

export async function buildMonthlyPlanningPreContext(): Promise<{ preContext: string } | null> {
  const planLog = createLogger("MonthlyPlanning");
  const startTime = Date.now();
  planLog.log("Building monthly planning preContext");

  const tz = getTimezone();
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "long", day: "numeric" }).format(now);
  const monthName = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", year: "numeric" }).format(now);

  const MASTER_TIMEOUT = 35_000;
  const sections: string[] = [];
  sections.push(`# Monthly Planning — ${dateStr}`);

  const sourceNames = ["monthly_priorities", "quarterly_goals", "projects", "next_month_calendar", "wellness"] as const;
  const sourceFetchers: Promise<SourceResult>[] = [
    fetchWithTimeout("monthly_priorities", async () => {
      const { goalsService } = await import("./goals-service");
      const todayStr = getTzDateStr(tz);
      const d = new Date(todayStr + "T12:00:00");
      const firstOfMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
      const priorities = await goalsService.listPrioritiesForPeriod("this_month", firstOfMonth);
      if (!priorities.length) return null;
      return priorities.map((p: { title: string; urgency?: string }) => `- ${p.title}${p.urgency ? ` (${p.urgency})` : ""}`).join("\n");
    }),
    fetchWithTimeout("quarterly_goals", async () => {
      const { goalsService: goalsServiceQ } = await import("./goals-service");
      const goals = await goalsServiceQ.listAll();
      const quarterly = goals.filter(g => ((g.horizon as string) === "quarter" || (g.horizon as string) === "quarterly") && (g.status === "active" || g.status === "on_track"));
      if (quarterly.length === 0) return null;
      return quarterly.map(g => `- [${g.status}] ${g.shortName}`).join("\n");
    }),
    fetchWithTimeout("projects", async () => {
      const { fileTaskStorage } = await import("./file-storage/tasks");
      const { fileProjectStorage } = await import("./file-storage/projects");
      const projects = await fileProjectStorage.getProjects();
      const activeProjects = projects.filter(p => p.status === "active");
      if (activeProjects.length === 0) return null;
      const lines: string[] = [];
      for (const p of activeProjects.slice(0, 10)) {
        const tasks = await fileTaskStorage.getTasks({ projectId: p.id });
        const readyCount = tasks.filter(t => t.status === "ready").length;
        const doneCount = tasks.filter(t => t.status === "done").length;
        lines.push(`- ${(p as any).name} (${readyCount} ready, ${doneCount} done, ${tasks.length} total)`);
      }
      return lines.join("\n");
    }, 8000),
    fetchWithTimeout("next_month_calendar", async () => {
      const { listAllEvents } = await import("./google-calendar");
      const offset = getTzOffsetISO(tz);
      const todayStr = getTzDateStr(tz);
      const d = new Date(todayStr + "T12:00:00");
      const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const endNextMonth = new Date(d.getFullYear(), d.getMonth() + 2, 0);
      const startStr = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
      const endStr = `${endNextMonth.getFullYear()}-${String(endNextMonth.getMonth() + 1).padStart(2, "0")}-${String(endNextMonth.getDate()).padStart(2, "0")}`;
      const { events } = await listAllEvents({
        timeMin: `${startStr}T00:00:00${offset}`,
        timeMax: `${endStr}T23:59:59${offset}`,
        maxResults: 50,
      });
      if (events.length === 0) return null;

      const weekdays = new Set<string>();
      for (let day = new Date(nextMonth); day <= endNextMonth; day.setDate(day.getDate() + 1)) {
        const dow = day.getDay();
        if (dow !== 0 && dow !== 6) weekdays.add(day.toISOString().split("T")[0]);
      }
      const workingDays = weekdays.size;

      let totalMeetingHours = 0;
      for (const e of events) {
        if (e.start.dateTime && e.end?.dateTime) {
          totalMeetingHours += (new Date(e.end.dateTime).getTime() - new Date(e.start.dateTime).getTime()) / 3600000;
        }
      }
      const availableHours = workingDays * 8 - Math.round(totalMeetingHours);

      return `Working days: ${workingDays}\nScheduled meeting hours: ~${Math.round(totalMeetingHours)}h\nAvailable deep work hours: ~${availableHours}h\nEvents: ${events.length} scheduled`;
    }, 8000),
    fetchWithTimeout("wellness", fetchWellnessStatus),
  ];

  const settled = await Promise.race([
    Promise.allSettled(sourceFetchers),
    new Promise<PromiseSettledResult<SourceResult>[]>((resolve) =>
      setTimeout(() => resolve(sourceNames.map(() => ({
        status: "rejected" as const,
        reason: "master timeout",
      }))), MASTER_TIMEOUT)
    ),
  ]);

  const results: SourceResult[] = settled.map(s =>
    s.status === "fulfilled" ? s.value : { data: null, failed: true }
  );

  const sectionTitles: Record<string, string> = {
    monthly_priorities: `${monthName} Priorities`,
    quarterly_goals: "Quarterly Goals (Alignment Target)",
    projects: "Active Projects (with task counts)",
    next_month_calendar: "Next Month Capacity",
    wellness: "Wellness Activities",
  };

  let successCount = 0;
  for (let i = 0; i < sourceNames.length; i++) {
    const name = sourceNames[i];
    const result = results[i];
    if (!result.failed && result.data) {
      sections.push(`\n## ${sectionTitles[name]}\n\n${result.data}`);
      successCount++;
    }
  }

  const elapsed = Date.now() - startTime;
  planLog.log(`Monthly planning preContext built: ${successCount}/${sourceNames.length} sources in ${elapsed}ms`);

  return successCount > 0 ? { preContext: sections.join("\n") } : null;
}

