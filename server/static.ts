import express, { type Express } from "express";
import fs from "fs";
import path from "path";

const currentDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();
const distPath = path.resolve(currentDir, "public");
const distExists = fs.existsSync(distPath);

export function serveStatic(app: Express) {
  if (!distExists) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Vite hashed assets: immutable, cache forever
  app.use(
    "/assets",
    express.static(path.join(distPath, "assets"), {
      maxAge: "1y",
      immutable: true,
    }),
  );

  // All other static files: short cache with revalidation
  app.use(
    express.static(distPath, {
      maxAge: "1h",
      setHeaders(res, filePath) {
        // index.html must always revalidate so deploys take effect immediately
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );

  // SPA fallback: serve index.html with no-cache for client-side routing
  app.use("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
