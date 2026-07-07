// Use createLogger for logging ONLY
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { createLogger } from "../log";
import { requireAuth, requireAdmin } from "../auth";
import { getDiagDump, recordClientWedge } from "../wedge-watchdog";
import { requireAdminPrivilegedMode } from "../sensitive-scope";
import { buildMultiUserDiagnosticsReport } from "../multiuser-diagnostics";

const log = createLogger("Diag");

// Hard cap on user-controlled field lengths so a misbehaving client can't
// fill the rattle log or the in-memory ring buffer with multi-MB strings.
const clientWedgeSchema = z.object({
  delayMs: z.number().int().min(0).max(10 * 60 * 1000),
  level: z.enum(["warn", "error"]),
  sessionKey: z.string().max(200).optional(),
  sessionId: z.string().max(100).optional(),
  wsReady: z.number().int().min(-1).max(10).optional(),
  wsAlive: z.boolean().optional(),
  message: z.string().max(500).optional(),
  // Correlation fields populated by the client watchdog so we can match the
  // client-side stall to a specific server-side run / event / tool call.
  runId: z.string().max(100).optional(),
  lastEventId: z.string().max(100).optional(),
  lastEventAgeMs: z.number().int().min(0).max(60 * 60 * 1000).optional(),
  lastToolCallId: z.string().max(100).optional(),
  lastToolCallAgeMs: z.number().int().min(0).max(60 * 60 * 1000).optional(),
  watchdogStage: z.string().max(40).optional(),
  userAgent: z.string().max(300).optional(),
});

export function registerDiagRoutes(app: Express): void {
  // GET /api/diag/inflight — sensitive operational dump (in-flight sessions,
  // run/tool metadata, log paths). Admin-only.
  app.get(
    "/api/diag/inflight",
    requireAuth,
    requireAdmin,
    (_req: Request, res: Response) => {
      try {
        res.json(getDiagDump());
      } catch (err: any) {
        log.error("inflight dump failed:", err?.message || err);
        res.status(500).json({ error: err?.message || "inflight dump failed" });
      }
    }
  );


  // GET /api/diag/multiuser-safety — admin-only migration and access-control
  // diagnostics for protected multi-user data. Requires privileged mode because
  // it exposes row-count and key metadata from private domains.
  app.get(
    "/api/diag/multiuser-safety",
    requireAuth,
    requireAdmin,
    requireAdminPrivilegedMode("diag:multiuser-safety"),
    async (_req: Request, res: Response) => {
      try {
        res.json(await buildMultiUserDiagnosticsReport());
      } catch (err: any) {
        log.error("multiuser safety diagnostics failed:", err?.message || err);
        res.status(500).json({ error: err?.message || "multiuser safety diagnostics failed" });
      }
    }
  );

  // POST /api/diag/client-wedge — receives client-side subscribe-watchdog
  // checkpoint reports posted via navigator.sendBeacon. The dashboard is a
  // logged-in single-user app, so we require auth (sendBeacon to a
  // same-origin endpoint includes the session cookie).
  app.post(
    "/api/diag/client-wedge",
    requireAuth,
    (req: Request, res: Response) => {
      try {
        const parsed = clientWedgeSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: parsed.error.errors[0]?.message || "invalid body" });
        }
        const r = parsed.data;
        recordClientWedge({
          receivedAt: Date.now(),
          delayMs: r.delayMs,
          level: r.level,
          sessionKey: r.sessionKey,
          sessionId: r.sessionId,
          wsReady: r.wsReady,
          wsAlive: r.wsAlive,
          message: r.message,
          runId: r.runId,
          lastEventId: r.lastEventId,
          lastEventAgeMs: r.lastEventAgeMs,
          lastToolCallId: r.lastToolCallId,
          lastToolCallAgeMs: r.lastToolCallAgeMs,
          watchdogStage: r.watchdogStage,
          userAgent: r.userAgent,
        });
        log.warn(
          `client-wedge ${r.level} stage=${r.watchdogStage || "-"} delayMs=${r.delayMs} ` +
            `sessionKey=${r.sessionKey || "-"} sessionId=${r.sessionId || "-"} ` +
            `runId=${r.runId || "-"} lastEventAgeMs=${r.lastEventAgeMs ?? "-"} ` +
            `lastToolCallAgeMs=${r.lastToolCallAgeMs ?? "-"}`
        );
        res.json({ ok: true });
      } catch (err: any) {
        res.status(500).json({ error: err?.message || "client-wedge failed" });
      }
    }
  );
}
