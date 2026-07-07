import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { createAccount, deleteAccount, getAccount, listAccounts, updateAccount } from "../connected-accounts";
import { createLogger } from "../log";
import { getSecret } from "../secrets-store";
import {
  buildOuraAuthorizationUrl,
  createOuraWebhookSubscription,
  exchangeOuraCode,
  getOuraOAuthConfig,
  isOuraConfigured,
  listOuraWebhookSubscriptions,
  OuraApiError,
  syncOuraAccount,
} from "../integrations/oura";
import type {
  OuraPersonalInfo,
  OuraScope,
  OuraTokens,
  OuraWebhookDataType,
  OuraWebhookNotification,
  OuraWebhookOperation,
  OuraWebhookSubscription,
} from "../integrations/oura";
import { OURA_PROVIDER } from "../integrations/oura";

const log = createLogger("OuraRoutes");

const OURA_ACCOUNT_ID = "oura:primary";
const OURA_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OURA_WEBHOOK_EVENTS: OuraWebhookOperation[] = ["create", "update"];
const OURA_WEBHOOK_DATA_TYPES: OuraWebhookDataType[] = [
  "daily_readiness",
  "daily_sleep",
  "sleep",
  "daily_activity",
  "workout",
  "session",
];
const OURA_OAUTH_SCOPES: OuraScope[] = [
  "email",
  "personal",
  "daily",
  "heartrate",
  "workout",
  "session",
  "spo2",
  "tag",
];

interface OuraOAuthState {
  redirectUri: string;
  createdAt: number;
}

interface OuraWebhookSubscriptionMetadata {
  id: string;
  callbackUrl: string;
  eventType: OuraWebhookOperation;
  dataType: OuraWebhookDataType;
  expirationTime: string;
}

interface OuraWebhookMetadata {
  subscriptions?: OuraWebhookSubscriptionMetadata[];
  lastSubscriptionAttemptAt?: string;
  lastSubscriptionSuccessAt?: string;
  lastSubscriptionError?: string | null;
  lastNotificationAt?: string;
  lastNotificationDataType?: string;
  lastNotificationEventType?: string;
  lastNotificationAccepted?: boolean;
  lastNotificationError?: string | null;
}

interface OuraPermissionsMetadata {
  scopes?: string[];
  webhooks?: OuraWebhookMetadata;
  [key: string]: unknown;
}

const oauthStateStore = new Map<string, OuraOAuthState>();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getRequestOrigin(req: Request): string {
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol || "https";
  const host = req.get("host");
  if (!host) {
    throw new OuraApiError("Cannot determine Oura OAuth callback host", 400, "configuration");
  }
  return `${proto}://${host}`;
}

function getRedirectUri(req: Request): string {
  return `${getRequestOrigin(req)}/api/oura/oauth/callback`;
}

function createOAuthState(redirectUri: string): string {
  cleanupExpiredOAuthStates();
  const state = crypto.randomBytes(24).toString("hex");
  oauthStateStore.set(state, { redirectUri, createdAt: Date.now() });
  return state;
}

function consumeOAuthState(state: string): OuraOAuthState | null {
  cleanupExpiredOAuthStates();
  const stored = oauthStateStore.get(state);
  if (!stored) return null;
  oauthStateStore.delete(state);
  return stored;
}

function cleanupExpiredOAuthStates(): void {
  const now = Date.now();
  for (const [state, stored] of oauthStateStore.entries()) {
    if (now - stored.createdAt > OURA_OAUTH_STATE_TTL_MS) {
      oauthStateStore.delete(state);
    }
  }
}

function resolvePermissions(value: unknown): OuraPermissionsMetadata {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function sanitizeWebhookMetadata(value: unknown): OuraWebhookMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const webhook = value as OuraWebhookMetadata;
  return {
    subscriptions: Array.isArray(webhook.subscriptions) ? webhook.subscriptions : undefined,
    lastSubscriptionAttemptAt: webhook.lastSubscriptionAttemptAt,
    lastSubscriptionSuccessAt: webhook.lastSubscriptionSuccessAt,
    lastSubscriptionError: webhook.lastSubscriptionError ?? null,
    lastNotificationAt: webhook.lastNotificationAt,
    lastNotificationDataType: webhook.lastNotificationDataType,
    lastNotificationEventType: webhook.lastNotificationEventType,
    lastNotificationAccepted: webhook.lastNotificationAccepted,
    lastNotificationError: webhook.lastNotificationError ?? null,
  };
}

function sanitizeSyncMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sync = value as Record<string, unknown>;
  return {
    lastSyncAt: sync.lastSyncAt,
    lastSuccessfulSyncAt: sync.lastSuccessfulSyncAt,
    lastSyncMode: sync.lastSyncMode,
    lastSyncStartDate: sync.lastSyncStartDate,
    lastSyncEndDate: sync.lastSyncEndDate,
    lastSyncInserted: sync.lastSyncInserted,
    lastSyncMetricRows: sync.lastSyncMetricRows,
    lastSyncCompletionsLogged: sync.lastSyncCompletionsLogged,
    lastSyncCompletionsUpgraded: sync.lastSyncCompletionsUpgraded,
    lastSyncError: sync.lastSyncError ?? null,
  };
}

function accountSummary(account: Awaited<ReturnType<typeof getAccount>>) {
  if (!account) return null;
  const permissions = resolvePermissions(account.permissions);
  const webhooks = sanitizeWebhookMetadata(permissions.webhooks);
  const sync = sanitizeSyncMetadata(permissions.sync);
  return {
    accountId: account.accountId,
    provider: account.provider,
    email: account.email,
    label: account.label,
    healthy: account.healthy,
    healthError: account.healthError,
    healthCheckedAt: account.healthCheckedAt,
    missingScopes: account.missingScopes,
    addedAt: account.addedAt,
    updatedAt: account.updatedAt,
    scopes: Array.isArray(permissions.scopes) ? permissions.scopes.filter((scope): scope is string => typeof scope === "string") : [],
    sync,
    webhooks,
    warnings: [
      ...(webhooks?.lastSubscriptionError ? ["Oura webhook subscription is not active"] : []),
      ...(sync?.lastSyncError ? ["Last Oura sync failed"] : []),
    ],
  };
}

function toPublicError(error: unknown): { status: number; message: string } {
  if (error instanceof OuraApiError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof Error) {
    return { status: 500, message: error.message || "Oura request failed" };
  }
  return { status: 500, message: "Oura request failed" };
}

function classifyOuraRouteError(error: unknown): string {
  if (error instanceof OuraApiError) return error.code;
  if (error instanceof Error) return error.name || "error";
  return typeof error;
}


function sendCallbackHtml(res: Response, input: { ok: boolean; title: string; body: string; status?: number }): void {
  const safeTitle = escapeHtml(input.title);
  const safeBody = escapeHtml(input.body);
  const heading = input.ok ? "Oura Connected" : "Authorization Failed";
  const html = `<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#e0e0e0"><h2>${heading}</h2><p><strong>${safeTitle}</strong></p><p>${safeBody}</p><p>You can close this tab.</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`;
  res.status(input.status || (input.ok ? 200 : 500)).send(html);
}


function toSubscriptionMetadata(subscription: OuraWebhookSubscription): OuraWebhookSubscriptionMetadata {
  return {
    id: subscription.id,
    callbackUrl: subscription.callback_url,
    eventType: subscription.event_type,
    dataType: subscription.data_type,
    expirationTime: subscription.expiration_time,
  };
}

async function persistWebhookMetadata(accountId: string, metadata: OuraWebhookMetadata): Promise<void> {
  const account = await getAccount(accountId);
  const current = resolvePermissions(account?.permissions);
  const currentWebhooks = current.webhooks && typeof current.webhooks === "object" && !Array.isArray(current.webhooks)
    ? current.webhooks as OuraWebhookMetadata
    : {};
  await updateAccount(accountId, {
    permissions: {
      ...current,
      webhooks: {
        ...currentWebhooks,
        ...metadata,
      },
    },
  });
}

