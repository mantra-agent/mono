import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { documentStorage } from "../memory";
import { requireAuth, requireAdmin } from "../auth";
import {
  dismissPlatformApplicationError,
  dismissPlatformApplicationErrorsByIdentity,
  getPlatformApplicationError,
  listPlatformApplicationErrors,
} from "../error-telemetry";
import { createLogger } from "../log";
import { requireModRouteGroup } from "../mods/mod-access";
import { requireCurrentPrincipal } from "../principal-context";
import { chatCompletion } from "../model-client";
import { getPromptModulePrompt } from "../prompt-modules";
import { ACTIVITY_THINKING } from "../job-profiles";
const requireActiveBuild = requireModRouteGroup("build.issues");

const log = createLogger("IssueRoutes");

const enhanceIssueSchema = z.object({ text: z.string().trim().min(1).max(10000) });

const createIssueSchema = z.object({
  title: z.string().max(500).optional().default(""),
  description: z.string().max(10000).default(""),
  /** Issue description — required at create; storage rejects whitespace-only input. */
  reproSteps: z.string().min(1).max(10000),
  page: z.string().optional(),
  screenshot: z.string().optional(),
  logs: z.string().max(50000).optional(),
  platformEnvironmentId: z.number().int().positive().nullable().optional(),
  buildId: z.string().min(1).max(200).nullable().optional(),
  productId: z.number().int().positive().optional(),
});

function generateIssueTitleSync(description?: string, reproSteps?: string): string {
  const source = (description && description.trim()) || (reproSteps && reproSteps.trim()) || "";
  if (source.length > 0) {
    const words = source.split(/\s+/).slice(0, 5).join(" ");
    return words.length > 50 ? words.substring(0, 47) + "..." : words;
  }
  return "Untitled Issue";
}

function isIssueCreateValidationError(error: unknown): error is { name: string; message: string; code?: string } {
  return !!error
    && typeof error === "object"
    && "name" in error
    && (error as { name?: string }).name === "IssueCreateValidationError";
}

