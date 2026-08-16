import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireCurrentPrincipal } from "./principal-context";
import { ownedInsertValues } from "./scoped-storage";
import { createAddressLink, listAddressLinks, retireAddressLink } from "./life-addressing-storage";
import { getVisibleProduct, getWritableProduct } from "./platforms/platform-access";

export const FEATURE_STAGES = ["idea", "spec", "develop", "test", "calibrate", "maintain", "deprecate"] as const;
export const FEATURE_STATUSES = ["ready", "in_progress", "needs_review"] as const;
type FeatureStage = typeof FEATURE_STAGES[number];
type FeatureStatus = typeof FEATURE_STATUSES[number];

const scopeColumns = { scope: sql`scope`, ownerUserId: sql`owner_user_id`, accountId: sql`account_id` };
function principal() { return requireCurrentPrincipal(); }
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw Object.assign(new Error(`${label} is required`), { status: 400 });
  return value.trim();
}
function enumValue<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  return value as T[number];
}
async function assertProduct(id: number, writable: boolean) {
  const result = writable ? await getWritableProduct(id) : await getVisibleProduct(id);
  if (!result) throw Object.assign(new Error("Product not found or not visible"), { status: 404 });
  return result.product;
}

export const featureStorage = {
  async list(input: { productId?: number; includeArchived?: boolean; search?: string } = {}) {
    const p = principal();
    const conditions = [
      p.actorType === "system" ? sql`TRUE` : sql`(f.scope = 'global' OR (f.owner_user_id = ${p.userId} AND f.account_id = ${p.accountId}))`,
      input.productId ? sql`f.product_id = ${input.productId}` : undefined,
      input.includeArchived ? undefined : sql`f.archived_at IS NULL`,
      input.search?.trim() ? sql`f.summary ILIKE ${`%${input.search.trim()}%`}` : undefined,
    ].filter((condition): condition is Exclude<typeof condition, undefined> => condition !== undefined);
    const where = conditions.reduce<ReturnType<typeof sql>>((query, condition) => sql`${query} AND ${condition}`);
    const result = await db.execute(sql`SELECT f.*, p.name AS product_name FROM features f JOIN products p ON p.id = f.product_id WHERE ${where} ORDER BY f.stage, f.updated_at DESC LIMIT 500`);
    return result.rows;
  },
  async get(id: string) {
    const rows = await this.list();
    return rows.find((row: any) => row.id === id);
  },
  async create(input: any) {
    const p = principal();
    const productId = Number(input.productId);
    if (!Number.isInteger(productId) || productId <= 0) throw Object.assign(new Error("Product is required"), { status: 400 });
    await assertProduct(productId, true);
    const ownerPersonId = text(input.ownerPersonId, "Owner", 200);
    const summary = text(input.summary, "Summary", 500);
    const stage = enumValue(input.stage ?? "idea", FEATURE_STAGES, "stage");
    const specPageId = typeof input.specPageId === "string" && input.specPageId.trim() ? input.specPageId.trim() : null;
    const ownership = ownedInsertValues(p, { scope: sql`scope`, ownerUserId: sql`owner_user_id`, accountId: sql`account_id` } as any);
    const [row] = await db.execute(sql`INSERT INTO features (product_id, owner_person_id, spec_page_id, summary, stage, status, scope, owner_user_id, account_id) VALUES (${productId}, ${ownerPersonId}, ${specPageId}, ${summary}, ${stage}, 'ready', ${ownership.scope}, ${ownership.ownerUserId}, ${ownership.accountId}) RETURNING *`).then(r => r.rows);
    return row;
  },
  async update(id: string, input: any) {
    const p = principal();
    const current = await this.get(id); if (!current) return undefined;
    const stage = input.stage === undefined ? current.stage : enumValue(input.stage, FEATURE_STAGES, "stage");
    const status = input.status === undefined ? current.status : enumValue(input.status, FEATURE_STATUSES, "status");
    const summary = input.summary === undefined ? current.summary : text(input.summary, "Summary", 500);
    const owner = input.ownerPersonId === undefined ? current.owner_person_id : text(input.ownerPersonId, "Owner", 200);
    const spec = input.specPageId === undefined ? current.spec_page_id : (typeof input.specPageId === "string" && input.specPageId.trim() ? input.specPageId.trim() : null);
    const reset = stage !== current.stage;
    const result = await db.execute(sql`UPDATE features SET summary=${summary}, owner_person_id=${owner}, spec_page_id=${spec}, stage=${stage}, status=${reset ? "ready" : status}, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND owner_user_id=${p.userId} AND account_id=${p.accountId} AND archived_at IS NULL RETURNING *`);
    return result.rows[0];
  },
  async archive(id: string) { const p = principal(); const result = await db.execute(sql`UPDATE features SET archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND owner_user_id=${p.userId} AND account_id=${p.accountId} AND archived_at IS NULL RETURNING *`); return result.rows[0]; },
  async permanentlyDelete(id: string, confirmation: boolean) { if (confirmation !== true) throw Object.assign(new Error("Permanent deletion requires confirm=true"), { status: 400 }); const p = principal(); const result = await db.execute(sql`DELETE FROM features WHERE id=${id} AND owner_user_id=${p.userId} AND account_id=${p.accountId} RETURNING id`); return !!result.rows[0]; },
  async linkKpi(id: string, kpiAddress: string, idempotencyKey: string) {
    const p = principal(); const feature = await this.get(id); if (!feature) throw Object.assign(new Error("Feature not found"), { status: 404 });
    const links = await listAddressLinks(p, { sourceAddress: `@feature:${id}`, predicates: ["intended_benefit"], lifecycle: "active", limit: 10 });
    for (const link of links.items) if (link.targetAddress !== kpiAddress) await retireAddressLink(p, link.id);
    return createAddressLink(p, { sourceAddress: `@feature:${id}`, predicate: "intended_benefit", targetAddress: kpiAddress, createdBy: "feature", idempotencyKey });
  },
  async unlinkKpi(id: string, linkId: string) { const p = principal(); const feature = await this.get(id); if (!feature) throw Object.assign(new Error("Feature not found"), { status: 404 }); return retireAddressLink(p, linkId); },
};
