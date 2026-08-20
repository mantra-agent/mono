import crypto from "crypto";
import type { Principal } from "../../principal";
import {
  createGoogleOAuthTransaction,
  consumeGoogleOAuthTransaction,
} from "../../google-oauth-transactions";
import {
  createConnectedAccountInVault,
  getAccount,
  getAccountTokens,
  setAccountTokens,
  updateAccount,
} from "../../connected-accounts";
import { getSecretSync } from "../../secrets-store";
import { providerFetch, readBoundedProviderBody } from "../provider-http";
import { createLogger } from "../../log";

const log = createLogger("MondayOAuth");

const AUTHORIZE_URL = "https://auth.monday.com/oauth2/authorize";
const TOKEN_URL = "https://auth.monday.com/oauth_ms/oauth/token";
const REVOKE_URL = "https://auth.monday.com/oauth_ms/oauth/revoke";
const GRAPHQL_URL = "https://api.monday.com/v2";
const API_VERSION = "2026-07";

/** Day-one read scopes only — never boards:write or webhooks:write. */
export const MONDAY_READ_SCOPES = [
  "me:read",
  "account:read",
  "boards:read",
  "workspaces:read",
  "users:read",
] as const;

export interface MondayTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  /** Epoch ms when access_token expires; required for OAuth 2.1 expiring tokens. */
  expiry_date?: number;
  /** PKCE verifier retained only while the authorization code is outstanding. */
  code_verifier?: string;
}

function credentials() {
  const clientId = getSecretSync("MONDAY_CLIENT_ID");
  const clientSecret = getSecretSync("MONDAY_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error("MONDAY_CLIENT_ID and MONDAY_CLIENT_SECRET are required"), {
      status: 503,
    });
  }
  return { clientId, clientSecret };
}

function redirectUri(originHost?: string) {
  const configured = getSecretSync("MONDAY_REDIRECT_URI");
  if (configured) return configured;
  if (!originHost) {
    throw Object.assign(new Error("Monday redirect origin unavailable"), { status: 503 });
  }
  const protocol = originHost.includes("localhost") ? "http" : "https";
  return `${protocol}://${originHost}/api/monday/oauth/callback`;
}

function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function decodeJwtExpMs(accessToken: string): number | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: number;
    };
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp * 1000;
    }
  } catch {
    // Non-JWT tokens are acceptable; caller must still fail closed without refresh.
  }
  return undefined;
}

async function exchangeToken(body: Record<string, string>): Promise<MondayTokens> {
  const response = await providerFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 15_000,
  });
  if (!response.ok) {
    const detail = await readBoundedProviderBody(response);
    log.warn("Monday token exchange failed", {
      status: response.status,
      detailLength: detail.length,
    });
    throw Object.assign(new Error(`Monday token exchange failed (${response.status})`), {
      status: response.status === 400 ? 400 : 502,
    });
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    scope?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw Object.assign(new Error("Monday token response missing access_token"), { status: 502 });
  }
  const jwtExp = decodeJwtExpMs(json.access_token);
  const expiresInMs =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? Date.now() + json.expires_in * 1000
      : undefined;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type,
    scope: json.scope,
    expiry_date: jwtExp ?? expiresInMs,
  };
}

export function mondayOAuthConfigured() {
  return Boolean(getSecretSync("MONDAY_CLIENT_ID") && getSecretSync("MONDAY_CLIENT_SECRET"));
}

export async function getMondayAuthUrl(
  vaultId: string,
  principal: Principal,
  originHost?: string,
) {
  const { clientId } = credentials();
  const { verifier, challenge } = createPkcePair();
  const state = await createGoogleOAuthTransaction(principal, {
    vaultId,
    redirectOrigin: originHost,
    provider: "monday",
    codeVerifier: verifier,
  });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(originHost),
    state,
    scope: MONDAY_READ_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function fetchMondayIdentity(accessToken: string): Promise<{
  userId: string;
  name: string | null;
  email: string | null;
  accountName: string | null;
  accountSlug: string | null;
}> {
  const response = await providerFetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: accessToken,
      "content-type": "application/json",
      "API-Version": API_VERSION,
    },
    body: JSON.stringify({
      query: `query {
        me { id name email }
        account { name slug }
      }`,
    }),
    timeoutMs: 15_000,
  });
  if (!response.ok) {
    throw Object.assign(new Error("Monday account identity unavailable"), { status: 502 });
  }
  const body = (await response.json()) as {
    data?: {
      me?: { id?: string | number; name?: string; email?: string };
      account?: { name?: string; slug?: string };
    };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length || !body.data?.me?.id) {
    throw Object.assign(new Error("Monday account identity unavailable"), { status: 502 });
  }
  const me = body.data.me;
  return {
    userId: String(me.id),
    name: me.name || null,
    email: me.email || null,
    accountName: body.data.account?.name || null,
    accountSlug: body.data.account?.slug || null,
  };
}

