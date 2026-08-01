import type { Express } from "express";
import { requireAuth } from "./auth";
import { getCurrentPrincipal } from "./principal-context";
import { ADDRESS_RESOLUTION_BATCH_LIMIT, resolveAddressBatch } from "./address-resolver";

function parseLegacyRefs(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map(ref => ref.trim()).filter(Boolean);
}

function parseStructuredRefs(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const refs = value.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0).map(ref => ref.trim());
  return refs.length === value.length ? refs : null;
}

/**
 * Canonical principal-aware batch address resolution.
 *
 * GET retains the legacy { "type:id": "label" } projection used by existing
 * reference chips. POST exposes the protocol outcome/redirect metadata.
 */
export function registerReferenceRoutes(app: Express) {
  app.get("/api/references/resolve", requireAuth, async (req, res) => {
    const refs = parseLegacyRefs(req.query.refs);
    if (refs.length === 0) return res.json({});
    if (refs.length > ADDRESS_RESOLUTION_BATCH_LIMIT) {
      return res.status(400).json({ error: `Too many refs (max ${ADDRESS_RESOLUTION_BATCH_LIMIT})` });
    }
    const principal = getCurrentPrincipal();
    if (!principal) return res.status(401).json({ error: "Authentication required" });

    const results = await resolveAddressBatch(principal, refs);
    const labels: Record<string, string> = {};
    for (const [index, result] of results.entries()) {
      if (!result.resolution) continue;
      labels[refs[index].replace(/^@/, "")] = result.resolution.label;
    }
    return res.json(labels);
  });

  app.post("/api/references/resolve", requireAuth, async (req, res) => {
    const refs = parseStructuredRefs(req.body?.refs);
    if (!refs) return res.status(400).json({ error: "refs must be an array of non-empty canonical addresses" });
    if (refs.length > ADDRESS_RESOLUTION_BATCH_LIMIT) {
      return res.status(400).json({ error: `Too many refs (max ${ADDRESS_RESOLUTION_BATCH_LIMIT})` });
    }
    const principal = getCurrentPrincipal();
    if (!principal) return res.status(401).json({ error: "Authentication required" });
    return res.json({ results: await resolveAddressBatch(principal, refs) });
  });
}
