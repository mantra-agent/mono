import type { ToolHandler } from "./contracts";
import { TOOLS } from "../tool-registry";

export type ToolDomainOwner =
  | "core-interaction"
  | "core-workspace"
  | "core-knowledge"
  | "core-relationships"
  | "core-planning"
  | "core-operations"
  | "build"
  | "communications"
  | "wellness"
  | "finance"
  | "strategy";

export interface ToolDomainAdapter {
  id: string;
  owner: ToolDomainOwner;
  tools: readonly string[];
  authorizationDependencies: readonly string[];
  normalizationExtensions: readonly string[];
  artifactKinds: readonly string[];
  providerBoundaries: readonly string[];
}

export type ToolHandlerSource = Readonly<Record<string, ToolHandler>>;

const nativeInteractionHandlers: ToolHandlerSource = {
  async ui(args) {
    const { handleUiInteraction } = await import("./ui");
    return handleUiInteraction(args);
  },
  async question(args) {
    const { handleQuestion } = await import("./question");
    return handleQuestion(args);
  },
};

const nativePlanningHandlers: ToolHandlerSource = {
  async agendas(args) {
    const { handleAgendas } = await import("./agendas");
    return handleAgendas(args);
  },
  async business(args) {
    const { handleBusiness } = await import("./business-plans");
    return handleBusiness(args);
  },
  async plan(args) {
    const { handlePlan } = await import("./plan");
    return handlePlan(args);
  },
  async workflows(args) {
    const { handleWorkflows } = await import("./workflows");
    return handleWorkflows(args);
  },
};

