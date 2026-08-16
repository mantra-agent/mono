export const SCREEN_REGISTRY = {
  home: { label: "Home", path: "/home" },
  email: { label: "Email", path: "/email", aliases: ["/comms"] },
  projects: { label: "Projects", path: "/projects", aliases: ["/work"] },
  identity: { label: "Identity", path: "/business/identity", aliases: ["/business/definition"] },
  plan: { label: "Plan", path: "/business/plan", aliases: ["/business/advantage"] },
  library: { label: "Library", path: "/library", aliases: ["/info", "/library2"] },
  performance: { label: "Performance", path: "/performance", aliases: ["/tools/performance", "/system?tab=resources"] },
  metrics: { label: "Metrics", path: "/tools/metrics", aliases: ["/business/metrics"] },
  kpis: { label: "KPIs", path: "/tools/kpis", aliases: ["/business/kpis"] },
  build: { label: "Build", path: "/build", aliases: ["/dev"] },
  orientation: { label: "Orientation", path: "/orientation", aliases: ["/world"] },
  vision: { label: "Vision", path: "/vision" },
  scenarios: { label: "Scenarios", path: "/scenarios" },
  account: { label: "Account", path: "/account" },
  observations: { label: "Observations", path: "/brain?tab=observations" },
  plans: { label: "Plans", path: "/brain?tab=plans" },
  personas: { label: "Personas", path: "/brain?tab=persona" },
  models: { label: "Models", path: "/brain?tab=model" },
  prompts: { label: "Prompts", path: "/system?tab=prompts" },
  inference: { label: "Inference", path: "/system?tab=inference" },
  routers: { label: "Routers", path: "/system?tab=routers" },
  cost: { label: "Cost", path: "/system?tab=cost" },
  database: { label: "Database", path: "/database" },
} as const;

export type ScreenId = keyof typeof SCREEN_REGISTRY;

export function screenLabel(id: ScreenId): string {
  return SCREEN_REGISTRY[id].label;
}

export function screenPath(id: ScreenId): string {
  return SCREEN_REGISTRY[id].path;
}
