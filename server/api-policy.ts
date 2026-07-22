import type { Express, Request, Response, NextFunction } from "express";
import { createLogger } from "./log";
import { getPrincipal, type Principal } from "./principal";
import { SUPERVISOR_HEALTH_PATH } from "./supervisor-health-contract";

const log = createLogger("api-policy");

export type ApiPolicyClassification = "public" | "personal" | "admin" | "service";

interface ApiPolicyRule {
  classification: ApiPolicyClassification;
  methods?: readonly string[];
  exact?: readonly string[];
  prefixes?: readonly string[];
  pattern?: RegExp;
  reason: string;
}

interface ApiPolicyEvaluation {
  classification: ApiPolicyClassification | "unclassified";
  reason: string;
  matchedRule?: string;
}

const PUBLIC_RULES: ApiPolicyRule[] = [
  { classification: "public", exact: ["/api/health", "/api/version", "/api/boot-status", "/api/boot/status", "/api/client-error", "/api/auth/status", "/api/auth/automation-login"], reason: "health, boot, and authentication bootstrap" },
  { classification: "public", methods: ["GET"], exact: [SUPERVISOR_HEALTH_PATH], reason: "process-local capability health probe" },
  { classification: "public", prefixes: ["/api/public", "/api/meeting-output"], reason: "explicit public capability-token or acquisition route" },
  { classification: "public", exact: ["/api/auth/login", "/api/auth/logout", "/api/auth/setup", "/api/auth/register", "/api/auth/reset"], reason: "authentication and setup flow" },
  { classification: "public", pattern: /^\/api\/auth\/(?:invite|reset)\/[^/]+$/, reason: "single-use authentication capability redemption" },
  { classification: "public", prefixes: ["/api/voice/llm/"], reason: "voice provider callback ingress" },
  { classification: "public", prefixes: ["/api/objects/", "/objects"], methods: ["GET"], reason: "object read path with object ACL checks downstream" },
  { classification: "personal", prefixes: ["/api/uploads"], reason: "authenticated user upload path" },
  { classification: "personal", exact: ["/api/glasses/toast"], methods: ["POST"], reason: "authenticated app-to-glasses toast relay" },
  { classification: "public", prefixes: ["/api/integrations/github/status"], methods: ["GET"], reason: "connection status only" },
];

const ADMIN_RULES: ApiPolicyRule[] = [
  { classification: "admin", prefixes: ["/api/admin", "/api/backup", "/api/backups", "/api/db-sync", "/api/schema", "/api/logs", "/api/events", "/api/tool-stats", "/api/secrets", "/api/diag", "/api/diagnostics", "/api/workspace", "/api/railway", "/api/expo", "/api/integrations/github", "/api/gitnexus", "/api/gitnexus-status", "/api/encryption", "/api/performance", "/api/gateway", "/api/models", "/api/settings", "/api/maintenance", "/api/mobile", "/api/setup", "/api/server", "/api/boot-info", "/api/config", "/api/design-doc", "/api/trust-config", "/api/openai-subscription", "/api/claude-cli", "/api/elevenlabs", "/api/integrations/expo", "/api/integrations/automation-auth", "/api/platforms", "/api/provider-connections", "/api/prompt-modules", "/api/communications", "/api/notifications", "/api/auth/users", "/api/auth/meeting-join-policy", "/api/auth/dev-login", "/api/dev"], reason: "system administration route" },
  { classification: "admin", prefixes: ["/api/auth/invite", "/api/auth/reset-request"], reason: "user administration route" },
  {
    classification: "admin",
    prefixes: [
      "/api/integrations/recall",
      "/api/integrations/twilio",
      "/api/integrations/deepgram",
      "/api/integrations/meta/wearables",
    ],
    reason: "privileged integration status and configuration route",
  },
];

const SERVICE_RULES: ApiPolicyRule[] = [
  { classification: "service", prefixes: ["/api/agent", "/api/autonomous", "/api/executor", "/api/hooks/run", "/api/timers/trigger", "/api/skills/run", "/api/brain"], reason: "agent/service execution route" },
  { classification: "service", prefixes: ["/api/webhooks", "/api/integrations/oura/webhook", "/api/oura/webhook", "/api/plaid/webhook"], reason: "external service webhook ingress" },
];

