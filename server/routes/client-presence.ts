import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { getPrincipal } from "../principal";
import { createLogger } from "../log";
import { isClientPresenceKind } from "@shared/client-presence";
import { getClientPresenceSnapshot, upsertHttpClientPresence } from "../client-presence";

const log = createLogger("ClientPresenceRoutes");

const heartbeatSchema = z.object({
  clientId: z.string().min(8).max(120),
  kind: z.custom<import("@shared/client-presence").ClientPresenceKind>(isClientPresenceKind, "invalid client kind"),
});

function identityForRequest(req: any): { accountId: string; userId: string } {
  const principal = getPrincipal(req);
  const accountId = principal?.accountId;
  const userId = principal?.userId;
  if (!accountId || !userId) throw Object.assign(new Error("Authentication required"), { status: 401 });
  return { accountId, userId };
}

export function registerClientPresenceRoutes(app: Express) {
  app.get("/api/client-presence", requireAuth, (req, res) => {
    try {
      const { accountId } = identityForRequest(req);
      res.json(getClientPresenceSnapshot(accountId));
    } catch (err) {
      const status = (err as any)?.status ?? 500;
      const message = err instanceof Error ? err.message : String(err);
      log.warn("GET /api/client-presence failed", { status, message });
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/client-presence/heartbeat", requireAuth, (req, res) => {
    try {
      const { accountId, userId } = identityForRequest(req);
      const parsed = heartbeatSchema.parse(req.body ?? {});
      const snapshot = upsertHttpClientPresence(accountId, userId, parsed.clientId, parsed.kind);
      res.json(snapshot);
    } catch (err) {
      const status = (err as any)?.status ?? (err instanceof z.ZodError ? 400 : 500);
      const message = err instanceof Error ? err.message : String(err);
      log.warn("POST /api/client-presence/heartbeat failed", { status, message });
      res.status(status).json({ error: message });
    }
  });
}
