import { Router, type Request, type Response } from "express";
import { registerMediaItem, listMediaItems, getMediaItem, deleteMediaItem, updateMediaItem, backfillMediaFromStorage } from "./media-storage";
import { extractThumbnail, probeFile, isAvailable, getBinaryPaths } from "./ffmpeg-service";
import { createLogger } from "../log";
import { storageBackend } from "../object_storage/s3-backend";
import { requireAuth, requireAdmin } from "../auth";
import { getPrincipal } from "../principal";
import { setObjectAclPolicy } from "../object_storage/objectAcl";

const log = createLogger("MediaRoutes");
const router = Router();

// GET /api/media — list with filters
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const { type, source, search, limit, offset } = req.query;
    const principal = getPrincipal(req);
    const result = await listMediaItems({
      type: type as string | undefined,
      source: source as string | undefined,
      search: search as string | undefined,
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    }, principal);
    res.json(result);
  } catch (err: any) {
    log.error(`[Media] list error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/media/:id — single item
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const item = await getMediaItem(req.params.id, getPrincipal(req));
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (err: any) {
    log.error(`[Media] get error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/media/register — register uploaded/generated media
router.post("/register", requireAuth, async (req: Request, res: Response) => {
  try {
    const principal = getPrincipal(req);
    if (!principal?.userId || !principal.accountId) return res.status(403).json({ error: "User principal required" });
    const { name, mediaType, source, objectPath, mimeType, fileSize, width, height, duration, metadata } = req.body;
    log.log(`[Media] register request: name="${name}" type=${mediaType} source=${source} path=${objectPath} mime=${mimeType} size=${fileSize}`);
    if (!name || !mediaType || !source || !objectPath || !mimeType) {
      log.warn(`[Media] register rejected: missing fields — name=${!!name} mediaType=${!!mediaType} source=${!!source} objectPath=${!!objectPath} mimeType=${!!mimeType}`);
      return res.status(400).json({ error: "Missing required fields: name, mediaType, source, objectPath, mimeType" });
    }

    const item = await registerMediaItem({
      name,
      mediaType,
      source,
      objectPath,
      mimeType,
      fileSize: fileSize || null,
      width: width || null,
      height: height || null,
      duration: duration || null,
      metadata: metadata || null,
    }, principal);

    const key = objectPath.startsWith("/objects/") ? `private/${objectPath.slice("/objects/".length)}` : objectPath;
    await setObjectAclPolicy(key, { owner: principal.userId, ownerUserId: principal.userId, accountId: principal.accountId, createdByUserId: principal.userId, scope: "user", visibility: "private" });

    // If video + FFmpeg available, generate thumbnail asynchronously
    if (mediaType === "video" && isAvailable()) {
      generateThumbnailAsync(item.id, item.objectPath, principal).catch((err) => {
        log.warn(`[Media] thumbnail generation failed for ${item.id}: ${err.message}`);
      });
    }

    // If image + FFmpeg available, generate resized thumbnail asynchronously
    if (mediaType === "image" && isAvailable()) {
      generateImageThumbnailAsync(item.id, item.objectPath, principal).catch((err) => {
        log.warn(`[Media] image thumbnail generation failed for ${item.id}: ${err.message}`);
      });
    }

    res.status(201).json(item);
  } catch (err: any) {
    log.error(`[Media] register error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/media/:id — update item (e.g. rename)
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "name is required" });
    }
    const item = await updateMediaItem(req.params.id, { name: name.trim() } as any, getPrincipal(req));
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (err: any) {
    log.error(`[Media] update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/media/:id — delete item
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const objectPath = await deleteMediaItem(req.params.id, getPrincipal(req));
    if (!objectPath) return res.status(404).json({ error: "Not found" });
    // Queue object storage cleanup (best effort)
    try {
      const key = objectPath.startsWith("/objects/") ? `private/${objectPath.slice("/objects/".length)}` : objectPath;
      await storageBackend.deleteObject(key);
    } catch (cleanupErr: any) {
      log.warn(`[Media] object cleanup failed for ${objectPath}: ${cleanupErr.message}`);
    }
    res.json({ deleted: true });
  } catch (err: any) {
    log.error(`[Media] delete error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/media/backfill — scan S3 and register untracked media files
router.post("/backfill", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    log.log("[Media] backfill started");
    const result = await backfillMediaFromStorage();
    log.log(`[Media] backfill done: scanned=${result.scanned} registered=${result.registered}`);
    res.json(result);
  } catch (err: any) {
    log.error(`[Media] backfill error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/media/health — FFmpeg availability check
router.get("/health/ffmpeg", async (_req: Request, res: Response) => {
  res.json({ available: isAvailable() });
});

async function generateThumbnailAsync(mediaId: string, objectPath: string, principal?: ReturnType<typeof getPrincipal>): Promise<void> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const os = await import("os");

  const tmpDir = path.join(os.tmpdir(), `thumb-${mediaId}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    // Download video from object storage
    const key = objectPath.startsWith("/objects/") ? `private/${objectPath.slice("/objects/".length)}` : objectPath;
    const buffer = await storageBackend.getObjectBuffer(key);
    const inputPath = path.join(tmpDir, "input.mp4");
    await fs.writeFile(inputPath, buffer);

    // Extract thumbnail
    const thumbFilename = "thumb.jpg";
    const thumbPath = path.join(tmpDir, thumbFilename);
    await extractThumbnail(inputPath, thumbPath, 1);

    // Upload thumbnail to object storage
    const thumbBuffer = await fs.readFile(thumbPath);
    const thumbKey = `private/uploads/thumbs/${mediaId}.jpg`;
    await storageBackend.putObject(thumbKey, thumbBuffer, "image/jpeg");

    // Set ACL so thumbnails are accessible
    const { setObjectAclPolicy } = await import("../object_storage/objectAcl");
    await setObjectAclPolicy(thumbKey, principal?.userId ? { owner: principal.userId, ownerUserId: principal.userId, accountId: principal.accountId ?? null, createdByUserId: principal.userId, scope: "user", visibility: "private" } : { owner: "system", scope: "system", visibility: "private" });

    // Update media item with thumbnail path
    const thumbObjectPath = `/objects/uploads/thumbs/${mediaId}.jpg`;
    await updateMediaItem(mediaId, { thumbPath: thumbObjectPath } as any, principal);
    log.log(`[Media] thumbnail generated for ${mediaId}: ${thumbObjectPath}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function generateImageThumbnailAsync(mediaId: string, objectPath: string, principal?: ReturnType<typeof getPrincipal>): Promise<void> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const os = await import("os");

  const tmpDir = path.join(os.tmpdir(), `img-thumb-${mediaId}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const key = objectPath.startsWith("/objects/") ? `private/${objectPath.slice("/objects/".length)}` : objectPath;
    const buffer = await storageBackend.getObjectBuffer(key);

    const ext = path.extname(objectPath).toLowerCase() || ".png";
    const inputPath = path.join(tmpDir, `input${ext}`);
    await fs.writeFile(inputPath, buffer);

    const thumbPath = path.join(tmpDir, "thumb.jpg");

    const bins = getBinaryPaths();
    if (!bins) throw new Error("FFmpeg not available");

    const ffmpeg = require("fluent-ffmpeg") as typeof import("fluent-ffmpeg");
    ffmpeg.setFfmpegPath(bins.ffmpegPath);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(["-vf", "scale=400:-1", "-q:v", "5"])
        .output(thumbPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });

    const thumbBuffer = await fs.readFile(thumbPath);
    const thumbKey = `private/uploads/thumbs/${mediaId}.jpg`;
    await storageBackend.putObject(thumbKey, thumbBuffer, "image/jpeg");

    // Set ACL so thumbnails are accessible
    const { setObjectAclPolicy } = await import("../object_storage/objectAcl");
    await setObjectAclPolicy(thumbKey, principal?.userId ? { owner: principal.userId, ownerUserId: principal.userId, accountId: principal.accountId ?? null, createdByUserId: principal.userId, scope: "user", visibility: "private" } : { owner: "system", scope: "system", visibility: "private" });

    const thumbObjectPath = `/objects/uploads/thumbs/${mediaId}.jpg`;
    await updateMediaItem(mediaId, { thumbPath: thumbObjectPath } as any, principal);
    log.log(`[Media] image thumbnail generated for ${mediaId}: ${thumbObjectPath}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function generateImageThumbnailsForBackfill(): Promise<void> {
  if (!isAvailable()) return;
  const items = await listMediaItems({ type: "image", limit: 500, offset: 0 });
  const needsThumbs = items.items.filter((i) => !i.thumbPath);
  log.log(`[Media] generating thumbnails for ${needsThumbs.length} images`);
  for (const item of needsThumbs) {
    try {
      await generateImageThumbnailAsync(item.id, item.objectPath);
    } catch (err: any) {
      log.warn(`[Media] thumbnail failed for ${item.id}: ${err.message}`);
    }
  }
}

export default router;
