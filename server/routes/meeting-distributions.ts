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
import { createLogger } from "../log";

const log = createLogger("MeetingDistributionRoutes");

const scopeColumns = {
  scope: meetingRecapDistributions.scope,
  ownerUserId: meetingRecapDistributions.ownerUserId,
  accountId: meetingRecapDistributions.accountId,
};

export function registerMeetingDistributionRoutes(app: Express): void {
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
}