export function registerIssueRoutes(app: Express) {
  app.use("/api/issues", requireAuth);

  app.post("/api/issues/enhance", async (req, res) => {
    try {
      const { text } = enhanceIssueSchema.parse(req.body);
      const prompt = await getPromptModulePrompt("issue-enhance-text");
      const result = await chatCompletion({
        activity: ACTIVITY_THINKING,
        metadata: { source: "issue-report-enhancement", activity: ACTIVITY_THINKING },
        maxTokens: 1200,
        temperature: 0.2,
        messages: [{ role: "system", content: prompt }, { role: "user", content: text }],
      });
      const enhanced = result.content.trim();
      if (!enhanced || enhanced.length > 10000) return res.status(502).json({ error: "Enhancement returned unusable text" });
      res.json({ enhanced });
    } catch (error: any) {
      if (error.name === "ZodError") return res.status(400).json({ error: "Invalid issue text" });
      log.error("issue_text_enhancement_failed", { errorType: error?.name || "UnknownError" });
      res.status(502).json({ error: "Could not enhance issue text" });
    }
  });

  app.post("/api/issues", async (req, res) => {
    try {
      const data = createIssueSchema.parse(req.body);

      let issueTitle = data.title?.trim() || "";
      if (!issueTitle) {
        issueTitle = generateIssueTitleSync(data.description, data.reproSteps);
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
        reproSteps: data.reproSteps,
        status: "open",
        kind: "reported",
        page: data.page || null,
        screenshot: screenshotPath || null,
        logs: data.logs || null,
        platformEnvironmentId: data.platformEnvironmentId ?? null,
        buildId: data.buildId ?? null,
        productId: data.productId,
      });

      res.json(issue);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      if (isIssueCreateValidationError(error)) {
        return res.status(400).json({ error: error.message, code: error.code || "issue_create_validation" });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/issues/screenshots/:filename", async (req, res) => {
    const filename = req.params.filename;
    if (!/^issue-\d+\.png$/.test(filename)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    let doc = await documentStorage.getDocument("issue_attachment" as any, filename);
    if (!doc && req.principal?.permissions.includes("system:read")) {
      const { fileIssueStorage } = await import("../file-storage/issues");
      doc = await fileIssueStorage.readAttachmentForAdmin(req.principal, filename);
    }
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

  app.get("/api/issues/errors/recent", requireActiveBuild, requireAdmin, async (req, res) => {
    const parsedLimit = Number.parseInt(String(req.query.limit ?? "25"), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 25;
    try {
      res.json(await listPlatformApplicationErrors(req.principal!, limit, 0));
    } catch (error) {
      log.error("issue_errors.list_failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(500).json({ error: "Failed to list recent application errors" });
    }
  });

  app.post("/api/issues/errors/:fingerprint/dismiss", requireActiveBuild, requireAdmin, async (req, res) => {
    try {
      const dismissed = await dismissPlatformApplicationError(req.principal!, String(req.params.fingerprint ?? ""));
      if (!dismissed) {
        return res.status(404).json({ error: "Error aggregate not found" });
      }
      res.json({ ok: true });
    } catch (error) {
      log.error("issue_errors.dismiss_failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(500).json({ error: "Failed to dismiss application error" });
    }
  });

  app.post("/api/issues/errors/:fingerprint/open", requireActiveBuild, requireAdmin, async (req, res) => {
    try {
      const principal = req.principal ?? requireCurrentPrincipal();
      const fingerprint = String(req.params.fingerprint ?? "");
      const error = await getPlatformApplicationError(principal, fingerprint);
      if (!error) {
        return res.status(404).json({ error: "Error aggregate not found" });
      }

      const source = error.sourceFile
        ? `${error.sourceFile}${error.sourceLine ? `:${error.sourceLine}` : ""}`
        : error.sourceSite || "Unavailable";
      const reproSteps = [
        `Promoted from application error aggregate ${error.fingerprint}.`,
        `Identity: ${error.errorIdentity}`,
        `Source: ${source}`,
        `Site: ${error.sourceSite}`,
        `Occurrences: ${error.occurrenceCount}`,
        `First seen: ${error.firstSeenAt}`,
        `Last seen: ${error.lastSeenAt}`,
      ].join("\n");

      const issue = await storage.createIssue({
        title: error.errorIdentity.slice(0, 500),
        description: `Tracked open Issue promoted from the Errors queue for ${error.errorIdentity}.`,
        reproSteps,
        status: "open",
        kind: "tracked",
        logs: [
          `fingerprint=${error.fingerprint}`,
          `errorIdentity=${error.errorIdentity}`,
          `sourceSite=${error.sourceSite}`,
          `source=${source}`,
          `occurrenceCount=${error.occurrenceCount}`,
        ].join("\n"),
      });

      // One Issue owns the identity; clear every active fingerprint sibling so
      // Errors and Open do not double-count the same defect.
      await dismissPlatformApplicationErrorsByIdentity(principal, error.errorIdentity);
      res.status(201).json(issue);
    } catch (error) {
      if (isIssueCreateValidationError(error)) {
        return res.status(400).json({ error: error.message, code: error.code || "issue_create_validation" });
      }
      log.error("issue_errors.open_failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(500).json({ error: "Failed to open application error as Issue" });
    }
  });

  app.get("/api/issues", requireActiveBuild, requireAdmin, async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const excludeStatus = req.query.exclude_status as string | undefined;
      const lightweight = req.query.lightweight === "true";
      const platformEnvironmentId = req.query.platformEnvironmentId ? Number(req.query.platformEnvironmentId) : undefined;
      if (platformEnvironmentId !== undefined && (!Number.isInteger(platformEnvironmentId) || platformEnvironmentId <= 0)) {
        return res.status(400).json({ error: "platformEnvironmentId must be a positive integer" });
      }
      const allIssues = await storage.getIssuesForAdmin(req.principal!, { status, excludeStatus, lightweight, platformEnvironmentId });
      res.json({ issues: allIssues });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/issues/:id", requireActiveBuild, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid issue ID" });
      const issue = await storage.getIssueForAdmin(req.principal!, id);
      if (!issue) return res.status(404).json({ error: "Issue not found" });
      res.json(issue);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const updateIssueSchema = z.object({
    status: z.enum(["open", "in_progress", "in_review", "resolved"]).optional(),
    kind: z.enum(["tracked", "reported"]).optional(),
    spec: z.string().max(10000).optional(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).optional(),
    reproSteps: z.string().min(1).max(10000).optional(),
    feedback: z.string().max(10000).optional(),
    dependencies: z.array(z.number()).optional(),
    platformEnvironmentId: z.number().int().positive().nullable().optional(),
    buildId: z.string().min(1).max(200).nullable().optional(),
    notes: z.any().optional(),
  });

  app.patch("/api/issues/:id", requireActiveBuild, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid issue ID" });

      const updates = updateIssueSchema.parse(req.body);

      const updated = await storage.updateIssueForAdmin(req.principal!, id, updates);
      if (!updated) {
        return res.status(404).json({ error: "Issue not found" });
      }
      res.json(updated);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      if (isIssueCreateValidationError(error)) {
        return res.status(400).json({ error: error.message, code: error.code || "issue_create_validation" });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/issues/:id/notes", requireActiveBuild, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid issue ID" });

      const issue = await storage.getIssueForAdmin(req.principal!, id);
      if (!issue) return res.status(404).json({ error: "Issue not found" });

      const noteSchema = z.object({
        author: z.enum(["user", "agent"]).default("agent"),
        content: z.string().max(5000),
      });

      const data = noteSchema.parse(req.body);
      // Canonical append-only path — same primitive the issues tool uses.
      const updated = await storage.addIssueNoteForAdmin(req.principal!, id, data.content, data.author);

      res.json(updated);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/issues/:id", requireActiveBuild, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid issue ID" });

      const issue = await storage.getIssueForAdmin(req.principal!, id);
      if (!issue) {
        return res.status(404).json({ error: "Issue not found" });
      }

      await storage.deleteIssueForAdmin(req.principal!, id);
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
