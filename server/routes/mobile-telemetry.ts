import type { Express, Request, Response } from "express";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../auth";
import { db } from "../db";
import { createLogger } from "../log";
import { getSecretSync } from "../secrets-store";
import { mobileStartupTelemetry } from "@shared/schema";

const log = createLogger("MobileTelemetryRoutes");

const MAX_RAW_BODY_BYTES = 32 * 1024;
const MAX_STACK_CHARS = 8_000;
const MAX_MESSAGE_CHARS = 1_000;
const MAX_TEXT_CHARS = 500;

const telemetryKindSchema = z.enum([
  "phase",
  "fatal_js_error",
  "unhandled_promise_rejection",
  "previous_launch_incomplete",
  "sentry_status",
]);

const startupPhaseSchema = z.enum([
  "process_start",
  "polyfills_start",
  "register_globals_start",
  "register_globals_done",
  "polyfills_done",
  "router_import_start",
  "app_mounted",
]);

const payloadSchema = z.object({}).passthrough().default({});

const telemetryWriteSchema = z.object({
  kind: telemetryKindSchema,
  phase: startupPhaseSchema.optional().nullable(),
  mobileSessionId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  platform: z.string().max(64).optional().nullable(),
  osVersion: z.string().max(128).optional().nullable(),
  deviceModel: z.string().max(256).optional().nullable(),
  appVersion: z.string().max(128).optional().nullable(),
  nativeBuildVersion: z.string().max(128).optional().nullable(),
  runtimeVersion: z.string().max(256).optional().nullable(),
  updateId: z.string().max(256).optional().nullable(),
  updateGroupId: z.string().max(256).optional().nullable(),
  bundleIdentifier: z.string().max(256).optional().nullable(),
  easBuildId: z.string().max(256).optional().nullable(),
  buildProfile: z.string().max(128).optional().nullable(),
  gitSha: z.string().max(128).optional().nullable(),
  sourceRef: z.string().max(256).optional().nullable(),
  isFatal: z.boolean().optional().default(false),
  errorName: z.string().max(MAX_TEXT_CHARS).optional().nullable(),
  errorMessage: z.string().max(MAX_MESSAGE_CHARS).optional().nullable(),
  errorStack: z.string().max(MAX_STACK_CHARS).optional().nullable(),
  payload: payloadSchema.optional().default({}),
  occurredAt: z.string().datetime().optional(),
});

function rawBodySize(req: Request): number {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(raw)) return raw.length;
  try {
    return Buffer.byteLength(JSON.stringify(req.body || {}), "utf8");
  } catch {
    return MAX_RAW_BODY_BYTES + 1;
  }
}

function truncateText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function boundedPayload(value: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(value || {});
  if (Buffer.byteLength(text, "utf8") <= 8_192) return value || {};
  return { truncated: true, originalBytes: Buffer.byteLength(text, "utf8") };
}

export function registerMobileTelemetryRoutes(app: Express) {
  app.post("/api/mobile/telemetry/startup", async (req: Request, res: Response) => {
    try {
      if (rawBodySize(req) > MAX_RAW_BODY_BYTES) {
        return res.status(413).json({ error: "Telemetry payload too large" });
      }

      const parsed = telemetryWriteSchema.safeParse(req.body);
      if (!parsed.success) {
        log.warn(`Rejected mobile telemetry payload: ${parsed.error.errors[0]?.message || "invalid"}`);
        return res.status(400).json({ error: "Invalid telemetry payload" });
      }

      const event = parsed.data;
      await db.insert(mobileStartupTelemetry).values({
        kind: event.kind,
        phase: event.phase || null,
        mobileSessionId: event.mobileSessionId,
        deviceId: event.deviceId,
        platform: truncateText(event.platform, 64),
        osVersion: truncateText(event.osVersion, 128),
        deviceModel: truncateText(event.deviceModel, 256),
        appVersion: truncateText(event.appVersion, 128),
        nativeBuildVersion: truncateText(event.nativeBuildVersion, 128),
        runtimeVersion: truncateText(event.runtimeVersion, 256),
        updateId: truncateText(event.updateId, 256),
        updateGroupId: truncateText(event.updateGroupId, 256),
        bundleIdentifier: truncateText(event.bundleIdentifier, 256),
        easBuildId: truncateText(event.easBuildId, 256),
        buildProfile: truncateText(event.buildProfile, 128),
        gitSha: truncateText(event.gitSha, 128),
        sourceRef: truncateText(event.sourceRef, 256),
        isFatal: Boolean(event.isFatal || event.kind === "fatal_js_error"),
        errorName: truncateText(event.errorName, MAX_TEXT_CHARS),
        errorMessage: truncateText(event.errorMessage, MAX_MESSAGE_CHARS),
        errorStack: truncateText(event.errorStack, MAX_STACK_CHARS),
        payload: boundedPayload(event.payload || {}),
        occurredAt: event.occurredAt ? new Date(event.occurredAt) : new Date(),
      });

      res.json({ ok: true });
    } catch (err: any) {
      log.error(`Failed to record mobile telemetry: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to record telemetry" });
    }
  });

  app.get("/api/mobile/telemetry/startup", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || 25) || 25));
      const events = await db
        .select()
        .from(mobileStartupTelemetry)
        .orderBy(desc(mobileStartupTelemetry.receivedAt))
        .limit(limit);

      const sentryDsn = getSecretSync("EXPO_PUBLIC_SENTRY_DSN") || getSecretSync("SENTRY_DSN");
      const sentryAuthToken = getSecretSync("SENTRY_AUTH_TOKEN");
      const sentryOrg = getSecretSync("SENTRY_ORG");
      const sentryProject = getSecretSync("SENTRY_PROJECT");
      const sentryConfigured = Boolean(sentryDsn && sentryAuthToken && sentryOrg && sentryProject);
      res.json({
        events,
        sentry: {
          active: sentryConfigured,
          missing: [
            ...(sentryDsn ? [] : ["EXPO_PUBLIC_SENTRY_DSN"]),
            ...(sentryAuthToken ? [] : ["SENTRY_AUTH_TOKEN"]),
            ...(sentryOrg ? [] : ["SENTRY_ORG"]),
            ...(sentryProject ? [] : ["SENTRY_PROJECT"]),
          ],
        },
      });
    } catch (err: any) {
      log.error(`Failed to read mobile telemetry: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to read telemetry" });
    }
  });
}
