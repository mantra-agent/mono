import type { Express } from "express";
import { z } from "zod";
import { createLogger } from "../log";
import {
  listContent,
  getContent,
  createContent,
  updateContent,
  deleteContent,
  batchApprove,
  getScheduledPostsInRange,
} from "../content-storage";
import {
  createContentCalendarEvent,
  deleteContentCalendarEvent,
  publishScheduledContent,
  suggestPostingTimes,
} from "../content-publisher";

const log = createLogger("ContentRoutes");

function routeError(error: unknown, operation: string): { message: string; operation: string } {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${operation} failed: ${message}`);
  return { message, operation };
}

const createContentSchema = z.object({
  platform: z.string().default("x"),
  content: z.string().min(1),
  threadParts: z.array(z.string()).nullable().optional(),
  status: z.string().default("draft"),
  scheduledAt: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

const updateContentSchema = z.object({
  content: z.string().min(1).optional(),
  threadParts: z.array(z.string()).nullable().optional(),
  status: z.string().optional(),
  scheduledAt: z.string().nullable().optional(),
  rejectReason: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

const batchApproveSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    scheduledAt: z.string(),
  })),
});

export function registerContentRoutes(app: Express) {
  app.get("/api/content", async (req, res) => {
    try {
      const { status, platform, limit, offset } = req.query;
      const rows = await listContent({
        status: status ? String(status) : undefined,
        platform: platform ? String(platform) : undefined,
        limit: limit ? parseInt(String(limit), 10) : undefined,
        offset: offset ? parseInt(String(offset), 10) : undefined,
      });
      res.json(rows);
    } catch (error) {
      const err = routeError(error, "list_content");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/content/suggestions", async (req, res) => {
    try {
      const count = parseInt(String(req.query.count || "7"), 10);
      const startDate = String(req.query.startDate || new Date().toISOString());
      const endDate = String(req.query.endDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());

      const existingPosts = await getScheduledPostsInRange(startDate, endDate);
      const existingTimes = existingPosts
        .filter((p) => p.scheduledAt)
        .map((p) => new Date(p.scheduledAt!));

      const times = suggestPostingTimes(count, startDate, endDate, existingTimes);
      res.json({ times });
    } catch (error) {
      const err = routeError(error, "suggest_times");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/content/:id", async (req, res) => {
    try {
      const post = await getContent(req.params.id);
      if (!post) return res.status(404).json({ error: "Post not found", operation: "get_content" });
      res.json(post);
    } catch (error) {
      const err = routeError(error, "get_content");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/content", async (req, res) => {
    try {
      const parsed = createContentSchema.parse(req.body);
      const post = await createContent({
        ...parsed,
        scheduledAt: parsed.scheduledAt ? new Date(parsed.scheduledAt) : undefined,
      } as any);
      res.status(201).json(post);
    } catch (error) {
      const err = routeError(error, "create_content");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.patch("/api/content/:id", async (req, res) => {
    try {
      const parsed = updateContentSchema.parse(req.body);
      const existing = await getContent(req.params.id);
      if (!existing) return res.status(404).json({ error: "Post not found", operation: "update_content" });

      const updates: any = { ...parsed };
      if (parsed.scheduledAt) {
        updates.scheduledAt = new Date(parsed.scheduledAt);
      } else if (parsed.scheduledAt === null) {
        updates.scheduledAt = null;
      }

      if (parsed.status === "rejected" && existing.calendarEventId) {
        await deleteContentCalendarEvent(existing);
        updates.calendarEventId = null;
      }

      if (parsed.status === "draft" && existing.status === "scheduled" && existing.calendarEventId) {
        await deleteContentCalendarEvent(existing);
        updates.calendarEventId = null;
      }

      const post = await updateContent(req.params.id, updates);
      if (!post) return res.status(404).json({ error: "Post not found", operation: "update_content" });
      res.json(post);
    } catch (error) {
      const err = routeError(error, "update_content");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/content/batch-approve", async (req, res) => {
    try {
      const parsed = batchApproveSchema.parse(req.body);
      const posts = await batchApprove(parsed.items);

      for (const post of posts) {
        try {
          const eventId = await createContentCalendarEvent(post);
          if (eventId) {
            await updateContent(post.id, { calendarEventId: eventId });
          }
        } catch (calErr) {
          log.warn(`Calendar event creation failed for post ${post.id}: ${calErr instanceof Error ? calErr.message : String(calErr)}`);
        }
      }

      res.json(posts);
    } catch (error) {
      const err = routeError(error, "batch_approve");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.delete("/api/content/:id", async (req, res) => {
    try {
      const existing = await getContent(req.params.id);
      if (existing?.calendarEventId) {
        await deleteContentCalendarEvent(existing);
      }
      const deleted = await deleteContent(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Post not found", operation: "delete_content" });
      res.json({ success: true });
    } catch (error) {
      const err = routeError(error, "delete_content");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/content/:id/publish", async (req, res) => {
    try {
      const post = await getContent(req.params.id);
      if (!post) return res.status(404).json({ error: "Post not found", operation: "manual_publish" });

      await updateContent(post.id, { status: "scheduled", scheduledAt: new Date() });
      await publishScheduledContent();

      const updated = await getContent(post.id);
      res.json(updated);
    } catch (error) {
      const err = routeError(error, "manual_publish");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });
}
