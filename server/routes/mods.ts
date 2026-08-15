// ─── ADMIN → Mods management surface (spec §7.1) ───────────────────────────
// The canonical self-service control plane for installing, enabling, disabling,
// reinstalling, and inspecting first-party Mods. Default-deny: requireAuth plus
// named `mods:read`/`mods:manage` permissions. The customer-facing catalog is a
// derived join of the code-owned Mod registry and the account's principal-scoped
// entitlement/installation state — never a second source of truth.

import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { requireAuth } from "../auth";
import { requirePermission, principalHasPermission } from "../permissions";
import { createLogger } from "../log";
import { eventBus } from "../event-bus";
import { modRegistry } from "../mods/registry";
import {
  ModPlatformError,
  modLifecycleService,
} from "../mods/mod-lifecycle-service";
import { BASELINE_MOD_KEYS } from "../mods/mod-lifecycle-service";
import { accounts, users, type ModInstallationRow, type ModKey } from "@shared/schema";
import { createUserPrincipalFromUser, getPrincipal, recordPrivilegedAccess, type Principal } from "../principal";
import { db } from "../db";

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

function publishCompositionChanged(principal: Principal, modKey: ModKey, action: "install" | "reinstall" | "disable"): void {
  eventBus.publish({
    category: "system",
    event: "data:product_composition_changed",
    payload: { modKey, action },
  }, principal);
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

async function targetAccountPrincipal(req: Request, accountId: string, write: boolean): Promise<Principal> {
  const operator = getPrincipal(req);
  const required = write ? "users:write" : "users:read";
  if (!operator || !principalHasPermission(operator, required)) {
    throw new ModPlatformError("account_admin_required", "Account administration required", 403);
  }
  const [account] = await db.select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
    .from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) throw new ModPlatformError("account_not_found", "Account not found", 404);
  if (!account.ownerUserId) throw new ModPlatformError("account_owner_required", "Account owner required", 400);
  const [owner] = await db.select().from(users).where(eq(users.id, account.ownerUserId)).limit(1);
  if (!owner) throw new ModPlatformError("account_owner_not_found", "Account owner not found", 404);
  const principal = createUserPrincipalFromUser(owner, account.id);
  principal.permissions = write ? ["mods:read", "mods:manage"] : ["mods:read"];
  return principal;
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

  app.get("/api/admin/accounts/:accountId/mods", requireAuth, requirePermission("users:read"), async (req, res) => {
    try {
      const principal = await targetAccountPrincipal(req, req.params.accountId, false);
      await modLifecycleService.ensureBaseline(principal);
      const { installations } = await modLifecycleService.listAccountState(principal);
      const byKey = new Map(installations.map((row) => [row.modKey, row]));
      return res.json({
        mods: modRegistry.mods.map((mod) => ({ key: mod.key, name: mod.name, status: statusFromInstallation(byKey.get(mod.key)) })),
        canManage: principalHasPermission(getPrincipal(req)!, "users:write"),
      });
    } catch (error) {
      return handleError(res, error);
    }
  });

  app.post("/api/admin/accounts/:accountId/mods/:key/:action", requireAuth, requirePermission("users:write"), async (req, res) => {
    try {
      const operator = getPrincipal(req);
      const principal = await targetAccountPrincipal(req, req.params.accountId, true);
      const key = normalizeKeyParam(res, req.params.key);
      if (!key) return res;
      const action = req.params.action;
      const row = action === "disable"
        ? await modLifecycleService.disable(principal, { modKey: key })
        : action === "install"
          ? await modLifecycleService.installProductMod(principal, key)
          : null;
      if (!row) return res.status(400).json({ error: "Unknown Mod action" });
      publishCompositionChanged(principal, key, action as "install" | "disable");
      await recordPrivilegedAccess({ principal: operator!, action: `account_mod_${action}`, reason: "admin account Mod lifecycle", metadata: { accountId: req.params.accountId, modKey: key } });
      return res.json({ key, status: statusFromInstallation(row) });
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
      publishCompositionChanged(principal, key, "install");
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
      publishCompositionChanged(principal, key, "reinstall");
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
      publishCompositionChanged(principal, key, "disable");
      return res.json({ key, status: statusFromInstallation(row) });
    } catch (error) {
      return handleError(res, error);
    }
  });
}
