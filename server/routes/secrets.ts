import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../auth";
import { listSecretsMetadata, setSecret, clearSecret } from "../secrets-store";
import { isKnownSecretName, SECRET_NAMES } from "@shared/secrets-catalog";
import { createLogger } from "../log";
import { requireAdminPrivilegedMode } from "../sensitive-scope";

const log = createLogger("SecretsRoutes");

/**
 * Post-save side-effects keyed by secret name. Some credentials are
 * baked into external state at provision time (e.g. the V3 webhook
 * secret is sent inside each EL workspace tool's `request_headers`)
 * and therefore need a re-provision after rotation, otherwise EL
 * keeps sending the OLD secret on every tool call and our authorize()
 * 401s — exactly the prod bug from task-945.
 *
 * Returns a small JSON-friendly outcome the route surfaces to the
 * caller so the UI can show "EL agent re-provisioned" inline.
 */
async function applyPostSaveSideEffects(_name: string): Promise<Record<string, unknown>> {
  // v3 webhook secret re-provisioning removed — single engine, no v3 mode.
  return {};
}

const setSchema = z.object({
  name: z.string().refine(isKnownSecretName, { message: "Unknown secret name" }),
  value: z.string().min(1),
});

const nameOnlySchema = z.object({
  name: z.string().refine(isKnownSecretName, { message: "Unknown secret name" }),
});

export function registerSecretsRoutes(app: Express) {
  // Auth + admin required for all secrets routes
  app.use("/api/secrets", requireAuth, requireAdmin);

  // Metadata is read-only (labels + last-4 chars, no values) — no privileged mode needed
  app.get("/api/secrets/metadata", async (_req: Request, res: Response) => {
    try {
      const items = await listSecretsMetadata();
      res.json({ secrets: items, items, names: SECRET_NAMES });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to list secrets" });
    }
  });

  // Write operations require privileged mode
  const privileged = requireAdminPrivilegedMode("secrets");

  app.post("/api/secrets/set", privileged, async (req: Request, res: Response) => {
    try {
      const parsed = setSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const userId = req.session.userId || null;
      await setSecret(parsed.data.name, parsed.data.value, userId);
      log.log(`POST /api/secrets/set name=${parsed.data.name} actor=${userId}`);
      const sideEffects = await applyPostSaveSideEffects(parsed.data.name);
      res.json({ ok: true, ...sideEffects });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to set secret" });
    }
  });

  app.post("/api/secrets/rotate", privileged, async (req: Request, res: Response) => {
    try {
      const parsed = setSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const userId = req.session.userId || null;
      await setSecret(parsed.data.name, parsed.data.value, userId);
      log.log(`POST /api/secrets/rotate name=${parsed.data.name} actor=${userId}`);
      const sideEffects = await applyPostSaveSideEffects(parsed.data.name);
      res.json({ ok: true, ...sideEffects });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to rotate secret" });
    }
  });

  app.post("/api/secrets/clear", privileged, async (req: Request, res: Response) => {
    try {
      const parsed = nameOnlySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const userId = req.session.userId || null;
      const removed = await clearSecret(parsed.data.name, userId);
      log.log(`POST /api/secrets/clear name=${parsed.data.name} actor=${userId} removed=${removed}`);
      // Same side-effect path as set/rotate — clearing the V3 webhook
      // secret means EL must be re-PATCHed so its workspace tools no
      // longer send the old header (or fall back to the env value).
      const sideEffects = await applyPostSaveSideEffects(parsed.data.name);
      res.json({ ok: true, removed, ...sideEffects });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to clear secret" });
    }
  });
}
