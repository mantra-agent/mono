import type { Express } from "express";
import multer from "multer";
import { extname } from "path";
import { readFile, unlink } from "fs/promises";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { ObjectPermission } from "./objectAcl";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { getPrincipal } from "../principal";

const log = createLogger("ObjectStorage");

const fileUpload = multer({
  dest: "/tmp/media-uploads/",
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 8 }, // 100 MB proxy budget; larger media uses presigned upload
});

export function registerObjectStorageRoutes(app: Express): void {
  const objectStorageService = new ObjectStorageService();

  // ── Server-proxied upload (eliminates CORS issues with R2/S3) ──────
  app.post("/api/uploads/file", requireAuth, (req, res) => {
    fileUpload.single("file")(req, res, async (err: any) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const tmpPath = req.file.path;
      try {
        const principal = getPrincipal(req);
        if (!principal?.userId || !principal.accountId) return res.status(403).json({ error: "User principal required" });
        const fileBuffer = await readFile(tmpPath);
        const uploaded = await objectStorageService.uploadObjectEntity(fileBuffer, {
          extension: extname(req.file.originalname) || undefined,
          contentType: req.file.mimetype || "application/octet-stream",
          category: "uploads",
          principal,
          acl: {
            owner: principal.userId,
            ownerUserId: principal.userId,
            accountId: principal.accountId,
            createdByUserId: principal.userId,
            scope: "user",
            visibility: "private",
          },
        });

        try {
          await unlink(tmpPath);
        } catch (cleanupError) {
          log.warn(`[Upload] proxy temp cleanup failed: name="${req.file.originalname}" error=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }

        log.log(`[Upload] proxy OK: name="${req.file.originalname}" objectPath=${uploaded.objectPath}`);
        res.json({ objectPath: uploaded.objectPath });
      } catch (error) {
        try { await unlink(tmpPath); } catch {}
        const message = error instanceof Error ? error.message : "Upload failed";
        log.error(`[Upload] proxy FAILED: ${message}`);
        res.status(500).json({ error: message });
      }
    });
  });

  // ── Legacy presigned URL endpoint (kept for backwards compat) ──────
  app.post("/api/uploads/request-url", requireAuth, async (req, res) => {
    try {
      const { name, size, contentType } = req.body;
      const principal = getPrincipal(req);
      log.log(`[Upload] presign request: name="${name}" size=${size} contentType=${contentType} actor=${principal?.actorType} userId=${principal?.userId}`);
      if (!name) {
        log.warn("[Upload] presign rejected: missing name");
        return res.status(400).json({ error: "Missing required field: name" });
      }

      const ext = (await import("path")).extname(name);
      if (!principal?.userId || !principal.accountId) return res.status(403).json({ error: "User principal required" });
      const uploadURL = await objectStorageService.getObjectEntityUploadURL(
        ext || undefined,
        { ownerUserId: principal.userId, accountId: principal.accountId, contentType: contentType || undefined, prefix: `users/${principal.userId}/uploads`, principal },
      );
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
      log.log(`[Upload] presign OK: name="${name}" objectPath=${objectPath}`);

      res.json({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate upload URL";
      const isConfigError = message.startsWith("Object storage not configured");
      log.error(`[Upload] presign FAILED: ${message} (isConfigError=${isConfigError})`);
      res.status(isConfigError ? 503 : 500).json({ error: message });
    }
  });

  app.use("/objects", requireAuth, async (req, res, next) => {
    if (req.method !== "GET") return next();
    try {
      const principal = getPrincipal(req);
      const objectFile = await objectStorageService.getObjectEntityFile(
        req.originalUrl.split("?")[0],
        principal,
      );
      const allowed = await objectStorageService.canAccessObjectEntity({
        principal,
        objectFile,
        requestedPermission: ObjectPermission.READ,
      });
      if (!allowed) {
        return res.status(principal ? 403 : 401).json({ error: "Forbidden" });
      }
      const fileName = typeof req.query.name === "string" ? req.query.name : undefined;
      await objectStorageService.downloadObject(objectFile, res, 3600, fileName);
    } catch (error) {
      log.error("Error serving object:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Object not found" });
      }
      return res.status(500).json({ error: "Failed to serve object" });
    }
  });
}
