import { strategyStorage } from "./strategy-storage";
import { peopleStorage } from "./people-storage";
import { contextBuilder } from "./context-builder";
import type { ContextRequest } from "../shared/context-spine";
import type {
  Strategy,
  StrategyActor,
  StrategyMoveInstance,
  StrategyMoveDefinition,
  StrategyAssumption,
  StrategyEndCondition,
  StrategyContextEntry,
} from "@shared/schema";
import { ACTIVITY_FRAMING } from "./job-profiles";
import { createLogger } from "./log";

const log = createLogger("StrategyContext");

async function getSpineContext(): Promise<string> {
  try {
    log.log("resolving spine context");
    const contextRequest: ContextRequest = {
      callType: "world",
      llmMode: "text",
      activity: ACTIVITY_FRAMING,
    };
    const resolvedSpine = await contextBuilder.resolve(contextRequest);
    const rendered = contextBuilder.renderToPrompt(resolvedSpine);
    log.log(`spine context resolved len=${rendered.length}`);
    return rendered;
  } catch (err) {
    log.error("Failed to resolve spine context:", err);
    return "";
  }
}

function formatStrategySection(strategy: Strategy, endConditions: StrategyEndCondition[]): string {
  const parts: string[] = [];
  parts.push(`## Strategy: ${strategy.title}`);
  if (strategy.description) {
    parts.push(`\n${strategy.description}`);
  }

  if (endConditions.length > 0) {
    parts.push(`\n### End Conditions`);
    for (const ec of endConditions) {
      const required = ec.isRequired ? "[REQUIRED]" : "[optional]";
      const satisfied = ec.isSatisfied ? " [SATISFIED]" : "";
      parts.push(`- ${required}${satisfied} ${ec.description}`);
    }
  }

  return parts.join("\n");
}

function formatContextEntries(entries: StrategyContextEntry[]): string {
  if (entries.length === 0) return "";

  const historical = entries.filter(e => e.type === "historical");
  const currentPosition = entries.filter(e => e.type === "current_position");

  const parts: string[] = [];
  parts.push(`### Strategic Context`);

  if (historical.length > 0) {
    parts.push(`\n#### Historical Facts`);
    for (const e of historical) {
      parts.push(`- ${e.content}`);
    }
  }

  if (currentPosition.length > 0) {
    parts.push(`\n#### Current Position`);
    for (const e of currentPosition) {
      parts.push(`- ${e.content}`);
    }
  }

  return parts.join("\n");
}

function formatAssumptions(assumptions: StrategyAssumption[]): string {
  if (assumptions.length === 0) return "";

  const parts: string[] = [];
  parts.push(`### Assumptions`);
  for (const a of assumptions) {
    const prob = (a.probability * 100).toFixed(0);
    parts.push(`- **${a.title}** (${prob}% likely): ${a.description}`);

  }

  return parts.join("\n");
}

async function formatActors(actors: StrategyActor[], moveDefinitions: StrategyMoveDefinition[]): Promise<string> {
  if (actors.length === 0) return "";

  const parts: string[] = [];
  parts.push(`### Actors`);

  for (const actor of actors) {
    const lines: string[] = [];
    lines.push(`- **${actor.name}**`);

    if (actor.notes) {
      lines.push(`  Notes: ${actor.notes}`);
    }

    if (actor.personId) {
      try {
        const person = await peopleStorage.getPerson(actor.personId);
        if (person) {
          const personDetails: string[] = [];
          if (person.trust) personDetails.push(`Trust: ${person.trust}`);
          if (person.company) personDetails.push(`Company: ${person.company}`);
          if (person.role) personDetails.push(`Title: ${person.role}`);
          if (person.relation) personDetails.push(`Relation: ${person.relation}`);
          if (person.quickSummary) personDetails.push(`Summary: ${person.quickSummary}`);
          else if (person.aiSummary) personDetails.push(`Analysis: ${person.aiSummary}`);
          if (personDetails.length > 0) {
            lines.push(`  Profile: ${personDetails.join("; ")}`);
          }
        }
      } catch (err) {
        log.warn(`formatActors degraded: failed to fetch optional person profile actorId=${actor.id} personId=${actor.personId}`, err);
      }
    }

    const actorDefs = moveDefinitions.filter(d => d.actorId === actor.id);
    if (actorDefs.length > 0) {
      lines.push(`  Known Moves:`);
      for (const def of actorDefs) {
        lines.push(`    - ${def.title}: ${def.description}`);
      }
    }

    parts.push(lines.join("\n"));
  }

  return parts.join("\n");
}

