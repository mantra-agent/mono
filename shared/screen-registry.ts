/**
 * Closed catalog of named product screens. Sole author of screen paths and labels.
 * Nav open targets and `@screen:{id}` references consume this; they do not re-author paths.
 */
export const SCREEN_REGISTRY = {
  home: { label: "Home", path: "/home" },
  dashboard: { label: "Dashboard", path: "/dashboard" },
  news: { label: "News", path: "/news" },
  email: { label: "Email", path: "/email", aliases: ["/comms"] },
  library: { label: "Library", path: "/library", aliases: ["/info", "/library2"] },
  files: { label: "Files", path: "/files" },
  schedule: { label: "Schedule", path: "/schedule" },
  projects: { label: "Projects", path: "/projects", aliases: ["/work"] },
  habits: { label: "Habits", path: "/habits" },
  reflections: { label: "Reflections", path: "/reflections" },
  gratitude: { label: "Gratitude", path: "/gratitude" },
  people: { label: "People", path: "/people" },
  meetings: { label: "Meetings", path: "/meetings" },
  companies: { label: "Companies", path: "/companies" },
  pipelines: { label: "Pipelines", path: "/pipelines" },
  goals: { label: "Goals", path: "/goals" },
  decisions: { label: "Decisions", path: "/decisions" },
  scenarios: { label: "Scenarios", path: "/scenarios" },
  tags: { label: "Tags", path: "/tags" },
  identity: { label: "Identity", path: "/business/identity", aliases: ["/business/definition"] },
  pricing: { label: "Pricing", path: "/business/pricing" },
  "business-model": { label: "Business Model", path: "/business/model" },
  budgets: { label: "Budgets", path: "/business/budgets" },
  plan: { label: "Plan", path: "/business/plan", aliases: ["/business/advantage"] },
  roles: { label: "Roles", path: "/business/roles" },
  hiring: { label: "Hiring", path: "/business/hiring" },
  kpis: { label: "KPIs", path: "/tools/kpis", aliases: ["/business/kpis"] },
  metrics: { label: "Metrics", path: "/tools/metrics", aliases: ["/business/metrics"] },
  health: { label: "Health", path: "/health" },
  agendas: { label: "Agendas", path: "/agendas" },
  skills: { label: "Skills", path: "/skills" },
  templates: { label: "Templates", path: "/templates" },
  plans: { label: "Plans", path: "/brain?tab=plans" },
  hooks: { label: "Hooks", path: "/system?tab=hooks" },
  timers: { label: "Timers", path: "/system?tab=timers" },
  orientation: { label: "Orientation", path: "/orientation", aliases: ["/world"] },
  personas: { label: "Personas", path: "/personas", aliases: ["/brain?tab=persona"] },
  emotion: { label: "Emotion", path: "/brain?tab=emotion" },
  "memory-layers": { label: "Memory", path: "/memory?tab=memories" },
  "memory-graph": { label: "Memory Graph", path: "/memory?tab=graph" },
  "memory-journal": { label: "Memory Journal", path: "/memory?tab=maintenance" },
  platforms: { label: "Platforms", path: "/platforms" },
  products: { label: "Products", path: "/products" },
  features: { label: "Features", path: "/build/features" },
  design: { label: "Design", path: "/design" },
  database: { label: "Database", path: "/database" },
  issues: { label: "Issues", path: "/build?tab=issues" },
  performance: { label: "Performance", path: "/performance", aliases: ["/tools/performance", "/system?tab=resources"] },
  logs: { label: "Logs", path: "/system?tab=logs" },
  events: { label: "Events", path: "/system?tab=events" },
  tools: { label: "Tools", path: "/system?tab=tools" },
  prompts: { label: "Prompts", path: "/system?tab=prompts" },
  context: { label: "Context", path: "/brain?tab=context" },
  inference: { label: "Inference", path: "/system?tab=inference" },
  routers: { label: "Routers", path: "/system?tab=routers" },
  models: { label: "Models", path: "/brain?tab=model" },
  cost: { label: "Cost", path: "/system?tab=cost" },
  audiences: { label: "Audiences", path: "/audiences" },
  campaigns: { label: "Campaigns", path: "/campaigns" },
  accounts: { label: "Accounts", path: "/system?tab=accounts" },
  agents: { label: "Agents", path: "/system?tab=agents" },
  users: { label: "Users", path: "/system?tab=users" },
  secrets: { label: "Secrets", path: "/system?tab=secrets" },
  vaults: { label: "Vaults", path: "/vaults" },
  teams: { label: "Teams", path: "/teams" },
  integrations: { label: "Integrations", path: "/integrations" },
  mods: { label: "Mods", path: "/mods" },
  account: { label: "Account", path: "/account" },
  build: { label: "Build", path: "/build", aliases: ["/dev"] },
  vision: { label: "Vision", path: "/vision" },
  observations: { label: "Observations", path: "/brain?tab=observations" },
} as const;

export type ScreenId = keyof typeof SCREEN_REGISTRY;

const SCREEN_IDS = Object.keys(SCREEN_REGISTRY) as ScreenId[];

/** Closed identifier set for `@screen:{id}` — registry keys only. */
export const SCREEN_ID_PATTERN = new RegExp(`^(?:${SCREEN_IDS.map(escapeRegExp).join("|")})$`);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isScreenId(value: string): value is ScreenId {
  return Object.prototype.hasOwnProperty.call(SCREEN_REGISTRY, value);
}

export function screenLabel(id: ScreenId): string {
  return SCREEN_REGISTRY[id].label;
}

export function screenPath(id: ScreenId): string {
  return SCREEN_REGISTRY[id].path;
}

export function listScreenEntries(): ReadonlyArray<{ id: ScreenId; label: string; path: string }> {
  return SCREEN_IDS.map(id => ({
    id,
    label: SCREEN_REGISTRY[id].label,
    path: SCREEN_REGISTRY[id].path,
  }));
}
