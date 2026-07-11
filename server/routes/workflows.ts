import * as fs from "fs";
import * as path from "path";
import type { Express } from "express";
import { requireAuth } from "../auth";
import { createLogger } from "../log";
import {
  approveWorkflowGate,
  attachWorkflowArtifact,
  cancelWorkflowRun,
  captureAcceptanceEvidence,
  captureCalibrationEvidence,
  capturePublishToStageEvidence,
  completeStageAttempt,
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowTemplate,
  listWorkflowRuns,
  listWorkflowTemplates,
  openWorkflowGate,
  pauseWorkflowRun,
  rejectWorkflowGate,
  resumeWorkflowRun,
  seedBuildWorkflowTemplate,
  startStageAttempt,
  startWorkflowRun,
  updateWorkflowRun,
} from "../workflows/workflow-service";

const log = createLogger("WorkflowRoutes");

function routeError(error: unknown, operation: string): { message: string; operation: string } {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${operation} failed: ${message}`);
  return { message, operation };
}

function intParam(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function registerWorkflowRoutes(app: Express) {
  app.use("/api/workflows", requireAuth);

  app.get("/api/workflows/templates", async (req, res) => {
    try {
      await seedBuildWorkflowTemplate();
      res.json(await listWorkflowTemplates({ type: String(req.query.type || "") || undefined, status: String(req.query.status || "") || undefined, limit: intParam(req.query.limit) }));
    } catch (error) {
      const err = routeError(error, "list_workflow_templates");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/workflows/templates/:id", async (req, res) => {
    try {
      await seedBuildWorkflowTemplate();
      const template = await getWorkflowTemplate(req.params.id);
      if (!template) return res.status(404).json({ error: `Workflow template ${req.params.id} not found`, operation: "get_workflow_template" });
      res.json(template);
    } catch (error) {
      const err = routeError(error, "get_workflow_template");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/workflows/runs", async (req, res) => {
    try {
      res.json(await listWorkflowRuns({
        status: String(req.query.status || "") || undefined,
        templateId: String(req.query.templateId || "") || undefined,
        projectId: intParam(req.query.projectId),
        platformId: intParam(req.query.platformId),
        productId: intParam(req.query.productId),
        environmentId: intParam(req.query.environmentId),
        limit: intParam(req.query.limit),
      }));
    } catch (error) {
      const err = routeError(error, "list_workflow_runs");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/workflows/runs", async (req, res) => {
    try {
      const run = await createWorkflowRun(req.body || {});
      res.status(201).json(run);
    } catch (error) {
      const err = routeError(error, "create_workflow_run");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });


  app.get("/api/workflows/validation-screenshot", async (req, res) => {
    try {
      const rawPath = typeof req.query.path === "string" ? req.query.path : "";
      if (!rawPath) return res.status(400).json({ error: "Screenshot path required", operation: "validation_screenshot" });
      const scratchDir = process.env.SCRATCH_DIR || "/app/scratch";
      const screenshotsDir = path.resolve(scratchDir, "screenshots");
      const resolvedPath = path.resolve(rawPath);
      if (!resolvedPath.startsWith(`${screenshotsDir}${path.sep}`)) {
        return res.status(403).json({ error: "Screenshot path outside validation directory", operation: "validation_screenshot" });
      }
      if (!fs.existsSync(resolvedPath)) {
        return res.status(404).json({ error: "Screenshot not found", operation: "validation_screenshot" });
      }
      res.setHeader("Cache-Control", "private, max-age=60");
      res.sendFile(resolvedPath);
    } catch (error) {
      const err = routeError(error, "validation_screenshot");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/workflows/runs/:id", async (req, res) => {
    try {
      const run = await getWorkflowRun(req.params.id);
      if (!run) return res.status(404).json({ error: `Workflow run ${req.params.id} not found`, operation: "get_workflow_run" });
      res.json(run);
    } catch (error) {
      const err = routeError(error, "get_workflow_run");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.patch("/api/workflows/runs/:id", async (req, res) => {
    try { res.json(await updateWorkflowRun(req.params.id, req.body || {})); }
    catch (error) { const err = routeError(error, "update_workflow_run"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/start", async (req, res) => {
    try { res.json(await startWorkflowRun(req.params.id)); }
    catch (error) { const err = routeError(error, "start_workflow_run"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/pause", async (req, res) => {
    try { res.json(await pauseWorkflowRun(req.params.id, req.body?.reason)); }
    catch (error) { const err = routeError(error, "pause_workflow_run"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/resume", async (req, res) => {
    try { res.json(await resumeWorkflowRun(req.params.id)); }
    catch (error) { const err = routeError(error, "resume_workflow_run"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/cancel", async (req, res) => {
    try { res.json(await cancelWorkflowRun(req.params.id, req.body?.reason)); }
    catch (error) { const err = routeError(error, "cancel_workflow_run"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/stages/:stageKey/start-attempt", async (req, res) => {
    try { res.status(201).json(await startStageAttempt(req.params.id, req.params.stageKey, req.body || {})); }
    catch (error) { const err = routeError(error, "start_workflow_stage_attempt"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/stage-attempts/:attemptId/complete", async (req, res) => {
    try { res.json(await completeStageAttempt(req.params.id, Number(req.params.attemptId), req.body || {})); }
    catch (error) { const err = routeError(error, "complete_workflow_stage_attempt"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/stage-attempts/:attemptId/complete", async (req, res) => {
    try {
      const workflowRunId = String(req.body?.workflowRunId || req.body?.runId || "").trim();
      if (!workflowRunId) throw new Error("workflowRunId is required; use the run-scoped completion route");
      res.json(await completeStageAttempt(workflowRunId, Number(req.params.attemptId), req.body || {}));
    }
    catch (error) { const err = routeError(error, "complete_workflow_stage_attempt"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/artifacts", async (req, res) => {
    try { res.status(201).json(await attachWorkflowArtifact({ ...(req.body || {}), workflowRunId: req.params.id })); }
    catch (error) { const err = routeError(error, "attach_workflow_artifact"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/publish-stage-evidence", async (req, res) => {
    try { res.status(201).json(await capturePublishToStageEvidence({ ...(req.body || {}), workflowRunId: req.params.id })); }
    catch (error) { const err = routeError(error, "capture_publish_stage_evidence"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/acceptance-evidence", async (req, res) => {
    try { res.status(201).json(await captureAcceptanceEvidence({ ...(req.body || {}), workflowRunId: req.params.id })); }
    catch (error) { const err = routeError(error, "capture_acceptance_evidence"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/calibration-evidence", async (req, res) => {
    try { res.status(201).json(await captureCalibrationEvidence({ ...(req.body || {}), workflowRunId: req.params.id })); }
    catch (error) { const err = routeError(error, "capture_calibration_evidence"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/runs/:id/gates", async (req, res) => {
    try { res.status(201).json(await openWorkflowGate({ ...(req.body || {}), workflowRunId: req.params.id })); }
    catch (error) { const err = routeError(error, "open_workflow_gate"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/gates/:gateId/approve", async (req, res) => {
    try { res.json(await approveWorkflowGate(Number(req.params.gateId), req.body?.decisionReason)); }
    catch (error) { const err = routeError(error, "approve_workflow_gate"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });

  app.post("/api/workflows/gates/:gateId/reject", async (req, res) => {
    try { res.json(await rejectWorkflowGate(Number(req.params.gateId), req.body?.decisionReason)); }
    catch (error) { const err = routeError(error, "reject_workflow_gate"); res.status(400).json({ error: err.message, operation: err.operation }); }
  });
}
