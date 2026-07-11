import type { SimpleAction, SimpleFeedItem, SimpleSection, SimpleSourceRef } from "@shared/models/simple";
import { fileTaskStorage } from "../file-storage/tasks";
import { fileProjectStorage } from "../file-storage/projects";
import { createLogger } from "../log";
import type { GoalIndexEntry, CalendarEventMetadata } from "@shared/schema";
import { goalsService } from "../goals-service";
import type { Task, Project, Milestone } from "@shared/models/work";
import { formatHour, getWindowLabel, inRange } from "@shared/wellness-window";
import { queryActivityStatus } from "../routes/wellness";
import { sourceRefsToReferenceRefs } from "@shared/simple-references";
import { createReferenceRef } from "@shared/references";
import { listAllEvents, type CalendarEvent } from "../google-calendar";
import { listMetadataByEvents, classifyEventByTitle, getLinkedArtifactsByMetadataIds } from "../calendar-metadata";
import { computeAgendaSignals, computeContextBadge, peopleStorage, type Interaction, type ScoredAgendaItem } from "../people-storage";
import { ensurePeopleSurfaceStates, listPeopleSurfaceStates } from "./people-surface-state";
import { signalStorage } from "../news-storage";
import type { SignalItem } from "@shared/models/signal";
import { db } from "../db";
import { emailMessages, emailEnrichments } from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import { and, sql, inArray } from "drizzle-orm";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { visibleScopePredicate } from "../scoped-storage";

const log = createLogger("SimpleCollectors");

type EmailPersonMap = Map<string, { id: string; name: string; summary: string | null; lastInteractionContext: string | null }>;
type MeetingArtifactView = { linkId: number; pageId: string; title: string; slug: string; artifactKind: string; source: string | null; summary: string | null; oneLiner: string | null };
type MeetingArtifactMap = Map<number, MeetingArtifactView[]>;

async function buildEmailPersonMap(): Promise<EmailPersonMap> {
  const map: EmailPersonMap = new Map();
  try {
    const entries = await peopleStorage.listPeople();
    const people = await peopleStorage.getPeopleByIds(entries.map(e => e.id));
    for (const person of people) {
      for (const ci of person.contactInfo ?? []) {
        if (ci.type === "email" && ci.value) {
          map.set(ci.value.toLowerCase(), {
            id: person.id,
            name: person.name,
            summary: person.aiSummary?.trim() || person.quickSummary?.trim() || person.identityContent?.trim() || null,
            lastInteractionContext: interactionContext(latestInteraction(person.interactions ?? [])),
          });
        }
      }
    }
  } catch (err) {
    log.warn(`buildEmailPersonMap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return map;
}

type WellnessActivityStatus = Awaited<ReturnType<typeof queryActivityStatus>>[number];

// ─── Shared helpers ───

function localWindowValue(category: string, now = new Date(), timezone = "America/Chicago"): number | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

  switch (category) {
    case "daily_practice": return Number(get("hour"));
    case "weekly_ritual": return weekdayMap[get("weekday")] ?? null;
    case "monthly_renewal": return Number(get("day"));
    case "quarterly_reset": return ((Number(get("month")) - 1) % 3) + 1;
    case "annual_checkup": return Number(get("month"));
    default: return null;
  }
}

export interface SimpleContextBundle {
  generatedAt: string;
  timezone: string;
  items: SimpleFeedItem[];
  errors: Array<{ source: string; message: string }>;
}

function todayInChicago(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}


function dateInTimezone(value: string | Date, timezone = "America/Chicago"): string {
  const d = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isTodayInTimezone(value: string | Date | null | undefined, timezone = "America/Chicago"): boolean {
  if (!value) return false;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return dateInTimezone(d, timezone) === dateInTimezone(new Date(), timezone);
}

function dateOnlyString(value: string | null | undefined, timezone = "America/Chicago"): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateInTimezone(parsed, timezone);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Format a date string as a short day+date label, e.g. "THU, 7/2". */
function formatShortDate(dateStr: string, timezone = "America/Chicago"): string | undefined {
  const dateOnly = dateOnlyString(dateStr, timezone);
  if (!dateOnly) return undefined;
  const d = new Date(`${dateOnly}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "numeric",
    day: "numeric",
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("weekday").toUpperCase()}, ${get("month")}/${get("day")}`;
}

/** Format a date string as a month+day label, e.g. "JUL 15". */
function formatMonthDate(dateStr: string, timezone = "America/Chicago"): string | undefined {
  const dateOnly = dateOnlyString(dateStr, timezone);
  if (!dateOnly) return undefined;
  const d = new Date(`${dateOnly}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("month").toUpperCase()} ${get("day")}`;
}


/** Format an Inbox surfaced date as a compact no-wrap label, e.g. "Oct 11". */
function formatInboxDate(dateStr: string, timezone = "America/Chicago"): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).format(d);
}

/** Sections where a day-of-week date label is shown (e.g. "THU, 7/2"). */
const DAY_LABEL_SECTIONS = new Set<SimpleSection>(["this_week", "next_week"]);
/** Sections where a month+day label is shown (e.g. "JUL 15"). */
const MONTH_LABEL_SECTIONS = new Set<SimpleSection>(["this_month", "next_month", "this_quarter", "next_quarter", "this_year", "next_year"]);

/** Get the appropriate time label for an item's due date given its section. */
function dateLabelForSection(dateStr: string, section: SimpleSection, timezone = "America/Chicago"): string | undefined {
  const dateOnly = dateOnlyString(dateStr, timezone);
  if (!dateOnly) return undefined;
  if (DAY_LABEL_SECTIONS.has(section)) return formatShortDate(dateOnly, timezone);
  if (MONTH_LABEL_SECTIONS.has(section)) return formatMonthDate(dateOnly, timezone);
  return undefined;
}

function endOfWeek(today: string, timezone = "America/Chicago"): string {
  const d = new Date(`${today}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).formatToParts(d);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const current = weekdayMap[parts.find(p => p.type === "weekday")?.value ?? "Mon"] ?? 1;
  const daysUntilSunday = (7 - current) % 7 || 7;
  return addDays(today, daysUntilSunday);
}

function endOfMonth(today: string): string {
  const [year, month] = today.split("-").map(Number);
  const last = new Date(year, month, 0).getDate();
  return `${today.slice(0, 8)}${String(last).padStart(2, "0")}`;
}

