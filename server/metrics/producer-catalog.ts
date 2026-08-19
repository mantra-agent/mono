/**
 * Closed Metric producer tokens for equation authoring.
 *
 * Code owns the token set. Data owns which Metric uses which producer.
 * Producers are not REFERENCE_REGISTRY types and are not chat-mentionable.
 */
import {
  metricAdapterKeyOf,
  type Metric,
  type MetricAdapterKind,
} from "@shared/models/metrics";

export type MetricProducerFamily = "product" | "engagement" | "health" | "system" | "warehouse";

export type MetricProducerDefinition = {
  key: string;
  label: string;
  family: MetricProducerFamily;
  /** Existing adapterKey used by queryMetric dispatch. */
  adapterKey: string;
  /** Derived adapter_kind column value for this leaf. */
  adapterKind: MetricAdapterKind;
  /** Extra adapterConfig fields stamped at compile (beyond adapterKey / equation / plan). */
  binding?: Record<string, unknown>;
};

/** Product grain — maps onto handleProduct via adapterKey product + key/slug. */
const PRODUCT_PRODUCERS: MetricProducerDefinition[] = [
  { key: "hours-used", label: "Hours Used", family: "product", adapterKey: "product", adapterKind: "internal", binding: { key: "hours-used" } },
  { key: "active-users", label: "Active Users", family: "product", adapterKey: "product", adapterKind: "internal", binding: { key: "active-users" } },
  { key: "current-users", label: "Current Users", family: "product", adapterKey: "product", adapterKind: "internal", binding: { key: "current-users" } },
  { key: "new-users", label: "New Users", family: "product", adapterKey: "product", adapterKind: "internal", binding: { key: "new-users" } },
  { key: "accounts", label: "Accounts", family: "product", adapterKey: "product", adapterKind: "internal", binding: { key: "accounts" } },
  { key: "registered-users", label: "Users", family: "product", adapterKey: "product", adapterKind: "internal", binding: { key: "registered-users" } },
  { key: "shipped-prs", label: "Shipped PRs", family: "product", adapterKey: "product", adapterKind: "internal", binding: { key: "shipped-prs" } },
  { key: "user-memory", label: "User Memory", family: "product", adapterKey: "product", adapterKind: "internal", binding: { key: "user-memory" } },
  { key: "achieved-goals", label: "Achieved Goals (platform)", family: "product", adapterKey: "product", adapterKind: "internal", binding: { key: "achieved-goals" } },
];

const ENGAGEMENT_PRODUCERS: MetricProducerDefinition[] = [
  { key: "tasks", label: "Completed Tasks", family: "engagement", adapterKey: "tasks", adapterKind: "internal" },
  { key: "interactions", label: "Opportunity Interactions", family: "engagement", adapterKey: "interactions", adapterKind: "internal" },
  { key: "wellness", label: "Wellness Completions", family: "engagement", adapterKey: "wellness", adapterKind: "internal" },
  { key: "goals", label: "Achieved Goals (personal)", family: "engagement", adapterKey: "goals", adapterKind: "internal" },
  { key: "meetings", label: "Meetings", family: "engagement", adapterKey: "meetings", adapterKind: "internal", binding: { key: "meetings" } },
];

/**
 * Oura series keys already stamped on health rows (webhook data types).
 * Authoring uses the bare metricType token; binding carries metricType.
 */
const OURA_METRIC_TYPES = [
  "daily_readiness",
  "daily_sleep",
  "sleep",
  "daily_activity",
  "workout",
  "session",
] as const;

const HEALTH_PRODUCERS: MetricProducerDefinition[] = OURA_METRIC_TYPES.map((metricType) => ({
  key: metricType,
  label: metricType.replace(/(^|_)([a-z])/g, (_m, p, l) => `${p ? " " : ""}${String(l).toUpperCase()}`),
  family: "health" as const,
  adapterKey: "oura",
  adapterKind: "internal" as const,
  binding: { source: "oura", metricType },
}));

const SYSTEM_PRODUCERS: MetricProducerDefinition[] = [
  {
    key: "performance",
    label: "Performance",
    family: "system",
    adapterKey: "performance",
    adapterKind: "internal",
  },
];

const WAREHOUSE_PRODUCERS: MetricProducerDefinition[] = [
  {
    key: "manual",
    label: "Manual / warehouse",
    family: "warehouse",
    adapterKey: "manual",
    adapterKind: "manual",
  },
];

export const METRIC_PRODUCER_CATALOG: readonly MetricProducerDefinition[] = [
  ...PRODUCT_PRODUCERS,
  ...ENGAGEMENT_PRODUCERS,
  ...HEALTH_PRODUCERS,
  ...SYSTEM_PRODUCERS,
  ...WAREHOUSE_PRODUCERS,
];

const BY_KEY = new Map(METRIC_PRODUCER_CATALOG.map((p) => [p.key, p]));

export function isClosedProducerKey(key: string): boolean {
  return BY_KEY.has(key.trim());
}

export function getProducerDefinition(key: string): MetricProducerDefinition | undefined {
  return BY_KEY.get(key.trim());
}

/** Client-safe picker projection (no server-only binding internals required). */
export function listMetricProducersForPicker(): Array<{
  key: string;
  label: string;
  family: MetricProducerFamily;
}> {
  return METRIC_PRODUCER_CATALOG.map(({ key, label, family }) => ({ key, label, family }));
}

/**
 * Derive the producer token that should be stamped on a provisioned leaf row.
 * Prefer explicit slug/key matches; fall through to adapter family tokens.
 */
export function producerKeyForMetric(metric: Pick<Metric, "slug" | "ownerKind" | "adapterKind" | "adapterConfig">): string | null {
  const config = metric.adapterConfig ?? {};
  const slug = metric.slug;

  if (BY_KEY.has(slug)) return slug;

  const configKey = typeof config.key === "string" ? config.key.trim() : "";
  if (configKey && BY_KEY.has(configKey)) return configKey;

  const metricType = typeof config.metricType === "string" ? config.metricType.trim() : "";
  if (metricType && BY_KEY.has(metricType)) return metricType;

  const adapterKey = metricAdapterKeyOf(metric);
  if (adapterKey === "tasks") return "tasks";
  if (adapterKey === "interactions") return "interactions";
  if (adapterKey === "wellness") return "wellness";
  if (adapterKey === "goals") return "goals";
  if (adapterKey === "meetings") return "meetings";
  if (adapterKey === "performance") return "performance";
  if (adapterKey === "product" && BY_KEY.has(slug)) return slug;
  if (adapterKey === "oura" && metricType) return metricType;
  if (metric.adapterKind === "manual" || !adapterKey) return "manual";
  return null;
}

export function buildProducerAdapterConfig(
  definition: MetricProducerDefinition,
  equation: string,
): Record<string, unknown> {
  return {
    ...(definition.binding ?? {}),
    adapterKey: definition.adapterKey,
    equation,
    plan: { type: "producer", key: definition.key },
    producerKey: definition.key,
  };
}
