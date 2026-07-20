import type { Express } from "express";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { db } from "../db";
import { merchantCategoryOverrides, expenseCategories, plaidSyncCursors, plaidTransactions } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

const log = createLogger("PlaidRoutes");

export async function registerPlaidRoutes(app: Express) {
  app.post("/api/plaid/create-link-token", requireAuth, async (_req, res) => {
    try {
      const { createLinkToken, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("../plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const parts: string[] = [];
        if (diag.missing.length > 0) parts.push(`missing: ${diag.missing.join(", ")}`);
        if (diag.invalid.length > 0) parts.push(`invalid: ${diag.invalid.join(", ")} (PLAID_ENV must be sandbox, development, or production)`);
        return res.status(400).json({ error: `Plaid is not configured. ${parts.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV.`, diagnostics: diag });
      }
      const result = await createLinkToken();
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("create-link-token error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/plaid/exchange-token", requireAuth, async (req, res) => {
    try {
      const { exchangePublicToken, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("../plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        return res.status(400).json({ error: "Plaid is not configured. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV (sandbox, development, or production).", diagnostics: diag });
      }
      const { publicToken } = req.body;
      if (!publicToken) {
        return res.status(400).json({ error: "publicToken required" });
      }
      const result = await exchangePublicToken(publicToken);
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("exchange-token error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/plaid/accounts", requireAuth, async (_req, res) => {
    try {
      const { getAccountsList, getPlaidItems, isPlaidConfigured } = await import("../plaid-service");
      if (!isPlaidConfigured()) {
        return res.json([]);
      }
      const items = await getPlaidItems();
      const accounts = await getAccountsList();
      const enriched = items.map(item => ({
        ...item,
        accounts: accounts.filter(a => a.itemId === item.itemId),
      }));
      res.json(enriched);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("accounts error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/plaid/sync", requireAuth, async (req, res) => {
    try {
      const { fullSyncItem, getPlaidItems, isPlaidConfigured, getPlaidConfigDiagnostics, isItemSyncing } = await import("../plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        return res.status(400).json({ error: "Plaid is not configured. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV (sandbox, development, or production).", diagnostics: diag });
      }
      const itemId = req.body?.itemId;
      const cursorRows = await db.select().from(plaidSyncCursors);
      const cursorMap = new Map(cursorRows.map(r => [r.itemId, { cursor: r.cursor, lastSynced: r.lastSynced, syncStatus: r.syncStatus }]));

      const LARGE_CATCHUP_HOURS = 24;
      const isLargeCatchup = (id: string) => {
        const entry = cursorMap.get(id);
        if (!entry || !entry.cursor) return true;
        if (entry.lastSynced) {
          const hoursSinceLast = (Date.now() - new Date(entry.lastSynced).getTime()) / (1000 * 60 * 60);
          return hoursSinceLast > LARGE_CATCHUP_HOURS;
        }
        return false;
      };

      const alreadySyncing = (id: string) => {
        return isItemSyncing(id) || cursorMap.get(id)?.syncStatus === "syncing";
      };

      if (itemId) {
        if (alreadySyncing(itemId)) {
          return res.json({ accepted: true, mode: "background", message: "Sync already in progress", syncedItemIds: [itemId] });
        }
        if (isLargeCatchup(itemId)) {
          res.json({ accepted: true, mode: "background", message: "Sync started in background", syncedItemIds: [itemId] });
          fullSyncItem(itemId).catch((err: unknown) => {
            log.error(`Background sync failed for ${itemId}: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else {
          const result = await fullSyncItem(itemId);
          return res.json({ ...result, mode: "sync" });
        }
      } else {
        const items = await getPlaidItems();
        const syncableItems = items.filter(item => !alreadySyncing(item.itemId));
        const hasLarge = syncableItems.some(item => isLargeCatchup(item.itemId));
        if (hasLarge) {
          const syncedItemIds = syncableItems.map(item => item.itemId);
          res.json({ accepted: true, mode: "background", message: "Sync started in background (includes large catch-up)", syncedItemIds });
          for (const item of syncableItems) {
            fullSyncItem(item.itemId).catch((err: unknown) => {
              log.error(`Background sync failed for ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        } else {
          const results: Array<{ itemId: string; added?: number; modified?: number; removed?: number; error?: string }> = [];
          for (const item of syncableItems) {
            try {
              const result = await fullSyncItem(item.itemId);
              results.push({ itemId: item.itemId, ...result });
            } catch (err: unknown) {
              results.push({ itemId: item.itemId, error: err instanceof Error ? err.message : String(err) });
            }
          }
          res.json({ results, mode: "sync" });
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("sync error:", msg);
      if (!res.headersSent) res.status(500).json({ error: msg });
    }
  });

  app.post("/api/plaid/refresh", requireAuth, async (_req, res) => {
    try {
      const { refreshAllItems, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("../plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        return res.status(400).json({ error: "Plaid is not configured. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV (sandbox, development, or production).", diagnostics: diag });
      }
      await refreshAllItems();
      res.json({ refreshed: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("refresh error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/plaid/refresh-liabilities", requireAuth, async (_req, res) => {
    try {
      const { getPlaidItems, fetchLiabilities, isPlaidConfigured } = await import("../plaid-service");
      if (!isPlaidConfigured()) {
        return res.status(400).json({ error: "Plaid is not configured." });
      }
      const items = await getPlaidItems();
      let total = 0;
      for (const item of items) {
        try {
          const count = await fetchLiabilities(item.itemId);
          total += count;
        } catch (e: unknown) {
          log.error(`Failed to refresh liabilities for ${item.itemId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      res.json({ refreshed: true, count: total });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("refresh-liabilities error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/plaid/detect-recurring", requireAuth, async (_req, res) => {
    try {
      const { getPlaidItems, fetchRecurring, isPlaidConfigured } = await import("../plaid-service");
      if (!isPlaidConfigured()) {
        return res.status(400).json({ error: "Plaid is not configured." });
      }
      const items = await getPlaidItems();
      let total = 0;
      for (const item of items) {
        try {
          const count = await fetchRecurring(item.itemId);
          total += count;
        } catch (e: unknown) {
          log.error(`Failed to detect recurring for ${item.itemId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      res.json({ detected: true, count: total });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("detect-recurring error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/plaid/force-resync", requireAuth, async (req, res) => {
    try {
      const { forceResync, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("../plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        return res.status(400).json({ error: "Plaid is not configured.", diagnostics: diag });
      }
      const { isItemSyncing } = await import("../plaid-service");
      const { itemId } = req.body;
      if (!itemId) {
        return res.status(400).json({ error: "itemId is required" });
      }
      if (isItemSyncing(itemId)) {
        return res.status(409).json({ error: "Item is currently syncing — wait for the current sync to finish" });
      }
      res.json({ accepted: true, mode: "background", message: "Force re-sync started in background", syncedItemIds: [itemId] });
      forceResync(itemId).catch((err: unknown) => {
        log.error(`Force re-sync failed for ${itemId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("force-resync error:", msg);
      if (!res.headersSent) res.status(500).json({ error: msg });
    }
  });

  app.get("/api/plaid/sync-status", requireAuth, async (_req, res) => {
    try {
      const { isItemSyncing, getSyncPhase } = await import("../plaid-service");
      const rows = await db.select().from(plaidSyncCursors);

      const dateRanges = await db
        .select({
          itemId: plaidTransactions.itemId,
          oldestDate: sql<string>`min(date)`,
          newestDate: sql<string>`max(date)`,
        })
        .from(plaidTransactions)
        .groupBy(plaidTransactions.itemId);
      const dateRangeMap = new Map(dateRanges.map(d => [d.itemId, { oldest: d.oldestDate, newest: d.newestDate }]));

      const statuses = rows.map(r => {
        const range = dateRangeMap.get(r.itemId);
        return {
          itemId: r.itemId,
          status: isItemSyncing(r.itemId) ? "syncing" : r.syncStatus,
          syncPhase: getSyncPhase(r.itemId),
          pagesCompleted: r.pagesCompleted,
          totalAdded: r.totalAdded,
          error: r.syncError,
          lastSynced: r.lastSynced?.toISOString() || null,
          syncStartedAt: r.syncStartedAt?.toISOString() || null,
          lastSyncAttempt: r.lastSyncAttempt?.toISOString() || null,
          needsInvestigation: r.needsInvestigation,
          hasCursor: !!r.cursor,
          initialSyncComplete: !!r.cursor && !r.needsInvestigation,
          oldestTransaction: range?.oldest || null,
          newestTransaction: range?.newest || null,
        };
      });
      res.json({ statuses });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/plaid/transactions", requireAuth, async (req, res) => {
    try {
      const { getTransactions } = await import("../plaid-service");
      const filters = {
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
        category: req.query.category as string | undefined,
        accountId: req.query.accountId as string | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
      };
      const { transactions, total } = await getTransactions(filters);

      const overrides = await db.select().from(merchantCategoryOverrides);
      const categories = await db.select().from(expenseCategories);
      const catById = new Map(categories.map(c => [c.id, c]));
      const merchantMap = new Map(overrides.map(o => [o.merchantName.toLowerCase(), o.categoryId]));

      const { getPairCounterparts } = await import("../finance-internal-transfers");
      const txnIds = transactions
        .map((t: Record<string, unknown>) => t.transactionId as string | undefined)
        .filter((x: string | undefined): x is string => !!x);
      const counterparts = await getPairCounterparts(txnIds);

      const enriched = transactions.map((txn: Record<string, unknown>) => {
        const merchant = (txn.merchantName as string || "").toLowerCase();
        const overrideCatId = merchantMap.get(merchant);
        const transferCounterpart = counterparts.get(txn.transactionId as string) || null;
        const base =
          overrideCatId !== undefined
            ? { ...txn, effectiveCategory: catById.get(overrideCatId)?.plaidCategory || catById.get(overrideCatId)?.name || txn.categoryPrimary }
            : { ...txn, effectiveCategory: txn.categoryPrimary };
        return { ...base, transferCounterpart };
      });

      res.json({ transactions: enriched, total });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("transactions error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/plaid/holdings", requireAuth, async (_req, res) => {
    try {
      const { getHoldingsList } = await import("../plaid-service");
      const holdings = await getHoldingsList();
      res.json({ holdings });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("holdings error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/plaid/liabilities", requireAuth, async (_req, res) => {
    try {
      const { getLiabilitiesList } = await import("../plaid-service");
      const liabilities = await getLiabilitiesList();
      res.json({ liabilities });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("liabilities error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/plaid/recurring", requireAuth, async (_req, res) => {
    try {
      const { getRecurringTransactions } = await import("../plaid-service");
      const transactions = await getRecurringTransactions();
      res.json({ transactions });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("recurring error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/plaid/summary", requireAuth, async (_req, res) => {
    try {
      const { getFinanceSummary } = await import("../plaid-service");
      const summary = await getFinanceSummary();
      res.json(summary);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("summary error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/plaid/status", requireAuth, async (_req, res) => {
    try {
      const { isPlaidConfigured, getPlaidConfigDiagnostics, getPlaidItems } = await import("../plaid-service");
      const configured = isPlaidConfigured();
      const diagnostics = getPlaidConfigDiagnostics();
      let items: Array<{ accountId: string; itemId: string; institutionName: string; healthy: boolean }> = [];
      if (configured) {
        try {
          items = await getPlaidItems();
        } catch { }
      }
      res.json({ configured, connected: items.length > 0, itemCount: items.length, items, diagnostics });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.delete("/api/plaid/items/:accountId", requireAuth, async (req, res) => {
    try {
      const { removeItem } = await import("../plaid-service");
      const removed = await removeItem(req.params.accountId as string);
      if (!removed) return res.status(404).json({ error: "Item not found" });
      res.json({ removed: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("remove item error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/plaid/webhook", async (req, res) => {
    try {
      const rawBody = (req as unknown as Record<string, unknown>).rawBody
        ? String((req as unknown as Record<string, unknown>).rawBody)
        : JSON.stringify(req.body);
      const webhookType: string = req.body.webhook_type || "";
      const webhookCode: string = req.body.webhook_code || "";
      const itemId: string = req.body.item_id || "";
      const crypto = await import("crypto");
      const webhookEventId: string = crypto.createHash("sha256").update(rawBody).digest("hex");

      log.log(`Webhook received: ${webhookType}/${webhookCode} for item ${itemId}`);

      const { verifyWebhook, isWebhookDuplicate } = await import("../plaid-service");
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
      const valid = await verifyWebhook(rawBody, headers);
      if (!valid) {
        log.warn("Webhook verification failed");
        return res.status(401).json({ error: "Webhook verification failed" });
      }

      if (isWebhookDuplicate(webhookEventId)) {
        log.debug(`Duplicate webhook ${webhookEventId}, skipping`);
        return res.json({ received: true, duplicate: true });
      }

      res.json({ received: true });

      if (!itemId) return;

      try {
        if (webhookType === "TRANSACTIONS" && webhookCode === "SYNC_UPDATES_AVAILABLE") {
          const { syncTransactions } = await import("../plaid-service");
          await syncTransactions(itemId);
        } else if (webhookType === "HOLDINGS" && webhookCode === "DEFAULT_UPDATE") {
          const { fetchHoldings } = await import("../plaid-service");
          await fetchHoldings(itemId);
        } else if (webhookType === "LIABILITIES" && webhookCode === "DEFAULT_UPDATE") {
          const { fetchLiabilities } = await import("../plaid-service");
          await fetchLiabilities(itemId);
        } else if (webhookType === "ITEM" && webhookCode === "ERROR") {
          const { updateAccount } = await import("../connected-accounts");
          const { getPlaidItems } = await import("../plaid-service");
          const items = await getPlaidItems();
          const item = items.find(i => i.itemId === itemId);
          if (item) {
            await updateAccount(item.accountId, {
              healthy: false,
              healthError: req.body.error?.error_message || "Item error",
              healthCheckedAt: new Date(),
            });
          }
        }
      } catch (err: unknown) {
        log.error(`Webhook handler error for ${webhookType}/${webhookCode}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("webhook error:", msg);
      res.status(500).json({ error: msg });
    }
  });
}
