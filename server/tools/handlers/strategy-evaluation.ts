import type { ToolHandlerResult } from "../contracts";
import type { StrategySubHandler } from "./strategy-core";

export const strategyEvaluationHandlers: Record<string, StrategySubHandler> = {
  evaluate_move: evaluateMove,
};

async function evaluateMove(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const moveId = args.moveId;
  if (!moveId) return { result: "Missing moveId for evaluate_move", error: true };
  const move = await storage.resolveMoveInstance(moveId);
  if (!move) return { result: `Move instance ${moveId} not found`, error: true };

  const { evaluateMoveWithAgent } = await import("../../strategy-simulation");
  const runId = await evaluateMoveWithAgent(move.id, { awaitResult: true });
  const updatedMove = await storage.getMoveInstance(move.id);
  const summary = [
    `Evaluation complete for "${move.title}" (run ${runId}).`,
    updatedMove?.probability != null ? `Probability: ${(updatedMove.probability * 100).toFixed(0)}%` : null,
    updatedMove?.evaluation ? `Analysis: ${updatedMove.evaluation.slice(0, 800)}` : null,
  ].filter(Boolean).join("\n");
  return { result: summary };
}
