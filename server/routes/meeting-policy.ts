/**
 * Meeting participation policy route.
 *
 * PATCH /api/meetings/:sessionId/participation-policy
 *   Body: { participationPolicy: "auto" | "listen_only" }
 *   Owner-scoped toggle for Listen Mode. listen_only keeps transcription and
 *   recap generation active but the turn coordinator never generates or speaks
 *   agent responses for the session.
 */
import { type Express } from "express";
import { requireAuth } from "../auth";
import { getPrincipal } from "../principal";
import { chatStorage } from "../integrations/chat/storage";
import { principalOwnsMeeting } from "../meeting/owner-principal";
import { createLogger } from "../log";

const log = createLogger("MeetingPolicyRoutes");

const POLICIES = new Set(["auto", "listen_only"]);

export function registerMeetingPolicyRoutes(app: Express): void {
  app.patch(
    "/api/meetings/:sessionId/participation-policy",
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
      const participationPolicy = (req.body as { participationPolicy?: unknown })
        ?.participationPolicy;
      if (typeof participationPolicy !== "string" || !POLICIES.has(participationPolicy)) {
        res.status(400).json({ error: 'participationPolicy must be "auto" or "listen_only"' });
        return;
      }

      try {
        const session = await chatStorage.getSession(sessionId);
        if (!session || !principalOwnsMeeting(principal, session)) {
          res.status(404).json({ error: "Meeting session not found" });
          return;
        }
        const updated = await chatStorage.updateMeetingMeta(sessionId, {
          participationPolicy: participationPolicy as "auto" | "listen_only",
        });
        log.info(
          `participation policy updated sessionId=${sessionId} policy=${participationPolicy}`,
        );
        res.json({ ok: true, participationPolicy: updated?.meeting?.participationPolicy ?? participationPolicy });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to update participation policy for session ${sessionId}: ${msg}`);
        res.status(500).json({ error: "Failed to update participation policy" });
      }
    },
  );
}
