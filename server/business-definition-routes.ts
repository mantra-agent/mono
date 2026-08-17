import type { Express, Request, Response } from "express";
import { and, eq, inArray, or } from "drizzle-orm";
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
// plus the fixed narrative slots (DNA / Product / Marketing / Success page
// links, plus Phases and Pitch so existing bindings stay reachable), each a
// linked Library page resolved through the canonical reference system. Reads
// enrich the stored `*_page_id` soft-refs into `{ id, title, slug }` so the
// client can render the shared inline library-page editor without a second
// round-trip per slot. Every read/write flows through the principal-scoped
// BusinessStorage and scoped library predicates — no unscoped table reads.

const log = createLogger("BusinessDefinitionRoutes");

const NARRATIVE_SLOTS = [
  "values",
  "vision",
  "mission",
  "phases",
  "pitch",
  "gtm",
  "product",
  "brand",
  "differentiators",
  "market",
  "icp",
  "activation",
] as const;
type NarrativeSlot = (typeof NARRATIVE_SLOTS)[number];
type NarrativeColumn = `${NarrativeSlot}PageId`;

const SLOT_LABEL: Record<NarrativeSlot, string> = {
  values: "Values",
  vision: "Vision",
  mission: "Mission",
  phases: "Phases",
  pitch: "Pitch",
  gtm: "GTM",
  product: "Product",
  brand: "Brand",
  differentiators: "Differentiators",
  market: "Market",
  icp: "ICP",
  activation: "Activation",
};

const SLOT_COLUMN: Record<NarrativeSlot, NarrativeColumn> = {
  values: "valuesPageId",
  vision: "visionPageId",
  mission: "missionPageId",
  phases: "phasesPageId",
  pitch: "pitchPageId",
  gtm: "gtmPageId",
  product: "productPageId",
  brand: "brandPageId",
  differentiators: "differentiatorsPageId",
  market: "marketPageId",
  icp: "icpPageId",
  activation: "activationPageId",
};

function narrativePageIds(business: Business): string[] {
  return NARRATIVE_SLOTS.map((slot) => business[SLOT_COLUMN[slot]] ?? "");
}

function narrativePages(business: Business, refs: Map<string, NarrativePageRef>): Record<`${NarrativeSlot}Page`, NarrativePageRef | null> {
  return Object.fromEntries(
    NARRATIVE_SLOTS.map((slot) => {
      const pageId = business[SLOT_COLUMN[slot]];
      return [`${slot}Page`, pageId ? refs.get(pageId) ?? null : null];
    }),
  ) as Record<`${NarrativeSlot}Page`, NarrativePageRef | null>;
}

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
  phasesPage: NarrativePageRef | null;
  pitchPage: NarrativePageRef | null;
  gtmPage: NarrativePageRef | null;
  productPage: NarrativePageRef | null;
  brandPage: NarrativePageRef | null;
  differentiatorsPage: NarrativePageRef | null;
  marketPage: NarrativePageRef | null;
  icpPage: NarrativePageRef | null;
  activationPage: NarrativePageRef | null;
}

const createSchema = z.object({
  publicName: z.string().trim().min(1).max(160),
  entityName: z.string().trim().min(1).max(200).nullable().optional(),
  vaultIds: z.array(z.string().min(1)).max(64).optional(),
});

const narrativePageIdSchema = z.string().min(1).nullable().optional();

const patchSchema = z
  .object({
    publicName: z.string().trim().min(1).max(160).optional(),
    entityName: z.string().trim().min(1).max(200).nullable().optional(),
    status: z.enum(["active", "archived"]).optional(),
    vaultIds: z.array(z.string().trim().min(1)).min(1).max(64).optional(),
    dataRoomUrl: z.string().trim().url().max(2048)
      .refine((value) => new URL(value).protocol === "https:", "Data Room URL must use HTTPS")
      .optional(),
    valuesPageId: narrativePageIdSchema,
    visionPageId: narrativePageIdSchema,
    missionPageId: narrativePageIdSchema,
    phasesPageId: narrativePageIdSchema,
    pitchPageId: narrativePageIdSchema,
    gtmPageId: narrativePageIdSchema,
    productPageId: narrativePageIdSchema,
    brandPageId: narrativePageIdSchema,
    differentiatorsPageId: narrativePageIdSchema,
    marketPageId: narrativePageIdSchema,
    icpPageId: narrativePageIdSchema,
    activationPageId: narrativePageIdSchema,
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

/**
 * Resolve reference-picker page references to canonical visible library_pages.id.
 * The universal picker emits slug-or-id references (page.slug || page.id), while
 * narrative slots persist the canonical UUID, so an assigned slug must be mapped
 * back to its id before storage. Returns input reference -> canonical id.
 */
async function resolveVisiblePageIds(refs: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(refs.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: libraryPages.id, slug: libraryPages.slug })
    .from(libraryPages)
    .where(
      combineWithVisibleScope(
        requireCurrentPrincipal(),
        libraryScopeColumns,
        or(inArray(libraryPages.id, ids), inArray(libraryPages.slug, ids)),
      ),
    );
  const out = new Map<string, string>();
  for (const row of rows) {
    if (ids.includes(row.id)) out.set(row.id, row.id);
    if (row.slug && ids.includes(row.slug)) out.set(row.slug, row.id);
  }
  return out;
}

async function toView(business: Business): Promise<BusinessDefinitionView> {
  const refs = await loadNarrativeRefs(narrativePageIds(business));
  return { ...business, ...narrativePages(business, refs) };
}

async function toViews(list: Business[]): Promise<BusinessDefinitionView[]> {
  const refs = await loadNarrativeRefs(list.flatMap(narrativePageIds));
  return list.map((business) => ({ ...business, ...narrativePages(business, refs) }));
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
        const { vaultIds, ...patch } = patchSchema.parse(req.body ?? {});
        // Assigned narrative pages arrive as picker references (slug or id).
        // Resolve each to its canonical visible library_pages.id before persist;
        // an unresolvable reference is a 404 rather than a stored dangling ref.
        const assignedColumns = NARRATIVE_SLOTS
          .map((slot) => SLOT_COLUMN[slot])
          .filter((column): column is NarrativeColumn =>
            typeof patch[column] === "string" && (patch[column] as string).length > 0);
        if (assignedColumns.length > 0) {
          const resolved = await resolveVisiblePageIds(
            assignedColumns.map((column) => patch[column] as string),
          );
          for (const column of assignedColumns) {
            const canonicalId = resolved.get(patch[column] as string);
            if (!canonicalId) {
              res.status(404).json({ error: "Library page not found or not visible" });
              return;
            }
            (patch as Record<string, unknown>)[column] = canonicalId;
          }
        }
        let business = Object.keys(patch).length > 0
          ? await businessStorage.update(req.params.id, patch)
          : await businessStorage.get(req.params.id);
        if (!business) throw new Error(`Business ${req.params.id} not found or not visible`);
        if (vaultIds) business = await businessStorage.replaceVaultMemberships(req.params.id, vaultIds);
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
        const updated = await businessStorage.update(business.id, { [column]: page.id });
        log.info("business narrative page created", { businessId: business.id, slot, pageId: page.id });
        res.status(201).json(await toView(updated));
      } catch (error) {
        respondError(res, "create business narrative page", error);
      }
    },
  );
}
