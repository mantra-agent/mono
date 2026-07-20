import { db } from "./db";
import { systemHooks, systemHookExecutions } from "@shared/schema";
import type { SystemHook, SystemHookExecution } from "@shared/schema";
import { and, eq, desc, sql, type SQL } from "drizzle-orm";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const hookScopeColumns = {
  scope: systemHooks.scope,
  ownerUserId: systemHooks.ownerUserId,
  accountId: systemHooks.accountId,
};

function visible(predicate?: SQL): SQL {
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), hookScopeColumns, predicate);
}
function writable(predicate?: SQL): SQL {
  return combineWithWritableScope(getCurrentPrincipalOrSystem(), hookScopeColumns, predicate);
}

export async function listHooks(): Promise<SystemHook[]> {
  return db.select().from(systemHooks).where(visible()).orderBy(desc(systemHooks.createdAt));
}

/** Scheduler-only global enumeration. Caller must be a named system principal. */
export async function listHooksForScheduler(): Promise<SystemHook[]> {
  const principal = getCurrentPrincipalOrSystem();
  if (principal.actorType !== "system" || !principal.jobName) throw new Error("Named system principal required for hook scheduler enumeration");
  return db.select().from(systemHooks).orderBy(desc(systemHooks.createdAt));
}

export async function getHook(id: number): Promise<SystemHook | undefined> {
  const rows = await db.select().from(systemHooks).where(visible(eq(systemHooks.id, id))).limit(1);
  return rows[0];
}

export async function getHookByName(name: string): Promise<SystemHook | undefined> {
  const rows = await db.select().from(systemHooks).where(visible(eq(systemHooks.name, name))).limit(1);
  return rows[0];
}

export async function createHook(data: {
  name: string;
  description?: string;
  eventPattern: string;
  condition?: any;
  actionType: string;
  actionConfig: any;
  cooldownSeconds?: number;
  enabled?: boolean;
  maxFirings?: number | null;
  createdBy?: string;
}): Promise<SystemHook> {
  const rows = await db.insert(systemHooks).values({
    name: data.name,
    description: data.description || null,
    eventPattern: data.eventPattern,
    condition: data.condition || null,
    actionType: data.actionType,
    actionConfig: data.actionConfig,
    cooldownSeconds: data.cooldownSeconds ?? 0,
    enabled: data.enabled ?? true,
    maxFirings: data.maxFirings ?? null,
    createdBy: data.createdBy || "user",
    ...ownedInsertValues(getCurrentPrincipalOrSystem(), hookScopeColumns),
  }).returning();
  return rows[0];
}

export async function updateHook(id: number, data: Partial<{
  name: string;
  description: string | null;
  eventPattern: string;
  condition: any;
  actionType: string;
  actionConfig: any;
  cooldownSeconds: number;
  enabled: boolean;
  maxFirings: number | null;
}>): Promise<SystemHook | undefined> {
  const rows = await db.update(systemHooks)
    .set({ ...data, updatedAt: new Date() })
    .where(writable(eq(systemHooks.id, id)))
    .returning();
  return rows[0];
}

export async function deleteHook(id: number): Promise<void> {
  await db.delete(systemHooks).where(writable(eq(systemHooks.id, id)));
}

export async function recordExecution(data: {
  hookId: number;
  eventDbId?: number;
  actionType: string;
  actionConfigResolved?: any;
  status: string;
  errorMessage?: string;
  durationMs?: number;
}): Promise<void> {
  const hook = await getHook(data.hookId);
  if (!hook) throw new Error("Hook not visible to current principal");
  await db.insert(systemHookExecutions).values({
    hookId: data.hookId,
    eventDbId: data.eventDbId || null,
    actionType: data.actionType,
    actionConfigResolved: data.actionConfigResolved || null,
    status: data.status,
    errorMessage: data.errorMessage || null,
    durationMs: data.durationMs || null,
  });
}

export async function getExecutions(hookId: number, limit: number = 20): Promise<SystemHookExecution[]> {
  const hook = await getHook(hookId);
  if (!hook) return [];
  return db.select().from(systemHookExecutions)
    .where(eq(systemHookExecutions.hookId, hookId))
    .orderBy(desc(systemHookExecutions.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

export async function getLastExecution(hookId: number): Promise<SystemHookExecution | undefined> {
  const rows = await getExecutions(hookId, 1);
  return rows[0];
}

export async function countExecutions(hookId: number): Promise<number> {
  const hook = await getHook(hookId);
  if (!hook) return 0;
  const rows = await db.select({ count: sql<number>`count(*)::int` })
    .from(systemHookExecutions)
    .where(and(eq(systemHookExecutions.hookId, hookId)));
  return rows[0]?.count ?? 0;
}
