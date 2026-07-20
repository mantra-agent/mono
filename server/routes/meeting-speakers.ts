import type { Express } from "express";
import { requireAuth } from "../auth";
import { getPrincipal } from "../principal";
import { chatStorage } from "../integrations/chat/storage";
import { peopleStorage } from "../people-storage";
import { reconcileMeetingRecapParticipants } from "../meeting/recap";
import { createLogger } from "../log";

const log = createLogger("MeetingSpeakerRoutes");

export function registerMeetingSpeakerRoutes(app: Express): void {
  app.patch(
    "/api/meetings/:sessionId/speaker-person",
    requireAuth,
    async (req, res) => {
      const principal = getPrincipal(req);
      if (!principal) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { sessionId } = req.params as { sessionId: string };
      const body = req.body as { speakerKey?: unknown; personId?: unknown } | undefined;
      const speakerKey = typeof body?.speakerKey === "string" ? body.speakerKey.trim() : "";
      const hasPersonId = !!body && Object.prototype.hasOwnProperty.call(body, "personId");
      if (!sessionId?.trim()) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }
      if (!speakerKey || speakerKey.length > 500) {
        res.status(400).json({ error: "speakerKey must be a non-empty stable meeting speaker key" });
        return;
      }
      if (!hasPersonId || (body?.personId !== null && (typeof body?.personId !== "string" || !body.personId.trim()))) {
        res.status(400).json({ error: "personId must be a Person ID or explicit null to clear" });
        return;
      }

      try {
        const personId = typeof body?.personId === "string" ? body.personId.trim() : null;
        const person = personId ? await peopleStorage.getPerson(personId) : null;
        if (personId && !person) {
          res.status(404).json({ error: "Person not found" });
          return;
        }

        const result = await chatStorage.assignMeetingParticipantPerson(
          sessionId,
          speakerKey,
          person ? { id: person.id, name: person.name } : null,
        );
        if (result.outcome === "not_found" || result.outcome === "not_owned") {
          res.status(404).json({ error: "Anonymous meeting speaker not found" });
          return;
        }
        if (result.outcome === "not_anonymous_speaker") {
          res.status(409).json({ error: "Only anonymous diarized speakers can be assigned" });
          return;
        }

        if (result.session.meeting) {
          await reconcileMeetingRecapParticipants(
            result.session.meeting,
            result.participant,
            result.previousPersonId,
          );
        }
        log.info("meeting speaker assignment updated", {
          sessionId,
          speakerKey,
          personId: person?.id ?? null,
          outcome: result.outcome,
          principalUserId: principal.userId,
        });
        res.json({
          ok: true,
          outcome: result.outcome,
          participant: result.participant,
          meeting: result.session.meeting,
        });
      } catch (error) {
        log.error("meeting speaker assignment failed", {
          sessionId,
          speakerKey,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({
          error: "Speaker assignment may have saved, but meeting attribution did not fully refresh. Retry the assignment.",
        });
      }
    },
  );
}
