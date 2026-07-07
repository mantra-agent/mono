import type { Express, Request, Response } from "express";
import { evaluateSurface } from "./cortex";
import { createLogger } from "../log";
import type { SurfaceDescriptor } from "@shared/models/glasses";
import crypto from "crypto";
import {
  ensureGlassesDeviceTokensTable,
  issueDeviceToken,
  resolveDeviceToken,
  getDefaultUser,
  revokeDeviceTokens,
  getUserDisplayName,
} from "./device-tokens";
import { registerExternalPresence, resolveAccountIdForUser } from "../client-presence";

const log = createLogger("GlassesRoutes");

const KEEPALIVE_INTERVAL_MS = 30_000;
const REEVALUATE_INTERVAL_MS = 60_000;

interface AuthenticatedSSEClient {
  res: Response;
  userId: string;
  surfaceEnabled: boolean;
}

interface GlassesToastPayload {
  title?: unknown;
  description?: unknown;
  variant?: unknown;
}

const sseClients = new Map<Response, AuthenticatedSSEClient>();
let lastDescriptorHash: string | null = null;
let evaluationTimer: ReturnType<typeof setInterval> | null = null;

function hashDescriptor(descriptor: SurfaceDescriptor): string {
  const content = JSON.stringify(descriptor.components);
  return crypto.createHash("md5").update(content).digest("hex");
}

function writeSseEvent(res: Response, event: string, payload: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function removeDeadClients(deadClients: Response[]): void {
  for (const dead of deadClients) {
    sseClients.delete(dead);
  }
}

function broadcastToClients(descriptor: SurfaceDescriptor): void {
  const deadClients: Response[] = [];

  for (const [res, client] of sseClients) {
    if (!client.surfaceEnabled) continue;
    try {
      writeSseEvent(res, "surface-update", descriptor);
    } catch {
      deadClients.push(res);
    }
  }

  removeDeadClients(deadClients);
}

function broadcastToastToUser(userId: string, payload: { title: string; description?: string; variant?: "default" | "destructive" }): number {
  const deadClients: Response[] = [];
  let delivered = 0;

  for (const [res, client] of sseClients) {
    if (client.userId !== userId) continue;
    try {
      writeSseEvent(res, "glasses-toast", payload);
      delivered += 1;
    } catch {
      deadClients.push(res);
    }
  }

  removeDeadClients(deadClients);
  return delivered;
}

function normalizeToastPayload(body: GlassesToastPayload): { title: string; description?: string; variant?: "default" | "destructive" } | null {
  if (!body || typeof body !== "object") return null;
  if (typeof body.title !== "string" || body.title.trim().length === 0) return null;
  const title = body.title.trim().slice(0, 160);
  const description = typeof body.description === "string" && body.description.trim().length > 0
    ? body.description.trim().slice(0, 240)
    : undefined;
  const variant = body.variant === "destructive" ? "destructive" : "default";
  return { title, description, variant };
}

async function evaluateAndBroadcast(): Promise<void> {
  try {
    if (![...sseClients.values()].some((client) => client.surfaceEnabled)) return;

    const descriptor = await evaluateSurface();
    const hash = hashDescriptor(descriptor);

    if (hash !== lastDescriptorHash) {
      lastDescriptorHash = hash;
      broadcastToClients(descriptor);
      log.log(`Surface updated, broadcast to ${sseClients.size} clients`);
    }
  } catch (err) {
    log.error(`Evaluation cycle failed: ${(err as Error).message}`);
  }
}

function ensureEvaluationLoop(): void {
  if (evaluationTimer) return;
  evaluationTimer = setInterval(evaluateAndBroadcast, REEVALUATE_INTERVAL_MS);
  log.log("Started Cortex evaluation loop");
}

function maybeStopEvaluationLoop(): void {
  if (sseClients.size === 0 && evaluationTimer) {
    clearInterval(evaluationTimer);
    evaluationTimer = null;
    log.log("Stopped Cortex evaluation loop (no clients)");
  }
}

/**
 * Resolve a user from the request.
 * Priority: device token (query/header) → session cookie.
 * Returns userId or null.
 */
type RequestUserResolution = {
  userId: string;
  source: "device-token" | "session";
};

async function resolveRequestUser(req: Request): Promise<string | null> {
  return (await resolveRequestUserWithSource(req))?.userId ?? null;
}

async function resolveRequestUserWithSource(req: Request): Promise<RequestUserResolution | null> {
  // 1. Device token via query param (for SSE/EventSource which can't set headers)
  const queryToken = req.query.dt as string | undefined;
  if (queryToken) {
    const userId = await resolveDeviceToken(queryToken);
    return userId ? { userId, source: "device-token" } : null;
  }

  // 2. Device token via Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const userId = await resolveDeviceToken(authHeader.slice(7));
    return userId ? { userId, source: "device-token" } : null;
  }

  // 3. Device token via X-Device-Token header
  const deviceToken = req.headers["x-device-token"] as string | undefined;
  if (deviceToken) {
    const userId = await resolveDeviceToken(deviceToken);
    return userId ? { userId, source: "device-token" } : null;
  }

  // 4. Session cookie (for in-app Zero page preview)
  if (req.session?.userId) {
    return { userId: req.session.userId, source: "session" };
  }

  return null;
}

