// Use createLogger for logging ONLY
import type { Express, Request, Response } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { extname } from "path";
import { readFile, unlink } from "fs/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { getPrincipal, type Principal } from "../principal";
import { visibleScopePredicate, writableScopePredicate } from "../scoped-storage";
import { setObjectAclPolicy } from "../object_storage/objectAcl";
import { storageBackend } from "../object_storage/s3-backend";
import { vaultObjectKeyFromPrincipal } from "../object_storage/vault-keys";
import {
  insertMagicDemoSessionEventSchema,
  insertMagicDemoSessionSchema,
  insertMagicDemoVisionFrameSchema,
  magicDemoSessionEvents,
  magicDemoSessions,
  magicDemoVisionFrames,
  updateMagicDemoSessionSchema,
  type MagicDemoSession,
} from "@shared/schema";

const log = createLogger("MagicDemoRoutes");

const frameUpload = multer({
  dest: "/tmp/magic-demo-frames/",
  limits: { fileSize: 20 * 1024 * 1024 },
});

const GLASSES_AGENT_ROUTE_PREFIXES = ["/api/magic-demo", "/api/glasses-agent"] as const;

function glassesAgentPaths(suffix: string): string[] {
  return GLASSES_AGENT_ROUTE_PREFIXES.map((prefix) => `${prefix}${suffix}`);
}


const sessionIdParamSchema = z.object({
  id: z.string().uuid(),
});

function requireUserPrincipal(req: Request): Principal & { userId: string; accountId: string } {
  const principal = getPrincipal(req);
  if (principal?.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw Object.assign(new Error("User principal required"), { status: 403 });
  }
  return principal as Principal & { userId: string; accountId: string };
}

function magicDemoSessionScope(principal: Principal) {
  return visibleScopePredicate(principal, {
    userId: magicDemoSessions.userId,
    ownerUserId: magicDemoSessions.ownerUserId,
    accountId: magicDemoSessions.accountId,
    scope: magicDemoSessions.scope,
  });
}

function magicDemoSessionWritableScope(principal: Principal) {
  return writableScopePredicate(principal, {
    userId: magicDemoSessions.userId,
    ownerUserId: magicDemoSessions.ownerUserId,
    accountId: magicDemoSessions.accountId,
  });
}

