/**
 * Meeting recap distribution routes.
 *
 * GET /api/meetings/:sessionId/recap-distributions
 *   Returns owner-scoped per-attendee distribution provenance. Email drafts
 *   render through canonical @email_draft references in the Session transcript.
 */
import { type Express, type Request } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { meetingRecapDistributions } from "@shared/schema";
import { combineWithVisibleScope } from "../scoped-storage";
import { requireAuth } from "../auth";
import { getPrincipal } from "../principal";
import { chatStorage } from "../integrations/chat/storage";
import { principalOwnsMeeting } from "../meeting/owner-principal";
import { finalizeMeetingSession } from "../meeting/recap";
import { distributeRecap, resolveOnboardingToken } from "../meeting/distribution";
import { createLogger } from "../log";
import type { RecipientRecapProjectionResponse } from "@shared/meeting-recipient-recap";
import {
  getAuthenticatedOnboardingRecapProjection,
  getRecipientRecapProjection,
} from "../meeting/recipient-projection";
import { normalizeEmailAddress } from "../email-normalization";
import { storage } from "../storage";

const LANDING_ROOT_URL = "https://www.trymantra.ai/";

type RecapEntryDecision =
  | { outcome: "landing"; location: string }
  | { outcome: "visualizer"; location: string }
  | { outcome: "login"; location: string }
  | { outcome: "recap"; location: string };

async function authenticatedEmail(req: Request): Promise<string | null> {
  if (!req.session.userId) return null;
  const user = await storage.getUser(req.session.userId);
  return user?.email ? normalizeEmailAddress(user.email) : null;
}

async function resolveRecapEntryDecision(
  req: Request,
  token: string,
): Promise<RecapEntryDecision> {
  const resolution = await resolveOnboardingToken(token);
  if (resolution.status === "not_found") {
    return { outcome: "landing", location: LANDING_ROOT_URL };
  }
  if (resolution.accountState === "provisional") {
    return {
      outcome: "visualizer",
      location: `${LANDING_ROOT_URL}?i=${encodeURIComponent(token)}`,
    };
  }

  const currentEmail = await authenticatedEmail(req);
  if (currentEmail !== normalizeEmailAddress(resolution.email)) {
    const fragment = new URLSearchParams({
      email: resolution.email,
      returnTo: `/r/${encodeURIComponent(token)}`,
    });
    return { outcome: "login", location: `/login#${fragment.toString()}` };
  }

  return {
    outcome: "recap",
    location: `/meeting-recap/${encodeURIComponent(token)}`,
  };
}

const log = createLogger("MeetingDistributionRoutes");

const scopeColumns = {
  scope: meetingRecapDistributions.scope,
  ownerUserId: meetingRecapDistributions.ownerUserId,
  accountId: meetingRecapDistributions.accountId,
};

export function registerMeetingDistributionRoutes(app: Express): void {
  /**
   * GET /r/:token
   *
   * Pure-read universal recap entry. The server owns the account/session switch
   * so scanners and clients cannot accidentally create, consume, or claim state.
   */
  app.get("/r/:token", async (req, res) => {
    try {
      const token = req.params.token?.trim() ?? "";
      const decision = await resolveRecapEntryDecision(req, token);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.redirect(302, decision.location);
    } catch (error) {
      log.error("Failed to resolve recap entry", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.redirect(302, LANDING_ROOT_URL);
    }
  });

  /**
   * GET /api/public/meeting-recaps/:token
   *
   * Resolve one opaque recipient capability into a data-minimized recap and
   * exact meeting-origin task grants. Invalid, expired, and revoked tokens are
   * deliberately indistinguishable.
   */
  app.get("/api/public/meeting-recaps/:token", async (req, res) => {
    try {
      const projection = await getRecipientRecapProjection(req.params.token ?? "");
      if (!projection) {
        res.status(404).json({ error: "Recap unavailable" });
        return;
      }
      const response: RecipientRecapProjectionResponse = { projection };
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.json(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to project recipient recap: ${msg}`);
      res.status(404).json({ error: "Recap unavailable" });
    }
  });

  /**
   * GET /api/meeting-recaps/onboarding/:token
   *
   * Matching real-account sessions may reuse the recipient recap view. The
   * onboarding capability never grants content without exact session-email
   * identity, and invalid/mismatched states remain indistinguishable.
   */
  app.get(
    "/api/meeting-recaps/onboarding/:token",
    requireAuth,
    async (req, res) => {
      try {
        const email = await authenticatedEmail(req);
        if (!email) {
          res.status(404).json({ error: "Recap unavailable" });
          return;
        }
        const projection = await getAuthenticatedOnboardingRecapProjection(
          req.params.token ?? "",
          email,
        );
        if (!projection) {
          res.status(404).json({ error: "Recap unavailable" });
          return;
        }
        const response: RecipientRecapProjectionResponse = { projection };
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.json(response);
      } catch (error) {
        log.error("Failed to project authenticated onboarding recap", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(404).json({ error: "Recap unavailable" });
      }
    },
  );

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
            accessExpiresAt: meetingRecapDistributions.accessExpiresAt,
            accessRevokedAt: meetingRecapDistributions.accessRevokedAt,
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
