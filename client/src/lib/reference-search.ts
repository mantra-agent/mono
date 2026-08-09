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
};

interface LibraryPageResult {
  id?: string;
  slug?: string;
  title?: string;
  oneLiner?: string;
}

interface PersonResult {
  id?: string;
  slug?: string;
  name?: string;
  role?: string;
  company?: string;
  relation?: string;
}

interface CompanyResult {
  id: string;
  name?: string;
  industry?: string;
  location?: string;
}

interface TagResult {
  slug: string;
  label: string;
  color?: string | null;
  usageCount: number;
}

interface GoalResult {
  id: string;
  shortName?: string;
  title?: string;
  name?: string;
  domain?: string;
}

interface TaskResult {
  id: number;
  title?: string;
  status?: string;
}

interface ProjectResult {
  id: number;
  title?: string;
  status?: string;
}
interface KpiResult {
  id: string;
  name?: string;
  description?: string;
  targetLabel?: string;
}

interface BusinessPlanResult {
  id: string;
  name?: string;
  vaultId?: string;
}

interface WellnessActivityResult {
  id?: number;
  name?: string;
  category?: string;
}

const MAX_RESULTS = 8;
const WORK_ITEM_TYPES = new Set<string>(["task", "project", "goal"]);

function normalizeSearchText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function matchesSuggestion(suggestion: ReferenceSuggestion, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [suggestion.type, suggestion.id, suggestion.label, suggestion.description].some(
    (value) => normalizeSearchText(value).includes(needle),
  );
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
  return out.slice(0, MAX_RESULTS);
}

export function sortSuggestionsByTrigger(
  suggestions: ReferenceSuggestion[],
  triggerChar: "@" | "#" = "@",
): ReferenceSuggestion[] {
  if (triggerChar === "@") {
    return [
      ...suggestions.filter((s) => s.type === "person"),
      ...suggestions.filter((s) => s.type === "company"),
      ...suggestions.filter((s) => s.type !== "person" && s.type !== "company"),
    ];
  }
  return [
    ...suggestions.filter((s) => WORK_ITEM_TYPES.has(s.type)),
    ...suggestions.filter((s) => !WORK_ITEM_TYPES.has(s.type)),
  ];
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

  const [library, people, tags, companies, goals, tasks, projects, kpis, businessPlans, wellnessActivities] =
    await Promise.all([
      allow("page") && query
        ? fetchJson<unknown>(`/api/info/library?search=${encoded}`, signal)
        : Promise.resolve(null),
      allow("person") && query
        ? fetchJson<unknown>(`/api/people/search?q=${encoded}`, signal)
        : Promise.resolve(null),
      allow("tag")
        ? fetchJson<unknown>(`/api/tags/search?q=${encoded}&limit=${limit}`, signal)
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
    ]);

  const suggestions: ReferenceSuggestion[] = [];

  for (const page of asItemArray<LibraryPageResult>(library)) {
    const refId = page.slug || page.id;
    if (!refId) continue;
    suggestions.push({
      type: "page",
      id: String(refId),
      label: String(page.title || page.oneLiner || refId),
      description: "Library page",
    });
  }

  for (const person of asItemArray<PersonResult>(people, ["people"])) {
    suggestions.push({
      type: "person",
      id: String(person.id || person.slug || person.name),
      label: String(person.name || person.id),
      description:
        [person.role, person.company].filter(Boolean).join(" at ") || person.relation || "Person",
    });
  }

  for (const tag of asItemArray<TagResult>(tags, ["tags"])) {
    if (!tag?.slug) continue;
    suggestions.push({
      type: "tag",
      id: tag.slug,
      label: tag.label,
      description: `Tag · ${tag.usageCount} ${tag.usageCount === 1 ? "usage" : "usages"}`,
      metadata: tag.color ? { color: tag.color } : undefined,
    });
  }

  for (const company of asItemArray<CompanyResult>(companies, ["companies"])) {
    suggestions.push({
      type: "company",
      id: String(company.id),
      label: String(company.name || company.id),
      description: [company.industry, company.location].filter(Boolean).join(" · ") || "Company",
    });
  }

  for (const goal of asItemArray<GoalResult>(goals, ["goals"])) {
    suggestions.push({
      type: "goal",
      id: String(goal.id),
      label: String(goal.shortName || goal.title || goal.name || goal.id),
      description: goal.domain || "Goal",
    });
  }

  for (const task of asItemArray<TaskResult>(tasks, ["tasks"])) {
    suggestions.push({
      type: "task",
      id: String(task.id),
      label: String(task.title || task.id),
      description: task.status ? `Task · ${task.status}` : "Task",
    });
  }

  for (const project of asItemArray<ProjectResult>(projects, ["projects"])) {
    suggestions.push({
      type: "project",
      id: String(project.id),
      label: String(project.title || project.id),
      description: project.status ? `Project · ${project.status}` : "Project",
    });
  }

  for (const kpi of asItemArray<KpiResult>(kpis, ["kpis"])) {
    if (!kpi?.id) continue;
    suggestions.push({
      type: "kpi",
      id: kpi.id,
      label: kpi.name || kpi.id,
      description: kpi.targetLabel || kpi.description || "KPI",
    });
  }

  for (const plan of asItemArray<BusinessPlanResult>(businessPlans, ["plans", "businessPlans"])) {
    if (!plan?.id) continue;
    suggestions.push({
      type: "business_plan",
      id: plan.id,
      label: plan.name || plan.id,
      description: "Business Plan",
      metadata: plan.vaultId ? { vaultId: plan.vaultId } : undefined,
    });
  }

  for (const activity of asItemArray<WellnessActivityResult>(wellnessActivities, [
    "activities",
    "wellnessActivities",
  ])) {
    suggestions.push({
      type: "wellness_activity",
      id: String(activity.id ?? activity.name),
      label: String(activity.name || activity.id),
      description: activity.category ? `Wellness · ${activity.category}` : "Wellness activity",
    });
  }

  const filtered = uniqueSuggestions(
    suggestions.filter((s) => matchesSuggestion(s, query) && allow(s.type)),
  ).slice(0, limit);

  logger.debug("suggestions", { count: filtered.length });
  return sortSuggestionsByTrigger(filtered, triggerChar);
}
