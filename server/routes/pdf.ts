import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { createLogger } from "../log";
import { generatePdf, openPdf, readPdfContentHandle } from "../pdf-service";

const log = createLogger("PdfRoutes");

function statusOf(error: unknown): number {
  const status = (error as { status?: number })?.status;
  return typeof status === "number" ? status : 500;
}

function statusClass(status: number): string {
  if (status === 400) return "bad_request";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 415) return "unsupported_media";
  if (status === 502) return "provider";
  if (status >= 500) return "internal";
  return "other";
}

function logPdfFailure(operation: "open" | "content" | "generate", error: unknown): number {
  const status = statusOf(error);
  const fields = { operation, status, statusClass: statusClass(status) };
  if (status >= 500) log.error("PDF route failed", fields);
  else log.warn("PDF route failed", fields);
  return status;
}

export function registerPdfRoutes(app: Express): void {
  app.post("/api/pdf/open", requireAuth, async (req: Request, res: Response) => {
    try {
      res.json(await openPdf(req.body ?? {}));
    } catch (error) {
      const status = logPdfFailure("open", error);
      res.status(status).json({ error: status >= 500 ? "Failed to open PDF" : (error as Error).message });
    }
  });

  app.post("/api/pdf/generate", requireAuth, async (req: Request, res: Response) => {
    try {
      res.status(201).json(await generatePdf(req.body ?? {}));
    } catch (error) {
      const status = logPdfFailure("generate", error);
      res.status(status).json({ error: status >= 500 ? "Failed to generate PDF" : (error as Error).message });
    }
  });

  app.get("/api/pdf/content/:handle", requireAuth, async (req: Request, res: Response) => {
    try {
      const buffer = await readPdfContentHandle(req.params.handle);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(buffer);
    } catch (error) {
      const status = logPdfFailure("content", error);
      res.status(status).json({ error: status >= 500 ? "Failed to read PDF" : (error as Error).message });
    }
  });
}