function formatMovePath(
  pathMoves: StrategyMoveInstance[],
  actors: Map<string, StrategyActor>,
  moveDefinitions: Map<string, StrategyMoveDefinition>
): string {
  if (pathMoves.length === 0) return "";

  const parts: string[] = [];
  parts.push(`### Path from Root to Current Position`);

  for (let i = 0; i < pathMoves.length; i++) {
    const move = pathMoves[i];
    const indent = "  ".repeat(i);
    const actor = move.actorId ? actors.get(move.actorId) : null;
    const def = move.moveDefinitionId ? moveDefinitions.get(move.moveDefinitionId) : null;
    const label = def?.title || move.title;
    const actorLabel = actor ? ` by ${actor.name}` : "";
    parts.push(`${indent}${i === 0 ? "Root" : `Step ${i}`}: **${label}**${actorLabel} (probability: ${(move.probability * 100).toFixed(0)}%)`);

    if (move.impact) {
      parts.push(`${indent}  Impact: ${move.impact}`);
    }
  }

  return parts.join("\n");
}

function formatCurrentMove(
  move: StrategyMoveInstance,
  childMoves: StrategyMoveInstance[],
  actors: Map<string, StrategyActor>,
  moveDefinitions: Map<string, StrategyMoveDefinition>
): string {
  const parts: string[] = [];
  const def = move.moveDefinitionId ? moveDefinitions.get(move.moveDefinitionId) : null;
  const label = def?.title || move.title;
  parts.push(`### Current Position: ${label}`);
  parts.push(`Status: ${move.status} | Probability: ${(move.probability * 100).toFixed(0)}% | Depth: ${move.depth}`);

  if (move.description) {
    parts.push(`\n${move.description}`);
  }

  if (move.evaluation) {
    parts.push(`\n**Evaluation:** ${move.evaluation}`);
  }

  if (childMoves.length > 0) {
    parts.push(`\n#### Child Moves from This Position`);
    for (const child of childMoves) {
      const childActor = child.actorId ? actors.get(child.actorId) : null;
      const childDef = child.moveDefinitionId ? moveDefinitions.get(child.moveDefinitionId) : null;
      const actorName = childActor?.name || "Unknown";
      parts.push(`- **${childDef?.title || child.title}** by ${actorName} (source: ${child.source})`);
      if (child.description) {
        parts.push(`  ${child.description}`);
      }
      if (child.impact) {
        parts.push(`  Impact: ${child.impact}`);
      }
    }
  }

  return parts.join("\n");
}