export const TOOL_DOMAIN_ADAPTERS: readonly ToolDomainAdapter[] = [
  {
    id: "interaction",
    owner: "core-interaction",
    tools: ["ui", "question", "orient", "session", "router", "cognition", "tools"],
    authorizationDependencies: ["agent-authority", "principal-context", "session-tree", "ui-interaction-coordinator"],
    normalizationExtensions: ["question prompt normalization", "session agenda normalization"],
    artifactKinds: [],
    providerBoundaries: ["model-client"],
  },
  {
    id: "workspace-files",
    owner: "core-workspace",
    tools: ["scratch", "files", "pdf", "docx", "indexed_content", "images"],
    authorizationDependencies: ["agent-authority", "object ACL", "FilesApi", "visible Vault scope"],
    normalizationExtensions: ["workspace path resolution", "object path normalization", "sparse edit operations"],
    artifactKinds: ["file", "docx", "indexed_content"],
    providerBoundaries: ["FilesApi", "ObjectStorageService", "pdf-service", "images provider adapter"],
  },
  {
    id: "knowledge",
    owner: "core-knowledge",
    tools: ["memory", "library", "settings", "code", "theses", "news"],
    authorizationDependencies: ["principal-context", "scoped storage", "visible Vault scope", "GitNexus runtime"],
    normalizationExtensions: ["memory lifecycle filters", "Library sparse mutations", "canonical references"],
    artifactKinds: ["memory_entry", "library_page", "news_signal"],
    providerBoundaries: ["model-client", "GitNexus runtime", "news source adapters"],
  },
  {
    id: "relationships",
    owner: "core-relationships",
    tools: ["people", "companies", "pronunciation", "blocking_graph"],
    authorizationDependencies: ["principal-context", "People Vault membership", "company membership"],
    normalizationExtensions: ["Person identity resolution", "contact metadata policy", "Vault membership sets"],
    artifactKinds: ["person", "interaction"],
    providerBoundaries: [],
  },
  {
    id: "planning-work",
    owner: "core-planning",
    tools: ["business", "goals", "work", "tasks", "decisions", "plan", "workflows", "agendas", "skills", "rules", "jobs"],
    authorizationDependencies: ["principal-context", "work Vault access", "Runtime", "named permissions"],
    normalizationExtensions: ["safe partial updates", "work placement", "plan step contracts", "checklist references"],
    artifactKinds: ["project", "task", "decision", "library_page", "workflow_artifact"],
    providerBoundaries: ["Runtime", "model-client"],
  },
  {
    id: "communications",
    owner: "communications",
    tools: ["phone_call", "gmail", "content", "meetings", "notion"],
    authorizationDependencies: ["principal-context", "connected-account scope", "human external-effect gates"],
    normalizationExtensions: ["draft body mutation", "recipient normalization", "meeting draft validation"],
    artifactKinds: ["email_draft", "content_draft", "meeting", "meeting_draft"],
    providerBoundaries: ["Gmail", "Google Calendar", "Notion", "Twilio", "X"],
  },
  {
    id: "build-operations",
    owner: "build",
    tools: ["shell", "python", "npm_dependencies", "web", "railway", "sentry", "meta", "expo", "system", "issues", "hooks", "git", "backup", "platforms", "routers"],
    authorizationDependencies: ["agent-authority", "build permissions", "trusted engineering provenance", "Platform access"],
    normalizationExtensions: ["shell policy", "repository path ownership", "Platform Environment identity"],
    artifactKinds: ["pr", "issue", "deployment", "web_article"],
    providerBoundaries: ["GitHub", "Railway", "Sentry", "Expo", "bounded untrusted URL"],
  },
  {
    id: "strategy-career",
    owner: "strategy",
    tools: ["scenarios", "exec"],
    authorizationDependencies: ["principal-context", "scoped strategy storage", "visible Library scope"],
    normalizationExtensions: ["move effects", "artifact content schemas"],
    artifactKinds: ["scenario_artifact", "library_page", "docx"],
    providerBoundaries: ["model-client"],
  },
  {
    id: "finance",
    owner: "finance",
    tools: ["finance"],
    authorizationDependencies: ["principal-context", "finance sensitive scope", "connected-account scope"],
    normalizationExtensions: ["bounded date ranges", "goal and amortization actions"],
    artifactKinds: [],
    providerBoundaries: ["Plaid"],
  },
  {
    id: "wellness",
    owner: "wellness",
    tools: ["health"],
    authorizationDependencies: ["principal-context", "active Wellness Mod", "wellness scoped storage"],
    normalizationExtensions: ["activity cadence", "metric thresholds", "dated personal logs"],
    artifactKinds: ["wellness_activity"],
    providerBoundaries: ["health integrations"],
  },
  {
    id: "utilities",
    owner: "core-operations",
    tools: ["timers", "weather"],
    authorizationDependencies: ["principal-context", "Runtime", "Timer ownership"],
    normalizationExtensions: ["schedule definitions", "bounded forecast ranges"],
    artifactKinds: ["timer_run"],
    providerBoundaries: ["weather provider"],
  },
] as const;

const NATIVE_HANDLER_SOURCES: readonly ToolHandlerSource[] = [
  nativeInteractionHandlers,
  nativePlanningHandlers,
];

export function composeToolDomainHandlers(
  legacySources: readonly ToolHandlerSource[],
): Record<string, ToolHandler> {
  const ownership = new Map<string, ToolDomainAdapter>();
  for (const adapter of TOOL_DOMAIN_ADAPTERS) {
    for (const tool of adapter.tools) {
      const prior = ownership.get(tool);
      if (prior) {
        throw new Error(`Tool ${tool} has duplicate domain owners: ${prior.id}, ${adapter.id}`);
      }
      ownership.set(tool, adapter);
    }
  }

  const registered = Object.keys(TOOLS);
  const unowned = registered.filter((tool) => !ownership.has(tool));
  const unknown = [...ownership.keys()].filter((tool) => !Object.hasOwn(TOOLS, tool));
  if (unowned.length > 0 || unknown.length > 0) {
    throw new Error(`Tool domain ownership mismatch: unowned=[${unowned.sort().join(", ")}] unknown=[${unknown.sort().join(", ")}]`);
  }

  const sources = [...NATIVE_HANDLER_SOURCES, ...legacySources];
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of registered) {
    const matches = sources.filter((source) => typeof source[tool] === "function");
    if (matches.length !== 1) {
      throw new Error(`Registered tool ${tool} must have exactly one handler source; found ${matches.length}`);
    }
    handlers[tool] = matches[0][tool];
  }
  return handlers;
}
