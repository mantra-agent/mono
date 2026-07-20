import { db } from "./db";
import { setSetting, getSettings } from "./system-settings";
import { getTimezone } from "./timezone";
import { sanitizeSummary } from "./utils/sanitize-summary";
import { userDateStr, userNoon } from "./utils/user-time";
import { createLogger } from "./log";
import { getCurrentPrincipal, getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope } from "./scoped-storage";

const log = createLogger("TemporalLog");
async function visibleLibraryPredicate(predicate: import("drizzle-orm").SQL): Promise<import("drizzle-orm").SQL> {
  const { libraryPages } = await import("@shared/models/info");
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), {
    scope: libraryPages.scope,
    ownerUserId: libraryPages.ownerUserId,
    accountId: libraryPages.accountId,
    vaultId: libraryPages.vaultId,
  }, predicate);
}


// --- Primary user cache for system-context fallback ---
let cachedPrimaryUserId: string | null = null;

async function resolvePrimaryUserId(): Promise<string> {
  if (cachedPrimaryUserId) return cachedPrimaryUserId;
  try {
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1);
    if (rows[0]) {
      cachedPrimaryUserId = rows[0].id;
      return cachedPrimaryUserId;
    }
  } catch (err: unknown) {
    log.warn(`resolvePrimaryUserId failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return "primary";
}

async function resolveTemporalUserId(): Promise<string> {
  const principal = getCurrentPrincipal();
  if (principal?.userId) return principal.userId;
  return resolvePrimaryUserId();
}

export const LAYER_IDS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "this_life",
] as const;

export type TemporalLayerId = (typeof LAYER_IDS)[number];

export interface TemporalLayer {
  content: string;
  updatedAt: string;
  sourceRef: string | null;
}

export const TOKEN_BUDGETS: Record<TemporalLayerId, number> = {
  today: 200,
  yesterday: 150,
  this_week: 150,
  last_week: 100,
  this_month: 100,
  last_month: 100,
  this_quarter: 125,
  last_quarter: 150,
  this_year: 125,
  last_year: 150,
  this_life: 200,
};

const APPROX_CHARS_PER_TOKEN = 4;

function settingKey(layerId: TemporalLayerId, userId: string): string {
  return `memory.temporal_log.${userId}.${layerId}`;
}

function truncateToBudget(content: string, layerId: TemporalLayerId): string {
  const maxChars = TOKEN_BUDGETS[layerId] * APPROX_CHARS_PER_TOKEN;
  if (content.length <= maxChars) return content;
  return content.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function fmtDate(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: getTimezone(), ...opts }).format(d);
}

function startOfDayInTz(d: Date): Date {
  // TZ-safe: subtract the seconds-since-midnight that `d` represents in the
  // user's timezone to land on the start-of-day instant in that TZ.
  const tz = getTimezone();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  let h = get("hour");
  if (h === 24) h = 0;
  const secs = h * 3600 + get("minute") * 60 + get("second");
  return new Date(d.getTime() - secs * 1000);
}

/**
 * Returns a Date instant that lands on the user-tz local calendar day
 * `days` away from the local day containing `now`. Uses calendar
 * arithmetic (not raw 24h math) so it's correct across DST transitions.
 * The returned instant is at noon of that local day, which is safe for
 * formatting via `fmtDate` (no risk of straddling midnight).
 */
function shiftDaysInTz(now: Date, days: number): Date {
  const todayStr = userDateStr(now);
  const [y, m, d] = todayStr.split("-").map(Number);
  const cal = new Date(Date.UTC(y, m - 1, d + days));
  const shiftedStr = `${cal.getUTCFullYear()}-${String(cal.getUTCMonth() + 1).padStart(2, "0")}-${String(cal.getUTCDate()).padStart(2, "0")}`;
  return userNoon(shiftedStr);
}

function getTodayTitle(now: Date): string {
  // Anchor on noon of today's local date so the formatted date matches the
  // user's calendar even if the server clock is in a different timezone.
  const todayLocal = userNoon(userDateStr(now));
  return `Today (${fmtDate(todayLocal, { month: "short", day: "numeric" })})`;
}

function getYesterdayTitle(now: Date): string {
  const y = shiftDaysInTz(now, -1);
  return `Yesterday (${fmtDate(y, { month: "short", day: "numeric" })})`;
}

function getThisWeekTitle(now: Date): string {
  const tz = getTimezone();
  const dow = new Date(now.toLocaleString("en-US", { timeZone: tz })).getDay();
  const monOffset = dow === 0 ? 6 : dow - 1;
  const monday = shiftDaysInTz(now, -monOffset);
  const todayLocal = userNoon(userDateStr(now));
  return `This Week (${fmtDate(monday, { month: "short", day: "numeric" })}-${fmtDate(todayLocal, { month: "short", day: "numeric" })})`;
}

function getLastWeekTitle(now: Date): string {
  const tz = getTimezone();
  const dow = new Date(now.toLocaleString("en-US", { timeZone: tz })).getDay();
  const monOffset = dow === 0 ? 6 : dow - 1;
  const lastMon = shiftDaysInTz(now, -monOffset - 7);
  const lastSun = shiftDaysInTz(now, -monOffset - 1);
  return `Last Week (${fmtDate(lastMon, { month: "short", day: "numeric" })}-${fmtDate(lastSun, { month: "short", day: "numeric" })})`;
}

function getThisMonthTitle(now: Date): string {
  return `This Month (${fmtDate(now, { month: "long" })})`;
}

function getLastMonthTitle(now: Date): string {
  const lastMonth = new Date(now);
  lastMonth.setDate(0);
  return `Last Month (${fmtDate(lastMonth, { month: "long" })})`;
}

function getQuarter(d: Date): number {
  const m = Number(fmtDate(d, { month: "numeric" }));
  return Math.floor((m - 1) / 3) + 1;
}

function getThisQuarterTitle(now: Date): string {
  return `This Quarter (Q${getQuarter(now)} ${fmtDate(now, { year: "numeric" })})`;
}

function getLastQuarterTitle(now: Date): string {
  const q = getQuarter(now);
  const year = Number(fmtDate(now, { year: "numeric" }));
  if (q === 1) return `Last Quarter (Q4 ${year - 1})`;
  return `Last Quarter (Q${q - 1} ${year})`;
}

function getThisYearTitle(now: Date): string {
  return `This Year (${fmtDate(now, { year: "numeric" })})`;
}

function getLastYearTitle(now: Date): string {
  const year = Number(fmtDate(now, { year: "numeric" }));
  return `Last Year (${year - 1})`;
}

const LAYER_TITLE_FNS: Record<TemporalLayerId, (now: Date) => string> = {
  today: getTodayTitle,
  yesterday: getYesterdayTitle,
  this_week: getThisWeekTitle,
  last_week: getLastWeekTitle,
  this_month: getThisMonthTitle,
  last_month: getLastMonthTitle,
  this_quarter: getThisQuarterTitle,
  last_quarter: getLastQuarterTitle,
  this_year: getThisYearTitle,
  last_year: getLastYearTitle,
  this_life: () => "This Life",
};

export async function writeLayer(
  layerId: TemporalLayerId,
  content: string,
  sourceRef: string | null = null,
): Promise<void> {
  const trimmed = (content || "").trim();
  if (!trimmed) return;
  const truncated = truncateToBudget(trimmed, layerId);
  const layer: TemporalLayer = {
    content: truncated,
    updatedAt: new Date().toISOString(),
    sourceRef,
  };
  try {
    const userId = await resolveTemporalUserId();
    await setSetting(settingKey(layerId, userId), layer);
  } catch (err: unknown) {
    log.warn(`writeLayer(${layerId}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function clearLayer(layerId: TemporalLayerId, sourceRef: string | null = null): Promise<void> {
  const layer: TemporalLayer = {
    content: "",
    updatedAt: new Date().toISOString(),
    sourceRef,
  };
  try {
    const userId = await resolveTemporalUserId();
    await setSetting(settingKey(layerId, userId), layer);
  } catch (err: unknown) {
    log.warn(`clearLayer(${layerId}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isSameDayInTz(a: Date, b: Date): boolean {
  const tz = getTimezone();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(a) === fmt.format(b);
}

function isTemporalLayer(value: unknown): value is TemporalLayer {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.content === "string" && typeof v.updatedAt === "string";
}

function toDate(value: Date | string | number | null | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return new Date(NaN);
}

export async function readAllLayers(): Promise<Map<TemporalLayerId, TemporalLayer>> {
  const result = new Map<TemporalLayerId, TemporalLayer>();
  try {
    const userId = await resolveTemporalUserId();
    const keys = LAYER_IDS.map((id) => settingKey(id, userId));
    const map = await getSettings(keys);
    for (const id of LAYER_IDS) {
      const raw = map.get(settingKey(id, userId));
      if (isTemporalLayer(raw)) {
        result.set(id, raw);
      }
    }
  } catch (err: unknown) {
    log.warn(`readAllLayers failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

export async function assembleTemporalLog(): Promise<string> {
  const layers = await readAllLayers();
  if (layers.size === 0) return "";
  const now = new Date();
  const sections: string[] = [];
  for (const id of LAYER_IDS) {
    const layer = layers.get(id);
    if (!layer || !layer.content.trim()) continue;
    const title = LAYER_TITLE_FNS[id](now);
    sections.push(`### ${title}\n${layer.content.trim()}`);
  }
  return sections.join("\n\n");
}

export async function updateTodayLayer(): Promise<void> {
  // Retired with the legacy memory reader exit. Today/period layers are now
  // written directly from review artifacts through write*TemporalLayers(), and
  // context activity counts come from the neutral EventBus rather than
  // memory_entries-backed mid-layer summaries. Archived memory rows remain
  // untouched.
  log.debug("updateTodayLayer skipped: legacy memory_entries temporal summary retired");
}

/**
 * Strip leading prose that appears before the first `##` heading. If the
 * output contains any `##` heading, drop everything before it. Used to clean
 * up reasoning prose that some models emit before their first heading.
 *
 * If there is no `##` heading, the original output is returned unchanged so
 * that callers that expect prose continue to work.
 */
export function stripLeadingProse(output: string): string {
  if (!output) return "";
  const trimmed = output.trim();
  const idx = trimmed.search(/(?:^|\n)##\s+/);
  if (idx < 0) return trimmed;
  // Drop everything before the first `##` heading and return from the heading on.
  // Handle the case where the heading is at position 0.
  const sliced = trimmed.slice(idx);
  return sliced.replace(/^\n+/, "");
}

export function extractSummaryFromOutput(output: string): string {
  if (!output) return "";
  const cleaned = stripLeadingProse(output);
  const match = cleaned.match(/(?:^|\n)##\s+Summary\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  // Fail safe: if no `## Summary` block is present, return empty rather than
  // silently capturing whatever prose preceded the (missing) heading. An
  // empty layer is strictly better than a layer full of reasoning artifacts.
  return "";
}

export function extractSectionFromOutput(output: string, heading: string): string {
  if (!output) return "";
  const cleaned = stripLeadingProse(output);
  // Escape regex metacharacters in heading.
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|\\n#\\s+|$)`, "i");
  const match = cleaned.match(re);
  if (match && match[1]) {
    return match[1].trim();
  }
  return "";
}

async function aggregateThisWeekFromDailyReviews(excludeYesterday: boolean, excludeToday: boolean): Promise<string> {
  try {
    const { resolveLibraryParent } = await import("./library-index");
    const parentId = await resolveLibraryParent("daily-reviews");
    if (!parentId) return "";
    const { libraryPages } = await import("@shared/models/info");
    const { eq, desc } = await import("drizzle-orm");
    const pages = await db
      .select({ title: libraryPages.title, plainTextContent: libraryPages.plainTextContent, createdAt: libraryPages.createdAt })
      .from(libraryPages)
      .where(await visibleLibraryPredicate(eq(libraryPages.parentId, parentId)))
      .orderBy(desc(libraryPages.createdAt))
      .limit(7);

    const now = new Date();
    const tz = getTimezone();
    const dow = new Date(now.toLocaleString("en-US", { timeZone: tz })).getDay();
    const monOffset = dow === 0 ? 6 : dow - 1;
    const weekStart = startOfDayInTz(new Date(now.getTime() - monOffset * 24 * 60 * 60 * 1000)).getTime();
    const todayStart = startOfDayInTz(now).getTime();
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

    const lines: string[] = [];
    for (const p of pages) {
      const ts = toDate(p.createdAt).getTime();
      if (ts < weekStart) continue;
      if (excludeToday && ts >= todayStart) continue;
      if (excludeYesterday && ts >= yesterdayStart && ts < todayStart) continue;
      const summary = extractSummaryFromOutput(p.plainTextContent || "");
      if (summary) {
        const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ts));
        lines.push(`- ${day}: ${summary.split(/\n+/)[0].slice(0, 200)}`);
      }
    }
    return lines.join("\n");
  } catch (err: unknown) {
    log.warn(`aggregateThisWeekFromDailyReviews failed: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

async function aggregateThisMonthFromWeekly(excludeCurrentWeek: boolean, excludeLastWeek: boolean): Promise<string> {
  try {
    const { resolveLibraryParent } = await import("./library-index");
    const parentId = await resolveLibraryParent("weekly-reflections");
    if (!parentId) return "";
    const { libraryPages } = await import("@shared/models/info");
    const { eq, desc } = await import("drizzle-orm");
    const pages = await db
      .select({ title: libraryPages.title, plainTextContent: libraryPages.plainTextContent, createdAt: libraryPages.createdAt })
      .from(libraryPages)
      .where(await visibleLibraryPredicate(eq(libraryPages.parentId, parentId)))
      .orderBy(desc(libraryPages.createdAt))
      .limit(6);

    const now = new Date();
    const tz = getTimezone();
    const monthStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(now);

    const dow = new Date(now.toLocaleString("en-US", { timeZone: tz })).getDay();
    const monOffset = dow === 0 ? 6 : dow - 1;
    const thisMonStart = startOfDayInTz(new Date(now.getTime() - monOffset * 24 * 60 * 60 * 1000)).getTime();
    const lastMonStart = thisMonStart - 7 * 24 * 60 * 60 * 1000;

    const lines: string[] = [];
    for (const p of pages) {
      const created = toDate(p.createdAt);
      const pageMonth = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(created);
      if (pageMonth !== monthStr) continue;
      const ts = created.getTime();
      if (excludeCurrentWeek && ts >= thisMonStart) continue;
      if (excludeLastWeek && ts >= lastMonStart && ts < thisMonStart) continue;
      const summary = extractSummaryFromOutput(p.plainTextContent || "");
      if (summary) {
        const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(created);
        lines.push(`- Week of ${label}: ${summary.split(/\n+/)[0].slice(0, 220)}`);
      }
    }
    return lines.join("\n");
  } catch (err: unknown) {
    log.warn(`aggregateThisMonthFromWeekly failed: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

function todayDateRef(): string {
  const tz = getTimezone();
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function latestLibraryPageRef(parentSlug: string): Promise<string | null> {
  const info = await latestLibraryPageInfo(parentSlug);
  if (!info) return null;
  return `library:${parentSlug}/${info.id}${info.slug ? `:${info.slug}` : ""}`;
}

async function latestLibraryPageInfo(
  parentSlug: string,
): Promise<{ id: string; slug: string | null; createdAt: Date } | null> {
  try {
    const { resolveLibraryParent } = await import("./library-index");
    const parentId = await resolveLibraryParent(parentSlug);
    if (!parentId) return null;
    const { libraryPages } = await import("@shared/models/info");
    const { eq, desc } = await import("drizzle-orm");
    const rows = await db
      .select({ id: libraryPages.id, slug: libraryPages.slug, createdAt: libraryPages.createdAt })
      .from(libraryPages)
      .where(await visibleLibraryPredicate(eq(libraryPages.parentId, parentId)))
      .orderBy(desc(libraryPages.createdAt))
      .limit(1);
    const page = rows[0];
    if (!page) return null;
    return { id: page.id, slug: page.slug ?? null, createdAt: toDate(page.createdAt) };
  } catch (err: unknown) {
    log.warn(`latestLibraryPageInfo(${parentSlug}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function aggregateThisQuarterFromMonthly(): Promise<string> {
  // Current quarter monthly reflections, excluding last 2 months (in last_month/this_month).
  try {
    const { resolveLibraryParent } = await import("./library-index");
    const parentId = await resolveLibraryParent("monthly-reflections");
    if (!parentId) return "";
    const { libraryPages } = await import("@shared/models/info");
    const { eq, desc } = await import("drizzle-orm");
    const pages = await db
      .select({ title: libraryPages.title, plainTextContent: libraryPages.plainTextContent, createdAt: libraryPages.createdAt })
      .from(libraryPages)
      .where(await visibleLibraryPredicate(eq(libraryPages.parentId, parentId)))
      .orderBy(desc(libraryPages.createdAt))
      .limit(6);

    const now = new Date();
    const tz = getTimezone();
    const currentQuarter = getQuarter(now);
    const currentYear = Number(fmtDate(now, { year: "numeric" }));

    const monthKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(d);
    const lastMonthDate = new Date(now);
    lastMonthDate.setDate(0);
    const excludedMonths = new Set([monthKey(now), monthKey(lastMonthDate)]);

    const lines: string[] = [];
    for (const p of pages) {
      const created = toDate(p.createdAt);
      const pageYear = Number(fmtDate(created, { year: "numeric" }));
      const pageQuarter = getQuarter(created);
      if (pageYear !== currentYear || pageQuarter !== currentQuarter) continue;
      if (excludedMonths.has(monthKey(created))) continue;
      const summary = extractSummaryFromOutput(p.plainTextContent || "");
      if (summary) {
        const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long" }).format(created);
        lines.push(`- ${label}: ${summary.split(/\n+/)[0].slice(0, 220)}`);
      }
    }
    return lines.join("\n");
  } catch (err: unknown) {
    log.warn(`aggregateThisQuarterFromMonthly failed: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

export async function writeDailyTemporalLayers(
  skillOutput: string,
  sourceRef?: string | null,
): Promise<void> {
  try {
    // Resolve the latest daily-review Library page (with its createdAt) so we
    // can route the summary to the correct single-day layer based on what
    // local calendar day the review actually covers.
    const pageInfo = await latestLibraryPageInfo("daily-reviews");
    const ref = sourceRef
      ?? (pageInfo ? `library:daily-reviews/${pageInfo.id}${pageInfo.slug ? `:${pageInfo.slug}` : ""}` : `library:daily-reviews/${todayDateRef()}`);

    const summary = extractSummaryFromOutput(skillOutput);
    if (summary) {
      const now = new Date();
      const reviewDate = pageInfo ? pageInfo.createdAt : now;
      const todayLocal = userDateStr(now);
      const reviewLocal = userDateStr(reviewDate);
      const yesterdayLocal = userDateStr(shiftDaysInTz(now, -1));

      if (reviewLocal === todayLocal) {
        // Review is for today's local date — write to today.
        await writeLayer("today", summary, ref);
        // If yesterday's layer was populated by a previous run of this same
        // daily review (e.g. before the bucket fix landed), clear it so the
        // same content doesn't appear under both Today and Yesterday.
        const layers = await readAllLayers();
        const yLayer = layers.get("yesterday");
        if (yLayer && yLayer.content.trim() && yLayer.sourceRef === ref) {
          await clearLayer("yesterday", ref);
        }
      } else if (reviewLocal === yesterdayLocal) {
        // Morning-after case: review is for yesterday's local date.
        await writeLayer("yesterday", summary, ref);
        // If today's layer somehow holds the same daily-review content
        // (e.g. it was written late last night and the local day rolled
        // over before the next run), clear it.
        const layers = await readAllLayers();
        const tLayer = layers.get("today");
        if (tLayer && tLayer.content.trim() && tLayer.sourceRef === ref) {
          await clearLayer("today", ref);
        }
      } else {
        // Older than yesterday in the user's local calendar — skip the
        // single-day layers; this content should already be summarized into
        // the weekly aggregate below.
        log.debug(`writeDailyTemporalLayers: skipping single-day layer write — reviewLocal=${reviewLocal} todayLocal=${todayLocal}`);
      }
    }
    const thisWeek = await aggregateThisWeekFromDailyReviews(true, true);
    if (thisWeek) {
      await writeLayer("this_week", thisWeek, ref);
    }
  } catch (err: unknown) {
    log.warn(`writeDailyTemporalLayers failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function writeWeeklyTemporalLayers(
  skillOutput: string,
  sourceRef?: string | null,
): Promise<void> {
  try {
    const ref = sourceRef ?? (await latestLibraryPageRef("weekly-reflections")) ?? `library:weekly-reflections/${todayDateRef()}`;
    const summary = extractSummaryFromOutput(skillOutput);
    if (summary) {
      await writeLayer("last_week", summary, ref);
    }
    const thisMonth = await aggregateThisMonthFromWeekly(true, true);
    if (thisMonth) {
      await writeLayer("this_month", thisMonth, ref);
    }
  } catch (err: unknown) {
    log.warn(`writeWeeklyTemporalLayers failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function writeMonthlyTemporalLayers(
  skillOutput: string,
  sourceRef?: string | null,
): Promise<void> {
  try {
    const ref = sourceRef ?? (await latestLibraryPageRef("monthly-reflections")) ?? `library:monthly-reflections/${todayDateRef()}`;
    const summary = extractSummaryFromOutput(skillOutput);
    if (summary) {
      await writeLayer("last_month", summary, ref);
    }
    const thisQuarter = await aggregateThisQuarterFromMonthly();
    if (thisQuarter) {
      await writeLayer("this_quarter", thisQuarter, ref);
    }
  } catch (err: unknown) {
    log.warn(`writeMonthlyTemporalLayers failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function writeQuarterlyTemporalLayers(
  skillOutput: string,
  sourceRef?: string | null,
): Promise<void> {
  try {
    const ref = sourceRef ?? (await latestLibraryPageRef("quarterly-reflections")) ?? `library:quarterly-reflections/${todayDateRef()}`;
    const summary = extractSummaryFromOutput(skillOutput);
    if (summary) {
      await writeLayer("last_quarter", summary, ref);
    }
    const thisQuarter = await aggregateThisQuarterFromMonthly();
    if (thisQuarter) {
      await writeLayer("this_quarter", thisQuarter, ref);
    }
  } catch (err: unknown) {
    log.warn(`writeQuarterlyTemporalLayers failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function writeAnnualTemporalLayers(
  skillOutput: string,
  sourceRef?: string | null,
): Promise<void> {
  try {
    const ref = sourceRef ?? (await latestLibraryPageRef("annual-reflections")) ?? `library:annual-reflections/${todayDateRef()}`;
    const summary = extractSummaryFromOutput(skillOutput);
    const explicitThisLife = extractSectionFromOutput(skillOutput, "This Life");
    const explicitThisYear = extractSectionFromOutput(skillOutput, "This Year");

    if (!summary) {
      return;
    }

    // The year being reflected on is now closed — its summary becomes Last Year.
    await writeLayer("last_year", summary, ref);

    // This Year: when the annual skill provides an explicit "## This Year"
    // section, persist it. Otherwise clear so the new year starts fresh and
    // is rebuilt by subsequent monthly/quarterly reflections.
    if (explicitThisYear) {
      await writeLayer("this_year", explicitThisYear, ref);
    } else {
      await clearLayer("this_year", ref);
    }

    // This Life: prefer an explicit lifetime arc authored by the annual skill.
    // Fall back to a rolling cascade so the layer is never empty if the skill
    // omits the section.
    if (explicitThisLife) {
      await writeLayer("this_life", explicitThisLife, ref);
    } else {
      const layers = await readAllLayers();
      const priorLife = layers.get("this_life")?.content?.trim() ?? "";
      const fragments: string[] = [];
      if (priorLife) fragments.push(priorLife);
      if (summary) {
        fragments.push(`- Earlier: ${summary.split(/\n+/)[0].slice(0, 200)}`);
      }
      const lifeContent = fragments.join("\n") || `- ${summary.split(/\n+/)[0].slice(0, 200)}`;
      await writeLayer("this_life", lifeContent, "temporal-log:cascade");
    }
  } catch (err: unknown) {
    log.warn(`writeAnnualTemporalLayers failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export { settingKey as temporalLogSettingKey };
