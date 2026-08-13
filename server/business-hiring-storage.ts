import { randomBytes } from "crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { businessHiringSlots, businesses, jobRoles } from "@shared/schema";
import { normalizeAssumptions } from "@shared/models/business-model";
import { hiringSlotCreateSchema, hiringSlotUpdateSchema, calendarMonthAt, currentCalendarMonth, HIRING_HORIZON_MONTHS, projectHiringSlots, type BusinessHiringProjection, type BusinessHiringSlot, type HiringSlotCreate, type HiringSlotUpdate } from "@shared/models/business-hiring";
import { db } from "./db";
import { requireCurrentUserPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { visibleBusinessPredicate, writableBusinessPredicate } from "./business-vault-access";
import { businessModelStorage } from "./business-model-storage";
import { jobRoleStorage } from "./job-role-storage";
import { createLogger } from "./log";

const log = createLogger("BusinessHiringStorage");
const slotScope = { scope: businessHiringSlots.scope, ownerUserId: businessHiringSlots.ownerUserId, accountId: businessHiringSlots.accountId };
const roleScope = { scope: jobRoles.scope, ownerUserId: jobRoles.ownerUserId, accountId: jobRoles.accountId };

function mapSlot(row: typeof businessHiringSlots.$inferSelect): BusinessHiringSlot {
  return { id: row.id, businessId: row.businessId, roleId: row.roleId, approvalMonth: row.approvalMonth, plannedStartMonth: row.plannedStartMonth, status: row.status as BusinessHiringSlot["status"], source: row.source as BusinessHiringSlot["source"], legacySourceKey: row.legacySourceKey, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function status(error: string, code: number): never { throw Object.assign(new Error(error), { status: code }); }

export class BusinessHiringStorage {
  private async assertBusiness(businessId: string, writable: boolean): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    const predicate = writable ? writableBusinessPredicate(principal, eq(businesses.id, businessId)) : visibleBusinessPredicate(principal, eq(businesses.id, businessId));
    const [business] = await db.select({ id: businesses.id }).from(businesses).where(predicate).limit(1);
    if (!business) status("Business not found or not accessible", writable ? 403 : 404);
  }
  private async listRows(businessId: string): Promise<BusinessHiringSlot[]> {
    const principal = requireCurrentUserPrincipal();
    const rows = await db.select().from(businessHiringSlots).where(combineWithVisibleScope(principal, slotScope, eq(businessHiringSlots.businessId, businessId))).orderBy(asc(businessHiringSlots.approvalMonth), asc(businessHiringSlots.createdAt));
    return rows.map(mapSlot);
  }
  async adoptLegacy(businessId: string): Promise<void> {
    await this.assertBusiness(businessId, true);
    const principal = requireCurrentUserPrincipal();
    const model = await businessModelStorage.getOrCreate(businessId);
    const assumptions = normalizeAssumptions(model.assumptions);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`business-hiring:${businessId}`}))`);
      const roleIds = [...new Set(assumptions.phases.flatMap((phase) => phase.keyHires.map((hire) => hire.roleId)))];
      const visibleRoles = roleIds.length ? await tx.select({ id: jobRoles.id }).from(jobRoles).where(combineWithVisibleScope(principal, roleScope, inArray(jobRoles.id, roleIds))) : [];
      const valid = new Set(visibleRoles.map((role) => role.id));
      for (const phase of assumptions.phases) for (const [index, hire] of phase.keyHires.entries()) {
        if (!valid.has(hire.roleId)) { log.warn("legacy hiring role unresolved", { businessId, phaseKey: phase.key, index }); continue; }
        const count = Math.max(1, Math.round(hire.headcount ?? 1));
        const startIndex = Math.max(1, Math.round(hire.startMonth ?? phase.startMonth ?? 1));
        const plannedStartMonth = calendarMonthAt(assumptions.startCalendarMonth, startIndex - 1);
        for (let ordinal = 0; ordinal < count; ordinal++) {
          const legacySourceKey = `${phase.key}:${index}:${ordinal}`;
          await tx.insert(businessHiringSlots).values({ id: randomBytes(8).toString("hex"), businessId, roleId: hire.roleId, approvalMonth: plannedStartMonth, plannedStartMonth, status: "approved", source: "legacy_key_hire_migration", legacySourceKey, ...ownedInsertValues(principal, slotScope), createdByUserId: principal.userId }).onConflictDoNothing();
        }
      }
    });
  }
  async projection(businessId: string): Promise<BusinessHiringProjection> {
    await this.assertBusiness(businessId, false);
    const [model, slots, roles] = await Promise.all([businessModelStorage.getOrCreate(businessId), this.listRows(businessId), jobRoleStorage.list({ limit: 200 })]);
    const assumptions = normalizeAssumptions(model.assumptions);
    const roleIds = new Set(roles.map((role) => role.id));
    const unresolvedLegacyRoleIds = [...new Set(assumptions.phases.flatMap((phase) => phase.keyHires.map((hire) => hire.roleId)).filter((id) => !roleIds.has(id)))];
    return { businessId, roles, slots, months: projectHiringSlots(currentCalendarMonth(), HIRING_HORIZON_MONTHS, slots, roles, assumptions.loadedCostMultiplier), unresolvedLegacyRoleIds };
  }
  async create(input: HiringSlotCreate): Promise<BusinessHiringProjection> {
    const parsed = hiringSlotCreateSchema.parse(input); await this.assertBusiness(parsed.businessId, true); await jobRoleStorage.get(parsed.roleId);
    const principal = requireCurrentUserPrincipal();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`business-hiring:${parsed.businessId}`}))`);
      await tx.insert(businessHiringSlots).values({ id: randomBytes(8).toString("hex"), businessId: parsed.businessId, roleId: parsed.roleId, approvalMonth: parsed.approvalMonth, plannedStartMonth: parsed.plannedStartMonth ?? parsed.approvalMonth, status: "approved", source: "manual", idempotencyKey: parsed.idempotencyKey, ...ownedInsertValues(principal, slotScope), createdByUserId: principal.userId }).onConflictDoNothing();
    });
    log.info("hiring slot created", { businessId: parsed.businessId, roleId: parsed.roleId }); return this.projection(parsed.businessId);
  }
  async update(id: string, input: HiringSlotUpdate): Promise<BusinessHiringProjection> {
    const parsed = hiringSlotUpdateSchema.parse(input); await this.assertBusiness(parsed.businessId, true); const principal = requireCurrentUserPrincipal();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`business-hiring:${parsed.businessId}`}))`);
      const [slot] = await tx.select().from(businessHiringSlots).where(combineWithWritableScope(principal, slotScope, and(eq(businessHiringSlots.id, id), eq(businessHiringSlots.businessId, parsed.businessId)))).limit(1);
      if (!slot || slot.status === "canceled") status("Hiring slot not found or no longer editable", 404);
      const plannedStartMonth = parsed.clearFields?.includes("plannedStartMonth") ? null : parsed.plannedStartMonth!;
      const approvalMonth = plannedStartMonth && plannedStartMonth < slot.approvalMonth ? plannedStartMonth : slot.approvalMonth;
      await tx.update(businessHiringSlots).set({ approvalMonth, plannedStartMonth, idempotencyKey: parsed.idempotencyKey, updatedAt: new Date() }).where(combineWithWritableScope(principal, slotScope, eq(businessHiringSlots.id, id)));
    });
    log.info("hiring slot updated", { businessId: parsed.businessId, slotId: id }); return this.projection(parsed.businessId);
  }
  async cancel(businessId: string, id: string): Promise<BusinessHiringProjection> {
    await this.assertBusiness(businessId, true); const principal = requireCurrentUserPrincipal();
    await db.transaction(async (tx) => { await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`business-hiring:${businessId}`}))`); await tx.update(businessHiringSlots).set({ status: "canceled", updatedAt: new Date() }).where(combineWithWritableScope(principal, slotScope, and(eq(businessHiringSlots.id, id), eq(businessHiringSlots.businessId, businessId), eq(businessHiringSlots.status, "approved")))); });
    log.info("hiring slot canceled", { businessId, slotId: id }); return this.projection(businessId);
  }
}
export const businessHiringStorage = new BusinessHiringStorage();