async function attemptOuraWebhookSubscription(accountId: string, callbackUrl: string): Promise<void> {
  const attemptedAt = new Date().toISOString();
  await persistWebhookMetadata(accountId, { lastSubscriptionAttemptAt: attemptedAt, lastSubscriptionError: null });

  const verificationToken = await getSecret("OURA_WEBHOOK_VERIFY_TOKEN");
  if (!verificationToken) {
    await persistWebhookMetadata(accountId, {
      lastSubscriptionAttemptAt: attemptedAt,
      lastSubscriptionError: "OURA_WEBHOOK_VERIFY_TOKEN is not configured",
    });
    log.warn("Oura webhook subscription skipped: verify token is not configured");
    return;
  }

  try {
    const existing = await listOuraWebhookSubscriptions();
    const subscriptions: OuraWebhookSubscription[] = [];
    for (const dataType of OURA_WEBHOOK_DATA_TYPES) {
      for (const eventType of OURA_WEBHOOK_EVENTS) {
        const current = existing.find((candidate) => (
          candidate.callback_url === callbackUrl &&
          candidate.data_type === dataType &&
          candidate.event_type === eventType
        ));
        if (current) {
          subscriptions.push(current);
          continue;
        }
        const created = await createOuraWebhookSubscription({
          callback_url: callbackUrl,
          verification_token: verificationToken,
          event_type: eventType,
          data_type: dataType,
        });
        subscriptions.push(created);
      }
    }

    await persistWebhookMetadata(accountId, {
      subscriptions: subscriptions.map(toSubscriptionMetadata),
      lastSubscriptionAttemptAt: attemptedAt,
      lastSubscriptionSuccessAt: new Date().toISOString(),
      lastSubscriptionError: null,
    });
    log.log(`Oura webhook subscriptions ready count=${subscriptions.length}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await persistWebhookMetadata(accountId, {
      lastSubscriptionAttemptAt: attemptedAt,
      lastSubscriptionError: message,
    });
    log.warn(`webhook subscription failed errorClass=${classifyOuraRouteError(error)} message=${message}`);
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

async function verifyOuraWebhook(req: Request, notification: OuraWebhookNotification): Promise<boolean> {
  const expected = await getSecret("OURA_WEBHOOK_VERIFY_TOKEN");
  if (!expected) return false;
  const received = firstString(
    req.get("x-oura-verification-token"),
    req.get("x-oura-token"),
    req.get("x-webhook-verification-token"),
    req.get("authorization")?.replace(/^Bearer\s+/i, ""),
    (req.body as { verification_token?: unknown } | undefined)?.verification_token,
    (notification as { verification_token?: unknown }).verification_token,
  );
  if (!received) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function triggerOuraWebhookSync(accountId: string): void {
  void syncOuraAccount({ accountId, mode: "incremental" }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`webhook-triggered sync failed accountId=${accountId} errorClass=${classifyOuraRouteError(error)} message=${message}`);
  });
}

async function fetchOuraPersonalInfo(tokens: OuraTokens): Promise<OuraPersonalInfo | null> {
  try {
    const response = await fetch("https://api.ouraring.com/v2/usercollection/personal_info", {
      method: "GET",
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      log.warn(`Oura personal info lookup failed status=${response.status}`);
      return null;
    }
    return await response.json() as OuraPersonalInfo;
  } catch (error: unknown) {
    log.warn("Oura personal info lookup failed", error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function registerOuraRoutes(app: Express): Promise<void> {
  app.get("/api/oura/status", async (_req, res) => {
    try {
      const [oauthConfigured, webhookConfigured, accounts] = await Promise.all([
        isOuraConfigured(),
        getSecret("OURA_WEBHOOK_VERIFY_TOKEN").then(Boolean),
        listAccounts(OURA_PROVIDER),
      ]);
      const account = accounts.find((candidate) => candidate.accountId === OURA_ACCOUNT_ID) || accounts[0] || null;
      const summary = accountSummary(account);
      log.debug(`status checked connected=${!!account} oauthConfigured=${oauthConfigured} webhookConfigured=${webhookConfigured} accounts=${accounts.length}`);
      res.json({
        connected: !!account,
        oauthConfigured,
        webhookConfigured,
        account: summary,
        accounts: accounts.length,
        warnings: summary?.warnings || [],
      });
    } catch (error: unknown) {
      const publicError = toPublicError(error);
      log.warn(`status check failed errorClass=${classifyOuraRouteError(error)} status=${publicError.status}`);
      res.status(publicError.status).json({ connected: false, error: publicError.message });
    }
  });

  app.get("/api/oura/oauth/start", async (req, res) => {
    try {
      const config = await getOuraOAuthConfig();
      const redirectUri = getRedirectUri(req);
      const state = createOAuthState(redirectUri);
      log.log(`oauth start scopes=${OURA_OAUTH_SCOPES.join(",")} redirectHost=${new URL(redirectUri).host}`);
      const url = buildOuraAuthorizationUrl({
        clientId: config.clientId,
        redirectUri,
        state,
        scopes: OURA_OAUTH_SCOPES,
      });
      res.json({ url });
    } catch (error: unknown) {
      const publicError = toPublicError(error);
      log.warn(`oauth start failed errorClass=${classifyOuraRouteError(error)} status=${publicError.status}`);
      res.status(publicError.status).json({ error: publicError.message });
    }
  });

  app.get("/api/oura/oauth/callback", async (req, res) => {
    try {
      const errorParam = typeof req.query.error === "string" ? req.query.error : undefined;
      if (errorParam) {
        log.warn("Oura OAuth callback returned provider error");
        return sendCallbackHtml(res, {
          ok: false,
          title: "Authorization was not completed",
          body: "Please restart Oura connection from the Integrations page.",
          status: 400,
        });
      }

      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const state = typeof req.query.state === "string" ? req.query.state : undefined;
      if (!code || !state) {
        log.warn(`oauth callback rejected missingCode=${!code} missingState=${!state}`);
        return sendCallbackHtml(res, { ok: false, title: "Missing authorization code or state", body: "Please restart Oura connection.", status: 400 });
      }

      const storedState = consumeOAuthState(state);
      if (!storedState) {
        log.warn("Oura OAuth callback rejected invalid or expired state");
        return sendCallbackHtml(res, { ok: false, title: "Invalid or expired state", body: "Please restart Oura connection.", status: 400 });
      }

      log.log("oauth callback accepted state");
      const tokens = await exchangeOuraCode({ code, redirectUri: storedState.redirectUri });
      const personalInfo = await fetchOuraPersonalInfo(tokens);
      const email = personalInfo?.email || null;
      const label = email || "Oura Ring";
      await createAccount({
        accountId: OURA_ACCOUNT_ID,
        provider: OURA_PROVIDER,
        email: email || undefined,
        label,
        tokens,
        permissions: { scopes: OURA_OAUTH_SCOPES },
      });
      await updateAccount(OURA_ACCOUNT_ID, { healthy: true, healthError: null, healthCheckedAt: new Date(), missingScopes: null });
      await attemptOuraWebhookSubscription(OURA_ACCOUNT_ID, `${getRequestOrigin(req)}/api/oura/webhook`);
      log.log(`oauth connected accountId=${OURA_ACCOUNT_ID} hasEmail=${!!email} scopes=${OURA_OAUTH_SCOPES.join(",")}`);
      sendCallbackHtml(res, { ok: true, title: label, body: "Oura Ring is connected." });
    } catch (error: unknown) {
      const publicError = toPublicError(error);
      log.error(`oauth callback failed errorClass=${classifyOuraRouteError(error)} status=${publicError.status} message=${publicError.message}`);
      sendCallbackHtml(res, { ok: false, title: "Oura connection failed", body: publicError.message, status: publicError.status });
    }
  });

  app.post("/api/oura/sync", async (req, res) => {
    try {
      const mode = req.body && typeof req.body === "object" && (req.body as { mode?: unknown }).mode === "initial"
        ? "initial"
        : "incremental";
      log.log(`manual sync requested accountId=${OURA_ACCOUNT_ID} mode=${mode}`);
      const result = await syncOuraAccount({ accountId: OURA_ACCOUNT_ID, mode });
      log.log(`manual sync complete accountId=${OURA_ACCOUNT_ID} mode=${mode} range=${result.startDate}..${result.endDate} metricRows=${result.metricRows} inserted=${result.inserted}`);
      const account = await getAccount(OURA_ACCOUNT_ID);
      res.json({ ok: true, result, account: accountSummary(account) });
    } catch (error: unknown) {
      const publicError = toPublicError(error);
      log.warn(`manual sync failed accountId=${OURA_ACCOUNT_ID} errorClass=${classifyOuraRouteError(error)} status=${publicError.status}`);
      res.status(publicError.status).json({ ok: false, error: publicError.message });
    }
  });

  app.post("/api/oura/webhook", async (req, res) => {
    const notification = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as OuraWebhookNotification
      : {};
    const eventType = typeof notification.event_type === "string" ? notification.event_type : "unknown";
    const dataType = typeof notification.data_type === "string" ? notification.data_type : "unknown";

    try {
      const accepted = await verifyOuraWebhook(req, notification);
      await persistWebhookMetadata(OURA_ACCOUNT_ID, {
        lastNotificationAt: new Date().toISOString(),
        lastNotificationDataType: dataType,
        lastNotificationEventType: eventType,
        lastNotificationAccepted: accepted,
        lastNotificationError: accepted ? null : "verification_failed",
      });

      if (!accepted) {
        log.warn(`webhook rejected dataType=${dataType} eventType=${eventType} errorClass=verification_failed`);
        return res.status(401).json({ ok: false });
      }

      log.log(`webhook accepted dataType=${dataType} eventType=${eventType}`);
      triggerOuraWebhookSync(OURA_ACCOUNT_ID);
      res.json({ ok: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`webhook handling failed dataType=${dataType} eventType=${eventType} errorClass=${classifyOuraRouteError(error)} message=${message}`);
      res.status(500).json({ ok: false });
    }
  });

  app.post("/api/oura/disconnect", async (_req, res) => {
    try {
      const deleted = await deleteAccount(OURA_ACCOUNT_ID);
      log.log(`disconnect complete accountId=${OURA_ACCOUNT_ID} deleted=${deleted}`);
      res.json({ disconnected: true });
    } catch (error: unknown) {
      const publicError = toPublicError(error);
      log.warn(`disconnect failed accountId=${OURA_ACCOUNT_ID} errorClass=${classifyOuraRouteError(error)} status=${publicError.status}`);
      res.status(publicError.status).json({ error: publicError.message });
    }
  });
}
