import { db, pool } from "./db";
import { eq, desc, and, sql, lt, ne, inArray, gte, type SQL } from "drizzle-orm";
import {
  signalSources,
  signalItems,
  scanRuns,
  signalSourceScanDiagnostics,
  type SignalSource,
  type InsertSignalSource,
  type SignalItem,
  type InsertSignalItem,
  type ScanRun,
  type InsertScanRun,
  type InsertSignalSourceScanDiagnostics,
  type SignalSourceScanDiagnostics,
  type SignalItemStatus,
} from "@shared/schema";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const log = createLogger("SignalStorage");
const sourceScopeColumns = { scope: signalSources.scope, ownerUserId: signalSources.ownerUserId, accountId: signalSources.accountId, vaultId: signalSources.vaultId };
const itemScopeColumns = { scope: signalItems.scope, ownerUserId: signalItems.ownerUserId, accountId: signalItems.accountId, vaultId: signalItems.vaultId };
const scanScopeColumns = { scope: scanRuns.scope, ownerUserId: scanRuns.ownerUserId, accountId: scanRuns.accountId };
const sourceDiagnosticScopeColumns = { scope: signalSourceScanDiagnostics.scope, ownerUserId: signalSourceScanDiagnostics.ownerUserId, accountId: signalSourceScanDiagnostics.accountId };
const INVALID_X_GROK_STORY_URL_PATTERN = "https://x.com/i/articles/%";

function isInvalidXGrokStorySignal(data: Pick<InsertSignalItem, "sourceType" | "url" | "status">): boolean {
  return data.sourceType === "x"
    && data.status !== "saved"
    && data.url.startsWith("https://x.com/i/articles/");
}

function visibleSources(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), sourceScopeColumns, predicate); }
function writableSources(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), sourceScopeColumns, predicate); }
function visibleItems(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), itemScopeColumns, predicate); }
function writableItems(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), itemScopeColumns, predicate); }
function visibleScans(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), scanScopeColumns, predicate); }
function writableScans(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), scanScopeColumns, predicate); }
function visibleSourceDiagnostics(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), sourceDiagnosticScopeColumns, predicate); }

function normalizeSignalItemSourceTypes(sourceType: string): string[] {
  switch (sourceType) {
    case "channel_x": return ["x"];
    case "channel_web": return ["web"];
    case "subreddit": return ["reddit"];
    case "reddit": return ["reddit"];
    case "rss_feed": return ["rss"];
    case "rss": return ["rss"];
    default: return [sourceType];
  }
}

function normalizeSignalSourceTypes(sourceType: string): string[] {
  switch (sourceType) {
    case "reddit": return ["subreddit"];
    case "rss": return ["rss_feed"];
    default: return [sourceType];
  }
}

let schemaMigrated = false;

async function autoHeal<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if ((code === "42703" || code === "42P01") && !schemaMigrated) {
      log.debug(`auto-heal: migrating schema after column/relation error (${message})`);
      await migrateSignalSchema();
      schemaMigrated = true;
      try {
        return await operation();
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log.warn(`auto-heal: retry failed after migration (${retryMsg})`);
        throw retryErr;
      }
    }
    throw err;
  }
}

// ── Source CRUD ─────────────────────────────────────────────────────
export class SignalStorage {
  // ── Sources ────────────────────────────────────────────────────────
  async listSources(opts?: { sourceType?: string }): Promise<SignalSource[]> {
    return autoHeal(async () => {
      if (opts?.sourceType) {
        const sourceTypes = normalizeSignalSourceTypes(opts.sourceType);
        return db.select().from(signalSources)
          .where(visibleSources(sourceTypes.length === 1
            ? eq(signalSources.sourceType, sourceTypes[0])
            : inArray(signalSources.sourceType, sourceTypes)))
          .orderBy(signalSources.createdAt);
      }
      return db.select().from(signalSources).where(visibleSources()).orderBy(signalSources.createdAt);
    });
  }

