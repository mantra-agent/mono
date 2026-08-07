import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { generatePdf, openPdf, readPdfContentHandle } from "../pdf-service";

function statusOf(error: unknown): number {
  const status = (error as { status?: number })?.status;
  return typeof status === "number" ? status : 500;
}

export function registerPdfRoutes(app: Express): void {
  app.post("/api/pdf/open", requireAuth, async (req: Request, res: Response) => {
    try {
      res.json(await openPdf(req.body ?? {}));
    } catch (error) {
      const status = statusOf(error);
      res.status(status).json({ error: status >= 500 ? "Failed to open PDF" : (error as Error).message });
    }
  });

  app.post("/api/pdf/generate", requireAuth, async (req: Request, res: Response) => {
    try {
      res.status(201).json(await generatePdf(req.body ?? {}));
    } catch (error) {
      const status = statusOf(error);
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
      const status = statusOf(error);
      res.status(status).json({ error: status >= 500 ? "Failed to read PDF" : (error as Error).message });
    }
  });
}