const PERSONAL_RULES: ApiPolicyRule[] = [
  { classification: "personal", exact: ["/api/client-logs", "/api/browser-telemetry", "/api/browser-telemetry/summary"], reason: "authenticated bounded client diagnostics" },
  {
    classification: "personal",
    prefixes: [
      "/api/auth/me",
      "/api/onboarding",
      "/api/issues",
      "/api/people",
      "/api/goals",
      "/api/priorities",
      "/api/tasks",
      "/api/projects",
      "/api/calendar",
      "/api/meetings",
      "/api/memory",
      "/api/context",
      "/api/strategy",
      "/api/decisions",
      "/api/theses",
      "/api/landscape",
      "/api/library",
      "/api/library2",
      "/api/notes",
      "/api/sessions",
      "/api/messages",
      "/api/chat",
      "/api/client-presence",
      "/api/content",
      "/api/personas",
      "/api/emotion",
      "/api/cognition",
      "/api/hooks",
      "/api/principles",
      "/api/emotional-state",
      "/api/tools",
      "/api/tool-icons",
      "/api/session-runs",
      "/api/inference",
      "/api/info",
      "/api/intentions",
      "/api/connected-accounts",
      "/api/notion",
      "/api/import-queue",
      "/api/twitter",
      "/api/triage-log",
      "/api/email-drafts",
      "/api/email-sync",
      "/api/session",
      "/api/home",
      "/api/plans",
      "/api/export",
      "/api/life-goals",
      "/api/tags",
      "/api/render",
      "/api/oura",
      "/api/plaid",
      "/api/version",
      "/api/pronunciation",
      "/api/references",
      "/api/voice",
      "/api/skills",
      "/api/finance",
      "/api/health",
      "/api/wellness",
      "/api/workflows",
      "/api/exec",
      "/api/opportunities",
      "/api/rules",
      "/api/vaults",

      "/api/email",
      "/api/gmail",
      "/api/calendar",
      "/api/files",
      "/api/object-storage",
      "/api/media",
      "/api/magic-demo",
      "/api/glasses-agent",
      "/api/glasses",
      "/api/companies",
      "/api/observations",
      "/api/dashboard",
      "/api/generate-image",
      "/api/auth/profile",
      "/api/auth/ui-prefs",
      "/api/auth/change-password",
    ],
    reason: "personal user data route",
  },
];

const API_POLICY_RULES = [...PUBLIC_RULES, ...ADMIN_RULES, ...SERVICE_RULES, ...PERSONAL_RULES];
const REPORT_ONLY = process.env.API_POLICY_ENFORCEMENT === "report";
const RATE_WINDOW_MS = 60_000;
const RATE_BUCKET_LIMIT = 20_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMITS: Record<ApiPolicyClassification | "unclassified", number> = {
  public: 120,
  personal: 300,
  admin: 120,
  service: 600,
  unclassified: 0,
};

function apiPathFromRequest(req: Request): string {
  const raw = req.originalUrl || req.url || req.path;
  try {
    return new URL(raw, "http://localhost").pathname;
  } catch {
    return raw.split("?")[0] || req.path;
  }
}

function ruleMatches(rule: ApiPolicyRule, method: string, path: string): boolean {
  if (rule.methods && !rule.methods.includes(method)) return false;
  if (rule.exact?.includes(path)) return true;
  if (rule.prefixes?.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) return true;
  if (rule.pattern?.test(path)) return true;
  return false;
}

export function classifyApiRequest(method: string, path: string): ApiPolicyEvaluation {
  for (const rule of API_POLICY_RULES) {
    if (ruleMatches(rule, method.toUpperCase(), path)) {
      return { classification: rule.classification, reason: rule.reason, matchedRule: rule.reason };
    }
  }
  return { classification: "unclassified", reason: "no explicit API policy rule matched" };
}

