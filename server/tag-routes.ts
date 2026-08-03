import type { Express } from "express";
import { tagRegistry } from "./file-storage";
import {
  createTagSchema,
  mergeTagsSchema,
  replaceEntityTagsSchema,
  tagAssignmentSchema,
  updateTagSchema,
} from "@shared/schema";

export function registerTagRoutes(app: Express) {
  app.get("/api/tags", async (req, res) => {
    try {
      res.json(await tagRegistry.listTags(req.principal));
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list tags" });
    }
  });

  app.get("/api/tags/co-occurrences", async (req, res) => {
    try {
      const index = await tagRegistry.getIndex(req.principal);
      res.json(index.coOccurrences);
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load co-occurrences" });
    }
  });

  app.get("/api/tags/:slug", async (req, res) => {
    try {
      const tag = await tagRegistry.getTag(req.params.slug, req.principal);
      if (!tag) return res.status(404).json({ error: "Tag not found" });
      res.json(tag);
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load tag" });
    }
  });

  app.post("/api/tags", async (req, res) => {
    try {
      const parsed = createTagSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      res.status(201).json(await tagRegistry.createTag(parsed.data, req.principal));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to create tag";
      res.status(message.includes("already exists") ? 409 : 500).json({ error: message });
    }
  });

  app.patch("/api/tags/:slug", async (req, res) => {
    try {
      const parsed = updateTagSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const tag = await tagRegistry.updateTag(req.params.slug, parsed.data, req.principal);
      if (!tag) return res.status(404).json({ error: "Tag not found" });
      res.json(tag);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to update tag";
      res.status(message.includes("already exists") ? 409 : 500).json({ error: message });
    }
  });

  app.delete("/api/tags/:slug", async (req, res) => {
    try {
      const deleted = await tagRegistry.deleteTag(req.params.slug, req.principal);
      if (!deleted) return res.status(404).json({ error: "Tag not found" });
      res.status(204).send();
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to delete tag" });
    }
  });

  app.post("/api/tags/merge", async (req, res) => {
    try {
      const parsed = mergeTagsSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const tag = await tagRegistry.mergeTags(parsed.data.sourceSlug, parsed.data.targetSlug, req.principal);
      if (!tag) return res.status(404).json({ error: "Source or target tag not found" });
      res.json(tag);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to merge tags";
      res.status(message.includes("already exists") ? 409 : 500).json({ error: message });
    }
  });

  app.put("/api/tags/:slug/assignments", async (req, res) => {
    try {
      const parsed = tagAssignmentSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      await tagRegistry.assignTag(
        req.params.slug,
        parsed.data.entityType,
        parsed.data.entityId,
        parsed.data.entityTitle,
        req.principal,
      );
      res.status(204).send();
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to assign tag" });
    }
  });

  app.delete("/api/tags/:slug/assignments/:entityType/:entityId", async (req, res) => {
    try {
      const parsed = tagAssignmentSchema.pick({ entityType: true, entityId: true }).safeParse(req.params);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      await tagRegistry.unassignTag(req.params.slug, parsed.data.entityType, parsed.data.entityId, req.principal);
      res.status(204).send();
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to unassign tag" });
    }
  });

  app.put("/api/tag-assignments/:entityType/:entityId", async (req, res) => {
    try {
      const parsed = replaceEntityTagsSchema.safeParse({ ...req.body, ...req.params });
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const tags = await tagRegistry.replaceEntityTags(
        parsed.data.entityType,
        parsed.data.entityId,
        parsed.data.entityTitle,
        parsed.data.tags,
        req.principal,
      );
      res.json({ tags });
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to replace tags" });
    }
  });
}
