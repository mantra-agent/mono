import { Router, type Request, type Response } from "express";
import { createRenderJob, getRenderJob, updateRenderJob, listRenderJobs } from "./render-storage";
import { getMediaItem, registerMediaItem } from "./media-storage";
import { concatVideos, probeFile, isAvailable, isRenderActive } from "./ffmpeg-service";
import { storageBackend } from "../object_storage/s3-backend";
import { requireAuth } from "../auth";
import { getPrincipal, type Principal } from "../principal";
import { setObjectAclPolicy } from "../object_storage/objectAcl";
import { vaultObjectKeyFromPrincipal } from "../object_storage/vault-keys";
import { createLogger } from "../log";

const log = createLogger("RenderRoutes");
const router = Router();

// Active SSE connections by job ID
const sseClients = new Map<string, Set<Response>>();

function broadcastProgress(jobId: string, data: Record<string, any>) {
  const clients = sseClients.get(jobId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// GET /api/render — list recent render jobs
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const jobs = await listRenderJobs(20, getPrincipal(req));
    res.json(jobs);
  } catch (err: any) {
    log.error(`[Render] list error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/render/start — start a new render job
router.post("/start", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isAvailable()) {
      return res.status(503).json({ error: "FFmpeg not available on this server" });
    }
    if (isRenderActive()) {
      return res.status(409).json({ error: "A render is already in progress. Please wait." });
    }

    const principal = getPrincipal(req);
    if (!principal?.userId || !principal.accountId) return res.status(403).json({ error: "User principal required" });
    const { clipIds, outputResolution, outputName } = req.body;
    if (!clipIds || !Array.isArray(clipIds) || clipIds.length === 0) {
      return res.status(400).json({ error: "clipIds array is required" });
    }
    if (clipIds.length > 50) {
      return res.status(400).json({ error: "Maximum 50 clips per render" });
    }

    // Validate all clips exist
    const clips = await Promise.all(clipIds.map((id: string) => getMediaItem(id, principal)));
    const missing = clipIds.filter((_: string, i: number) => !clips[i]);
    if (missing.length > 0) {
      return res.status(400).json({ error: `Clips not found: ${missing.join(", ")}` });
    }

    // Check total file size (10GB limit)
    const totalSize = clips.reduce((sum, c) => sum + (c?.fileSize || 0), 0);
    if (totalSize > 10 * 1024 * 1024 * 1024) {
      return res.status(400).json({ error: "Total clip size exceeds 10GB limit" });
    }

    const resolution = outputResolution === "720p" || outputResolution === "1080p" ? outputResolution : null;

    const job = await createRenderJob({
      clipIds,
      outputResolution: resolution || "original",
      status: "pending",
      progress: 0,
    }, principal);

    // Start async render
    runRender(job.id, clips as any[], resolution, outputName || "stitched-output", principal).catch((err) => {
      log.error(`[Render] async render failed for ${job.id}: ${err.message}`);
    });

    res.status(201).json(job);
  } catch (err: any) {
    log.error(`[Render] start error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/render/:id — job status
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const principal = getPrincipal(req);
    const job = await getRenderJob(req.params.id, principal);
    if (!job) return res.status(404).json({ error: "Not found" });
    res.json(job);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/render/:id/progress — SSE progress stream
router.get("/:id/progress", requireAuth, async (req: Request, res: Response) => {
  const jobId = req.params.id;
  const job = await getRenderJob(jobId, getPrincipal(req));
  if (!job) return res.status(404).json({ error: "Not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ progress: job.progress, status: job.status })}\n\n`);

  if (job.status === "complete" || job.status === "failed") {
    res.end();
    return;
  }

  // Register for updates
  if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
  sseClients.get(jobId)!.add(res);

  req.on("close", () => {
    sseClients.get(jobId)?.delete(res);
    if (sseClients.get(jobId)?.size === 0) sseClients.delete(jobId);
  });
});

// POST /api/render/:id/cancel — cancel render
router.post("/:id/cancel", requireAuth, async (req: Request, res: Response) => {
  try {
    const principal = getPrincipal(req);
    const job = await getRenderJob(req.params.id, principal);
    if (!job) return res.status(404).json({ error: "Not found" });
    if (job.status !== "pending" && job.status !== "running") {
      return res.status(400).json({ error: "Job is not cancellable" });
    }
    await updateRenderJob(req.params.id, { status: "failed", error: "Canceled by user" }, principal);
    broadcastProgress(req.params.id, { status: "failed", error: "Canceled by user" });
    res.json({ canceled: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function runRender(
  jobId: string,
  clips: Array<{ id: string; objectPath: string; name: string }>,
  resolution: "720p" | "1080p" | null,
  outputName: string,
  principal: Principal,
): Promise<void> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const os = await import("os");

  const tmpDir = path.join(os.tmpdir(), `render-${jobId}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    await updateRenderJob(jobId, { status: "running" }, principal);
    broadcastProgress(jobId, { status: "running", progress: 0 });

    // Download all clips to temp dir
    const clipPaths: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const key = clip.objectPath.startsWith("/objects/")
        ? `private/${clip.objectPath.slice("/objects/".length)}`
        : clip.objectPath;
      const buffer = await storageBackend.getObjectBuffer(key);
      const ext = path.extname(clip.name) || ".mp4";
      const localPath = path.join(tmpDir, `clip-${i}${ext}`);
      await fs.writeFile(localPath, buffer);
      clipPaths.push(localPath);
    }

    // Pre-compute total duration
    let totalDuration = 0;
    for (const cp of clipPaths) {
      const probe = await probeFile(cp);
      totalDuration += probe.duration;
    }
    await updateRenderJob(jobId, { totalDuration }, principal);

    // Check for cancellation
    const currentJob = await getRenderJob(jobId, principal);
    if (currentJob?.status === "failed") {
      log.log(`[Render] job ${jobId} was canceled before concat`);
      return;
    }

    // Run FFmpeg concat
    const outputPath = path.join(tmpDir, `${outputName}.mp4`);
    await concatVideos({
      clipPaths,
      outputPath,
      resolution,
      onProgress: (percent) => {
        updateRenderJob(jobId, { progress: percent }, principal).catch(() => {});
        broadcastProgress(jobId, { status: "running", progress: percent });
      },
    });

    // Upload output to object storage with vault prefix
    const outputBuffer = await fs.readFile(outputPath);
    const ownerPrefix = principal.userId ? `users/${principal.userId}` : "system";
    const outputKey = vaultObjectKeyFromPrincipal(principal, `${ownerPrefix}/renders`, `${jobId}.mp4`);
    await storageBackend.putObject(outputKey, outputBuffer, { contentType: "video/mp4" });
    const outputObjectPath = `/objects/${ownerPrefix}/renders/${jobId}.mp4`;
    await setObjectAclPolicy(outputKey, principal.userId ? { owner: principal.userId, ownerUserId: principal.userId, accountId: principal.accountId ?? null, createdByUserId: principal.userId, scope: "user", visibility: "private", vaultId: principal.activeVaultId ?? undefined } : { owner: "system", scope: "system", visibility: "private" });

    // Register output as media item
    const outputMedia = await registerMediaItem({
      name: `${outputName}.mp4`,
      mediaType: "video",
      source: "render",
      objectPath: outputObjectPath,
      mimeType: "video/mp4",
      fileSize: outputBuffer.length,
      duration: totalDuration,
      metadata: { clipIds: clips.map((c) => c.id), resolution: resolution || "original" },
    }, principal);

    await updateRenderJob(jobId, {
      status: "complete",
      progress: 100,
      outputMediaId: outputMedia.id,
    }, principal);

    broadcastProgress(jobId, {
      status: "complete",
      progress: 100,
      outputMediaId: outputMedia.id,
      downloadUrl: outputObjectPath,
    });

    log.log(`[Render] job ${jobId} complete: ${outputObjectPath}`);
  } catch (err: any) {
    log.error(`[Render] job ${jobId} failed: ${err.message}`);
    await updateRenderJob(jobId, { status: "failed", error: err.message }, principal).catch(() => {});
    broadcastProgress(jobId, { status: "failed", error: err.message });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    // Clean up SSE connections
    const clients = sseClients.get(jobId);
    if (clients) {
      for (const client of clients) {
        try { client.end(); } catch {}
      }
      sseClients.delete(jobId);
    }
  }
}

export default router;
