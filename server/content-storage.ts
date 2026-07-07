import { db } from "./db";
import { contentQueue, type ContentQueue, type InsertContent } from "@shared/schema";
import { eq, desc, sql, and, lte, type SQL } from "drizzle-orm";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const log = createLogger("ContentStorage");
const contentScopeColumns = { scope: contentQueue.scope, ownerUserId: contentQueue.ownerUserId, accountId: contentQueue.accountId };
function visibleContent(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), contentScopeColumns, predicate); }
function writableContent(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), contentScopeColumns, predicate); }

export async function listContent(filters?: {
  status?: string;
  platform?: string;
  limit?: number;
  offset?: number;
}): Promise<ContentQueue[]> {
  const conditions = [];
  if (filters?.status) conditions.push(eq(contentQueue.status, filters.status));
  if (filters?.platform) conditions.push(eq(contentQueue.platform, filters.platform));

  const predicate = conditions.length > 0 ? and(...conditions) : undefined;
  const query = db.select().from(contentQueue).where(visibleContent(predicate));

  const rows = await query
    .orderBy(desc(contentQueue.createdAt))
    .limit(filters?.limit ?? 100)
    .offset(filters?.offset ?? 0);

  return rows;
}

export async function getContent(id: string): Promise<ContentQueue | undefined> {
  const [row] = await db.select().from(contentQueue).where(visibleContent(eq(contentQueue.id, id)));
  return row;
}

export async function createContent(data: InsertContent): Promise<ContentQueue> {
  const [row] = await db.insert(contentQueue).values({
    ...data,
    status: data.status ?? "draft",
    platform: data.platform ?? "x",
    ...ownedInsertValues(getCurrentPrincipalOrSystem(), contentScopeColumns),
  }).returning();
  return row;
}

export async function updateContent(id: string, updates: Partial<ContentQueue>): Promise<ContentQueue | undefined> {
  const [row] = await db.update(contentQueue)
    .set({ ...updates, updatedAt: new Date() })
    .where(writableContent(eq(contentQueue.id, id)))
    .returning();
  return row;
}

export async function deleteContent(id: string): Promise<boolean> {
  const [row] = await db.delete(contentQueue).where(writableContent(eq(contentQueue.id, id))).returning();
  return !!row;
}

export async function claimContentForPublish(): Promise<ContentQueue[]> {
  const rows = await db.execute(sql`
    UPDATE content_queue
    SET status = 'publishing', updated_at = NOW()
    WHERE id IN (
      SELECT id FROM content_queue
      WHERE status = 'scheduled'
        AND scheduled_at <= NOW()
        AND retry_count < 3
      ORDER BY scheduled_at
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  log.debug(`claimContentForPublish: claimed ${(rows.rows || []).length} post(s)`);
  return (rows.rows || []) as ContentQueue[];
}

export async function resetStalePublishing(): Promise<number> {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const rows = await db.update(contentQueue)
    .set({ status: "scheduled", updatedAt: new Date() })
    .where(
      and(
        eq(contentQueue.status, "publishing"),
        lte(contentQueue.updatedAt, tenMinutesAgo)
      )
    )
    .returning();
  if (rows.length > 0) {
    log.debug(`Reset ${rows.length} stale publishing rows back to scheduled`);
  }
  return rows.length;
}

export async function batchApprove(
  items: Array<{ id: string; scheduledAt: string }>
): Promise<ContentQueue[]> {
  const results: ContentQueue[] = [];
  for (const item of items) {
    const [row] = await db.update(contentQueue)
      .set({
        status: "scheduled",
        scheduledAt: new Date(item.scheduledAt),
        updatedAt: new Date(),
      })
      .where(eq(contentQueue.id, item.id))
      .returning();
    if (row) results.push(row);
  }
  return results;
}

export async function getScheduledPostsInRange(
  startDate: string,
  endDate: string
): Promise<ContentQueue[]> {
  return db.select().from(contentQueue)
    .where(
      visibleContent(and(
        eq(contentQueue.status, "scheduled"),
        sql`${contentQueue.scheduledAt} >= ${new Date(startDate)}`,
        sql`${contentQueue.scheduledAt} <= ${new Date(endDate)}`
      ))
    )
    .orderBy(contentQueue.scheduledAt);
}
