import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireCurrentPrincipal } from "./principal-context";
import { ownedInsertValues } from "./scoped-storage";
import { createAddressLink, listAddressLinks, listReferenceOccurrences, retireAddressLink } from "./life-addressing-storage";
import { getVisibleProduct, getWritableProduct } from "./platforms/platform-access";
import { getSessionsByArtifact } from "./session-artifacts";
import { chatFileStorage } from "./chat-file-storage";

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
/** Optional free text (e.g. description): empty string is a legitimate cleared value. */
function optionalText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw Object.assign(new Error(`${label} must be text`), { status: 400 });
  const trimmed = value.trim();
  if (trimmed.length > max) throw Object.assign(new Error(`${label} is too long`), { status: 400 });
  return trimmed;
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
    const description = input.description === undefined ? "" : optionalText(input.description, "Description", 10000);
    const ownership = ownedInsertValues(p, { scope: sql`scope`, ownerUserId: sql`owner_user_id`, accountId: sql`account_id` } as any);
    const [row] = await db.execute(sql`INSERT INTO features (product_id, owner_person_id, spec_page_id, summary, description, stage, status, scope, owner_user_id, account_id) VALUES (${productId}, ${ownerPersonId}, ${specPageId}, ${summary}, ${description}, ${stage}, 'ready', ${ownership.scope}, ${ownership.ownerUserId}, ${ownership.accountId}) RETURNING *`).then(r => r.rows);
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
    const description = input.description === undefined ? current.description : optionalText(input.description, "Description", 10000);
    let productId = current.product_id as number;
    if (input.productId !== undefined) {
      const nextProductId = Number(input.productId);
      if (!Number.isInteger(nextProductId) || nextProductId <= 0) throw Object.assign(new Error("Product is required"), { status: 400 });
      await assertProduct(nextProductId, true);
      productId = nextProductId;
    }
    const reset = stage !== current.stage;
    const result = await db.execute(sql`UPDATE features SET product_id=${productId}, summary=${summary}, description=${description}, owner_person_id=${owner}, spec_page_id=${spec}, stage=${stage}, status=${reset ? "ready" : status}, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND owner_user_id=${p.userId} AND account_id=${p.accountId} AND archived_at IS NULL RETURNING *`);
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
  /**
   * Session history for one Feature: explicit artifact links plus discovered
   * @feature: address occurrences. Sole ordinary producer for HTTP and Agent tools.
   */
  async listSessions(id: string) {
    const p = principal();
    const feature = await this.get(id);
    if (!feature) return undefined;
    const explicitRows = await getSessionsByArtifact("feature", id);
    const discoveredPage = await listReferenceOccurrences(p, { targetAddress: `@feature:${id}`, limit: 100 });
    const explicit = await Promise.all(explicitRows.map(async (row) => {
      const session = await chatFileStorage.getSession(row.sessionId);
      return session
        ? { sessionId: row.sessionId, title: session.title || "Untitled", evidenceType: "explicit" as const, createdAt: row.createdAt }
        : null;
    }));
    const discovered = await Promise.all([...new Set(discoveredPage.items.map((item) => item.sourceAddress))].map(async (sourceAddress) => {
      const sessionId = sourceAddress.replace(/^@session:/, "");
      const session = await chatFileStorage.getSession(sessionId);
      return session
        ? { sessionId, title: session.title || "Untitled", evidenceType: "discovered" as const, createdAt: session.updatedAt }
        : null;
    }));
    return [...explicit, ...discovered].filter((row): row is NonNullable<typeof row> => row !== null);
  },
};
