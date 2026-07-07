import { db } from "./db";
import { systemHooks, systemHookExecutions } from "@shared/schema";
import type { SystemHook, SystemHookExecution } from "@shared/schema";
import { eq, desc, sql } from "drizzle-orm";

export async function listHooks(): Promise<SystemHook[]> {
  return db.select().from(systemHooks).orderBy(desc(systemHooks.createdAt));
}

export async function getHook(id: number): Promise<SystemHook | undefined> {
  const rows = await db.select().from(systemHooks).where(eq(systemHooks.id, id));
  return rows[0];
}

export async function getHookByName(name: string): Promise<SystemHook | undefined> {
  const rows = await db.select().from(systemHooks).where(eq(systemHooks.name, name));
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
    .where(eq(systemHooks.id, id))
    .returning();
  return rows[0];
}

export async function deleteHook(id: number): Promise<void> {
  await db.delete(systemHooks).where(eq(systemHooks.id, id));
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
  return db.select().from(systemHookExecutions)
    .where(eq(systemHookExecutions.hookId, hookId))
    .orderBy(desc(systemHookExecutions.createdAt))
    .limit(limit);
}

export async function getLastExecution(hookId: number): Promise<SystemHookExecution | undefined> {
  const rows = await db.select().from(systemHookExecutions)
    .where(eq(systemHookExecutions.hookId, hookId))
    .orderBy(desc(systemHookExecutions.createdAt))
    .limit(1);
  return rows[0];
}

export async function countExecutions(hookId: number): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` })
    .from(systemHookExecutions)
    .where(eq(systemHookExecutions.hookId, hookId));
  return rows[0]?.count ?? 0;
}
