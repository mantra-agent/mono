import type { Express, Request, Response } from "express";
import { randomUUID } from "crypto";
import { storageBackend } from "../object_storage/s3-backend";
import { vaultObjectKeyFromPrincipal } from "../object_storage/vault-keys";
import { setObjectAclPolicy } from "../object_storage/objectAcl";
import { requireAuth } from "../auth";
import { getPrincipal } from "../principal";
import { registerMediaItem } from "../media/media-storage";
import { z } from "zod";
import { createLogger } from "../log";

const log = createLogger("MobileDATDebugRoutes");
const MAX_COMMANDS = 100;
const MAX_RESULTS = 100;

const actionSchema = z.enum(["status", "preflight", "initialize", "listDevices", "requestCamera", "register", "connect", "capture"]);
const enqueueSchema = z.object({ action: actionSchema, params: z.record(z.any()).optional().default({}), note: z.string().max(500).optional().nullable() });
const pollSchema = z.object({ deviceId: z.string().max(128).optional().nullable(), sinceId: z.coerce.number().int().nonnegative().optional().default(0) });
const resultSchema = z.object({ status: z.enum(["ok", "error", "crashed", "skipped"]).optional().default("ok"), result: z.any().optional(), error: z.string().max(2000).optional().nullable(), deviceId: z.string().max(128).optional().nullable(), mobileTimestamp: z.string().datetime().optional().nullable() });
const uploadSchema = z.object({ base64: z.string().min(100).max(20_000_000), contentType: z.string().default("image/jpeg"), capturedAt: z.string().datetime().optional() });

export type MobileDATCommand = { id: number; action: z.infer<typeof actionSchema>; params: Record<string, unknown>; note: string | null; createdAt: string; consumedAt: string | null; consumedBy: string | null };
export type MobileDATResult = { id: number; commandId: number; action: string; status: string; result: unknown; error: string | null; deviceId: string | null; createdAt: string; mobileTimestamp: string | null };

let nextCommandId = 1;
let nextResultId = 1;
const commands: MobileDATCommand[] = [];
const results: MobileDATResult[] = [];

function trimQueues() {
  while (commands.length > MAX_COMMANDS) commands.shift();
  while (results.length > MAX_RESULTS) results.shift();
}


export function queueMobileDATDebugCommand(input: { action: z.infer<typeof actionSchema>; params?: Record<string, unknown>; note?: string | null }): MobileDATCommand {
  const parsed = enqueueSchema.parse(input);
  const command: MobileDATCommand = {
    id: nextCommandId++,
    action: parsed.action,
    params: parsed.params || {},
    note: parsed.note || null,
    createdAt: new Date().toISOString(),
    consumedAt: null,
    consumedBy: null,
  };
  commands.push(command);
  trimQueues();
  log.log("Queued mobile DAT debug command", { id: command.id, action: command.action });
  return command;
}

export function listMobileDATDebugState(limit = 50): { commands: MobileDATCommand[]; results: MobileDATResult[] } {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  return { commands: [...commands].reverse().slice(0, safeLimit), results: [...results].reverse().slice(0, safeLimit) };
}

export function getMobileDATDebugResult(commandId: number): MobileDATResult | null {
  return results.find((result) => result.commandId === commandId) || null;
}

export async function waitForMobileDATDebugResult(commandId: number, timeoutMs = 30000): Promise<MobileDATResult | null> {
  const deadline = Date.now() + Math.min(120000, Math.max(1000, timeoutMs));
  while (Date.now() < deadline) {
    const result = getMobileDATDebugResult(commandId);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

export function registerMobileDATDebugRoutes(app: Express) {
  app.post("/api/mobile/dat-debug/commands", (req: Request, res: Response) => {
    const parsed = enqueueSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid command" });
    const command = queueMobileDATDebugCommand(parsed.data);
    res.json({ command });
  });

  app.get("/api/mobile/dat-debug/commands", (req: Request, res: Response) => {
    const parsed = pollSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid poll" });
    const pending = commands.filter((command) => command.id > parsed.data.sinceId && !command.consumedAt).slice(0, 5);
    const now = new Date().toISOString();
    for (const command of pending) {
      command.consumedAt = now;
      command.consumedBy = parsed.data.deviceId || null;
    }
    res.json({ commands: pending, latestId: commands.at(-1)?.id ?? 0 });
  });

  app.post("/api/mobile/dat-debug/commands/:id/result", (req: Request, res: Response) => {
    const commandId = Number(req.params.id);
    if (!Number.isInteger(commandId) || commandId <= 0) return res.status(400).json({ error: "Invalid command id" });
    const command = commands.find((item) => item.id === commandId);
    if (!command) return res.status(404).json({ error: "Command not found" });
    const parsed = resultSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid result" });
    const entry: MobileDATResult = { id: nextResultId++, commandId, action: command.action, status: parsed.data.status, result: parsed.data.result ?? null, error: parsed.data.error || null, deviceId: parsed.data.deviceId || null, createdAt: new Date().toISOString(), mobileTimestamp: parsed.data.mobileTimestamp || null };
    results.push(entry);
    trimQueues();
    log.log("Recorded mobile DAT debug result", { commandId, action: command.action, status: entry.status });
    res.json({ result: entry });
  });

  app.get("/api/mobile/dat-debug/results", (_req: Request, res: Response) => {
    res.json(listMobileDATDebugState(50));
  });

  // ── DAT capture upload ─────────────────────────────────────────
  app.post('/api/mobile/dat-capture/upload', requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = uploadSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'Invalid upload' });
      const { base64, contentType, capturedAt } = parsed.data;
      const buffer = Buffer.from(base64, 'base64');
      const byteCount = buffer.length;
      if (byteCount < 100) return res.status(400).json({ error: 'Image too small' });
      if (byteCount > 15 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (15MB max)' });
      const principal = getPrincipal(req);
      if (!principal?.userId || !principal.accountId) return res.status(403).json({ error: "User principal required" });

      const ext = contentType === 'image/png' ? '.png' : '.jpg';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const objectId = `${timestamp}-${randomUUID().slice(0, 8)}`;
      const fileName = `glasses-capture-${objectId}${ext}`;
      const key = vaultObjectKeyFromPrincipal(principal, `users/${principal.userId}/uploads`, `${objectId}${ext}`);
      await storageBackend.putObject(key, buffer, { contentType });
      await setObjectAclPolicy(key, {
        owner: principal.userId,
        ownerUserId: principal.userId,
        accountId: principal.accountId,
        createdByUserId: principal.userId,
        scope: "user",
        visibility: "private",
      });

      const objectPath = `/objects/users/${principal.userId}/uploads/${objectId}${ext}`;
      const media = await registerMediaItem({
        name: fileName,
        mediaType: "image",
        source: "upload",
        objectPath,
        mimeType: contentType,
        fileSize: byteCount,
        width: null,
        height: null,
        duration: null,
        metadata: { source: "meta_dat_capture", capturedAt: capturedAt || null },
      }, principal);

      log.log(`[DAT Capture] uploaded ${byteCount} bytes → ${objectPath}`, { capturedAt, key, mediaId: media.id });
      res.json({ objectPath, mediaId: media.id, byteCount, capturedAt: capturedAt || new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      log.error(`[DAT Capture] upload failed: ${message}`);
      res.status(500).json({ error: message });
    }
  });

}
