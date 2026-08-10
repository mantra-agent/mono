import type { ToolHandlerResult } from "../contracts";
import type { StrategySubHandler } from "./strategy-core";

export const strategyAssumptionHandlers: Record<string, StrategySubHandler> = {
  list_assumptions: listAssumptions,
  add_assumption: addAssumption,
  update_assumption: updateAssumption,
  delete_assumption: deleteAssumption,
  cascade_assumption: cascadeAssumption,
  set_actor_states: setActorStates,
  link_assumption_to_move: linkAssumptionToMove,
  unlink_assumption_from_move: unlinkAssumptionFromMove,
};

async function listAssumptions(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return missingStrategyId();
  const assumptions = await storage.getAssumptions(goalId);
  if (assumptions.length === 0) return { result: "No assumptions for this strategy." };
  const links = await storage.getAssumptionLinksForGoal(goalId);
  const linkCountByAssumption = new Map<string, number>();
  for (const link of links) {
    linkCountByAssumption.set(link.assumptionId, (linkCountByAssumption.get(link.assumptionId) || 0) + 1);
  }
  const lines = assumptions.map((assumption: any) => {
    const linkCount = linkCountByAssumption.get(assumption.id) || 0;
    return `- **${assumption.title}** (id: ${assumption.id}, prob: ${(assumption.probability * 100).toFixed(0)}%)${linkCount > 0 ? ` — linked to ${linkCount} move(s)` : ""}`;
  });
  return { result: `${assumptions.length} assumptions:\n${lines.join("\n")}` };
}

async function addAssumption(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return missingStrategyId();
  if (!args.title) return { result: "Missing assumption title", error: true };
  const assumption = await storage.createAssumption({
    goalId,
    title: args.title,
    description: args.description || "",
    probability: args.probability ?? 0.5,
  });
  return { result: `Assumption added: "${assumption.title}" (ID: ${assumption.id}, prob: ${(assumption.probability * 100).toFixed(0)}%)` };
}

async function updateAssumption(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.id) return { result: "Missing assumption id", error: true };
  const updates: Record<string, any> = {};
  if (args.title) updates.title = args.title;
  if (args.description) updates.description = args.description;
  if (args.probability !== undefined) updates.probability = args.probability;
  const assumption = await storage.updateAssumption(args.id, updates);
  if (!assumption) return { result: `Assumption ${args.id} not found`, error: true };
  return { result: `Assumption updated: "${assumption.title}" — ${Object.entries(updates).map(([key, value]) => `${key}: ${value}`).join(", ")}` };
}

async function deleteAssumption(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.id) return { result: "Missing assumption id", error: true };
  if (!await storage.deleteAssumption(args.id)) return { result: `Assumption ${args.id} not found`, error: true };
  return { result: `Assumption ${args.id} deleted` };
}

async function cascadeAssumption(args: Record<string, any>): Promise<ToolHandlerResult> {
  if (!args.id) return { result: "Missing assumption id", error: true };
  const { cascadeAssumption: cascade } = await import("../../strategy-simulation");
  await cascade(args.id);
  return { result: `Assumption ${args.id} cascaded — affected move probabilities recalculated` };
}

async function setActorStates(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.moveId) return { result: "Missing moveId", error: true };
  if (!args.actorStates || !Array.isArray(args.actorStates)) return { result: "Missing actorStates array (expected [{actorId, state}])", error: true };
  const resolvedMove = await storage.resolveMoveInstance(args.moveId);
  if (!resolvedMove) return { result: `Move ${args.moveId} not found`, error: true };
  const move = await storage.updateMoveInstance(resolvedMove.id, { actorStates: args.actorStates });
  if (!move) return { result: `Move ${args.moveId} not found`, error: true };
  const actors = await storage.getActors(move.goalId);
  const actorNames = new Map(actors.map((actor: any) => [actor.id, actor.name]));
  const stateLines = args.actorStates.map((state: any) => `  - ${actorNames.get(state.actorId) || state.actorId}: "${state.state}"`);
  return { result: `Actor states updated on move "${move.title}":\n${stateLines.join("\n")}` };
}

async function linkAssumptionToMove(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const polarity = args.polarity === "negative" ? "negative" : "positive";
  if (!args.assumptionId) return { result: "Missing assumptionId", error: true };
  if (!args.moveId) return { result: "Missing moveId", error: true };
  const move = await storage.resolveMoveInstance(args.moveId);
  if (!move) return { result: `Move ${args.moveId} not found`, error: true };
  const assumption = await storage.getAssumption(args.assumptionId);
  if (!assumption) return { result: `Assumption ${args.assumptionId} not found`, error: true };
  await storage.createAssumptionLink({ assumptionId: args.assumptionId, moveInstanceId: move.id, polarity });
  return { result: `Move ${args.moveId} linked to assumption "${assumption.title}" with polarity=${polarity}` };
}

async function unlinkAssumptionFromMove(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.assumptionId) return { result: "Missing assumptionId", error: true };
  if (!args.moveId) return { result: "Missing moveId", error: true };
  const move = await storage.resolveMoveInstance(args.moveId);
  if (!move) return { result: `Move ${args.moveId} not found`, error: true };
  const assumption = await storage.getAssumption(args.assumptionId);
  if (!assumption) return { result: `Assumption ${args.assumptionId} not found`, error: true };
  const links = await storage.getAssumptionLinksForAssumption(args.assumptionId);
  const link = links.find((candidate: any) => candidate.moveInstanceId === move.id);
  if (!link) return { result: `Move ${args.moveId} is not linked to assumption "${assumption.title}"` };
  await storage.deleteAssumptionLink(link.id);
  return { result: `Move ${args.moveId} unlinked from assumption "${assumption.title}"` };
}

function missingStrategyId(): ToolHandlerResult {
  return { result: "Missing strategyId. Call list_scenarios first to get available strategy IDs.", error: true };
}
