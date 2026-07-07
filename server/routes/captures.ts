// Use createLogger for logging ONLY
import type { Express } from "express";
import { z } from "zod";
import { db } from "../db";
import { captures, captureTypeEnum, captureStatusEnum } from "@shared/schema";
import { eq, desc, gte, and, sql } from "drizzle-orm";
import { eventBus } from "../event-bus";
import { createLogger } from "../log";

const log = createLogger("captures");

const createCaptureSchema = z.object({
  text: z.string().min(1).max(2000),
  typeHint: captureTypeEnum.optional(),
});

const reclassifySchema = z.object({
  type: captureTypeEnum,
  context: z.string().optional(),
});

export function registerCaptureRoutes(app: Express) {
  app.post("/api/captures", async (req, res) => {
    try {
      const body = createCaptureSchema.parse(req.body);
      const [capture] = await db.insert(captures).values({
        rawText: body.text,
        typeHint: body.typeHint || null,
        status: "pending",
        userId: "ray",
      }).returning();

      eventBus.publish({
        category: "system",
        event: "capture.created",
        payload: { captureId: capture.id },
      });

      res.status(201).json({
        id: capture.id,
        status: capture.status,
        createdAt: capture.createdAt,
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors });
      }
      log.error("POST error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/captures", async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const since = req.query.since as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

      const conditions = [];
      if (status) {
        const parsed = captureStatusEnum.safeParse(status);
        if (parsed.success) {
          conditions.push(eq(captures.status, parsed.data));
        }
      }
      if (since) {
        const sinceDate = new Date(since);
        if (!isNaN(sinceDate.getTime())) {
          conditions.push(gte(captures.createdAt, sinceDate));
        }
      }

      const where = conditions.length > 0
        ? conditions.length === 1 ? conditions[0] : and(...conditions)
        : undefined;

      const rows = await db.select().from(captures)
        .where(where)
        .orderBy(desc(captures.createdAt))
        .limit(limit);

      const [countResult] = await db.select({ count: sql<number>`count(*)` })
        .from(captures)
        .where(where);

      res.json({
        captures: rows,
        total: Number(countResult?.count || 0),
      });
    } catch (err: any) {
      log.error("GET error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/captures/:id/reclassify", async (req, res) => {
    try {
      const { id } = req.params;
      const body = reclassifySchema.parse(req.body);

      const [existing] = await db.select().from(captures).where(eq(captures.id, id));
      if (!existing) {
        return res.status(404).json({ error: "Capture not found" });
      }
      if (existing.status !== "manual" && existing.status !== "failed") {
        return res.status(400).json({ error: "Only manual or failed captures can be reclassified" });
      }

      const [updated] = await db.update(captures).set({
        classifiedType: body.type,
        status: "pending",
        errorMessage: null,
        processedAt: null,
      }).where(eq(captures.id, id)).returning();

      eventBus.publish({
        category: "system",
        event: "capture.created",
        payload: { captureId: id, reclassify: true, overrideType: body.type, context: body.context },
      });

      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors });
      }
      log.error("reclassify error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/captures/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const [existing] = await db.select().from(captures).where(eq(captures.id, id));
      if (!existing) {
        return res.status(404).json({ error: "Capture not found" });
      }
      if (existing.status !== "pending" && existing.status !== "manual") {
        return res.status(400).json({ error: "Only pending or manual captures can be deleted" });
      }

      await db.delete(captures).where(eq(captures.id, id));
      res.json({ success: true });
    } catch (err: any) {
      log.error("DELETE error:", err);
      res.status(500).json({ error: err.message });
    }
  });
}
