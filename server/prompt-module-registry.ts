import {
  ACTIVITY_FRAMING,
  ACTIVITY_MEMORY,
  ACTIVITY_THINKING,
  ACTIVITY_RECALL,
  ACTIVITY_STRATEGY,
  ACTIVITY_WORK,
} from "./job-profiles";

export const PROMPT_MODULE_KEYS = [
  "agent-classifycomplexity",
  "chat-compactrunhistory",
  "myelination-cross-concept",
  "myelination-link",
  "myelination-mid-merge",
  "myelination-mid-merge-consolidate",
  "myelination-summarize",
  "people-deepsummary",
  "strategy-discovermoves",
  "strategy-evaluatemove",
  "strategy-evaluatestate",
  "tools-indexcontent",
] as const;

export type PromptModuleKey = typeof PROMPT_MODULE_KEYS[number];
export type PromptModuleDomain = "agent" | "chat" | "memory" | "people" | "strategy" | "tools";
export type PromptModuleOwnerSystem = "agent" | "chat" | "memory" | "people" | "strategy" | "tools";

export interface PromptModuleCallSiteMetadata {
  file: string;
  symbol?: string;
  purpose: string;
}

export interface PromptModuleManifestEntry {
  key: PromptModuleKey;
  domain: PromptModuleDomain;
  ownerSystem: PromptModuleOwnerSystem;
  description: string;
  activity: string;
  callSites: PromptModuleCallSiteMetadata[];
}

export const PROMPT_MODULE_MANIFEST: Record<PromptModuleKey, PromptModuleManifestEntry> = {
  "agent-classifycomplexity": {
    key: "agent-classifycomplexity",
    domain: "agent",
    ownerSystem: "agent",
    description: "Classifies task complexity for model/profile routing.",
    activity: ACTIVITY_THINKING,
    callSites: [{ file: "server/job-profiles.ts", purpose: "Routes inference work to the appropriate complexity tier." }],
  },
  "chat-compactrunhistory": {
    key: "chat-compactrunhistory",
    domain: "chat",
    ownerSystem: "chat",
    description: "Compacts chat/session run history while preserving operational state.",
    activity: ACTIVITY_FRAMING,
    callSites: [
      { file: "server/agent-executor.ts", purpose: "Compacts autonomous execution history." },
      { file: "server/agent-context.ts", purpose: "Compacts session history for context assembly." },
      { file: "server/bridge-tools.ts", purpose: "Compacts older bridge/tool transcript chunks." },
    ],
  },
  "myelination-cross-concept": {
    key: "myelination-cross-concept",
    domain: "memory",
    ownerSystem: "memory",
    description: "Discovers higher-order cross-concept memory links.",
    activity: ACTIVITY_MEMORY,
    callSites: [{ file: "server/memory/graph-discovery.ts", purpose: "Evaluates cross-concept graph edges." }],
  },
  "myelination-link": {
    key: "myelination-link",
    domain: "memory",
    ownerSystem: "memory",
    description: "Evaluates candidate links between memory entries.",
    activity: ACTIVITY_MEMORY,
    callSites: [
      { file: "server/memory/graph-discovery.ts", purpose: "Scores graph link candidates." },
      { file: "server/memory/memory-enrichment.ts", purpose: "Scores enrichment-time memory links." },
    ],
  },
  "myelination-mid-merge": {
    key: "myelination-mid-merge",
    domain: "memory",
    ownerSystem: "memory",
    description: "Merges related mid-term memories during myelination.",
    activity: ACTIVITY_MEMORY,
    callSites: [
      { file: "server/memory/memory-transitions.ts", purpose: "Merges mid-term memories." },
      { file: "server/memory/sleep-maintenance.ts", purpose: "Merges memories during sleep maintenance." },
    ],
  },
  "myelination-mid-merge-consolidate": {
    key: "myelination-mid-merge-consolidate",
    domain: "memory",
    ownerSystem: "memory",
    description: "Consolidates mid-term merge candidates into durable memory text.",
    activity: ACTIVITY_MEMORY,
    callSites: [{ file: "server/memory/memory-transitions.ts", purpose: "Consolidates memory merge output." }],
  },
  "myelination-summarize": {
    key: "myelination-summarize",
    domain: "memory",
    ownerSystem: "memory",
    description: "Summarizes memory content for enrichment without truncating source information.",
    activity: ACTIVITY_MEMORY,
    callSites: [{ file: "server/memory/memory-enrichment.ts", purpose: "Builds memory summaries for enrichment." }],
  },
  "people-deepsummary": {
    key: "people-deepsummary",
    domain: "people",
    ownerSystem: "people",
    description: "Writes deeper relationship summaries for people profiles.",
    activity: ACTIVITY_RECALL,
    callSites: [{ file: "server/people-routes.ts", purpose: "Generates deep people summaries." }],
  },
  "strategy-discovermoves": {
    key: "strategy-discovermoves",
    domain: "strategy",
    ownerSystem: "strategy",
    description: "Discovers plausible next moves for strategy simulations.",
    activity: ACTIVITY_STRATEGY,
    callSites: [{ file: "server/strategy-simulation.ts", purpose: "Generates child strategy moves." }],
  },
  "strategy-evaluatemove": {
    key: "strategy-evaluatemove",
    domain: "strategy",
    ownerSystem: "strategy",
    description: "Evaluates a strategy move and updates probability, analysis, states, and assumptions.",
    activity: ACTIVITY_STRATEGY,
    callSites: [{ file: "server/strategy-simulation.ts", purpose: "Evaluates move instances." }],
  },
  "strategy-evaluatestate": {
    key: "strategy-evaluatestate",
    domain: "strategy",
    ownerSystem: "strategy",
    description: "Evaluates a strategy state against desired end conditions.",
    activity: ACTIVITY_STRATEGY,
    callSites: [{ file: "server/strategy-simulation.ts", purpose: "Evaluates strategy state nodes." }],
  },
  "tools-indexcontent": {
    key: "tools-indexcontent",
    domain: "tools",
    ownerSystem: "tools",
    description: "Indexes archived large content into retrievable sections and identifiers.",
    activity: ACTIVITY_WORK,
    callSites: [{ file: "server/content-indexer.ts", purpose: "Indexes archived tool output and fetched content." }],
  },
};

export function isPromptModuleKey(key: string): key is PromptModuleKey {
  return (PROMPT_MODULE_KEYS as readonly string[]).includes(key);
}

export function getPromptModuleManifestEntry(key: PromptModuleKey): PromptModuleManifestEntry {
  return PROMPT_MODULE_MANIFEST[key];
}
