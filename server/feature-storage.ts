import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireCurrentPrincipal } from "./principal-context";
import { ownedInsertValues } from "./scoped-storage";
import { createAddressLink, listAddressLinks, listReferenceOccurrences, retireAddressLink } from "./life-addressing-storage";
import { getVisibleProduct, getWritableProduct } from "./platforms/platform-access";
import { getSessionsByArtifact } from "./session-artifacts";
import { chatFileStorage } from "./chat-file-storage";
import { eventBus } from "./event-bus";
import { FEATURE_STAGES, FEATURE_STATUSES, type FeatureStage, type FeatureStatus } from "@shared/feature-pipeline";
import {
  featureRoomDeclaresAvailability,
  projectFeatureAvailability,
  resolveChangeShaForStamp,
  roomDeclaresChangeShaIdentity,
} from "./feature-availability";

export { FEATURE_STAGES, FEATURE_STATUSES };

const scopeColumns = { scope: sql`scope`, ownerUserId: sql`owner_user_id`, accountId: sql`account_id` };
function principal() { return requireCurrentPrincipal(); }

/** Push Features list consumers (UI + context) to refetch after a durable mutation. */
function publishFeaturesChanged(action: "created" | "updated" | "archived" | "deleted", featureId: string): void {
  eventBus.publish({
    category: "system",
    event: "data:features_changed",
    payload: { source: "features", action, featureId },
  });
}
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

function historyNote(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (trimmed.length > 2000) throw Object.assign(new Error("History note is too long"), { status: 400 });
    return trimmed;
  }
  return fallback;
}

/**
 * Append one provenance row for a Feature stage/status change.
 * Sole writer lives inside featureStorage create/update/archive.
 * Optional change_sha stamps when entering a room that declares identity: "change_sha".
 */
