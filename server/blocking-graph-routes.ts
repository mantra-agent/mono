import type { Express, Request, Response } from "express";
import { requireAuth } from "./auth";
import { blockingGraphService } from "./blocking-graph-service";
import { createLogger } from "./log";

const log = createLogger("BlockingGraphRoutes");

function statusOf(error: unknown, fallback = 500): number {
  if (typeof error === "object" && error && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isInteger(status) && status >= 400 && status < 600) return status;
  }
  return fallback;
}

function sendError(res: Response, error: unknown, label: string): void {
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (status >= 500) log.error(`${label}: ${message}`);
  else log.warn(`${label}: ${message}`);
  res.status(status).json({ error: message });
}

export function registerBlockingGraphRoutes(app: Express): void {
  app.get("/api/blocking-graph/blockers", requireAuth, async (req: Request, res: Response) => {
    try {
      const sourceAddress = typeof req.query.sourceAddress === "string" ? req.query.sourceAddress : "";
      const lifecycle = req.query.lifecycle === "retired" ? "retired" : "active";
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
      const page = await blockingGraphService.listBlockers({
        sourceAddress,
        lifecycle,
        cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json(page);
    } catch (error) {
      sendError(res, error, "list blockers");
    }
  });

  app.get("/api/blocking-graph/blocked-items", requireAuth, async (req: Request, res: Response) => {
    try {
      const targetAddress = typeof req.query.targetAddress === "string" ? req.query.targetAddress : "";
      const lifecycle = req.query.lifecycle === "retired" ? "retired" : "active";
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
      const page = await blockingGraphService.listBlockedItems({
        targetAddress,
        lifecycle,
        cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json(page);
    } catch (error) {
      sendError(res, error, "list blocked items");
    }
  });

  app.post("/api/blocking-graph/blocked-by", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const edge = await blockingGraphService.createBlockedBy({
        sourceAddress: String(body.sourceAddress ?? ""),
        targetAddress: String(body.targetAddress ?? ""),
        idempotencyKey: String(body.idempotencyKey ?? ""),
        ...(typeof body.provenanceAddress === "string" && body.provenanceAddress.trim()
          ? { provenanceAddress: body.provenanceAddress }
          : {}),
      });
      res.status(201).json(edge);
    } catch (error) {
      sendError(res, error, "create blocked_by");
    }
  });

  app.delete("/api/blocking-graph/blocked-by/:linkId", requireAuth, async (req: Request, res: Response) => {
    try {
      const sourceAddress = typeof req.query.sourceAddress === "string"
        ? req.query.sourceAddress
        : typeof req.body?.sourceAddress === "string"
          ? req.body.sourceAddress
          : "";
      const edge = await blockingGraphService.retireBlockedBy({
        sourceAddress,
        linkId: req.params.linkId,
      });
      res.json(edge);
    } catch (error) {
      sendError(res, error, "retire blocked_by");
    }
  });
}
