// Use createLogger for logging ONLY
import type { Express } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { peopleStorage } from "../people-storage";
import { resolve } from "path";
import crypto from "crypto";
// insertEmailDraftSchema import removed — email draft CRUD moved to email-drafts.ts
import { createLogger } from "../log";
import { getSecretSync } from "../secrets-store";
import { requireAuth, requireAdmin } from "../auth";
import { requirePermission } from "../permissions";
import { runWithPrincipal } from "../principal-context";
import { createNamedSystemPrincipal } from "../principal";
import { getSetting, setSetting } from "../system-settings";

const log = createLogger("IntegrationsRoutes");

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


interface MetaWearablesConfig {
  enabled: boolean;
  developerMode: boolean;
  bundleId: string;
  universalLink: string;
  applicationId: string;
  mwdatPlistEntry: string;
  releaseChannel: string;
  notes: string;
}

const META_WEARABLES_CONFIG_KEY = "integration.meta.wearables";

const DEFAULT_META_WEARABLES_CONFIG: MetaWearablesConfig = {
  enabled: false,
  developerMode: true,
  bundleId: "com.oniops.firstglasses",
  universalLink: "https://raymondkallmeyer.com",
  applicationId: "",
  mwdatPlistEntry: "",
  releaseChannel: "Magic Demo",
  notes: "",
};

function normalizeMetaWearablesConfig(input: unknown): MetaWearablesConfig {
  const existing = input && typeof input === "object" ? input as Partial<MetaWearablesConfig> : {};
  return {
    ...DEFAULT_META_WEARABLES_CONFIG,
    ...existing,
    enabled: Boolean(existing.enabled),
    developerMode: existing.developerMode !== false,
    bundleId: typeof existing.bundleId === "string" && existing.bundleId.trim() ? existing.bundleId.trim() : DEFAULT_META_WEARABLES_CONFIG.bundleId,
    universalLink: typeof existing.universalLink === "string" && existing.universalLink.trim() ? existing.universalLink.trim() : DEFAULT_META_WEARABLES_CONFIG.universalLink,
    applicationId: typeof existing.applicationId === "string" ? existing.applicationId.trim() : "",
    mwdatPlistEntry: typeof existing.mwdatPlistEntry === "string" ? existing.mwdatPlistEntry : "",
    releaseChannel: typeof existing.releaseChannel === "string" ? existing.releaseChannel.trim() : "",
    notes: typeof existing.notes === "string" ? existing.notes : "",
  };
}

function redactMetaWearablesConfig(config: MetaWearablesConfig): MetaWearablesConfig & { applicationIdConfigured: boolean; applicationIdLast4: string | null; mwdatConfigured: boolean } {
  return {
    ...config,
    applicationId: "",
    mwdatPlistEntry: "",
    applicationIdConfigured: !!config.applicationId,
    applicationIdLast4: config.applicationId ? config.applicationId.slice(-4) : null,
    mwdatConfigured: !!config.mwdatPlistEntry.trim(),
  };
}


function getGitHubWebhookSecret(): string | null {
  const fromStore = getSecretSync("GITHUB_WEBHOOK_SECRET");
  const fromEnv = process.env.GITHUB_WEBHOOK_SECRET;
  const secret = (fromStore || fromEnv || "").trim();
  return secret || null;
}

