import type { Request, Response, NextFunction } from "express";
import { createLogger } from "./log";
const log = createLogger("maintenance");

interface MaintenanceState {
  active: boolean;
  reason: string;
  enteredAt: string;
  expiresAt: string;
  expiryTimer: NodeJS.Timeout | null;
}

const state: MaintenanceState = {
  active: false,
  reason: "",
  enteredAt: "",
  expiresAt: "",
  expiryTimer: null,
};

const DEFAULT_TTL_MS = 15 * 60 * 1000;

const ALLOWLIST = new Set<string>([
  "/api/health",
  "/api/brain/import",
  "/api/maintenance/enter",
  "/api/maintenance/exit",
  "/api/maintenance/exit-and-restart",
  "/api/maintenance/status",
]);

export function isInMaintenance(): boolean {
  return state.active;
}

export function getMaintenanceState() {
  return {
    active: state.active,
    reason: state.reason,
    enteredAt: state.enteredAt || null,
    expiresAt: state.expiresAt || null,
  };
}

export function enterMaintenance(reason: string, ttlMs: number = DEFAULT_TTL_MS): void {
  if (state.expiryTimer) clearTimeout(state.expiryTimer);
  state.active = true;
  state.reason = reason || "maintenance";
  state.enteredAt = new Date().toISOString();
  state.expiresAt = new Date(Date.now() + ttlMs).toISOString();
  state.expiryTimer = setTimeout(() => {
    if (state.active) {
      log.warn(`[Maintenance] auto-expiring after ${ttlMs}ms — original reason: ${state.reason}`);
      exitMaintenance();
    }
  }, ttlMs);
  // Don't keep the process alive solely for the expiry timer.
  state.expiryTimer.unref?.();
}

export function exitMaintenance(): void {
  if (state.expiryTimer) {
    clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
  }
  state.active = false;
  state.reason = "";
  state.enteredAt = "";
  state.expiresAt = "";
}

export function maintenanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!state.active) {
    next();
    return;
  }
  // Strip query string for the allowlist check.
  const path = req.path;
  if (ALLOWLIST.has(path)) {
    next();
    return;
  }
  // Non-API requests (e.g. Vite static assets in dev) pass through so the
  // browser can still load the page that's polling status.
  if (!path.startsWith("/api/")) {
    next();
    return;
  }
  res.status(503).json({
    error: "service in maintenance mode",
    reason: state.reason,
    expiresAt: state.expiresAt,
  });
}
