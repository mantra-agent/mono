import type { Express } from "express";
import { requireAuth } from "../auth";
import { getPrincipal } from "../principal";
import { requestMeetingBotLeave } from "../meeting/leave";
import { requestMeetingBotReset } from "../meeting/reset";
import { createLogger } from "../log";

const log = createLogger("MeetingLifecycleRoutes");

export function registerMeetingLifecycleRoutes(app: Express): void {
  app.post("/api/meetings/:sessionId/leave", requireAuth, async (req, res) => {
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
      const result = await requestMeetingBotLeave(sessionId, principal);
      if (result.outcome === "not_found") {
        res.status(404).json({ error: "Meeting session not found" });
        return;
      }
      if (result.outcome === "not_leaveable") {
        res.status(409).json({
          error: "Meeting bot is no longer active",
          botStatus: result.session.meeting?.botStatus,
        });
        return;
      }
      if (result.outcome === "failed") {
        res.status(502).json({ error: `Failed to remove bot from call: ${result.error}` });
        return;
      }
      res.status(result.outcome === "requested" ? 202 : 200).json({
        ok: true,
        outcome: result.outcome,
        botStatus: result.session.meeting?.botStatus,
      });
    } catch (error) {
      log.error(
        `Failed to request meeting departure sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.status(500).json({ error: "Failed to request meeting departure" });
    }
  });

  app.post("/api/meetings/:sessionId/reset", requireAuth, async (req, res) => {
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
      const result = await requestMeetingBotReset(sessionId, principal);
      if (result.outcome === "not_found") {
        res.status(404).json({ error: "Meeting session not found" });
        return;
      }
      if (result.outcome === "not_recoverable") {
        res.status(409).json({ error: result.reason });
        return;
      }
      if (result.outcome === "failed") {
        res.status(502).json({ error: `Failed to reconnect the meeting bot: ${result.error}` });
        return;
      }
      res.status(result.outcome === "already_resetting" ? 200 : 202).json({
        ok: true,
        outcome: result.outcome,
        strategy: result.outcome === "already_resetting" ? undefined : result.strategy,
        botStatus: result.session.meeting?.botStatus,
      });
    } catch (error) {
      log.error(
        `Failed to reset meeting sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.status(500).json({ error: "Failed to reset meeting" });
    }
  });
}
