import type { SimpleFeed, SimpleFeedItem, SimpleFeedSection, SimpleSection } from "@shared/models/simple";
import { SIMPLE_SECTIONS } from "@shared/models/simple";
import { createLogger } from "../log";
import { chatCompletion } from "../model-client";
import { ACTIVITY_FRAMING } from "../job-profiles";
import { collectSimpleContext, type SimpleContextBundle } from "./collectors";
import { validateSimpleFeed } from "./schema";

const log = createLogger("SimpleFeed");
const feedCache = new Map<string, SimpleFeed>();
const feedGeneration = new Map<string, number>();
const inFlightFeeds = new Map<string, Promise<SimpleFeed>>();

function feedLocalDate(feed: SimpleFeed): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: feed.timezone || "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(feed.generatedAt));
}

function isCachedFeedCurrent(feed: SimpleFeed): boolean {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: feed.timezone || "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return feedLocalDate(feed) === today;
}

export function invalidateSimpleFeedCache(accountId?: string): void {
  if (accountId) {
    feedCache.delete(accountId);
    feedGeneration.set(accountId, (feedGeneration.get(accountId) || 0) + 1);
    return;
  }
  feedCache.clear();
  for (const key of feedGeneration.keys()) {
    feedGeneration.set(key, (feedGeneration.get(key) || 0) + 1);
  }
}

function localMinutesFromIso(value: string | undefined, timezone: string): number | null {
  if (!value) return null;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(time);
  const hour = Number(parts.find(part => part.type === "hour")?.value ?? NaN);
  const minute = Number(parts.find(part => part.type === "minute")?.value ?? NaN);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function localMinutesFromLabel(value: string | undefined): number | null {
  if (!value || value === "All day") return null;
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3].toUpperCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (meridiem === "PM" && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

function itemChronologicalMinute(item: SimpleFeedItem, timezone: string): number | null {
  return localMinutesFromIso(item.anchorTime, timezone)
    ?? localMinutesFromIso(item.actionTime, timezone)
    ?? localMinutesFromLabel(item.time);
}

function inboxAddedMs(item: SimpleFeedItem): number {
  const value = typeof item.payload?.inboxAddedAt === "string"
    ? item.payload.inboxAddedAt
    : item.anchorTime ?? item.actionTime;
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : 0;
}

function isGoalItem(item: SimpleFeedItem): boolean {
  return item.payload?.kind === "goal" || item.sourceRefs?.some(ref => ref.type === "goal") === true;
}

function sortSectionItems(a: SimpleFeedItem, b: SimpleFeedItem, timezone: string): number {
  if (a.section === "inbox" && b.section === "inbox") {
    return inboxAddedMs(b) - inboxAddedMs(a) || (a.priority ?? 100) - (b.priority ?? 100);
  }

  // Goals are the planning headline for every temporal cadence. Keep them above
  // meetings, tasks, projects, wellness, and ambient state even when those items
  // have concrete timestamps.
  const aIsGoal = isGoalItem(a);
  const bIsGoal = isGoalItem(b);
  if (aIsGoal !== bIsGoal) return aIsGoal ? -1 : 1;

  // Date-level sort first — items on different dates sort chronologically
  const aDate = (a.actionTime ?? a.anchorTime ?? "").slice(0, 10);
  const bDate = (b.actionTime ?? b.anchorTime ?? "").slice(0, 10);
  if (aDate && bDate && aDate !== bDate) return aDate < bDate ? -1 : 1;

  // Same date or missing dates: time-of-day sort
  const aMinute = itemChronologicalMinute(a, timezone);
  const bMinute = itemChronologicalMinute(b, timezone);
  if (aMinute != null && bMinute != null && aMinute !== bMinute) return aMinute - bMinute;
  if (aMinute != null && bMinute == null) return -1;
  if (aMinute == null && bMinute != null) return 1;
  return (a.priority ?? 100) - (b.priority ?? 100);
}

function currentHourInTimezone(timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find(p => p.type === "hour")?.value ?? "12");
}

function weeklyMondayDateKey(timezone: string, weekOffsetDays = 0): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const local = new Date(`${parts}T12:00:00`);
  const day = local.getDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(local.getFullYear(), local.getMonth(), local.getDate() - daysSinceMonday + weekOffsetDays);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
}

