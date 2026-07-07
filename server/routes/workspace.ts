import type { Express } from "express";
import { documentStorage } from "../memory";
import { requireAuth, requireAdmin } from "../auth";
import { requireAdminPrivilegedMode } from "../sensitive-scope";

export async function registerWorkspaceRoutes(app: Express) {
  app.use("/api/workspace", requireAuth, requireAdmin, requireAdminPrivilegedMode("workspace"));
  app.get("/api/workspace", async (req, res) => {
    try {
      const subPath = (req.query.path as string) || "";
      const docs = await documentStorage.listDirectory(subPath);

      const dirSet = new Set<string>();
      const files: Array<{ name: string; path: string; type: string; docType?: string; docId?: string; title?: string }> = [];

      for (const doc of docs) {
        const docPath = doc.path;
        const relativePath = subPath ? docPath.replace(new RegExp(`^${subPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), "") : docPath;
        const parts = relativePath.split("/").filter(Boolean);

        if (parts.length > 1) {
          const dirName = parts[0];
          const dirPath = subPath ? `${subPath}/${dirName}` : dirName;
          if (!dirSet.has(dirPath)) {
            dirSet.add(dirPath);
            files.push({ name: dirName, path: dirPath, type: "directory" });
          }
        } else if (parts.length === 1) {
          files.push({
            name: parts[0],
            path: docPath,
            type: "file",
            docType: doc.docType,
            docId: doc.docId,
            title: doc.title ?? undefined,
          });
        }
      }

      files.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.json(files);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/workspace/file", async (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        return res.status(400).json({ error: "File path is required" });
      }

      const doc = await documentStorage.getDocumentByPath(filePath);
      if (!doc) {
        return res.status(404).json({ error: "File not found" });
      }
      res.json({ path: doc.path, content: doc.content, metadata: doc.metadata });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/workspace/file", async (req, res) => {
    try {
      const { path: filePath, content } = req.body;
      if (!filePath || typeof filePath !== "string") {
        return res.status(400).json({ error: "File path is required" });
      }
      if (typeof content !== "string") {
        return res.status(400).json({ error: "Content is required" });
      }
      const existing = await documentStorage.getDocumentByPath(filePath);
      if (existing) {
        await documentStorage.updateDocument(existing.docType as any, existing.docId, { content });
      } else {
        const baseName = filePath.split("/").pop() || filePath;
        await documentStorage.upsertDocument("file", filePath, filePath, baseName, content, {});
      }

      res.json({ message: "File saved successfully" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/workspace/file", async (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath || typeof filePath !== "string") {
        return res.status(400).json({ error: "File path is required" });
      }
      const doc = await documentStorage.getDocumentByPath(filePath);
      if (doc) {
        await documentStorage.deleteDocument(doc.docType as any, doc.docId);
      }

      res.json({ message: "File deleted successfully" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });



}
