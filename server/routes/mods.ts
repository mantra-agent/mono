// ─── ADMIN → Mods management surface (spec §7.1) ───────────────────────────
// The canonical self-service control plane for installing, enabling, disabling,
// reinstalling, and inspecting first-party Mods. Default-deny: requireAuth plus
// named `mods:read`/`mods:manage` permissions. The customer-facing catalog is a
// derived join of the code-owned Mod registry and the account's principal-scoped
// entitlement/installation state — never a second source of truth.

import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { requirePermission, principalHasPermission } from "../permissions";
import { createLogger } from "../log";
import { modRegistry } from "../mods/registry";
import {
  ModPlatformError,
  modLifecycleService,
} from "../mods/mod-lifecycle-service";
import { BASELINE_MOD_KEYS } from "../mods/mod-lifecycle-service";
import type { ModInstallationRow, ModKey } from "@shared/schema";

const log = createLogger("mods-route");

type ModCatalogStatus =
  | "enabled"
  | "available"
  | "installing"
  | "disabling"
  | "error";

interface ModCatalogEntry {
  key: ModKey;
  name: string;
  description: string;
  outcomeLabel: string;
  outcomePromise: string;
  version: string;
  status: ModCatalogStatus;
  resolvedVersion: string | null;
  failureCode: string | null;
  isBaseline: boolean;
  integrations: string[];
}

function statusFromInstallation(row: ModInstallationRow | undefined): ModCatalogStatus {
  if (!row) return "available";
  switch (row.status) {
    case "active":
      return "enabled";
    case "installing":
      return "installing";
    case "disabling":
      return "disabling";
    case "error":
      return "error";
    case "disabled":
    default:
      return "available";
  }
}

function handleError(res: Response, error: unknown): Response {
  if (error instanceof ModPlatformError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  log.error("mods route failed", { error: error instanceof Error ? error.message : String(error) });
  return res.status(500).json({ error: "Mods operation failed" });
}

function normalizeKeyParam(res: Response, raw: string): ModKey | null {
  const key = (raw ?? "").trim();
  if (!modRegistry.mods.some((mod) => mod.key === key)) {
    res.status(400).json({ error: `Unknown Mod: ${key || "(empty)"}` });
    return null;
  }
  return key as ModKey;
}

export function registerModsRoutes(app: Express): void {
  // Catalog: derived join of registry + account state. Ensures the baseline
  // (Planning + Network) is provisioned idempotently before projecting.
  app.get("/api/mods", requireAuth, requirePermission("mods:read"), async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal?.userId || !principal.accountId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      await modLifecycleService.ensureBaseline(principal);
      const { installations } = await modLifecycleService.listAccountState(principal);
      const byKey = new Map(installations.map((row) => [row.modKey, row]));
      const canManage = principalHasPermission(principal, "mods:manage");

      const mods: ModCatalogEntry[] = modRegistry.mods.map((mod) => {
        const installation = byKey.get(mod.key);
        return {
          key: mod.key,
          name: mod.name,
          description: mod.description,
          outcomeLabel: mod.outcome.label,
          outcomePromise: mod.outcome.promise,
          version: mod.version,
          status: statusFromInstallation(installation),
          resolvedVersion: installation?.resolvedVersion ?? null,
          failureCode: installation?.failureCode ?? null,
          isBaseline: (BASELINE_MOD_KEYS as readonly string[]).includes(mod.key),
          integrations: (mod.contributions.integrations ?? []).map((i) => i.connectorKey),
        };
      });

      return res.json({ mods, canManage });
    } catch (error) {
      return handleError(res, error);
    }
  });

  app.post("/api/mods/:key/install", requireAuth, requirePermission("mods:manage"), async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal?.userId || !principal.accountId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const key = normalizeKeyParam(res, req.params.key);
    if (!key) return res;
    try {
      const row = await modLifecycleService.installProductMod(principal, key);
      return res.json({ key, status: statusFromInstallation(row) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  // Reinstall reconciles retained state through the same idempotent install path.
  app.post("/api/mods/:key/reinstall", requireAuth, requirePermission("mods:manage"), async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal?.userId || !principal.accountId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const key = normalizeKeyParam(res, req.params.key);
    if (!key) return res;
    try {
      const row = await modLifecycleService.installProductMod(principal, key);
      return res.json({ key, status: statusFromInstallation(row) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  app.post("/api/mods/:key/disable", requireAuth, requirePermission("mods:manage"), async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal?.userId || !principal.accountId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const key = normalizeKeyParam(res, req.params.key);
    if (!key) return res;
    try {
      const row = await modLifecycleService.disable(principal, { modKey: key });
      return res.json({ key, status: statusFromInstallation(row) });
    } catch (error) {
      return handleError(res, error);
    }
  });
}
