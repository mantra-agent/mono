import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import { withNativeMeetingCreationLock } from "../meeting/locks";
import { meetingRecognitionCapabilities } from "../meeting/stt";
import { getPrincipal } from "../principal";
import {
  getMeetingCounts,
  getMeetingRecord,
  listCompletedMeetings,
  listMeetingsForPage,
  meetingRecordToSimpleFeedItem,
  type MeetingIndexFilter,
  type MeetingNotesFilter,
} from "../meetings/meeting-index";

const log = createLogger("MeetingsRoutes");
const MAX_IDEMPOTENCY_KEY_LENGTH = 120;

function nativeMeetingTitle(at = new Date()): string {
  return `Transcription · ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at)}`;
}

function optionalNotesFilter(notesFilter: unknown, legacyHasNotes: unknown): MeetingNotesFilter | undefined {
  if (notesFilter === "any" || notesFilter === "with_notes" || notesFilter === "without_notes") return notesFilter;
  if (legacyHasNotes === "true" || legacyHasNotes === true) return "with_notes";
  if (legacyHasNotes === "false" || legacyHasNotes === false) return "without_notes";
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function filterFromQuery(req: Request): MeetingIndexFilter {
  return {
    query: typeof req.query.query === "string" ? req.query.query : undefined,
    notesFilter: optionalNotesFilter(req.query.notesFilter, req.query.hasNotes),
    startAfter: typeof req.query.startAfter === "string" ? req.query.startAfter : undefined,
    startBefore: typeof req.query.startBefore === "string" ? req.query.startBefore : undefined,
    limit: optionalNumber(req.query.limit),
    offset: optionalNumber(req.query.offset),
  };
}

export function registerMeetingsRoutes(app: Express): void {
  app.post("/api/meetings/native", requireAuth, async (req: Request, res: Response) => {
    const principal = getPrincipal(req);
    if (!principal?.userId || !principal.accountId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const idempotencyKey = typeof req.body?.idempotencyKey === "string"
      ? req.body.idempotencyKey.trim()
      : "";
    if (!idempotencyKey || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      res.status(400).json({ error: "idempotencyKey is required" });
      return;
    }
    const capability = meetingRecognitionCapabilities().sharedRoom;
    if (!capability.available) {
      res.status(409).json({
        error: "Shared-room transcription is unavailable until Deepgram Nova-3 is configured.",
        code: "recognition_capability_unavailable",
      });
      return;
    }

    try {
      const result = await withNativeMeetingCreationLock(
        principal.userId,
        idempotencyKey,
        async () => {
          const existing = await chatStorage.findNativeMeetingSessionByIdempotencyKey(idempotencyKey);
          if (existing) return { outcome: "reused" as const, session: existing };
          const now = new Date();
          const title = nativeMeetingTitle(now);
          const sourceKey = "native:microphone";
          const session = await chatStorage.createMeetingSession(
            title,
            {
              title,
              platform: "native",
              transport: "native",
              participants: [],
              botStatus: "live",
              speakerPolicy: { mode: "shared_room" },
              audioSourcePolicies: {
                [sourceKey]: {
                  mode: "shared_room",
                  mutationId: `native:${idempotencyKey}`,
                  updatedAt: now.toISOString(),
                },
              },
              recognition: {
                mode: "shared_room",
                status: "waiting",
                reasonCode: "participant_audio_ready",
                detail: "Waiting for the shared microphone",
                streams: [],
              },
              sttProvider: capability.provider,
              sttModel: capability.model,
              sttSource: "native_microphone",
              sttFallback: false,
              sttStatus: "inactive",
              sttStatusDetail: "Waiting for the shared microphone",
              participationPolicy: "listen_only",
            },
            `meeting-native:${idempotencyKey}`,
          );
          return { outcome: "created" as const, session };
        },
      );
      log.info("native meeting session ready", {
        sessionId: result.session.id,
        outcome: result.outcome,
        ownerUserId: principal.userId,
      });
      res.status(result.outcome === "created" ? 201 : 200).json({
        ok: true,
        outcome: result.outcome,
        sessionId: result.session.id,
        sessionKey: result.session.sessionKey,
        sourceKey: "native:microphone",
      });
    } catch (error) {
      log.error("native meeting creation failed", {
        ownerUserId: principal.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Failed to start transcription" });
    }
  });

  app.get("/api/meetings/records/counts", async (_req: Request, res: Response) => {
    try {
      res.json(await getMeetingCounts());
    } catch (error) {
      log.error("Meeting counts failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Failed to load meeting counts" });
    }
  });

  app.get("/api/meetings/records/:id", async (req: Request, res: Response) => {
    try {
      const meeting = await getMeetingRecord(req.params.id);
      if (!meeting) return res.status(404).json({ error: "Meeting not found" });
      res.json({ meeting, item: meetingRecordToSimpleFeedItem(meeting) });
    } catch (error) {
      log.error("Meeting record failed", {
        meetingId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Failed to load meeting" });
    }
  });

  app.get("/api/meetings/records", async (req: Request, res: Response) => {
    try {
      const result = req.query.includeActive === "true"
        ? await listMeetingsForPage(filterFromQuery(req))
        : await listCompletedMeetings(filterFromQuery(req));
      res.json({
        meetings: result.meetings,
        items: result.meetings.map((meeting, index) => meetingRecordToSimpleFeedItem(meeting, "earlier", index)),
        total: result.total,
        counts: result.counts,
      });
    } catch (error) {
      log.error("Meeting records failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Failed to load meetings" });
    }
  });
}
