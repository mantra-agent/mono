import { eq, desc, sql, and, type SQL } from "drizzle-orm";
import { renderJobs, type RenderJob, type InsertRenderJob } from "@shared/schema";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { visibleScopePredicate, writableScopePredicate } from "../scoped-storage";

const log = createLogger("RenderStorage");

function renderVisiblePredicate(principal?: Principal | null): SQL | undefined {
  if (!principal) return sql`FALSE`;
  return visibleScopePredicate(principal, { ownerUserId: renderJobs.ownerUserId, accountId: renderJobs.accountId, scope: renderJobs.scope });
}

function renderWritablePredicate(principal?: Principal | null): SQL | undefined {
  if (!principal) return sql`FALSE`;
  return writableScopePredicate(principal, { ownerUserId: renderJobs.ownerUserId, accountId: renderJobs.accountId });
}

function withRenderOwner(job: InsertRenderJob, principal?: Principal | null): InsertRenderJob {
  if (!principal?.userId || !principal.accountId) return job;
  return { ...job, scope: "user", ownerUserId: principal.userId, accountId: principal.accountId, createdByUserId: principal.userId, updatedByUserId: principal.userId } as InsertRenderJob;
}

export async function createRenderJob(job: InsertRenderJob, principal?: Principal | null): Promise<RenderJob> {
  const { db } = await import("../db");
  const [row] = await db.insert(renderJobs).values(withRenderOwner(job, principal)).returning();
  log.log(`created render job: ${row.id} (${row.clipIds.length} clips)`);
  return row;
}

export async function getRenderJob(id: string, principal?: Principal | null): Promise<RenderJob | undefined> {
  const { db } = await import("../db");
  const visible = renderVisiblePredicate(principal);
  const [row] = await db.select().from(renderJobs).where(visible ? and(eq(renderJobs.id, id), visible) : eq(renderJobs.id, id));
  return row;
}

export async function updateRenderJob(id: string, updates: Partial<RenderJob>, principal?: Principal | null): Promise<RenderJob | undefined> {
  const { db } = await import("../db");
  const [row] = await db.update(renderJobs)
    .set({ ...updates, ...(principal?.userId ? { updatedByUserId: principal.userId } : {}), updatedAt: new Date() })
    .where(principal ? and(eq(renderJobs.id, id), renderWritablePredicate(principal) ?? sql`FALSE`) : eq(renderJobs.id, id))
    .returning();
  return row;
}

export async function listRenderJobs(limit = 20, principal?: Principal | null): Promise<RenderJob[]> {
  const { db } = await import("../db");
  const visible = renderVisiblePredicate(principal);
  return db.select().from(renderJobs)
    .where(visible)
    .orderBy(desc(renderJobs.createdAt))
    .limit(limit);
}
