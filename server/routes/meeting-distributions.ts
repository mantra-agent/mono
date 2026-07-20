/**
 * Meeting recap distribution routes.
 *
 * GET /api/meetings/:sessionId/recap-distributions
 *   Returns per-attendee distribution rows for a session. Principal-scoped.
 *   Used by MeetingHeaderBar to render EmailDraftWidget chips per attendee draft.
 */
import { type Express } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { meetingRecapDistributions } from "@shared/schema";
import { combineWithVisibleScope } from "../scoped-storage";
import { requireAuth } from "../auth";
import { getPrincipal } from "../principal";
import { chatStorage } from "../integrations/chat/storage";
import { principalOwnsMeeting } from "../meeting/owner-principal";
import { finalizeMeetingSession } from "../meeting/recap";
import { distributeRecap } from "../meeting/distribution";
import { createLogger } from "../log";

const log = createLogger("MeetingDistributionRoutes");

const scopeColumns = {
  scope: meetingRecapDistributions.scope,
  ownerUserId: meetingRecapDistributions.ownerUserId,
  accountId: meetingRecapDistributions.accountId,
};

export function registerMeetingDistributionRoutes(app: Express): void {
  /**
   * POST /api/meetings/:sessionId/recap/retry
   *
   * Reclaims a failed recap through the same atomic finalization path used by
   * Recall end events. Ready/generating sessions are idempotent no-ops.
   */
  app.post(
    "/api/meetings/:sessionId/recap/retry",
    requireAuth,
    async (req, res) => {
      const principal = getPrincipal(req);
      if (!principal) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { sessionId } = req.params as { sessionId: string };
      if (!sessionId?.trim()) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      try {
        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          res.status(404).json({ error: "Meeting session not found" });
          return;
        }
        if (!principalOwnsMeeting(principal, session)) {
          res.status(404).json({ error: "Meeting session not found" });
          return;
        }

        const result = await finalizeMeetingSession(sessionId);
        if (result.outcome === "not_meeting") {
          res.status(404).json({ error: "Meeting session not found" });
          return;
        }
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to retry recap for session ${sessionId}: ${msg}`);
        res.status(500).json({ error: "Failed to retry recap" });
      }
    },
  );

  /**
   * GET /api/meetings/:sessionId/recap-distributions
   *
   * Returns the distribution records for the given session.
   * Principal-aware: only returns rows owned by the requesting user.
   */
  app.get(
    "/api/meetings/:sessionId/recap-distributions",
    requireAuth,
    async (req, res) => {
      const principal = getPrincipal(req);
      if (!principal) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { sessionId } = req.params as { sessionId: string };
      if (!sessionId?.trim()) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      try {
        const rows = await db
          .select({
            id: meetingRecapDistributions.id,
            attendeeEmail: meetingRecapDistributions.attendeeEmail,
            attendeeName: meetingRecapDistributions.attendeeName,
            draftId: meetingRecapDistributions.draftId,
            status: meetingRecapDistributions.status,
            sendMethod: meetingRecapDistributions.sendMethod,
            error: meetingRecapDistributions.error,
            isMantraUser: meetingRecapDistributions.isMantraUser,
          })
          .from(meetingRecapDistributions)
          .where(
            combineWithVisibleScope(
              principal,
              scopeColumns,
              eq(meetingRecapDistributions.sessionId, sessionId),
            ),
          )
          .orderBy(meetingRecapDistributions.createdAt);

        res.json({ distributions: rows });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to fetch recap distributions for session ${sessionId}: ${msg}`);
        res.status(500).json({ error: "Failed to fetch distributions" });
      }
    },
  );

  /**
   * POST /api/meetings/:sessionId/recap-distributions/ensure
   *
   * Ensure/retry recap distribution for a session.
   * If distribution failed (e.g., no Gmail connected), retrying may succeed
   * if the condition has changed (e.g., Gmail now connected).
   */
  app.post(
    "/api/meetings/:sessionId/recap-distributions/ensure",
    requireAuth,
    async (req, res) => {
      const principal = getPrincipal(req);
      if (!principal) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { sessionId } = req.params as { sessionId: string };
      if (!sessionId?.trim()) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      try {
        const session = await chatStorage.getSession(sessionId);
        if (!session || !principalOwnsMeeting(principal, session)) {
          res.status(404).json({ error: "Meeting session not found" });
          return;
        }
        const meeting = session.meeting!;
        const recap = meeting.recap;
        if (!recap || recap.status !== "ready") {
          res.status(409).json({ error: "Meeting recap is not ready" });
          return;
        }

        log.info(`Distribution retry requested for session ${sessionId}`);
        await distributeRecap(sessionId, meeting, recap, principal, { retryFailed: true });

        const updated = await chatStorage.getSession(sessionId);
        res.json({ recap: updated?.meeting?.recap ?? recap });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          `Failed to ensure recap distributions for session ${sessionId}: ${msg}`,
        );
        res.status(500).json({ error: "Failed to ensure distributions" });
      }
    },
  );
}
