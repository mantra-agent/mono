export const REFERENCE_TYPES = [
  "page",
  "person",
  "tag",
  "company",
  "interaction",
  "goal",
  "task",
  "project",
  "milestone",
  "role",
  "meeting",
  "session",
  "inference_context",
  "plan",
  "plan_attempt",
  "workflow",
  "workflow_gate",
  "intention",
  "timer",
  "hook",
  "decision",
  "principle",
  "question",
  "strategy",
  "strategy_move",
  "strategy_assumption",
  "strategy_end_condition",
  "strategy_state",
  "opportunity",
  "platform",
  "product",
  "environment",
  "build",
  "skill",
  "claim",
  "wellness_activity",
  "priority",
  "metric",
  "kpi",
  "business_plan",
  "business",
  "file",
  "document",
  "news",
  "web_article",
  "x_item",
  "reddit_post",
  "rss_item",
  "pr",
  "issue",
  "email_thread",
  "email_message",
  "email_draft",
  "meeting_draft",
  "account",
  "user",
  "agent_instance",
  "router",
] as const;

export type KnownReferenceType = typeof REFERENCE_TYPES[number];
export type ReferenceType = KnownReferenceType | string;

export type ReferenceIdentifierKind =
  | "uuid"
  | "slug"
  | "integer"
  | "opaque"
  | "url"
  | "path"
  | "composite"
  | "repository_pr";

export interface ReferenceTypeDefinition {
  type: KnownReferenceType;
  aliases: readonly string[];
  identifierKind: ReferenceIdentifierKind;
  identifierPattern: RegExp;
  route?: (id: string) => string | undefined;
  capabilities: readonly string[];
  graph: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INTEGER_PATTERN = /^[1-9]\d*$/;
const OPAQUE_PATTERN = /^[^\s\]<>]+$/;
const URL_PATTERN = /^https?:\/\/[^\s\]<>]+$/i;
const PATH_PATTERN = /^\/objects\/[^\s\]<>]+$/;
const FILE_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\/objects\/[^\s\]<>]+)$/i;
const COMPOSITE_PATTERN = /^[^\s~\]<>]+~[^\s~\]<>]+$/;
const EMAIL_THREAD_PATTERN = /^[^\s:\]<>]+:.+$/;
const PR_PATTERN = /^(?:[^\s/]+\/)?[^\s/]+\/\d+$/;

function definition(
  type: KnownReferenceType,
  identifierKind: ReferenceIdentifierKind,
  identifierPattern: RegExp,
  options: Partial<Omit<ReferenceTypeDefinition, "type" | "identifierKind" | "identifierPattern">> = {},
): ReferenceTypeDefinition {
  return {
    type,
    identifierKind,
    identifierPattern,
    aliases: options.aliases ?? [],
    route: options.route,
    capabilities: options.capabilities ?? ["open"],
    graph: options.graph ?? true,
  };
}