function routeError(error: unknown, operation: string): { message: string; operation: string } {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${operation} failed: ${message}`);
  return { message, operation };
}

function isCompletedStatus(status: MagicDemoSession["status"]): boolean {
  return status === "completed" || status === "failed" || status === "abandoned";
}


const imageContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function extensionForImage(contentType: string, originalName: string): string {
  const ext = extname(originalName).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return ext;
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  return "";
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function detectImageDimensions(buffer: Buffer): { width: number; height: number; format: string } | null {
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: "png" };
  }

  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunkType = buffer.toString("ascii", 12, 16);
    if (chunkType === "VP8X" && buffer.length >= 30) {
      return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1, format: "webp" };
    }
    if (chunkType === "VP8 " && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, format: "webp" };
    }
    if (chunkType === "VP8L" && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" };
    }
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) return null;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), format: "jpeg" };
      }
      offset += 2 + length;
    }
  }

  return null;
}

function parseFrameBody(body: Record<string, unknown>): Record<string, unknown> {
  const parsed = { ...body };
  if (typeof parsed.telemetry === "string" && parsed.telemetry.trim()) {
    try {
      parsed.telemetry = JSON.parse(parsed.telemetry);
    } catch {
      parsed.telemetry = { raw: parsed.telemetry };
    }
  }
  return parsed;
}


async function analyzeMagicDemoFrame(buffer: Buffer, contentType: string): Promise<{ text: string; latencyMs: number }> {
  const startedAt = Date.now();
  const { chatCompletion } = await import("../model-client");
  const { ACTIVITY_MEDIA } = await import("../job-profiles");
  const dataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
  const result = await chatCompletion({
    activity: ACTIVITY_MEDIA,
    model: "openai-subscription/gpt-5.4-mini-sub",
    overrideReason: "Magic Demo quick vision requires low-latency multimodal analysis",
    metadata: { source: "magic-demo", route: "vision.frame", activity: ACTIVITY_MEDIA },
    maxTokens: 700,
    messages: [{
      role: "user" as const,
      content: [
        { type: "image_url" as const, image_url: { url: dataUrl } },
        { type: "text" as const, text: "Ray is wearing Meta Display glasses and asked, 'What am I looking at?' Answer in one or two short spoken sentences. Name the salient objects, context, or useful next action. Do not mention that you are analyzing an image unless necessary." },
      ],
    }],
  });
  return { text: result.content.trim() || "I can see the scene, but I do not have a confident description yet.", latencyMs: Date.now() - startedAt };
}

async function synthesizeMagicDemoSpeech(text: string): Promise<{ audioBase64: string; contentType: string }> {
  const { textToSpeech } = await import("../integrations/audio/client");
  const buffer = await textToSpeech(text, "alloy", "mp3");
  return { audioBase64: buffer.toString("base64"), contentType: "audio/mpeg" };
}

function compactFrameResponse(frame: {
  id: string;
  source: string;
  width: number;
  height: number;
  format: string;
  captureMode: string;
  linkedUtteranceId: string | null;
  capturedAt: Date;
}): { ok: true; frame: { id: string; source: string; dimensions: string; format: string; captureMode: string; linkedUtteranceId: string | null; capturedAt: Date } } {
  return {
    ok: true,
    frame: {
      id: frame.id,
      source: frame.source,
      dimensions: `${frame.width}x${frame.height}`,
      format: frame.format,
      captureMode: frame.captureMode,
      linkedUtteranceId: frame.linkedUtteranceId,
      capturedAt: frame.capturedAt,
    },
  };
}

export function registerMagicDemoRoutes(app: Express): void {
  app.post(glassesAgentPaths("/sessions"), requireAuth, async (req: Request, res: Response) => {
    try {
      const principal = requireUserPrincipal(req);
      const parsed = insertMagicDemoSessionSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid Magic Demo session", details: parsed.error.flatten() });
      }

      const [session] = await db.insert(magicDemoSessions).values({
        ...parsed.data,
        userId: principal.userId,
        scope: "user",
        ownerUserId: principal.userId,
        accountId: principal.accountId,
        createdByUserId: principal.userId,
        updatedByUserId: principal.userId,
      }).returning();

      res.status(201).json({ session });
    } catch (error: unknown) {
      const err = routeError(error, "create_magic_demo_session");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get(glassesAgentPaths("/sessions/:id"), requireAuth, async (req: Request, res: Response) => {
    try {
      const params = sessionIdParamSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: "Invalid session id" });
      }

      const principal = requireUserPrincipal(req);
      const [session] = await db.select().from(magicDemoSessions).where(and(
        eq(magicDemoSessions.id, params.data.id),
        magicDemoSessionScope(principal),
      )).limit(1);

      if (!session) {
        return res.status(404).json({ error: "Magic Demo session not found" });
      }

      const events = await db.select().from(magicDemoSessionEvents).where(
        eq(magicDemoSessionEvents.sessionId, session.id),
      ).orderBy(desc(magicDemoSessionEvents.createdAt)).limit(200);

      const frames = await db.select().from(magicDemoVisionFrames).where(
        eq(magicDemoVisionFrames.sessionId, session.id),
      ).orderBy(desc(magicDemoVisionFrames.createdAt)).limit(50);

      res.json({ session, events, frames });
    } catch (error: unknown) {
      const err = routeError(error, "get_magic_demo_session");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.patch(glassesAgentPaths("/sessions/:id"), requireAuth, async (req: Request, res: Response) => {
    try {
      const params = sessionIdParamSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: "Invalid session id" });
      }

      const parsed = updateMagicDemoSessionSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid Magic Demo session update", details: parsed.error.flatten() });
      }

      const principal = requireUserPrincipal(req);
      const update = parsed.data;
      const endedAt = update.endedAt ?? (update.status && isCompletedStatus(update.status) ? new Date() : undefined);

      const [session] = await db.update(magicDemoSessions).set({
        ...update,
        endedAt,
        updatedByUserId: principal.userId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(and(
        eq(magicDemoSessions.id, params.data.id),
        magicDemoSessionWritableScope(principal),
      )).returning();

      if (!session) {
        return res.status(404).json({ error: "Magic Demo session not found" });
      }

      res.json({ session });
    } catch (error: unknown) {
      const err = routeError(error, "update_magic_demo_session");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });


  app.post(glassesAgentPaths("/sessions/:id/vision/frame"), requireAuth, (req: Request, res: Response) => {
    frameUpload.single("frame")(req, res, async (uploadError: unknown) => {
      const tmpPath = req.file?.path;
      try {
        if (uploadError) {
          const message = uploadError instanceof Error ? uploadError.message : "Frame upload failed";
          return res.status(400).json({ error: message });
        }

        const params = sessionIdParamSchema.safeParse(req.params);
        if (!params.success) {
          return res.status(400).json({ error: "Invalid session id" });
        }

        if (!req.file) {
          return res.status(400).json({ error: "No frame uploaded" });
        }

        const contentType = req.file.mimetype || "application/octet-stream";
        if (!imageContentTypes.has(contentType)) {
          return res.status(400).json({ error: "Unsupported frame format", supported: Array.from(imageContentTypes) });
        }

        const parsed = insertMagicDemoVisionFrameSchema.safeParse(parseFrameBody(req.body || {}));
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid Magic Demo vision frame", details: parsed.error.flatten() });
        }

        const principal = requireUserPrincipal(req);
        const [session] = await db.select({ id: magicDemoSessions.id, ownerUserId: magicDemoSessions.ownerUserId, accountId: magicDemoSessions.accountId }).from(magicDemoSessions).where(and(
          eq(magicDemoSessions.id, params.data.id),
          magicDemoSessionWritableScope(principal),
        )).limit(1);

        if (!session) {
          return res.status(404).json({ error: "Magic Demo session not found" });
        }

        const fileBuffer = await readFile(req.file.path);
        const detected = detectImageDimensions(fileBuffer);
        const width = parsed.data.width ?? detected?.width;
        const height = parsed.data.height ?? detected?.height;
        const format = parsed.data.format ?? detected?.format;

        if (!width || !height || !format) {
          return res.status(400).json({ error: "Could not determine frame dimensions or format" });
        }

        const suffix = extensionForImage(contentType, req.file.originalname);
        const objectId = randomUUID();
        const entityPath = `users/${principal.userId}/magic-demo/${params.data.id}/vision/${objectId}${suffix}`;
        const objectPath = `/objects/${entityPath}`;
        const key = vaultObjectKeyFromPrincipal(principal, `users/${principal.userId}/magic-demo/${params.data.id}/vision`, `${objectId}${suffix}`);

        await storageBackend.putObject(key, fileBuffer, { contentType });
        await setObjectAclPolicy(key, {
          owner: principal.userId,
          ownerUserId: principal.userId,
          accountId: principal.accountId,
          createdByUserId: principal.userId,
          scope: "user",
          visibility: "private",
          vaultId: principal.activeVaultId ?? undefined,
        });

        const capturedAt = parsed.data.capturedAt ?? new Date();
        const [frame] = await db.insert(magicDemoVisionFrames).values({
          sessionId: params.data.id,
          ownerUserId: principal.userId,
          accountId: principal.accountId,
          createdByUserId: principal.userId,
          source: parsed.data.source,
          objectPath,
          contentType,
          fileSize: req.file.size,
          width,
          height,
          format,
          captureMode: parsed.data.captureMode,
          linkedUtteranceId: parsed.data.linkedUtteranceId ?? null,
          capturedAt,
          telemetry: parsed.data.telemetry,
        }).returning();

        await db.insert(magicDemoSessionEvents).values({
          sessionId: params.data.id,
          ownerUserId: principal.userId,
          accountId: principal.accountId,
          createdByUserId: principal.userId,
          eventType: "vision",
          eventName: "frame_uploaded",
          visionLifecycle: "frame_uploaded",
          telemetry: {
            frameId: frame.id,
            source: frame.source,
            objectPath: frame.objectPath,
            contentType: frame.contentType,
            fileSize: frame.fileSize,
            width: frame.width,
            height: frame.height,
            format: frame.format,
            captureMode: frame.captureMode,
            linkedUtteranceId: frame.linkedUtteranceId,
          },
          occurredAt: capturedAt,
        });

        let answer: { text: string; latencyMs: number } | undefined;
        const shouldRespond = req.body.respond === "true" || req.body.respond === true;
        if (shouldRespond) {
          answer = await analyzeMagicDemoFrame(fileBuffer, contentType);
          const speech = await synthesizeMagicDemoSpeech(answer.text);
          await db.insert(magicDemoSessionEvents).values({
            sessionId: params.data.id,
            ownerUserId: principal.userId,
            accountId: principal.accountId,
            createdByUserId: principal.userId,
            eventType: "vision",
            eventName: "quick_vision_answer_generated",
            visionLifecycle: "answered",
            latencyMs: answer.latencyMs,
            telemetry: {
              frameId: frame.id,
              answerLength: answer.text.length,
              speechContentType: speech.contentType,
            },
            occurredAt: new Date(),
          });
        }

        const sessionUpdate: Partial<typeof magicDemoSessions.$inferInsert> & { telemetry?: unknown } = {
          updatedByUserId: principal.userId,
          updatedAt: sql`CURRENT_TIMESTAMP` as unknown as Date,
        };
        if (shouldRespond && answer) {
          sessionUpdate.telemetry = sql`${magicDemoSessions.telemetry} || ${JSON.stringify({ lastQuickVisionAnswer: answer.text, lastQuickVisionFrameId: frame.id })}::jsonb`;
        }
        await db.update(magicDemoSessions).set(sessionUpdate).where(and(eq(magicDemoSessions.id, params.data.id), magicDemoSessionWritableScope(principal)));

        res.status(201).json({ ...compactFrameResponse(frame), answer: answer ? { ...answer, speech } : undefined });
      } catch (error: unknown) {
        const err = routeError(error, "upload_magic_demo_vision_frame");
        res.status(500).json({ error: err.message, operation: err.operation });
      } finally {
        if (tmpPath) {
          await unlink(tmpPath).catch((cleanupError: unknown) => {
            const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            log.warn(`cleanup_magic_demo_frame_tmp failed: ${message}`);
          });
        }
      }
    });
  });

  app.post(glassesAgentPaths("/sessions/:id/events"), requireAuth, async (req: Request, res: Response) => {
    try {
      const params = sessionIdParamSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: "Invalid session id" });
      }

      const principal = requireUserPrincipal(req);
      const parsed = insertMagicDemoSessionEventSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid Magic Demo session event", details: parsed.error.flatten() });
      }

      const [session] = await db.select({ id: magicDemoSessions.id, ownerUserId: magicDemoSessions.ownerUserId, accountId: magicDemoSessions.accountId }).from(magicDemoSessions).where(and(
        eq(magicDemoSessions.id, params.data.id),
        magicDemoSessionWritableScope(principal),
      )).limit(1);

      if (!session) {
        return res.status(404).json({ error: "Magic Demo session not found" });
      }

      const [event] = await db.insert(magicDemoSessionEvents).values({
        ...parsed.data,
        sessionId: params.data.id,
        ownerUserId: principal.userId,
        accountId: principal.accountId,
        createdByUserId: principal.userId,
      }).returning();

      await db.update(magicDemoSessions).set({
        updatedByUserId: principal.userId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(and(eq(magicDemoSessions.id, params.data.id), magicDemoSessionWritableScope(principal)));

      res.status(201).json({ event });
    } catch (error: unknown) {
      const err = routeError(error, "append_magic_demo_session_event");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });
}
