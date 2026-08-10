import type { ToolHandlerResult } from "../contracts";
import type { StrategySubHandler } from "./strategy-core";

export const strategyMoveMutationHandlers: Record<string, StrategySubHandler> = {
  create_move: createMove,
  update_move: updateMove,
  delete_move: deleteMove,
  reparent_move: reparentMove,
};

async function applyEndConditionEffects(args: Record<string, any>, moveId: string, storage: any): Promise<void> {
  const effects: Array<{ endConditionId: string; effect: "satisfies" | "blocks" | "none" }> = Array.isArray(args.endConditionEffects) ? args.endConditionEffects : [];
  for (const entry of effects) {
    if (!entry?.endConditionId || !entry?.effect) continue;
    if (!["satisfies", "blocks", "none"].includes(entry.effect)) continue;
    await storage.setMoveEndConditionEffect(moveId, entry.endConditionId, entry.effect);
  }
}

async function createMove(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_scenarios first to get available strategy IDs.", error: true };
  const title = args.title;
  if (!title) return { result: "Missing move title", error: true };
  const moveDefinitionId = args.moveDefinitionId;
  if (!moveDefinitionId) return { result: "Missing moveDefinitionId. You must instantiate from an existing move definition. Use list_move_definitions to find one, or create_move_definition to create one first.", error: true };
  const definition = await storage.getMoveDefinition(moveDefinitionId);
  if (!definition) return { result: `Move definition ${moveDefinitionId} not found`, error: true };
  const data: Record<string, any> = {
    goalId,
    title,
    description: args.description || "",
    evaluation: args.analysis || "",
    impact: args.impact || "",
    actorStates: args.actorStates || [],
    probability: args.probability ?? 0.5,
    status: args.status || "unexplored",
    source: args.source || "manual",
    actorId: definition.actorId,
    moveDefinitionId,
    parentMoveInstanceId: args.parentMoveInstanceId || null,
    parentStateId: args.parentStateId || null,
    terminatingStateId: args.terminatingStateId || null,
    depth: 0,
    path: "",
  };
  if (data.parentMoveInstanceId) {
    const parent = await storage.resolveMoveInstance(data.parentMoveInstanceId);
    if (parent) {
      data.parentMoveInstanceId = parent.id;
      data.depth = parent.depth + 1;
      data.path = parent.path ? `${parent.path}/${parent.id}` : parent.id;
    }
  }
  const move = await storage.createMoveInstance(data);
  await applyEndConditionEffects(args, move.id, storage);
  const reference = move.refId ? `#${move.refId}` : "";
  const label = reference ? `${reference}, ID: ${move.id}` : `ID: ${move.id}`;
  return { result: `Move created: "${move.title}" (${label}, depth: ${move.depth}, actor: ${definition.actorId})` };
}

async function updateMove(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.moveId;
  if (!id) return { result: "Missing move id", error: true };
  const resolved = await storage.resolveMoveInstance(id);
  if (!resolved) return { result: `Move ${id} not found`, error: true };
  const updates: Record<string, any> = {};
  if (args.title) updates.title = args.title;
  if (args.description) updates.description = args.description;
  if (args.analysis) updates.evaluation = args.analysis;
  if (args.impact) updates.impact = args.impact;
  if (args.probability !== undefined) updates.probability = args.probability;
  if (args.status) updates.status = args.status;
  if (args.actorStates) updates.actorStates = args.actorStates;
  if (args.parentStateId !== undefined) updates.parentStateId = args.parentStateId || null;
  if (args.terminatingStateId !== undefined) updates.terminatingStateId = args.terminatingStateId || null;
  const move = await storage.updateMoveInstance(resolved.id, updates);
  if (!move) return { result: `Move ${id} not found`, error: true };
  await applyEndConditionEffects(args, move.id, storage);
  return { result: `Move updated: "${move.title}" — ${Object.entries(updates).map(([key, value]) => `${key}: ${value}`).join(", ")}` };
}

async function deleteMove(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.moveId;
  if (!id) return { result: "Missing move id", error: true };
  const resolved = await storage.resolveMoveInstance(id);
  if (!resolved) return { result: `Move ${id} not found`, error: true };
  const deleted = await storage.deleteMoveInstanceAndChildren(resolved.id);
  if (!deleted) return { result: `Move ${id} not found`, error: true };
  return { result: `Move ${id} and all children deleted` };
}

async function reparentMove(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.moveId;
  if (!id) return { result: "Missing move id", error: true };
  const resolved = await storage.resolveMoveInstance(id);
  if (!resolved) return { result: `Move ${id} not found`, error: true };
  const newParentRaw = args.newParentId ?? args.parentMoveInstanceId ?? undefined;
  let newParentId: string | null = null;
  if (newParentRaw !== undefined && newParentRaw !== null) {
    const parent = await storage.resolveMoveInstance(newParentRaw);
    if (!parent) return { result: `New parent move ${newParentRaw} not found`, error: true };
    newParentId = parent.id;
  }
  try {
    const move = await storage.reparentMoveInstance(resolved.id, newParentId);
    if (!move) return { result: `Failed to reparent move ${id}`, error: true };
    return { result: `Move "${move.title}" reparented successfully (new depth: ${move.depth}, parent: ${newParentId || "root"})` };
  } catch (error: any) {
    if (error.message?.includes("Circular") || error.message?.includes("Cannot reparent")) return { result: error.message, error: true };
    throw error;
  }
}
