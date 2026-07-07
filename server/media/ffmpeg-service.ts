import { createLogger } from "../log";
import { EventEmitter } from "events";

const log = createLogger("FFmpeg");

// Global render semaphore — max 1 concurrent render
let activeRender = false;

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  codec: string;
  bitrate: number;
}

export interface RenderOptions {
  clipPaths: string[];
  outputPath: string;
  resolution?: "720p" | "1080p" | null;
  onProgress: (percent: number) => void;
}

export function getBinaryPaths(): { ffmpegPath: string; ffprobePath: string } | null {
  try {
    const ffmpegPath = require("ffmpeg-static");
    const ffprobePath = require("ffprobe-static").path;
    return { ffmpegPath, ffprobePath };
  } catch {
    return null;
  }
}

export function isAvailable(): boolean {
  return getBinaryPaths() !== null;
}

export async function probeFile(filePath: string): Promise<ProbeResult> {
  const bins = getBinaryPaths();
  if (!bins) throw new Error("FFmpeg binaries not available");

  const ffmpeg = require("fluent-ffmpeg") as typeof import("fluent-ffmpeg");
  ffmpeg.setFfprobePath(bins.ffprobePath);

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: Error | null, metadata: any) => {
      if (err) return reject(err);
      const video = metadata.streams?.find((s: any) => s.codec_type === "video");
      const audio = metadata.streams?.find((s: any) => s.codec_type === "audio");
      const stream = video || audio;
      resolve({
        duration: parseFloat(metadata.format?.duration || "0"),
        width: video?.width || 0,
        height: video?.height || 0,
        codec: stream?.codec_name || "unknown",
        bitrate: parseInt(metadata.format?.bit_rate || "0"),
      });
    });
  });
}

export async function extractThumbnail(inputPath: string, outputPath: string, timestampSec = 1): Promise<void> {
  const bins = getBinaryPaths();
  if (!bins) throw new Error("FFmpeg binaries not available");

  const ffmpeg = require("fluent-ffmpeg") as typeof import("fluent-ffmpeg");
  ffmpeg.setFfmpegPath(bins.ffmpegPath);

  const path = await import("path");

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({
        count: 1,
        timemarks: [String(timestampSec)],
        folder: path.dirname(outputPath),
        filename: path.basename(outputPath),
        size: "320x?",
      })
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err));
  });
}

function parseTimemark(timemark: string): number {
  // timemark format: HH:MM:SS.ms
  const parts = timemark.split(":");
  if (parts.length !== 3) return 0;
  const hours = parseFloat(parts[0]);
  const minutes = parseFloat(parts[1]);
  const seconds = parseFloat(parts[2]);
  return hours * 3600 + minutes * 60 + seconds;
}

export async function concatVideos(options: RenderOptions): Promise<void> {
  if (activeRender) throw new Error("A render is already in progress");

  const bins = getBinaryPaths();
  if (!bins) throw new Error("FFmpeg binaries not available");

  const fs = await import("fs/promises");
  const path = await import("path");
  const ffmpeg = require("fluent-ffmpeg") as typeof import("fluent-ffmpeg");
  ffmpeg.setFfmpegPath(bins.ffmpegPath);
  ffmpeg.setFfprobePath(bins.ffprobePath);

  activeRender = true;
  log.log(`[Render] starting concat: ${options.clipPaths.length} clips → ${options.outputPath}`);

  try {
    // Pre-compute total duration
    let totalDuration = 0;
    for (const clip of options.clipPaths) {
      const probe = await probeFile(clip);
      totalDuration += probe.duration;
    }
    log.log(`[Render] total duration: ${totalDuration.toFixed(1)}s`);

    // Generate concat file listing
    const concatDir = path.dirname(options.outputPath);
    const concatFile = path.join(concatDir, "concat.txt");
    const listing = options.clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await fs.writeFile(concatFile, listing, "utf-8");

    // Build FFmpeg command
    const cmd = ffmpeg(concatFile)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c:a", "aac"]);

    // Apply resolution scaling if requested
    if (options.resolution === "720p") {
      cmd.outputOptions(["-vf", "scale=1280:720:flags=lanczos", "-c:v", "libx264", "-crf", "18", "-preset", "medium"]);
    } else if (options.resolution === "1080p") {
      cmd.outputOptions(["-vf", "scale=1920:1080:flags=lanczos", "-c:v", "libx264", "-crf", "18", "-preset", "medium"]);
    } else {
      // Keep original — copy video stream
      cmd.outputOptions(["-c:v", "copy"]);
    }

    await new Promise<void>((resolve, reject) => {
      cmd
        .output(options.outputPath)
        .on("progress", (info: any) => {
          if (info.timemark && totalDuration > 0) {
            const currentSec = parseTimemark(info.timemark);
            const percent = Math.min(100, Math.round((currentSec / totalDuration) * 100));
            options.onProgress(percent);
          }
        })
        .on("end", () => {
          log.log(`[Render] concat complete: ${options.outputPath}`);
          options.onProgress(100);
          resolve();
        })
        .on("error", (err: Error) => {
          log.error(`[Render] concat failed: ${err.message}`);
          reject(err);
        })
        .run();
    });
  } finally {
    activeRender = false;
  }
}

export function isRenderActive(): boolean {
  return activeRender;
}