  async getSource(id: string): Promise<SignalSource | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(signalSources).where(visibleSources(eq(signalSources.id, id)));
      return row;
    });
  }

  async addSource(data: InsertSignalSource): Promise<SignalSource> {
    return autoHeal(async () => {
      const [row] = await db.insert(signalSources).values({ ...data, ...ownedInsertValues(getCurrentPrincipalOrSystem(), sourceScopeColumns) }).returning();
      log.debug(`addSource type=${row.sourceType} value="${row.value}" id=${row.id}`);
      return row;
    });
  }

  async updateSource(id: string, updates: Partial<Pick<InsertSignalSource, "value" | "enabled" | "sourceType" | "cachedUserId">>): Promise<SignalSource | undefined> {
    return autoHeal(async () => {
      const [row] = await db.update(signalSources).set(updates)
        .where(writableSources(eq(signalSources.id, id))).returning();
      return row;
    });
  }

  async deleteSource(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const result = await db.delete(signalSources).where(writableSources(eq(signalSources.id, id))).returning();
      return result.length > 0;
    });
  }

  async touchSourceScan(id: string, newSignals: number): Promise<void> {
    await db.update(signalSources).set({
      lastScanAt: new Date(),
      signalCount: sql`${signalSources.signalCount} + ${newSignals}`,
    }).where(writableSources(eq(signalSources.id, id)));
  }

  async touchSourceAttempt(id: string, error?: string): Promise<void> {
    if (error) {
      await db.update(signalSources).set({
        lastAttemptedAt: new Date(),
        lastError: error,
        consecutiveFailures: sql`${signalSources.consecutiveFailures} + 1`,
      }).where(writableSources(eq(signalSources.id, id)));
    } else {
      await db.update(signalSources).set({
        lastAttemptedAt: new Date(),
        lastError: null,
        consecutiveFailures: 0,
      }).where(writableSources(eq(signalSources.id, id)));
    }
  }

  // ── Signal Items ───────────────────────────────────────────────────
  async listSignals(opts?: {
    status?: SignalItemStatus;
    sourceType?: string;
    limit?: number;
    offset?: number;
    minRelevance?: number;
    curationStatus?: string;
    hasCuration?: boolean;
    matchedTopic?: string;
    query?: string;
    createdAfter?: Date;
    createdBefore?: Date;
  }): Promise<{ items: SignalItem[]; total: number }> {
    return autoHeal(async () => {
      const conditions = [];
      if (opts?.status) conditions.push(eq(signalItems.status, opts.status));
      if (opts?.status === "surfaced") {
        conditions.push(sql`${signalItems.curatedTitle} IS NOT NULL AND ${signalItems.curatedReason} IS NOT NULL`);
      }
      if (opts?.sourceType) {
        const sourceTypes = normalizeSignalItemSourceTypes(opts.sourceType);
        conditions.push(sourceTypes.length === 1
          ? eq(signalItems.sourceType, sourceTypes[0])
          : inArray(signalItems.sourceType, sourceTypes));
      }
      if (opts?.minRelevance != null) {
        conditions.push(sql`${signalItems.relevanceScore} >= ${opts.minRelevance}`);
      }
      if (opts?.curationStatus) {
        conditions.push(eq(signalItems.curationStatus, opts.curationStatus));
      }
      if (opts?.hasCuration === true) {
        conditions.push(sql`${signalItems.curatedTitle} IS NOT NULL AND ${signalItems.curatedReason} IS NOT NULL`);
      } else if (opts?.hasCuration === false) {
        conditions.push(sql`${signalItems.curatedTitle} IS NULL OR ${signalItems.curatedReason} IS NULL`);
      }
      if (opts?.matchedTopic) {
        conditions.push(sql`${opts.matchedTopic} = ANY(${signalItems.matchedTopics})`);
      }
      if (opts?.query) {
        const pattern = `%${opts.query}%`;
        conditions.push(sql`(${signalItems.title} ILIKE ${pattern} OR ${signalItems.snippet} ILIKE ${pattern} OR ${signalItems.curatedTitle} ILIKE ${pattern} OR ${signalItems.curatedReason} ILIKE ${pattern})`);
      }
      if (opts?.createdAfter) conditions.push(gte(signalItems.scannedAt, opts.createdAfter));
      if (opts?.createdBefore) conditions.push(lt(signalItems.scannedAt, opts.createdBefore));

      const where = visibleItems(conditions.length > 0 ? and(...conditions) : undefined);
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;

      const countResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(signalItems)
        .where(where);
      const total = countResult[0]?.count ?? 0;

      const order = opts?.status === "surfaced"
        ? desc(signalItems.relevanceScore)
        : desc(sql`COALESCE(${signalItems.publishedAt}, ${signalItems.scannedAt})`);

      const items = await db.select().from(signalItems)
        .where(where)
        .orderBy(order)
        .limit(limit)
        .offset(offset);

      return { items, total };
    });
  }


  async getNewsSummary(): Promise<{
    scanRuns: ScanRun[];
    countsByStatus: Array<{ status: string; count: number }>;
    countsBySourceType: Array<{ sourceType: string; count: number }>;
    curation: { curated: number; uncurated: number; surfacedCurated: number; surfacedUncurated: number };
    latestSurfaced: SignalItem[];
  }> {
    return autoHeal(async () => {
      const [scanRuns, countsByStatus, countsBySourceType, [curation], latest] = await Promise.all([
        this.listScanRuns(5),
        db.select({ status: signalItems.status, count: sql<number>`count(*)::int` })
          .from(signalItems)
          .where(visibleItems())
          .groupBy(signalItems.status),
        db.select({ sourceType: signalItems.sourceType, count: sql<number>`count(*)::int` })
          .from(signalItems)
          .where(visibleItems())
          .groupBy(signalItems.sourceType),
        db.select({
          curated: sql<number>`count(*) filter (where ${signalItems.curatedTitle} is not null and ${signalItems.curatedReason} is not null)::int`,
          uncurated: sql<number>`count(*) filter (where ${signalItems.curatedTitle} is null or ${signalItems.curatedReason} is null)::int`,
          surfacedCurated: sql<number>`count(*) filter (where ${signalItems.status} = 'surfaced' and ${signalItems.curatedTitle} is not null and ${signalItems.curatedReason} is not null)::int`,
          surfacedUncurated: sql<number>`count(*) filter (where ${signalItems.status} = 'surfaced' and (${signalItems.curatedTitle} is null or ${signalItems.curatedReason} is null))::int`,
        }).from(signalItems).where(visibleItems()),
        this.listSignals({ status: "surfaced", limit: 10, hasCuration: true }),
      ]);
      return {
        scanRuns,
        countsByStatus,
        countsBySourceType,
        curation: curation ?? { curated: 0, uncurated: 0, surfacedCurated: 0, surfacedUncurated: 0 },
        latestSurfaced: latest.items,
      };
    });
  }

  async getSignal(id: string): Promise<SignalItem | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(signalItems).where(visibleItems(eq(signalItems.id, id)));
      return row;
    });
  }

  async upsertSignal(data: InsertSignalItem): Promise<{ item: SignalItem; isNew: boolean }> {
    return autoHeal(async () => {
      const normalizedData = isInvalidXGrokStorySignal(data)
        ? { ...data, status: "archived" as const }
        : data;

      // Try insert, on fingerprint conflict do nothing
      const result = await db.insert(signalItems)
        .values({ ...normalizedData, ...ownedInsertValues(getCurrentPrincipalOrSystem(), itemScopeColumns) })
        .onConflictDoNothing({ target: signalItems.fingerprint })
        .returning();
      if (result.length > 0) {
        return { item: result[0], isNew: true };
      }
      // Already existed. Refresh scan-owned fields, but preserve explicit user statuses.
      const [existing] = await db.select().from(signalItems)
        .where(visibleItems(eq(signalItems.fingerprint, normalizedData.fingerprint)));
      if (!existing) return { item: existing, isNew: false };
      const nextStatus = existing.status === "saved" || existing.status === "dismissed"
        ? existing.status
        : normalizedData.status;
      const [updated] = await db.update(signalItems)
        .set({
          sourceType: normalizedData.sourceType,
          sourceId: normalizedData.sourceId,
          url: normalizedData.url,
          title: normalizedData.title,
          snippet: normalizedData.snippet,
          agentSummary: normalizedData.agentSummary ?? existing.agentSummary,
          curatedTitle: normalizedData.curatedTitle ?? existing.curatedTitle,
          curatedReason: normalizedData.curatedReason ?? existing.curatedReason,
          curationStatus: normalizedData.curationStatus && normalizedData.curationStatus !== "unread" ? normalizedData.curationStatus : existing.curationStatus,
          curationScore: normalizedData.curationScore ?? existing.curationScore,
          matchedTopics: normalizedData.matchedTopics && normalizedData.matchedTopics.length > 0 ? normalizedData.matchedTopics : existing.matchedTopics,
          curatedAt: normalizedData.curatedAt ?? existing.curatedAt,
          publishedAt: normalizedData.publishedAt ?? existing.publishedAt,
          scannedAt: new Date(),
          relevanceScore: normalizedData.relevanceScore,
          relevanceTags: normalizedData.relevanceTags,
          matchingSkills: normalizedData.matchingSkills,
          matchingTheses: normalizedData.matchingTheses,
          status: nextStatus,
        })
        .where(writableItems(eq(signalItems.id, existing.id)))
        .returning();
      return { item: updated ?? existing, isNew: false };
    });
  }

  async updateSignalStatus(id: string, status: SignalItemStatus): Promise<SignalItem | undefined> {
    return autoHeal(async () => {
      const [row] = await db.update(signalItems)
        .set({ status })
        .where(writableItems(eq(signalItems.id, id)))
        .returning();
      return row;
    });
  }

  async surfaceSignal(id: string): Promise<SignalItem | undefined> {
    return autoHeal(async () => {
      const [row] = await db.update(signalItems)
        .set({ status: "surfaced", scannedAt: new Date() })
        .where(writableItems(eq(signalItems.id, id)))
        .returning();
      return row;
    });
  }

  async countSurfacedSince(since: Date): Promise<number> {
    return autoHeal(async () => {
      const [row] = await db.select({ count: sql<number>`count(*)::int` })
        .from(signalItems)
        .where(visibleItems(and(
          eq(signalItems.status, "surfaced"),
          sql`${signalItems.curatedTitle} IS NOT NULL AND ${signalItems.curatedReason} IS NOT NULL`,
          gte(signalItems.scannedAt, since),
        )));
      return row?.count ?? 0;
    });
  }

  async countSurfacedToday(timezone: string = "America/Chicago"): Promise<number> {
    return autoHeal(async () => {
      const todayStart = sql`date_trunc('day', now() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}`;
      const tomorrowStart = sql`(date_trunc('day', now() AT TIME ZONE ${timezone}) + interval '1 day') AT TIME ZONE ${timezone}`;
      const [row] = await db.select({ count: sql<number>`count(*)::int` })
        .from(signalItems)
        .where(visibleItems(and(
          eq(signalItems.status, "surfaced"),
          sql`${signalItems.curatedTitle} IS NOT NULL AND ${signalItems.curatedReason} IS NOT NULL`,
          sql`${signalItems.scannedAt} >= ${todayStart}`,
          sql`${signalItems.scannedAt} < ${tomorrowStart}`,
        )));
      return row?.count ?? 0;
    });
  }

  async dismissStaleSurfacedSignals(olderThanDays: number = 3): Promise<number> {
    return autoHeal(async () => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - olderThanDays);
      const result = await db.update(signalItems)
        .set({ status: "dismissed" })
        .where(writableItems(and(
          eq(signalItems.status, "surfaced"),
          lt(signalItems.scannedAt, cutoff),
        )))
        .returning();
      if (result.length > 0) {
        log.debug(`dismissed ${result.length} surfaced signals older than ${olderThanDays} days`);
      }
      return result.length;
    });
  }

  async archiveInvalidXArticleLinks(): Promise<number> {
    return autoHeal(async () => {
      const result = await db.update(signalItems)
        .set({ status: "archived" })
        .where(writableItems(and(
          eq(signalItems.sourceType, "x"),
          sql`${signalItems.url} LIKE ${INVALID_X_GROK_STORY_URL_PATTERN}`,
          ne(signalItems.status, "saved"),
        )))
        .returning();
      if (result.length > 0) {
        log.debug(`archived ${result.length} invalid X/Grok Story links using /i/articles URLs`);
      }
      return result.length;
    });
  }

  async enforceSurfaceLimits(opts: {
    maxPerDay?: number;
    dismissAfterDays?: number;
    timezone?: string;
  } = {}): Promise<{ staleDismissed: number; overflowDismissed: number }> {
    const maxPerDay = opts.maxPerDay ?? 3;
    const dismissAfterDays = opts.dismissAfterDays ?? 3;
    const timezone = opts.timezone ?? "America/Chicago";
    const staleDismissed = await this.dismissStaleSurfacedSignals(dismissAfterDays);

    return autoHeal(async () => {
      const surfaced = await db.select({
        id: signalItems.id,
        day: sql<string>`to_char(${signalItems.scannedAt} AT TIME ZONE ${timezone}, 'YYYY-MM-DD')`,
      })
        .from(signalItems)
        .where(visibleItems(eq(signalItems.status, "surfaced")))
        .orderBy(sql`date_trunc('day', ${signalItems.scannedAt} AT TIME ZONE ${timezone}) DESC`, desc(signalItems.relevanceScore));

      const keptPerDay = new Map<string, number>();
      const overflowIds: string[] = [];
      for (const item of surfaced) {
        const kept = keptPerDay.get(item.day) ?? 0;
        if (kept < maxPerDay) {
          keptPerDay.set(item.day, kept + 1);
        } else {
          overflowIds.push(item.id);
        }
      }

      if (overflowIds.length === 0) return { staleDismissed, overflowDismissed: 0 };

      const result = await db.update(signalItems)
        .set({ status: "dismissed" })
        .where(writableItems(inArray(signalItems.id, overflowIds)))
        .returning();
      log.debug(`dismissed ${result.length} surfaced signals over the ${maxPerDay}/day cap`);
      return { staleDismissed, overflowDismissed: result.length };
    });
  }

  async getRecentSessionTopics(opts: { days?: number; limit?: number } = {}): Promise<Array<{ value: string; mentions: number; lastSeenAt: Date }>> {
    const days = opts.days ?? 14;
    const limit = opts.limit ?? 40;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return autoHeal(async () => {
      const { sessionOutputBuffer } = await import("@shared/schema");
      const rows = await db.select({ topics: sessionOutputBuffer.topics, createdAt: sessionOutputBuffer.createdAt })
        .from(sessionOutputBuffer)
        .where(gte(sessionOutputBuffer.createdAt, cutoff))
        .orderBy(desc(sessionOutputBuffer.createdAt))
        .limit(200);
      const map = new Map<string, { value: string; mentions: number; lastSeenAt: Date }>();
      const generic = new Set(["ui", "api", "bug", "fix", "page", "app", "chat", "session", "spec", "design", "implementation", "review", "planning"]);
      for (const row of rows) {
        for (const raw of row.topics || []) {
          const value = String(raw || "").trim();
          if (!value || value.length < 3 || value.length > 60) continue;
          if (generic.has(value.toLowerCase())) continue;
          const key = value.toLowerCase();
          const existing = map.get(key);
          if (existing) {
            existing.mentions += 1;
            if (new Date(row.createdAt) > existing.lastSeenAt) existing.lastSeenAt = new Date(row.createdAt);
          } else {
            map.set(key, { value, mentions: 1, lastSeenAt: new Date(row.createdAt) });
          }
        }
      }
      return Array.from(map.values())
        .sort((a, b) => b.mentions - a.mentions || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .slice(0, limit);
    });
  }

  async archiveStaleSignals(olderThanDays: number = 30): Promise<number> {
    return autoHeal(async () => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - olderThanDays);
      const result = await db.update(signalItems)
        .set({ status: "archived" })
        .where(writableItems(and(
          lt(signalItems.scannedAt, cutoff),
          ne(signalItems.status, "archived"),
          ne(signalItems.status, "saved"),
        )))
        .returning();
      if (result.length > 0) {
        log.debug(`archived ${result.length} stale signals older than ${olderThanDays} days`);
      }
      return result.length;
    });
  }

  // ── Scan Runs ──────────────────────────────────────────────────────
  async startScanRun(): Promise<ScanRun> {
    return autoHeal(async () => {
      const [row] = await db.insert(scanRuns).values(ownedInsertValues(getCurrentPrincipalOrSystem(), scanScopeColumns)).returning();
      log.debug(`startScanRun id=${row.id}`);
      return row;
    });
  }

  async completeScanRun(id: string, stats: {
    sourcesScanned: number;
    itemsFound: number;
    itemsSurfaced: number;
    itemsDeduped: number;
    error?: string;
  }): Promise<ScanRun | undefined> {
    return autoHeal(async () => {
      const [row] = await db.update(scanRuns).set({
        completedAt: new Date(),
        ...stats,
      }).where(writableScans(eq(scanRuns.id, id))).returning();
      log.debug(`completeScanRun id=${id} found=${stats.itemsFound} surfaced=${stats.itemsSurfaced} deduped=${stats.itemsDeduped}`);
      return row;
    });
  }

  async listScanRuns(limit: number = 20): Promise<ScanRun[]> {
    return autoHeal(async () => {
      return db.select().from(scanRuns)
        .where(visibleScans())
        .orderBy(desc(scanRuns.startedAt))
        .limit(limit);
    });
  }


  async saveSourceScanDiagnostics(rows: InsertSignalSourceScanDiagnostics[]): Promise<void> {
    if (rows.length === 0) return;
    await autoHeal(async () => {
      await db.insert(signalSourceScanDiagnostics).values(rows.map(row => ({
        ...row,
        ...ownedInsertValues(getCurrentPrincipalOrSystem(), sourceDiagnosticScopeColumns),
      })));
      log.debug(`saveSourceScanDiagnostics rows=${rows.length}`);
    });
  }

  async listSourceScanDiagnostics(scanRunId: string): Promise<SignalSourceScanDiagnostics[]> {
    return autoHeal(async () => {
      return db.select().from(signalSourceScanDiagnostics)
        .where(visibleSourceDiagnostics(eq(signalSourceScanDiagnostics.scanRunId, scanRunId)))
        .orderBy(desc(signalSourceScanDiagnostics.startedAt));
    });
  }

  async hasInProgressScan(): Promise<boolean> {
    const STALE_SCAN_TTL_MS = 10 * 60 * 1000; // 10 minutes
    return autoHeal(async () => {
      const [row] = await db
        .select({ id: scanRuns.id, startedAt: scanRuns.startedAt })
        .from(scanRuns)
        .where(visibleScans(sql`${scanRuns.completedAt} IS NULL`))
        .limit(1);
      if (!row) return false;
      // Auto-expire scans that exceed the TTL (e.g. interrupted by deployment)
      const age = Date.now() - new Date(row.startedAt).getTime();
      if (age > STALE_SCAN_TTL_MS) {
        await db
          .update(scanRuns)
          .set({
            completedAt: new Date(),
            error: `Auto-expired: scan exceeded ${STALE_SCAN_TTL_MS / 60_000}-minute TTL`,
          })
          .where(writableScans(eq(scanRuns.id, row.id)));
        log.warn(`hasInProgressScan: auto-expired stale scan id=${row.id} age=${Math.round(age / 1000)}s`);
        return false;
      }
      return true;
    });
  }

  async cancelScanRun(id: string): Promise<ScanRun | undefined> {
    return autoHeal(async () => {
      const [row] = await db.update(scanRuns).set({
        completedAt: new Date(),
        error: "Cancelled by user",
      }).where(writableScans(and(eq(scanRuns.id, id), sql`${scanRuns.completedAt} IS NULL`))).returning();
      if (row) log.debug(`cancelScanRun id=${id}`);
      return row;
    });
  }

  // ── Channel / Topic Migration ──────────────────────────────────────
  async migrateChannelsAndTopics(): Promise<void> {
    return autoHeal(async () => {
      // 1. Ensure channel_x singleton exists
      const existingChX = await db.select().from(signalSources)
        .where(visibleSources(eq(signalSources.sourceType, "channel_x"))).limit(1);
      if (existingChX.length === 0) {
        await db.insert(signalSources).values({ sourceType: "channel_x", value: "X Search", enabled: true, ...ownedInsertValues(getCurrentPrincipalOrSystem(), sourceScopeColumns) });
        log.debug("migrateChannelsAndTopics: created channel_x");
      }

      // 2. Ensure channel_web singleton exists
      const existingChWeb = await db.select().from(signalSources)
        .where(visibleSources(eq(signalSources.sourceType, "channel_web"))).limit(1);
      if (existingChWeb.length === 0) {
        await db.insert(signalSources).values({ sourceType: "channel_web", value: "Web Search", enabled: true, ...ownedInsertValues(getCurrentPrincipalOrSystem(), sourceScopeColumns) });
        log.debug("migrateChannelsAndTopics: created channel_web");
      }


    });
  }
}