export async function handleMondayOAuthCallback(
  code: string,
  state: string,
  principal: Principal,
  originHost?: string,
) {
  const transaction = await consumeGoogleOAuthTransaction(state, principal, "monday");
  const codeVerifier = transaction.codeVerifier;
  if (!codeVerifier) {
    throw Object.assign(new Error("Monday OAuth PKCE verifier missing"), { status: 400 });
  }
  const { clientId, clientSecret } = credentials();
  const redirect = redirectUri(originHost || transaction.redirectOrigin || undefined);
  const tokens = await exchangeToken({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirect,
    code_verifier: codeVerifier,
  });
  if (!tokens.refresh_token) {
    throw Object.assign(
      new Error("Monday app must use OAuth 2.1 with refresh tokens; enable New OAuth Flow"),
      { status: 503 },
    );
  }
  const identity = await fetchMondayIdentity(tokens.access_token);
  const accountId = `monday-${principal.accountId}-${identity.userId}`;
  await createConnectedAccountInVault(
    {
      accountId,
      provider: "monday",
      providerAccountId: identity.userId,
      email: identity.email,
      label: identity.name || identity.email || "Monday",
      workspaceName: identity.accountName || identity.accountSlug || null,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        scope: tokens.scope,
        expiry_date: tokens.expiry_date,
      },
      permissions: { scopes: MONDAY_READ_SCOPES },
    },
    transaction.vaultId,
  );
  await updateAccount(accountId, {
    healthy: true,
    healthError: null,
    healthCheckedAt: new Date(),
  });
  return {
    accountId,
    email: identity.email,
    label: identity.name || identity.email || "Monday",
    workspaceName: identity.accountName || identity.accountSlug || null,
  };
}

export async function getMondayAccessTokenForAccount(accountId: string): Promise<string> {
  const account = await getAccount(accountId);
  if (!account || account.provider !== "monday") {
    throw Object.assign(new Error("Monday account disconnected or missing"), { status: 403 });
  }
  const current = (await getAccountTokens(accountId)) as MondayTokens | null;
  if (!current?.access_token) {
    throw Object.assign(new Error("Monday access token unavailable"), { status: 403 });
  }
  const stillFresh =
    current.expiry_date && current.expiry_date > Date.now() + 60_000;
  if (stillFresh) return current.access_token;

  if (!current.refresh_token) {
    await updateAccount(accountId, {
      healthy: false,
      healthError: "Monday refresh token missing; reconnect required",
      healthCheckedAt: new Date(),
    });
    throw Object.assign(new Error("Monday refresh token unavailable; reconnect required"), {
      status: 403,
    });
  }

  const { clientId, clientSecret } = credentials();
  try {
    const refreshed = await exchangeToken({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: current.refresh_token,
    });
    if (!refreshed.refresh_token && !current.refresh_token) {
      throw new Error("Monday refresh did not return a refresh token");
    }
    await setAccountTokens(accountId, {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || current.refresh_token,
      token_type: refreshed.token_type,
      scope: refreshed.scope || current.scope,
      expiry_date: refreshed.expiry_date,
    });
    await updateAccount(accountId, {
      healthy: true,
      healthError: null,
      healthCheckedAt: new Date(),
    });
    return refreshed.access_token;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Monday token refresh failed";
    await updateAccount(accountId, {
      healthy: false,
      healthError: message.slice(0, 240),
      healthCheckedAt: new Date(),
    });
    throw Object.assign(new Error("Monday token refresh failed; reconnect required"), {
      status: 403,
    });
  }
}

export async function revokeMondayAccount(accountId: string) {
  const tokens = (await getAccountTokens(accountId)) as MondayTokens | null;
  if (!tokens?.access_token && !tokens?.refresh_token) return;
  try {
    const { clientId, clientSecret } = credentials();
    const token = tokens.refresh_token || tokens.access_token;
    await providerFetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        token,
      }),
      timeoutMs: 10_000,
    });
  } catch (error) {
    log.warn("Monday token revoke best-effort failed", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}
