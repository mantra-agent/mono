import type { Express, Response } from "express";
import { createAccount, deleteAccount, getAccount, listVisibleConnectedAccounts, updateAccount } from "../connected-accounts";
import { createGoogleOAuthTransaction, consumeGoogleOAuthTransaction } from "../google-oauth-transactions";
import { createLogger } from "../log";
import {
  buildQuickBooksAuthorizationUrl,
  classifyQuickBooksError,
  exchangeQuickBooksCode,
  fetchQuickBooksCompanyInfo,
  getQuickBooksConfigDiagnostics,
  getQuickBooksRedirectUri,
  isQuickBooksConfigured,
  logQuickBooksConnection,
  QUICKBOOKS_PROVIDER,
  QUICKBOOKS_SCOPE,
  quickBooksAccountId,
  type QuickBooksCompanyInfo,
} from "../quickbooks-service";

const log = createLogger("QuickBooksRoutes");
const REALM_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

interface QuickBooksPermissions {
  quickbooksRead: true;
  quickbooksSync: false;
  scopes: string[];
  companyInfo: QuickBooksCompanyInfo | null;
  lastCompanyInfoSyncAt: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function callbackHtml(
  res: Response,
  input: { ok: boolean; title: string; body: string; status?: number },
): void {
  const heading = input.ok ? "QuickBooks Connected" : "Authorization Failed";
  const html = `<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#e0e0e0"><h2>${heading}</h2><p><strong>${escapeHtml(input.title)}</strong></p><p>${escapeHtml(input.body)}</p><p>You can close this tab.</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`;
  res.status(input.status || (input.ok ? 200 : 500)).send(html);
}

function asCompanyInfo(value: unknown): QuickBooksCompanyInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.companyName !== "string" || !raw.companyName.trim()) return null;
  return {
    companyName: raw.companyName.trim().slice(0, 200),
    legalName: typeof raw.legalName === "string" && raw.legalName.trim() ? raw.legalName.trim().slice(0, 200) : null,
    country: typeof raw.country === "string" && raw.country.trim() ? raw.country.trim().slice(0, 80) : null,
    fiscalYearStartMonth: typeof raw.fiscalYearStartMonth === "string" && raw.fiscalYearStartMonth.trim()
      ? raw.fiscalYearStartMonth.trim().slice(0, 40)
      : null,
  };
}

function asPermissions(value: unknown): QuickBooksPermissions {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<QuickBooksPermissions>
    : {};
  return {
    quickbooksRead: true,
    quickbooksSync: false,
    scopes: Array.isArray(raw.scopes)
      ? raw.scopes.filter((scope): scope is string => typeof scope === "string").slice(0, 10)
      : [QUICKBOOKS_SCOPE],
    companyInfo: asCompanyInfo(raw.companyInfo),
    lastCompanyInfoSyncAt: typeof raw.lastCompanyInfoSyncAt === "string" ? raw.lastCompanyInfoSyncAt.slice(0, 40) : null,
  };
}

function publicAccount(account: Awaited<ReturnType<typeof getAccount>>) {
  if (!account) return null;
  const permissions = asPermissions(account.permissions);
  return {
    accountId: account.accountId,
    companyName: permissions.companyInfo?.companyName || account.label,
    legalName: permissions.companyInfo?.legalName || null,
    country: permissions.companyInfo?.country || null,
    healthy: account.healthy !== false,
    healthError: account.healthError || null,
    healthCheckedAt: account.healthCheckedAt,
    lastCompanyInfoSyncAt: permissions.lastCompanyInfoSyncAt,
    vaultId: account.vaultId,
    addedAt: account.addedAt,
    updatedAt: account.updatedAt,
    readOnly: true,
  };
}

async function persistCompanyInfo(accountId: string, companyInfo: QuickBooksCompanyInfo): Promise<void> {
  const account = await getAccount(accountId);
  if (!account || account.provider !== QUICKBOOKS_PROVIDER) {
    throw new Error("QuickBooks connection was not found");
  }
  const permissions = asPermissions(account.permissions);
  await updateAccount(accountId, {
    label: companyInfo.companyName,
    workspaceName: companyInfo.legalName || companyInfo.companyName,
    permissions: {
      ...permissions,
      companyInfo,
      lastCompanyInfoSyncAt: new Date().toISOString(),
    },
    healthy: true,
    healthError: null,
    healthCheckedAt: new Date(),
    missingScopes: null,
  });
}

function publicError(error: unknown): { status: number; message: string } {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    return { status, message: status === 404 ? "QuickBooks connection was not found" : "QuickBooks request failed" };
  }
  return { status: 500, message: "QuickBooks request failed" };
}

