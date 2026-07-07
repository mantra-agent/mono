import { createLogger } from "../../log";
import { getSecret } from "../../secrets-store";
import { getAccountTokens, updateAccount } from "../../connected-accounts";
import type {
  OuraCollectionFetchOptions,
  OuraPagedResponse,
  OuraRequestOptions,
  OuraTokenResponse,
  OuraTokens,
  OuraWebhookSubscription,
  OuraWebhookSubscriptionRequest,
} from "./types";

const log = createLogger("OuraClient");

const OURA_API_BASE_URL = "https://api.ouraring.com";
const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PAGES = 20;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_RATE_LIMIT_SLEEP_MS = 5_000;

export class OuraApiError extends Error {
  status: number;
  code: "configuration" | "auth" | "rate_limited" | "timeout" | "network" | "response";
  retryAfterMs?: number;

  constructor(message: string, status: number, code: OuraApiError["code"], retryAfterMs?: number) {
    super(message);
    this.name = "OuraApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface OuraOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export async function getOuraOAuthConfig(): Promise<OuraOAuthConfig> {
  const [clientId, clientSecret] = await Promise.all([
    getSecret("OURA_CLIENT_ID"),
    getSecret("OURA_CLIENT_SECRET"),
  ]);
  if (!clientId || !clientSecret) {
    throw new OuraApiError("Oura OAuth credentials are not configured", 400, "configuration");
  }
  return { clientId, clientSecret };
}

export async function isOuraConfigured(): Promise<boolean> {
  const [clientId, clientSecret] = await Promise.all([
    getSecret("OURA_CLIENT_ID"),
    getSecret("OURA_CLIENT_SECRET"),
  ]);
  return !!(clientId && clientSecret);
}

export function buildOuraAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    scope: input.scopes.join(" "),
  });
  return `${OURA_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeOuraCode(input: {
  code: string;
  redirectUri: string;
}): Promise<OuraTokens> {
  const config = await getOuraOAuthConfig();
  const tokens = await postTokenRequest({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  }, config);
  log.log("token exchange complete grantType=authorization_code");
  return normalizeTokenResponse(tokens);
}

export async function refreshOuraTokens(accountId: string, refreshToken: string): Promise<OuraTokens> {
  const config = await getOuraOAuthConfig();
  const tokens = await postTokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }, config);
  const refreshed = normalizeTokenResponse(tokens);
  const merged = { ...refreshed, refresh_token: refreshed.refresh_token || refreshToken };
  await updateAccount(accountId, { tokens: merged, healthError: null, healthCheckedAt: new Date() });
  log.log(`token refresh complete accountId=${accountId}`);
  return merged;
}

async function postTokenRequest(params: Record<string, string>, config: OuraOAuthConfig): Promise<OuraTokenResponse> {
  let response: Response;
  try {
    response = await fetch(OURA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw toNetworkError("Oura token request failed", err);
  }

  if (!response.ok) {
    throw await toResponseError(response, "Oura token request failed");
  }

  try {
    return await response.json() as OuraTokenResponse;
  } catch {
    throw new OuraApiError("Oura token endpoint returned invalid JSON", 502, "response");
  }
}

function normalizeTokenResponse(tokens: OuraTokenResponse): OuraTokens {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    scope: tokens.scope,
  };
}

function isOuraTokens(value: unknown): value is OuraTokens {
  return !!(
    value &&
    typeof value === "object" &&
    "access_token" in value &&
    typeof (value as { access_token?: unknown }).access_token === "string"
  );
}

async function getValidOuraTokens(accountId: string): Promise<OuraTokens> {
  const rawTokens = await getAccountTokens(accountId);
  if (!isOuraTokens(rawTokens)) {
    throw new OuraApiError(`Oura account ${accountId} is missing tokens`, 401, "auth");
  }

  const expiresAt = rawTokens.expires_at;
  if (expiresAt && expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS) {
    if (!rawTokens.refresh_token) {
      throw new OuraApiError(`Oura account ${accountId} requires reconnection`, 401, "auth");
    }
    return refreshOuraTokens(accountId, rawTokens.refresh_token);
  }
  return rawTokens;
}

export async function ouraFetch<T = unknown>(
  accountId: string,
  path: string,
  options: OuraRequestOptions = {},
): Promise<T> {
  const method = options.method || "GET";
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retryOnRateLimit = options.retryOnRateLimit ?? true;
  const tokens = await getValidOuraTokens(accountId);
  const url = buildApiUrl(path, options.params);

  const response = await sendOuraRequest(url, method, tokens.access_token, options.body, timeoutMs);
  if (response.status === 429 && retryOnRateLimit) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    if (retryAfterMs > 0 && retryAfterMs <= MAX_RATE_LIMIT_SLEEP_MS) {
      log.warn(`rate limited method=${method} path=${sanitizePath(path)} retryAfterMs=${retryAfterMs} errorClass=rate_limited`);
      await sleep(retryAfterMs);
      const retryResponse = await sendOuraRequest(url, method, tokens.access_token, options.body, timeoutMs);
      return parseOuraResponse<T>(retryResponse, path);
    }
  }

  return parseOuraResponse<T>(response, path);
}

async function sendOuraRequest(
  url: URL,
  method: string,
  accessToken: string,
  body: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    throw toNetworkError(`Oura API request failed path=${sanitizePath(url.pathname)}`, err);
  }
}

async function parseOuraResponse<T>(response: Response, path: string): Promise<T> {
  if (!response.ok) {
    throw await toResponseError(response, `Oura API request failed path=${sanitizePath(path)}`);
  }

  if (response.status === 204) return undefined as T;

  try {
    return await response.json() as T;
  } catch {
    throw new OuraApiError(`Oura API returned invalid JSON path=${sanitizePath(path)}`, response.status || 502, "response");
  }
}


export async function createOuraWebhookSubscription(
  input: OuraWebhookSubscriptionRequest,
): Promise<OuraWebhookSubscription> {
  const subscription = await ouraAppFetch<OuraWebhookSubscription>("/v2/webhook/subscription", {
    method: "POST",
    body: input,
  });
  log.log(`webhook subscription created dataType=${subscription.data_type} eventType=${subscription.event_type}`);
  return subscription;
}

export async function listOuraWebhookSubscriptions(): Promise<OuraWebhookSubscription[]> {
  return ouraAppFetch<OuraWebhookSubscription[]>("/v2/webhook/subscription");
}

async function ouraAppFetch<T = unknown>(
  path: string,
  options: Omit<OuraRequestOptions, "params"> & { params?: Record<string, string | number | boolean | undefined | null> } = {},
): Promise<T> {
  const config = await getOuraOAuthConfig();
  const url = buildApiUrl(path, options.params);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": config.clientId,
        "x-client-secret": config.clientSecret,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw toNetworkError(`Oura app API request failed path=${sanitizePath(path)}`, err);
  }
  return parseOuraResponse<T>(response, path);
}

export async function fetchOuraCollection<T = unknown>(
  options: OuraCollectionFetchOptions<T>,
): Promise<T[]> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = options.pageSize;
  const allItems: T[] = [];
  let nextToken: string | undefined;
  let page = 0;

  do {
    page += 1;
    const response = await ouraFetch<OuraPagedResponse<unknown>>(options.accountId, options.path, {
      params: {
        ...options.params,
        next_token: nextToken,
        page_size: pageSize,
      },
    });
    const pageItems = Array.isArray(response.data) ? response.data : [];
    const mappedItems = options.mapPage ? options.mapPage(pageItems) : pageItems as T[];
    allItems.push(...mappedItems);
    nextToken = typeof response.next_token === "string" && response.next_token.length > 0 ? response.next_token : undefined;
    log.debug(`collection page path=${sanitizePath(options.path)} startDate=${options.params?.start_date || "-"} endDate=${options.params?.end_date || "-"} page=${page} items=${pageItems.length} hasNext=${!!nextToken}`);
  } while (nextToken && page < maxPages);

  if (nextToken) {
    log.warn(`pagination capped path=${sanitizePath(options.path)} startDate=${options.params?.start_date || "-"} endDate=${options.params?.end_date || "-"} maxPages=${maxPages}`);
  }

  log.log(`collection fetched path=${sanitizePath(options.path)} startDate=${options.params?.start_date || "-"} endDate=${options.params?.end_date || "-"} pages=${page} items=${allItems.length}`);
  return allItems;
}

function buildApiUrl(path: string, params?: Record<string, string | number | boolean | undefined | null>): URL {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(normalizedPath, OURA_API_BASE_URL);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function toResponseError(response: Response, prefix: string): Promise<OuraApiError> {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const code = response.status === 401 || response.status === 403
    ? "auth"
    : response.status === 429
      ? "rate_limited"
      : "response";
  const safeMessage = `${prefix}: HTTP ${response.status}${retryAfterMs ? ` retryAfterMs=${retryAfterMs}` : ""}`;
  try {
    await response.text();
  } catch {
    // Drain best-effort without using or logging raw provider payloads.
  }
  return new OuraApiError(safeMessage, response.status || 502, code, retryAfterMs || undefined);
}

function toNetworkError(prefix: string, err: unknown): OuraApiError {
  const message = err instanceof Error ? err.message : String(err);
  const isTimeout = err instanceof Error && err.name === "TimeoutError";
  return new OuraApiError(`${prefix}: ${message}`, isTimeout ? 504 : 502, isTimeout ? "timeout" : "network");
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return 0;
}

function sanitizePath(path: string): string {
  const withoutQuery = path.split("?")[0] || "/";
  return withoutQuery.replace(/[A-Za-z0-9_-]{24,}/g, "[id]");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