function principalSatisfies(evaluation: ApiPolicyEvaluation, principal: Principal | null): boolean {
  if (evaluation.classification === "public") return true;
  if (evaluation.classification === "unclassified") return false;
  if (evaluation.classification === "service" && evaluation.reason === "external service webhook ingress") return true;
  if (!principal) return false;
  if (evaluation.classification === "personal") return principal.actorType === "user" || principal.actorType === "service" || principal.actorType === "system";
  if (evaluation.classification === "admin") return principal.isAdmin || principal.actorType === "system";
  if (evaluation.classification === "service") return principal.actorType === "service" || principal.actorType === "system" || principal.isAdmin;
  return false;
}

function warningPayload(req: Request, res: Response, evaluation: ApiPolicyEvaluation, principal: Principal | null, classifiedPath: string) {
  return {
    event: "api_policy_report_only_warning",
    mode: REPORT_ONLY ? "report_only" : "enforce",
    method: req.method,
    path: req.path,
    classifiedPath,
    originalUrl: req.originalUrl,
    baseUrl: req.baseUrl,
    url: req.url,
    statusCode: res.statusCode,
    classification: evaluation.classification,
    reason: evaluation.reason,
    matchedRule: evaluation.matchedRule ?? null,
    hasSimplePrefix: PERSONAL_RULES.some(rule => rule.prefixes?.includes("/api/home")),
    totalRules: API_POLICY_RULES.length,
    hasPrincipal: !!principal,
    principalActorType: principal?.actorType ?? null,
    principalUserId: principal?.userId ?? null,
    principalAccountId: principal?.accountId ?? null,
  };
}


function clientAddress(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function enforceAbuseBudget(req: Request, res: Response, evaluation: ApiPolicyEvaluation): boolean {
  const limit = RATE_LIMITS[evaluation.classification];
  if (limit <= 0) return false;
  const now = Date.now();
  if (rateBuckets.size >= RATE_BUCKET_LIMIT) {
    for (const [key, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(key);
    if (rateBuckets.size >= RATE_BUCKET_LIMIT) rateBuckets.delete(rateBuckets.keys().next().value as string);
  }
  const key = `${evaluation.classification}:${clientAddress(req)}`;
  const current = rateBuckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + RATE_WINDOW_MS }
    : { count: current.count + 1, resetAt: current.resetAt };
  rateBuckets.set(key, bucket);
  res.setHeader("RateLimit-Limit", String(limit));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
  res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count <= limit) return true;
  res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
  res.status(429).json({ error: "Request budget exceeded" });
  return false;
}

export function apiPolicyReportMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestPath = apiPathFromRequest(req);
  if (!requestPath.startsWith("/api")) return next();

  res.on("finish", () => {
    const finishPath = apiPathFromRequest(req);
    const evaluation = classifyApiRequest(req.method, finishPath);
    const principal = getPrincipal(req);
    const satisfied = principalSatisfies(evaluation, principal);
    if (evaluation.classification === "unclassified" || !satisfied) {
      log.warn("API policy route needs classification or guard", warningPayload(req, res, evaluation, principal, finishPath));
    }
  });

  const evaluation = classifyApiRequest(req.method, requestPath);
  const principal = getPrincipal(req);
  if (!REPORT_ONLY && !principalSatisfies(evaluation, principal)) {
    const status = evaluation.classification === "unclassified" ? 404 : 401;
    return res.status(status).json({ error: status === 404 ? "Not found" : "Authentication required" });
  }
  if (!enforceAbuseBudget(req, res, evaluation)) return;

  next();
}

export function getApiPolicyStatus() {
  return {
    mode: REPORT_ONLY ? "report_only" : "enforce",
    publicRules: PUBLIC_RULES.length,
    personalRules: PERSONAL_RULES.length,
    adminRules: ADMIN_RULES.length,
    serviceRules: SERVICE_RULES.length,
    totalRules: API_POLICY_RULES.length,
  };
}

export function registerApiPolicy(app: Express): void {
  app.use(apiPolicyReportMiddleware);
  log.log("API policy registered", getApiPolicyStatus());
}
