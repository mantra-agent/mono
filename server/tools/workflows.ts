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
  pauseWorkflowRun,
  rejectWorkflowGate,
  resumeWorkflowRun,
  seedBuildWorkflowTemplate,
  startStageAttempt,
  startWorkflowRun,
} from "../workflows/workflow-service";

type ToolHandlerResult = { result: string; error?: boolean };

function json(value: unknown): ToolHandlerResult {
  return { result: JSON.stringify(value, null, 2) };
}

export async function handleWorkflows(args: Record<string, any>): Promise<ToolHandlerResult> {
  try {
    await seedBuildWorkflowTemplate();
    const action = String(args.action || "list_runs");
    switch (action) {
      case "list_templates": return json(await listWorkflowTemplates({ type: args.type, status: args.status, limit: args.limit }));
      case "get_template": return json(await getWorkflowTemplate(String(args.templateId || args.id || "")));
      case "list_runs": return json(await listWorkflowRuns({ status: args.status, templateId: args.templateId, projectId: args.projectId, platformId: args.platformId, productId: args.productId, environmentId: args.environmentId, limit: args.limit }));
      case "get_run": return json(await getWorkflowRun(String(args.runId || args.id || "")));
      case "create_run": return json(await createWorkflowRun(args));
      case "start_run": return json(await startWorkflowRun(String(args.runId || args.id || "")));
      case "pause_run": return json(await pauseWorkflowRun(String(args.runId || args.id || ""), args.reason));
      case "resume_run": return json(await resumeWorkflowRun(String(args.runId || args.id || "")));
      case "cancel_run": return json(await cancelWorkflowRun(String(args.runId || args.id || ""), args.reason));
      case "start_stage_attempt": return json(await startStageAttempt(String(args.runId || args.id || ""), args.stageKey, args));
      case "complete_stage_attempt": {
        const workflowRunId = String(args.workflowRunId || args.runId || "").trim();
        const attemptId = Number(args.attemptId);
        if (!workflowRunId) throw new Error("complete_stage_attempt requires workflowRunId");
        if (!Number.isSafeInteger(attemptId) || attemptId <= 0) throw new Error(`complete_stage_attempt requires a positive integer attemptId; received ${String(args.attemptId)}`);
        return json(await completeStageAttempt(workflowRunId, attemptId, args));
      }
      case "attach_artifact": return json(await attachWorkflowArtifact({ ...args, workflowRunId: String(args.workflowRunId || args.runId || args.id || "") || undefined }));
      case "capture_publish_stage_evidence": return json(await capturePublishToStageEvidence({ workflowRunId: String(args.runId || args.id || args.workflowRunId || ""), stageAttemptId: args.stageAttemptId, createdBySessionId: args.createdBySessionId, summary: args.summary }));
      case "capture_acceptance_evidence": return json(await captureAcceptanceEvidence({ workflowRunId: String(args.runId || args.id || args.workflowRunId || ""), stageAttemptId: args.stageAttemptId, routePath: args.routePath, createdBySessionId: args.createdBySessionId, summary: args.summary, optionalSmokeAttempted: args.optionalSmokeAttempted }));
      case "capture_calibration_evidence": return json(await captureCalibrationEvidence({ workflowRunId: String(args.runId || args.id || args.workflowRunId || ""), stageAttemptId: args.stageAttemptId, createdBySessionId: args.createdBySessionId, summary: args.summary, decision: args.decision, documentationUpdated: args.documentationUpdated, specDelta: args.specDelta, failureContext: args.failureContext }));
      case "approve_gate": return json(await approveWorkflowGate(Number(args.gateId || args.id), args.decisionReason));
      case "reject_gate": return json(await rejectWorkflowGate(Number(args.gateId || args.id), args.decisionReason));
      default:
        return { result: `Unknown workflows action: ${action}`, error: true };
    }
  } catch (err) {
    return { result: err instanceof Error ? err.message : String(err), error: true };
  }
}
