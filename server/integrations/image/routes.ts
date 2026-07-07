import type { Express, Request, Response } from "express";
import { createLogger } from "../../log";

const log = createLogger("ImageRoutes");

export function registerImageRoutes(app: Express): void {
  app.post("/api/generate-image", async (req: Request, res: Response) => {
    try {
      const { prompt, size = "1024x1024", quality, background, outputFormat } = req.body;

      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required" });
      }

      log.debug(`[ImageRoutes] generate: prompt="${prompt.slice(0, 80)}" size=${size}`);

      const { generateImageBuffer } = await import("./client");
      const buffer = await generateImageBuffer(prompt, { size, quality, background, outputFormat });

      const format = outputFormat || "png";
      const contentType = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", buffer.length);
      res.send(buffer);
    } catch (error: any) {
      log.error("Error generating image:", error);
      res.status(500).json({ error: error.message || "Failed to generate image" });
    }
  });
}
