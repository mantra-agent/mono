import crypto from "crypto";
import {
  getAccount,
  getAccountTokens,
  updateAccount,
} from "./connected-accounts";
import { createLogger } from "./log";
import { getRuntimePublicBaseUrl } from "./runtime-identity";
import { getSecretSync } from "./secrets-store";

const log = createLogger("QuickBooks");

export const QUICKBOOKS_PROVIDER = "quickbooks";
export const QUICKBOOKS_SCOPE = "com.intuit.quickbooks.accounting";

const AUTHORIZATION_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_CHARS = 1_000_000;
const VALID_ENVIRONMENTS = ["sandbox", "production"] as const;

type QuickBooksEnvironment = typeof VALID_ENVIRONMENTS[number];

export interface QuickBooksTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
  refresh_token_expiry_date: number | null;
  scope: string;
  environment: QuickBooksEnvironment;
}

export interface QuickBooksCompanyInfo {
  companyName: string;
  legalName: string | null;
  country: string | null;
  fiscalYearStartMonth: string | null;
}

export interface QuickBooksConfigDiagnostics {
  configured: boolean;
  missing: string[];
  invalid: string[];
  details: {
    QUICKBOOKS_CLIENT_ID: { set: boolean };
    QUICKBOOKS_CLIENT_SECRET: { set: boolean };
    QUICKBOOKS_ENV: { set: boolean; value: string | null; valid: boolean; validValues: string[] };
  };
}

export class QuickBooksApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "configuration" | "authorization" | "provider" | "invalid_response" | "not_found",
  ) {
    super(message);
    this.name = "QuickBooksApiError";
  }
}

function getEnvironment(): QuickBooksEnvironment {
  const environment = getSecretSync("QUICKBOOKS_ENV");
  if (environment === "sandbox" || environment === "production") return environment;
  throw new QuickBooksApiError("QuickBooks environment is not configured", 400, "configuration");
}

function getConfig(): { clientId: string; clientSecret: string; environment: QuickBooksEnvironment } {
  const clientId = getSecretSync("QUICKBOOKS_CLIENT_ID");
  const clientSecret = getSecretSync("QUICKBOOKS_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new QuickBooksApiError("QuickBooks OAuth credentials are not configured", 400, "configuration");
  }
  return { clientId, clientSecret, environment: getEnvironment() };
}

export function getQuickBooksConfigDiagnostics(): QuickBooksConfigDiagnostics {
  const clientId = getSecretSync("QUICKBOOKS_CLIENT_ID");
  const clientSecret = getSecretSync("QUICKBOOKS_CLIENT_SECRET");
  const environment = getSecretSync("QUICKBOOKS_ENV");
  const missing: string[] = [];
  const invalid: string[] = [];

  if (!clientId) missing.push("QUICKBOOKS_CLIENT_ID");
  if (!clientSecret) missing.push("QUICKBOOKS_CLIENT_SECRET");
  if (!environment) missing.push("QUICKBOOKS_ENV");
  else if (!VALID_ENVIRONMENTS.includes(environment as QuickBooksEnvironment)) invalid.push("QUICKBOOKS_ENV");

  return {
    configured: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    details: {
      QUICKBOOKS_CLIENT_ID: { set: Boolean(clientId) },
      QUICKBOOKS_CLIENT_SECRET: { set: Boolean(clientSecret) },
      QUICKBOOKS_ENV: {
        set: Boolean(environment),
        value: environment || null,
        valid: Boolean(environment) && VALID_ENVIRONMENTS.includes(environment as QuickBooksEnvironment),
        validValues: [...VALID_ENVIRONMENTS],
      },
    },
  };
}

export function isQuickBooksConfigured(): boolean {
  return getQuickBooksConfigDiagnostics().configured;
}

export async function getQuickBooksRedirectUri(): Promise<string> {
  const baseUrl = await getRuntimePublicBaseUrl();
  if (!baseUrl) {
    throw new QuickBooksApiError("QuickBooks callback URL is unavailable", 400, "configuration");
  }
  return `${baseUrl}/api/quickbooks/oauth/callback`;
}

export async function buildQuickBooksAuthorizationUrl(state: string): Promise<string> {
  const { clientId } = getConfig();
  const redirectUri = await getQuickBooksRedirectUri();
  const url = new URL(AUTHORIZATION_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QUICKBOOKS_SCOPE);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > 32_000) {
    throw new QuickBooksApiError("QuickBooks returned an invalid token response", 502, "invalid_response");
  }
  return value;
}

function optionalPositiveSeconds(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

async function readProviderJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_PROVIDER_RESPONSE_CHARS) {
    throw new QuickBooksApiError("QuickBooks returned an oversized response", 502, "invalid_response");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new QuickBooksApiError("QuickBooks returned an invalid response", 502, "invalid_response");
  }
}