/** Map of section → { periodType, dateKeyFn, artifactField, skillName } */
const PLAN_ARTIFACT_CONFIG: Record<string, {
  periodType: "daily" | "weekly" | "monthly" | "quarterly";
  artifactField: "dailyPlanPageId" | "weeklyPlanPageId" | "monthlyPlanPageId" | "quarterlyPlanPageId";
  skillName: "plan";
  planCadence: "daily" | "weekly" | "monthly" | "quarterly";
  dateKey: (tz: string) => string;
}> = {
  now: {
    periodType: "daily",
    artifactField: "dailyPlanPageId",
    skillName: "plan",
    planCadence: "daily",
    dateKey: (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
  },
  this_week: {
    periodType: "weekly",
    artifactField: "weeklyPlanPageId",
    skillName: "plan",
    planCadence: "weekly",
    dateKey: (tz) => weeklyMondayDateKey(tz),
  },
  next_week: {
    periodType: "weekly",
    artifactField: "weeklyPlanPageId",
    skillName: "plan",
    planCadence: "weekly",
    dateKey: (tz) => weeklyMondayDateKey(tz, 7),
  },
  this_month: {
    periodType: "monthly",
    artifactField: "monthlyPlanPageId",
    skillName: "plan",
    planCadence: "monthly",
    dateKey: (tz) => {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(new Date());
      const year = parts.find(p => p.type === "year")?.value ?? "2026";
      const month = parts.find(p => p.type === "month")?.value ?? "01";
      return `${year}-${month}-01`;
    },
  },
  this_quarter: {
    periodType: "quarterly",
    artifactField: "quarterlyPlanPageId",
    skillName: "plan",
    planCadence: "quarterly",
    dateKey: (tz) => {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(new Date());
      const year = Number(parts.find(p => p.type === "year")?.value ?? "2026");
      const month = Number(parts.find(p => p.type === "month")?.value ?? "1");
      const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
      return `${year}-${String(quarterStartMonth).padStart(2, "0")}-01`;
    },
  },
};

async function enrichSectionsWithPlanArtifacts(
  sections: SimpleFeedSection[],
  timezone: string,
): Promise<void> {
  const { getArtifacts } = await import("../period-artifact-storage");
  const { db } = await import("../db");
  const { libraryPages } = await import("@shared/models/info");
  const { eq } = await import("drizzle-orm");

  for (const section of sections) {
    const config = PLAN_ARTIFACT_CONFIG[section.section];
    if (!config) continue;

    section.planSkillName = config.skillName;
    section.planCadence = config.planCadence;

    try {
      const dateKey = config.dateKey(timezone);
      const artifacts = await getArtifacts(dateKey, config.periodType);
      const pageId = artifacts?.[config.artifactField] as string | null | undefined;

      if (pageId) {
        const rows = await db
          .select({ id: libraryPages.id, slug: libraryPages.slug, title: libraryPages.title })
          .from(libraryPages)
          .where(eq(libraryPages.id, pageId))
          .limit(1);
        if (rows[0]) {
          section.planArtifact = {
            pageId: rows[0].id,
            pageSlug: rows[0].slug ?? rows[0].id,
            title: rows[0].title,
          };
        } else {
          section.planArtifact = null;
        }
      } else {
        section.planArtifact = null;
      }
    } catch (err) {
      log.warn(`enrichSectionsWithPlanArtifacts ${section.section}: ${err instanceof Error ? err.message : String(err)}`);
      section.planArtifact = null;
    }
  }
}

function groupItems(bundle: SimpleContextBundle, degraded = false): SimpleFeed {
  // In the evening (>= 18), merge "today" into "now" — there's no "later today"
  const hour = currentHourInTimezone(bundle.timezone);
  const mergeTodayIntoNow = hour >= 18;

  const items = mergeTodayIntoNow
    ? bundle.items.map(item => item.section === "today" ? { ...item, section: "now" as SimpleSection } : item)
    : bundle.items;

  const sections = SIMPLE_SECTIONS.map(section => ({
    section,
    items: items
      .filter(item => item.section === section)
      .sort((a, b) => sortSectionItems(a, b, bundle.timezone)),
  })).filter(section => section.items.length > 0 || PLAN_ARTIFACT_CONFIG[section] !== undefined);

  return {
    id: `simple-${Date.now().toString(36)}`,
    generatedAt: bundle.generatedAt,
    timezone: bundle.timezone,
    anchor: "now",
    sections,
    degraded: degraded || bundle.errors.length > 0,
    errors: bundle.errors.length ? bundle.errors : undefined,
  };
}

function normalizeGeneratedFeed(input: unknown, fallback: SimpleFeed): SimpleFeed {
  const parsed = validateSimpleFeed(input);
  const allowedIds = new Set(fallback.sections.flatMap(section => section.items.map(item => item.id)));
  const fallbackById = new Map(fallback.sections.flatMap(section => section.items.map(item => [item.id, item] as const)));
  const fallbackSectionByKey = new Map(fallback.sections.map(section => [section.section, section] as const));
  const sections = parsed.sections
    .map(section => {
      const fallbackSection = fallbackSectionByKey.get(section.section);
      return {
        section: section.section,
        planArtifact: fallbackSection?.planArtifact,
        planSkillName: fallbackSection?.planSkillName,
        planCadence: fallbackSection?.planCadence,
        items: section.items
          .filter(item => allowedIds.has(item.id))
          .map(item => ({ ...fallbackById.get(item.id), ...item, sourceRefs: fallbackById.get(item.id)?.sourceRefs ?? item.sourceRefs, references: fallbackById.get(item.id)?.references ?? item.references } as SimpleFeedItem)),
      };
    })
    .filter(section => section.items.length > 0 || section.planArtifact !== undefined);

  return validateSimpleFeed({
    ...parsed,
    id: fallback.id,
    generatedAt: fallback.generatedAt,
    timezone: fallback.timezone,
    anchor: "now",
    sections,
    degraded: fallback.degraded,
    errors: fallback.errors,
  });
}

async function curateWithModel(bundle: SimpleContextBundle, fallback: SimpleFeed): Promise<SimpleFeed> {
  const compactItems = fallback.sections.flatMap(section => section.items).map(item => ({
    id: item.id,
    section: item.section,
    widgetType: item.widgetType,
    title: item.title,
    status: item.status,
    priority: item.priority,
    sourceRefs: item.sourceRefs,
    references: item.references,
    payload: item.payload,
    actions: item.actions,
    completedAt: item.completedAt,
    actionTime: item.actionTime,
  }));

  const result = await chatCompletion({
    activity: ACTIVITY_FRAMING,
    metadata: { source: "simple-feed", activity: ACTIVITY_FRAMING, sessionKey: "simple-feed" },
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 2200,
    messages: [
      {
        role: "system",
        content: [
          "You curate Agent's Simple feed for Ray.",
          "Return only valid JSON matching the provided SimpleFeed shape.",
          "Use only the provided item ids. Do not invent factual cards.",
          "Every item must keep sourceRefs.",
          "Collapsed card titles must have no subtitles and no explanatory copy.",
          "Tone is neutral, never nanny-like. Forbidden title styles: 'you have not', 'you ignored', 'behind on', 'need to'.",
          "Prefer quiet titles: 'Magic Demo', 'Health Insurance', 'Cynthia'.",
          "You may reorder, omit low-salience items, change section, and improve title wording while preserving source grounding.",
          "Sections allowed: " + SIMPLE_SECTIONS.join(", "),
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "Curate this fallback feed into the best Simple feed. Keep ids and sourceRefs. Omit clutter. Put completed items in done, current focus in now, near future below.",
          generatedAt: bundle.generatedAt,
          timezone: bundle.timezone,
          fallbackFeed: fallback,
          candidateItems: compactItems,
        }),
      },
    ],
  });

  return normalizeGeneratedFeed(JSON.parse(result.content), fallback);
}

