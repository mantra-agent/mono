import { z } from "zod";
import { issueRegressionContractInputSchema, regressionResultStatusSchema } from "@shared/models/regression";
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

export async function handleRegression(args: Record<string, unknown>): Promise<ToolHandlerResult> {
  try {
    const action = z.enum(["list_candidates", "get_run", "get_issue", "upsert_contract", "execute_scenario", "append_result", "get_results", "associate_plan"]).parse(args.action);
    switch (action) {
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
      case "execute_scenario": return json(await executeRegressionScenario({
        runId: requiredRunId(args.runId),
        issueId: positiveIssueId(args.issueId),
        planStepId: typeof args.planStepId === "string" ? args.planStepId.trim() || undefined : undefined,
        sessionId: typeof args._sessionId === "string" ? args._sessionId : undefined,
      }));
      case "append_result": {
        const status = regressionResultStatusSchema.parse(args.status);
        if (status !== "blocked") throw new Error("Agent-authored append_result is limited to blocked documentation/execution results; scenario pass/fail is appended by execute_scenario");
        return json(await appendRegressionResult({
          runId: requiredRunId(args.runId),
          issueId: positiveIssueId(args.issueId),
          status,
          reasonCode: z.string().trim().min(1).max(100).parse(args.reasonCode),
          summary: z.string().trim().min(1).max(2_000).parse(args.summary),
          planStepId: typeof args.planStepId === "string" ? args.planStepId.trim() || undefined : undefined,
          sessionId: typeof args._sessionId === "string" ? args._sessionId : undefined,
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
