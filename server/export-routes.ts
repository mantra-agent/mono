// Use createLogger for logging ONLY
import type { Express, Request, Response } from "express";
import { createLogger } from "./log";
import { createExportJob, getExportJob, runExportOrchestrator } from "./export-storage";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const log = createLogger("ExportRoutes");

export function registerExportRoutes(app: Express): void {
  // POST /api/export/archive — enqueue a new export job
  app.post("/api/export/archive", async (_req: Request, res: Response) => {
    try {
      const job = await createExportJob();
      log.log(`export job created: ${job.id}`);

      // Fire-and-forget — never await this
      setImmediate(() => {
        runExportOrchestrator(job.id).catch((err: unknown) => {
          log.error(`export orchestrator unhandled error jobId=${job.id}:`, err instanceof Error ? err.message : String(err));
        });
      });

      return res.status(202).json({ jobId: job.id });
    } catch (err: any) {
      log.error("POST /api/export/archive:", err?.message);
      return res.status(500).json({ error: err?.message ?? "Failed to create export job" });
    }
  });

  // GET /api/export/archive/:jobId/download — stream the zip file
  app.get("/api/export/archive/:jobId/download", async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      if (!jobId) return res.status(400).json({ error: "Missing jobId" });
      const job = await getExportJob(jobId);
      if (!job) return res.status(404).json({ error: "Export job not found" });
      if (job.status !== "complete") return res.status(409).json({ error: "Export not ready" });
      const tmpDir = os.tmpdir();
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(`gstack-${jobId}`) && f.endsWith(".zip"));
      if (files.length === 0) return res.status(404).json({ error: "Export file not found — it may have been cleaned up. Re-run the export." });
      const zipPath = path.join(tmpDir, files[0]);
      const stat = fs.statSync(zipPath);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${files[0].replace(`-${jobId}`, "")}"`);
      res.setHeader("Content-Length", String(stat.size));
      fs.createReadStream(zipPath).pipe(res);
    } catch (err: any) {
      log.error("GET /api/export/archive/:jobId/download:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: err?.message ?? "Download failed" });
    }
  });

  // GET /api/export/archive/:jobId — poll job status
  app.get("/api/export/archive/:jobId", async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      if (!jobId) {
        return res.status(400).json({ error: "Missing jobId" });
      }
      const job = await getExportJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Export job not found" });
      }
      return res.json({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        currentDomain: job.currentDomain ?? null,
        downloadUrl: job.downloadUrl ?? null,
        error: job.error ?? null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch (err: any) {
      log.error("GET /api/export/archive/:jobId:", err?.message);
      return res.status(500).json({ error: err?.message ?? "Failed to fetch export job" });
    }
  });
}
