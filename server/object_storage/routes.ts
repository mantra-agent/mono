import type { Express } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { extname } from "path";
import { readFileSync, unlinkSync } from "fs";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { ObjectPermission, setObjectAclPolicy } from "./objectAcl";
import { storageBackend, PRIVATE_PREFIX } from "./s3-backend";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { getPrincipal } from "../principal";

const log = createLogger("ObjectStorage");

const fileUpload = multer({
  dest: "/tmp/media-uploads/",
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
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
        const ext = extname(req.file.originalname);
        const objectId = randomUUID();
        const suffix = ext ? (ext.startsWith(".") ? ext : `.${ext}`) : "";
        const key = `${PRIVATE_PREFIX}users/${principal.userId}/uploads/${objectId}${suffix}`;

        const fileBuffer = readFileSync(tmpPath);
        await storageBackend.putObject(key, fileBuffer, {
          contentType: req.file.mimetype || "application/octet-stream",
        });

        await setObjectAclPolicy(key, {
          owner: principal.userId,
          ownerUserId: principal.userId,
          accountId: principal.accountId,
          createdByUserId: principal.userId,
          scope: "user",
          visibility: "private",
        });


        unlinkSync(tmpPath);

        const objectPath = `/objects/users/${principal.userId}/uploads/${objectId}${suffix}`;
        log.log(`[Upload] proxy OK: name="${req.file.originalname}" key=${key} objectPath=${objectPath}`);
        res.json({ objectPath });
      } catch (error) {
        try { unlinkSync(tmpPath); } catch {}
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
        { ownerUserId: principal.userId, accountId: principal.accountId, contentType: contentType || undefined, prefix: `users/${principal.userId}/uploads` },
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
      const objectFile = await objectStorageService.getObjectEntityFile(
        req.originalUrl.split("?")[0],
      );
      const principal = getPrincipal(req);
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
