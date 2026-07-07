import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("lucide-react")) {
            return "icons";
          }
          if (
            id.includes("@radix-ui") ||
            id.includes("components/ui") ||
            id.includes("/cmdk/")
          ) {
            return "ui";
          }
          if (id.includes("node_modules/")) {
            return "vendor";
          }
          if (id.includes("client/src/pages/")) {
            const authPages = ["login", "register", "onboarding"];
            const systemPages = [
              "system",
              "beliefs",
              "rules",
              "principles",
              "context-page",
              "preferences",
              "inference",
              "tools",
              "tags",
              "skills",
              "thoughts-page",
            ];
            const strategyPages = [
              "strategy",
              "strategy-detail",
              "priorities-dashboard",
              "predictions",
            ];
            const detailPages = [
              "goal-detail",
              "project-detail",
              "issue-detail",
              "user-details",
            ];
            const miscPages = ["world", "wellness", "logs"];
            const file = id.split("/").pop() || "";
            const pageName = file.replace(/\.(tsx?|jsx?)$/, "");
            if (authPages.includes(pageName)) return "pages-auth";
            if (systemPages.includes(pageName)) return "pages-system";
            if (strategyPages.includes(pageName)) return "pages-strategy";
            if (detailPages.includes(pageName)) return "pages-detail";
            if (miscPages.includes(pageName)) return "pages-misc";
          }
          if (
            id.includes("client/src/") &&
            !id.includes("client/src/pages/") &&
            !id.includes("client/src/main")
          ) {
            return "app-shared";
          }
          if (id.includes("shared/")) {
            return "app-shared";
          }
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
