import type { ToolHandlerResult } from "../contracts";
import type { StrategySubHandler } from "./strategy-core";

export const strategyMoveReadHandlers: Record<string, StrategySubHandler> = {
  get_move_tree: getMoveTree,
  get_move: getMove,
  get_move_path: getMovePath,
  list_child_moves: listChildMoves,
};

async function getMoveTree(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_scenarios first to get available strategy IDs.", error: true };
  const moves = await storage.getMoveTree(goalId);
  if (moves.length === 0) return { result: "No moves in this strategy's tree." };
  const actors = await storage.getActors(goalId);
  const actorMap = new Map(actors.map((actor: any) => [actor.id, actor.name]));
  const lines = moves.map((move: any) => {
    const indent = "  ".repeat(move.depth);
    const probability = `${(move.probability * 100).toFixed(0)}%`;
    const actorName = move.actorId ? (actorMap.get(move.actorId) || "Unknown") : "";
    const actorLabel = actorName ? ` by ${actorName}` : "";
    const reference = move.refId ? ` #${move.refId}` : "";
    const states = move.actorStates as any[] || [];
    const stateLabel = states.length > 0
      ? ` | states: ${states.map((state: any) => `${actorMap.get(state.actorId) || state.actorId}: "${state.state}"`).join(", ")}`
      : "";
    const identity = reference ? `${reference}, prob: ${probability}` : `prob: ${probability}`;
    return `${indent}- [${move.status}] **${move.title}**${actorLabel} (${identity})${stateLabel}`;
  });
  return { result: `${moves.length} moves:\n${lines.join("\n")}` };
}

async function getMove(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.moveId;
  if (!id) return { result: "Missing moveId", error: true };
  const move = await storage.resolveMoveInstance(id);
  if (!move) return { result: `Move ${id} not found`, error: true };
  const actors = await storage.getActors(move.goalId);
  const actorMap = new Map(actors.map((actor: any) => [actor.id, actor.name]));
  const actorName = move.actorId ? (actorMap.get(move.actorId) || "Unknown") : "";
  const reference = move.refId ? `#${move.refId}` : "";
  const identity = reference ? `${reference}, id: ${move.id}` : `id: ${move.id}`;
  const parts = [`**${move.title}**${actorName ? ` by ${actorName}` : ""} (${identity}, ${move.status})`];
  parts.push(`Probability: ${(move.probability * 100).toFixed(0)}%, Depth: ${move.depth}`);
  if (move.description) parts.push(`Description: ${move.description}`);
  if (move.evaluation) parts.push(`Analysis: ${move.evaluation}`);
  if (move.impact) parts.push(`Impact: ${move.impact}`);
  parts.push(`Source: ${move.source}`);

  const historyPath = await storage.getMovePath(id);
  if (historyPath.length > 1) {
    const historyLines = historyPath.map((historyMove: any, index: number) => {
      const historyActor = historyMove.actorId ? (actorMap.get(historyMove.actorId) || "Unknown") : "—";
      const historyReference = historyMove.refId ? `#${historyMove.refId}` : "";
      const marker = historyMove.id === move.id ? " ← current" : "";
      const historyIdentity = historyReference
        ? `${historyReference}, prob: ${(historyMove.probability * 100).toFixed(0)}%`
        : `prob: ${(historyMove.probability * 100).toFixed(0)}%`;
      return `  ${index + 1}. ${historyActor}: **${historyMove.title}** (${historyIdentity})${marker}`;
    });
    parts.push(`\nMove History (${historyPath.length} moves):\n${historyLines.join("\n")}`);
  }

  const accumulatedStates = new Map<string, string>();
  for (const historyMove of historyPath) {
    const states = historyMove.actorStates as any[] || [];
    for (const state of states) {
      if (state.state && state.state.trim() !== "") accumulatedStates.set(state.actorId, state.state);
    }
  }
  if (accumulatedStates.size > 0 || actors.length > 0) {
    const stateLines = actors.map((actor: any) => {
      const state = accumulatedStates.get(actor.id);
      const influence = `${Math.round((actor.influence ?? 0.5) * 100)}% influence`;
      return state ? `  - ${actor.name} (${influence}): "${state}"` : `  - ${actor.name} (${influence}): (no state set)`;
    });
    parts.push(`\nAccumulated Actor States:\n${stateLines.join("\n")}`);
  }

  const assumptions = await storage.getAssumptions(move.goalId);
  const assumptionLinks = await storage.getAssumptionLinksForGoal(move.goalId);
  const linkedIds = new Set(assumptionLinks.filter((link: any) => link.moveInstanceId === move.id).map((link: any) => link.assumptionId));
  const linked = assumptions.filter((assumption: any) => linkedIds.has(assumption.id));
  if (linked.length > 0) {
    const assumptionLines = linked.map((assumption: any) => `  - "${assumption.title}" (prob: ${(assumption.probability * 100).toFixed(0)}%)`);
    parts.push(`Linked Assumptions:\n${assumptionLines.join("\n")}`);
  }

  const states = await storage.getStates(move.goalId);
  const stateMap = new Map(states.map((state: any) => [state.id, state.name]));
  if (move.parentStateId) parts.push(`Parent State: "${stateMap.get(move.parentStateId) || "?"}" (id: ${move.parentStateId})`);
  else if (move.parentMoveInstanceId) parts.push(`Parent Move: ${move.parentMoveInstanceId}`);
  if (move.terminatingStateId) parts.push(`Terminating State: "${stateMap.get(move.terminatingStateId) || "?"}" (id: ${move.terminatingStateId})`);

  const effects = await storage.getMoveEndConditionEffects(move.id);
  if (effects.length > 0) {
    const endConditions = await storage.getEndConditions(move.goalId);
    const endConditionMap = new Map(endConditions.map((condition: any) => [condition.id, condition]));
    const effectLines = effects.map((effect: any) => {
      const condition: any = endConditionMap.get(effect.endConditionId);
      const label = condition ? `"${condition.title}"${condition.isRequired ? " [required]" : ""}` : effect.endConditionId;
      return `  - ${effect.effect.toUpperCase()}: ${label}`;
    });
    parts.push(`End Condition Effects:\n${effectLines.join("\n")}`);
  }
  return { result: parts.join("\n") };
}

