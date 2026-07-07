import type { Express, Request, Response } from "express";
import { createLogger } from "../log";
import { db } from "../db";
import { emailMessages, emailDrafts, emailSyncCursors, emailEnrichments } from "@shared/schema";
import { eq, and, desc, sql, ilike, inArray } from "drizzle-orm";
import { triageJob } from "../triage-job-state";
import { storage } from "../storage";
import { combineWithSensitiveVisible, combineWithSensitiveWritable, sensitiveOwnershipValues } from "../sensitive-scope";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { invalidateSimpleFeedCache } from "../simple/generate-feed";

const log = createLogger("EmailRoutes");

const messageScopeCols = { ownerUserId: emailMessages.ownerUserId, principalAccountId: emailMessages.principalAccountId };
const draftScopeCols = { ownerUserId: emailDrafts.ownerUserId, principalAccountId: emailDrafts.principalAccountId };

function activeDismissalExclusionPredicate(threadIdRef: any, accountIdRef: any) {
  // Exclude threads with an active (non-stale) dismissal. Manual Review
  // dismissal is authoritative for all tiers, including 🔴/🟡. New inbound
  // messages after the dismissal make it stale and resurface the thread.
  return sql`NOT EXISTS (
    SELECT 1 FROM email_dismissals ed
    WHERE ed.provider_thread_id = ${threadIdRef}
      AND ed.account_id = ${accountIdRef}
      AND ed.dismissed_at >= COALESCE(
        (SELECT MAX(em2.date) FROM email_messages em2
         WHERE em2.provider_thread_id = ${threadIdRef}
           AND em2.account_id = ${accountIdRef}
           AND em2.direction = 'inbound'),
        '1970-01-01'::timestamptz
      )
  )`;
}

