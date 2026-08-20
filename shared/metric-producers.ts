/**
 * Client-safe closed Metric producer catalog for equation authoring pickers.
 * Server compile authority lives in server/metrics/producer-catalog.ts — keep keys aligned.
 */

export type MetricProducerFamily = "product" | "engagement" | "health" | "system" | "warehouse";

export type MetricProducerPickerItem = {
  key: string;
  label: string;
  family: MetricProducerFamily;
};

const OURA_METRIC_TYPES = [
  "daily_readiness",
  "daily_sleep",
  "sleep",
  "daily_activity",
  "workout",
  "session",
] as const;

function ouraLabel(metricType: string): string {
  return metricType.replace(/(^|_)([a-z])/g, (_m, p, l) => `${p ? " " : ""}${String(l).toUpperCase()}`);
}

/** Producers first (spec order), then Metrics in the picker. */
export const METRIC_PRODUCER_PICKER_ITEMS: readonly MetricProducerPickerItem[] = [
  { key: "hours-used", label: "Hours Used", family: "product" },
  { key: "active-users", label: "Active Users", family: "product" },
  { key: "current-users", label: "Current Users", family: "product" },
  { key: "new-users", label: "New Users", family: "product" },
  { key: "accounts", label: "Accounts", family: "product" },
  { key: "registered-users", label: "Users", family: "product" },
  { key: "shipped-prs", label: "Shipped PRs", family: "product" },
  { key: "user-memory", label: "User Memory", family: "product" },
  { key: "achieved-goals", label: "Achieved Goals (platform)", family: "product" },
  { key: "net-new-active-users", label: "Net New Active Users", family: "product" },
  { key: "mantra-meetings", label: "Meetings (company)", family: "product" },
  { key: "tasks", label: "Completed Tasks", family: "engagement" },
  { key: "interactions", label: "Opportunity Interactions", family: "engagement" },
  { key: "wellness", label: "Wellness Completions", family: "engagement" },
  { key: "goals", label: "Achieved Goals (personal)", family: "engagement" },
  { key: "meetings", label: "Meetings", family: "engagement" },
  ...OURA_METRIC_TYPES.map((key) => ({ key, label: ouraLabel(key), family: "health" as const })),
  { key: "performance", label: "Performance", family: "system" },
  { key: "manual", label: "Manual / warehouse", family: "warehouse" },
];

export const METRIC_PRODUCER_FAMILY_LABEL: Record<MetricProducerFamily, string> = {
  product: "Product producers",
  engagement: "Engagement producers",
  health: "Health producers",
  system: "System producers",
  warehouse: "Warehouse",
};

/** O(1) closed-key lookup for equation authoring highlight (not a registry type). */
export const METRIC_PRODUCER_KEYS: ReadonlySet<string> = new Set(
  METRIC_PRODUCER_PICKER_ITEMS.map((item) => item.key),
);
