/** Shared Root ∪ selected-persona composition for context sections and tool bundles. */

export const CONTEXT_GROUPS = ["emotions", "schedule", "life", "people", "principles"] as const;
export type ContextGroupId = (typeof CONTEXT_GROUPS)[number];

export interface ContextGroupDefinition {
  id: ContextGroupId;
  title: string;
  description: string;
  recommendedFor: string;
  tokenCost: "small" | "medium" | "large";
  sectionIds: readonly string[];
}

/** Optional context a selectable persona can turn on. Root-owned sections are not here. */
export const CONTEXT_GROUP_DEFINITIONS: readonly ContextGroupDefinition[] = [
  {
    id: "emotions",
    title: "Emotions",
    description: "Emotional guidance, current state, and expression tags",
    recommendedFor: "Companion, Coach",
    tokenCost: "small",
    sectionIds: [
      "world_model.people.self.emotional_guidance",
      "world_model.people.self.emotional_state",
      "world_model.people.self.emotional_expression",
    ],
  },
  {
    id: "schedule",
    title: "Schedule",
    description: "Today/week/month goals plus active work and open decisions",
    recommendedFor: "Operator, Coach, Default",
    tokenCost: "medium",
    sectionIds: [
      "world_model.people.partner.goals.today",
      "world_model.people.partner.goals.this_week",
      "world_model.people.partner.goals.this_month",
      "world_model.active_work",
      "world_model.active_work.tasks",
      "world_model.active_work.projects",
      "world_model.decisions",
    ],
  },
  {
    id: "life",
    title: "Life",
    description: "Partner identity and the full life goal tree",
    recommendedFor: "Coach, Strategist",
    tokenCost: "large",
    sectionIds: [
      "world_model.people.partner",
      "world_model.people.partner.identity",
      "world_model.people.partner.goals",
    ],
  },
  {
    id: "people",
    title: "People",
    description: "Other contacts and relationship context",
    recommendedFor: "Companion, Persuader, Coach",
    tokenCost: "large",
    sectionIds: ["world_model.people.others"],
  },
  {
    id: "principles",
    title: "Principles",
    description: "Guiding life principles for decisions and reflection",
    recommendedFor: "Architect, Coach, Strategist",
    tokenCost: "large",
    sectionIds: ["world_model.people.self.principles"],
  },
];

export const CONTEXT_GROUP_SECTION_IDS: ReadonlySet<string> = new Set(
  CONTEXT_GROUP_DEFINITIONS.flatMap((group) => [...group.sectionIds]),
);

export function sectionIdsForEnabledGroups(flags: Record<string, boolean> | null | undefined): string[] {
  if (!flags) return [];
  const ids = new Set<string>();
  for (const group of CONTEXT_GROUP_DEFINITIONS) {
    if (flags[group.id] === true) {
      for (const sectionId of group.sectionIds) ids.add(sectionId);
    }
  }
  return [...ids];
}

export function sectionIdsForDisabledGroups(flags: Record<string, boolean> | null | undefined): string[] {
  if (!flags) return [];
  const ids = new Set<string>();
  for (const group of CONTEXT_GROUP_DEFINITIONS) {
    if (flags[group.id] === false) {
      for (const sectionId of group.sectionIds) ids.add(sectionId);
    }
  }
  return [...ids];
}

/** Union Root-on flags with selected-persona flags. Root-on cannot be turned off. */
export function unionRootContextSections(
  root: Record<string, boolean> | null | undefined,
  selected: Record<string, boolean> | null | undefined,
): Record<string, boolean> {
  const merged: Record<string, boolean> = { ...(selected ?? {}) };
  for (const [id, enabled] of Object.entries(root ?? {})) {
    if (enabled) merged[id] = true;
  }
  return merged;
}

/** Union Root tools with selected-persona tools. Empty selected still means passthrough. */
export function unionRootToolBundle(
  root: string[] | null | undefined,
  selected: string[] | null | undefined,
): string[] | null {
  if (!selected || selected.length === 0) return selected ?? null;
  return [...new Set([...(root ?? []), ...selected])];
}
