/**
 * Database Backup API Routes
 *
 * POST   /api/backups                — create a backup from the live DB
 * GET    /api/backups                — list backups
 * GET    /api/backups/:id            — get backup detail
 * GET    /api/backups/:id/download   — presigned download URL (redirect)
 * POST   /api/backups/:id/restore    — restore from a backup in the list
 * POST   /api/backups/upload-url     — get a presigned PUT URL for direct-to-R2 upload
 * POST   /api/backups/upload-from-key — create a backup entry from an R2 object key (after presigned upload)
 * POST   /api/backups/chunked/init   — start a chunked upload session (returns sessionId)
 * PUT    /api/backups/chunked/:sessionId/:index — upload one chunk
 * POST   /api/backups/chunked/:sessionId/finalize — reassemble chunks and create a backup entry
 * POST   /api/backups/:id/cancel     — cancel an in-progress backup
 * DELETE /api/backups/:id            — delete a backup
 *
 * Legacy (kept for backward compat):
 * POST   /api/backups/upload-restore — upload a .tar.gz and restore (hits Railway 300s timeout)
 * POST   /api/backups/restore-from-key — restore from an R2 object key
 */
import type { Express } from "express";
import { requireAuth, requireAdmin } from "../auth";
import { requireAdminPrivilegedMode } from "../sensitive-scope";
import { createLogger } from "../log";
import {
  createBackup,
  listBackups,
  getBackup,
  deleteBackup,
  cancelBackup,
  restoreFromBackup,
  restoreFromUpload,
  createRestoreJob,
  getRestoreJobStatus,
  createBackupFromUpload,
  createBackupFromR2Key,
} from "../backup-storage";
import crypto from "crypto";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";

const log = createLogger("BackupRoutes");

