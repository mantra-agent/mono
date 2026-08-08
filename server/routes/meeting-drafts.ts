import type { Express, Request, Response } from "express";
import { z } from "zod";
import { meetingDraftStorage } from "../meeting-draft-storage";
import { createLogger } from "../log";

const log = createLogger("MeetingDraftRoutes");
const patchSchema = z.object({
  googleAccountId: z.string().min(1).optional(),
  calendarId: z.string().min(1).optional(),
  summary: z.string().max(500).optional(),
  start: z.string().max(100).optional(),
  end: z.string().max(100).optional(),
  timeZone: z.string().max(100).optional(),
  attendees: z.array(z.string().email()).max(100).optional(),
  location: z.string().max(1000).optional(),
  description: z.string().max(10000).optional(),
  visibility: z.enum(["default", "public", "private", "confidential"]).optional(),
}).strict();

export function registerMeetingDraftRoutes(app: Express): void {
  app.get("/api/meeting-drafts/:id", async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: "Not authenticated" });
    const draft = await meetingDraftStorage.getById(principal, req.params.id);
    return draft ? res.json({ draft }) : res.status(404).json({ error: "Meeting draft not found" });
  });

  app.patch("/api/meeting-drafts/:id", async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: "Not authenticated" });
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid meeting draft" });
    const draft = await meetingDraftStorage.update(principal, req.params.id, parsed.data);
    return draft ? res.json({ draft }) : res.status(409).json({ error: "Meeting draft is no longer editable" });
  });

  app.post("/api/meeting-drafts/:id/schedule", async (req: Request, res: Response) => {
    try {
      const principal = req.principal;
      if (!principal) return res.status(401).json({ error: "Not authenticated" });
      const draft = await meetingDraftStorage.schedule(principal, req.params.id);
      return res.json({ draft });
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
      if (status >= 500) log.error("meeting draft schedule failed", error);
      return res.status(status).json({ error: error instanceof Error ? error.message : "Failed to schedule meeting" });
    }
  });

  app.post("/api/meeting-drafts/:id/discard", async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: "Not authenticated" });
    const draft = await meetingDraftStorage.discard(principal, req.params.id);
    return draft ? res.json({ draft }) : res.status(404).json({ error: "Meeting draft not found" });
  });
}
