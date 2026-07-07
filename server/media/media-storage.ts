import { eq, desc, ilike, and, sql, type SQL } from "drizzle-orm";
import { mediaItems, type MediaItem, type InsertMediaItem } from "@shared/schema";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { visibleScopePredicate, writableScopePredicate } from "../scoped-storage";

const log = createLogger("MediaStorage");

export interface ListMediaOptions {
  type?: string;
  source?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function registerMediaItem(item: InsertMediaItem, principal?: Principal | null): Promise<MediaItem> {
  const { db } = await import("../db");
  const [row] = await db.insert(mediaItems)
    .values(withMediaOwner(item, principal))
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // Conflict on objectPath — return existing
    const [existing] = await db.select().from(mediaItems)
      .where(eq(mediaItems.objectPath, item.objectPath));
    if (existing) return existing;
    throw new Error("Failed to register media item");
  }
  log.log(`registered media item: ${row.id} (${row.mediaType}, ${row.source})`);
  return row;
}

function withMediaOwner(item: InsertMediaItem, principal?: Principal | null): InsertMediaItem {
  if (!principal?.userId || !principal.accountId) return item;
  return {
    ...item,
    scope: "user",
    ownerUserId: item.ownerUserId ?? principal.userId,
    accountId: item.accountId ?? principal.accountId,
    createdByUserId: item.createdByUserId ?? principal.userId,
    updatedByUserId: item.updatedByUserId ?? principal.userId,
  } as InsertMediaItem;
}

function mediaVisiblePredicate(principal?: Principal | null): SQL | undefined {
  if (!principal) return sql`FALSE`;
  return visibleScopePredicate(principal, {
    ownerUserId: mediaItems.ownerUserId,
    accountId: mediaItems.accountId,
    scope: mediaItems.scope,
  });
}

function mediaWritablePredicate(principal?: Principal | null): SQL | undefined {
  if (!principal) return sql`FALSE`;
  return writableScopePredicate(principal, {
    ownerUserId: mediaItems.ownerUserId,
    accountId: mediaItems.accountId,
  });
}

