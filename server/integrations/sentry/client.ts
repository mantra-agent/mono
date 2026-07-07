import { getSecret } from "../../secrets-store";
import { createLogger } from "../../log";

const log = createLogger("SentryClient");

const SENTRY_API_BASE = "https://sentry.io/api/0";

export class SentryApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "SentryApiError";
    this.status = status;
    this.details = details;
  }
}

export interface SentryConfig {
  hasToken: boolean;
  org: string | null;
  project: string | null;
}

export async function getSentryConfig(): Promise<SentryConfig> {
  const token = await getSecret("SENTRY_AUTH_TOKEN");
  const org = await getSecret("SENTRY_ORG");
  const project = await getSecret("SENTRY_PROJECT");
  return {
    hasToken: !!(token && token.length > 0),
    org: org || null,
    project: project || null,
  };
}

export function isSentryConfigured(
  cfg: SentryConfig
): cfg is SentryConfig & { org: string; project: string; hasToken: true } {
  return cfg.hasToken && !!cfg.org && !!cfg.project;
}

async function sentryFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getSecret("SENTRY_AUTH_TOKEN");
  if (!token) throw new SentryApiError("SENTRY_AUTH_TOKEN not configured", 401);

  const url = `${SENTRY_API_BASE}${path}`;
  log.debug(`${options.method ?? "GET"} ${path}`);

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text().catch(() => null);
    }
    log.error(`Sentry API error: ${res.status} ${res.statusText}`, { detail });
    throw new SentryApiError(
      `Sentry API ${res.status}: ${res.statusText}`,
      res.status,
      detail
    );
  }

  return res;
}

// --- Types ---

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  status: string;
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  metadata: Record<string, unknown>;
  platform?: string;
  type?: string;
  project?: { id: string; name: string; slug: string };
}

export interface SentryEvent {
  eventID: string;
  id: string;
  title: string;
  message: string;
  dateCreated: string;
  platform: string;
  culprit: string;
  tags: Array<{ key: string; value: string }>;
  entries?: Array<{ type: string; data: unknown }>;
  contexts?: Record<string, unknown>;
  user?: Record<string, unknown>;
  sdk?: Record<string, unknown>;
  crashFile?: string | null;
  location?: string;
  groupID?: string;
}

// --- API functions ---

export async function fetchIssues(
  org: string,
  project: string,
  options: { query?: string; sort?: string; limit?: number } = {}
): Promise<SentryIssue[]> {
  const params = new URLSearchParams();
  params.set("query", options.query ?? "is:unresolved");
  if (options.sort) params.set("sort", options.sort);
  params.set("limit", String(Math.min(100, Math.max(1, options.limit ?? 25))));

  const res = await sentryFetch(
    `/projects/${org}/${project}/issues/?${params}`
  );
  return res.json();
}

export async function fetchIssue(
  org: string,
  issueId: string
): Promise<SentryIssue> {
  const res = await sentryFetch(
    `/organizations/${org}/issues/${issueId}/`
  );
  return res.json();
}

export async function fetchIssueEvents(
  org: string,
  issueId: string,
  options: { full?: boolean; limit?: number } = {}
): Promise<SentryEvent[]> {
  const params = new URLSearchParams();
  if (options.full !== false) params.set("full", "true");
  params.set(
    "per_page",
    String(Math.min(100, Math.max(1, options.limit ?? 10)))
  );

  const res = await sentryFetch(
    `/organizations/${org}/issues/${issueId}/events/?${params}`
  );
  return res.json();
}

export async function fetchLatestEvent(
  org: string,
  issueId: string
): Promise<SentryEvent> {
  const res = await sentryFetch(
    `/organizations/${org}/issues/${issueId}/events/latest/?full=true`
  );
  return res.json();
}

export async function updateIssueStatus(
  org: string,
  issueId: string,
  status: "resolved" | "unresolved" | "ignored"
): Promise<SentryIssue> {
  const res = await sentryFetch(
    `/organizations/${org}/issues/${issueId}/`,
    {
      method: "PUT",
      body: JSON.stringify({ status }),
    }
  );
  return res.json();
}