export function registerGlassesRoutes(app: Express): void {
  // Bootstrap the device tokens table on registration
  ensureGlassesDeviceTokensTable().catch((err) => {
    log.error(`Failed to ensure device tokens table: ${(err as Error).message}`);
  });

  // ── GET /api/glasses/surface — current surface descriptor ──────
  // Requires a valid device token.
  app.get("/api/glasses/surface", async (req: Request, res: Response) => {
    try {
      const userId = await resolveRequestUser(req);
      if (!userId) {
        return res.status(401).json({ error: "Device not paired. Connect via /glasses to auto-pair." });
      }

      const debug = req.query.debug === "true";
      const descriptor = await evaluateSurface({ debug });
      res.json(descriptor);
    } catch (err) {
      log.error(`Surface endpoint error: ${(err as Error).message}`);
      res.status(500).json({ error: "Failed to evaluate surface" });
    }
  });

  // ── GET /api/glasses/events — SSE with auto-pairing ────────────
  // If token provided: authenticated stream.
  // If no token: auto-pair to the default user, push token via SSE.
  app.get("/api/glasses/events", async (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Try to resolve existing token
    let userResolution = await resolveRequestUserWithSource(req);
    let userId = userResolution?.userId ?? null;
    let shouldRegisterGlassesPresence = userResolution?.source === "device-token";

    const surfaceEnabled = req.query.surface !== "none";
    let displayName: string | null = null;

    if (!userId) {
      // Auto-pair: find the default user and issue a token
      log.log("Unpaired glasses SSE connection, attempting auto-pair...");
      const defaultUser = await getDefaultUser();

      if (!defaultUser) {
        writeSseEvent(res, "error", { error: "No users available for pairing" });
        res.end();
        return;
      }

      const token = await issueDeviceToken(defaultUser.id);
      userId = defaultUser.id;
      userResolution = { userId, source: "device-token" };
      shouldRegisterGlassesPresence = true;
      displayName = await getUserDisplayName(defaultUser.id);

      // Push the token to the glasses for localStorage persistence
      writeSseEvent(res, "paired", { token, userId: defaultUser.id, displayName });
      log.log(`Auto-paired glasses to user ${defaultUser.id}`);
    }

    displayName ??= await getUserDisplayName(userId);
    const accountId = await resolveAccountIdForUser(userId);
    const unregisterPresence = accountId && shouldRegisterGlassesPresence
      ? registerExternalPresence(accountId, "glasses")
      : null;
    writeSseEvent(res, "connected", { message: "Glasses SSE connected", paired: true, displayName });

    sseClients.set(res, { res, userId, surfaceEnabled });
    log.log(`SSE client connected (total: ${sseClients.size}, userId: ${userId}, accountId: ${accountId ?? "none"}, source: ${userResolution?.source ?? "unknown"}, presence: ${shouldRegisterGlassesPresence}, surface: ${surfaceEnabled})`);

    if (surfaceEnabled) {
      ensureEvaluationLoop();

      // Send initial surface immediately for full-surface clients.
      evaluateSurface()
        .then((descriptor) => {
          try {
            writeSseEvent(res, "surface-update", descriptor);
            lastDescriptorHash = hashDescriptor(descriptor);
          } catch {
            // Client may have disconnected
          }
        })
        .catch((err) => {
          log.warn(`Initial SSE evaluation failed: ${(err as Error).message}`);
        });
    }

    // Keepalive
    const keepalive = setInterval(() => {
      try {
        res.write(`:keepalive ${Date.now()}\n\n`);
      } catch {
        clearInterval(keepalive);
      }
    }, KEEPALIVE_INTERVAL_MS);

    req.on("close", () => {
      clearInterval(keepalive);
      unregisterPresence?.();
      sseClients.delete(res);
      log.log(`SSE client disconnected (remaining: ${sseClients.size})`);
      maybeStopEvaluationLoop();
    });
  });

  // ── POST /api/glasses/toast — relay app toasts to paired glasses ──────
  app.post("/api/glasses/toast", async (req: Request, res: Response) => {
    try {
      const userId = await resolveRequestUser(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const payload = normalizeToastPayload(req.body as GlassesToastPayload);
      if (!payload) {
        return res.status(400).json({ error: "Invalid toast payload" });
      }

      const delivered = broadcastToastToUser(userId, payload);
      res.json({ ok: true, delivered });
    } catch (err) {
      log.error(`Toast relay error: ${(err as Error).message}`);
      res.status(500).json({ error: "Toast relay failed" });
    }
  });

  // ── POST /api/glasses/unpair — revoke device token ─────────────
  app.post("/api/glasses/unpair", async (req: Request, res: Response) => {
    try {
      const userId = await resolveRequestUser(req);
      if (!userId) {
        return res.status(401).json({ error: "Not paired" });
      }
      await revokeDeviceTokens(userId);
      res.json({ ok: true, message: "Device unpaired" });
    } catch (err) {
      log.error(`Unpair error: ${(err as Error).message}`);
      res.status(500).json({ error: "Unpair failed" });
    }
  });

  log.log("Glasses routes registered");
}
