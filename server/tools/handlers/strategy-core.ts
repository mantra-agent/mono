import type { ToolHandlerResult } from "../contracts";

export type StrategySubHandler = (args: Record<string, any>, storage: any) => Promise<ToolHandlerResult>;

export const strategyCoreHandlers: Record<string, StrategySubHandler> = {
  list_scenarios: listStrategies,
  get_scenario: getStrategy,
  create_scenario: createStrategy,
  update_scenario: updateStrategy,
  delete_scenario: deleteStrategy,
  list_goals: listStrategies,
  get_goal: getStrategy,
  create_goal: createStrategy,
  update_goal: updateStrategy,
  delete_goal: deleteStrategy,
  list_actors: listActors,
  get_actor: getActor,
  add_actor: addActor,
  update_actor: updateActor,
  remove_actor: removeActor,
};

async function listStrategies(_args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const strategies = await storage.getStrategies();
  if (strategies.length === 0) return { result: "No strategies yet." };
  const lines = strategies.map((strategy: any) => `- **${strategy.title}** (id: ${strategy.id})`);
  return { result: `${strategies.length} strategies:\n${lines.join("\n")}` };
}

async function getStrategy(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.goalId;
  if (!id) return { result: "Missing goalId. Call list_scenarios first to get available strategy IDs.", error: true };
  const strategy = await storage.getStrategy(id);
  if (!strategy) return { result: `Strategy ${id} not found`, error: true };
  const actors = await storage.getActors(id);
  const moves = await storage.getMoveTree(id);
  const assumptions = await storage.getAssumptions(id);
  const endConditions = await storage.getEndConditions(id);
  const contextEntries = await storage.getContextEntries(id);
  const parts = [`**${strategy.title}** (id: ${strategy.id})`];
  if (strategy.description) parts.push(`Description: ${strategy.description}`);
  parts.push(`Actors: ${actors.length}, Moves: ${moves.length}, Assumptions: ${assumptions.length}, End Conditions: ${endConditions.length}, Notes: ${contextEntries.length}`);
  return { result: parts.join("\n") };
}

async function createStrategy(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const title = args.title;
  if (!title) return { result: "Missing strategy title", error: true };
  const existing = await storage.getStrategies();
  const normalizedTitle = title.toLowerCase().trim();
  const similar = existing.find((strategy: any) => {
    const existingTitle = strategy.title.toLowerCase().trim();
    return existingTitle === normalizedTitle || existingTitle.includes(normalizedTitle) || normalizedTitle.includes(existingTitle);
  });
  if (similar) return { result: `A scenario with a similar title already exists: "${similar.title}" (ID: ${similar.id}). Use update_scenario with strategyId="${similar.id}" to modify it, or provide a distinctly different title to create_scenario.`, error: true };
  const strategy = await storage.createStrategy({ title, description: args.description || "" });
  return { result: `Strategy created: "${strategy.title}" (ID: ${strategy.id})` };
}

async function updateStrategy(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.goalId;
  if (!id) return { result: "Missing goalId. Call list_scenarios first to get available strategy IDs.", error: true };
  const updates: Record<string, any> = {};
  if (args.title) updates.title = args.title;
  if (args.description) updates.description = args.description;
  const strategy = await storage.updateStrategy(id, updates);
  if (!strategy) return { result: `Strategy ${id} not found`, error: true };
  return { result: `Strategy updated: "${strategy.title}" — ${Object.entries(updates).map(([key, value]) => `${key}: ${value}`).join(", ")}` };
}

async function deleteStrategy(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.goalId;
  if (!id) return { result: "Missing goalId. Call list_scenarios first to get available strategy IDs.", error: true };
  const deleted = await storage.deleteStrategy(id);
  if (!deleted) return { result: `Strategy ${id} not found`, error: true };
  return { result: `Strategy ${id} deleted` };
}

async function listActors(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_scenarios first to get available strategy IDs.", error: true };
  const actors = await storage.getActors(goalId);
  if (actors.length === 0) return { result: "No actors for this strategy." };
  const lines = actors.map((actor: any) => `- **${actor.name}** (id: ${actor.id}, ${Math.round((actor.influence ?? 0.5) * 100)}% influence) [person: ${actor.personId}]`);
  return { result: `${actors.length} actors:\n${lines.join("\n")}` };
}

async function getActor(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing actor id", error: true };
  const actor = await storage.getActor(id);
  if (!actor) return { result: `Actor ${id} not found`, error: true };
  const parts = [`**${actor.name}** (id: ${actor.id})`, `Influence: ${Math.round((actor.influence ?? 0.5) * 100)}%`];
  if (actor.notes) parts.push(`Notes: ${actor.notes}`);
  parts.push(`Person ID: ${actor.personId}`);
  return { result: parts.join("\n") };
}

async function addActor(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_scenarios first to get available strategy IDs.", error: true };
  const name = args.name;
  if (!name) return { result: "Missing actor name", error: true };
  const personId = args.personId;
  if (!personId) return { result: "Missing personId - actors must be linked to a person", error: true };
  const influence = Math.max(0, Math.min(1, args.influence ?? 0.5));
  const actor = await storage.createActor({ goalId, name, notes: args.notes || "", personId, influence });
  return { result: `Actor added: "${actor.name}" (ID: ${actor.id}, influence: ${Math.round((actor.influence ?? 0.5) * 100)}%)` };
}

async function updateActor(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing actor id", error: true };
  const updates: Record<string, any> = {};
  if (args.name) updates.name = args.name;
  if (args.notes) updates.notes = args.notes;
  if (args.influence !== undefined) updates.influence = Math.max(0, Math.min(1, args.influence));
  const actor = await storage.updateActor(id, updates);
  if (!actor) return { result: `Actor ${id} not found`, error: true };
  return { result: `Actor updated: "${actor.name}" — ${Object.entries(updates).map(([key, value]) => key === "influence" ? `influence: ${Math.round((value as number) * 100)}%` : `${key}: ${value}`).join(", ")}` };
}

async function removeActor(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing actor id", error: true };
  const deleted = await storage.deleteActor(id);
  if (!deleted) return { result: `Actor ${id} not found`, error: true };
  return { result: `Actor ${id} removed` };
}