export async function listMediaItems(opts: ListMediaOptions = {}, principal?: Principal | null): Promise<{ items: MediaItem[]; total: number }> {
  const { db } = await import("../db");
  const { limit = 50, offset = 0 } = opts;

  const conditions: SQL[] = [];
  if (opts.type) conditions.push(eq(mediaItems.mediaType, opts.type));
  if (opts.source) conditions.push(eq(mediaItems.source, opts.source));
  if (opts.search) conditions.push(ilike(mediaItems.name, `%${opts.search}%`));
  const visible = mediaVisiblePredicate(principal);
  if (visible) conditions.push(visible);

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [items, countResult] = await Promise.all([
    db.select().from(mediaItems)
      .where(where)
      .orderBy(desc(mediaItems.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(mediaItems).where(where),
  ]);

  return { items, total: countResult[0]?.count ?? 0 };
}

export async function getMediaItem(id: string, principal?: Principal | null): Promise<MediaItem | undefined> {
  const { db } = await import("../db");
  const visible = mediaVisiblePredicate(principal);
  const where = visible ? and(eq(mediaItems.id, id), visible) : eq(mediaItems.id, id);
  const [row] = await db.select().from(mediaItems).where(where);
  return row;
}

export async function updateMediaItem(id: string, updates: Partial<InsertMediaItem>, principal?: Principal | null): Promise<MediaItem | undefined> {
  const { db } = await import("../db");
  const [row] = await db.update(mediaItems)
    .set({ ...updates, ...(principal?.userId ? { updatedByUserId: principal.userId } : {}), updatedAt: new Date() })
    .where(and(eq(mediaItems.id, id), mediaWritablePredicate(principal) ?? sql`TRUE`))
    .returning();
  return row;
}

/**
 * Scan object storage for media files and register any that aren't already in the DB.
 * Safe to run repeatedly — onConflictDoNothing handles dedup.
 */
export async function backfillMediaFromStorage(): Promise<{ scanned: number; registered: number }> {
  const { storageBackend } = await import("../object_storage/s3-backend");
  if (!storageBackend.isConfigured()) {
    log.log("backfill skipped: S3 not configured");
    return { scanned: 0, registered: 0 };
  }

  const MEDIA_EXTENSIONS: Record<string, { mediaType: string; mimeType: string }> = {
    ".png": { mediaType: "image", mimeType: "image/png" },
    ".jpg": { mediaType: "image", mimeType: "image/jpeg" },
    ".jpeg": { mediaType: "image", mimeType: "image/jpeg" },
    ".gif": { mediaType: "image", mimeType: "image/gif" },
    ".webp": { mediaType: "image", mimeType: "image/webp" },
    ".svg": { mediaType: "image", mimeType: "image/svg+xml" },
    ".mp4": { mediaType: "video", mimeType: "video/mp4" },
    ".webm": { mediaType: "video", mimeType: "video/webm" },
    ".mov": { mediaType: "video", mimeType: "video/quicktime" },
    ".mp3": { mediaType: "audio", mimeType: "audio/mpeg" },
    ".wav": { mediaType: "audio", mimeType: "audio/wav" },
    ".ogg": { mediaType: "audio", mimeType: "audio/ogg" },
  };

  // Scan all private/ prefixes where media lives
  const prefixes = ["private/uploads/", "private/generated/", "private/images/", "private/media/"];
  let scanned = 0;
  let registered = 0;

  for (const prefix of prefixes) {
    let objects;
    try {
      objects = await storageBackend.listObjects(prefix, { maxKeys: 1000 });
    } catch (err: any) {
      log.warn(`backfill: failed to list ${prefix}: ${err.message}`);
      continue;
    }

    for (const obj of objects) {
      scanned++;
      // Skip thumbnail files and directories
      if (obj.key.includes("/thumbs/") || obj.key.endsWith("/") || obj.size === 0) continue;

      const ext = obj.key.substring(obj.key.lastIndexOf(".")).toLowerCase();
      const mediaInfo = MEDIA_EXTENSIONS[ext];
      if (!mediaInfo) continue;

      // Map S3 key to the objectPath the app uses: private/X → /objects/X
      const objectPath = "/objects/" + obj.key.replace(/^private\//, "");
      const name = obj.key.split("/").pop() || "Unknown";

      try {
        await registerMediaItem({
          name,
          mediaType: mediaInfo.mediaType,
          source: "generated", // best guess for pre-existing files
          objectPath,
          mimeType: mediaInfo.mimeType,
          fileSize: obj.size || null,
          width: null,
          height: null,
          duration: null,
          metadata: null,
        });
        registered++;
      } catch (err: any) {
        // onConflictDoNothing handles dupes, this catches other errors
        log.warn(`backfill: failed to register ${obj.key}: ${err.message}`);
      }
    }
  }

  log.log(`backfill complete: scanned=${scanned} registered=${registered}`);

  // Generate thumbnails for images without them (async, non-blocking)
  if (registered > 0) {
    const { generateImageThumbnailsForBackfill } = await import("./media-routes");
    generateImageThumbnailsForBackfill().catch((err) => {
      log.warn(`[Media] backfill thumbnail generation failed: ${err.message}`);
    });
  }

  // Ensure all existing thumbnails have ACL policies
  try {
    const { setObjectAclPolicy, getObjectAclPolicy } = await import("../object_storage/objectAcl");
    const allItems = await listMediaItems({ limit: 1000, offset: 0 });
    let aclFixed = 0;
    for (const item of allItems.items) {
      if (item.thumbPath) {
        const thumbKey = item.thumbPath.startsWith("/objects/")
          ? `private/${item.thumbPath.slice("/objects/".length)}`
          : item.thumbPath;
        const existing = await getObjectAclPolicy(thumbKey);
        if (!existing) {
          await setObjectAclPolicy(thumbKey, { owner: "system", visibility: "public" });
          aclFixed++;
        }
      }
    }
    if (aclFixed > 0) {
      log.log(`[Media] backfill: set ACL on ${aclFixed} thumbnails`);
    }
  } catch (err: any) {
    log.warn(`[Media] backfill ACL pass failed: ${err.message}`);
  }

  return { scanned, registered };
}

export async function deleteMediaItem(id: string, principal?: Principal | null): Promise<string | undefined> {
  const { db } = await import("../db");
  const [row] = await db.delete(mediaItems).where(and(eq(mediaItems.id, id), mediaWritablePredicate(principal) ?? sql`TRUE`)).returning();
  if (row) {
    log.log(`deleted media item: ${row.id}`);
    return row.objectPath;
  }
  return undefined;
}
