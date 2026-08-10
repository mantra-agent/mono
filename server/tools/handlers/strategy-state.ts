import type { ToolHandlerResult } from "../contracts";
import type { StrategySubHandler } from "./strategy-core";

export const strategyStateHandlers: Record<string, StrategySubHandler> = {
  list_states: listStates,
  get_state: getState,
  create_state: createState,
  update_state: updateState,
  delete_state: deleteState,
  set_end_condition_effect: setEndConditionEffect,
  list_move_definitions: (args, storage) => handleMoveDefinition("list_move_definitions", args, storage),
  get_move_definition: (args, storage) => handleMoveDefinition("get_move_definition", args, storage),
  create_move_definition: (args, storage) => handleMoveDefinition("create_move_definition", args, storage),
  update_move_definition: (args, storage) => handleMoveDefinition("update_move_definition", args, storage),
  delete_move_definition: (args, storage) => handleMoveDefinition("delete_move_definition", args, storage),
};

async function listStates(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId", error: true };
  const states = await storage.getStates(goalId);
  if (states.length === 0) return { result: "No states defined for this strategy." };
  const lines = states.map((state: any) => `- ${state.name} (ID: ${state.id})${state.description ? ` — ${state.description}` : ""}`);
  return { result: `${states.length} state(s):\n${lines.join("\n")}` };
}

async function createState(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  const name = args.name;
  if (!goalId || !name) return { result: "Missing goalId or name", error: true };
  const state = await storage.createState({ goalId, name, description: args.description || "" });
  return { result: `State created: "${state.name}" (ID: ${state.id})` };
}

async function getState(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.stateId;
  if (!id) return { result: "Missing stateId", error: true };
  const state = await storage.getState(id);
  if (!state) return { result: `State ${id} not found`, error: true };
  const references = await storage.getStateReferences(id);
  const lines = [
    `State: ${state.name} (ID: ${state.id})`,
    state.description ? `Description: ${state.description}` : "",
    `Reached by ${references.terminatingMoves.length} move(s); branches into ${references.childMoves.length} move(s).`,
  ].filter(Boolean);
  return { result: lines.join("\n") };
}

async function updateState(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.stateId;
  if (!id) return { result: "Missing stateId", error: true };
  const updates: Record<string, any> = {};
  if (args.name !== undefined) updates.name = args.name;
  if (args.description !== undefined) updates.description = args.description;
  const state = await storage.updateState(id, updates);
  if (!state) return { result: `State ${id} not found`, error: true };
  return { result: `State updated: "${state.name}"` };
}

async function deleteState(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.stateId;
  if (!id) return { result: "Missing stateId", error: true };
  const result = await storage.deleteState(id);
  if (!result.deleted) return { result: result.reason || `State ${id} not found`, error: true };
  return { result: `State ${id} deleted` };
}

async function setEndConditionEffect(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const moveId = args.moveId;
  const endConditionId = args.endConditionId;
  const effect = args.effect;
  if (!moveId || !endConditionId || !effect) return { result: "Missing moveId, endConditionId, or effect", error: true };
  if (!["satisfies", "blocks", "none"].includes(effect)) return { result: "effect must be one of: satisfies, blocks, none", error: true };
  const resolved = await storage.resolveMoveInstance(moveId);
  if (!resolved) return { result: `Move ${moveId} not found`, error: true };
  await storage.setMoveEndConditionEffect(resolved.id, endConditionId, effect);
  return { result: `End-condition effect set: move=${resolved.id}, endCondition=${endConditionId}, effect=${effect}` };
}

async function handleMoveDefinition(action: string, args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (action === "list_move_definitions") {
    const goalId = args.goalId;
    const actorId = args.actorId;
    if (!goalId && !actorId) return { result: "Missing strategyId or actorId. Call list_scenarios first to get strategyIds, then list_actors to get actorIds.", error: true };
    const definitions = actorId ? await storage.getMoveDefinitionsByActor(actorId) : await storage.getMoveDefinitions(goalId);
    if (definitions.length === 0) return { result: "No move definitions found." };
    const lines = definitions.map((definition: any) => `- ${definition.title} (id: ${definition.id}, actorId: ${definition.actorId})${definition.description ? `: ${definition.description.slice(0, 100)}` : ""}`);
    return { result: `${definitions.length} move definitions:\n${lines.join("\n")}` };
  }
  if (action === "get_move_definition") {
    const id = args.id;
    if (!id) return { result: "Missing move definition id", error: true };
    const definition = await storage.getMoveDefinition(id);
    if (!definition) return { result: `Move definition ${id} not found`, error: true };
    const parts = [`**${definition.title}** (id: ${definition.id})`, `Actor: ${definition.actorId}`, `Goal: ${definition.goalId}`];
    if (definition.description) parts.push(`Description: ${definition.description}`);
    return { result: parts.join("\n") };
  }
  if (action === "create_move_definition") {
    const goalId = args.goalId;
    const actorId = args.actorId;
    const title = args.title;
    if (!goalId) return { result: "Missing strategyId. Call list_scenarios first to get available strategy IDs.", error: true };
    if (!actorId) return { result: "Missing actorId", error: true };
    if (!title) return { result: "Missing title", error: true };
    const definition = await storage.createMoveDefinition({ goalId, actorId, title, description: args.description || "" });
    return { result: `Move definition created: "${definition.title}" (id: ${definition.id}, actorId: ${definition.actorId}, goalId: ${definition.goalId})` };
  }
  if (action === "update_move_definition") {
    const id = args.id;
    if (!id) return { result: "Missing move definition id", error: true };
    const updates: Record<string, any> = {};
    if (args.title) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.actorId) updates.actorId = args.actorId;
    const definition = await storage.updateMoveDefinition(id, updates);
    if (!definition) return { result: `Move definition ${id} not found`, error: true };
    return { result: `Move definition updated: "${definition.title}" — ${Object.entries(updates).map(([key, value]) => `${key}: ${value}`).join(", ")}` };
  }
  const id = args.id;
  if (!id) return { result: "Missing move definition id", error: true };
  const deleted = await storage.deleteMoveDefinition(id);
  if (!deleted) return { result: `Move definition ${id} not found`, error: true };
  return { result: `Move definition ${id} deleted` };
}
