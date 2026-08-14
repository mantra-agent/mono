import type { ReferenceType } from "@shared/references";
import { createLogger } from "@/lib/logger";

const logger = createLogger("ReferenceSearch");

export type ReferenceSuggestion = {
  type: ReferenceType;
  id: string;
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

export const REFERENCE_TYPE_LABELS: Record<string, string> = {
  page: "Page",
  person: "Person",
  tag: "Tag",
  company: "Company",
  goal: "Goal",
  task: "Task",
  project: "Project",
  metric: "Metric",
  kpi: "KPI",
  business_plan: "Business Plan",
  milestone: "Milestone",
  meeting: "Meeting",
  decision: "Decision",
  principle: "Principle",
  wellness_activity: "Wellness",
  priority: "Priority",
  file: "File",
  news: "News",
  web_article: "Web",
  x_item: "X",
  reddit_post: "Reddit",
  rss_item: "RSS",
  pr: "PR",
  router: "Router",
  account: "Account",
  user: "User",
  agent_instance: "Agent",
};

interface LibraryPageResult {
  id?: string;
  slug?: string;
  title?: string;
  oneLiner?: string;
  updatedAt?: string | Date;
  createdAt?: string | Date;
}

interface PersonResult {
  id?: string;
  slug?: string;
  name?: string;
  role?: string;
  company?: string;
  relation?: string;
  lastInteractionDate?: string;
  lastViewedAt?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface CompanyResult {
  id: string;
  name?: string;
  industry?: string;
  location?: string;
  updatedAt?: string | Date;
  createdAt?: string | Date;
}

interface TagResult {
  slug: string;
  label: string;
  color?: string | null;
  usageCount: number;
  updatedAt?: string | Date;
}

interface GoalResult {
  id: string;
  shortName?: string;
  title?: string;
  name?: string;
  domain?: string;
  updatedAt?: string | Date;
  createdAt?: string | Date;
  targetDate?: string;
}

interface TaskResult {
  id: number;
  title?: string;
  status?: string;
  updatedAt?: string | Date;
  createdAt?: string | Date;
  deadline?: string | null;
}

interface ProjectResult {
  id: number;
  title?: string;
  status?: string;
  updatedAt?: string | Date;
  createdAt?: string | Date;
}

interface MetricResult {
  id: string;
  name?: string;
  description?: string;
  unit?: string;
  updatedAt?: string | Date;
}

interface KpiResult {
  id: string;
  name?: string;
  description?: string;
  targetLabel?: string;
  updatedAt?: string | Date;
}

interface BusinessPlanResult {
  id: string;
  name?: string;
  vaultId?: string;
  updatedAt?: string | Date;
}

interface WellnessActivityResult {
  id?: number;
  name?: string;
  category?: string;
  updatedAt?: string | Date;
}

const MAX_RESULTS = 8;
const WORK_ITEM_TYPES = new Set<string>(["task", "project", "goal"]);
const MS_DAY = 86_400_000;
/** Keep ranking candidates above the final slice so recency can surface past first-N arrival order. */
const RANK_CANDIDATE_CAP = 64;

function normalizeSearchText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function toEpochMs(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const ms = new Date(value as string | Date).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function bestTimestamp(...values: unknown[]): number {
  return values.reduce<number>((best, value) => Math.max(best, toEpochMs(value)), 0);
}

function withRankMeta(
  suggestion: ReferenceSuggestion,
  opts: { rankAt?: unknown; linkScore?: number },
): ReferenceSuggestion {
  const rankAt = toEpochMs(opts.rankAt);
  const linkScore =
    typeof opts.linkScore === "number" && Number.isFinite(opts.linkScore)
      ? Math.max(0, opts.linkScore)
      : 0;
  return {
    ...suggestion,
    metadata: {
      ...suggestion.metadata,
      ...(rankAt > 0 ? { rankAt } : {}),
      ...(linkScore > 0 ? { linkScore } : {}),
    },
  };
}

export function matchesSuggestion(suggestion: ReferenceSuggestion, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [suggestion.type, suggestion.id, suggestion.label, suggestion.description].some(
    (value) => normalizeSearchText(value).includes(needle),
  );
}

/** Exact/prefix label matches beat loose substring hits. */
function matchQuality(suggestion: ReferenceSuggestion, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const label = normalizeSearchText(suggestion.label);
  const id = normalizeSearchText(suggestion.id);
  if (label === needle || id === needle) return 400;
  if (label.startsWith(needle) || id.startsWith(needle)) return 300;
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => label.includes(token))) return 220;
  if (label.includes(needle) || id.includes(needle)) return 160;
  if (normalizeSearchText(suggestion.description).includes(needle)) return 80;
  if (normalizeSearchText(suggestion.type).includes(needle)) return 20;
  return 0;
}

/** 0–120 from last activity. Half-life ~45 days keeps recent work ahead without burying history. */
function recencyScore(rankAtMs: number, nowMs: number): number {
  if (rankAtMs <= 0) return 0;
  const ageDays = Math.max(0, (nowMs - rankAtMs) / MS_DAY);
  return Math.round(120 * Math.exp(-ageDays / 45));
}

/** Connectivity proxy: tag usage today; reserved for graph degree when a cheap index exists. */
function linkScoreOf(suggestion: ReferenceSuggestion): number {
  const raw = suggestion.metadata?.linkScore;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(100, Math.round(18 * Math.log2(1 + raw)));
}

function typeBucketScore(type: ReferenceType, triggerChar: "@" | "#"): number {
  if (triggerChar === "#") {
    if (WORK_ITEM_TYPES.has(type)) return 50;
    if (type === "tag") return 30;
    return 0;
  }
  if (type === "person") return 50;
  if (type === "company") return 35;
  if (type === "page" || type === "goal" || type === "project" || type === "task") return 20;
  return 0;
}

function rankAtOf(suggestion: ReferenceSuggestion): number {
  return toEpochMs(suggestion.metadata?.rankAt);
}

export function uniqueSuggestions(suggestions: ReferenceSuggestion[]): ReferenceSuggestion[] {
  const seen = new Set<string>();
  const out: ReferenceSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (!suggestion.id) continue;
    const key = `${suggestion.type}:${suggestion.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
  }
  return out;
}

/**
 * Rank suggestions for the active trigger.
 * Score = match quality + type bucket + link proxy + recency.
 * Full memory-graph degree is intentionally not loaded on the keystroke path.
 */
export function sortSuggestionsByTrigger(
  suggestions: ReferenceSuggestion[],
  triggerChar: "@" | "#" = "@",
  query = "",
): ReferenceSuggestion[] {
  const nowMs = Date.now();
  return [...suggestions].sort((a, b) => {
    const scoreA =
      matchQuality(a, query) +
      typeBucketScore(a.type, triggerChar) +
      linkScoreOf(a) +
      recencyScore(rankAtOf(a), nowMs);
    const scoreB =
      matchQuality(b, query) +
      typeBucketScore(b.type, triggerChar) +
      linkScoreOf(b) +
      recencyScore(rankAtOf(b), nowMs);
    if (scoreB !== scoreA) return scoreB - scoreA;
    // Stable tie-break: newer first, then label.
    const recencyDiff = rankAtOf(b) - rankAtOf(a);
    if (recencyDiff !== 0) return recencyDiff;
    return a.label.localeCompare(b.label);
  });
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

/**
 * Normalize list payloads from heterogeneous reference search endpoints.
 * Some routes return bare arrays; others wrap them (`{ kpis }`, `{ goals }`, …).
 * A non-array body must never throw out of `for…of` and empty the whole picker.
 */
function asItemArray<T>(value: unknown, keys: string[] = []): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested as T[];
  }
  return [];
}

export type LoadReferenceSuggestionsOptions = {
  query: string;
  signal: AbortSignal;
  allowedTypes?: ReferenceType[];
  triggerChar?: "@" | "#";
  limit?: number;
};

/**
 * Canonical multi-type reference search used by chat mentions, field pickers,
 * and the Design playground. One search path — every surface filters/sorts.
 */
export async function loadReferenceSuggestions(
  options: LoadReferenceSuggestionsOptions,
): Promise<ReferenceSuggestion[]> {
  const { query, signal, allowedTypes, triggerChar = "@", limit = MAX_RESULTS } = options;
  const encoded = encodeURIComponent(query || "");
  const typeSet = allowedTypes?.length ? new Set(allowedTypes) : null;
  const allow = (type: ReferenceType) => !typeSet || typeSet.has(type);

  logger.debug("search", { query, allowedTypes, triggerChar });

  const [library, people, tags, companies, goals, tasks, projects, metrics, kpis, businessPlans, wellnessActivities, routers] =
    await Promise.all([
      allow("page") && query
        ? fetchJson<unknown>(`/api/info/library?search=${encoded}`, signal)
        : Promise.resolve(null),
      allow("person") && query
        ? fetchJson<unknown>(`/api/people/search?q=${encoded}`, signal)
        : Promise.resolve(null),
      allow("tag")
        ? fetchJson<unknown>(`/api/tags/search?q=${encoded}&limit=${Math.max(limit, 20)}`, signal)
        : Promise.resolve(null),
      allow("company")
        ? fetchJson<unknown>(`/api/companies${query ? `?q=${encoded}` : ""}`, signal)
        : Promise.resolve(null),
      allow("goal")
        ? fetchJson<unknown>(`/api/life-goals${query ? `?search=${encoded}` : ""}`, signal)
        : Promise.resolve(null),
      allow("task")
        ? fetchJson<unknown>(`/api/projects/tasks`, signal)
        : Promise.resolve(null),
      allow("project")
        ? fetchJson<unknown>(`/api/projects/projects`, signal)
        : Promise.resolve(null),
      allow("metric")
        ? fetchJson<unknown>(
            `/api/business/metrics${query ? `?query=${encoded}` : ""}`,
            signal,
          )
        : Promise.resolve(null),
      // KPI list is canonically `{ kpis: [...] }`; search param is `query`, not `q`.
      allow("kpi")
        ? fetchJson<unknown>(
            `/api/business/kpis${query ? `?query=${encoded}` : ""}`,
            signal,
          )
        : Promise.resolve(null),
      allow("business_plan")
        ? fetchJson<unknown>("/api/business/plans", signal)
        : Promise.resolve(null),
      allow("wellness_activity")
        ? fetchJson<unknown>(`/api/wellness/activities`, signal)
        : Promise.resolve(null),
      allow("router")
        ? fetchJson<unknown>("/api/routers", signal)
        : Promise.resolve(null),
    ]);

  const suggestions: ReferenceSuggestion[] = [];

  for (const page of asItemArray<LibraryPageResult>(library)) {
    const refId = page.slug || page.id;
    if (!refId) continue;
    suggestions.push(
      withRankMeta(
        {
          type: "page",
          id: String(refId),
          label: String(page.title || page.oneLiner || refId),
          description: "Library page",
        },
        { rankAt: bestTimestamp(page.updatedAt, page.createdAt) },
      ),
    );
  }

  for (const person of asItemArray<PersonResult>(people, ["people"])) {
    suggestions.push(
      withRankMeta(
        {
          type: "person",
          id: String(person.id || person.slug || person.name),
          label: String(person.name || person.id),
          description:
            [person.role, person.company].filter(Boolean).join(" at ") ||
            person.relation ||
            "Person",
        },
        {
          rankAt: bestTimestamp(
            person.lastInteractionDate,
            person.lastViewedAt,
            person.updatedAt,
            person.createdAt,
          ),
        },
      ),
    );
  }

  for (const tag of asItemArray<TagResult>(tags, ["tags"])) {
    if (!tag?.slug) continue;
    suggestions.push(
      withRankMeta(
        {
          type: "tag",
          id: tag.slug,
          label: tag.label,
          description: `Tag · ${tag.usageCount} ${tag.usageCount === 1 ? "usage" : "usages"}`,
          metadata: tag.color ? { color: tag.color } : undefined,
        },
        {
          rankAt: tag.updatedAt,
          // Tag usage is the only cheap connectivity signal on the keystroke path today.
          linkScore: tag.usageCount,
        },
      ),
    );
  }

  for (const company of asItemArray<CompanyResult>(companies, ["companies"])) {
    suggestions.push(
      withRankMeta(
        {
          type: "company",
          id: String(company.id),
          label: String(company.name || company.id),
          description:
            [company.industry, company.location].filter(Boolean).join(" · ") || "Company",
        },
        { rankAt: bestTimestamp(company.updatedAt, company.createdAt) },
      ),
    );
  }

  for (const goal of asItemArray<GoalResult>(goals, ["goals"])) {
    suggestions.push(
      withRankMeta(
        {
          type: "goal",
          id: String(goal.id),
          label: String(goal.shortName || goal.title || goal.name || goal.id),
          description: goal.domain || "Goal",
        },
        { rankAt: bestTimestamp(goal.updatedAt, goal.targetDate, goal.createdAt) },
      ),
    );
  }

  for (const task of asItemArray<TaskResult>(tasks, ["tasks"])) {
    suggestions.push(
      withRankMeta(
        {
          type: "task",
          id: String(task.id),
          label: String(task.title || task.id),
          description: task.status ? `Task · ${task.status}` : "Task",
        },
        { rankAt: bestTimestamp(task.updatedAt, task.deadline, task.createdAt) },
      ),
    );
  }

  for (const project of asItemArray<ProjectResult>(projects, ["projects"])) {
    suggestions.push(
      withRankMeta(
        {
          type: "project",
          id: String(project.id),
          label: String(project.title || project.id),
          description: project.status ? `Project · ${project.status}` : "Project",
        },
        { rankAt: bestTimestamp(project.updatedAt, project.createdAt) },
      ),
    );
  }

  for (const metric of asItemArray<MetricResult>(metrics, ["metrics"])) {
    if (!metric?.id) continue;
    suggestions.push(
      withRankMeta(
        {
          type: "metric",
          id: metric.id,
          label: metric.name || metric.id,
          description: metric.description || metric.unit || "Metric",
        },
        { rankAt: metric.updatedAt },
      ),
    );
  }

  for (const kpi of asItemArray<KpiResult>(kpis, ["kpis"])) {
    if (!kpi?.id) continue;
    suggestions.push(
      withRankMeta(
        {
          type: "kpi",
          id: kpi.id,
          label: kpi.name || kpi.id,
          description: kpi.targetLabel || kpi.description || "KPI",
        },
        { rankAt: kpi.updatedAt },
      ),
    );
  }

  for (const plan of asItemArray<BusinessPlanResult>(businessPlans, ["plans", "businessPlans"])) {
    if (!plan?.id) continue;
    suggestions.push(
      withRankMeta(
        {
          type: "business_plan",
          id: plan.id,
          label: plan.name || plan.id,
          description: "Business Plan",
          metadata: plan.vaultId ? { vaultId: plan.vaultId } : undefined,
        },
        { rankAt: plan.updatedAt },
      ),
    );
  }

  for (const activity of asItemArray<WellnessActivityResult>(wellnessActivities, [
    "activities",
    "wellnessActivities",
  ])) {
    suggestions.push(
      withRankMeta(
        {
          type: "wellness_activity",
          id: String(activity.id ?? activity.name),
          label: String(activity.name || activity.id),
          description: activity.category ? `Wellness · ${activity.category}` : "Wellness activity",
        },
        { rankAt: activity.updatedAt },
      ),
    );
  }

  for (const router of asItemArray<{ id: string; name: string; isDefault?: boolean; updatedAt?: string }>(routers, ["routers"])) {
    if (!router?.id) continue;
    suggestions.push(
      withRankMeta(
        {
          type: "router",
          id: router.id,
          label: router.name || router.id,
          description: router.isDefault ? "Default Router" : "Router",
        },
        { rankAt: router.updatedAt },
      ),
    );
  }

  const matched = uniqueSuggestions(
    suggestions.filter((s) => matchesSuggestion(s, query) && allow(s.type)),
  ).slice(0, RANK_CANDIDATE_CAP);

  const ranked = sortSuggestionsByTrigger(matched, triggerChar, query).slice(0, limit);

  logger.debug("suggestions", { count: ranked.length, candidates: matched.length });
  return ranked;
}
