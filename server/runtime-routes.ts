import type { Express, Request, Response } from "express";
import { runtimeRunPhases, type RuntimeRunPhase } from "@shared/models/runtime";
import { requireAuth } from "./auth";
import { createLogger } from "./log";
import { requirePermission } from "./permissions";
import { getCurrentPrincipal } from "./principal-context";
import {
  getRuntimeRunDiagnostics,
  listRuntimeRunDiagnostics,
  type RuntimeDiagnosticsFilters,
} from "./runtime/runtime-storage";

const log = createLogger("RuntimeRoutes");

function optionalQueryString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw Object.assign(new Error("limit must be an integer from 1 to 50"), { status: 400 });
  }
  return parsed;
}

function parsePhase(value: unknown): RuntimeRunPhase | undefined {
  const phase = optionalQueryString(value);
  if (!phase) return undefined;
  if (!(runtimeRunPhases as readonly string[]).includes(phase)) {
    throw Object.assign(new Error("phase is invalid"), { status: 400 });
  }
  return phase as RuntimeRunPhase;
}

function diagnosticsFilters(req: Request): RuntimeDiagnosticsFilters {
  return {
    limit: parseLimit(req.query.limit),
    kind: optionalQueryString(req.query.kind),
    handlerKey: optionalQueryString(req.query.handlerKey),
    sourceType: optionalQueryString(req.query.sourceType),
    sourceId: optionalQueryString(req.query.sourceId),
    phase: parsePhase(req.query.phase),
  };
}

function respondError(res: Response, error: unknown): Response {
  const status = Number((error as { status?: number }).status) || 500;
  const details = {
    errorName: error instanceof Error ? error.name : typeof error,
    status,
  };
  if (status >= 500) log.error("Runtime diagnostics read failed", details);
  else log.warn("Runtime diagnostics request rejected", details);
  return res.status(status).json({
    error: status < 500 && error instanceof Error ? error.message : "Runtime diagnostics read failed",
  });
}

/** Read-only, principal-scoped operational evidence for Runtime cutover acceptance. */
export function registerRuntimeRoutes(app: Express): void {
  app.get("/api/runtime/runs", requireAuth, requirePermission("build:read"), async (req, res) => {
    const principal = getCurrentPrincipal();
    if (!principal) return res.status(401).json({ error: "Authentication required" });
    try {
      return res.json({ runs: await listRuntimeRunDiagnostics(principal, diagnosticsFilters(req)) });
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.get("/api/runtime/runs/:id", requireAuth, requirePermission("build:read"), async (req, res) => {
    const principal = getCurrentPrincipal();
    if (!principal) return res.status(401).json({ error: "Authentication required" });
    try {
      const diagnostics = await getRuntimeRunDiagnostics(principal, String(req.params.id));
      return diagnostics
        ? res.json(diagnostics)
        : res.status(404).json({ error: "Runtime run not found" });
    } catch (error) {
      return respondError(res, error);
    }
  });
}
