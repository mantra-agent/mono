import type { Express, Request, Response } from "express";
import { createLogger } from "../log";
import {
  getMeetingCounts,
  getMeetingRecord,
  listCompletedMeetings,
  meetingRecordToSimpleFeedItem,
  type MeetingIndexFilter,
  type MeetingNotesFilter,
} from "../meetings/meeting-index";

const log = createLogger("MeetingsRoutes");

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
      const result = await listCompletedMeetings(filterFromQuery(req));
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
