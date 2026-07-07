import type { ReferenceRef } from "../references";

export const SIMPLE_SECTIONS = [
  "earlier",
  "now",
  "inbox",
  "today",
  "tomorrow",
  "this_week",
  "next_week",
  "this_month",
  "next_month",
  "this_quarter",
  "next_quarter",
  "this_year",
  "next_year",
  "three_years",
  "lifetime",
  "done",
  "snoozed",
] as const;

export type SimpleSection = typeof SIMPLE_SECTIONS[number];

export const SIMPLE_SOURCE_TYPES = [
  "calendar",
  "wellness",
  "comms",
  "priority",
  "task",
  "project",
  "milestone",
  "goal",
  "decision",
  "person",
  "finance",
  "agent",
  "artifact",
  "email",
  "news",
] as const;

export type SimpleSourceType = typeof SIMPLE_SOURCE_TYPES[number];

export interface SimpleSourceRef {
  type: SimpleSourceType;
  id: string;
  label?: string;
  href?: string;
  observedAt?: string;
}

export const SIMPLE_WIDGET_TYPES = [
  "meeting",
  "priority_task",
  "person",
  "wellness",
  "decision_prompt",
  "communication",
  "project",
  "inbox_item",
  "state",
  "generic",
] as const;

export type SimpleWidgetType = typeof SIMPLE_WIDGET_TYPES[number];

export interface SimpleAction {
  id: string;
  label: string;
  type: "navigate" | "complete" | "log" | "discuss" | "open_source";
  href?: string;
  sourceRef?: SimpleSourceRef;
  payload?: Record<string, unknown>;
}

export interface SimpleFeedItem {
  id: string;
  section: SimpleSection;
  widgetType: SimpleWidgetType;
  title: string;
  status?: "active" | "completed" | "dismissed" | "stale";
  priority?: number;
  sourceRefs: SimpleSourceRef[];
  references?: ReferenceRef[];
  payload: Record<string, unknown>;
  actions?: SimpleAction[];
  completedAt?: string;
  anchorTime?: string;
  actionTime?: string;
  /** Pre-formatted display time/date for the left metadata column (e.g. "1:30 PM" or "MON, 5/23") */
  time?: string;
  /** Nested child items for hierarchy display */
  children?: SimpleFeedItem[];
  /** Whether this item can be checked off */
  completable?: boolean;
}

/** Linked plan artifact for a horizon section (e.g. weekly plan, monthly plan). */
export interface SectionPlanArtifact {
  pageId: string;
  pageSlug: string;
  title: string;
}

export interface SimpleFeedSection {
  section: SimpleSection;
  items: SimpleFeedItem[];
  /** Linked plan artifact for this horizon, or null if none exists yet. */
  planArtifact?: SectionPlanArtifact | null;
  /** Skill name to run to generate the plan artifact (null = no skill available). */
  planSkillName?: string | null;
  /** Cadence parameter passed to the parameterized Plan skill. */
  planCadence?: "daily" | "weekly" | "monthly" | "quarterly" | null;
}

export interface SimpleFeed {
  id: string;
  generatedAt: string;
  timezone: string;
  anchor: "now";
  sections: SimpleFeedSection[];
  stale?: boolean;
  degraded?: boolean;
  errors?: Array<{ source: string; message: string }>;
}

/** Static fallback labels — prefer dynamicSectionLabel() for display. */
export const SIMPLE_SECTION_LABELS: Record<SimpleSection, string> = {
  earlier: "Earlier",
  now: "Now",
  inbox: "Inbox",
  today: "Today",
  tomorrow: "Tomorrow",
  this_week: "This Week",
  next_week: "Next Week",
  this_month: "This Month",
  next_month: "Next Month",
  this_quarter: "This Quarter",
  next_quarter: "Next Quarter",
  this_year: "This Year",
  next_year: "Next Year",
  three_years: "3 Years",
  lifetime: "Lifetime",
  done: "DONE",
  snoozed: "Snoozed",
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/**
 * Returns a contextual, human-friendly section label.
 * "now" → "TODAY, WED, JULY 1"
 * "this_month" → "June"
 * "this_quarter" → "Q3"
 * "next_quarter" → "Q4"
 * "this_year" → "2026"
 * "next_year" → "2027"
 * "three_years" → "2029"
 */
export function dynamicSectionLabel(section: SimpleSection, now?: Date, timezone = "America/Chicago"): string {
  const d = now ?? new Date();

  // Use Intl to get local date parts in the target timezone
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";

  // Get the current hour in the target timezone for time-of-day labels
  const hourParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);
  const hour = Number(hourParts.find(p => p.type === "hour")?.value ?? "12");

  switch (section) {
    case "now": {
      const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(d).toUpperCase();
      const month = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "long" }).format(d).toUpperCase();
      return `TODAY, ${weekday}, ${month} ${get("day")}`;
    }
    case "today": {
      // Show the NEXT time-of-day period (Now already covers current)
      if (hour < 12) return "Afternoon";
      if (hour < 18) return "Tonight";
      // Evening: no next period — section should be merged into "now" by the feed generator
      return "Tonight";
    }
    case "this_month": {
      const monthIdx = Number(get("month")) - 1;
      return MONTHS[monthIdx] ?? SIMPLE_SECTION_LABELS.this_month;
    }
    case "next_month": {
      const nextMonthIdx = Number(get("month")) % 12; // current month (1-indexed) becomes 0-indexed next month
      return MONTHS[nextMonthIdx] ?? SIMPLE_SECTION_LABELS.next_month;
    }
    case "this_quarter": {
      const q = Math.ceil(Number(get("month")) / 3);
      return `Q${q}`;
    }
    case "next_quarter": {
      const curQ = Math.ceil(Number(get("month")) / 3);
      const nextQ = curQ >= 4 ? 1 : curQ + 1;
      return `Q${nextQ}`;
    }
    case "this_year":
      return get("year") || SIMPLE_SECTION_LABELS.this_year;
    case "next_year": {
      const year = Number(get("year"));
      return Number.isFinite(year) ? String(year + 1) : SIMPLE_SECTION_LABELS.next_year;
    }
    case "three_years": {
      const year = Number(get("year"));
      return Number.isFinite(year) ? String(year + 3) : SIMPLE_SECTION_LABELS.three_years;
    }
    default:
      return SIMPLE_SECTION_LABELS[section];
  }
}
