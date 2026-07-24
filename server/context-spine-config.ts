import type { SpineSectionConfig, ContextCallType } from "../shared/context-spine";

export const SPINE_SECTIONS: SpineSectionConfig[] = [
  {
    id: "world_model",
    title: "World Model",
    parentId: null,
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 1,
    includedIn: ["full", "world"],
    bootstrap: true,
  },

  {
    id: "world_model.temporal",
    layer: "kernel",
    title: "Time & Day",
    parentId: "world_model",
    sourceType: "dynamic",
    freshnessPolicy: "real-time",
    priority: 0,
    includedIn: ["full", "world"],
    bootstrap: true,
  },

  {
    id: "world_model.runtime",
    layer: "kernel",
    title: "Runtime Identity",
    parentId: "world_model",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 0.05,
    includedIn: ["full", "world", "internal"],
    bootstrap: true,
  },

  {
    id: "world_model.orientation",
    layer: "kernel",
    title: "Session Orientation",
    parentId: "world_model",
    sourceType: "dynamic",
    // Orientation changes within a session. Caching it for the full session can
    // feed the main model the pre-bootstrap protocol after orientation applies.
    freshnessPolicy: "real-time",
    priority: 0.1,
    includedIn: ["full", "world"],
    bootstrap: true,
  },

  {
    id: "world_model.people",
    title: "People",
    parentId: "world_model",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 1,
    includedIn: ["full", "world"],
    bootstrap: true,
  },
  {
    id: "world_model.people.self",
    title: "Self (Agent)",
    parentId: "world_model.people",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 1,
    includedIn: ["full", "world", "internal"],
    bootstrap: true,
  },
  {
    id: "world_model.people.self.identity",
    layer: "kernel",
    title: "Identity",
    parentId: "world_model.people.self",
    sourceType: "static",
    freshnessPolicy: "rarely",
    priority: 1,
    includedIn: ["full", "world", "internal"],
    bootstrap: true,
  },
  {
    id: "world_model.people.self.voice",
    layer: "kernel",
    title: "Voice",
    parentId: "world_model.people.self",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 1.5,
    includedIn: ["full", "world", "internal"],
    bootstrap: true,
  },
  {
    id: "world_model.people.self.persona",
    layer: "state",
    title: "Persona",
    parentId: "world_model.people.self",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 1.51,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },
  {
    id: "world_model.people.self.emotional_guidance",
    layer: "reference",
    referenceOnly: true,
    maxDefaultTokens: 220,
    title: "Emotional Guidance",
    parentId: "world_model.people.self",
    sourceType: "dynamic",
    freshnessPolicy: "real-time",
    priority: 1.55,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },
  {
    id: "world_model.people.self.emotional_state",
    layer: "state",
    title: "Emotional State",
    parentId: "world_model.people.self",
    sourceType: "dynamic",
    freshnessPolicy: "real-time",
    priority: 1.6,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },
  {
    id: "world_model.people.self.emotional_expression",
    layer: "state",
    title: "Emotional Expression",
    parentId: "world_model.people.self",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 1.65,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },
  {
    id: "world_model.people.self.general_instructions",
    title: "General Instructions",
    parentId: "world_model.people.self",
    sourceType: "static",
    freshnessPolicy: "rarely",
    priority: 2.5,
    bootstrap: true,
    includedIn: ["full", "world"],
  },
  {
    id: "world_model.people.self.chat_instructions",
    title: "Chat Instructions",
    parentId: "world_model.people.self",
    sourceType: "static",
    freshnessPolicy: "rarely",
    priority: 2.6,
    includedIn: ["full", "world"],
  },

  {
    id: "world_model.people.self.principles",
    title: "Principles",
    parentId: "world_model.people.self",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 5,
    includedIn: ["full", "world"],
  },

  {
    id: "world_model.people.self.journal",
    title: "Journal",
    parentId: "world_model.people.self",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 5.5,
    includedIn: [],
  },

  {
    id: "world_model.people.self.rules",
    layer: "kernel",
    title: "Active Rules",
    parentId: "world_model.people.self",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 6,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },

  {
    id: "world_model.people.partner",
    title: "Partner (Ray)",
    parentId: "world_model.people",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 2,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },
  {
    id: "world_model.people.partner.identity",
    title: "Identity",
    parentId: "world_model.people.partner",
    sourceType: "static",
    freshnessPolicy: "rarely",
    priority: 1,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },

  {
    id: "world_model.people.partner.goals",
    title: "Goals",
    parentId: "world_model.people.partner",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 3,
    includedIn: ["full", "world"],
  },
  {
    id: "world_model.people.partner.goals",
    layer: "state",
    title: "Goals by Horizon",
    parentId: "world_model.people.partner",
    sourceType: "dynamic",
    freshnessPolicy: "real-time",
    priority: 4,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },
  {
    id: "world_model.people.partner.goals.today",
    title: "Today",
    parentId: "world_model.people.partner.goals",
    sourceType: "dynamic",
    freshnessPolicy: "real-time",
    priority: 1,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },
  {
    id: "world_model.people.partner.goals.this_week",
    title: "This Week",
    parentId: "world_model.people.partner.goals",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 2,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },

  {
    id: "world_model.people.partner.goals.this_month",
    title: "This Month",
    parentId: "world_model.people.partner.goals",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 3,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },

  {
    id: "world_model.people.others",
    title: "Other People",
    parentId: "world_model.people",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 3,
    includedIn: ["full", "world"],
  },

  {
    id: "world_model.active_work",
    title: "Active Work",
    parentId: "world_model",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 2,
    includedIn: ["full", "world"],
  },
  {
    id: "world_model.active_work.tasks",
    title: "Tasks",
    parentId: "world_model.active_work",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 1,
    includedIn: ["full", "world"],
  },
  {
    id: "world_model.active_work.projects",
    title: "Projects",
    parentId: "world_model.active_work",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 2,
    includedIn: ["full", "world"],
  },
  {
    id: "world_model.decisions",
    title: "Open Decisions",
    parentId: "world_model",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    cacheTtlMs: 5 * 60 * 1000,
    priority: 2,
    includedIn: ["full", "world"],
  },

  {
    id: "world_model.calendar",
    layer: "state",
    title: "Calendar",
    parentId: "world_model",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 3,
    includedIn: ["full", "world"],
    bootstrap: true,
  },
  {
    id: "world_model.meeting",
    layer: "state",
    title: "Current Meeting",
    parentId: "world_model",
    sourceType: "dynamic",
    freshnessPolicy: "real-time",
    priority: 3.1,
    includedIn: ["full", "world"],
    defaultIncluded: true,
  },


  {
    id: "memory",
    title: "Memory",
    parentId: null,
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 2,
    includedIn: ["full", "world"],
  },
  {
    id: "memory.graph",
    title: "Memory Graph",
    parentId: "memory",
    sourceType: "dynamic",
    freshnessPolicy: "real-time",
    priority: 4,
    includedIn: ["full", "world"],
    bootstrap: true,
  },
  {
    id: "memory.recent_sessions",
    title: "Recent Sessions",
    parentId: "memory",
    sourceType: "dynamic",
    freshnessPolicy: "real-time",
    priority: 4.5,
    includedIn: ["full", "world"],
  },

  {
    id: "session_context",
    title: "Current Session",
    parentId: null,
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 2.4,
    includedIn: ["full"],
  },

  {
    id: "thoughts",
    title: "Observations",
    parentId: null,
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 2.5,
    includedIn: ["full", "world"],
  },


  {
    id: "capabilities",
    title: "Capabilities",
    parentId: null,
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 3,
    includedIn: ["full"],
    bootstrap: true,
  },
  {
    id: "capabilities.tools",
    layer: "reference",
    instructionGroupId: "tool_reference",
    referenceOnly: true,
    maxDefaultTokens: 450,
    title: "Tools",
    parentId: "capabilities",
    sourceType: "dynamic",
    freshnessPolicy: "real-time",
    priority: 1,
    includedIn: ["full", "world", "internal"],
    bootstrap: true,
  },
  {
    id: "capabilities.code_instructions",
    layer: "instructions",
    instructionGroupId: "coding_instructions",
    maxDefaultTokens: 900,
    title: "Code Instructions",
    parentId: "capabilities",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 1.5,
    includedIn: ["full"],
    bootstrap: true,
  },
  {
    id: "capabilities.planning_instructions",
    layer: "reference",
    instructionGroupId: "planning_instructions",
    referenceOnly: true,
    maxDefaultTokens: 160,
    title: "Planning Instructions",
    parentId: "capabilities",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 1.4,
    includedIn: ["full"],
    bootstrap: true,
  },
  {
    id: "capabilities.goals_instructions",
    layer: "reference",
    instructionGroupId: "goals_instructions",
    referenceOnly: true,
    maxDefaultTokens: 160,
    title: "Goals and Priority Instructions",
    parentId: "capabilities",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 1.45,
    includedIn: ["full"],
    bootstrap: true,
  },
  {
    id: "capabilities.skills",
    title: "Skills",
    parentId: "capabilities",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 2,
    includedIn: ["full"],
  },
  {
    id: "capabilities.library",
    layer: "reference",
    instructionGroupId: "library_artifact_instructions",
    referenceOnly: true,
    maxDefaultTokens: 400,
    title: "Library",
    parentId: "capabilities",
    sourceType: "dynamic",
    freshnessPolicy: "per-session",
    priority: 3,
    includedIn: ["full"],
  },
];

