import type { Express, Request, Response } from "express";
import { createLogger } from "../log";
import { emailDraftStorage } from "../email-draft-storage";
import { db } from "../db";
import { emailMessages } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { combineWithSensitiveVisible } from "../sensitive-scope";

const log = createLogger("EmailDraftRoutes");

export function registerEmailDraftRoutes(app: Express) {
  /**
   * POST /api/email-drafts/by-thread-ids
   * Body: { threadIds: string[] } → drafts linked to those Gmail threads,
   * scoped to the requesting principal. Used by the Comms Review tab.
   */
  app.post("/api/email-drafts/by-thread-ids", async (req: Request, res: Response) => {
    try {
      const principal = req.principal;
      if (!principal) return res.status(401).json({ error: "Not authenticated" });

      const raw = req.body?.threadIds;
      const threadIds = Array.isArray(raw)
        ? raw.filter((t: unknown): t is string => typeof t === "string" && t.length > 0).slice(0, 500)
        : [];
      const drafts = await emailDraftStorage.listByThreadIds(principal, threadIds);
      res.json({ drafts });
    } catch (err) {
      log.error(`POST /api/email-drafts/by-thread-ids failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to fetch linked drafts" });
    }
  });

  /**
   * GET /api/email-drafts/:id
   * Fetch a draft. If it has a threadId, include prior thread messages
   * from the local email cache for reply context display.
   */
  app.get("/api/email-drafts/:id", async (req: Request, res: Response) => {
    try {
      const principal = req.principal;
      if (!principal) return res.status(401).json({ error: "Not authenticated" });

      const draft = await emailDraftStorage.getById(principal, req.params.id);
      if (!draft) return res.status(404).json({ error: "Draft not found" });

      let threadMessages: Array<{
        id: number;
        providerMessageId: string;
        fromAddress: string | null;
        toAddresses: string | null;
        ccAddresses: string | null;
        subject: string | null;
        snippet: string | null;
        bodyText: string | null;
        bodyHtml: string | null;
        date: Date | null;
        direction: string | null;
      }> = [];

      // If this is a reply, fetch prior thread messages from local cache
      if (draft.threadId) {
        try {
          const messageScopeCols = {
            ownerUserId: emailMessages.ownerUserId,
            principalAccountId: emailMessages.principalAccountId,
          };
          threadMessages = await db
            .select({
              id: emailMessages.id,
              providerMessageId: emailMessages.providerMessageId,
              fromAddress: emailMessages.fromAddress,
              toAddresses: emailMessages.toAddresses,
              ccAddresses: emailMessages.ccAddresses,
              subject: emailMessages.subject,
              snippet: emailMessages.snippet,
              bodyText: emailMessages.bodyText,
              bodyHtml: emailMessages.bodyHtml,
              date: emailMessages.date,
              direction: emailMessages.direction,
            })
            .from(emailMessages)
            .where(
              combineWithSensitiveVisible(
                messageScopeCols,
                eq(emailMessages.providerThreadId, draft.threadId),
              ),
            )
            .orderBy(desc(emailMessages.date))
            .limit(20);
        } catch (err) {
          log.warn(`Failed to fetch thread messages for draft ${draft.id}: ${(err as Error).message}`);
          // Non-fatal: return draft without thread history
        }
      }

      res.json({ draft, threadMessages });
    } catch (err: any) {
      log.error(`GET /api/email-drafts/:id error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PATCH /api/email-drafts/:id
   * Edit a draft's fields while status === 'draft'.
   */
  app.patch("/api/email-drafts/:id", async (req: Request, res: Response) => {
    try {
      const principal = req.principal;
      if (!principal) return res.status(401).json({ error: "Not authenticated" });

      const { gmailAccountId, to, cc, bcc, subject, body } = req.body;
      const draft = await emailDraftStorage.update(principal, req.params.id, {
        gmailAccountId,
        to,
        cc,
        bcc,
        subject,
        body,
      });

      if (!draft) return res.status(404).json({ error: "Draft not found" });
      res.json({ draft });
    } catch (err: any) {
      if (err.message?.includes("Cannot edit draft")) {
        return res.status(400).json({ error: err.message });
      }
      log.error(`PATCH /api/email-drafts/:id error: ${err.message}`);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /**
   * POST /api/email-drafts/:id/send
   * Human-only: requires actorType === 'user'. Sends via Gmail API
   * using the draft record. Idempotent.
   */
  app.post("/api/email-drafts/:id/send", async (req: Request, res: Response) => {
    try {
      const principal = req.principal;
      if (!principal) return res.status(401).json({ error: "Not authenticated" });

      // INVARIANT: Only human users can send email
      if (principal.actorType !== "user") {
        return res.status(403).json({
          error: "Only authenticated users can send email. Service and system principals are not permitted.",
        });
      }

      const sent = await emailDraftStorage.send(
        principal,
        req.params.id,
        async (draft) => {
          const { sendEmailFromDraft } = await import("../gmail");
          const result = await sendEmailFromDraft(draft);
          return { messageId: result.id || "" };
        },
      );

      res.json({
        draft: sent,
        sent: true,
        messageId: sent.sentMessageId,
      });
    } catch (err: any) {
      log.error(`POST /api/email-drafts/:id/send error: ${err.message}`);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /**
   * POST /api/email-drafts/:id/discard
   * Mark a draft as discarded (terminal state).
   */
  app.post("/api/email-drafts/:id/discard", async (req: Request, res: Response) => {
    try {
      const principal = req.principal;
      if (!principal) return res.status(401).json({ error: "Not authenticated" });

      const draft = await emailDraftStorage.discard(principal, req.params.id);
      if (!draft) return res.status(404).json({ error: "Draft not found" });

      res.json({ draft });
    } catch (err: any) {
      log.error(`POST /api/email-drafts/:id/discard error: ${err.message}`);
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}
