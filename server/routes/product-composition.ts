// ─── GET /api/product-composition (spec §4.5, §6.3) — SHADOW MODE ───────────
// Returns the safe, serializable, principal-resolved ResolvedProductComposition
// for the authenticated user. Phase 1 shadow foundation: nothing in the client
// renders from this yet. The endpoint additionally runs a bounded, throttled
// shadow-parity drift check comparing the resolver output for the default
// account shape against today's hard-coded app-sidebar / App.tsx lists.
//
// Security: default-deny. requireAuth establishes the principal; requirePermission
// gates on the named `mods:read` capability (account owners receive it by
// default). The body contains only allowlisted, serializable fields — no
// secrets, handlers, raw permission policy, or hidden metadata. Responses are
// private and revalidated via ETag.

import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { createLogger } from "../log";
import { isContributionModality, type ContributionModality } from "@shared/models/product-composition";
import { resolveProductComposition } from "../mods/composition/contribution-resolver";
import { modLifecycleService } from "../mods/mod-lifecycle-service";
import { runShadowParityCheck } from "../mods/composition/shadow-parity";

const log = createLogger("product-composition-route");

function readModality(req: Request): ContributionModality {
  const raw = typeof req.query.modality === "string" ? req.query.modality : "";
  return isContributionModality(raw) ? raw : "web";
}

export function registerProductCompositionRoutes(app: Express): void {
  app.get(
    "/api/product-composition",
    requireAuth,
    requirePermission("mods:read"),
    async (req: Request, res: Response) => {
      const principal = req.principal;
      if (!principal || !principal.userId || !principal.accountId) {
        return res.status(401).json({ error: "Authentication required" });
      }

      try {
        const modality = readModality(req);
        await modLifecycleService.ensureBaseline(principal);
        const composition = await resolveProductComposition(principal, modality);

        // Bounded, throttled shadow-parity drift logging (does not block the
        // response and reads no real account state).
        runShadowParityCheck();

        // ETag revalidation: the composition version is a stable fingerprint of
        // every input that determines the body, so it is a strong validator.
        const etag = `"${composition.compositionVersion}"`;
        res.setHeader("ETag", etag);
        res.setHeader("Cache-Control", "private, no-cache");

        const ifNoneMatch = req.headers["if-none-match"];
        if (typeof ifNoneMatch === "string" && ifNoneMatch === etag) {
          return res.status(304).end();
        }

        return res.json(composition);
      } catch (error) {
        log.error("failed to resolve product composition", {
          error: error instanceof Error ? error.message : String(error),
        });
        return res.status(500).json({ error: "Failed to resolve product composition" });
      }
    },
  );
}