async function appendHistory(args: {
  featureId: string;
  fromStage: string | null;
  toStage: string;
  fromStatus: string | null;
  toStatus: string;
  note: string;
  source: string;
  sessionId?: string | null;
  changeSha?: string | null;
}) {
  const p = principal();
  const ownership = ownedInsertValues(p, scopeColumns as any);
  const actorUserId = p.actorType === "user" ? p.userId : null;
  const sessionId = typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : null;
  const changeSha = typeof args.changeSha === "string" && args.changeSha.trim() ? args.changeSha.trim().toLowerCase() : null;
  await db.execute(sql`
    INSERT INTO feature_history (
      feature_id, from_stage, to_stage, from_status, to_status, note, source,
      actor_user_id, session_id, scope, owner_user_id, account_id, change_sha
    ) VALUES (
      ${args.featureId}, ${args.fromStage}, ${args.toStage}, ${args.fromStatus}, ${args.toStatus},
      ${args.note}, ${args.source}, ${actorUserId}, ${sessionId},
      ${ownership.scope}, ${ownership.ownerUserId}, ${ownership.accountId}, ${changeSha}
    )
  `);
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
    return projectFeatureAvailability(result.rows as Record<string, unknown>[]);
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
    if (row) {
      const featureId = String((row as any).id);
      let changeSha: string | null = null;
      if (roomDeclaresChangeShaIdentity(stage)) {
        changeSha = await resolveChangeShaForStamp({
          featureId,
          productId,
          explicitChangeSha: input.changeSha ?? input.change_sha,
        });
      }
      await appendHistory({
        featureId,
        fromStage: null,
        toStage: stage,
        fromStatus: null,
        toStatus: "ready",
        note: historyNote(input.historyNote ?? input.note, `Created Feature at ${stage}/ready`),
        source: typeof input.historySource === "string" && input.historySource.trim() ? input.historySource.trim() : "create",
        sessionId: input.sessionId,
        changeSha,
      });
      publishFeaturesChanged("created", featureId);
    }
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
    const nextStatus = reset ? "ready" : status;
    const stageChanged = stage !== current.stage;
    const statusChanged = nextStatus !== current.status;
    if ((stageChanged || statusChanged) && !(typeof input.historyNote === "string" && input.historyNote.trim()) && !(typeof input.note === "string" && input.note.trim())) {
      // Prefer an explicit why-note on stage/status mutations. Fall back only for
      // mechanical stage-reset from a bare stage write so existing clients still work.
      if (!stageChanged) {
        throw Object.assign(new Error("historyNote is required when status changes"), { status: 400 });
      }
    }
    const result = await db.execute(sql`UPDATE features SET product_id=${productId}, summary=${summary}, description=${description}, owner_person_id=${owner}, spec_page_id=${spec}, stage=${stage}, status=${nextStatus}, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND owner_user_id=${p.userId} AND account_id=${p.accountId} AND archived_at IS NULL RETURNING *`);
    const row = result.rows[0];
    if (row && (stageChanged || statusChanged)) {
      const fallback = stageChanged
        ? `Stage ${current.stage} → ${stage}${statusChanged ? ` (status ${current.status} → ${nextStatus})` : " (status reset to ready)"}`
        : `Status ${current.status} → ${nextStatus}`;
      // Stamp merge SHA only when entering a room that declares identity: "change_sha".
      let changeSha: string | null = null;
      if (stageChanged && roomDeclaresChangeShaIdentity(stage)) {
        changeSha = await resolveChangeShaForStamp({
          featureId: id,
          productId,
          explicitChangeSha: input.changeSha ?? input.change_sha,
        });
      }
      await appendHistory({
        featureId: id,
        fromStage: String(current.stage),
        toStage: stage,
        fromStatus: String(current.status),
        toStatus: nextStatus,
        note: historyNote(input.historyNote ?? input.note, fallback),
        source: typeof input.historySource === "string" && input.historySource.trim()
          ? input.historySource.trim()
          : "update",
        sessionId: input.sessionId,
        changeSha,
      });
    }
    if (row) publishFeaturesChanged("updated", id);
    // Return projected availability so get/update consumers see the Play gate.
    if (!row) return row;
    if (!featureRoomDeclaresAvailability(String((row as any).stage))) return row;
    const [projected] = await projectFeatureAvailability([row as Record<string, unknown>]);
    return projected ?? row;
  },
  /**
   * Recheck the Stage join for one Feature. Does not launch Smoke and does not
   * leave/re-enter the room. If the newest enter-declaring-room history row has
   * a NULL change_sha, fill it through resolveChangeShaForStamp only. Never
   * overwrite a real SHA. Same-room status writes are not identity.
   * Then re-project that one Feature against the Product clock.
   */
  async recheckAvailability(id: string) {
    const current = await this.get(id);
    if (!current) return undefined;
    const stage = String((current as { stage?: string }).stage ?? "");
    if (!featureRoomDeclaresAvailability(stage)) return current;

    const productId = Number((current as { product_id?: number }).product_id);
    if (Number.isInteger(productId) && productId > 0 && roomDeclaresChangeShaIdentity(stage)) {
      const newest = await db.execute(sql`
        SELECT id, change_sha
        FROM feature_history
        WHERE feature_id = ${id}
          AND to_stage = ${stage}
          AND from_stage IS DISTINCT FROM to_stage
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const history = newest.rows[0] as { id?: string; change_sha?: string | null } | undefined;
      const historyId = typeof history?.id === "string" ? history.id : "";
      const existingSha =
        typeof history?.change_sha === "string" && history.change_sha.trim()
          ? history.change_sha.trim()
          : null;
      if (historyId && !existingSha) {
        const filled = await resolveChangeShaForStamp({ featureId: id, productId });
        if (filled) {
          await db.execute(sql`
            UPDATE feature_history
            SET change_sha = ${filled}
            WHERE id = ${historyId}
              AND (change_sha IS NULL OR btrim(change_sha) = '')
          `);
        }
      }
    }

    const [projected] = await projectFeatureAvailability([current as Record<string, unknown>]);
    if (projected) publishFeaturesChanged("updated", id);
    return projected ?? current;
  },
  async archive(id: string, input: any = {}) {
    const p = principal();
    const current = await this.get(id);
    if (!current) return undefined;
    const result = await db.execute(sql`UPDATE features SET archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND owner_user_id=${p.userId} AND account_id=${p.accountId} AND archived_at IS NULL RETURNING *`);
    const row = result.rows[0];
    if (row) {
      await appendHistory({
        featureId: id,
        fromStage: String(current.stage),
        toStage: String(current.stage),
        fromStatus: String(current.status),
        toStatus: String(current.status),
        note: historyNote(input.historyNote ?? input.note, "Archived Feature"),
        source: "archive",
        sessionId: input.sessionId,
      });
      publishFeaturesChanged("archived", id);
    }
    return row;
  },
  async permanentlyDelete(id: string, confirmation: boolean) {
    if (confirmation !== true) throw Object.assign(new Error("Permanent deletion requires confirm=true"), { status: 400 });
    const p = principal();
    const result = await db.execute(sql`DELETE FROM features WHERE id=${id} AND owner_user_id=${p.userId} AND account_id=${p.accountId} RETURNING id`);
    const deleted = !!result.rows[0];
    if (deleted) publishFeaturesChanged("deleted", id);
    return deleted;
  },
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
  /**
   * Append-only stage/status provenance for one Feature.
   * Newest first. Optional filters for stage/status query.
   */
  async listHistory(
    id: string,
    input: {
      limit?: number;
      toStage?: string;
      toStatus?: string;
      fromStage?: string;
      fromStatus?: string;
    } = {},
  ) {
    const p = principal();
    const feature = await this.get(id);
    if (!feature) return undefined;
    const limit = Number.isInteger(input.limit) && (input.limit as number) > 0
      ? Math.min(input.limit as number, 200)
      : 50;
    const conditions = [
      sql`h.feature_id = ${id}`,
      p.actorType === "system"
        ? sql`TRUE`
        : sql`(h.scope = 'global' OR (h.owner_user_id = ${p.userId} AND h.account_id = ${p.accountId}))`,
      input.toStage ? sql`h.to_stage = ${enumValue(input.toStage, FEATURE_STAGES, "toStage")}` : undefined,
      input.toStatus ? sql`h.to_status = ${enumValue(input.toStatus, FEATURE_STATUSES, "toStatus")}` : undefined,
      input.fromStage ? sql`h.from_stage = ${enumValue(input.fromStage, FEATURE_STAGES, "fromStage")}` : undefined,
      input.fromStatus ? sql`h.from_status = ${enumValue(input.fromStatus, FEATURE_STATUSES, "fromStatus")}` : undefined,
    ].filter((condition): condition is Exclude<typeof condition, undefined> => condition !== undefined);
    const where = conditions.reduce<ReturnType<typeof sql>>((query, condition) => sql`${query} AND ${condition}`);
    const result = await db.execute(sql`
      SELECT h.id, h.feature_id, h.from_stage, h.to_stage, h.from_status, h.to_status,
             h.note, h.source, h.actor_user_id, h.session_id, h.created_at
      FROM feature_history h
      WHERE ${where}
      ORDER BY h.created_at DESC
      LIMIT ${limit}
    `);
    return result.rows;
  },
};
