import type { Principal } from "./principal";
import { createGoogleOAuthTransaction, consumeGoogleOAuthTransaction } from "./google-oauth-transactions";
import { createConnectedAccountInVault, getAccount, getAccountTokens, setAccountTokens, updateAccount } from "./connected-accounts";
import { getSecretSync } from "./secrets-store";

interface BoxTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
  expiry_date?: number;
}

const authorizeUrl = "https://account.box.com/api/oauth2/authorize";
const tokenUrl = "https://api.box.com/oauth2/token";

function credentials() {
  const clientId = getSecretSync("BOX_CLIENT_ID");
  const clientSecret = getSecretSync("BOX_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error("BOX_CLIENT_ID and BOX_CLIENT_SECRET are required"), { status: 503 });
  }
  return { clientId, clientSecret };
}

function redirectUri(originHost?: string) {
  const configured = getSecretSync("BOX_REDIRECT_URI");
  if (configured) return configured;
  if (!originHost) {
    throw Object.assign(new Error("Box redirect origin unavailable"), { status: 503 });
  }
  const protocol = originHost.includes("localhost") ? "http" : "https";
  return `${protocol}://${originHost}/api/box/oauth/callback`;
}

async function exchange(params: URLSearchParams): Promise<BoxTokens> {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Box token exchange failed (${response.status})`), {
      status: response.status === 400 ? 400 : 502,
    });
  }
  const tokens = await response.json() as BoxTokens;
  return {
    ...tokens,
    expiry_date: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
  };
}

export function boxOAuthConfigured() {
  return Boolean(getSecretSync("BOX_CLIENT_ID") && getSecretSync("BOX_CLIENT_SECRET"));
}

export async function getBoxAuthUrl(vaultId: string, principal: Principal, originHost?: string) {
  const { clientId } = credentials();
  const state = await createGoogleOAuthTransaction(principal, {
    vaultId,
    redirectOrigin: originHost,
    provider: "box",
  });
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri(originHost),
    state,
  });
  return `${authorizeUrl}?${params.toString()}`;
}

export async function handleBoxOAuthCallback(
  code: string,
  state: string,
  principal: Principal,
  originHost?: string,
) {
  const transaction = await consumeGoogleOAuthTransaction(state, principal, "box");
  const { clientId, clientSecret } = credentials();
  const tokens = await exchange(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(originHost || transaction.redirectOrigin || undefined),
  }));
  const userResponse = await fetch(
    "https://api.box.com/2.0/users/me?fields=id,name,login,enterprise",
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  );
  if (!userResponse.ok) {
    throw Object.assign(new Error("Box account identity unavailable"), { status: 502 });
  }
  const user = await userResponse.json() as {
    id: string;
    name?: string;
    login?: string;
    enterprise?: { name?: string };
  };
  const accountId = `box-${principal.accountId}-${user.id}`;
  await createConnectedAccountInVault({
    accountId,
    provider: "box",
    providerAccountId: user.id,
    email: user.login || null,
    label: user.name || user.login || "Box",
    workspaceName: user.enterprise?.name || null,
    tokens,
    permissions: {},
  }, transaction.vaultId);
  return {
    accountId,
    email: user.login || null,
    label: user.name || user.login || "Box",
  };
}

export async function getBoxAccessTokenForAccount(accountId: string): Promise<string> {
  const account = await getAccount(accountId);
  if (!account || account.provider !== "box") {
    throw Object.assign(new Error("Box account disconnected or missing"), { status: 403 });
  }
  const current = await getAccountTokens(accountId) as BoxTokens | null;
  if (!current?.refresh_token) {
    throw Object.assign(new Error("Box refresh token unavailable"), { status: 403 });
  }
  if (current.access_token && (!current.expiry_date || current.expiry_date > Date.now() + 60_000)) {
    return current.access_token;
  }
  const { clientId, clientSecret } = credentials();
  const refreshed = await exchange(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  }));
  await setAccountTokens(accountId, refreshed);
  await updateAccount(accountId, {
    healthy: true,
    healthError: null,
    healthCheckedAt: new Date(),
  });
  return refreshed.access_token;
}

export async function revokeBoxAccount(accountId: string) {
  const tokens = await getAccountTokens(accountId) as BoxTokens | null;
  const { clientId, clientSecret } = credentials();
  if (tokens?.access_token) {
    await fetch("https://api.box.com/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token: tokens.access_token,
      }),
    });
  }
}