export const REFERENCE_REGISTRY: Readonly<Record<KnownReferenceType, ReferenceTypeDefinition>> = {
  page: definition("page", "uuid", UUID_PATTERN, { aliases: ["spec"], route: id => `/info#library?page=${encodeURIComponent(id)}` }),
  person: definition("person", "opaque", OPAQUE_PATTERN, { route: id => `/people/${encodeURIComponent(id)}` }),
  tag: definition("tag", "slug", SLUG_PATTERN, {
    route: id => `/tags/${encodeURIComponent(id)}`,
    capabilities: ["open", "discuss", "link"],
  }),
  company: definition("company", "opaque", OPAQUE_PATTERN, { route: id => `/companies/${encodeURIComponent(id)}` }),
  interaction: definition("interaction", "composite", COMPOSITE_PATTERN, { route: id => {
    const [personId, interactionId] = id.split("~").map(decodeURIComponent);
    return `/people/${encodeURIComponent(personId)}?interaction=${encodeURIComponent(interactionId)}`;
  } }),
  goal: definition("goal", "opaque", OPAQUE_PATTERN, { route: id => `/goals?goal=${encodeURIComponent(id)}` }),
  task: definition("task", "integer", INTEGER_PATTERN, { route: id => `/projects?task=${encodeURIComponent(id)}` }),
  project: definition("project", "integer", INTEGER_PATTERN, { route: id => `/projects?project=${encodeURIComponent(id)}` }),
  milestone: definition("milestone", "composite", COMPOSITE_PATTERN, { route: id => {
    const [projectId] = id.split("~");
    return `/projects?project=${encodeURIComponent(projectId)}`;
  } }),
  role: definition("role", "opaque", OPAQUE_PATTERN, { route: id => `/business/roles?role=${encodeURIComponent(id)}` }),
  meeting: definition("meeting", "opaque", OPAQUE_PATTERN, { route: id => `/schedule/${encodeURIComponent(id)}` }),
  session: definition("session", "opaque", OPAQUE_PATTERN, { route: id => `/session?c=${encodeURIComponent(id)}` }),
  inference_context: definition("inference_context", "uuid", UUID_PATTERN, { route: id => `/brain?tab=context&capture=${encodeURIComponent(id)}`, graph: false }),
  plan: definition("plan", "opaque", OPAQUE_PATTERN, { route: id => `/plans/${encodeURIComponent(id)}` }),
  plan_attempt: definition("plan_attempt", "integer", INTEGER_PATTERN, { route: () => "/plans" }),
  workflow: definition("workflow", "opaque", OPAQUE_PATTERN, { route: id => `/workflows/${encodeURIComponent(id)}` }),
  workflow_gate: definition("workflow_gate", "integer", INTEGER_PATTERN, { route: id => `/workflows?gate=${encodeURIComponent(id)}` }),
  intention: definition("intention", "opaque", OPAQUE_PATTERN, { graph: false }),
  timer: definition("timer", "opaque", OPAQUE_PATTERN, { route: id => `/timers?timer=${encodeURIComponent(id)}` }),
  hook: definition("hook", "integer", INTEGER_PATTERN, { route: id => `/hooks?hook=${encodeURIComponent(id)}` }),
  decision: definition("decision", "opaque", OPAQUE_PATTERN, { route: id => `/decisions?decision=${encodeURIComponent(id)}` }),
  principle: definition("principle", "opaque", OPAQUE_PATTERN, { route: () => "/orientation" }),
  question: definition("question", "opaque", OPAQUE_PATTERN),
  strategy: definition("strategy", "opaque", OPAQUE_PATTERN, { route: id => `/strategy/${encodeURIComponent(id)}` }),
  strategy_move: definition("strategy_move", "opaque", OPAQUE_PATTERN, { route: id => `/strategy?move=${encodeURIComponent(id)}` }),
  strategy_assumption: definition("strategy_assumption", "opaque", OPAQUE_PATTERN, { route: id => `/strategy?assumption=${encodeURIComponent(id)}` }),
  strategy_end_condition: definition("strategy_end_condition", "opaque", OPAQUE_PATTERN, { route: id => `/strategy?endCondition=${encodeURIComponent(id)}` }),
  strategy_state: definition("strategy_state", "opaque", OPAQUE_PATTERN, { route: id => `/strategy?state=${encodeURIComponent(id)}` }),
  opportunity: definition("opportunity", "integer", INTEGER_PATTERN, { route: id => `/exec?opportunity=${encodeURIComponent(id)}` }),
  platform: definition("platform", "integer", INTEGER_PATTERN, { route: id => `/platforms/${encodeURIComponent(id)}` }),
  product: definition("product", "integer", INTEGER_PATTERN, { route: id => `/platform-products/${encodeURIComponent(id)}` }),
  environment: definition("environment", "integer", INTEGER_PATTERN, { route: id => `/platform-environments/${encodeURIComponent(id)}` }),
  build: definition("build", "uuid", UUID_PATTERN, { route: () => "/build" }),
  skill: definition("skill", "uuid", UUID_PATTERN, { route: id => `/skills/${encodeURIComponent(id)}` }),
  claim: definition("claim", "integer", INTEGER_PATTERN, { route: id => `/memory?claim=${encodeURIComponent(id)}` }),
  wellness_activity: definition("wellness_activity", "integer", INTEGER_PATTERN, { aliases: ["health_activity", "wellness"], route: id => `/wellness?tab=calendar&activity=${encodeURIComponent(id)}` }),
  priority: definition("priority", "opaque", OPAQUE_PATTERN, { route: () => "/goals" }),
  metric: definition("metric", "opaque", OPAQUE_PATTERN, { route: id => `/business/metrics?metric=${encodeURIComponent(id)}` }),
  kpi: definition("kpi", "opaque", OPAQUE_PATTERN, { route: id => `/business/kpis?kpi=${encodeURIComponent(id)}` }),
  business_plan: definition("business_plan", "opaque", OPAQUE_PATTERN, { aliases: ["business-plan"], route: id => `/business/plan?plan=${encodeURIComponent(id)}` }),
  business: definition("business", "opaque", OPAQUE_PATTERN, { route: id => `/business/identity?business=${encodeURIComponent(id)}` }),
  file: definition("file", "opaque", FILE_PATTERN, { route: id => id.startsWith("/objects/") ? id : `/files?driveResource=${encodeURIComponent(id)}` }),
  document: definition("document", "uuid", UUID_PATTERN, { route: id => `/documents/${encodeURIComponent(id)}` }),
  news: definition("news", "opaque", OPAQUE_PATTERN, { route: id => `/news?signal=${encodeURIComponent(id)}` }),
  web_article: definition("web_article", "url", URL_PATTERN, { graph: false }),
  x_item: definition("x_item", "url", URL_PATTERN, { graph: false }),
  reddit_post: definition("reddit_post", "url", URL_PATTERN, { graph: false }),
  rss_item: definition("rss_item", "url", URL_PATTERN, { graph: false }),
  pr: definition("pr", "repository_pr", PR_PATTERN, { route: id => {
    const parts = id.split("/");
    return parts.length === 3 ? `https://github.com/${parts[0]}/${parts[1]}/pull/${parts[2]}` : undefined;
  }, graph: false }),
  issue: definition("issue", "integer", INTEGER_PATTERN, { route: id => `/issues/${encodeURIComponent(id)}`, graph: false }),
  email_thread: definition("email_thread", "composite", EMAIL_THREAD_PATTERN, { route: () => "/comms", graph: false }),
  email_message: definition("email_message", "integer", INTEGER_PATTERN, { route: () => "/comms", graph: false }),
  email_draft: definition("email_draft", "uuid", UUID_PATTERN, { aliases: ["draft"], route: id => `/email?draft=${encodeURIComponent(id)}`, graph: false }),
  meeting_draft: definition("meeting_draft", "uuid", UUID_PATTERN, { aliases: ["calendar_draft"], route: () => "/", graph: false }),
  account: definition("account", "uuid", UUID_PATTERN, {
    route: id => `/system?tab=accounts&account=${encodeURIComponent(id)}`,
    capabilities: ["open"],
  }),
  user: definition("user", "uuid", UUID_PATTERN, {
    route: id => `/system?tab=users&user=${encodeURIComponent(id)}`,
    capabilities: ["open"],
  }),
  agent_instance: definition("agent_instance", "uuid", UUID_PATTERN, {
    aliases: ["agent", "instance"],
    route: id => `/system?tab=agents&agent=${encodeURIComponent(id)}`,
    capabilities: ["open"],
  }),
  router: definition("router", "uuid", UUID_PATTERN, {
    route: id => `/system?tab=routers&router=${encodeURIComponent(id)}`,
    capabilities: ["open"],
  }),
};

