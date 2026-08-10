import type { Express, Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { libraryPages } from "@shared/schema";
import { requireAuth } from "./auth";
import { requirePermission } from "./permissions";
import { businessStorage, ensureBusinessesSchema, type Business } from "./business-storage";
import { createFiledLibraryPage } from "./library-save";
import { db } from "./db";
import { combineWithVisibleScope } from "./scoped-storage";
import { requireCurrentPrincipal } from "./principal-context";
import { createLogger } from "./log";

// REST surface over BusinessStorage for the Definition page: identity scalars
// plus the three fixed narrative slots (Values / Vision / Mission), each a
// linked Library page resolved through the canonical reference system. Reads
// enrich the stored `*_page_id` soft-refs into `{ id, title, slug }` so the
// client can render the shared inline library-page editor without a second
// round-trip per slot. Every read/write flows through the principal-scoped
// BusinessStorage and scoped library predicates — no unscoped table reads.

const log = createLogger("BusinessDefinitionRoutes");

const NARRATIVE_SLOTS = ["values", "vision", "mission"] as const;
type NarrativeSlot = (typeof NARRATIVE_SLOTS)[number];

const SLOT_LABEL: Record<NarrativeSlot, string> = {
  values: "Values",
  vision: "Vision",
  mission: "Mission",
};

const SLOT_COLUMN: Record<NarrativeSlot, "valuesPageId" | "visionPageId" | "missionPageId"> = {
  values: "valuesPageId",
  vision: "visionPageId",
  mission: "missionPageId",
};

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

interface NarrativePageRef {
  id: string;
  title: string;
  slug: string;
}

interface BusinessDefinitionView extends Business {
  valuesPage: NarrativePageRef | null;
  visionPage: NarrativePageRef | null;
  missionPage: NarrativePageRef | null;
}

const createSchema = z.object({
  publicName: z.string().trim().min(1).max(160),
  entityName: z.string().trim().min(1).max(200).nullable().optional(),
  vaultIds: z.array(z.string().min(1)).max(64).optional(),
});

const patchSchema = z
  .object({
    publicName: z.string().trim().min(1).max(160).optional(),
    entityName: z.string().trim().min(1).max(200).nullable().optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "At least one change is required");

const narrativeSchema = z.object({ slot: z.enum(NARRATIVE_SLOTS) });

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Request failed";
}

function respondError(res: Response, operation: string, error: unknown): void {
  const status = statusOf(error);
  log.error(`${operation} failed`, { status, message: messageOf(error) });
  res.status(status).json({ error: messageOf(error) });
}

let bootstrapped: Promise<void> | null = null;
async function ensureReady(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = ensureBusinessesSchema().catch((err) => {
      bootstrapped = null;
      throw err;
    });
  }
  await bootstrapped;
}

/** Resolve the stored narrative page soft-refs into principal-visible refs. */
async function loadNarrativeRefs(pageIds: string[]): Promise<Map<string, NarrativePageRef>> {
  const ids = [...new Set(pageIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug })
    .from(libraryPages)
    .where(combineWithVisibleScope(requireCurrentPrincipal(), libraryScopeColumns, inArray(libraryPages.id, ids)));
  return new Map(rows.map((row) => [row.id, row]));
}

async function toView(business: Business): Promise<BusinessDefinitionView> {
  const refs = await loadNarrativeRefs([
    business.valuesPageId ?? "",
    business.visionPageId ?? "",
    business.missionPageId ?? "",
  ]);
  return {
    ...business,
    valuesPage: business.valuesPageId ? refs.get(business.valuesPageId) ?? null : null,
    visionPage: business.visionPageId ? refs.get(business.visionPageId) ?? null : null,
    missionPage: business.missionPageId ? refs.get(business.missionPageId) ?? null : null,
  };
}

async function toViews(list: Business[]): Promise<BusinessDefinitionView[]> {
  const refs = await loadNarrativeRefs(
    list.flatMap((b) => [b.valuesPageId ?? "", b.visionPageId ?? "", b.missionPageId ?? ""]),
  );
  return list.map((business) => ({
    ...business,
    valuesPage: business.valuesPageId ? refs.get(business.valuesPageId) ?? null : null,
    visionPage: business.visionPageId ? refs.get(business.visionPageId) ?? null : null,
    missionPage: business.missionPageId ? refs.get(business.missionPageId) ?? null : null,
  }));
}

export function registerBusinessDefinitionRoutes(app: Express): void {
  app.get(
    "/api/business/definition",
    requireAuth,
    requirePermission("system:read"),
    async (_req: Request, res: Response) => {
      try {
        await ensureReady();
        const list = await businessStorage.list();
        res.json({ businesses: await toViews(list) });
      } catch (error) {
        respondError(res, "list businesses", error);
      }
    },
  );

  app.post(
    "/api/business/definition",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const input = createSchema.parse(req.body ?? {});
        const business = await businessStorage.create(input);
        log.info("business created", { businessId: business.id });
        res.status(201).json(await toView(business));
      } catch (error) {
        respondError(res, "create business", error);
      }
    },
  );

  app.get(
    "/api/business/definition/:id",
    requireAuth,
    requirePermission("system:read"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const business = await businessStorage.get(req.params.id);
        if (!business) {
          res.status(404).json({ error: "Business not found or not visible" });
          return;
        }
        res.json(await toView(business));
      } catch (error) {
        respondError(res, "get business", error);
      }
    },
  );

  app.patch(
    "/api/business/definition/:id",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const patch = patchSchema.parse(req.body ?? {});
        const business = await businessStorage.update(req.params.id, patch);
        res.json(await toView(business));
      } catch (error) {
        respondError(res, "update business", error);
      }
    },
  );

  // Create the narrative Library page for a slot and wire its id into the
  // business row. One canonical mutation path: the page is filed into the
  // Business's own Vault, then the soft-ref is persisted through BusinessStorage.
  app.post(
    "/api/business/definition/:id/pages",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const { slot } = narrativeSchema.parse(req.body ?? {});
        const business = await businessStorage.get(req.params.id);
        if (!business) {
          res.status(404).json({ error: "Business not found or not visible" });
          return;
        }
        const column = SLOT_COLUMN[slot];
        if (business[column]) {
          res.status(409).json({ error: `${SLOT_LABEL[slot]} page already exists` });
          return;
        }
        const page = await createFiledLibraryPage({
          title: `${business.publicName} — ${SLOT_LABEL[slot]}`,
          markdown: "",
          explicitVaultId: business.vaultIds[0] ?? null,
          tags: ["business-narrative", `business-${slot}`],
        });
        const patch =
          slot === "values"
            ? { valuesPageId: page.id }
            : slot === "vision"
              ? { visionPageId: page.id }
              : { missionPageId: page.id };
        const updated = await businessStorage.update(business.id, patch);
        log.info("business narrative page created", { businessId: business.id, slot, pageId: page.id });
        res.status(201).json(await toView(updated));
      } catch (error) {
        respondError(res, "create business narrative page", error);
      }
    },
  );
}
