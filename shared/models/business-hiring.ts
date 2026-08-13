import { z } from "zod";
import type { JobRole } from "./job-roles";

export const calendarMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must use YYYY-MM");
export const calendarQuarterSchema = z.string().regex(/^\d{4} Q[1-4]$/, "Quarter must use YYYY Q1-Q4");

export function quarterToMonth(quarter: string): string {
  const parsed = calendarQuarterSchema.parse(quarter);
  const [year, q] = parsed.split(" ");
  return `${year}-${String((Number(q.slice(1)) - 1) * 3 + 1).padStart(2, "0")}`;
}

export function monthToQuarter(month: string): string {
  const [year, monthNumber] = calendarMonthSchema.parse(month).split("-");
  return `${year} Q${Math.floor((Number(monthNumber) - 1) / 3) + 1}`;
}

export function currentCalendarMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
export const hiringSlotCreateSchema = z.object({
  businessId: z.string().min(1), roleId: z.string().min(1), approvalMonth: calendarMonthSchema,
  plannedStartMonth: calendarMonthSchema.nullable().optional(), idempotencyKey: z.string().trim().min(8).max(200),
}).strict().superRefine((value, ctx) => {
  if (value.plannedStartMonth && value.plannedStartMonth < value.approvalMonth) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["plannedStartMonth"], message: "Planned start month cannot precede approval month" });
});
export const hiringSlotUpdateSchema = z.object({
  businessId: z.string().min(1), plannedStartMonth: calendarMonthSchema.optional(),
  clearFields: z.array(z.literal("plannedStartMonth")).max(1).optional(), idempotencyKey: z.string().trim().min(8).max(200),
}).strict().refine((value) => Boolean(value.plannedStartMonth) !== Boolean(value.clearFields?.includes("plannedStartMonth")), "Provide plannedStartMonth or explicitly clear it");

export interface BusinessHiringSlot {
  id: string; businessId: string; roleId: string; approvalMonth: string; plannedStartMonth: string | null;
  status: "approved" | "canceled"; source: "manual" | "legacy_key_hire_migration"; legacySourceKey: string | null;
  createdAt: string; updatedAt: string;
}
export interface HiringMonthProjection { calendarMonth: string; label: string; quarterLabel: string; approvedSlots: number; headcount: number; staffOpex: number; }
export interface BusinessHiringProjection { businessId: string; roles: JobRole[]; slots: BusinessHiringSlot[]; months: HiringMonthProjection[]; unresolvedLegacyRoleIds: string[]; }

export interface HiringQuarter { quarter: string; roles: Array<JobRole & { slotId: string }>; }
export interface BusinessHiringPlan { businessId: string; roles: JobRole[]; quarters: HiringQuarter[]; }

export function calendarMonthAt(start: string, offset: number): string {
  const [year, month] = start.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function monthOffset(start: string, target: string): number {
  const [sy, sm] = start.split("-").map(Number); const [ty, tm] = target.split("-").map(Number);
  return (ty - sy) * 12 + tm - sm;
}
export function loadedMonthlyForRole(role: JobRole, multiplier: number): number {
  return ((role.annualSalaryMin + role.annualSalaryMax) / 2) * (1 + role.targetBonusPercent / 100) * multiplier / 12;
}

/** Hiring page/projection window. Independent of the financial model's Phase 1 horizon. */
export const HIRING_HORIZON_MONTHS = 60;

export function projectHiringSlots(startCalendarMonth: string, count: number, slots: BusinessHiringSlot[], roles: JobRole[], multiplier: number): HiringMonthProjection[] {
  const roleById = new Map(roles.map((role) => [role.id, role]));
  return Array.from({ length: count }, (_, index) => {
    const calendarMonth = calendarMonthAt(startCalendarMonth, index);
    const active = slots.filter((slot) => slot.status === "approved" && slot.plannedStartMonth && slot.plannedStartMonth <= calendarMonth && roleById.has(slot.roleId));
    const [year, month] = calendarMonth.split("-").map(Number);
    return {
      calendarMonth, label: new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1))),
      quarterLabel: `Q${Math.floor((month - 1) / 3) + 1} ${year}`,
      approvedSlots: slots.filter((slot) => slot.status === "approved" && slot.approvalMonth <= calendarMonth).length,
      headcount: active.length,
      staffOpex: active.reduce((sum, slot) => sum + loadedMonthlyForRole(roleById.get(slot.roleId)!, multiplier), 0),
    };
  });
}
export type HiringSlotCreate = z.infer<typeof hiringSlotCreateSchema>;
export type HiringSlotUpdate = z.infer<typeof hiringSlotUpdateSchema>;
