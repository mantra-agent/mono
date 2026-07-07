import type { ContextFlags } from "../shared/context-spine";

export interface ContextInstructionGroup {
  id: string;
  title: string;
  flag: string;
  sectionIds: string[];
  includeWhen: string;
}

export const INSTRUCTION_GROUPS: ContextInstructionGroup[] = [
  {
    id: "coding_instructions",
    title: "Coding Instructions",
    flag: "instructions.coding",
    sectionIds: ["capabilities.code_instructions"],
    includeWhen: "Use for code changes, debugging, repo work, PRs, builds, deployments, and implementation planning.",
  },
  {
    id: "goals_instructions",
    title: "Goals Instructions",
    flag: "instructions.goals",
    sectionIds: ["capabilities.goals_instructions"],
    includeWhen: "Use for life goals across all horizons, FTUE goal capture, planning, reviews, and goal mutation.",
  },
  {
    id: "library_artifact_instructions",
    title: "Library Artifact Instructions",
    flag: "instructions.library_artifact",
    sectionIds: ["capabilities.library"],
    includeWhen: "Use when creating specs, reports, drafts, shareable artifacts, or durable Library pages.",
  },
  {
    id: "tool_reference",
    title: "Tool Reference",
    flag: "references.tools",
    sectionIds: ["capabilities.tools"],
    includeWhen: "Use when the model needs a compact reminder of tool routing. Detailed docs come from tools.get.",
  },
  {
    id: "relationship_context",
    title: "Relationship Context",
    flag: "context.relationships",
    sectionIds: ["world_model.people.others", "world_model.people.partner.preferences", "world_model.people.partner.goals"],
    includeWhen: "Use for relationship, coaching, planning, and people-context conversations.",
  },
  {
    id: "active_work_context",
    title: "Active Work Context",
    flag: "context.active_work",
    sectionIds: ["world_model.active_work", "world_model.decisions"],
    includeWhen: "Use for planning, review, execution, and work prioritization.",
  },
  {
    id: "memory_context",
    title: "Memory Context",
    flag: "context.memory",
    sectionIds: ["memory"],
    includeWhen: "Use when continuity, prior conversations, or memory operations are relevant.",
  },
];

const SECTION_IDS = new Set(INSTRUCTION_GROUPS.flatMap(group => group.sectionIds));

export function isSemanticContextFlag(flag: string): boolean {
  return INSTRUCTION_GROUPS.some(group => group.flag === flag);
}

export function expandSemanticContextFlags(flags: ContextFlags | null): string[] {
  if (!flags) return [];
  const includeIds = new Set<string>();
  for (const group of INSTRUCTION_GROUPS) {
    if (flags[group.flag]) {
      for (const sectionId of group.sectionIds) includeIds.add(sectionId);
    }
  }
  return [...includeIds];
}

export function expandDisabledSemanticContextFlags(flags: ContextFlags | null): string[] {
  if (!flags) return [];
  const excludeIds = new Set<string>();
  for (const group of INSTRUCTION_GROUPS) {
    if (flags[group.flag] === false) {
      for (const sectionId of group.sectionIds) excludeIds.add(sectionId);
    }
  }
  return [...excludeIds];
}

const FLAG_ALIASES: Record<string, string[]> = {
  "instructions.coding": ["code", "coding", "debug", "debugging", "implementation", "repo", "build", "deployment", "system"],
  "instructions.library_artifact": ["spec", "artifact", "library", "report", "draft", "writing", "document"],
  "context.active_work": ["planning", "review", "goals", "work", "execution", "project"],
  "context.relationships": ["people", "relationship", "relationships", "contact", "outreach", "coaching"],
  "context.memory": ["memory", "context", "continuity", "retrieval", "compaction"],
};

function normalizeOrientationTerm(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_ -]/g, "").replace(/\s+/g, " ");
}

export function recommendSemanticContextFlags(input: { title?: string; topics?: string[]; personaName?: string }): ContextFlags {
  const terms = new Set<string>();
  if (input.title) {
    for (const part of normalizeOrientationTerm(input.title).split(" ")) {
      if (part) terms.add(part);
    }
  }
  for (const topic of input.topics || []) {
    const normalized = normalizeOrientationTerm(topic);
    if (normalized) terms.add(normalized);
  }
  if (input.personaName && normalizeOrientationTerm(input.personaName) === "operator") {
    terms.add("execution");
  }

  const flags: ContextFlags = {};
  for (const [flag, aliases] of Object.entries(FLAG_ALIASES)) {
    if (aliases.some(alias => terms.has(alias))) {
      flags[flag] = true;
    }
  }
  return flags;
}

export function getInstructionGroupBySection(sectionId: string): ContextInstructionGroup | undefined {
  return INSTRUCTION_GROUPS.find(group => group.sectionIds.some(id => sectionId === id || sectionId.startsWith(id + ".")));
}

export function isInstructionGroupSection(sectionId: string): boolean {
  return SECTION_IDS.has(sectionId) || [...SECTION_IDS].some(id => sectionId.startsWith(id + "."));
}