export function registerQuickBooksRoutes(app: Express): void {
  app.get("/api/quickbooks/status", async (_req, res) => {
    try {
      const diagnostics = getQuickBooksConfigDiagnostics();
      const accounts = await listVisibleConnectedAccounts(QUICKBOOKS_PROVIDER);
      res.json({
        configured: diagnostics.configured,
        diagnostics,
        connected: accounts.length > 0,
        healthy: accounts.length > 0 ? accounts.every((account) => account.healthy !== false) : undefined,
        accounts: accounts.map(publicAccount),
        readOnly: true,
      });
    } catch (error: unknown) {
      log.warn("status failed", { errorClass: classifyQuickBooksError(error) });
      res.status(500).json({ error: "QuickBooks status is unavailable" });
    }
  });

  app.post("/api/quickbooks/oauth/start", async (req, res) => {
    try {
      if (!req.principal?.userId || !req.principal.accountId) return res.status(401).json({ error: "Authentication required" });
      if (!isQuickBooksConfigured()) {
        return res.status(400).json({
          error: "QuickBooks is not configured",
          diagnostics: getQuickBooksConfigDiagnostics(),
        });
      }
      const vaultId = typeof req.body?.vaultId === "string" ? req.body.vaultId.trim() : "";
      if (!vaultId) return res.status(400).json({ error: "vaultId is required" });

      const redirectUri = await getQuickBooksRedirectUri();
      const state = await createGoogleOAuthTransaction(req.principal, {
        vaultId,
        provider: "quickbooks",
        redirectOrigin: new URL(redirectUri).origin,
      });
      const url = await buildQuickBooksAuthorizationUrl(state);
      log.info("oauth start", { callbackHost: new URL(redirectUri).host, scopeCount: 1 });
      res.json({ url });
    } catch (error: unknown) {
      const result = publicError(error);
      log.warn("oauth start failed", { errorClass: classifyQuickBooksError(error), status: result.status });
      res.status(result.status).json({ error: result.message });
    }
  });

  app.get("/api/quickbooks/oauth/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    try {
      if (!req.principal?.userId || !req.principal.accountId) {
        return callbackHtml(res, { ok: false, title: "Authentication required", body: "Sign in and restart the connection.", status: 401 });
      }
      if (!state) {
        return callbackHtml(res, { ok: false, title: "Missing authorization state", body: "Restart the connection from Integrations.", status: 400 });
      }

      const transaction = await consumeGoogleOAuthTransaction(state, req.principal, "quickbooks");
      if (typeof req.query.error === "string") {
        log.warn("oauth callback returned provider error");
        return callbackHtml(res, { ok: false, title: "Authorization was not completed", body: "Restart the connection from Integrations.", status: 400 });
      }

      const code = typeof req.query.code === "string" ? req.query.code : "";
      const realmId = typeof req.query.realmId === "string" ? req.query.realmId : "";
      if (!code || !REALM_ID_PATTERN.test(realmId)) {
        log.warn("oauth callback rejected", { missingCode: !code, invalidRealm: !REALM_ID_PATTERN.test(realmId) });
        return callbackHtml(res, { ok: false, title: "QuickBooks returned an invalid callback", body: "Restart the connection from Integrations.", status: 400 });
      }

      const tokens = await exchangeQuickBooksCode(code);
      const accountId = quickBooksAccountId(req.principal.userId, realmId);
      await createAccount({
        accountId,
        provider: QUICKBOOKS_PROVIDER,
        providerAccountId: realmId,
        vaultId: transaction.vaultId,
        label: "QuickBooks Company",
        tokens,
        permissions: {
          quickbooksRead: true,
          quickbooksSync: false,
          scopes: [QUICKBOOKS_SCOPE],
          companyInfo: null,
          lastCompanyInfoSyncAt: null,
        } satisfies QuickBooksPermissions,
      });

      let companyName = "QuickBooks Company";
      let companyInfoSynced = false;
      try {
        const companyInfo = await fetchQuickBooksCompanyInfo(accountId);
        await persistCompanyInfo(accountId, companyInfo);
        companyName = companyInfo.companyName;
        companyInfoSynced = true;
      } catch (error: unknown) {
        await updateAccount(accountId, {
          healthy: false,
          healthError: "Company information sync needs attention",
          healthCheckedAt: new Date(),
        });
        log.warn("company info sync degraded", { accountId, errorClass: classifyQuickBooksError(error) });
      }

      logQuickBooksConnection("oauth connected", realmId, { companyInfoSynced });
      callbackHtml(res, {
        ok: true,
        title: companyName,
        body: companyInfoSynced
          ? "QuickBooks is connected in read-only mode."
          : "QuickBooks is connected. Company information needs a refresh.",
      });
    } catch (error: unknown) {
      const result = publicError(error);
      log.error("oauth callback failed", { errorClass: classifyQuickBooksError(error), status: result.status });
      callbackHtml(res, { ok: false, title: "QuickBooks connection failed", body: "Restart the connection from Integrations.", status: result.status });
    }
  });

  app.post("/api/quickbooks/accounts/:id/company-info", async (req, res) => {
    try {
      const account = await getAccount(req.params.id);
      if (!account || account.provider !== QUICKBOOKS_PROVIDER) {
        return res.status(404).json({ error: "QuickBooks connection was not found" });
      }
      const companyInfo = await fetchQuickBooksCompanyInfo(account.accountId);
      await persistCompanyInfo(account.accountId, companyInfo);
      res.json({ account: publicAccount(await getAccount(account.accountId)) });
    } catch (error: unknown) {
      const result = publicError(error);
      log.warn("company info refresh failed", { errorClass: classifyQuickBooksError(error), status: result.status });
      res.status(result.status).json({ error: result.message });
    }
  });

  app.delete("/api/quickbooks/accounts/:id", async (req, res) => {
    try {
      const account = await getAccount(req.params.id);
      if (!account || account.provider !== QUICKBOOKS_PROVIDER) {
        return res.status(404).json({ error: "QuickBooks connection was not found" });
      }
      const deleted = await deleteAccount(account.accountId);
      res.json({ disconnected: deleted });
    } catch (error: unknown) {
      const result = publicError(error);
      log.warn("disconnect failed", { errorClass: classifyQuickBooksError(error), status: result.status });
      res.status(result.status).json({ error: result.message });
    }
  });
}
