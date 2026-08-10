import type { ToolHandlerResult } from "../contracts";
import type { StrategySubHandler } from "./strategy-core";

export const strategySupportHandlers: Record<string, StrategySubHandler> = {
  list_notes: listContext,
  list_context: listContext,
  add_note: addContext,
  add_context: addContext,
  update_note: updateContext,
  update_context: updateContext,
  delete_note: deleteContext,
  delete_context: deleteContext,
  list_end_conditions: listEndConditions,
  add_end_condition: addEndCondition,
  update_end_condition: updateEndCondition,
  delete_end_condition: deleteEndCondition,
};

async function listContext(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return missingStrategyId();
  const entries = await storage.getContextEntries(goalId);
  if (entries.length === 0) return { result: "No context entries for this strategy." };
  const lines = entries.map((entry: any) => `- [${entry.type}] ${entry.content.slice(0, 100)}${entry.content.length > 100 ? "..." : ""} (id: ${entry.id})`);
  return { result: `${entries.length} context entries:\n${lines.join("\n")}` };
}

async function addContext(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return missingStrategyId();
  if (!args.content) return { result: "Missing content", error: true };
  const entry = await storage.createContextEntry({ goalId, type: args.type || "historical", content: args.content });
  return { result: `Context entry added (ID: ${entry.id}, type: ${entry.type})` };
}

async function updateContext(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.id) return { result: "Missing context entry id", error: true };
  const updates: Record<string, any> = {};
  if (args.content) updates.content = args.content;
  if (args.type) updates.type = args.type;
  const entry = await storage.updateContextEntry(args.id, updates);
  if (!entry) return { result: `Context entry ${args.id} not found`, error: true };
  return { result: `Context entry ${args.id} updated` };
}

async function deleteContext(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.id) return { result: "Missing context entry id", error: true };
  if (!await storage.deleteContextEntry(args.id)) return { result: `Context entry ${args.id} not found`, error: true };
  return { result: `Context entry ${args.id} deleted` };
}

async function listEndConditions(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return missingStrategyId();
  const conditions = await storage.getEndConditions(goalId);
  if (conditions.length === 0) return { result: "No end conditions for this strategy." };
  const lines = conditions.map((condition: any) => {
    const required = condition.isRequired ? "[REQUIRED]" : "[OPTIONAL]";
    const satisfied = condition.isSatisfied ? " [SATISFIED]" : "";
    return `- ${required}${satisfied} ${condition.description} (id: ${condition.id})`;
  });
  return { result: `${conditions.length} end conditions:\n${lines.join("\n")}` };
}

async function addEndCondition(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return missingStrategyId();
  if (!args.description) return { result: "Missing description", error: true };
  const condition = await storage.createEndCondition({
    goalId,
    description: args.description,
    isRequired: args.isRequired ?? false,
    isSatisfied: args.isSatisfied ?? false,
  });
  return { result: `End condition added (ID: ${condition.id})` };
}

async function updateEndCondition(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.id) return { result: "Missing end condition id", error: true };
  const updates: Record<string, any> = {};
  if (args.description) updates.description = args.description;
  if (args.isRequired !== undefined) updates.isRequired = args.isRequired;
  if (args.isSatisfied !== undefined) updates.isSatisfied = args.isSatisfied;
  const condition = await storage.updateEndCondition(args.id, updates);
  if (!condition) return { result: `End condition ${args.id} not found`, error: true };
  return { result: `End condition ${args.id} updated` };
}

async function deleteEndCondition(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.id) return { result: "Missing end condition id", error: true };
  if (!await storage.deleteEndCondition(args.id)) return { result: `End condition ${args.id} not found`, error: true };
  return { result: `End condition ${args.id} deleted` };
}

function missingStrategyId(): ToolHandlerResult {
  return { result: "Missing strategyId. Call list_scenarios first to get available strategy IDs.", error: true };
}
