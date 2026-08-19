import { getSecret } from "../../secrets-store";
import { createLogger } from "../../log";
import { providerFetch, readBoundedProviderBody } from "../provider-http";
import {
  getSentryFullConfig,
  isSentryFullyConfigured,
  resolveSentryDsn,
  type SentryFullConfig,
} from "./config";

const log = createLogger("SentryClient");

const SENTRY_API_BASE = "https://sentry.io/api/0";

export class SentryApiError extends Error {
  status: number;
  details?: unknown;
  /** Stable machine code for known caller-correctable failures. */
  code?: string;
  constructor(message: string, status = 500, details?: unknown, code?: string) {
    super(message);
    this.name = "SentryApiError";
    this.status = status;
    this.details = details;
    if (code) this.code = code;
  }
}

/** API + crash-capture readiness. Prefer this over the legacy token-only shape. */
export type SentryConfig = SentryFullConfig;

export interface SentryUptimeAggregate {
  checkCount: number;
  failureRatePercent: number;
  incomplete: boolean;
}

export async function getSentryConfig(): Promise<SentryConfig> {
  return getSentryFullConfig();
}

export function isSentryConfigured(
  cfg: SentryConfig
): cfg is SentryConfig & { dsn: string; org: string; project: string; hasToken: true } {
  return isSentryFullyConfigured(cfg);
}

export { resolveSentryDsn };

/**
 * Sentry issue search does not support Boolean OR/AND operators. Space-separated
 * terms are implicit AND; multi-value OR uses key:[a,b]. Standalone OR/AND tokens
 * produce HTTP 400 from the issues endpoint.
 */
const ISSUE_SEARCH_BOOLEAN_OPERATOR = /(?:^|[\s(])(?:OR|AND)(?:$|[\s)])/;

export function assertValidIssueSearchQuery(query: string): void {
  if (!ISSUE_SEARCH_BOOLEAN_OPERATOR.test(query)) return;
  throw new SentryApiError(
    "Sentry issue search does not support Boolean OR/AND. Use space-separated terms (implicit AND) or key:[value1,value2] for multi-value match.",
    400,
    { reason: "boolean_operators_unsupported", query: query.slice(0, 200) },
    "invalid_search_query",
  );
}

function isKnownInvalidSearchDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return /Boolean statements containing\s*"?(?:OR|AND)"?/i.test(detail)
    || /Boolean statements containing .* are not supported in this search/i.test(detail)
    || /Error parsing search query/i.test(detail);
}

type SentryFetchOptions = RequestInit & {
  /**
   * HTTP statuses that are expected for this call site. Returned as a normal
   * Response without error-logging or throw so callers can map them to a typed
   * domain state (e.g. no uptime monitor yet).
   */
  acceptStatuses?: number[];
};

async function sentryFetch(
  path: string,
  options: SentryFetchOptions = {}
): Promise<Response> {
  const { acceptStatuses, ...init } = options;
  const token = await getSecret("SENTRY_AUTH_TOKEN");
  if (!token) throw new SentryApiError("SENTRY_AUTH_TOKEN not configured", 401);

  const url = `${SENTRY_API_BASE}${path}`;
  log.debug(`${init.method ?? "GET"} ${path}`);

  const res = await providerFetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!res.ok) {
    if (acceptStatuses?.includes(res.status)) {
      log.debug(`Sentry API expected status: ${res.status} ${res.statusText}`, {
        path,
      });
      return res;
    }
    const detail = await readBoundedProviderBody(res).catch(() => null);
    // Known-invalid issue search shapes are caller input, not integration defects.
    if (res.status === 400 && isKnownInvalidSearchDetail(detail)) {
      log.debug(`Sentry API invalid search query: ${res.status} ${res.statusText}`, {
        path,
        detailPreview: detail?.slice(0, 300) || undefined,
      });
      throw new SentryApiError(
        `Sentry API ${res.status}: invalid search query`,
        res.status,
        detail,
        "invalid_search_query",
      );
    }
    // Missing issue/project/resource is caller input (stale id, wrong org scope),
    // not an integration defect — warn + stable code so ERRORS does not page 404s.
    if (res.status === 404) {
      log.warn(`Sentry API missing resource: ${res.status} ${res.statusText}`, {
        path,
        detailPreview: detail?.slice(0, 300) || undefined,
      });
      throw new SentryApiError(
        `Sentry API ${res.status}: ${res.statusText}`,
        res.status,
        detail,
        "resource_not_found",
      );
    }
    log.error(`Sentry API error: ${res.status} ${res.statusText}`, {
      detailPreview: detail?.slice(0, 500) || undefined,
    });
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
  const query = options.query ?? "is:unresolved";
  assertValidIssueSearchQuery(query);
  const params = new URLSearchParams();
  params.set("query", query);
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

export async function fetchUptimeAggregate(
  org: string,
  project: string,
  input: { start: Date; end: Date; query?: string },
): Promise<SentryUptimeAggregate> {
  const projectRes = await sentryFetch(`/projects/${org}/${project}/`);
  const projectPayload = await projectRes.json() as { id?: unknown };
  const projectId = String(projectPayload.id ?? "");
  if (!/^\d+$/.test(projectId)) {
    throw new SentryApiError("Sentry returned an invalid project identity", 502);
  }

  const params = new URLSearchParams();
  params.set("dataset", "uptime_results");
  params.append("project", projectId);
  params.append("field", "count()");
  params.append("field", "failure_rate()");
  params.set("start", input.start.toISOString());
  params.set("end", input.end.toISOString());
  params.set("per_page", "1");
  const query = input.query?.trim();
  if (query) params.set("query", query.slice(0, 500));

  // 400/404 on uptime_results means the project has no usable uptime monitor
  // (or the dataset is not available yet). That is a coverage gap, not a
  // SentryClient failure — return incomplete so availability maps to
  // monitor_pending instead of error-logging SENTRY_API_ERROR_400.
  const res = await sentryFetch(`/organizations/${org}/events/?${params}`, {
    acceptStatuses: [400, 404],
  });
  if (!res.ok) {
    log.debug("Sentry uptime_results unavailable; treating as incomplete", {
      status: res.status,
      org,
      project,
    });
    return { checkCount: 0, failureRatePercent: 0, incomplete: true };
  }
  const payload = await res.json() as {
    data?: Array<Record<string, unknown>>;
    meta?: { fields?: Record<string, string> };
  };
  const row = payload.data?.[0];
  if (!row) return { checkCount: 0, failureRatePercent: 0, incomplete: true };
  const checkCount = Number(row["count()"]);
  const failureRatePercent = Number(row["failure_rate()"]);
  if (!Number.isFinite(checkCount) || checkCount < 0 || !Number.isFinite(failureRatePercent) || failureRatePercent < 0 || failureRatePercent > 100) {
    throw new SentryApiError("Sentry returned an invalid uptime aggregate", 502);
  }
  return {
    checkCount: Math.floor(checkCount),
    failureRatePercent,
    incomplete: false,
  };
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
