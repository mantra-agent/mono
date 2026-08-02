import { z } from "zod";
import { issueRegressionContractInputSchema, regressionResultStatusSchema } from "@shared/models/regression";
import { getPlanStepAttemptByChildSession, getPlanSteps } from "../plan-service";
import {
  appendRegressionResult,
  associateRegressionPlan,
  getRegressionIssue,
  getRegressionResults,
  getRegressionRun,
  listRegressionCandidates,
  reconcileRegressionRunStatus,
  upsertIssueRegressionContract,
} from "../regression/regression-service";
import { executeRegressionScenario } from "../regression/browser-executor";

type ToolHandlerResult = { result: string; error?: boolean };
const json = (value: unknown): ToolHandlerResult => ({ result: JSON.stringify(value, null, 2) });

const positiveIssueId = (value: unknown) => z.coerce.number().int().positive().parse(value);
const requiredRunId = (value: unknown) => z.string().trim().min(1).max(100).parse(value);

async function requireRegressionPlanStep(input: { runId: string; issueId: number; planStepId: string; sessionId?: string }) {
  const run = await getRegressionRun(input.runId);
  if (!run) throw new Error(`Regression run not found: ${input.runId}`);
  if (!run.planId) throw new Error(`Regression run ${input.runId} has no associated Plan`);
  const snapshot = await listRegressionCandidates(run.id);
  const candidateIndex = snapshot.candidates.findIndex((candidate) => candidate.issueId === input.issueId);
  if (candidateIndex < 0) throw new Error(`Issue ${input.issueId} is not a candidate in regression run ${run.id}`);
  const expectedStepId = `step_${candidateIndex + 1}`;
  if (input.planStepId !== expectedStepId) {
    throw new Error(`Issue ${input.issueId} must execute from deterministic Plan step ${expectedStepId}`);
  }
  const step = (await getPlanSteps(run.planId)).find((candidate) => candidate.id === expectedStepId);
  if (!step || step.status !== "running") {
    throw new Error(`Regression Plan step ${expectedStepId} is not actively running`);
  }
  if (input.sessionId && step.sessionId !== input.sessionId) {
    throw new Error(`Regression Plan step ${expectedStepId} is owned by a different child session`);
  }
  if (input.sessionId) {
    const attempt = await getPlanStepAttemptByChildSession(run.planId, expectedStepId, input.sessionId);
    if (!attempt || attempt.status !== "running") {
      throw new Error(`Regression Plan step ${expectedStepId} has no running attempt for this session`);
    }
  }
  return { run, expectedStepId };
}

export async function handleRegression(args: Record<string, unknown>): Promise<ToolHandlerResult> {
  try {
    const action = z.enum(["start_run", "list_candidates", "get_run", "get_issue", "upsert_contract", "execute_scenario", "append_result", "get_results", "associate_plan"]).parse(args.action);
    switch (action) {
      case "start_run": {
        const { startManualRegression } = await import("../regression/regression-admission");
        return json(await startManualRegression({
          environmentId: args.environmentId == null ? undefined : z.coerce.number().int().positive().parse(args.environmentId),
          wait: args.wait !== false,
        }));
      }
      case "list_candidates": {
        const runId = requiredRunId(args.runId);
        const snapshot = await listRegressionCandidates(runId);
        if (snapshot.candidates.length === 0) await reconcileRegressionRunStatus(runId);
        return json(snapshot);
      }
      case "get_run": {
        const runId = requiredRunId(args.runId);
        const run = await getRegressionRun(runId);
        if (!run) throw new Error(`Regression run not found: ${runId}`);
        return json(run);
      }
      case "get_issue": return json(await getRegressionIssue(requiredRunId(args.runId), positiveIssueId(args.issueId)));
      case "upsert_contract": {
        const contract = issueRegressionContractInputSchema.parse(args.contract);
        return json(await upsertIssueRegressionContract(positiveIssueId(args.issueId), contract));
      }
      case "execute_scenario": {
        const runId = requiredRunId(args.runId);
        const issueId = positiveIssueId(args.issueId);
        const planStepId = z.string().trim().min(1).max(100).parse(args.planStepId);
        const sessionId = typeof args._sessionId === "string" ? args._sessionId : undefined;
        await requireRegressionPlanStep({ runId, issueId, planStepId, sessionId });
        return json(await executeRegressionScenario({ runId, issueId, planStepId, sessionId }));
      }
      case "append_result": {
        const status = regressionResultStatusSchema.parse(args.status);
        if (status !== "blocked") throw new Error("Agent-authored append_result is limited to blocked documentation/execution results; scenario pass/fail is appended by execute_scenario");
        const runId = requiredRunId(args.runId);
        const issueId = positiveIssueId(args.issueId);
        const planStepId = z.string().trim().min(1).max(100).parse(args.planStepId);
        const sessionId = typeof args._sessionId === "string" ? args._sessionId : undefined;
        await requireRegressionPlanStep({ runId, issueId, planStepId, sessionId });
        return json(await appendRegressionResult({
          runId,
          issueId,
          status,
          reasonCode: z.string().trim().min(1).max(100).parse(args.reasonCode),
          summary: z.string().trim().min(1).max(2_000).parse(args.summary),
          planStepId,
          sessionId,
          contractVersion: args.contractVersion == null ? undefined : z.coerce.number().int().positive().parse(args.contractVersion),
          browserEvidence: { executionAttempted: false, recordedBy: "regression_tool" },
        }));
      }
      case "get_results": return json(await getRegressionResults({
        runId: typeof args.runId === "string" ? args.runId.trim() || undefined : undefined,
        issueId: args.issueId == null ? undefined : positiveIssueId(args.issueId),
        limit: args.limit == null ? undefined : z.coerce.number().int().positive().max(100).parse(args.limit),
      }));
      case "associate_plan": return json(await associateRegressionPlan(requiredRunId(args.runId), z.string().trim().min(1).max(100).parse(args.planId)));
    }
  } catch (error) {
    return { result: error instanceof Error ? error.message : String(error), error: true };
  }
}
