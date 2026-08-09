import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { SystemHook, SystemHookExecution } from "@shared/schema";
import { systemHookExecutions, systemHooks } from "@shared/schema";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db } from "./db";
import { requireCurrentPrincipal, requireCurrentUserPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const hookScopeColumns = {
  scope: systemHooks.scope,
  ownerUserId: systemHooks.ownerUserId,
  accountId: systemHooks.accountId,
};

function visible(predicate?: SQL): SQL {
  return combineWithVisibleScope(requireCurrentUserPrincipal(), hookScopeColumns, predicate);
}

function writable(predicate?: SQL): SQL {
  return combineWithWritableScope(requireCurrentUserPrincipal(), hookScopeColumns, predicate);
}

function schedulerVisibleHookPredicate(id: number): SQL {
  const principal = requireCurrentPrincipal();
  if (principal.actorType === "system" && principal.jobName) return eq(systemHooks.id, id);
  return combineWithVisibleScope(requireCurrentUserPrincipal(), hookScopeColumns, eq(systemHooks.id, id));
}

export async function listHooks(): Promise<SystemHook[]> {
  return db.select().from(systemHooks).where(visible()).orderBy(desc(systemHooks.createdAt));
}

/** Scheduler-only global enumeration. Caller must be a named system principal. */
export async function listHooksForScheduler(): Promise<SystemHook[]> {
  const principal = requireCurrentPrincipal();
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
  condition?: unknown;
  actionType: string;
  actionConfig: unknown;
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
    ...ownedInsertValues(requireCurrentUserPrincipal(), hookScopeColumns),
  }).returning();
  return rows[0];
}

export async function updateHook(id: number, data: Partial<{
  name: string;
  description: string | null;
  eventPattern: string;
  condition: unknown;
  actionType: string;
  actionConfig: unknown;
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

export async function claimHookExecution(data: {
  hookId: number;
  eventIdentity: string;
  actionType: string;
  actionConfigResolved: unknown;
}): Promise<SystemHookExecution | null> {
  return db.transaction(async (tx) => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.HOOK_EXECUTION, String(data.hookId));
    const [hook] = await tx.select().from(systemHooks).where(schedulerVisibleHookPredicate(data.hookId)).limit(1);
    if (!hook?.enabled) return null;

    const [lastExecution] = await tx.select({ createdAt: systemHookExecutions.createdAt })
      .from(systemHookExecutions)
      .where(eq(systemHookExecutions.hookId, hook.id))
      .orderBy(desc(systemHookExecutions.createdAt))
      .limit(1);
    if (hook.cooldownSeconds > 0 && lastExecution) {
      const elapsedMs = Date.now() - lastExecution.createdAt.getTime();
      if (elapsedMs < hook.cooldownSeconds * 1_000) return null;
    }

    if (hook.maxFirings != null) {
      const [countRow] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(systemHookExecutions)
        .where(eq(systemHookExecutions.hookId, hook.id));
      if ((countRow?.count ?? 0) >= hook.maxFirings) {
        await tx.update(systemHooks).set({ enabled: false, updatedAt: new Date() }).where(eq(systemHooks.id, hook.id));
        return null;
      }
    }

    const [execution] = await tx.insert(systemHookExecutions).values({
      hookId: hook.id,
      eventIdentity: data.eventIdentity,
      actionType: data.actionType,
      actionConfigResolved: data.actionConfigResolved,
      status: "running",
    }).onConflictDoNothing({
      target: [systemHookExecutions.hookId, systemHookExecutions.eventIdentity],
    }).returning();
    return execution ?? null;
  });
}

export async function completeHookExecution(data: {
  hookId: number;
  executionId: number;
  status: "dispatched" | "success" | "error";
  errorMessage?: string;
  durationMs: number;
}): Promise<{ disabled: boolean }> {
  return db.transaction(async (tx) => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.HOOK_EXECUTION, String(data.hookId));
    const [completed] = await tx.update(systemHookExecutions).set({
      status: data.status,
      errorMessage: data.errorMessage ?? null,
      durationMs: data.durationMs,
      completedAt: new Date(),
    }).where(and(
      eq(systemHookExecutions.id, data.executionId),
      eq(systemHookExecutions.hookId, data.hookId),
      eq(systemHookExecutions.status, "running"),
    )).returning({ id: systemHookExecutions.id });
    if (!completed) return { disabled: false };

    const [hook] = await tx.select({ maxFirings: systemHooks.maxFirings, enabled: systemHooks.enabled })
      .from(systemHooks)
      .where(schedulerVisibleHookPredicate(data.hookId))
      .limit(1);
    if (!hook?.enabled || hook.maxFirings == null) return { disabled: false };
    const [countRow] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(systemHookExecutions)
      .where(eq(systemHookExecutions.hookId, data.hookId));
    if ((countRow?.count ?? 0) < hook.maxFirings) return { disabled: false };
    await tx.update(systemHooks).set({ enabled: false, updatedAt: new Date() }).where(eq(systemHooks.id, data.hookId));
    return { disabled: true };
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
    .where(eq(systemHookExecutions.hookId, hookId));
  return rows[0]?.count ?? 0;
}
