import type { Express } from "express";
import { requireAuth } from "../auth";
import { eventBus } from "../event-bus";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import { getPrincipal } from "../principal";
import type { MeetingAudioSourceMode } from "@shared/models/chat";

const log = createLogger("MeetingAudioSourceRoutes");
const MODES = new Set<MeetingAudioSourceMode>(["participant_streams", "shared_room"]);
const MAX_SOURCE_KEY_LENGTH = 500;
const MAX_MUTATION_ID_LENGTH = 200;

export function registerMeetingAudioSourceRoutes(app: Express): void {
  app.patch(
    "/api/meetings/:sessionId/audio-source-policy",
    requireAuth,
    async (req, res) => {
      const principal = getPrincipal(req);
      if (!principal?.userId || !principal.accountId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const { sessionId } = req.params as { sessionId: string };
      const body = req.body as { sourceKey?: unknown; mode?: unknown; mutationId?: unknown } | undefined;
      const sourceKey = typeof body?.sourceKey === "string" ? body.sourceKey.trim() : "";
      const mutationId = typeof body?.mutationId === "string" ? body.mutationId.trim() : "";
      const mode = body?.mode;
      if (!sessionId?.trim()) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }
      if (!sourceKey || sourceKey.length > MAX_SOURCE_KEY_LENGTH) {
        res.status(400).json({ error: "sourceKey must be a stable active meeting audio-source key" });
        return;
      }
      if (!mutationId || mutationId.length > MAX_MUTATION_ID_LENGTH) {
        res.status(400).json({ error: "mutationId is required" });
        return;
      }
      if (typeof mode !== "string" || !MODES.has(mode as MeetingAudioSourceMode)) {
        res.status(400).json({ error: 'mode must be "participant_streams" or "shared_room"' });
        return;
      }

      try {
        const result = await chatStorage.setMeetingAudioSourcePolicy(
          sessionId,
          sourceKey,
          mode as MeetingAudioSourceMode,
          mutationId,
        );
        if (result.outcome === "not_found" || result.outcome === "not_owned") {
          res.status(404).json({ error: "Meeting audio source not found" });
          return;
        }
        if (result.outcome === "not_active") {
          res.status(409).json({ error: "Meeting audio sources can only change while the meeting is live" });
          return;
        }
        if (result.outcome === "excluded") {
          res.status(409).json({ error: "Mantra and bot output sources cannot use speaker recognition" });
          return;
        }
        if (result.outcome === "updated") {
          eventBus.publish({
            category: "voice",
            event: "meeting.audio_source_policy.updated",
            payload: { sessionId, sourceKey, mode, mutationId },
            audience: { scope: "user", ownerUserId: principal.userId, accountId: principal.accountId },
          });
        }
        log.info("meeting audio source policy persisted", {
          sessionId,
          sourceKey,
          mode,
          mutationId,
          outcome: result.outcome,
          principalUserId: principal.userId,
        });
        res.json({
          ok: true,
          outcome: result.outcome,
          meeting: result.session.meeting,
        });
      } catch (error) {
        log.error("meeting audio source policy update failed", {
          sessionId,
          sourceKey,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Failed to update meeting audio source policy" });
      }
    },
  );
}