function verifyGitHubWebhookSignature(rawBody: unknown, signatureHeader: string | undefined, secret: string): boolean {
  if (!Buffer.isBuffer(rawBody) || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actual = Buffer.from(signatureHeader, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

export async function registerIntegrationsRoutes(app: Express) {
  app.get("/api/gmail/status", async (_req, res) => {
    try {
      // Runs under the request principal: users only see their own Gmail integration state.
      const result = await (async () => {
        const { isGmailConnected, isConnectorConnected, listGmailAccounts, getAccountScopes } = await import("../gmail");
        const connected = await isGmailConnected();
        const connectorAccess = await isConnectorConnected();
        const accounts = await listGmailAccounts();
        let readAccess = false;
        let email: string | null = null;
        for (const a of accounts) {
          const scopes = await getAccountScopes(a.id);
          if (scopes.hasGmailRead) {
            readAccess = true;
            if (!email) email = a.email;
          }
        }
        const oauthConfigured = !!(getSecretSync("GOOGLE_CLIENT_ID") && getSecretSync("GOOGLE_CLIENT_SECRET"));
        return { connected, readAccess, connectorAccess, email, oauthConfigured, accounts: accounts.length };
      })();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gmail/oauth/start", requireAuth, async (req, res) => {
    try {
      const { getAuthUrlForAccount } = await import("../gmail");
      const originHost = req.get("host") || undefined;
      const vaultId = String(req.query.vaultId || '');
      if (!vaultId || !req.principal) return res.status(400).json({ error: 'vaultId is required' });
      const url = await getAuthUrlForAccount('Personal', vaultId, req.principal, originHost);
      res.json({ url });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gmail/oauth/callback", requireAuth, async (req, res) => {
    try {
      const code = req.query.code as string;
      const stateRaw = req.query.state as string | undefined;
      if (!code) {
        return res.status(400).send("Missing authorization code");
      }

      if (!stateRaw || !req.principal) return res.status(400).send('Missing OAuth transaction');
      const { handleAccountOAuthCallback } = await import("../gmail");
      const originHost = req.get("host") || undefined;
      const account = await handleAccountOAuthCallback(code, stateRaw, req.principal, originHost);
      res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#e0e0e0"><h2>Account Connected</h2><p><strong>${account.email}</strong> (${account.label})</p><p>You can close this tab.</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
    } catch (error: any) {
      res.status(500).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#e0e0e0"><h2>Authorization Failed</h2><p>${error.message}</p></body></html>`);
    }
  });

  app.get("/api/gmail/labels", async (_req, res) => {
    try {
      const { listLabels } = await import("../gmail");
      const labels = await listLabels();
      res.json({ labels });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gmail/messages", async (req, res) => {
    try {
      const { listMessages, getMessage } = await import("../gmail");
      const q = (req.query.q as string) || undefined;
      const maxResults = parseInt(req.query.maxResults as string) || 20;
      const accountId = (req.query.accountId as string) || undefined;
      const stubs = await listMessages(q, maxResults, accountId);
      const messages = await Promise.all(
        stubs.map((s: any) => getMessage(s.id, 'metadata', accountId))
      );
      res.json({ messages });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });


  app.get("/api/gmail/messages/:id", async (req, res) => {
    try {
      const { getMessage } = await import("../gmail");
      const format = (req.query.format as 'full' | 'metadata' | 'minimal') || 'full';
      const message = await getMessage(req.params.id, format);
      res.json(message);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gmail/profile", async (_req, res) => {
    try {
      const { getProfile } = await import("../gmail");
      const profile = await getProfile();
      res.json(profile);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Email sending removed from routes — the only send path is POST /api/email-drafts/:id/send (human-only).

  app.get("/api/gmail/accounts", async (_req, res) => {
    try {
      // Runs under the request principal: connected accounts are user-owned sensitive data.
      const result = await (async () => {
        const { listGmailAccounts, getAccountScopes, verifyAccountTokenHealth } = await import("../gmail");
        const accounts = await listGmailAccounts();
        const enriched = await Promise.all(accounts.map(async (a) => {
          const [scopes, health] = await Promise.all([
            getAccountScopes(a.id),
            verifyAccountTokenHealth(a.id),
          ]);
          return {
            ...a,
            scopes,
            healthy: health.healthy,
            healthError: health.error,
            missingScopes: scopes.missingScopes,
          };
        }));
        return { accounts: enriched };
      })();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/gmail/accounts/add", requireAuth, async (req, res) => {
    try {
      const { getAuthUrlForAccount } = await import("../gmail");
      const label = req.body.label || 'Personal';
      const vaultId = String(req.body.vaultId || '');
      if (!vaultId || !req.principal) return res.status(400).json({ error: 'vaultId is required' });
      const originHost = req.get("host") || undefined;
      const url = await getAuthUrlForAccount(label, vaultId, req.principal, originHost);
      res.json({ url });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/gmail/accounts/:id", async (req, res) => {
    try {
      const { removeGmailAccount } = await import("../gmail");
      await removeGmailAccount(req.params.id);
      res.json({ removed: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/gmail/accounts/:id", async (req, res) => {
    try {
      const { updateAccountLabel } = await import("../gmail");
      const { label } = req.body;
      if (!label) return res.status(400).json({ error: "label required" });
      const account = await updateAccountLabel(req.params.id, label);
      if (!account) return res.status(404).json({ error: "Account not found" });
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gmail/contacts/scan", async (req, res) => {
    try {
      const { extractContactCandidatesBatch } = await import("../gmail");
      const batchSize = parseInt(req.query.batchSize as string) || 200;
      const minThreads = parseInt(req.query.minThreads as string) || 3;
      const afterDate = req.query.afterDate as string | undefined;
      const beforeDate = req.query.beforeDate as string | undefined;
      const accountId = req.query.accountId as string | undefined;
      const gmailPageToken = req.query.gmailPageToken as string | undefined;
      const excludeEmailsRaw = req.query.excludeEmails as string | undefined;
      const excludeEmails = excludeEmailsRaw ? excludeEmailsRaw.split(',').map(e => e.trim()).filter(Boolean) : [];
      const userId = (req as any).session?.userId || 'default';
      const result = await extractContactCandidatesBatch({
        batchSize,
        minThreadCount: minThreads,
        afterDate,
        beforeDate,
        userId,
        accountId,
        gmailPageToken,
        excludeEmails,
      });
      res.json({
        candidates: result.candidates,
        total: result.candidates.length,
        nextPageToken: result.nextPageToken,
        threadsProcessed: result.threadsProcessed,
        estimatedTotal: result.estimatedTotal,
        hasMore: result.hasMore,
        oldestDate: result.oldestDate,
        newestDate: result.newestDate,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gmail/contacts/scan/progress", async (req, res) => {
    try {
      const { getScanProgress } = await import("../gmail");
      const userId = (req as any).session?.userId || 'default';
      res.json(getScanProgress(userId));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gmail/contacts/skip-list", async (_req, res) => {
    try {
      const list = await storage.getGmailSkipList();
      res.json({ skipList: list });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/gmail/contacts/skip-list", async (req, res) => {
    try {
      const { entries } = req.body;
      if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: "entries array required" });
      }
      await storage.addToGmailSkipList(entries);
      const list = await storage.getGmailSkipList();
      res.json({ skipList: list });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/gmail/contacts/skip-list", async (req, res) => {
    try {
      const { emails } = req.body;
      if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: "emails array required" });
      }
      await storage.removeFromGmailSkipList(emails);
      const list = await storage.getGmailSkipList();
      res.json({ skipList: list });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // === Connected Accounts & Permissions ===

  app.get("/api/connected-accounts", requireAuth, async (req, res) => {
    try {
      // Runs under the request principal: each user sees only their own connected accounts.
      const result = await (async () => {
        const { listAccounts, resolvePermissions } = await import("../connected-accounts");
        const provider = req.query.provider as string | undefined;
        const accounts = await listAccounts(provider || undefined);
        return accounts.map(a => {
          const { tokens, ...safe } = a;
          return {
            ...safe,
            permissions: resolvePermissions(a.permissions),
          };
        });
      })();
      res.json({ accounts: result });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/connected-accounts/:id/permissions", requireAuth, async (req, res) => {
    try {
      const { getAccountPermissions, getAccount } = await import("../connected-accounts");
      const account = await getAccount(req.params.id);
      if (!account) return res.status(404).json({ error: "Account not found" });
      const permissions = await getAccountPermissions(req.params.id);
      res.json({ accountId: req.params.id, permissions });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/connected-accounts/:id/permissions", requireAuth, async (req, res) => {
    try {
      const { setAccountPermissions, getAccount, DEFAULT_GOOGLE_PERMISSIONS } = await import("../connected-accounts");
      const account = await getAccount(req.params.id);
      if (!account) return res.status(404).json({ error: "Account not found" });
      const validKeys = Object.keys(DEFAULT_GOOGLE_PERMISSIONS);
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "Body must be a JSON object with permission keys" });
      }
      const sanitized: Record<string, boolean> = {};
      for (const [key, val] of Object.entries(body)) {
        if (!validKeys.includes(key)) continue;
        if (typeof val !== "boolean") {
          return res.status(400).json({ error: `Permission "${key}" must be a boolean` });
        }
        sanitized[key] = val;
      }
      if (Object.keys(sanitized).length === 0) {
        return res.status(400).json({ error: `No valid permission keys. Valid: ${validKeys.join(", ")}` });
      }
      const permissions = await setAccountPermissions(req.params.id, sanitized);
      res.json({ accountId: req.params.id, permissions });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // === Notion Account Routes ===

  app.get("/api/notion/accounts", async (_req, res) => {
    try {
      const { listNotionAccounts, verifyAccount } = await import("../notion");
      const accounts = await listNotionAccounts();
      const enriched = await Promise.all(accounts.map(async (a) => {
        const status = await verifyAccount(a.id);
        return { ...a, valid: status.valid };
      }));
      res.json({ accounts: enriched });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/notion/accounts/add", async (req, res) => {
    try {
      const { addNotionAccount } = await import("../notion");
      const { token, label } = req.body;
      if (!token) return res.status(400).json({ error: "token required" });
      const account = await addNotionAccount(token, label || 'Personal');
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/notion/accounts/:id", async (req, res) => {
    try {
      const { removeNotionAccount } = await import("../notion");
      await removeNotionAccount(req.params.id);
      res.json({ removed: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/notion/accounts/:id", async (req, res) => {
    try {
      const { updateAccountLabel } = await import("../notion");
      const { label } = req.body;
      if (!label) return res.status(400).json({ error: "label required" });
      const account = await updateAccountLabel(req.params.id, label);
      if (!account) return res.status(404).json({ error: "Account not found" });
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/notion/search", async (req, res) => {
    try {
      const { searchPages, searchDatabases } = await import("../notion");
      const accountId = req.query.accountId as string;
      const query = req.query.q as string | undefined;
      const type = req.query.type as string || 'all';
      if (!accountId) return res.status(400).json({ error: "accountId required" });
      const [pages, databases] = await Promise.all([
        type === 'database' ? Promise.resolve([]) : searchPages(accountId, query),
        type === 'page' ? Promise.resolve([]) : searchDatabases(accountId, query),
      ]);
      res.json({ pages, databases });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/notion/pages/:pageId", async (req, res) => {
    try {
      const { getPage, getPageContent } = await import("../notion");
      const accountId = req.query.accountId as string;
      if (!accountId) return res.status(400).json({ error: "accountId required" });
      const [page, blocks] = await Promise.all([
        getPage(accountId, req.params.pageId),
        getPageContent(accountId, req.params.pageId),
      ]);
      res.json({ page, blocks });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/notion/databases/:dbId", async (req, res) => {
    try {
      const { getDatabase, queryDatabase } = await import("../notion");
      const accountId = req.query.accountId as string;
      if (!accountId) return res.status(400).json({ error: "accountId required" });
      const pageSize = parseInt(req.query.pageSize as string) || 50;
      const startCursor = req.query.startCursor as string | undefined;
      const [db, data] = await Promise.all([
        getDatabase(accountId, req.params.dbId),
        queryDatabase(accountId, req.params.dbId, { pageSize, startCursor }),
      ]);
      res.json({ database: db, ...data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // === Import Queue Routes ===

  app.get("/api/import-queue/status", requireAdmin, async (_req, res) => {
    try {
      const { getQueueSummaryFromDb } = await import("../import-queue");
      res.json(await getQueueSummaryFromDb());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/import-queue/candidates", requireAdmin, async (_req, res) => {
    try {
      const { getPendingCandidatesFromDb } = await import("../import-queue");
      const pending = await getPendingCandidatesFromDb();
      res.json({ candidates: pending });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });


  app.post("/api/import-queue/ios-contacts", requireAdmin, async (req, res) => {
    try {
      const { stageIosContacts } = await import("../import-queue");
      const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
      if (contacts.length === 0) {
        return res.status(400).json({ error: "contacts array required" });
      }
      if (contacts.length > 5000) {
        return res.status(400).json({ error: "contacts limit is 5000" });
      }
      const result = await stageIosContacts(contacts);
      res.json({ ok: true, ...result });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/import-queue/scan", requireAdmin, async (req, res) => {
    try {
      const { runAutoScan } = await import("../import-queue");
      const mode = req.body.mode as "start" | "continue" | "refresh";
      if (!["start", "continue", "refresh"].includes(mode)) {
        return res.status(400).json({ error: "mode must be start, continue, or refresh" });
      }
      const accountId = req.body.accountId as string | undefined;

      const buildEmailMap = async () => {
        const people = await peopleStorage.listPeople();
        const emailMap: Record<string, { id: string; name: string }> = {};
        for (const entry of people) {
          const person = await peopleStorage.getPerson(entry.id);
          if (person) {
            for (const ci of person.contactInfo || []) {
              if (ci.type === "email" && ci.value) {
                emailMap[ci.value.toLowerCase()] = { id: person.id, name: person.name };
              }
            }
          }
        }
        return emailMap;
      };

      await runAutoScan({
        mode,
        accountId,
        peopleStorage,
        getSkipList: () => storage.getGmailSkipList(),
        getEmailMap: buildEmailMap,
      });

      res.json({ ok: true, message: `Scan ${mode} initiated` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/import-queue/decide", requireAdmin, async (req, res) => {
    try {
      const { addImportCandidate, mergeImportCandidate, skipImportCandidate } = await import("../people-import-decision-service");
      const { email, candidateId, decision, idempotencyKey, ...fields } = req.body;
      const resolvedCandidateId = String(candidateId || email || "").trim().toLowerCase();
      if (!resolvedCandidateId || !decision) return res.status(400).json({ error: "candidateId/email and decision required" });
      if (!["add", "merge", "skip"].includes(decision)) return res.status(400).json({ error: "decision must be add, merge, or skip" });
      const input = {
        ...fields,
        candidateId: resolvedCandidateId,
        idempotencyKey: String(idempotencyKey || `legacy-ui:${decision}:${resolvedCandidateId}`).trim(),
      };
      const result = decision === "add"
        ? await addImportCandidate(input)
        : decision === "merge"
          ? await mergeImportCandidate(input)
          : await skipImportCandidate(input);
      if (result.outcome === "conflict") return res.status(409).json({ error: result.warnings[0] || "Import decision conflict", result });
      res.json({
        ok: true,
        imported: result.outcome === "added" ? 1 : 0,
        updated: result.outcome === "merged" ? 1 : 0,
        repaired: 0,
        skipped: result.outcome === "skipped" ? 1 : 0,
        result,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/import-queue/cancel", requireAdmin, async (_req, res) => {
    try {
      const { abortScan, isScanActuallyRunning } = await import("../import-queue");
      if (!isScanActuallyRunning()) {
        return res.json({ ok: true, message: "No scan running" });
      }
      abortScan();
      res.json({ ok: true, message: "Scan cancellation requested" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/import-queue/reset", requireAdmin, async (_req, res) => {
    try {
      const { saveQueueState } = await import("../import-queue");
      await saveQueueState({
        candidates: {},
        scan: { status: "idle", threadsProcessed: 0, estimatedTotal: 0, contactsFound: 0 },
        stats: { totalAdded: 0, totalMerged: 0, totalSkipped: 0 },
      });
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // === OpenAI Subscription OAuth Routes ===

  const OPENAI_SUBSCRIPTION_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
  const OPENAI_SUBSCRIPTION_TOKEN_URL = "https://auth.openai.com/oauth/token";
  const OPENAI_SUBSCRIPTION_AUTH_URL = "https://auth.openai.com/oauth/authorize";
  const OPENAI_SUBSCRIPTION_SCOPES = "openid profile email offline_access";
  const OPENAI_SUBSCRIPTION_ACCOUNT_ID = "openai-subscription-primary";

  const pkceStore = new Map<string, { codeVerifier: string; redirectUri: string; createdAt: number }>();

  function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    return { codeVerifier, codeChallenge };
  }

  const OPENAI_SUBSCRIPTION_REDIRECT_URI = "http://localhost:1455/auth/callback";

  app.get("/api/openai-subscription/status", async (_req, res) => {
    try {
      // Use system principal: this is a system-wide integration check, not per-user.
      // The global auth middleware may have set a user principal whose ownership
      // predicates hide legacy rows with NULL owner_user_id.
      const result = await runWithPrincipal(createNamedSystemPrincipal("openai-subscription-check"), async () => {
        const { getAccount, getAccountTokens } = await import("../connected-accounts");
        const account = await getAccount(OPENAI_SUBSCRIPTION_ACCOUNT_ID);
        if (!account) {
          return { connected: false as const };
        }
        const tokens = await getAccountTokens(OPENAI_SUBSCRIPTION_ACCOUNT_ID);
        return {
          connected: true as const,
          email: account.email,
          label: account.label,
          hasTokens: !!tokens,
        };
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/openai-subscription/oauth/start", requireAuth, requirePermission("system:write"), async (_req, res) => {
    try {
      const { codeVerifier, codeChallenge } = generatePKCE();
      const state = crypto.randomBytes(16).toString("hex");
      pkceStore.set(state, { codeVerifier, redirectUri: OPENAI_SUBSCRIPTION_REDIRECT_URI, createdAt: Date.now() });

      // Clean up old entries
      const now = Date.now();
      for (const [k, v] of pkceStore.entries()) {
        if (now - v.createdAt > 10 * 60 * 1000) pkceStore.delete(k);
      }

      const params = new URLSearchParams({
        response_type: "code",
        client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
        redirect_uri: OPENAI_SUBSCRIPTION_REDIRECT_URI,
        scope: OPENAI_SUBSCRIPTION_SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
      });

      const url = `${OPENAI_SUBSCRIPTION_AUTH_URL}?${params.toString()}`;
      res.json({ url, state });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  async function handleOAuthCallback(req: any, res: any) {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string;
      const errorParam = req.query.error as string | undefined;

      if (errorParam) {
        const safeError = escapeHtml(String(errorParam));
        const safeDesc = escapeHtml(String(req.query.error_description || ""));
        return res.status(400).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#e0e0e0"><h2>Authorization Failed</h2><p>${safeError}${safeDesc ? `: ${safeDesc}` : ""}</p></body></html>`);
      }

      if (!code || !state) {
        return res.status(400).send("Missing authorization code or state");
      }

      const pkce = pkceStore.get(state);
      if (!pkce) {
        return res.status(400).send("Invalid or expired state");
      }
      pkceStore.delete(state);

      const redirectUri = pkce.redirectUri;

      const tokenParams = new URLSearchParams({
        client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: pkce.codeVerifier,
      });

      const tokenResponse = await fetch(OPENAI_SUBSCRIPTION_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
      });

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text();
        throw new Error(`Token exchange failed: ${errText}`);
      }

      const tokens = await tokenResponse.json() as {
        access_token: string;
        refresh_token?: string;
        token_type: string;
        expires_in?: number;
        id_token?: string;
      };

      // Decode id_token to get email/name
      let email = "";
      let name = "";
      if (tokens.id_token) {
        try {
          const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
          email = payload.email || "";
          name = payload.name || payload.email || "";
        } catch { /* ignore */ }
      }

      const expiryDate = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
      const storedTokens = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        expiry_date: expiryDate,
        email,
      };

      const { createAccount } = await import("../connected-accounts");
      await runWithPrincipal(createNamedSystemPrincipal("openai-subscription-check"), () => createAccount({
        accountId: OPENAI_SUBSCRIPTION_ACCOUNT_ID,
        provider: "openai-subscription",
        email,
        label: name || email || "ChatGPT Account",
        tokens: storedTokens,
      }));

      const safeEmail = escapeHtml(email || "Account");
      res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#e0e0e0"><h2>ChatGPT Account Connected</h2><p><strong>${safeEmail}</strong></p><p>You can close this tab.</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
    } catch (error: any) {
      const safeMsg = escapeHtml(String(error.message || "Unknown error"));
      res.status(500).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#e0e0e0"><h2>Authorization Failed</h2><p>${safeMsg}</p></body></html>`);
    }
  }

  app.get("/callback", handleOAuthCallback);
  app.get("/auth/callback", handleOAuthCallback);
  app.get("/api/openai-subscription/oauth/callback", handleOAuthCallback);

  import("http").then((http) => {
    const oauthCallbackServer = http.createServer((inReq, inRes) => {
      if (inReq.url?.startsWith("/auth/callback")) {
        const parsedUrl = new URL(inReq.url, "http://localhost:1455");
        const query: Record<string, string> = {};
        for (const [k, v] of parsedUrl.searchParams.entries()) query[k] = v;
        const fakeReq = { query, get: () => "localhost:1455" } as any;
        const fakeRes = {
          statusCode: 200,
          status(code: number) { this.statusCode = code; return this; },
          send(html: string) {
            inRes.writeHead(this.statusCode, { "Content-Type": "text/html" });
            inRes.end(html);
          },
        } as any;
        handleOAuthCallback(fakeReq, fakeRes);
      } else {
        inRes.writeHead(404);
        inRes.end("Not found");
      }
    });
    oauthCallbackServer.listen(1455, "localhost", () => {
      log.log("OAuth callback server listening on http://localhost:1455");
    });
    oauthCallbackServer.on("error", (err: any) => {
      log.error("Could not start OAuth callback server on port 1455:", err.message);
    });
  });

  app.post("/api/openai-subscription/oauth/exchange", requireAuth, requirePermission("system:write"), async (req, res) => {
    try {
      const { code, state } = req.body;
      if (!code || !state) {
        return res.status(400).json({ error: "Missing code or state" });
      }
      const pkce = pkceStore.get(state);
      if (!pkce) {
        return res.status(400).json({ error: "Invalid or expired state" });
      }
      pkceStore.delete(state);

      const tokenParams = new URLSearchParams({
        client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
        code,
        redirect_uri: pkce.redirectUri,
        grant_type: "authorization_code",
        code_verifier: pkce.codeVerifier,
      });

      const tokenResponse = await fetch(OPENAI_SUBSCRIPTION_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
      });

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text();
        throw new Error(`Token exchange failed: ${errText}`);
      }

      const tokens = await tokenResponse.json() as {
        access_token: string;
        refresh_token?: string;
        token_type: string;
        expires_in?: number;
        id_token?: string;
      };

      let email = "";
      let name = "";
      if (tokens.id_token) {
        try {
          const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
          email = payload.email || "";
          name = payload.name || payload.email || "";
        } catch { /* ignore */ }
      }

      const expiryDate = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
      const storedTokens = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        expiry_date: expiryDate,
        email,
      };

      const { createAccount } = await import("../connected-accounts");
      await runWithPrincipal(createNamedSystemPrincipal("openai-subscription-check"), () => createAccount({
        accountId: OPENAI_SUBSCRIPTION_ACCOUNT_ID,
        provider: "openai-subscription",
        email,
        label: name || email || "ChatGPT Account",
        tokens: storedTokens,
      }));

      res.json({ success: true, email });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/openai-subscription/disconnect", requireAuth, requirePermission("system:write"), async (_req, res) => {
    try {
      const { deleteAccount } = await import("../connected-accounts");
      await runWithPrincipal(createNamedSystemPrincipal("openai-subscription-check"), () => deleteAccount(OPENAI_SUBSCRIPTION_ACCOUNT_ID));
      res.json({ disconnected: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/claude-cli/status", async (_req, res) => {
    try {
      const token = getSecretSync("CLAUDE_CODE_OAUTH_TOKEN");
      if (!token) {
        return res.json({ connected: false, error: "CLAUDE_CODE_OAUTH_TOKEN not configured" });
      }

      const { spawn } = await import("child_process");
      const path = await import("path");
      const fs = await import("fs");
      const bundledClaudeBin = path.resolve(process.cwd(), "dist", "claude-cli-runtime", "node_modules", ".bin", "claude");
      const cliBin = fs.existsSync(bundledClaudeBin)
        ? bundledClaudeBin
        : path.resolve(process.cwd(), "node_modules", ".bin", "claude");

      const verification = await new Promise<{ connected: boolean; error?: string }>((resolve) => {
        const cliEnv: Record<string, string> = { ...process.env } as Record<string, string>;
        cliEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
        delete cliEnv.ANTHROPIC_API_KEY;
        const child = spawn(cliBin, ["-p", "Say OK", "--bare", "--output-format", "json"], {
          env: cliEnv,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 30000,
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          resolve({ connected: false, error: "Verification timed out" });
        }, 25000);

        child.on("error", (err: Error) => {
          clearTimeout(timer);
          resolve({ connected: false, error: `CLI binary not found: ${err.message}` });
        });

        child.on("close", (code: number | null) => {
          clearTimeout(timer);
          if (code === 0 && stdout.trim()) {
            resolve({ connected: true });
          } else {
            const errMsg = stderr.trim() || `CLI exited with code ${code}`;
            if (errMsg.includes("expired") || errMsg.includes("invalid") || errMsg.includes("unauthorized") || errMsg.includes("401")) {
              resolve({ connected: false, error: "Token expired or invalid. Please re-run `claude setup-token` and update the secret." });
            } else {
              resolve({ connected: false, error: errMsg.slice(0, 200) });
            }
          }
        });
      });

      res.json(verification);
    } catch (error: any) {
      res.status(500).json({ connected: false, error: error.message });
    }
  });

  app.get("/api/twitter/accounts", async (_req, res) => {
    try {
      // Runs under the request principal: connected accounts are user-owned sensitive data.
      const result = await (async () => {
        const { listTwitterAccounts, verifyStoredCredentials, getTwitterPermissions } = await import("../twitter");
        const accounts = await listTwitterAccounts();
        const enriched = await Promise.all(accounts.map(async (a) => {
          const status = await verifyStoredCredentials(a.id);
          const permissions = await getTwitterPermissions(a.id);
          return { ...a, valid: status.valid, username: status.username, error: status.error, permissions };
        }));
        return { accounts: enriched };
      })();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/twitter/accounts/add", async (req, res) => {
    try {
      const { addTwitterAccount } = await import("../twitter");
      const { apiKey, apiSecret, accessToken, accessTokenSecret, bearerToken, label } = req.body;
      if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
        return res.status(400).json({ error: "All four credentials are required: apiKey, apiSecret, accessToken, accessTokenSecret" });
      }
      const account = await addTwitterAccount(
        {
          apiKey: String(apiKey),
          apiSecret: String(apiSecret),
          accessToken: String(accessToken),
          accessTokenSecret: String(accessTokenSecret),
          ...(bearerToken ? { bearerToken: String(bearerToken) } : {}),
        },
        label || "Personal"
      );
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/twitter/accounts/:id", async (req, res) => {
    try {
      const { removeTwitterAccount } = await import("../twitter");
      await removeTwitterAccount(req.params.id);
      res.json({ removed: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/twitter/accounts/:id/tokens", requireAuth, requirePermission("system:write"), async (req, res) => {
    try {
      const { bearerToken } = req.body;
      if (!bearerToken || typeof bearerToken !== "string") {
        return res.status(400).json({ error: "bearerToken is required" });
      }
      const { updateBearerToken } = await import("../twitter");
      await updateBearerToken(req.params.id, bearerToken.trim());
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/twitter/accounts/:id/permissions", requireAuth, requirePermission("system:write"), async (req, res) => {
    try {
      const { setTwitterPermissions } = await import("../twitter");
      const perms = await setTwitterPermissions(req.params.id, req.body);
      res.json({ permissions: perms });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/triage-log", async (req, res) => {
    try {
      const sinceHours = parseInt(req.query.sinceHours as string) || 168;
      const entries = await storage.getTriageLog(sinceHours);
      res.json({ entries });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Email draft CRUD moved to server/routes/email-drafts.ts
  // with new schema (uuid IDs, scoped-storage, human-only send gate).

  // === Automation Auth Token ===

  // ---------------------------------------------------------------------------
  // Recall.ai (meeting bot)
  // ---------------------------------------------------------------------------

  app.get("/api/integrations/recall/status", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { getRecallConfig, testRecallConnection } = await import(
        "../integrations/recall/client"
      );
      const cfg = await getRecallConfig();
      if (!cfg.hasKey || !cfg.region) {
        return res.json({
          connected: false,
          hasKey: cfg.hasKey,
          region: cfg.region,
          hasWebhookSecret: cfg.hasWebhookSecret,
          hasWorkspaceVerificationSecret: cfg.hasWorkspaceVerificationSecret,
        });
      }
      const test = await testRecallConnection();
      const { getRuntimePublicBaseUrl, getRuntimeIdentity } = await import("../runtime-identity");
      const runtime = getRuntimeIdentity();
      const webhookBase = getRuntimePublicBaseUrl() || `${req.protocol}://${req.get("host")}`;
      res.json({
        connected: test.connected,
        hasKey: cfg.hasKey,
        region: cfg.region,
        hasWebhookSecret: cfg.hasWebhookSecret,
        hasWorkspaceVerificationSecret: cfg.hasWorkspaceVerificationSecret,
        statusWebhookUrl: `${webhookBase}/api/webhooks/recall`,
        transcriptWebhookUrl: `${webhookBase}/api/webhooks/recall/transcript`,
        runtimeEnvironment: runtime.environmentName,
        servingHost: runtime.servingHost,
        publicUrl: runtime.publicUrl,
        publicUrlMismatch: runtime.publicUrlMismatch,
        error: test.error,
      });
    } catch (error: any) {
      res.json({ connected: false, error: error.message });
    }
  });

  app.post("/api/integrations/recall/test", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { getRecallConfig, testRecallConnection } = await import(
        "../integrations/recall/client"
      );
      const cfg = await getRecallConfig();
      const test = await testRecallConnection();
      const { getRuntimePublicBaseUrl, getRuntimeIdentity } = await import("../runtime-identity");
      const runtime = getRuntimeIdentity();
      const webhookBase = getRuntimePublicBaseUrl() || `${req.protocol}://${req.get("host")}`;
      res.json({
        connected: test.connected,
        hasKey: cfg.hasKey,
        region: cfg.region,
        hasWebhookSecret: cfg.hasWebhookSecret,
        hasWorkspaceVerificationSecret: cfg.hasWorkspaceVerificationSecret,
        statusWebhookUrl: `${webhookBase}/api/webhooks/recall`,
        transcriptWebhookUrl: `${webhookBase}/api/webhooks/recall/transcript`,
        runtimeEnvironment: runtime.environmentName,
        servingHost: runtime.servingHost,
        publicUrl: runtime.publicUrl,
        publicUrlMismatch: runtime.publicUrlMismatch,
        error: test.error,
      });
    } catch (error: any) {
      res.status(500).json({ connected: false, error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Twilio + Deepgram (phone agent)
  // ---------------------------------------------------------------------------

  const twilioStatus = async (req: any) => {
    const { getTwilioConfig, testTwilioConnection } = await import("../integrations/twilio/client");
    const { getRuntimePublicBaseUrl, getRuntimeIdentity } = await import("../runtime-identity");
    const config = getTwilioConfig();
    const test = config.hasAccountSid && config.hasAuthToken
      ? await testTwilioConnection()
      : { connected: false, ownedNumbers: [], configuredNumberOwned: false };
    const runtime = getRuntimeIdentity();
    const callbackBase = getRuntimePublicBaseUrl() || `${req.protocol}://${req.get("host")}`;
    return {
      ...test,
      hasAccountSid: config.hasAccountSid,
      hasAuthToken: config.hasAuthToken,
      hasPhoneNumber: config.hasPhoneNumber,
      configuredPhoneNumber: config.phoneNumber,
      voiceWebhookUrl: `${callbackBase}/api/webhooks/twilio/voice`,
      mediaStreamUrl: `${callbackBase.replace(/^http/, "ws")}/api/webhooks/twilio/media`,
      runtimeEnvironment: runtime.environmentName,
      servingHost: runtime.servingHost,
      publicUrl: runtime.publicUrl,
      publicUrlMismatch: runtime.publicUrlMismatch,
    };
  };

  app.get("/api/integrations/twilio/status", requireAuth, requireAdmin, async (req, res) => {
    try { res.json(await twilioStatus(req)); }
    catch (error: any) { res.json({ connected: false, ownedNumbers: [], configuredNumberOwned: false, error: error.message }); }
  });

  app.post("/api/integrations/twilio/test", requireAuth, requireAdmin, async (req, res) => {
    try { res.json(await twilioStatus(req)); }
    catch (error: any) { res.status(500).json({ connected: false, ownedNumbers: [], configuredNumberOwned: false, error: error.message }); }
  });

  const deepgramStatus = async () => {
    const { hasDeepgramApiKey, testDeepgramConnection } = await import("../integrations/deepgram/client");
    const hasApiKey = hasDeepgramApiKey();
    return { hasApiKey, ...(hasApiKey ? await testDeepgramConnection() : { connected: false }) };
  };

  app.get("/api/integrations/deepgram/status", requireAuth, requireAdmin, async (_req, res) => {
    try { res.json(await deepgramStatus()); }
    catch (error: any) { res.json({ connected: false, error: error.message }); }
  });

  app.post("/api/integrations/deepgram/test", requireAuth, requireAdmin, async (_req, res) => {
    try { res.json(await deepgramStatus()); }
    catch (error: any) { res.status(500).json({ connected: false, error: error.message }); }
  });

  // ---------------------------------------------------------------------------
  // Expo / EAS
  // ---------------------------------------------------------------------------

  app.get("/api/integrations/expo/status", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const { getExpoToken, getViewer } = await import("../integrations/expo");
      const token = await getExpoToken();
      if (!token) return res.json({ connected: false });
      const viewer = await getViewer();
      res.json({
        connected: true,
        username: viewer.username,
        accountName: viewer.primaryAccount?.name || viewer.username,
        accounts: viewer.accounts || [],
      });
    } catch (error: any) {
      res.json({ connected: false, error: error.message });
    }
  });

  app.get("/api/integrations/expo/projects", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const { listProjects } = await import("../integrations/expo");
      res.json({ projects: await listProjects() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/expo/project-config", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const { getProjectConfig } = await import("../integrations/expo");
      res.json(getProjectConfig());
    } catch (error: any) {
      res.status(500).json({ configured: false, error: error.message });
    }
  });


  app.get("/api/integrations/expo/apple-credentials", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const { getAppleCredentialsConfig, redactAppleCredentialsConfig } = await import("../integrations/expo");
      res.json(redactAppleCredentialsConfig(await getAppleCredentialsConfig()));
    } catch (error: any) {
      res.status(500).json({ configured: false, error: error.message });
    }
  });

  app.put("/api/integrations/expo/apple-credentials", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { saveAppleCredentialsConfig, redactAppleCredentialsConfig } = await import("../integrations/expo");
      const config = await saveAppleCredentialsConfig(req.body || {});
      res.json(redactAppleCredentialsConfig(config));
    } catch (error: any) {
      res.status(400).json({ configured: false, error: error.message });
    }
  });

  app.post("/api/integrations/expo/apple-credentials/setup", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const { startInteractiveAppleCredentialsSetup } = await import("../integrations/expo");
      res.json({ run: await startInteractiveAppleCredentialsSetup() });
    } catch (error: any) {
      log.error("Expo Apple credentials setup request failed", { error: error.message, stack: error.stack });
      res.status(500).json({ ok: false, stderr: error.message, error: error.message, exitCode: null });
    }
  });

  app.post("/api/integrations/expo/apple-credentials/input", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { sendInteractiveEasInput } = await import("../integrations/expo");
      res.json({ run: sendInteractiveEasInput(String(req.body?.input ?? "")) });
    } catch (error: any) {
      log.error("Expo Apple credentials input failed", { error: error.message, stack: error.stack });
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/integrations/expo/apple-credentials/cancel", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const { cancelInteractiveEasRun } = await import("../integrations/expo");
      res.json({ run: cancelInteractiveEasRun() });
    } catch (error: any) {
      log.error("Expo Apple credentials cancel failed", { error: error.message, stack: error.stack });
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/integrations/expo/build", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { profile = "preview", platform = "ios", cancelExisting = true } = req.body || {};
      const { easBuild } = await import("../integrations/expo");
      res.json(await easBuild(profile, platform, "main", { cancelExisting: cancelExisting !== false }));
    } catch (error: any) {
      log.error("Expo build request failed", {
        profile: req.body?.profile,
        platform: req.body?.platform,
        source: "main",
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ ok: false, stderr: error.message, error: error.message, exitCode: null });
    }
  });


  app.post("/api/integrations/expo/builds/cancel", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { buildId, projectId, profile, platform } = req.body || {};
      const expo = await import("../integrations/expo");
      if (typeof buildId === "string" && buildId.trim()) {
        return res.json({ cancelled: [await expo.cancelBuild(buildId.trim())] });
      }
      const cancelled = await expo.cancelInProgressBuilds({
        projectId: typeof projectId === "string" && projectId.trim() ? projectId.trim() : undefined,
        profile: typeof profile === "string" && profile.trim() ? profile.trim() : undefined,
        platform: typeof platform === "string" && platform.trim() ? platform.trim() : undefined,
      });
      res.json({ cancelled });
    } catch (error: any) {
      log.error("Expo build cancel request failed", { error: error.message, stack: error.stack });
      res.status(500).json({ error: error.message });
    }
  });

  // Auto-build toggle — defaults to true (on)
  const MOBILE_AUTO_BUILD_KEY = "system.mobile_auto_build";

  app.get("/api/integrations/expo/auto-build", requireAuth, requireAdmin, async (_req, res) => {
    const enabled = await getSetting<boolean>(MOBILE_AUTO_BUILD_KEY);
    res.json({ enabled: enabled !== false }); // default true when unset
  });

  app.put("/api/integrations/expo/auto-build", requireAuth, requireAdmin, async (req, res) => {
    const enabled = req.body?.enabled === true;
    await setSetting(MOBILE_AUTO_BUILD_KEY, enabled);
    log.log("Mobile auto-build toggled", { enabled });
    res.json({ enabled });
  });

  app.post("/api/webhooks/github", async (req, res) => {
    const eventName = String(req.get("x-github-event") || "");
    const deliveryId = String(req.get("x-github-delivery") || "");
    const secret = getGitHubWebhookSecret();

    if (!secret) {
      log.warn("GitHub webhook rejected: GITHUB_WEBHOOK_SECRET is not configured", { eventName, deliveryId });
      return res.status(503).json({ ok: false, error: "webhook_secret_not_configured" });
    }

    if (!verifyGitHubWebhookSignature(req.rawBody, req.get("x-hub-signature-256"), secret)) {
      log.warn("GitHub webhook rejected: signature verification failed", { eventName, deliveryId });
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    if (eventName !== "push") {
      return res.json({ ok: true, ignored: true, reason: "unsupported_event" });
    }

    const ref = typeof req.body?.ref === "string" ? req.body.ref : "";
    if (ref !== "refs/heads/main") {
      return res.json({ ok: true, ignored: true, reason: "non_main_ref", ref });
    }

    // Check auto-build setting (defaults to true when unset)
    const autoBuildEnabled = await getSetting<boolean>(MOBILE_AUTO_BUILD_KEY);
    if (autoBuildEnabled === false) {
      log.log("GitHub push to main ignored: mobile auto-build is disabled", { deliveryId });
      return res.json({ ok: true, ignored: true, reason: "auto_build_disabled" });
    }

    const sourceRef = typeof req.body?.after === "string" ? req.body.after : null;
    const { triggerMainMobileBuild } = await import("../integrations/expo");

    triggerMainMobileBuild({
      profile: "preview",
      platform: "ios",
      sourceRef,
      reason: `github_push:${deliveryId || sourceRef || "unknown"}`,
    }).catch((error: any) => {
      log.error("GitHub-triggered Mobile build failed", {
        deliveryId,
        sourceRef,
        error: error.message,
        stack: error.stack,
      });
    });

    return res.json({ ok: true, triggered: true, sourceRef });
  });

  app.get("/api/integrations/expo/build-log", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const { getLatestEasRun } = await import("../integrations/expo");
      res.json({ run: await getLatestEasRun() });
    } catch (error: any) {
      log.error("Expo build log request failed", { error: error.message, stack: error.stack });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/expo/builds", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const { getProjectConfig, listBuilds } = await import("../integrations/expo");
      const projectId = getProjectConfig().projectId;
      if (!projectId) return res.json({ builds: [], error: "Mobile Expo config has no Expo projectId." });
      const builds = await listBuilds(projectId, 10);
      res.json({ builds });
    } catch (error: any) {
      log.error("Expo build list request failed", { error: error.message, stack: error.stack });
      res.status(500).json({ error: error.message, stderr: error.message });
    }
  });

  app.get("/api/integrations/meta/wearables", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const stored = await getSetting<MetaWearablesConfig>(META_WEARABLES_CONFIG_KEY);
      res.json(redactMetaWearablesConfig(normalizeMetaWearablesConfig(stored)));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/integrations/meta/wearables", requireAuth, requireAdmin, async (req, res) => {
    try {
      const current = normalizeMetaWearablesConfig(await getSetting<MetaWearablesConfig>(META_WEARABLES_CONFIG_KEY));
      const body = req.body && typeof req.body === "object" ? req.body as Partial<MetaWearablesConfig> : {};
      const next = normalizeMetaWearablesConfig({
        ...current,
        ...body,
        applicationId: typeof body.applicationId === "string" && body.applicationId.trim() ? body.applicationId : current.applicationId,
        mwdatPlistEntry: typeof body.mwdatPlistEntry === "string" && body.mwdatPlistEntry.trim() ? body.mwdatPlistEntry : current.mwdatPlistEntry,
      });

      if (next.universalLink && !next.universalLink.startsWith("https://")) {
        return res.status(400).json({ error: "Universal link must be an HTTPS URL" });
      }
      if (next.bundleId && !/^[A-Za-z0-9.-]+$/.test(next.bundleId)) {
        return res.status(400).json({ error: "Bundle ID contains invalid characters" });
      }

      await setSetting(META_WEARABLES_CONFIG_KEY, next);
      res.json(redactMetaWearablesConfig(next));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/automation-auth", requireAuth, requireAdmin, async (_req, res) => {
    try {
      // One-time migration from old setting key
      let token = await getSetting<string>("system.automation_auth_token");
      if (!token) {
        const oldToken = await getSetting<string>("system.screenshot_auth_token");
        if (oldToken) {
          await setSetting("system.automation_auth_token", oldToken);
          await setSetting("system.screenshot_auth_token", null as any);
          token = oldToken;
        }
      }
      res.json({
        configured: !!token,
        lastChars: token ? token.slice(-8) : null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/integrations/automation-auth", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { token, generate } = req.body;
      if (!token && !generate) {
        return res.status(400).json({ error: "Provide 'token' or set 'generate' to true" });
      }
      const finalToken = generate ? crypto.randomBytes(32).toString("hex") : token;
      if (typeof finalToken !== "string" || finalToken.length < 32) {
        return res.status(400).json({ error: "Token must be at least 32 characters" });
      }
      await setSetting("system.automation_auth_token", finalToken);
      res.json({
        configured: true,
        lastChars: finalToken.slice(-8),
        ...(generate ? { token: finalToken } : {}),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

}