const REFERENCE_TYPE_ALIASES = new Map<string, KnownReferenceType>(
  Object.values(REFERENCE_REGISTRY).flatMap(entry => [
    [entry.type, entry.type] as const,
    ...entry.aliases.map(alias => [alias, entry.type] as const),
  ]),
);

export interface ReferenceRef {
  type: ReferenceType;
  id: string;
  raw?: string;
  canonical: string;
  legacy?: boolean;
  metadata?: Record<string, unknown>;
}

export type ReferencePart =
  | { kind: "text"; text: string }
  | { kind: "reference"; ref: ReferenceRef };

export interface ReferenceAction {
  id: string;
  label: string;
  type: "navigate" | "mutate" | "copy" | "open_source";
  href?: string;
  payload?: Record<string, unknown>;
}

export interface ResolvedReference {
  ref: ReferenceRef;
  status: "resolved" | "missing" | "unauthorized" | "stale" | "loading" | "error";
  label: string;
  href?: string;
  icon?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  actions?: ReferenceAction[];
}

export function isKnownReferenceType(type: string): type is KnownReferenceType {
  return Object.prototype.hasOwnProperty.call(REFERENCE_REGISTRY, type);
}

export function normalizeReferenceType(type: string): ReferenceType {
  const normalized = type.trim().toLowerCase();
  return REFERENCE_TYPE_ALIASES.get(normalized) ?? normalized;
}

export function getReferenceTypeDefinition(type: string): ReferenceTypeDefinition | undefined {
  const normalized = normalizeReferenceType(type);
  return isKnownReferenceType(normalized) ? REFERENCE_REGISTRY[normalized] : undefined;
}

export function isValidReferenceIdentifier(type: string, id: string): boolean {
  const entry = getReferenceTypeDefinition(type);
  return !!entry && entry.identifierPattern.test(id.trim());
}

export function serializeReference(ref: Pick<ReferenceRef, "type" | "id">): string {
  return `@${normalizeReferenceType(ref.type)}:${ref.id.trim()}`;
}

export function createReferenceRef(params: {
  type: string;
  id: string;
  raw?: string;
  legacy?: boolean;
  metadata?: Record<string, unknown>;
}): ReferenceRef {
  const type = normalizeReferenceType(params.type);
  const id = params.id.trim();
  return {
    type,
    id,
    raw: params.raw,
    legacy: params.legacy,
    canonical: serializeReference({ type, id }),
    metadata: params.metadata,
  };
}

export function isParseableReferenceType(type: string): boolean {
  return !!getReferenceTypeDefinition(type);
}