export const signalStorage = new SignalStorage();

// ── Schema Migration ───────────────────────────────────────────────
export async function migrateSignalSchema(): Promise<void> {
  const migrations = [
    `CREATE TABLE IF NOT EXISTS signal_sources (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       source_type text NOT NULL,
       value text NOT NULL,
       enabled boolean NOT NULL DEFAULT true,
       last_scan_at timestamptz,
       signal_count integer NOT NULL DEFAULT 0,
       created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS signal_items (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       source_type text NOT NULL,
       source_id text REFERENCES signal_sources(id),
       url text NOT NULL,
       title text NOT NULL,
       snippet text NOT NULL DEFAULT '',
       agent_summary text,
       curated_title text,
       curated_reason text,
       curation_status text NOT NULL DEFAULT 'unread',
       curation_score real,
       matched_topics text[] NOT NULL DEFAULT '{}'::text[],
       curated_at timestamptz,
       published_at timestamptz,
       scanned_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
       relevance_score real NOT NULL DEFAULT 0,
       relevance_tags text[] NOT NULL DEFAULT '{}'::text[],
       matching_skills text[] NOT NULL DEFAULT '{}'::text[],
       matching_theses text[] NOT NULL DEFAULT '{}'::text[],
       fingerprint text NOT NULL UNIQUE,
       status text NOT NULL DEFAULT 'new',
       created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    // CREATE TABLE IF NOT EXISTS does not add columns to pre-existing tables —
    // patch agent_summary onto installs created before the column existed.
    `ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS agent_summary text`,
    `ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS curated_title text`,
    `ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS curated_reason text`,
    `ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS curation_status text NOT NULL DEFAULT 'unread'`,
    `ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS curation_score real`,
    `ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS matched_topics text[] NOT NULL DEFAULT '{}'::text[]`,
    `ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS curated_at timestamptz`,
    `ALTER TABLE signal_sources ADD COLUMN IF NOT EXISTS last_attempted_at timestamptz`,
    `ALTER TABLE signal_sources ADD COLUMN IF NOT EXISTS last_error text`,
    `ALTER TABLE signal_sources ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0`,
    `ALTER TABLE signal_sources ADD COLUMN IF NOT EXISTS cached_user_id text`,
    `ALTER TABLE signal_sources ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user'`,
    `ALTER TABLE signal_sources ADD COLUMN IF NOT EXISTS owner_user_id text`,
    `ALTER TABLE signal_sources ADD COLUMN IF NOT EXISTS account_id text`,
    `ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user'`,
    `ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS owner_user_id text`,
    `ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS account_id text`,
    `CREATE INDEX IF NOT EXISTS idx_signal_sources_scope_owner ON signal_sources(scope, owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_signal_sources_account ON signal_sources(account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_signal_items_scope_owner ON signal_items(scope, owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_signal_items_account ON signal_items(account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_signal_items_status ON signal_items(status)`,
    `CREATE INDEX IF NOT EXISTS idx_signal_items_relevance ON signal_items(relevance_score DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_signal_items_scanned ON signal_items(scanned_at DESC)`,
    `CREATE TABLE IF NOT EXISTS scan_runs (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
       completed_at timestamptz,
       sources_scanned integer NOT NULL DEFAULT 0,
       items_found integer NOT NULL DEFAULT 0,
       items_surfaced integer NOT NULL DEFAULT 0,
       items_deduped integer NOT NULL DEFAULT 0,
       error text
     )`,
    `ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user'`,
    `ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS owner_user_id text`,
    `ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS account_id text`,
    `CREATE INDEX IF NOT EXISTS idx_scan_runs_scope_owner ON scan_runs(scope, owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_scan_runs_account ON scan_runs(account_id)`,
    `CREATE TABLE IF NOT EXISTS signal_source_scan_diagnostics (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       scan_run_id text NOT NULL REFERENCES scan_runs(id),
       source_id text REFERENCES signal_sources(id),
       source_type text NOT NULL,
       source_value text NOT NULL,
       adapter_status text NOT NULL,
       fetched_count integer NOT NULL DEFAULT 0,
       accepted_count integer NOT NULL DEFAULT 0,
       rejected_count integer NOT NULL DEFAULT 0,
       persisted_count integer NOT NULL DEFAULT 0,
       surfaced_count integer NOT NULL DEFAULT 0,
       deduped_count integer NOT NULL DEFAULT 0,
       rejected_by_reason jsonb NOT NULL DEFAULT '{}'::jsonb,
       last_error text,
       started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
       completed_at timestamptz,
       scope text NOT NULL DEFAULT 'user',
       owner_user_id text,
       account_id text
     )`,
    `CREATE INDEX IF NOT EXISTS idx_signal_source_diag_scan_run ON signal_source_scan_diagnostics(scan_run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_signal_source_diag_source_started ON signal_source_scan_diagnostics(source_id, started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_signal_source_diag_scope_owner ON signal_source_scan_diagnostics(scope, owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_signal_source_diag_account ON signal_source_scan_diagnostics(account_id)`,
  ];
  for (const sqlStr of migrations) {
    try {
      await pool.query(sqlStr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("migration failed:", msg, "sql:", sqlStr.slice(0, 80));
    }
  }
  log.debug("signal schema migration complete");
}