function endOfQuarter(today: string): string {
  const [year, month] = today.split("-").map(Number);
  const qEnd = Math.ceil(month / 3) * 3;
  const last = new Date(year, qEnd, 0).getDate();
  return `${year}-${String(qEnd).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

function endOfYear(today: string): string {
  return `${today.slice(0, 4)}-12-31`;
}

function endOfNextYear(today: string): string {
  return `${Number(today.slice(0, 4)) + 1}-12-31`;
}

function isoWeekString(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ─── Wellness ───

function wellnessSection(activity: WellnessActivityStatus, now = new Date(), timezone = "America/Chicago"): SimpleSection | null {
  if (activity.doneForCurrentPeriod) return isTodayInTimezone(activity.lastCompletedAt, timezone) ? "done" : null;

  const actionable = activity.status === "overdue" || activity.status === "due_soon" || activity.status === "never_done";
  if (!actionable) return null;
  if (activity.inWindow) return "now";

  const hasWindow = activity.windowStart != null && activity.windowEnd != null;
  if (!hasWindow) {
    switch (activity.category) {
      case "daily_practice": return "today";
      case "weekly_ritual": return "this_week";
      case "monthly_renewal": return "this_month";
      case "quarterly_reset": return "this_quarter";
      case "annual_checkup": return "this_year";
      default: return "today";
    }
  }

  const current = localWindowValue(activity.category, now, timezone);
  if (current == null) return "today";

  switch (activity.category) {
    case "daily_practice":
      return inRange(current, activity.windowStart!, activity.windowEnd!) ? "now" : "today";
    case "weekly_ritual":
      return "this_week";
    case "monthly_renewal":
      return "this_month";
    case "quarterly_reset":
      return "this_quarter";
    case "annual_checkup":
      return "this_year";
    default:
      return "today";
  }
}

function itemFromWellnessActivity(activity: WellnessActivityStatus, section: SimpleSection, index: number): SimpleFeedItem {
  const sourceRef: SimpleSourceRef = {
    type: "wellness",
    id: String(activity.id),
    label: activity.name,
    href: `/wellness?tab=calendar&activity=${activity.id}`,
    observedAt: activity.updatedAt instanceof Date ? activity.updatedAt.toISOString() : undefined,
  };
  const hasWindow = activity.windowStart != null && activity.windowEnd != null;
  const windowLabel = hasWindow ? getWindowLabel(activity.category, activity.windowStart!, activity.windowEnd!) : null;

  // Use just the end time for the time column (keeps it to one line)
  const wellnessTime = hasWindow && activity.category === "daily_practice"
    ? formatHour(activity.windowEnd!)
    : undefined;

  return {
    id: `wellness-${activity.id}`,
    section,
    widgetType: "wellness",
    title: activity.name,
    status: activity.doneForCurrentPeriod ? "completed" : "active",
    priority: (section === "now" ? 12 : 45) + index,
    sourceRefs: [sourceRef],
    references: sourceRefsToReferenceRefs([sourceRef]),
    completedAt: activity.doneForCurrentPeriod && activity.lastCompletedAt ? activity.lastCompletedAt : undefined,
    time: wellnessTime,
    completable: true,
    payload: {
      kind: "wellness_activity",
      category: activity.category,
      activityStatus: activity.status,
      urgency: activity.urgency,
      daysSince: activity.daysSince,
      daysUntilDue: activity.daysUntilDue,
      doneForCurrentPeriod: activity.doneForCurrentPeriod,
      inWindow: activity.inWindow,
      windowStart: activity.windowStart,
      windowEnd: activity.windowEnd,
      windowLabel,
      estimatedMinutes: activity.estimatedMinutes,
      benefit: activity.benefit,
      risk: activity.risk,
    },
    actions: [
      { id: `complete-wellness-${activity.id}`, label: "Done", type: "complete", sourceRef, payload: { activityId: activity.id } },
      { id: `open-wellness-${activity.id}`, label: "Open wellness", type: "navigate", href: sourceRef.href, sourceRef },
    ],
  };
}


// ─── Goals ───

function goalSection(goal: GoalIndexEntry, fallbackSection?: SimpleSection): SimpleSection {
  if (goal.status === "achieved") return "done";
  if (fallbackSection) return fallbackSection;
  switch (goal.horizon) {
    case "today": return "now";
    case "this_week": return "this_week";
    case "this_month": return "this_month";
    case "this_quarter": return "this_quarter";
    case "this_year": return "this_year";
    case "three_year": return "three_years";
    case "ten_year": return "lifetime";
    case "lifetime": return "lifetime";
    default: return "this_year";
  }
}

function goalHref(goal: GoalIndexEntry): string {
  switch (goal.horizon) {
    case "today": return "/goals?tab=today";
    case "this_week": return "/goals?tab=week";
    case "this_month": return "/goals?tab=month";
    default: return "/goals";
  }
}

function itemFromGoal(goal: GoalIndexEntry, index: number, fallbackSection?: SimpleSection): SimpleFeedItem {
  const section = goalSection(goal, fallbackSection);
  const sourceRef: SimpleSourceRef = {
    type: "goal",
    id: goal.id,
    label: goal.shortName,
    href: goalHref(goal),
    observedAt: goal.updatedAt,
  };
  return {
    id: `goal-${goal.id}`,
    section,
    widgetType: "priority_task",
    title: goal.shortName,
    status: goal.status === "achieved" ? "completed" : "active",
    priority: index,
    sourceRefs: [sourceRef],
    references: sourceRefsToReferenceRefs([sourceRef]),
    completedAt: goal.status === "achieved" ? goal.completedAt ?? undefined : undefined,
    completable: goal.status !== "achieved",
    payload: {
      kind: "goal",
      goalId: goal.id,
      horizon: goal.horizon,
      goalStatus: goal.status,
      parentId: goal.parentId,
      targetDate: goal.targetDate,
      periodDate: goal.periodDate,
      periodWeek: goal.periodWeek,
      periodMonth: goal.periodMonth,
    },
    actions: [
      { id: `complete-goal-${goal.id}`, label: "Done", type: "complete", sourceRef, payload: { priorityId: goal.id, horizon: goal.horizon, period: goal.horizon, date: goal.periodDate ?? goal.periodWeek ?? goal.periodMonth ?? goal.targetDate ?? "" } },
      { id: `open-goal-${goal.id}`, label: "Open goals", type: "navigate", href: sourceRef.href, sourceRef },
    ],
  };
}

// ─── People ───

type SimplePeopleSurfaceTier = "follow_up" | "maintenance";
type TieredAgendaItem = ScoredAgendaItem & {
  simpleSurfaceTier: SimplePeopleSurfaceTier;
  urgencyScore: number;
  reasonKey: string;
  lastInteractionContext: string | null;
  snoozedUntil?: string | null;
};

function latestInteraction(interactions: Interaction[]): Interaction | null {
  return interactions
    .filter(ix => ix.date)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0] ?? null;
}

function interactionContext(interaction: Interaction | null): string | null {
  if (!interaction) return null;
  const summary = interaction.summary?.trim() || "No summary recorded";
  const date = interaction.date ? interaction.date.slice(0, 10) : "date missing";
  return `${date} ${interaction.type}: ${summary}`;
}

function reasonKey(item: ScoredAgendaItem): string {
  if (item.responseOwedDetails) return `response:${item.responseOwedDetails}`;
  if (item.commitmentDetails) return `commitment:${item.commitmentDetails}`;
  return `maintenance:${item.dueStatus}:${item.reason || item.suggestedAction}`;
}

function itemFromAgendaPerson(item: TieredAgendaItem, index: number): SimpleFeedItem {
  const sourceRef: SimpleSourceRef = {
    type: "person",
    id: item.personId,
    label: item.name,
    href: `/people/${item.personId}`,
  };
  const badge = item.contextBadge?.label;
  const section: SimpleSection = item.snoozedUntil ? "snoozed" : "inbox";
  const inboxAddedAt = item.surfacedAt || new Date().toISOString();
  const inboxAddedDate = dateInTimezone(inboxAddedAt);
  return {
    id: `person-${item.personId}`,
    section,
    widgetType: "person",
    title: item.name,
    status: "active",
    priority: 35 + index,
    anchorTime: inboxAddedAt,
    time: formatInboxDate(inboxAddedDate),
    sourceRefs: [sourceRef],
    references: sourceRefsToReferenceRefs([sourceRef]),
    payload: {
      kind: "relationship_outreach",
      reason: item.reason || "Relationship context missing — open People to inspect.",
      reasonKey: item.reasonKey,
      suggestedAction: item.suggestedAction,
      dueStatus: item.dueStatus,
      daysSinceMeaningful: item.daysSinceMeaningful,
      daysSinceLastContact: item.daysSinceLastContact,
      cabinetLevel: item.cabinetLevel,
      contextBadge: badge || null,
      responseOwedDetails: item.responseOwedDetails || null,
      responseDueBy: item.responseDueBy || null,
      commitmentDetails: item.commitmentDetails || null,
      surfaceTier: item.simpleSurfaceTier,
      urgencyScore: item.urgencyScore,
      inboxAddedAt,
      followUpReason: item.reason || null,
      lastInteractionContext: item.lastInteractionContext,
      missingLastInteractionContext: item.lastInteractionContext ? false : true,
      snoozedUntil: item.snoozedUntil ?? null,
    },
    actions: [
      { id: `open-person-${item.personId}`, label: "Open person", type: "navigate", href: sourceRef.href, sourceRef },
    ],
  };
}

const PEOPLE_SURFACE_LIMIT = 3;

const NEWS_INBOX_LIMIT = 3;

const EMAIL_INBOX_LIMIT = 5;

// ─── Email Review ───

interface EmailReviewThread {
  id: number;
  providerThreadId: string;
  accountId: string;
  subject: string | null;
  fromAddress: string | null;
  snippet: string | null;
  date: string | null;
  triageTier: string | null;
  triageReason: string | null;
  messageIds: number[];
  messageCount: number;
  unreadCount: number;
  enrichmentSummary: string | null;
  enrichmentActions: string[] | null;
  doneAt?: string | null;
}

async function collectEmailReviewThreads(): Promise<EmailReviewThread[]> {
  try {
    const principal = getCurrentPrincipalOrSystem();
    const ownerConditions: string[] = [];
    if (principal.actorType !== "system") {
      if (principal.userId) ownerConditions.push(`em.owner_user_id = '${principal.userId}'`);
      if (principal.accountId) ownerConditions.push(`em.principal_account_id = '${principal.accountId}'`);
    }
    const ownerWhere = ownerConditions.length > 0
      ? `(${ownerConditions.join(" OR ")})`
      : "TRUE";

    const result = await db.execute(sql.raw(`
      SELECT DISTINCT ON (em.account_id, em.provider, COALESCE(em.provider_thread_id, em.provider_message_id))
        em.id,
        COALESCE(em.provider_thread_id, em.provider_message_id) AS provider_thread_id,
        em.account_id,
        em.subject,
        em.from_address,
        em.snippet,
        em.date::text,
        em.triage_tier,
        em.triage_reason,
        (SELECT ARRAY_AGG(t.id ORDER BY t.date DESC) FROM email_messages t WHERE t.provider_thread_id = COALESCE(em.provider_thread_id, em.provider_message_id) AND t.account_id = em.account_id AND t.provider = em.provider) AS message_ids,
        (SELECT COUNT(*) FROM email_messages t WHERE t.provider_thread_id = COALESCE(em.provider_thread_id, em.provider_message_id) AND t.account_id = em.account_id AND t.provider = em.provider) AS message_count,
        (SELECT COUNT(*) FROM email_messages t WHERE t.provider_thread_id = COALESCE(em.provider_thread_id, em.provider_message_id) AND t.account_id = em.account_id AND t.provider = em.provider AND t.is_read = false) AS unread_count,
        ee.summary AS enrichment_summary,
        ee.actions AS enrichment_actions
      FROM email_messages em
      LEFT JOIN email_enrichments ee ON ee.provider_thread_id = COALESCE(em.provider_thread_id, em.provider_message_id) AND ee.account_id = em.account_id
      WHERE ${ownerWhere}
        AND em.triage_status = 'triaged'
        AND em.is_done = false
        AND (em.snoozed_until IS NULL OR em.snoozed_until <= NOW())
        AND EXISTS (SELECT 1 FROM email_enrichments ee2 WHERE ee2.provider_thread_id = COALESCE(em.provider_thread_id, em.provider_message_id) AND ee2.account_id = em.account_id)
        AND NOT EXISTS (
          SELECT 1 FROM email_dismissals ed
          WHERE ed.provider_thread_id = COALESCE(em.provider_thread_id, em.provider_message_id)
            AND ed.account_id = em.account_id
            AND ed.dismissed_at >= COALESCE(
              (SELECT MAX(em2.date) FROM email_messages em2
               WHERE em2.provider_thread_id = COALESCE(em.provider_thread_id, em.provider_message_id)
                 AND em2.account_id = em.account_id
                 AND em2.direction = 'inbound'),
              '1970-01-01'::timestamptz
            )
        )
      ORDER BY em.account_id, em.provider, COALESCE(em.provider_thread_id, em.provider_message_id), em.date DESC
      LIMIT ${EMAIL_INBOX_LIMIT}
    `));

    return (result.rows as any[]).map(row => ({
      id: row.id,
      providerThreadId: row.provider_thread_id,
      accountId: row.account_id,
      subject: row.subject,
      fromAddress: row.from_address,
      snippet: row.snippet,
      date: row.date,
      triageTier: row.triage_tier,
      triageReason: row.triage_reason,
      messageIds: Array.isArray(row.message_ids) ? row.message_ids.map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id)) : [],
      messageCount: Number(row.message_count) || 1,
      unreadCount: Number(row.unread_count) || 0,
      enrichmentSummary: row.enrichment_summary,
      enrichmentActions: row.enrichment_actions,
    }));
  } catch (err) {
    log.error(`collectEmailReviewThreads failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

const EMAIL_DONE_LIMIT = 8;

/**
 * Threads the user explicitly marked done today (done_reason='user_done').
 * Auto-done (noise/FYI/archive sync) and dismissals are intentionally excluded —
 * DONE is a win list, not a discard log.
 */
async function collectEmailDoneToday(): Promise<EmailReviewThread[]> {
  try {
    const principal = getCurrentPrincipalOrSystem();
    const ownerConditions: string[] = [];
    if (principal.actorType !== "system") {
      if (principal.userId) ownerConditions.push(`em.owner_user_id = '${principal.userId}'`);
      if (principal.accountId) ownerConditions.push(`em.principal_account_id = '${principal.accountId}'`);
    }
    const ownerWhere = ownerConditions.length > 0
      ? `(${ownerConditions.join(" OR ")})`
      : "TRUE";

    const result = await db.execute(sql.raw(`
      SELECT DISTINCT ON (em.account_id, em.provider, COALESCE(em.provider_thread_id, em.provider_message_id))
        em.id,
        COALESCE(em.provider_thread_id, em.provider_message_id) AS provider_thread_id,
        em.account_id,
        em.subject,
        em.from_address,
        em.snippet,
        em.date::text,
        em.triage_tier,
        em.triage_reason,
        em.done_at::text AS done_at,
        ee.summary AS enrichment_summary,
        ee.actions AS enrichment_actions
      FROM email_messages em
      LEFT JOIN email_enrichments ee ON ee.provider_thread_id = COALESCE(em.provider_thread_id, em.provider_message_id) AND ee.account_id = em.account_id
      WHERE ${ownerWhere}
        AND em.is_done = true
        AND em.done_reason = 'user_done'
        AND em.done_at IS NOT NULL
        AND (em.done_at AT TIME ZONE 'America/Chicago')::date = (NOW() AT TIME ZONE 'America/Chicago')::date
      ORDER BY em.account_id, em.provider, COALESCE(em.provider_thread_id, em.provider_message_id), em.done_at DESC
      LIMIT ${EMAIL_DONE_LIMIT}
    `));

    return (result.rows as any[]).map(row => ({
      id: row.id,
      providerThreadId: row.provider_thread_id,
      accountId: row.account_id,
      subject: row.subject,
      fromAddress: row.from_address,
      snippet: row.snippet,
      date: row.date,
      triageTier: row.triage_tier,
      triageReason: row.triage_reason,
      messageIds: [],
      messageCount: 1,
      unreadCount: 0,
      enrichmentSummary: row.enrichment_summary,
      enrichmentActions: row.enrichment_actions,
      doneAt: row.done_at,
    }));
  } catch (err) {
    log.error(`collectEmailDoneToday failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function emailSenderName(fromAddress: string | null): string {
  if (!fromAddress) return "Unknown";
  // Parse "Name <email>" or just "email"
  const match = fromAddress.match(/^"?([^"<]+)"?\s*<.*>$/);
  if (match) return match[1].trim();
  return fromAddress.split("@")[0];
}

function itemFromEmailReview(thread: EmailReviewThread, index: number, options?: { done?: boolean }): SimpleFeedItem {
  const done = options?.done === true;
  const title = thread.subject || "(no subject)";
  const sender = emailSenderName(thread.fromAddress);
  const observedAt = thread.date || new Date().toISOString();
  const sourceRef: SimpleSourceRef = {
    type: "email",
    id: `${thread.accountId}:${thread.providerThreadId}`,
    label: title,
    href: "/comms",
    observedAt,
  };
  const inboxAddedDate = dateInTimezone(observedAt);
  return {
    id: `email-review-${thread.accountId}-${thread.providerThreadId}`,
    section: done ? "done" : "inbox",
    widgetType: "inbox_item",
    title,
    status: done ? "completed" : "active",
    completedAt: done ? thread.doneAt ?? undefined : undefined,
    priority: 40 + index,
    anchorTime: observedAt,
    time: formatInboxDate(inboxAddedDate),
    sourceRefs: [sourceRef],
    references: [
      ...sourceRefsToReferenceRefs([sourceRef]),
      ...thread.messageIds.slice(0, 1).map(messageId => createReferenceRef({
        type: "email_message",
        id: String(messageId),
        metadata: { label: `${title} latest message`, href: "/comms" },
      })),
    ],
    payload: {
      kind: "email_review",
      sender,
      fromAddress: thread.fromAddress,
      snippet: thread.snippet?.slice(0, 200) || null,
      reason: thread.enrichmentSummary || thread.triageReason || null,
      triageTier: thread.triageTier,
      messageIds: thread.messageIds,
      messageCount: thread.messageCount,
      unreadCount: thread.unreadCount,
      enrichmentActions: thread.enrichmentActions,
      inboxAddedAt: observedAt,
    },
    actions: [
      { id: `open-email-${thread.id}`, label: "Open email", type: "navigate", href: "/comms", sourceRef },
    ],
  };
}

function sourceLabelForNews(sourceType: string): string {
  switch (sourceType) {
    case "x": return "X";
    case "x_account": return "X";
    case "reddit": return "Reddit";
    case "rss": return "RSS";
    case "web": return "Web";
    default: return sourceType.replace(/_/g, " ");
  }
}

function cleanNewsText(value?: string | null): string {
  if (!value) return "";
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function newsReferenceType(sourceType: string): "web_article" | "x_item" | "reddit_post" | "rss_item" | "news" {
  if (sourceType === "web") return "web_article";
  if (sourceType === "x" || sourceType === "x_account") return "x_item";
  if (sourceType === "reddit") return "reddit_post";
  if (sourceType === "rss") return "rss_item";
  return "news";
}

function itemFromNewsSignal(signal: SignalItem, index: number): SimpleFeedItem {
  const title = cleanNewsText(signal.curatedTitle || signal.title) || "News item";
  const summary = cleanNewsText(signal.agentSummary);
  const reason = cleanNewsText(signal.curatedReason);
  const originalTitle = cleanNewsText(signal.title);
  const sourceLabel = sourceLabelForNews(signal.sourceType);
  const observedAt = (signal.publishedAt ?? signal.scannedAt ?? signal.createdAt).toISOString();
  const sourceRef: SimpleSourceRef = {
    type: "news",
    id: signal.id,
    label: title,
    href: signal.url,
    observedAt,
  };
  const inboxAddedDate = dateInTimezone(observedAt);
  return {
    id: `news-${signal.id}`,
    section: "inbox",
    widgetType: "inbox_item",
    title,
    status: "active",
    priority: 45 + index,
    anchorTime: observedAt,
    time: formatInboxDate(inboxAddedDate),
    sourceRefs: [sourceRef],
    references: [createReferenceRef({
      type: newsReferenceType(signal.sourceType),
      id: signal.url,
      metadata: { label: title, href: signal.url, sourceType: signal.sourceType },
    })],
    payload: {
      kind: "news_signal",
      signalId: signal.id,
      sourceType: signal.sourceType,
      sourceLabel,
      url: signal.url,
      summary,
      reason,
      originalTitle,
      matchedTopics: signal.matchedTopics,
      relevanceScore: signal.curationScore ?? signal.relevanceScore,
      inboxAddedAt: observedAt,
    },
    actions: [
      { id: `open-news-${signal.id}`, label: "Open source", type: "open_source", href: signal.url, sourceRef },
      { id: `open-news-page-${signal.id}`, label: "Open News", type: "navigate", href: "/news", sourceRef },
    ],
  };
}

/**
 * Compute urgency score for sorting within a tier.
 * Higher = more urgent. Positive = overdue, negative = days until due.
 */
function computeUrgencyScore(item: ScoredAgendaItem): number {
  // Follow-up and reconnect ordering each use their own explicit comparators below.
  // This score remains a payload/debug signal and a fallback tie-breaker.
  if (item.responseOwedDetails || item.commitmentDetails) return item.daysSinceLastContact;
  if (item.dueStatus === "drifting" || item.dueStatus === "urgent") return item.daysSinceMeaningful;
  if (item.dueStatus === "due") return 0;
  return -item.daysSinceMeaningful;
}

function responseDueSortValue(item: ScoredAgendaItem): number {
  if (!item.responseDueBy) return Number.POSITIVE_INFINITY;
  const value = new Date(item.responseDueBy).getTime();
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function compareFollowUps(a: TieredAgendaItem, b: TieredAgendaItem): number {
  const aDue = responseDueSortValue(a);
  const bDue = responseDueSortValue(b);
  if (aDue !== bDue) return aDue - bDue;
  const urgencyDelta = b.urgencyScore - a.urgencyScore;
  if (urgencyDelta !== 0) return urgencyDelta;
  return a.name.localeCompare(b.name);
}

function compareMaintenance(a: TieredAgendaItem, b: TieredAgendaItem): number {
  const contactDelta = b.daysSinceLastContact - a.daysSinceLastContact;
  if (contactDelta !== 0) return contactDelta;
  const urgencyDelta = b.urgencyScore - a.urgencyScore;
  if (urgencyDelta !== 0) return urgencyDelta;
  return a.name.localeCompare(b.name);
}

function compareAgendaSurface(a: TieredAgendaItem, b: TieredAgendaItem): number {
  if (a.simpleSurfaceTier !== b.simpleSurfaceTier) return a.simpleSurfaceTier === "follow_up" ? -1 : 1;
  return a.simpleSurfaceTier === "follow_up" ? compareFollowUps(a, b) : compareMaintenance(a, b);
}

async function collectAgendaPeople(): Promise<TieredAgendaItem[]> {
  const people = await peopleStorage.listPeople();
  const cabinetConfig = await peopleStorage.getCabinetConfig();
  const cabinetWeights: Record<string, number> = {};
  for (const level of cabinetConfig.levels) cabinetWeights[level.id] = Math.max(1, 7 - level.order);

  const candidateEntries = people.filter(entry => !["self", "agent", "user"].includes(entry.cabinetLevel));
  const fullPeople = await peopleStorage.getPeopleByIds(candidateEntries.map(entry => entry.id));
  const peopleById = new Map(fullPeople.map(person => [person.id, person]));
  const agenda: TieredAgendaItem[] = [];
  const now = Date.now();
  for (const entry of candidateEntries) {
    const person = peopleById.get(entry.id);
    if (!person) continue;
    const scored = computeAgendaSignals(person, cabinetWeights, now);
    if (!scored) continue;
    if (entry.cabinetLevel === "network" && scored.surfaceTier !== "follow_up") continue;
    const latest = latestInteraction(person.interactions ?? []);
    const simpleSurfaceTier: SimplePeopleSurfaceTier = scored.surfaceTier === "follow_up" ? "follow_up" : "maintenance";
    agenda.push({
      ...scored,
      contextBadge: computeContextBadge(scored),
      simpleSurfaceTier,
      urgencyScore: computeUrgencyScore(scored),
      reasonKey: reasonKey(scored),
      lastInteractionContext: interactionContext(latest),
    });
  }

  const lookups = agenda.map(item => ({ personId: item.personId, reasonKey: item.reasonKey }));
  await ensurePeopleSurfaceStates(lookups);
  const states = await listPeopleSurfaceStates(lookups);
  const visible: TieredAgendaItem[] = [];
  const snoozed: TieredAgendaItem[] = [];

  for (const item of agenda) {
    const state = states.get(`${item.personId}::${item.reasonKey}`);
    const surfacedAt = state?.surfacedAt?.toISOString() ?? new Date(now).toISOString();
    item.surfacedAt = surfacedAt;
    const snoozedUntil = state?.snoozedUntil ?? null;
    if (snoozedUntil && snoozedUntil.getTime() > now) {
      snoozed.push({ ...item, snoozedUntil: snoozedUntil.toISOString() });
      continue;
    }
    if (state?.dismissedAt && state.dismissedReasonKey === item.reasonKey) continue;
    visible.push(item);
  }

  const followUps = visible
    .filter(item => item.simpleSurfaceTier === "follow_up")
    .sort(compareFollowUps);
  const remainingSlots = Math.max(0, PEOPLE_SURFACE_LIMIT - followUps.length);
  const maintenance = visible
    .filter(item => item.simpleSurfaceTier === "maintenance")
    .sort(compareMaintenance)
    .slice(0, remainingSlots);

  return [...followUps, ...maintenance, ...snoozed.sort(compareAgendaSurface)];
}

// ─── Tasks ───

/** Resolve the effective deadline for a task, inheriting from parent milestone if needed. */
function resolveTaskDeadline(task: Task, milestoneMap: Map<string, Milestone>): string | null {
  const taskDeadline = dateOnlyString(task.deadline);
  if (taskDeadline) return taskDeadline;
  if (task.milestoneId) {
    const milestone = milestoneMap.get(`${task.projectId}-${task.milestoneId}`);
    const milestoneDeadline = dateOnlyString(milestone?.dueDate);
    if (milestoneDeadline) return milestoneDeadline;
  }
  return null;
}

/** Check if a task needs a date flag (dateless task in an active project without milestone date). */
function taskNeedsDate(task: Task, milestoneMap: Map<string, Milestone>): boolean {
  if (task.status === "done") return false; // completed work never warns about missing dates
  if (dateOnlyString(task.deadline)) return false;
  if (task.milestoneId) {
    const milestone = milestoneMap.get(`${task.projectId}-${task.milestoneId}`);
    if (dateOnlyString(milestone?.dueDate)) return false;
  }
  // Task has no resolved date — flag if it belongs to an active project
  return task.projectId != null;
}

/** Check if task deadline exceeds its parent milestone deadline. */
function taskDateConflict(task: Task, milestoneMap: Map<string, Milestone>): boolean {
  const taskDeadline = dateOnlyString(task.deadline);
  if (!taskDeadline || !task.milestoneId) return false;
  const milestone = milestoneMap.get(`${task.projectId}-${task.milestoneId}`);
  const milestoneDeadline = dateOnlyString(milestone?.dueDate);
  if (!milestoneDeadline) return false;
  return taskDeadline > milestoneDeadline;
}

function taskSection(task: Task, today: string, tomorrow: string, weekEnd: string, monthEnd: string, quarterEnd: string, yearEnd: string, milestoneMap: Map<string, Milestone>): SimpleSection {
  const deadline = resolveTaskDeadline(task, milestoneMap);
  if (!deadline) return task.status === "active" ? "now" : "today";

  if (deadline < today) return "now"; // overdue
  if (deadline === today) return "today";
  if (deadline === tomorrow) return "tomorrow";
  if (deadline <= weekEnd) return "this_week";
  const nextWeekEnd = addDays(weekEnd, 7);
  if (deadline <= nextWeekEnd) return "next_week";
  if (deadline <= monthEnd) return "this_month";
  const nextMonthEnd = endOfMonth(addDays(monthEnd, 1));
  if (deadline <= nextMonthEnd) return "next_month";
  if (deadline <= quarterEnd) return "this_quarter";
  const nextQuarterEnd = endOfQuarter(addDays(quarterEnd, 1));
  if (deadline <= nextQuarterEnd) return "next_quarter";
  if (deadline <= yearEnd) return "this_year";
  if (deadline <= endOfNextYear(today)) return "next_year";
  return "this_year"; // beyond next year remains clamped to this_year
}

function itemFromTask(task: Task, today: string, tomorrow: string, weekEnd: string, monthEnd: string, quarterEnd: string, yearEnd: string, index: number, milestoneMap: Map<string, Milestone>): SimpleFeedItem {
  const sourceRef: SimpleSourceRef = {
    type: "task",
    id: String(task.id),
    label: task.title,
    href: `/projects?tab=tasks&task=${task.id}`,
    observedAt: task.updatedAt,
  };
  const effectiveDeadline = resolveTaskDeadline(task, milestoneMap);
  const needsDate = taskNeedsDate(task, milestoneMap);
  const dateConflict = taskDateConflict(task, milestoneMap);
  const section = taskSection(task, today, tomorrow, weekEnd, monthEnd, quarterEnd, yearEnd, milestoneMap);
  const timeLabel = effectiveDeadline ? dateLabelForSection(effectiveDeadline, section) : undefined;
  return {
    id: `task-${task.id}`,
    section,
    widgetType: "priority_task",
    title: task.title,
    status: task.status === "done" ? "completed" : "active",
    priority: 20 + index,
    sourceRefs: [sourceRef],
    references: sourceRefsToReferenceRefs([sourceRef]),
    actionTime: effectiveDeadline ? `${effectiveDeadline}T17:00:00.000Z` : undefined,
    time: timeLabel,
    completable: true,
    payload: {
      kind: "task",
      status: task.status,
      taskPriority: task.priority,
      impact: task.impact,
      effort: task.effort,
      deadline: task.deadline,
      effectiveDeadline,
      inheritedDeadline: !task.deadline && effectiveDeadline ? true : undefined,
      projectId: task.projectId,
      milestoneId: task.milestoneId,
      tags: task.tags,
      needsDate: needsDate || undefined,
      dateConflict: dateConflict || undefined,
    },
    actions: [
      { id: `complete-task-${task.id}`, label: "Done", type: "complete", sourceRef, payload: { taskId: task.id } },
      { id: `open-task-${task.id}`, label: "Open task", type: "navigate", href: sourceRef.href, sourceRef },
    ],
  };
}

// ─── Meetings ───

function meetingSection(event: CalendarEvent, today: string, tomorrow: string, weekEnd: string): SimpleSection {
  const startDate = (event.start.dateTime ?? event.start.date ?? "").slice(0, 10);
  if (startDate < today) return "earlier";
  if (startDate === today) {
    // If the event has ended, move it out of "now"
    const endDt = event.end.dateTime;
    if (endDt && new Date(endDt) < new Date()) return "earlier";
    return "now";
  }
  if (startDate === tomorrow) return "tomorrow";
  if (startDate <= weekEnd) return "this_week";
  return "this_month";
}

function formatMeetingTime(event: CalendarEvent, timezone: string): string {
  const dt = event.start.dateTime;
  if (!dt) return "All day";
  const d = new Date(dt);
  return d.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true });
}


async function buildMeetingArtifactMap(metadataIds: number[]): Promise<MeetingArtifactMap> {
  const map: MeetingArtifactMap = new Map();
  if (metadataIds.length === 0) return map;
  try {
    const links = await getLinkedArtifactsByMetadataIds(metadataIds);
    if (links.length === 0) return map;
    const pageIds = Array.from(new Set(links.map(link => link.libraryPageId)));
    const principal = getCurrentPrincipalOrSystem();
    const pages = await db
      .select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug, oneLiner: libraryPages.oneLiner, summary: libraryPages.summary, plainTextContent: libraryPages.plainTextContent })
      .from(libraryPages)
      .where(and(
        inArray(libraryPages.id, pageIds),
        visibleScopePredicate(principal, { scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId }),
      ));
    const pagesById = new Map(pages.map(page => [page.id, page]));
    for (const link of links) {
      const page = pagesById.get(link.libraryPageId);
      if (!page) continue;
      const list = map.get(link.metadataId) ?? [];
      list.push({
        linkId: link.id,
        pageId: page.id,
        title: link.title || page.title || "Meeting artifact",
        slug: page.slug,
        artifactKind: link.artifactKind,
        source: link.source,
        summary: page.summary?.trim() || page.plainTextContent?.trim() || null,
        oneLiner: page.oneLiner?.trim() || null,
      });
      map.set(link.metadataId, list);
    }
  } catch (err) {
    log.warn(`buildMeetingArtifactMap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return map;
}

function itemFromMeeting(event: CalendarEvent, section: SimpleSection, index: number, timezone: string, emailMap: EmailPersonMap, artifacts: MeetingArtifactView[] = [], meta?: CalendarEventMetadata): SimpleFeedItem {
  const sourceRef: SimpleSourceRef = {
    type: "calendar",
    id: `${event.accountId}:${event.id}`,
    label: event.summary,
    href: `/calendar`,
    observedAt: event.start.dateTime ?? event.start.date,
  };
  const timeLabel = formatMeetingTime(event, timezone);
  const attendeeNames = event.attendees
    .filter(a => !a.self)
    .map(a => a.displayName || a.email.split("@")[0])
    .slice(0, 3);

  // Build children for attendees and location. These children remain source-grounded to
  // the parent meeting for schema validity, but only matched attendees expose references.
  // Generic rows without explicit references render plain titles instead of synthesizing
  // duplicate meeting chips from the grounding source.
  const children: SimpleFeedItem[] = [];
  if (event.location) {
    children.push({
      id: `meeting-${event.accountId}-${event.id}-location`,
      section,
      widgetType: "generic",
      title: event.location,
      status: "active",
      sourceRefs: [sourceRef],
      payload: { kind: "meeting_location" },
    });
  }
  const externalAttendees = event.attendees.filter(a => !a.self);
  for (const attendee of externalAttendees.slice(0, 6)) {
    const matched = emailMap.get(attendee.email.toLowerCase());
    const name = matched?.name ?? (attendee.displayName || attendee.email.split("@")[0]);
    const personSourceRef: SimpleSourceRef | null = matched
      ? { type: "person", id: matched.id, label: matched.name, href: `/people/${matched.id}` }
      : null;
    children.push({
      id: `meeting-${event.accountId}-${event.id}-attendee-${attendee.email}`,
      section,
      widgetType: "generic",
      title: name,
      status: "active",
      sourceRefs: personSourceRef ? [personSourceRef] : [sourceRef],
      ...(personSourceRef ? { references: sourceRefsToReferenceRefs([personSourceRef]) } : {}),
      payload: {
        kind: "meeting_attendee",
        email: attendee.email,
        responseStatus: attendee.responseStatus || null,
        personId: matched?.id ?? null,
        profileSummary: matched?.summary ?? null,
        lastInteractionContext: matched?.lastInteractionContext ?? null,
      },
    });
  }

  for (const artifact of artifacts) {
    const artifactSourceRef: SimpleSourceRef = {
      type: "artifact",
      id: artifact.pageId,
      label: artifact.title,
      href: `/info#library?page=${encodeURIComponent(artifact.slug)}`,
    };
    children.push({
      id: `meeting-${event.accountId}-${event.id}-artifact-${artifact.linkId}`,
      section,
      widgetType: "generic",
      title: artifact.title,
      status: "active",
      sourceRefs: [artifactSourceRef],
      references: [{ type: "page", id: artifact.pageId, canonical: `@page:${artifact.pageId}`, metadata: { title: artifact.title, slug: artifact.slug } }],
      payload: {
        kind: "meeting_artifact",
        artifactKind: artifact.artifactKind,
        pageId: artifact.pageId,
        slug: artifact.slug,
        source: artifact.source,
        artifactSummary: artifact.summary,
        artifactOneLiner: artifact.oneLiner,
      },
      actions: [{ id: "open-artifact", label: "Open", type: "navigate", href: `/info#library?page=${encodeURIComponent(artifact.slug)}`, sourceRef: artifactSourceRef }],
    });
  }

  return {
    id: `meeting-${event.accountId}-${event.id}`,
    section,
    widgetType: "meeting",
    title: event.summary || "Untitled event",
    status: "active",
    priority: 5 + index,
    sourceRefs: [sourceRef],
    references: sourceRefsToReferenceRefs([sourceRef]),
    anchorTime: event.start.dateTime ?? event.start.date,
    actionTime: event.start.dateTime ?? event.start.date,
    time: timeLabel,
    children: children.length ? children : undefined,
    payload: {
      kind: "meeting",
      time: timeLabel,
      location: event.location || null,
      attendees: attendeeNames,
      attendeeCount: event.attendees.filter(a => !a.self).length,
      htmlLink: event.htmlLink || null,
      startDateTime: event.start.dateTime || null,
      endDateTime: event.end.dateTime || null,
      allDay: !event.start.dateTime,
      googleEventId: event.id,
      accountId: event.accountId,
      calendarId: event.calendarId,
      agentJoinEnabled: meta?.agentJoinEnabled ?? false,
      agentJoinStatus: meta?.agentJoinStatus ?? null,
      agentJoinDetail: meta?.agentJoinDetail ?? null,
      agentJoinSessionId: meta?.agentJoinSessionId ?? null,
    },
    actions: [
      { id: `open-meeting-${event.id}`, label: "Open in Calendar", type: "navigate", href: `/calendar`, sourceRef },
      ...(event.htmlLink ? [{ id: `gcal-meeting-${event.id}`, label: "Google Calendar", type: "navigate" as const, href: event.htmlLink, sourceRef }] : []),
    ],
  };
}

// ─── Milestones (independent) ───

function milestoneSection(milestone: Milestone, today: string, weekEnd: string, monthEnd: string, quarterEnd: string, yearEnd: string, nextYearEnd: string): SimpleSection {
  if (!milestone.dueDate) return "today"; // dateless milestones surface in today with needsDate flag
  if (milestone.dueDate < today) return "now"; // overdue
  if (milestone.dueDate <= weekEnd) return "this_week";
  const nextWeekEnd = addDays(weekEnd, 7);
  if (milestone.dueDate <= nextWeekEnd) return "next_week";
  if (milestone.dueDate <= monthEnd) return "this_month";
  const nextMonthEnd = endOfMonth(addDays(monthEnd, 1));
  if (milestone.dueDate <= nextMonthEnd) return "next_month";
  if (milestone.dueDate <= quarterEnd) return "this_quarter";
  const nextQuarterEnd = endOfQuarter(addDays(quarterEnd, 1));
  if (milestone.dueDate <= nextQuarterEnd) return "next_quarter";
  if (milestone.dueDate <= yearEnd) return "this_year";
  if (milestone.dueDate <= nextYearEnd) return "next_year";
  return "this_year"; // beyond next year remains clamped to this_year
}

function itemFromStandaloneMilestone(milestone: Milestone, project: Project, today: string, weekEnd: string, monthEnd: string, quarterEnd: string, yearEnd: string, nextYearEnd: string): SimpleFeedItem {
  const section: SimpleSection = milestone.status === "completed" ? "done" : milestoneSection(milestone, today, weekEnd, monthEnd, quarterEnd, yearEnd, nextYearEnd);
  const milestoneSourceRef: SimpleSourceRef = {
    type: "milestone",
    id: `${project.id}-${milestone.id}`,
    label: milestone.name,
    href: `/projects?project=${project.id}&milestone=${milestone.id}`,
  };
  const needsDate = milestone.status !== "completed" && !milestone.dueDate;
  const timeLabel = milestone.dueDate ? dateLabelForSection(milestone.dueDate, section) : undefined;
  return {
    id: `milestone-${project.id}-${milestone.id}`,
    section,
    widgetType: "generic",
    title: milestone.name,
    status: milestone.status === "completed" ? "completed" : "active",
    completedAt: milestone.status === "completed" ? milestone.completedAt ?? undefined : undefined,
    sourceRefs: [milestoneSourceRef],
    references: sourceRefsToReferenceRefs([milestoneSourceRef]),
    completable: milestone.status !== "completed",
    priority: 25,
    actionTime: milestone.dueDate ? `${milestone.dueDate}T17:00:00.000Z` : undefined,
    time: timeLabel,
    payload: {
      kind: "milestone",
      milestoneStatus: milestone.status,
      dueDate: milestone.dueDate,
      projectId: project.id,
      projectTitle: project.title,
      needsDate: needsDate || undefined,
    },
  };
}

// ─── Projects ───

function projectSection(project: Project, today: string, monthEnd: string, quarterEnd: string, yearEnd: string, nextYearEnd: string): SimpleSection {
  if (!project.dueDate) {
    // No deadline: active projects flagged, default to this_month
    return "this_month";
  }
  if (project.dueDate < today) return "now"; // overdue
  if (project.dueDate <= monthEnd) return "this_month";
  if (project.dueDate <= quarterEnd) return "this_quarter";
  if (project.dueDate <= yearEnd) return "this_year";
  if (project.dueDate <= nextYearEnd) return "next_year";
  return "this_year"; // beyond next year remains clamped to this_year
}


function sameSection(parentItem: SimpleFeedItem | undefined, childItem: SimpleFeedItem): parentItem is SimpleFeedItem {
  return Boolean(parentItem && parentItem.section === childItem.section);
}

function nestChild(parentItem: SimpleFeedItem, childItem: SimpleFeedItem): void {
  if (!parentItem.children) parentItem.children = [];
  parentItem.children.push(childItem);
}

function firstSameSection(childItem: SimpleFeedItem, ...parentItems: Array<SimpleFeedItem | undefined>): SimpleFeedItem | undefined {
  return parentItems.find(parentItem => sameSection(parentItem, childItem));
}

function itemFromProject(project: Project, section: SimpleSection, index: number): SimpleFeedItem {
  const sourceRef: SimpleSourceRef = {
    type: "project",
    id: String(project.id),
    label: project.title,
    href: `/projects?project=${project.id}`,
    observedAt: project.updatedAt,
  };
  const needsDate = !project.dueDate && project.status === "active";
  const timeLabel = project.dueDate ? dateLabelForSection(project.dueDate, section) : undefined;

  return {
    id: `project-${project.id}`,
    section,
    widgetType: "project",
    title: project.title,
    status: project.status === "completed" ? "completed" : "active",
    completedAt: project.status === "completed" ? project.completedAt ?? undefined : undefined,
    priority: 30 + index,
    sourceRefs: [sourceRef],
    references: sourceRefsToReferenceRefs([sourceRef]),
    actionTime: project.dueDate ? `${project.dueDate}T17:00:00.000Z` : undefined,
    time: timeLabel,
    payload: {
      kind: "project",
      status: project.status,
      projectPriority: project.priority,
      dueDate: project.dueDate,
      milestoneCount: project.milestones?.length ?? 0,
      activeMilestones: project.milestones?.filter(m => m.status === "active").length ?? 0,
      needsDate: needsDate || undefined,
    },
    actions: [
      { id: `open-project-${project.id}`, label: "Open project", type: "navigate", href: sourceRef.href, sourceRef },
    ],
  };
}

// ─── Main collector ───

export async function collectSimpleContext(): Promise<SimpleContextBundle> {
  const generatedAt = new Date().toISOString();
  const timezone = "America/Chicago";
  const today = todayInChicago();
  const tomorrow = addDays(today, 1);
  const weekEnd = endOfWeek(today, timezone);
  const monthEnd = endOfMonth(today);
  const quarterEnd = endOfQuarter(today);
  const yearEnd = endOfYear(today);
  const nextYearEnd = endOfNextYear(today);
  const items: SimpleFeedItem[] = [];
  const errors: Array<{ source: string; message: string }> = [];

  // Goals (by horizon)
  try {
    // Compute period keys for daily/weekly/monthly queries. Longer horizons are not period-key scoped.
    const currentWeek = isoWeekString(today);
    const currentMonth = today.slice(0, 7);

    const [dailyGoals, tomorrowGoals, weeklyGoals, monthlyGoals, quarterlyGoals, yearlyGoals, threeYearGoals, tenYearGoals, lifetimeGoals] = await Promise.all([
      goalsService.listAll({ horizon: "today", periodDate: today, periodScoped: true }),
      goalsService.listAll({ horizon: "today", periodDate: tomorrow, periodScoped: true }),
      goalsService.listAll({ horizon: "this_week", periodWeek: currentWeek, periodScoped: true }),
      goalsService.listAll({ horizon: "this_month", periodMonth: currentMonth, periodScoped: true }),
      goalsService.listAll({ horizon: "this_quarter", periodScoped: true }),
      goalsService.listAll({ horizon: "this_year", periodScoped: true }),
      goalsService.listAll({ horizon: "three_year", periodScoped: true }),
      goalsService.listAll({ horizon: "ten_year", periodScoped: true }),
      goalsService.listAll({ horizon: "lifetime", periodScoped: true }),
    ]);

    // Achieved goals stay in DONE only until the next calendar day, then drop from the feed.
    const doneVisible = (goal: GoalIndexEntry) => goal.status !== "achieved" || isTodayInTimezone(goal.completedAt, timezone);

    dailyGoals.filter(doneVisible).forEach((goal, index) => items.push(itemFromGoal(goal, index, "now")));

    // GoalStorage period filters intentionally carry active daily goals forward. That is
    // correct for the daily planning APIs, but Simple's TOMORROW lane is a calendar
    // preview: only goals explicitly scheduled for tomorrow belong there. Without this
    // exact-period boundary, today's active goals appear in both NOW and TOMORROW.
    tomorrowGoals
      .filter(goal => goal.periodDate === tomorrow)
      .forEach((goal, index) => {
        if (goal.status !== "achieved") items.push(itemFromGoal(goal, 5 + index, "tomorrow"));
      });
    weeklyGoals.filter(doneVisible).forEach((goal, index) => items.push(itemFromGoal(goal, 10 + index, "this_week")));
    monthlyGoals.filter(doneVisible).forEach((goal, index) => items.push(itemFromGoal(goal, 20 + index, "this_month")));
    quarterlyGoals.filter(doneVisible).forEach((goal, index) => items.push(itemFromGoal(goal, 30 + index)));
    yearlyGoals.filter(doneVisible).forEach((goal, index) => items.push(itemFromGoal(goal, 40 + index)));
    threeYearGoals.filter(doneVisible).forEach((goal, index) => items.push(itemFromGoal(goal, 50 + index)));
    tenYearGoals.filter(doneVisible).forEach((goal, index) => items.push(itemFromGoal(goal, 60 + index)));
    lifetimeGoals.filter(doneVisible).forEach((goal, index) => items.push(itemFromGoal(goal, 70 + index)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`goal collection failed: ${message}`);
    errors.push({ source: "goal", message });
  }

  // Build milestone lookup map from active projects (needed by tasks and milestones)
  let milestoneMap = new Map<string, Milestone>();
  let activeProjects: Project[] = [];
  let completedTodayProjects: Project[] = [];
  try {
    const allProjects = await fileProjectStorage.getProjects();
    activeProjects = allProjects.filter(p => p.status === "active" || p.status === "planning");
    completedTodayProjects = allProjects.filter(p => p.status === "completed" && isTodayInTimezone(p.completedAt, timezone));
    for (const project of activeProjects) {
      for (const milestone of project.milestones ?? []) {
        milestoneMap.set(`${project.id}-${milestone.id}`, milestone);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`project pre-load failed: ${message}`);
    errors.push({ source: "project", message });
  }

  // Tasks
  try {
    const [tasks, completedTasks] = await Promise.all([
      fileTaskStorage.getTodoTasks(),
      fileTaskStorage.getTasks({ status: "done" }),
    ]);
    tasks
      .filter(task => {
        // Skip tasks belonging to completed milestones — the milestone is done,
        // these orphan tasks would otherwise surface as overdue in NOW
        if (task.milestoneId && task.projectId != null) {
          const milestone = milestoneMap.get(`${task.projectId}-${task.milestoneId}`);
          if (milestone?.status === "completed") return false;
        }
        return true;
      })
      .forEach((task, index) => items.push(itemFromTask(task, today, tomorrow, weekEnd, monthEnd, quarterEnd, yearEnd, index, milestoneMap)));
    completedTasks
      .filter(task => isTodayInTimezone(task.updatedAt, timezone))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .forEach((task, index) => items.push({ ...itemFromTask(task, today, tomorrow, weekEnd, monthEnd, quarterEnd, yearEnd, 80 + index, milestoneMap), section: "done", status: "completed", completedAt: task.updatedAt }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`task collection failed: ${message}`);
    errors.push({ source: "task", message });
  }

  // Wellness
  try {
    const now = new Date();
    const activities = await queryActivityStatus();
    activities
      .map((activity, index) => ({ activity, section: wellnessSection(activity, now, timezone), index }))
      .filter((entry): entry is { activity: WellnessActivityStatus; section: SimpleSection; index: number } => entry.section != null)
      .sort((a, b) => {
        if (a.activity.doneForCurrentPeriod !== b.activity.doneForCurrentPeriod) return a.activity.doneForCurrentPeriod ? 1 : -1;
        if (a.activity.inWindow !== b.activity.inWindow) return a.activity.inWindow ? -1 : 1;
        return b.activity.urgency - a.activity.urgency;
      })
      .slice(0, 6)
      .forEach(({ activity, section }, index) => items.push(itemFromWellnessActivity(activity, section, index)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`wellness collection failed: ${message}`);
    errors.push({ source: "wellness", message });
  }

  // People (relationship follow-ups are visible but not immediate needs)
  try {
    const agendaPeople = await collectAgendaPeople();
    agendaPeople.forEach((person, index) => items.push(itemFromAgendaPerson(person, index)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`people agenda collection failed: ${message}`);
    errors.push({ source: "person", message });
  }

  // News (curated surfaced signals belong in the same inbox stream as surfaced people/pages)
  try {
    const surfacedNews = await signalStorage.listSignals({ status: "surfaced", limit: NEWS_INBOX_LIMIT, hasCuration: true });
    surfacedNews.items.forEach((signal, index) => items.push(itemFromNewsSignal(signal, index)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`news collection failed: ${message}`);
    errors.push({ source: "news", message });
  }

  // Email Review (enriched triaged threads needing attention)
  try {
    const emailReviewThreads = await collectEmailReviewThreads();
    emailReviewThreads.forEach((thread, index) => items.push(itemFromEmailReview(thread, index)));
    const emailDoneThreads = await collectEmailDoneToday();
    emailDoneThreads.forEach((thread, index) => items.push(itemFromEmailReview(thread, index, { done: true })));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`email review collection failed: ${message}`);
    errors.push({ source: "email", message });
  }

  // Meetings (calendar events for today through this week)
  try {
    const emailMap = await buildEmailPersonMap();
    const todayStart = `${today}T00:00:00-05:00`;
    const lookAhead = addDays(today, 7);
    const lookAheadEnd = `${lookAhead}T23:59:59-05:00`;
    const { events, errors: calErrors } = await listAllEvents({
      timeMin: todayStart,
      timeMax: lookAheadEnd,
      maxResults: 50,
    });
    for (const calErr of calErrors) {
      log.warn(`calendar account ${calErr.accountId} failed: ${calErr.message}`);
    }
    // Filter out cancelled events
    const relevant = events.filter(e => e.status !== "cancelled");

    // Batch-load metadata to identify focus blocks
    const metadataList = await listMetadataByEvents(
      relevant.map(e => ({ googleEventId: e.id, accountId: e.accountId, calendarId: e.calendarId }))
    );
    const metaByKey = new Map(
      metadataList.map(m => [`${m.googleEventId}::${m.accountId}::${m.calendarId}`, m])
    );
    const artifactsByMetadataId = await buildMeetingArtifactMap(metadataList.map(m => m.id));

    // Focus blocks only appear in the TODAY section — filter out future ones
    const visible = relevant.filter(event => {
      const meta = metaByKey.get(`${event.id}::${event.accountId}::${event.calendarId}`);
      const isFocus = meta?.eventType === "focus_block" || classifyEventByTitle(event.summary) === "focus_block";
      if (!isFocus) return true;
      const startDate = (event.start.dateTime ?? event.start.date ?? "").slice(0, 10);
      return startDate === today;
    });

    visible
      .slice(0, 15)
      .forEach((event, index) => {
        const section = meetingSection(event, today, tomorrow, weekEnd);
        const meta = metaByKey.get(`${event.id}::${event.accountId}::${event.calendarId}`);
        const artifacts = meta ? artifactsByMetadataId.get(meta.id) ?? [] : [];
        items.push(itemFromMeeting(event, section, index, timezone, emailMap, artifacts, meta));
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`meeting collection failed: ${message}`);
    errors.push({ source: "calendar", message });
  }

  // Projects (active/planning only, restricted to this_month/this_quarter)
  try {
    activeProjects.forEach((project, index) => {
      const section = projectSection(project, today, monthEnd, quarterEnd, yearEnd, nextYearEnd);
      items.push(itemFromProject(project, section, index));
    });
    // Projects completed today land in DONE until the next calendar day.
    completedTodayProjects.forEach((project, index) => items.push(itemFromProject(project, "done", index)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`project collection failed: ${message}`);
    errors.push({ source: "project", message });
  }

  // Milestones (independent items in this_week/this_month)
  try {
    for (const project of activeProjects) {
      for (const milestone of project.milestones ?? []) {
        // Milestones completed today land in DONE until the next calendar day; older completions drop out.
        if (milestone.status === "completed" && !isTodayInTimezone(milestone.completedAt, timezone)) continue;
        items.push(itemFromStandaloneMilestone(milestone, project, today, weekEnd, monthEnd, quarterEnd, yearEnd, nextYearEnd));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`milestone collection failed: ${message}`);
    errors.push({ source: "milestone", message });
  }

  // ─── Post-processing: build goal → project → milestone → task hierarchy ───
  const goalItemsById = new Map<string, SimpleFeedItem>();
  const projectItemsById = new Map<number, SimpleFeedItem>();
  const milestoneItemsByKey = new Map<string, SimpleFeedItem>();
  const projectById = new Map(activeProjects.map(project => [project.id, project] as const));
  const nestedItemIds = new Set<string>();

  for (const item of items) {
    if (item.payload?.kind === "goal") {
      const goalId = item.payload.goalId;
      if (typeof goalId === "string") goalItemsById.set(goalId, item);
    } else if (item.payload?.kind === "project") {
      const projectId = item.sourceRefs[0]?.id ? Number(item.sourceRefs[0].id) : null;
      if (projectId != null && Number.isFinite(projectId)) projectItemsById.set(projectId, item);
    } else if (item.payload?.kind === "milestone") {
      const key = item.sourceRefs[0]?.id; // "projectId-milestoneId"
      if (key) milestoneItemsByKey.set(key, item);
    }
  }

  for (const project of activeProjects) {
    if (!project.goalId) continue;
    const goalItem = goalItemsById.get(project.goalId);
    const projectItem = projectItemsById.get(project.id);
    if (projectItem && sameSection(goalItem, projectItem)) {
      nestChild(goalItem, projectItem);
      nestedItemIds.add(projectItem.id);
    }
  }

  for (const item of items) {
    if (item.payload?.kind !== "milestone") continue;
    const projectId = typeof item.payload.projectId === "number" ? item.payload.projectId : Number(item.payload.projectId);
    const project = Number.isFinite(projectId) ? projectById.get(projectId) : undefined;
    const projectItem = Number.isFinite(projectId) ? projectItemsById.get(projectId) : undefined;
    const goalItem = project?.goalId ? goalItemsById.get(project.goalId) : undefined;
    const parentItem = firstSameSection(item, projectItem, goalItem);
    if (!parentItem) continue;

    nestChild(parentItem, item);
    nestedItemIds.add(item.id);
  }

  for (const item of items) {
    if (item.payload?.kind !== "task") continue;
    const projectId = typeof item.payload.projectId === "number" ? item.payload.projectId : Number(item.payload.projectId);
    const milestoneId = typeof item.payload.milestoneId === "number" ? item.payload.milestoneId : Number(item.payload.milestoneId);
    const milestoneKey = Number.isFinite(projectId) && Number.isFinite(milestoneId) ? `${projectId}-${milestoneId}` : null;
    const milestoneItem = milestoneKey ? milestoneItemsByKey.get(milestoneKey) : undefined;
    const project = Number.isFinite(projectId) ? projectById.get(projectId) : undefined;
    const projectItem = Number.isFinite(projectId) ? projectItemsById.get(projectId) : undefined;
    const goalItem = project?.goalId ? goalItemsById.get(project.goalId) : undefined;
    const parentItem = firstSameSection(item, milestoneItem, projectItem, goalItem);
    if (!parentItem || parentItem.id === item.id) continue;

    const parentDate = parentItem.payload?.dueDate as string | undefined;
    const childDate = item.payload?.effectiveDeadline as string | undefined;
    const childItem = (parentDate && childDate && parentDate === childDate)
      ? { ...item, time: undefined }
      : item;
    nestChild(parentItem, childItem);
    nestedItemIds.add(item.id);
  }

  if (nestedItemIds.size > 0) {
    const before = items.length;
    items.splice(0, items.length, ...items.filter(item => !nestedItemIds.has(item.id)));
    log.debug(`nested ${nestedItemIds.size} Simple hierarchy children, items ${before} → ${items.length}`);
  }

  // Empty state fallback
  if (!items.length && !errors.length) {
    items.push({
      id: "state-quiet-now",
      section: "now",
      widgetType: "state",
      title: "Quiet now",
      status: "active",
      priority: 999,
      sourceRefs: [{ type: "agent", id: "simple-empty-state", label: "Simple empty state", observedAt: generatedAt }],
      references: sourceRefsToReferenceRefs([{ type: "agent", id: "simple-empty-state", label: "Simple empty state", observedAt: generatedAt }]),
      payload: { tone: "calm" },
    });
  }

  return { generatedAt, timezone, items, errors };
}