export function registerBackupRoutes(app: Express): void {
  app.use("/api/backups", requireAuth, requireAdmin, requireAdminPrivilegedMode("backup"));
  // Create a new backup
  app.post("/api/backups", async (_req, res) => {
    try {
      const job = await createBackup("manual");
      res.json({ id: job.id, status: job.status });
    } catch (err: any) {
      log.error(`POST /api/backups failed: ${err.message}`);
      res.status(409).json({ error: err.message });
    }
  });

  // List recent backups
  app.get("/api/backups", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const backups = await listBackups(limit);
      res.json(backups);
    } catch (err: any) {
      log.error(`GET /api/backups failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Get backup detail
  app.get("/api/backups/:id", async (req, res) => {
    try {
      const backup = await getBackup(req.params.id);
      if (!backup) return res.status(404).json({ error: "Backup not found" });
      res.json(backup);
    } catch (err: any) {
      log.error(`GET /api/backups/:id failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Download backup archive (presigned S3 URL redirect)
  app.get("/api/backups/:id/download", async (req, res) => {
    try {
      const backup = await getBackup(req.params.id);
      if (!backup) return res.status(404).json({ error: "Backup not found" });
      if (backup.status !== "complete" || !backup.s3_key) {
        return res.status(400).json({ error: "Backup is not downloadable" });
      }
      const { storageBackend } = await import("../object_storage/s3-backend");
      const url = await storageBackend.getSignedGetUrl(backup.s3_key, { ttlSec: 300 });
      if (req.accepts(["json", "html"]) === "json") {
        return res.json({ url });
      }
      res.redirect(url);
    } catch (err: any) {
      log.error(`GET /api/backups/:id/download failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Presigned upload flow (bypasses Railway 300s proxy timeout) ---

  // Step 1: Get a presigned PUT URL for direct-to-R2 upload
  app.post("/api/backups/upload-url", async (_req, res) => {
    try {
      const { storageBackend } = await import("../object_storage/s3-backend");
      const objectKey = `private/backups/upload-restore-${Date.now()}.tar.gz`;
      const uploadUrl = await storageBackend.getSignedPutUrl(objectKey, {
        contentType: "application/gzip",
        ttlSec: 900,
      });
      log.debug(`[PresignedUpload] Generated presigned PUT URL for ${objectKey}`);
      res.json({ uploadUrl, objectKey });
    } catch (err: any) {
      log.error(`POST /api/backups/upload-url failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Step 2: Create a backup entry from an R2 object key (after presigned upload completes)
  app.post("/api/backups/upload-from-key", async (req, res) => {
    const { objectKey } = req.body || {};
    if (!objectKey || typeof objectKey !== "string") {
      return res.status(400).json({ error: "objectKey is required" });
    }
    log.log(`[UploadFromKey] Creating backup from ${objectKey}`);

    try {
      const job = await createBackupFromR2Key(objectKey);
      log.log(`[UploadFromKey] Backup ${job.id} created from ${objectKey}`);
      res.json({ id: job.id });
    } catch (err: any) {
      log.error(`POST /api/backups/upload-from-key failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Legacy: Trigger restore from an R2 object key (kept for backward compat)
  app.post("/api/backups/restore-from-key", async (req, res) => {
    const { objectKey, dryRun } = req.body || {};
    if (!objectKey || typeof objectKey !== "string") {
      return res.status(400).json({ error: "objectKey is required" });
    }
    log.debug(`[RestoreFromKey] Starting restore from ${objectKey} (dryRun=${!!dryRun})`);

    let tempFilePath: string | null = null;
    try {
      const { storageBackend } = await import("../object_storage/s3-backend");

      // Download from R2 to a temp file
      await fsPromises.mkdir(path.join(os.tmpdir(), "backup-upload-stream"), { recursive: true });
      tempFilePath = path.join(os.tmpdir(), "backup-upload-stream", `r2-${Date.now()}.tar.gz`);

      const stream = await storageBackend.getObjectStream(objectKey);
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(tempFilePath!);
        stream.pipe(writeStream);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
        stream.on("error", reject);
      });

      const stat = await fsPromises.stat(tempFilePath);
      log.debug(`[RestoreFromKey] Downloaded ${stat.size} bytes from R2 to disk`);

      // Create restore job and return immediately
      const jobId = crypto.randomUUID();
      createRestoreJob(jobId);

      const filePath = tempFilePath;
      tempFilePath = null; // Prevent finally cleanup — async runner owns it

      restoreFromUpload(filePath, !!dryRun, jobId)
        .catch((err) => {
          log.error(`[RestoreFromKey] Async restore ${jobId} failed: ${err.message}`);
        })
        .finally(() => {
          fsPromises.rm(filePath, { force: true }).catch(() => {});
          // Clean up the R2 upload object
          storageBackend.deleteObject(objectKey).catch((e) => {
            log.error(`[RestoreFromKey] Failed to clean up R2 object ${objectKey}: ${e.message}`);
          });
        });

      res.json({ jobId });
    } catch (err: any) {
      log.error(`POST /api/backups/restore-from-key failed: ${err.message}`);
      res.status(500).json({ error: err.message });
      if (tempFilePath) {
        fsPromises.rm(tempFilePath, { force: true }).catch(() => {});
      }
    }
  });

  // --- Chunked upload (bypasses Railway 300s proxy timeout without requiring S3/R2) ---

  // In-memory registry of active chunked upload sessions
  const chunkedSessions = new Map<string, { totalChunks: number; totalSize: number; createdAt: number }>();

  // Cleanup stale sessions after 30 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of chunkedSessions) {
      if (now - session.createdAt > 30 * 60 * 1000) {
        chunkedSessions.delete(id);
        const chunkDir = path.join(os.tmpdir(), "backup-chunks", id);
        fsPromises.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
        log.debug(`[ChunkedUpload] Cleaned up stale session ${id}`);
      }
    }
  }, 5 * 60 * 1000);

  // Step 1: Initialize a chunked upload session
  app.post("/api/backups/chunked/init", async (req, res) => {
    try {
      const { totalSize, totalChunks } = req.body || {};
      if (!totalSize || !totalChunks || typeof totalSize !== "number" || typeof totalChunks !== "number") {
        return res.status(400).json({ error: "totalSize and totalChunks are required (numbers)" });
      }
      if (totalChunks < 1 || totalChunks > 200) {
        return res.status(400).json({ error: "totalChunks must be between 1 and 200" });
      }

      const sessionId = crypto.randomUUID();
      const chunkDir = path.join(os.tmpdir(), "backup-chunks", sessionId);
      await fsPromises.mkdir(chunkDir, { recursive: true });

      chunkedSessions.set(sessionId, { totalChunks, totalSize, createdAt: Date.now() });
      log.debug(`[ChunkedUpload] Session ${sessionId} initialized: ${totalChunks} chunks, ${totalSize} bytes`);

      res.json({ sessionId });
    } catch (err: any) {
      log.error(`POST /api/backups/chunked/init failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Step 2: Upload a single chunk
  app.put("/api/backups/chunked/:sessionId/:index", async (req, res) => {
    const { sessionId, index: indexStr } = req.params;
    const index = parseInt(indexStr, 10);

    const session = chunkedSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Upload session not found or expired" });
    }
    if (isNaN(index) || index < 0 || index >= session.totalChunks) {
      return res.status(400).json({ error: `Invalid chunk index (expected 0-${session.totalChunks - 1})` });
    }

    const chunkDir = path.join(os.tmpdir(), "backup-chunks", sessionId);
    const chunkPath = path.join(chunkDir, `${index}.part`);

    try {
      // Stream request body directly to disk
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(chunkPath);
        req.pipe(writeStream);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
        req.on("error", reject);
      });

      const stat = await fsPromises.stat(chunkPath);
      log.debug(`[ChunkedUpload] Session ${sessionId} chunk ${index}/${session.totalChunks - 1} received (${stat.size} bytes)`);

      res.json({ received: index, size: stat.size });
    } catch (err: any) {
      log.error(`PUT /api/backups/chunked/${sessionId}/${index} failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Step 3: Finalize — reassemble chunks and create a backup entry (no restore)
  app.post("/api/backups/chunked/:sessionId/finalize", async (req, res) => {
    const { sessionId } = req.params;

    const session = chunkedSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Upload session not found or expired" });
    }

    const chunkDir = path.join(os.tmpdir(), "backup-chunks", sessionId);

    try {
      // Verify all chunks are present
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(chunkDir, `${i}.part`);
        try {
          await fsPromises.access(chunkPath);
        } catch {
          return res.status(400).json({ error: `Missing chunk ${i}` });
        }
      }

      // Reassemble chunks into a single file
      log.debug(`[ChunkedUpload] Session ${sessionId} finalizing: reassembling ${session.totalChunks} chunks...`);
      const outputPath = path.join(chunkDir, "combined.tar.gz");
      const writeStream = fs.createWriteStream(outputPath);

      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(chunkDir, `${i}.part`);
        await new Promise<void>((resolve, reject) => {
          const readStream = fs.createReadStream(chunkPath);
          readStream.pipe(writeStream, { end: false });
          readStream.on("end", resolve);
          readStream.on("error", reject);
        });
        // Delete chunk after appending to free disk space
        await fsPromises.rm(chunkPath, { force: true });
      }

      writeStream.end();
      await new Promise<void>((resolve) => writeStream.on("finish", resolve));

      const stat = await fsPromises.stat(outputPath);
      log.debug(`[ChunkedUpload] Session ${sessionId} reassembled: ${stat.size} bytes`);

      // Remove session from registry
      chunkedSessions.delete(sessionId);

      // Create backup entry from the reassembled file (upload to R2, extract metadata)
      const job = await createBackupFromUpload(outputPath);
      log.debug(`[ChunkedUpload] Session ${sessionId} created backup ${job.id}`);

      // Clean up chunk directory
      fsPromises.rm(chunkDir, { recursive: true, force: true }).catch(() => {});

      res.json({ id: job.id });
    } catch (err: any) {
      log.error(`POST /api/backups/chunked/${sessionId}/finalize failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Legacy upload-restore (kept for backwards compat, hits Railway 300s timeout on large files) ---

  // Upload a .tar.gz backup file and restore from it.
  // Streams to a temp file on disk, then runs restore async with progress tracking.
  // Returns a jobId immediately; poll GET /api/backups/restore-jobs/:id for status.
  app.post("/api/backups/upload-restore", async (req, res) => {
    const contentLength = req.headers["content-length"];
    log.debug(`[UploadRestore] Request started (content-length=${contentLength ?? "unknown"})`);

    let tempFilePath: string | null = null;
    try {
      // 1. Stream request body to a temp file on disk
      await fsPromises.mkdir(path.join(os.tmpdir(), "backup-upload-stream"), { recursive: true });
      tempFilePath = path.join(os.tmpdir(), "backup-upload-stream", `upload-${Date.now()}.tar.gz`);

      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(tempFilePath!);
        req.pipe(writeStream);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
        req.on("error", reject);
      });

      // 2. Validate file was written
      const stat = await fsPromises.stat(tempFilePath);
      if (stat.size === 0) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      log.debug(`[UploadRestore] Upload streamed to disk (${stat.size} bytes)`);

      // 3. Create a restore job and return immediately
      const jobId = crypto.randomUUID();
      const dryRun = req.query.dryRun === "true";
      createRestoreJob(jobId);

      // Run restore async — don't await
      const filePath = tempFilePath;
      tempFilePath = null; // Prevent finally from cleaning up — the async runner will do it
      restoreFromUpload(filePath, dryRun, jobId)
        .catch((err) => {
          log.error(`[UploadRestore] Async restore ${jobId} failed: ${err.message}`);
        })
        .finally(() => {
          fsPromises.rm(filePath, { force: true }).catch(() => {});
        });

      res.json({ jobId });
    } catch (err: any) {
      log.error(`POST /api/backups/upload-restore failed: ${err.message}`);
      res.status(500).json({ error: err.message });
      // Clean up temp file on error during upload phase
      if (tempFilePath) {
        fsPromises.rm(tempFilePath, { force: true }).catch(() => {});
      }
    }
  });

  // Poll restore job status
  app.get("/api/backups/restore-jobs/:id", async (req, res) => {
    const job = getRestoreJobStatus(req.params.id);
    if (!job) return res.status(404).json({ error: "Restore job not found" });
    res.json(job);
  });

  // Cancel an in-progress backup
  app.post("/api/backups/:id/cancel", async (req, res) => {
    try {
      const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim()
        : "Cancelled manually from Dev Database page";
      const job = await cancelBackup(req.params.id, reason);
      res.json(job);
    } catch (err: any) {
      log.error(`POST /api/backups/:id/cancel failed: ${err.message}`);
      const status = err.message?.includes("not found") ? 404 : 409;
      res.status(status).json({ error: err.message });
    }
  });

  // Restore from backup
  app.post("/api/backups/:id/restore", async (req, res) => {
    try {
      const dryRun = req.body?.dryRun === true;
      const result = await restoreFromBackup(req.params.id, dryRun);
      res.json(result);
    } catch (err: any) {
      log.error(`POST /api/backups/:id/restore failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a backup
  app.delete("/api/backups/:id", async (req, res) => {
    try {
      await deleteBackup(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      log.error(`DELETE /api/backups/:id failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  log.debug("Backup routes registered");
}
