import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeReferenceType, serializeReference, type ReferenceType } from "@shared/references";
import { createLogger } from "@/lib/logger";

const logger = createLogger("MentionAutocomplete");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReferenceSuggestion = {
  type: ReferenceType;
  id: string;
  label: string;
  description?: string;
};

export type ReferenceTrigger = {
  start: number;
  query: string;
  triggerChar: "@" | "#";
};

export const REFERENCE_TYPE_LABELS: Record<string, string> = {
  page: "Page",
  person: "Person",
  company: "Company",
  goal: "Goal",
  task: "Task",
  project: "Project",
  milestone: "Milestone",
  meeting: "Meeting",

  decision: "Decision",
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

// ---------------------------------------------------------------------------
// API response interfaces (minimal shapes consumed by this hook)
// ---------------------------------------------------------------------------

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

interface WellnessActivityResult {
  id?: number;
  name?: string;
  category?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSearchText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Detect a mention trigger (`@` or `#`) from the text before the cursor.
 * When both characters are present, the one closest to the cursor wins.
 */
export function findReferenceTrigger(value: string, cursor: number): ReferenceTrigger | null {
  const beforeCursor = value.slice(0, cursor);
  let best: ReferenceTrigger | null = null;
  for (const char of ["@", "#"] as const) {
    const pos = beforeCursor.lastIndexOf(char);
    if (pos === -1) continue;
    const beforeChar = pos === 0 ? " " : beforeCursor[pos - 1];
    if (!/\s|[(\[{]/.test(beforeChar)) continue;
    const query = beforeCursor.slice(pos + 1);
    if (/\s|[`]/.test(query)) continue;
    if (query.includes(":")) continue;
    const candidate: ReferenceTrigger = { start: pos, query, triggerChar: char };
    if (!best || pos > best.start) best = candidate;
  }
  return best;
}

function matchesSuggestion(suggestion: ReferenceSuggestion, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [suggestion.type, suggestion.id, suggestion.label, suggestion.description].some(
    (value) => normalizeSearchText(value).includes(needle),
  );
}

function uniqueSuggestions(suggestions: ReferenceSuggestion[]): ReferenceSuggestion[] {
  const seen = new Set<string>();
  const out: ReferenceSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (!suggestion.id) continue;
    const key = `${suggestion.type}:${suggestion.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
  }
  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

/** Work-item types that surface first when the `#` trigger is used. */
const WORK_ITEM_TYPES = new Set<string>(["task", "project", "goal"]);

function sortByTrigger(
  suggestions: ReferenceSuggestion[],
  triggerChar: "@" | "#",
): ReferenceSuggestion[] {
  if (triggerChar === "@") {
    // People first
    return [
      ...suggestions.filter((s) => s.type === "person"),
      ...suggestions.filter((s) => s.type === "company"),
      ...suggestions.filter((s) => s.type !== "person" && s.type !== "company"),
    ];
  }
  // # — work items first
  return [
    ...suggestions.filter((s) => WORK_ITEM_TYPES.has(s.type)),
    ...suggestions.filter((s) => !WORK_ITEM_TYPES.has(s.type)),
  ];
}

async function loadReferenceSuggestions(
  query: string,
  signal: AbortSignal,
): Promise<ReferenceSuggestion[]> {
  const encoded = encodeURIComponent(query || "");

  logger.debug("trigger", { query });

  const [library, people, companies, goals, tasks, projects, wellnessActivities] =
    await Promise.all([
      query
        ? fetchJson<LibraryPageResult[]>(`/api/info/library?search=${encoded}`, signal)
        : Promise.resolve(null),
      query
        ? fetchJson<{ people?: PersonResult[] }>(`/api/people/search?q=${encoded}`, signal)
        : Promise.resolve(null),
      fetchJson<{ companies?: CompanyResult[] }>(`/api/companies${query ? `?q=${encoded}` : ""}`, signal),
      fetchJson<{ goals?: GoalResult[] }>(
        `/api/life-goals${query ? `?search=${encoded}` : ""}`,
        signal,
      ),
      fetchJson<TaskResult[]>(`/api/projects/tasks`, signal),
      fetchJson<ProjectResult[]>(`/api/projects/projects`, signal),
      fetchJson<WellnessActivityResult[]>(`/api/wellness/activities`, signal),
    ]);

  const suggestions: ReferenceSuggestion[] = [];

  for (const page of library || []) {
    const refId = page.slug || page.id;
    if (!refId) continue;
    suggestions.push({
      type: "page",
      id: String(refId),
      label: String(page.title || page.oneLiner || refId),
      description: "Library page",
    });
  }

  for (const person of people?.people || []) {
    suggestions.push({
      type: "person",
      id: String(person.id || person.slug || person.name),
      label: String(person.name || person.id),
      description:
        [person.role, person.company].filter(Boolean).join(" at ") || person.relation || "Person",
    });
  }

  for (const company of companies?.companies || []) {
    suggestions.push({
      type: "company",
      id: String(company.id),
      label: String(company.name || company.id),
      description: [company.industry, company.location].filter(Boolean).join(" · ") || "Company",
    });
  }

  for (const goal of goals?.goals || []) {
    suggestions.push({
      type: "goal",
      id: String(goal.id),
      label: String(goal.shortName || goal.title || goal.name || goal.id),
      description: goal.domain || "Goal",
    });
  }

  for (const task of tasks || []) {
    suggestions.push({
      type: "task",
      id: String(task.id),
      label: String(task.title || task.id),
      description: task.status ? `Task · ${task.status}` : "Task",
    });
  }

  for (const project of projects || []) {
    suggestions.push({
      type: "project",
      id: String(project.id),
      label: String(project.title || project.id),
      description: project.status ? `Project · ${project.status}` : "Project",
    });
  }

  for (const activity of wellnessActivities || []) {
    suggestions.push({
      type: "wellness_activity",
      id: String(activity.id ?? activity.name),
      label: String(activity.name || activity.id),
      description: activity.category ? `Wellness · ${activity.category}` : "Wellness activity",
    });
  }

  const filtered = uniqueSuggestions(suggestions.filter((s) => matchesSuggestion(s, query)));
  logger.debug("suggestions", { count: filtered.length });
  return filtered;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface MentionAutocompleteOptions {
  /** Current text value */
  value: string;
  /** Cursor position in the text */
  cursorPosition: number;
  /** Callback to update text and cursor */
  onChange: (newValue: string, newCursorPosition: number) => void;
  /** Restrict suggestions to specific reference types. */
  allowedTypes?: ReferenceType[];
}

export interface MentionAutocompleteResult {
  /** Active trigger state (null when inactive) */
  trigger: ReferenceTrigger | null;
  /** Filtered suggestions */
  suggestions: ReferenceSuggestion[];
  /** Whether suggestions are loading */
  isLoading: boolean;
  /** Active keyboard-navigation index */
  activeIndex: number;
  /** Set active index (for hover) */
  setActiveIndex: (index: number) => void;
  /** Insert the given suggestion at the trigger position */
  insertSuggestion: (suggestion: ReferenceSuggestion) => void;
  /** Dismiss the popover without inserting */
  dismiss: () => void;
  /** Handle keyboard events — returns true if consumed */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Call on every input change to re-evaluate trigger */
  handleInputChange: (value: string, cursorPosition: number) => void;
}

export function useMentionAutocomplete(
  options: MentionAutocompleteOptions,
): MentionAutocompleteResult {
  const { value, onChange, allowedTypes } = options;
  const allowedKey = allowedTypes?.join(",") || "";
  const queryClient = useQueryClient();

  const [trigger, setTrigger] = useState<ReferenceTrigger | null>(null);
  const [suggestions, setSuggestions] = useState<ReferenceSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Keep a ref for current trigger to avoid stale closures in insert
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  const valueRef = useRef(value);
  valueRef.current = value;

  // Detect trigger on input changes
  const handleInputChange = useCallback((newValue: string, cursorPosition: number) => {
    const detected = findReferenceTrigger(newValue, cursorPosition);
    setTrigger(detected);
    setActiveIndex(0);
  }, []);

  // Debounced suggestion fetching
  useEffect(() => {
    if (!trigger) {
      setSuggestions([]);
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setIsLoading(true);
      loadReferenceSuggestions(trigger.query, controller.signal)
        .then((results) => {
          if (!controller.signal.aborted) {
            const filtered = allowedTypes?.length ? results.filter(item => allowedTypes.includes(item.type)) : results;
            setSuggestions(sortByTrigger(filtered, trigger.triggerChar));
          }
        })
        .catch((error) => {
          if (error?.name !== "AbortError") {
            logger.warn("fetch-error", { error: error?.message || String(error) });
            setSuggestions([]);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [trigger, allowedKey]);

  const insertSuggestion = useCallback(
    (suggestion: ReferenceSuggestion) => {
      const currentTrigger = triggerRef.current;
      if (!currentTrigger) return;
      const currentValue = valueRef.current;
      const normalizedType = normalizeReferenceType(suggestion.type);
      const token = serializeReference({ type: normalizedType, id: suggestion.id });
      if (suggestion.label && suggestion.label !== suggestion.id) {
        queryClient.setQueryData(["reference-label", normalizedType, suggestion.id], suggestion.label);
      }
      const nextValue = `${currentValue.slice(0, currentTrigger.start)}${token} ${currentValue.slice(currentTrigger.start + 1 + currentTrigger.query.length)}`;
      const nextCursor = currentTrigger.start + token.length + 1;
      setTrigger(null);
      setSuggestions([]);
      onChange(nextValue, nextCursor);
    },
    [onChange, queryClient],
  );

  const dismiss = useCallback(() => {
    setTrigger(null);
    setSuggestions([]);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!trigger || suggestions.length === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertSuggestion(suggestions[activeIndex] || suggestions[0]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return true;
      }
      return false;
    },
    [trigger, suggestions, activeIndex, insertSuggestion, dismiss],
  );

  return {
    trigger,
    suggestions,
    isLoading,
    activeIndex,
    setActiveIndex,
    insertSuggestion,
    dismiss,
    handleKeyDown,
    handleInputChange,
  };
}