export function registerEmailRoutes(app: Express) {
  app.get("/api/email/messages", async (req: Request, res: Response) => {
    try {
      const accountId = req.query.accountId as string | undefined;
      const triageTier = req.query.triageTier as string | undefined;
      const triageStatus = req.query.triageStatus as string | undefined;
      const isRead = req.query.isRead as string | undefined;
      const isDone = req.query.isDone as string | undefined;
      const enriched = req.query.enriched as string | undefined;
      const excludeDismissed = req.query.excludeDismissed === "true";
      const search = req.query.search as string | undefined;
      const includeSnoozed = req.query.includeSnoozed === "true";
      const groupByThread = req.query.groupByThread === "true";
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const conditions: any[] = [];
      if (!includeSnoozed) {
        conditions.push(sql`(${emailMessages.snoozedUntil} IS NULL OR ${emailMessages.snoozedUntil} <= NOW())`);
      }
      if (accountId) conditions.push(eq(emailMessages.accountId, accountId));
      if (triageTier) {
        const tiers = triageTier.split(",").map(t => t.trim()).filter(Boolean);
        if (tiers.length === 1) {
          conditions.push(eq(emailMessages.triageTier, tiers[0]));
        } else if (tiers.length > 1) {
          conditions.push(inArray(emailMessages.triageTier, tiers));
        }
      }
      if (triageStatus) conditions.push(eq(emailMessages.triageStatus, triageStatus));
      if (isRead !== undefined) conditions.push(eq(emailMessages.isRead, isRead === 'true'));
      if (isDone !== undefined) conditions.push(eq(emailMessages.isDone, isDone === 'true'));
      if (enriched === 'true') {
        conditions.push(sql`EXISTS (SELECT 1 FROM email_enrichments ee WHERE ee.provider_thread_id = ${emailMessages.providerThreadId} AND ee.account_id = ${emailMessages.accountId})`);
      } else if (enriched === 'false') {
        conditions.push(sql`NOT EXISTS (SELECT 1 FROM email_enrichments ee WHERE ee.provider_thread_id = ${emailMessages.providerThreadId} AND ee.account_id = ${emailMessages.accountId})`);
      }
      if (excludeDismissed) {
        conditions.push(activeDismissalExclusionPredicate(emailMessages.providerThreadId, emailMessages.accountId));
      }
      if (search) conditions.push(ilike(emailMessages.subject, `%${search}%`));

      const userCondition = conditions.length > 0 ? and(...conditions) : undefined;
      const where = combineWithSensitiveVisible(messageScopeCols, userCondition);

      if (groupByThread) {
        const principal = getCurrentPrincipalOrSystem();
        const rawConditions: ReturnType<typeof sql>[] = [];
        if (principal.actorType !== "system") {
          const ownerPredicates: ReturnType<typeof sql>[] = [];
          if (principal.userId) ownerPredicates.push(sql`em.owner_user_id = ${principal.userId}`);
          if (principal.accountId) ownerPredicates.push(sql`em.principal_account_id = ${principal.accountId}`);
          if (ownerPredicates.length > 0) {
            rawConditions.push(sql`(${sql.join(ownerPredicates, sql` OR `)})`);
          } else {
            rawConditions.push(sql`FALSE`);
          }
        }
        if (!includeSnoozed) {
          rawConditions.push(sql`(em.snoozed_until IS NULL OR em.snoozed_until <= NOW())`);
        }
        if (accountId) rawConditions.push(sql`em.account_id = ${accountId}`);
        if (triageTier) {
          const tiers = triageTier.split(",").map(t => t.trim()).filter(Boolean);
          if (tiers.length === 1) {
            rawConditions.push(sql`em.triage_tier = ${tiers[0]}`);
          } else if (tiers.length > 1) {
            rawConditions.push(sql`em.triage_tier IN (${sql.join(tiers.map(t => sql`${t}`), sql`, `)})`);
          }
        }
        if (triageStatus) rawConditions.push(sql`em.triage_status = ${triageStatus}`);
        if (isRead !== undefined) rawConditions.push(sql`em.is_read = ${isRead === 'true'}`);
        if (isDone !== undefined) rawConditions.push(sql`em.is_done = ${isDone === 'true'}`);
        if (enriched === 'true') {
          rawConditions.push(sql`EXISTS (SELECT 1 FROM email_enrichments ee WHERE ee.provider_thread_id = em.provider_thread_id AND ee.account_id = em.account_id)`);
        } else if (enriched === 'false') {
          rawConditions.push(sql`NOT EXISTS (SELECT 1 FROM email_enrichments ee WHERE ee.provider_thread_id = em.provider_thread_id AND ee.account_id = em.account_id)`);
        }
        if (excludeDismissed) {
          rawConditions.push(activeDismissalExclusionPredicate(sql`em.provider_thread_id`, sql`em.account_id`));
        }
        if (search) rawConditions.push(sql`em.subject ILIKE ${`%${search}%`}`);

        const rawWhere = sql`WHERE ${sql.join(rawConditions, sql` AND `)}`;

        const threadQuery = sql`
          SELECT DISTINCT ON (em.account_id, em.provider, COALESCE(em.provider_thread_id, em.provider_message_id))
            em.*,
            CASE
              WHEN em.provider_thread_id IS NOT NULL THEN
                (SELECT COUNT(*) FROM email_messages t WHERE t.provider_thread_id = em.provider_thread_id AND t.account_id = em.account_id AND t.provider = em.provider)
              ELSE 1
            END AS message_count,
            CASE
              WHEN em.provider_thread_id IS NOT NULL THEN
                (SELECT COUNT(*) FROM email_messages t WHERE t.provider_thread_id = em.provider_thread_id AND t.account_id = em.account_id AND t.provider = em.provider AND t.is_read = false)
              ELSE CASE WHEN em.is_read = false THEN 1 ELSE 0 END
            END AS unread_count,
            CASE
              WHEN em.provider_thread_id IS NOT NULL THEN
                (SELECT BOOL_OR(t.triage_status = 'triaged') FROM email_messages t WHERE t.provider_thread_id = em.provider_thread_id AND t.account_id = em.account_id AND t.provider = em.provider)
              ELSE (em.triage_status = 'triaged')
            END AS has_triaged
          FROM email_messages em
          ${rawWhere}
          ORDER BY em.account_id, em.provider, COALESCE(em.provider_thread_id, em.provider_message_id), em.date DESC
        `;

        const wrappedQuery = sql`
          SELECT * FROM (${threadQuery}) sub
          ORDER BY sub.date DESC NULLS LAST
          LIMIT ${limit} OFFSET ${offset}
        `;

        const threadMessages = await db.execute(wrappedQuery);

        const countQuery = sql`
          SELECT COUNT(*) as count FROM (
            SELECT DISTINCT ON (em.account_id, em.provider, COALESCE(em.provider_thread_id, em.provider_message_id)) em.id
            FROM email_messages em
            ${rawWhere}
            ORDER BY em.account_id, em.provider, COALESCE(em.provider_thread_id, em.provider_message_id), em.date DESC
          ) sub
        `;
        const countResult = await db.execute(countQuery);

        res.json({
          messages: threadMessages.rows,
          total: Number((countResult.rows[0] as any)?.count || 0),
          limit,
          offset,
          groupedByThread: true,
        });
        return;
      }

      const messages = await db.select().from(emailMessages)
        .where(where)
        .orderBy(desc(emailMessages.date))
        .limit(limit)
        .offset(offset);

      const countResult = await db.select({ count: sql<number>`count(*)` })
        .from(emailMessages)
        .where(where);

      res.json({
        messages,
        total: Number(countResult[0]?.count || 0),
        limit,
        offset,
      });
    } catch (err: any) {
      log.error(`GET /api/email/messages error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/email/messages/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid message ID" });

      const rows = await db.select().from(emailMessages).where(combineWithSensitiveVisible(messageScopeCols, eq(emailMessages.id, id))).limit(1);
      if (rows.length === 0) return res.status(404).json({ error: "Message not found" });
      res.json(rows[0]);
    } catch (err: any) {
      log.error(`GET /api/email/messages/:id error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/email/messages/:id/done", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid message ID" });
      const { isDone } = req.body;
      if (typeof isDone !== "boolean") return res.status(400).json({ error: "isDone must be a boolean" });
      const { storage } = await import("../storage");
      const updated = await storage.markEmailDone(id, isDone);
      if (!updated) return res.status(404).json({ error: "Message not found" });

      let gmailArchived: boolean | null = null;
      if (updated.provider === "gmail" && updated.accountId && updated.providerMessageId) {
        try {
          const { archiveEmail, unarchiveEmail } = await import("../gmail");
          if (isDone) {
            gmailArchived = await archiveEmail(updated.accountId, updated.providerMessageId);
          } else {
            gmailArchived = await unarchiveEmail(updated.accountId, updated.providerMessageId);
          }
        } catch (gmailErr: any) {
          gmailArchived = false;
          log.error(`Gmail archive/unarchive failed for message ${id}`, {
            messageId: id,
            accountId: updated.accountId,
            operation: isDone ? 'archive' : 'unarchive',
            error: gmailErr.message,
          });
        }
      }

      invalidateSimpleFeedCache(req.principal?.accountId || updated.principalAccountId || updated.accountId || undefined);
      if (gmailArchived === false && isDone) {
        const rolledBack = await storage.markEmailDone(id, false);
        res.json({ ...(rolledBack || updated), isDone: false, gmailArchived });
      } else {
        res.json({ ...updated, gmailArchived });
      }
    } catch (err: any) {
      log.error(`PATCH /api/email/messages/:id/done error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/email/messages/:id/snooze", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid message ID" });
      const { snoozedUntil } = req.body;
      if (snoozedUntil !== null && snoozedUntil !== undefined) {
        const parsed = new Date(snoozedUntil);
        if (isNaN(parsed.getTime())) return res.status(400).json({ error: "Invalid snoozedUntil date" });
      }
      const updated = await db.update(emailMessages)
        .set({
          snoozedUntil: snoozedUntil ? new Date(snoozedUntil) : null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(combineWithSensitiveWritable(messageScopeCols, eq(emailMessages.id, id)))
        .returning();
      if (updated.length === 0) return res.status(404).json({ error: "Message not found" });
      invalidateSimpleFeedCache(req.principal?.accountId || updated[0].principalAccountId || updated[0].accountId || undefined);
      res.json(updated[0]);
    } catch (err: any) {
      log.error(`PATCH /api/email/messages/:id/snooze error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/email/sync-status", async (_req: Request, res: Response) => {
    try {
      const { getSyncStatus } = await import("../email-sync");
      const status = await getSyncStatus();
      res.json(status);
    } catch (err: any) {
      log.error(`GET /api/email/sync-status error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/email/sync", async (_req: Request, res: Response) => {
    try {
      const { runEmailSync } = await import("../email-sync");
      const result = await runEmailSync();
      res.json(result);
    } catch (err: any) {
      log.error(`POST /api/email/sync error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/email/messages/:id/draft", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid message ID" });

      const message = await db.select().from(emailMessages).where(combineWithSensitiveVisible(messageScopeCols, eq(emailMessages.id, id))).limit(1);
      if (message.length === 0) return res.status(404).json({ error: "Message not found" });

      const srcMsg = message[0];
      const sender = srcMsg.fromAddress || "";
      const subject = srcMsg.subject || "(no subject)";
      const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
      const snippet = srcMsg.bodyText || srcMsg.snippet || "";
      const contextSnippet = snippet.length > 1500 ? snippet.slice(0, 1500) + "..." : snippet;

      try {
        const { handleGmailDraftFromReview } = await import("../bridge-tools");
        const draftResult = await handleGmailDraftFromReview({
          to: sender,
          subject: replySubject,
          sourceEmailId: id,
          accountId: srcMsg.accountId,
          context: `Original email from ${sender}:\nSubject: ${subject}\n\n${contextSnippet}`,
        });
        res.json(draftResult);
      } catch (skillErr: any) {
        const draftData = {
          accountId: srcMsg.accountId,
          toAddress: sender,
          subject: replySubject,
          bodyText: "",
          bodyHtml: "",
          status: "pending_review" as const,
          sourceEmailId: id,
          ...sensitiveOwnershipValues(),
        };
        const [created] = await db.insert(emailDrafts).values(draftData).returning();
        res.json({ draft: created, skillError: skillErr.message });
      }
    } catch (err: any) {
      log.error(`POST /api/email/messages/:id/draft error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/email/drafts/by-source-ids", async (req: Request, res: Response) => {
    try {
      const { sourceEmailIds } = req.body;
      if (!Array.isArray(sourceEmailIds)) return res.status(400).json({ error: "sourceEmailIds must be an array" });
      const { storage } = await import("../storage");
      const drafts = await storage.getEmailDraftsBySourceIds(sourceEmailIds);
      res.json({ drafts });
    } catch (err: any) {
      log.error(`POST /api/email/drafts/by-source-ids error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/email/drafts", async (req: Request, res: Response) => {
    try {
      const accountId = req.query.accountId as string | undefined;
      const status = req.query.status as string | undefined;

      const conditions: any[] = [];
      if (accountId) conditions.push(eq(emailDrafts.accountId, accountId));
      if (status) conditions.push(eq(emailDrafts.status, status));

      const userCondition = conditions.length > 0 ? and(...conditions) : undefined;
      const where = combineWithSensitiveVisible(draftScopeCols, userCondition);

      const drafts = await db.select().from(emailDrafts)
        .where(where)
        .orderBy(desc(emailDrafts.createdAt));

      res.json({ drafts });
    } catch (err: any) {
      log.error(`GET /api/email/drafts error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/email/drafts", async (req: Request, res: Response) => {
    try {
      const { accountId, toAddress, subject, bodyHtml, bodyText, status } = req.body;
      if (!accountId || !toAddress || !subject) {
        return res.status(400).json({ error: "accountId, toAddress, and subject are required" });
      }

      const validStatuses = ['pending_review', 'approved_to_send', 'sent', 'send_failed', 'discarded'];
      const draftStatus = status && validStatuses.includes(status) ? status : 'pending_review';

      const result = await db.insert(emailDrafts).values({
        accountId,
        toAddress,
        subject,
        bodyHtml: bodyHtml || null,
        bodyText: bodyText || null,
        status: draftStatus,
        ...sensitiveOwnershipValues(),
      }).returning();

      res.status(201).json(result[0]);
    } catch (err: any) {
      log.error(`POST /api/email/drafts error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/email/drafts/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid draft ID" });

      const existing = await db.select().from(emailDrafts).where(combineWithSensitiveVisible(draftScopeCols, eq(emailDrafts.id, id))).limit(1);
      if (existing.length === 0) return res.status(404).json({ error: "Draft not found" });

      const updates: Record<string, any> = { updatedAt: sql`CURRENT_TIMESTAMP` };
      if (req.body.toAddress !== undefined) updates.toAddress = req.body.toAddress;
      if (req.body.subject !== undefined) updates.subject = req.body.subject;
      if (req.body.bodyHtml !== undefined) updates.bodyHtml = req.body.bodyHtml;
      if (req.body.bodyText !== undefined) updates.bodyText = req.body.bodyText;
      if (req.body.status !== undefined) {
        const validStatuses = ['pending_review', 'approved_to_send', 'sent', 'send_failed', 'discarded'];
        if (!validStatuses.includes(req.body.status)) {
          return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        }
        updates.status = req.body.status;
      }

      const result = await db.update(emailDrafts).set(updates).where(combineWithSensitiveWritable(draftScopeCols, eq(emailDrafts.id, id))).returning();
      res.json(result[0]);
    } catch (err: any) {
      log.error(`PATCH /api/email/drafts/:id error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/email/drafts/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid draft ID" });

      const deleted = await db.delete(emailDrafts).where(combineWithSensitiveWritable(draftScopeCols, eq(emailDrafts.id, id))).returning();
      if (deleted.length === 0) return res.status(404).json({ error: "Draft not found" });
      res.json({ deleted: true });
    } catch (err: any) {
      log.error(`DELETE /api/email/drafts/:id error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/email/triage-status", (_req: Request, res: Response) => {
    res.json({ ...triageJob });
  });

  app.get("/api/email/pipeline-status", async (_req: Request, res: Response) => {
    try {
      const { getEmailPipelineHealth } = await import("../email-sync");
      const [counts, syncHealth, lastEnrichment] = await Promise.all([
        storage.getEmailPipelineCounts(),
        getEmailPipelineHealth(),
        storage.getLastEmailEnrichment(),
      ]);

      res.json({
        status: syncHealth.status,
        stage: syncHealth.stage,
        currentError: syncHealth.currentError,
        triage: { ...triageJob },
        counts,
        lastSyncAt: syncHealth.lastGoodAt,
        lastTriageAt: triageJob.completedAt ? new Date(triageJob.completedAt).toISOString() : null,
        lastEnrichmentAt: lastEnrichment?.updatedAt ? new Date(lastEnrichment.updatedAt).toISOString() : null,
        syncAccounts: syncHealth.accounts.map(account => ({
          accountId: account.accountId,
          lastSuccess: account.lastGoodAt,
          lastError: account.currentError,
          healthy: account.healthy,
          stale: account.stale,
          orphaned: account.orphaned,
          status: account.status,
          stage: account.stage,
        })),
      });
    } catch (err: any) {
      log.error(`GET /api/email/pipeline-status error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/email/triage-run", async (_req: Request, res: Response) => {
    const { tryClaimSkillRun, releaseSkillRun } = await import("../autonomous-skill-runner");

    if (triageJob.status === "running" || !tryClaimSkillRun("triage")) {
      return res.status(409).json({ ...triageJob, error: "Triage is already running" });
    }

    triageJob.status = "running";
    triageJob.startedAt = Date.now();
    triageJob.completedAt = null;
    triageJob.error = null;

    res.json({ started: true });

    (async () => {
      try {
        const { runTriagePipeline } = await import("../triage-runner");
        const result = await runTriagePipeline();

        if (result.status === "succeeded") {
          log.log(`POST /api/email/triage-run: programmatic triage succeeded — passes=${result.passes} processed=${result.processed} triaged=${result.triaged} avg=${result.avgPerEmailMs}ms/email`);
          try {
            const { runEnrichment } = await import("../email-enrichment");
            runEnrichment().catch(err => {
              log.warn(`Post-triage enrichment failed: ${err.message}`);
            });
          } catch (enrichErr: any) {
            log.warn(`Failed to start post-triage enrichment: ${enrichErr.message}`);
          }
        } else {
          log.error(`POST /api/email/triage-run: programmatic triage failed — error=${result.error || "unknown"}`);
        }
      } catch (err: any) {
        triageJob.status = "error";
        triageJob.error = err.message;
        triageJob.completedAt = Date.now();
        log.error(`POST /api/email/triage-run error: ${err.message}`);
      } finally {
        releaseSkillRun("triage");
      }
    })();
  });

  app.post("/api/email/enrich", async (_req: Request, res: Response) => {
    try {
      const { runEnrichment } = await import("../email-enrichment");
      const result = await runEnrichment();
      res.json(result);
    } catch (err: any) {
      log.error(`POST /api/email/enrich error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/email/enrich-thread", async (req: Request, res: Response) => {
    try {
      const { threadId } = req.body;
      if (!threadId) {
        return res.status(400).json({ error: "threadId is required" });
      }
      const { runEnrichment } = await import("../email-enrichment");
      const result = await runEnrichment();
      res.json(result);
    } catch (err: any) {
      log.error(`POST /api/email/enrich-thread error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/email/enrichments", async (req: Request, res: Response) => {
    try {
      const threadIdsParam = req.query.threadIds as string | undefined;
      const accountId = req.query.accountId as string | undefined;
      if (!threadIdsParam) {
        return res.json({ enrichments: [] });
      }
      const threadIds = threadIdsParam.split(",").filter(Boolean);
      if (threadIds.length === 0) {
        return res.json({ enrichments: [] });
      }
      const { storage } = await import("../storage");
      const enrichments = await storage.getEnrichmentsByThreadIds(threadIds, accountId);
      res.json({ enrichments });
    } catch (err: any) {
      log.error(`GET /api/email/enrichments error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/email/history", async (req: Request, res: Response) => {
    try {
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
      const type = req.query.type as string | undefined;
      const { storage } = await import("../storage");
      const history = await storage.getEmailHistory({ startDate, endDate, type });
      res.json({ history });
    } catch (err: any) {
      log.error(`GET /api/email/history error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/email/history/record", async (req: Request, res: Response) => {
    try {
      const { messageId, providerThreadId, accountId, tier, sender, subject, reason, dismissedBy } = req.body;
      const { storage } = await import("../storage");
      const dismissal = await storage.recordEmailDismissal({
        messageId: messageId || null,
        providerThreadId: providerThreadId || null,
        accountId: accountId || null,
        tier: tier || null,
        sender: sender || null,
        subject: subject || null,
        reason: reason || null,
        dismissedBy: dismissedBy || "manual",
      });
      invalidateSimpleFeedCache(req.principal?.accountId || accountId || undefined);
      res.json(dismissal);
    } catch (err: any) {
      log.error(`POST /api/email/history/record error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/email/drafts/:id/send", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid draft ID" });

      const rows = await db.select().from(emailDrafts).where(combineWithSensitiveVisible(draftScopeCols, eq(emailDrafts.id, id))).limit(1);
      if (rows.length === 0) return res.status(404).json({ error: "Draft not found" });

      const draft = rows[0];
      if (draft.status !== 'approved_to_send') {
        return res.status(400).json({ error: `Draft must be in 'approved_to_send' status to send. Current: ${draft.status}` });
      }

      const { sendEmail } = await import("../gmail");
      const body = draft.bodyHtml || draft.bodyText || '';

      try {
        const result = await sendEmail(draft.toAddress, draft.subject, body, draft.accountId);
        await db.update(emailDrafts).set({
          status: 'sent',
          sentAt: sql`CURRENT_TIMESTAMP`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(combineWithSensitiveWritable(draftScopeCols, eq(emailDrafts.id, id)));

        res.json({ sent: true, gmailMessageId: result.id });
      } catch (sendErr: any) {
        await db.update(emailDrafts).set({
          status: 'send_failed',
          gmailError: sendErr.message,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(combineWithSensitiveWritable(draftScopeCols, eq(emailDrafts.id, id)));

        res.status(502).json({ sent: false, error: sendErr.message });
      }
    } catch (err: any) {
      log.error(`POST /api/email/drafts/:id/send error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });
}