export async function buildStrategyContext(
  goalId: string,
  moveId?: string
): Promise<string> {
  log.log(`buildStrategyContext goalId=${goalId} moveId=${moveId || "none"}`);
  const [
    strategy,
    endConditions,
    contextEntries,
    assumptions,
    actors,
    moveDefinitions,
    spineContext,
    states,
    ecEffects,
    allMovesForCtx,
  ] = await Promise.all([
    strategyStorage.getStrategy(goalId),
    strategyStorage.getEndConditions(goalId),
    strategyStorage.getContextEntries(goalId),
    strategyStorage.getAssumptions(goalId),
    strategyStorage.getActors(goalId),
    strategyStorage.getMoveDefinitions(goalId),
    getSpineContext(),
    strategyStorage.getStates(goalId),
    strategyStorage.getMoveEndConditionEffectsForGoal(goalId),
    strategyStorage.getMoveInstancesForGoal(goalId),
  ]);

  if (!strategy) {
    log.log(`buildStrategyContext strategy not found goalId=${goalId}`);
    return `Strategy ${goalId} not found.`;
  }

  log.log(`buildStrategyContext assembling goalId=${goalId} actors=${actors.length} assumptions=${assumptions.length} endConditions=${endConditions.length} contextEntries=${contextEntries.length} moveDefs=${moveDefinitions.length}`);

  const sections: string[] = [];

  if (spineContext) {
    sections.push(`# System Context\n${spineContext}`);
  }

  sections.push(`\n# Strategy Analysis Context`);
  sections.push(formatStrategySection(strategy, endConditions));

  const contextEntriesStr = formatContextEntries(contextEntries);
  if (contextEntriesStr) {
    sections.push(contextEntriesStr);
  }

  const assumptionsStr = formatAssumptions(assumptions);
  if (assumptionsStr) {
    sections.push(assumptionsStr);
  }

  const actorsStr = await formatActors(actors, moveDefinitions);
  if (actorsStr) {
    sections.push(actorsStr);
  }

  if (states.length > 0) {
    const stateLines = [`### States (Milestones)`, `Shared convergence/branch points in the move tree.`];
    for (const s of states) {
      const terminating = allMovesForCtx.filter(m => m.terminatingStateId === s.id);
      const children = allMovesForCtx.filter(m => m.parentStateId === s.id);
      stateLines.push(`- **${s.name}** (id: ${s.id})${s.description ? ` — ${s.description}` : ""}`);
      if (terminating.length > 0) {
        stateLines.push(`  - Reached by: ${terminating.map(m => `${m.title || "(untitled)"} (id: ${m.id})`).join(", ")}`);
      }
      if (children.length > 0) {
        stateLines.push(`  - Branches into: ${children.map(m => `${m.title || "(untitled)"} (id: ${m.id})`).join(", ")}`);
      }
    }
    sections.push(stateLines.join("\n"));
  }

  if (ecEffects.length > 0) {
    const ecMap = new Map(endConditions.map(ec => [ec.id, ec]));
    const moveMap = new Map(allMovesForCtx.map(m => [m.id, m]));
    const byMove = new Map<string, typeof ecEffects>();
    for (const e of ecEffects) {
      if (!byMove.has(e.moveInstanceId)) byMove.set(e.moveInstanceId, []);
      byMove.get(e.moveInstanceId)!.push(e);
    }
    const lines = [`### End Condition Effects per Move`, `How each move affects required/optional end conditions.`];
    for (const [mid, effects] of byMove) {
      const m = moveMap.get(mid);
      if (!m) continue;
      const parts = effects.map(e => {
        const ec = ecMap.get(e.endConditionId);
        return `${ec?.description || e.endConditionId} → ${e.effect}`;
      });
      lines.push(`- ${m.title || "(untitled)"} (id: ${mid}): ${parts.join("; ")}`);
    }
    sections.push(lines.join("\n"));
  }

  if (moveId) {
    log.log(`buildStrategyContext resolving move path moveId=${moveId}`);
    const actorMap = new Map(actors.map(a => [a.id, a]));
    const defMap = new Map(moveDefinitions.map(d => [d.id, d]));

    const [pathMoves, currentMove, childMoves] = await Promise.all([
      strategyStorage.getMovePath(moveId),
      strategyStorage.getMoveInstance(moveId),
      strategyStorage.getChildMoveInstances(moveId),
    ]);

    log.log(`buildStrategyContext moveId=${moveId} pathLen=${pathMoves.length} children=${childMoves.length}`);

    const pathStr = formatMovePath(pathMoves, actorMap, defMap);
    if (pathStr) {
      sections.push(pathStr);
    }

    if (currentMove) {
      sections.push(formatCurrentMove(currentMove, childMoves, actorMap, defMap));
    }
  }

  const result = sections.join("\n\n");
  log.log(`buildStrategyContext complete goalId=${goalId} totalLen=${result.length}`);
  return result;
}
