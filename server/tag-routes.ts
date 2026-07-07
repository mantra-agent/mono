import type { Express } from "express";
import { tagRegistry } from "./file-storage";
import { createTagSchema, updateTagSchema, mergeTagsSchema } from "@shared/schema";

export function registerTagRoutes(app: Express): void {

  app.get("/api/tags", async (_req, res) => {
    try {
      const index = await tagRegistry.getIndex();
      const tags = Object.values(index.tags).sort((a, b) => b.usageCount - a.usageCount);
      res.json({ tags, coOccurrences: index.coOccurrences });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/tags/duplicates", async (_req, res) => {
    try {
      const duplicates = await tagRegistry.findDuplicates();
      res.json({ duplicates });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/tags/:slug", async (req, res) => {
    try {
      const tag = await tagRegistry.getTag(req.params.slug);
      if (!tag) return res.status(404).json({ error: "Tag not found" });
      res.json(tag);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/tags", async (req, res) => {
    try {
      const input = createTagSchema.parse(req.body);
      const tag = await tagRegistry.createTag(input);
      res.status(201).json(tag);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/tags/:slug", async (req, res) => {
    try {
      const input = updateTagSchema.parse(req.body);
      const tag = await tagRegistry.updateTag(req.params.slug, input);
      if (!tag) return res.status(404).json({ error: "Tag not found" });
      res.json(tag);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/tags/:slug", async (req, res) => {
    try {
      const ok = await tagRegistry.deleteTag(req.params.slug);
      if (!ok) return res.status(404).json({ error: "Tag not found" });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/tags/merge", async (req, res) => {
    try {
      const input = mergeTagsSchema.parse(req.body);
      const merged = await tagRegistry.mergeTags(input.sourceSlug, input.targetSlug);
      if (!merged) return res.status(404).json({ error: "One or both tags not found" });
      res.json(merged);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });
}
