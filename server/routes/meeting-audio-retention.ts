import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { createLogger } from "../log";
import { requirePermission } from "../permissions";
import {
  deleteMeetingAudioSample,
  exportMeetingAudioSample,
  getMeetingAudioEvaluation,
  queueMeetingAudioEvaluation,
} from "../meeting/audio-retention";

const log = createLogger("MeetingAudioRetentionRoutes");

const evaluationSchema = z.object({
  environmentId: z.number().int().positive(),
  bindingId: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(120),
}).strict();

function statusCode(error: unknown): number {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 0;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400;
}

export function registerMeetingAudioRetentionRoutes(app: Express): void {
  app.get("/api/meetings/audio-samples/:sampleId/export", requireAuth, async (req, res) => {
    try {
      await exportMeetingAudioSample(req.params.sampleId, res);
    } catch (error) {
      log.error("Meeting audio export failed", {
        sampleId: req.params.sampleId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      if (!res.headersSent) res.status(statusCode(error)).json({ error: error instanceof Error ? error.message : "Meeting audio export failed" });
    }
  });

  app.delete("/api/meetings/audio-samples/:sampleId", requireAuth, async (req, res) => {
    try {
      const deleted = await deleteMeetingAudioSample(req.params.sampleId, "owner");
      if (!deleted) return res.status(404).json({ error: "Retained audio not found" });
      res.json({ deleted: true });
    } catch (error) {
      log.error("Meeting audio deletion failed", {
        sampleId: req.params.sampleId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      res.status(statusCode(error)).json({ error: error instanceof Error ? error.message : "Meeting audio deletion failed" });
    }
  });

  app.post(
    "/api/meetings/audio-samples/:sampleId/evaluations",
    requireAuth,
    requirePermission("system:write"),
    async (req, res) => {
      try {
        const input = evaluationSchema.parse(req.body);
        const result = await queueMeetingAudioEvaluation({ sampleId: req.params.sampleId, ...input });
        res.status(result.status === "running" ? 202 : 200).json(result);
      } catch (error) {
        log.error("Meeting audio evaluation request failed", {
          sampleId: req.params.sampleId,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        res.status(statusCode(error)).json({ error: error instanceof Error ? error.message : "Meeting audio evaluation failed" });
      }
    },
  );

  app.get(
    "/api/meetings/audio-evaluations/:evaluationId",
    requireAuth,
    requirePermission("system:read"),
    async (req, res) => {
      try {
        const evaluation = await getMeetingAudioEvaluation(req.params.evaluationId);
        if (!evaluation) return res.status(404).json({ error: "Meeting audio evaluation not found" });
        res.json(evaluation);
      } catch (error) {
        log.error("Meeting audio evaluation read failed", {
          evaluationId: req.params.evaluationId,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        res.status(statusCode(error)).json({ error: error instanceof Error ? error.message : "Meeting audio evaluation read failed" });
      }
    },
  );
}
