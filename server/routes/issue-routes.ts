import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { documentStorage } from "../memory";
import { requireAuth, requireAdmin } from "../auth";
import { createLogger } from "../log";

const log = createLogger("IssueRoutes");

const createIssueSchema = z.object({
  title: z.string().max(500).optional().default(""),
  description: z.string().max(10000).default(""),
  page: z.string().optional(),
  screenshot: z.string().optional(),
  logs: z.string().max(50000).optional(),
});

function generateIssueTitleSync(description?: string): string {
  if (description && description.length > 0) {
    const words = description.split(/\s+/).slice(0, 5).join(" ");
    return words.length > 50 ? words.substring(0, 47) + "..." : words;
  }
  return "Untitled Issue";
}

export function registerIssueRoutes(app: Express) {
  app.use("/api/issues", requireAuth, requireAdmin);

  app.post("/api/issues", async (req, res) => {
    try {
      const data = createIssueSchema.parse(req.body);

      let issueTitle = data.title?.trim() || "";
      if (!issueTitle) {
        const content = data.description || data.logs || data.page || "";
        if (content) {
          issueTitle = generateIssueTitleSync(data.description);
        } else {
          issueTitle = "Untitled Issue";
        }
      }

      let screenshotPath: string | undefined;
      if (data.screenshot) {
        const filename = `issue-${Date.now()}.png`;
        const base64Data = data.screenshot.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length > 5 * 1024 * 1024) {
          return res.status(400).json({ error: "Screenshot too large (max 5MB)" });
        }
        await documentStorage.upsertDocument(
          "issue_attachment" as any,
          filename,
          `issues/screenshots/${filename}`,
          filename,
          base64Data,
          { type: "screenshot", origName: filename, mimeType: "image/png" }
        );
        screenshotPath = `/api/issues/screenshots/${filename}`;
      }

      const issue = await storage.createIssue({
        title: issueTitle,
        description: data.description,
        status: "open",
        page: data.page || null,
        screenshot: screenshotPath || null,
        logs: data.logs || null,
      });

      res.json(issue);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/issues/screenshots/:filename", async (req, res) => {
    const filename = req.params.filename;
    if (!/^issue-\d+\.png$/.test(filename)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const doc = await documentStorage.getDocument("issue_attachment" as any, filename);
    if (!doc) {
      return res.status(404).json({ error: "Screenshot not found" });
    }
    const buffer = Buffer.from(doc.content, "base64");
    res.type("image/png");
    res.send(buffer);
  });

  app.post("/api/issues/attachments", async (req, res) => {
    try {
      const { data, filename: origName, mimeType } = req.body;
      if (!data || !origName) {
        return res.status(400).json({ error: "Missing data or filename" });
      }

      const ext = origName.includes(".") ? origName.split(".").pop() : "bin";
      const safeName = `attach-${Date.now()}.${ext}`;
      const base64Data = data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      if (buffer.length > 10 * 1024 * 1024) {
        return res.status(400).json({ error: "File too large (max 10MB)" });
      }
      await documentStorage.upsertDocument(
        "issue_attachment" as any,
        safeName,
        `issues/attachments/${safeName}`,
        origName,
        base64Data,
        { type: "attachment", origName, mimeType: mimeType || "application/octet-stream" }
      );
      const url = `/api/issues/attachments/${safeName}`;
      res.json({ url, filename: origName });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/issues/attachments/:filename", async (req, res) => {
    const filename = req.params.filename;
    if (!/^attach-\d+\.\w+$/.test(filename)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const doc = await documentStorage.getDocument("issue_attachment" as any, filename);
    if (!doc) {
      return res.status(404).json({ error: "Attachment not found" });
    }
    const meta = doc.metadata as Record<string, string> | null;
    const mimeType = meta?.mimeType || "application/octet-stream";
    const buffer = Buffer.from(doc.content, "base64");
    res.type(mimeType);
    res.send(buffer);
  });

  app.get("/api/issues", async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const excludeStatus = req.query.exclude_status as string | undefined;
      const lightweight = req.query.lightweight === "true";
      const allIssues = await storage.getIssues({ status, excludeStatus, lightweight });
      res.json({ issues: allIssues });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/issues/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid issue ID" });
      const issue = await storage.getIssue(id);
      if (!issue) return res.status(404).json({ error: "Issue not found" });
      res.json(issue);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const updateIssueSchema = z.object({
    status: z.enum(["open", "in_progress", "in_review", "resolved"]).optional(),
    spec: z.string().max(10000).optional(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).optional(),
    feedback: z.string().max(10000).optional(),
    dependencies: z.array(z.number()).optional(),
    notes: z.any().optional(),
  });

  app.patch("/api/issues/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid issue ID" });

      const existing = await storage.getIssue(id);
      if (!existing) return res.status(404).json({ error: "Issue not found" });

      const updates = updateIssueSchema.parse(req.body);

      if (updates.status && updates.status !== existing.status) {
        const existingNotes: any[] = Array.isArray(existing.notes) ? existing.notes as any[] : [];
        const statusNote = {
          id: `status-${Date.now()}`,
          author: "agent",
          content: "",
          timestamp: new Date().toISOString(),
          statusChange: { from: existing.status, to: updates.status },
        };
        updates.notes = [...existingNotes, statusNote];
      }

      if (updates.feedback && !updates.status) {
        updates.status = "open";
      }
      const updated = await storage.updateIssue(id, updates);
      if (!updated) {
        return res.status(404).json({ error: "Issue not found" });
      }
      res.json(updated);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/issues/:id/notes", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid issue ID" });

      const issue = await storage.getIssue(id);
      if (!issue) return res.status(404).json({ error: "Issue not found" });

      const noteSchema = z.object({
        author: z.enum(["user", "agent"]),
        content: z.string().max(10000),
        attachments: z.array(z.object({ name: z.string(), url: z.string() })).optional(),
      });

      const data = noteSchema.parse(req.body);
      const existingNotes: any[] = Array.isArray(issue.notes) ? issue.notes as any[] : [];
      const newNote = {
        id: `note-${Date.now()}`,
        author: data.author,
        content: data.content,
        timestamp: new Date().toISOString(),
        attachments: data.attachments || [],
      };

      const updated = await storage.updateIssue(id, {
        notes: [...existingNotes, newNote] as any,
      });

      res.json(updated);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/issues/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid issue ID" });

      const issue = await storage.getIssue(id);
      if (!issue) {
        return res.status(404).json({ error: "Issue not found" });
      }

      if (issue.screenshot) {
        const filenameMatch = issue.screenshot.match(/issue-\d+\.png$/);
        if (filenameMatch) {
          try { await documentStorage.deleteDocument("issue_attachment" as any, filenameMatch[0]); } catch { /* already gone */ }
        }
      }

      await storage.deleteIssue(id);
      res.json({ message: "Issue deleted" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Brain Export/Import handlers (helpers live at module scope) ──────

  const exportBodySchema = z.object({
    mode: z.enum(["schema", "data", "data_plus"]).optional().default("data_plus"),
  });


}