export async function generateSimpleFeed(options: { refresh?: boolean; useModel?: boolean; accountId?: string } = {}): Promise<SimpleFeed> {
  const cacheKey = options.accountId || "__default__";
  const cached = feedCache.get(cacheKey);
  if (!options.refresh && cached && isCachedFeedCurrent(cached)) return { ...cached, stale: true };

  const generation = feedGeneration.get(cacheKey) || 0;
  if (!feedGeneration.has(cacheKey)) feedGeneration.set(cacheKey, generation);
  const inFlightKey = `${cacheKey}:${options.useModel === true ? "curated" : "deterministic"}:${generation}`;
  const existing = inFlightFeeds.get(inFlightKey);
  if (existing) {
    log.debug(`coalesced Simple feed generation account=${cacheKey} generation=${generation}`);
    return existing;
  }

  const generationPromise = (async (): Promise<SimpleFeed> => {
    const started = Date.now();
    const bundle = await collectSimpleContext();
    const fallback = validateSimpleFeed(groupItems(bundle, false));

    try {
      await enrichSectionsWithPlanArtifacts(fallback.sections, bundle.timezone);
    } catch (err) {
      log.warn(`plan artifact enrichment failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const cacheIfCurrent = (feed: SimpleFeed): void => {
      if ((feedGeneration.get(cacheKey) || 0) === generation) {
        feedCache.set(cacheKey, feed);
      }
    };

    if (!options.useModel) {
      cacheIfCurrent(fallback);
      log.debug(`generated deterministic Simple feed items=${fallback.sections.reduce((n, section) => n + section.items.length, 0)} degraded=${!!fallback.degraded} ms=${Date.now() - started}`);
      return fallback;
    }

    try {
      const curated = await curateWithModel(bundle, fallback);
      cacheIfCurrent(curated);
      log.debug(`generated curated Simple feed items=${curated.sections.reduce((n, section) => n + section.items.length, 0)} degraded=${!!curated.degraded} ms=${Date.now() - started}`);
      return curated;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`curated generation failed, using fallback: ${message}`);
      const degraded = { ...fallback, degraded: true, errors: [...(fallback.errors || []), { source: "llm", message }] };
      cacheIfCurrent(degraded);
      return degraded;
    }
  })();

  inFlightFeeds.set(inFlightKey, generationPromise);
  try {
    return await generationPromise;
  } finally {
    if (inFlightFeeds.get(inFlightKey) === generationPromise) {
      inFlightFeeds.delete(inFlightKey);
    }
  }
}