export function cacheTtlFromFreshness(policy: string): number {
  switch (policy) {
    case "rarely": return Infinity;
    case "per-session": return Infinity;
    case "real-time": return 0;
    case "never": return 0;
    default: return 0;
  }
}

export function getSectionsForCallType(
  callType: ContextCallType,
  includeSections?: string[],
  excludeSections?: string[],
): SpineSectionConfig[] {
  if (callType === "none" && !includeSections?.length) return [];

  let sections = callType === "none"
    ? []
    : SPINE_SECTIONS.filter(s => s.includedIn.includes(callType));

  if (includeSections?.length) {
    const baseIds = new Set(sections.map(s => s.id));
    const additions = SPINE_SECTIONS.filter(
      s => !baseIds.has(s.id) && includeSections.some(prefix => s.id === prefix || s.id.startsWith(prefix + ".")),
    );
    sections = [...sections, ...additions];
  }

  if (excludeSections?.length) {
    const bootstrapIds = getBootstrapSectionIds();
    sections = sections.filter(
      s => bootstrapIds.has(s.id) || !excludeSections.some(prefix => s.id === prefix || s.id.startsWith(prefix + ".")),
    );
  }

  return sections;
}

export function getSectionConfig(sectionId: string): SpineSectionConfig | undefined {
  return SPINE_SECTIONS.find(s => s.id === sectionId);
}

export function getAllSectionIds(): string[] {
  return SPINE_SECTIONS.map(s => s.id);
}

/** Returns sections that are always included and cannot be excluded by context flags. */
export function getBootstrapSections(): SpineSectionConfig[] {
  return SPINE_SECTIONS.filter(s => s.bootstrap === true);
}

/** Returns section IDs that are always included (bootstrap). */
export function getBootstrapSectionIds(): Set<string> {
  return new Set(getBootstrapSections().map(s => s.id));
}

/** Returns sections included by default: bootstrap + sections marked defaultIncluded. */
export function getDefaultIncludedSections(): SpineSectionConfig[] {
  return SPINE_SECTIONS.filter(s => s.bootstrap === true || s.defaultIncluded === true);
}

/** Returns section IDs included by default (bootstrap + defaultIncluded). */
export function getDefaultIncludedSectionIds(): Set<string> {
  return new Set(getDefaultIncludedSections().map(s => s.id));
}