async function requestTokens(body: URLSearchParams): Promise<QuickBooksTokens> {
  const { clientId, clientSecret, environment } = getConfig();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readProviderJson(response);
  if (!response.ok) {
    throw new QuickBooksApiError("QuickBooks authorization was rejected", 502, "authorization");
  }
  const record = asObject(payload);
  if (!record) throw new QuickBooksApiError("QuickBooks returned an invalid token response", 502, "invalid_response");

  const expiresIn = optionalPositiveSeconds(record, "expires_in");
  if (!expiresIn) throw new QuickBooksApiError("QuickBooks token expiry is missing", 502, "invalid_response");
  const refreshExpiresIn = optionalPositiveSeconds(record, "x_refresh_token_expires_in");
  const now = Date.now();
  return {
    access_token: requiredString(record, "access_token"),
    refresh_token: requiredString(record, "refresh_token"),
    token_type: typeof record.token_type === "string" && record.token_type && record.token_type.length <= 100 ? record.token_type : "bearer",
    expiry_date: now + expiresIn * 1000,
    refresh_token_expiry_date: refreshExpiresIn ? now + refreshExpiresIn * 1000 : null,
    scope: typeof record.scope === "string" && record.scope && record.scope.length <= 2_000 ? record.scope : QUICKBOOKS_SCOPE,
    environment,
  };
}

export async function exchangeQuickBooksCode(code: string): Promise<QuickBooksTokens> {
  const redirectUri = await getQuickBooksRedirectUri();
  return requestTokens(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  }));
}

function asQuickBooksTokens(value: unknown): QuickBooksTokens | null {
  const record = asObject(value);
  if (!record) return null;
  if (
    typeof record.access_token !== "string" ||
    typeof record.refresh_token !== "string" ||
    typeof record.expiry_date !== "number" ||
    (record.environment !== "sandbox" && record.environment !== "production")
  ) return null;
  return record as unknown as QuickBooksTokens;
}

async function getUsableTokens(accountId: string): Promise<QuickBooksTokens> {
  const current = asQuickBooksTokens(await getAccountTokens(accountId));
  if (!current) throw new QuickBooksApiError("QuickBooks credentials are unavailable", 400, "authorization");
  if (current.expiry_date <= Date.now()) {
    await updateAccount(accountId, {
      healthy: false,
      healthError: "QuickBooks authorization needs attention",
      healthCheckedAt: new Date(),
    });
    throw new QuickBooksApiError("QuickBooks authorization needs attention", 401, "authorization");
  }
  return current;
}

function companyInfoFromPayload(payload: unknown): QuickBooksCompanyInfo {
  const root = asObject(payload);
  const company = root ? asObject(root.CompanyInfo) : null;
  const companyName = company?.CompanyName;
  if (typeof companyName !== "string" || !companyName.trim()) {
    throw new QuickBooksApiError("QuickBooks company identity is missing", 502, "invalid_response");
  }
  return {
    companyName: companyName.trim().slice(0, 200),
    legalName: typeof company.LegalName === "string" && company.LegalName.trim()
      ? company.LegalName.trim().slice(0, 200)
      : null,
    country: typeof company.Country === "string" && company.Country.trim()
      ? company.Country.trim().slice(0, 80)
      : null,
    fiscalYearStartMonth: typeof company.FiscalYearStartMonth === "string" && company.FiscalYearStartMonth.trim()
      ? company.FiscalYearStartMonth.trim().slice(0, 40)
      : null,
  };
}

export async function fetchQuickBooksCompanyInfo(accountId: string): Promise<QuickBooksCompanyInfo> {
  const account = await getAccount(accountId);
  if (!account || account.provider !== QUICKBOOKS_PROVIDER || !account.providerAccountId) {
    throw new QuickBooksApiError("QuickBooks connection was not found", 404, "not_found");
  }
  const tokens = await getUsableTokens(accountId);
  const apiHost = tokens.environment === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
  const realmId = encodeURIComponent(account.providerAccountId);
  const response = await fetch(`${apiHost}/v3/company/${realmId}/companyinfo/${realmId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readProviderJson(response);
  if (!response.ok) {
    throw new QuickBooksApiError("QuickBooks company information is unavailable", 502, "provider");
  }
  return companyInfoFromPayload(payload);
}

export function quickBooksAccountId(ownerUserId: string, realmId: string): string {
  const digest = crypto.createHash("sha256").update(`${ownerUserId}:${realmId}`).digest("hex").slice(0, 32);
  return `quickbooks-${digest}`;
}

export function classifyQuickBooksError(error: unknown): string {
  if (error instanceof QuickBooksApiError) return error.code;
  if (error instanceof Error) return error.name || "error";
  return typeof error;
}

export function logQuickBooksConnection(event: string, realmId: string, details: Record<string, unknown> = {}): void {
  const realmHash = crypto.createHash("sha256").update(realmId).digest("hex").slice(0, 12);
  log.info(event, { realmHash, ...details });
}