async function getMovePath(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.moveId;
  if (!id) return { result: "Missing move id", error: true };
  const resolvedMove = await storage.resolveMoveInstance(id);
  if (!resolvedMove) return { result: `Move ${id} not found`, error: true };
  const path = await storage.getMovePath(resolvedMove.id);
  if (path.length === 0) return { result: `Move ${id} not found`, error: true };
  const actors = await storage.getActors(path[0].goalId);
  const actorMap = new Map(actors.map((actor: any) => [actor.id, actor.name]));
  const accumulatedStates = new Map<string, string>();
  const lines = path.map((move: any) => {
    const prefix = move.depth === 0 ? "ROOT" : `Depth ${move.depth}`;
    const actorName = move.actorId ? (actorMap.get(move.actorId) || "Unknown") : "—";
    const reference = move.refId ? `#${move.refId}` : "";
    const changes: string[] = [];
    for (const state of move.actorStates as any[] || []) {
      if (state.state && state.state.trim() !== "" && accumulatedStates.get(state.actorId) !== state.state) changes.push(`${actorMap.get(state.actorId) || state.actorId}: "${state.state}"`);
      if (state.state && state.state.trim() !== "") accumulatedStates.set(state.actorId, state.state);
    }
    const changeLabel = changes.length > 0 ? ` | state changes: ${changes.join(", ")}` : "";
    const identity = reference ? `${reference}, prob: ${(move.probability * 100).toFixed(0)}%` : `prob: ${(move.probability * 100).toFixed(0)}%`;
    return `[${prefix}] ${actorName}: ${move.title} (${identity}, ${move.status})${changeLabel}`;
  });
  return { result: `Path (${path.length} moves):\n${lines.join("\n")}` };
}

async function listChildMoves(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const parentId = args.parentId;
  if (!parentId) return { result: "Missing parentId / moveId", error: true };
  const parent = await storage.resolveMoveInstance(parentId);
  const children = await storage.getChildMoveInstances(parent?.id || parentId);
  if (children.length === 0) return { result: "No child moves from this position." };
  const parentStateMap = new Map((parent?.actorStates as any[] || []).map((state: any) => [state.actorId, state.state]));
  const actors = await storage.getActors(children[0].goalId);
  const actorMap = new Map(actors.map((actor: any) => [actor.id, actor.name]));
  const assumptionLinks = await storage.getAssumptionLinksForGoal(children[0].goalId);
  const lines = children.map((child: any) => {
    const actorName = child.actorId ? (actorMap.get(child.actorId) || "Unknown") : "—";
    const changedStates = (child.actorStates as any[] || []).filter((state: any) => state.state && state.state.trim() !== "" && parentStateMap.get(state.actorId) !== state.state);
    const stateLabel = changedStates.length > 0 ? ` | state changes: ${changedStates.map((state: any) => `${actorMap.get(state.actorId) || state.actorId}: "${state.state}"`).join(", ")}` : "";
    const linkedCount = assumptionLinks.filter((link: any) => link.moveInstanceId === child.id).length;
    const assumptionLabel = linkedCount > 0 ? ` | ${linkedCount} linked assumptions` : "";
    const reference = child.refId ? `#${child.refId}` : "";
    const identity = reference ? `${reference}, ${child.source}, prob: ${(child.probability * 100).toFixed(0)}%` : `${child.source}, prob: ${(child.probability * 100).toFixed(0)}%`;
    return `- **${child.title}** by ${actorName} (${identity})${stateLabel}${assumptionLabel}`;
  });
  return { result: `${children.length} child moves:\n${lines.join("\n")}` };
}
