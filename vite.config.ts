import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { execFileSync } from "child_process";

const buildId =
  process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
  process.env.GIT_COMMIT_SHA?.trim() ||
  readCheckedOutCommit() ||
  "development";

function readCheckedOutCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __MANTRA_BUILD_ID__: JSON.stringify(buildId),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
