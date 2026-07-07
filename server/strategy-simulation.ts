import { eventBus } from "./event-bus";
import { strategyStorage } from "./strategy-storage";
import { peopleStorage } from "./people-storage";
import { getPromptModulePrompt } from "./prompt-modules";
import { ACTIVITY_STRATEGY } from "./job-profiles";
import type { StrategyMoveInstance } from "@shared/schema";
import { createLogger } from "./log";

const log = createLogger("StrategySim");

interface SimulationOptions {
  mode: "clear_and_simulate" | "update";
  sessionKey?: string;
}

interface DiscoveredMove {
  actorId: string;
  title: string;
  description: string;
  impact: string;
  shouldExplore: boolean;
  outcomes: Array<{
    title: string;
    description: string;
    probability: number;
  }>;
}

interface EvaluateResult {
  probability: number;
  evaluation: string;
  endConditionStatus?: Array<{
    endConditionId: string;
    status: string;
    note?: string;
  }>;
}

const activeSimulations = new Map<string, AbortController>();

export function getActiveSimulationCount(): number {
  return activeSimulations.size;
}

export function cancelSimulation(runId: string): boolean {
  const controller = activeSimulations.get(runId);
  if (controller) {
    log.log(`cancelSimulation runId=${runId}`);
    controller.abort();
    return true;
  }
  log.log(`cancelSimulation runId=${runId} not-found`);
  return false;
}

async function buildMoveContext(goalId: string, moveId: string): Promise<string> {
  log.log(`buildMoveContext goalId=${goalId} moveId=${moveId}`);
  const [goal, actors, contextEntries, endConditions, assumptions, movePath, moveDefinitions] = await Promise.all([
    strategyStorage.getStrategy(goalId),
    strategyStorage.getActors(goalId),
    strategyStorage.getContextEntries(goalId),
    strategyStorage.getEndConditions(goalId),
    strategyStorage.getAssumptions(goalId),
    strategyStorage.getMovePath(moveId),
    strategyStorage.getMoveDefinitions(goalId),
  ]);

  if (!goal) throw new Error(`Strategy ${goalId} not found`);

  const lines: string[] = [];

  lines.push(`## Strategic Goal: ${goal.title}`);
  if (goal.description) lines.push(goal.description);
  lines.push("");

  if (contextEntries.length > 0) {
    lines.push("## Context");
    for (const entry of contextEntries) {
      lines.push(`### ${entry.type === "historical" ? "Historical Fact" : "Current Position"}`);
      lines.push(entry.content);
      lines.push("");
    }
  }

  if (actors.length > 0) {
    lines.push("## Actors");
    for (const actor of actors) {
      lines.push(`### ${actor.name} (ID: ${actor.id})`);
      if (actor.notes) lines.push(`Notes: ${actor.notes}`);

      if (actor.personId) {
        try {
          const person = await peopleStorage.getPerson(actor.personId);
          if (person) {
            if (person.trust) lines.push(`Trust Level: ${person.trust}`);
            if (person.company) lines.push(`Company: ${person.company}`);
            if (person.role) lines.push(`Title: ${person.role}`);
            if (person.aiSummary) lines.push(`Analysis: ${person.aiSummary}`);
            else if (person.quickSummary) lines.push(`Summary: ${person.quickSummary}`);
          }
        } catch (err) {
          log.warn(`buildMoveContext degraded: failed to fetch optional person profile actorId=${actor.id} personId=${actor.personId}`, err);
        }
      }

      const actorDefs = moveDefinitions.filter(d => d.actorId === actor.id);
      if (actorDefs.length > 0) {
        lines.push(`  Known Moves:`);
        for (const def of actorDefs) {
          lines.push(`  - ${def.title}: ${def.description}`);
        }
      }
      lines.push("");
    }
  }

  if (assumptions.length > 0) {
    lines.push("## Assumptions");
    for (const a of assumptions) {
      lines.push(`- ${a.title} (probability: ${(a.probability * 100).toFixed(0)}%): ${a.description}`);
    }
    lines.push("");
  }

  if (endConditions.length > 0) {
    lines.push("## End Conditions (Desired Outcome)");
    for (const ec of endConditions) {
      const req = ec.isRequired ? "[REQUIRED]" : "[OPTIONAL]";
      const sat = ec.isSatisfied ? " ✓ SATISFIED" : "";
      lines.push(`- ${req} ${ec.description}${sat} (ID: ${ec.id})`);
    }
    lines.push("");
  }

  if (movePath.length > 0) {
    lines.push("## Path to Current Position (Move Sequence)");
    for (const m of movePath) {
      const prefix = m.depth === 0 ? "ROOT" : `Depth ${m.depth}`;
      const actor = m.actorId ? actors.find(a => a.id === m.actorId) : null;
      const actorLabel = actor ? ` by ${actor.name}` : "";
      lines.push(`[${prefix}] ${m.title}${actorLabel}: ${m.description}`);
      if (m.evaluation) lines.push(`  Evaluation: ${m.evaluation}`);
    }
    lines.push("");
  }

  const currentMove = movePath[movePath.length - 1];
  if (currentMove) {
    const childMoves = await strategyStorage.getChildMoveInstances(currentMove.id);
    if (childMoves.length > 0) {
      lines.push("## Existing Moves Already Explored From This Position");
      for (const child of childMoves) {
        const actor = child.actorId ? actors.find(a => a.id === child.actorId) : null;
        const def = child.moveDefinitionId ? moveDefinitions.find(d => d.id === child.moveDefinitionId) : null;
        lines.push(`- ${actor?.name || "Unknown"}: ${def?.title || child.title}`);
        if (child.impact) lines.push(`  Impact: ${child.impact}`);
      }
      lines.push("");
    }
  }

  const contextStr = lines.join("\n");
  log.log(`buildMoveContext complete goalId=${goalId} moveId=${moveId} contextLen=${contextStr.length}`);
  return contextStr;
}

async function callLLM(systemMessage: string, userMessage: string): Promise<string> {
  log.log(`callLLM systemLen=${systemMessage.length} userLen=${userMessage.length}`);
  const startTime = Date.now();
  const { chatCompletion } = await import("./model-client");
  const result = await chatCompletion({
    activity: ACTIVITY_STRATEGY,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ],
    temperature: 0.7,
    jsonMode: true,
    metadata: { source: "strategy-simulation", activity: ACTIVITY_STRATEGY },
  });
  const elapsed = Date.now() - startTime;
  log.log(`callLLM complete latency=${elapsed}ms responseLen=${result.content.length}`);
  return result.content;
}

function parseJsonResponse<T>(content: string): T {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.error("parseJsonResponse no JSON found in LLM response");
    throw new Error("No JSON found in LLM response");
  }
  return JSON.parse(jsonMatch[0]) as T;
}

export async function simulateMove(
  moveId: string,
  options?: { sessionKey?: string }
): Promise<StrategyMoveInstance[]> {
  log.log(`simulateMove start moveId=${moveId}`);
  const parentMove = await strategyStorage.getMoveInstance(moveId);
  if (!parentMove) throw new Error(`Move instance ${moveId} not found`);

  const context = await buildMoveContext(parentMove.goalId, moveId);
  const skillProcess = await getPromptModulePrompt("strategy-discovermoves");

  log.log(`simulateMove calling LLM for move discovery moveId=${moveId}`);
  const response = await callLLM(
    skillProcess || "You are a strategic simulator. Return JSON with a 'moves' array. Each move should have: actorId, title, description, impact, shouldExplore (boolean), and outcomes (array of {title, description, probability}).",
    `Analyze this strategic situation and discover all plausible next moves:\n\n${context}`
  );

  const parsed = parseJsonResponse<{ moves: DiscoveredMove[] }>(response);
  if (!parsed.moves || !Array.isArray(parsed.moves)) {
    log.log(`simulateMove no moves discovered moveId=${moveId}`);
    return [];
  }

  log.log(`simulateMove discovered ${parsed.moves.length} moves moveId=${moveId}`);

  const actors = await strategyStorage.getActors(parentMove.goalId);
  const actorIds = new Set(actors.map(a => a.id));
  const existingDefs = await strategyStorage.getMoveDefinitions(parentMove.goalId);

  const createdInstances: StrategyMoveInstance[] = [];

  for (const move of parsed.moves) {
    if (!actorIds.has(move.actorId)) {
      log.debug(`simulateMove skipping move with unknown actorId=${move.actorId}`);
      continue;
    }

    let moveDef = existingDefs.find(d => d.actorId === move.actorId && d.title.toLowerCase() === move.title.toLowerCase());
    if (!moveDef) {
      log.log(`simulateMove creating new move definition title="${move.title}" actorId=${move.actorId}`);
      moveDef = await strategyStorage.createMoveDefinition({
        goalId: parentMove.goalId,
        actorId: move.actorId,
        title: move.title,
        description: move.description,
      });
    }

    const outcomes = move.outcomes && move.outcomes.length > 0
      ? move.outcomes
      : [{ title: move.title, description: move.description, probability: 0.5 }];

    for (const outcome of outcomes) {
      const childMove = await strategyStorage.createMoveInstance({
        goalId: parentMove.goalId,
        parentMoveInstanceId: moveId,
        moveDefinitionId: moveDef.id,
        actorId: move.actorId,
        title: outcome.title,
        description: outcome.description,
        impact: move.impact,
        probability: outcome.probability,
        depth: parentMove.depth + 1,
        path: parentMove.path ? `${parentMove.path}/${parentMove.id}` : `/${parentMove.id}`,
        status: move.shouldExplore ? "unexplored" : "terminal",
        source: "simulated",
      });

      createdInstances.push(childMove);
    }
  }

  await strategyStorage.updateMoveInstance(moveId, { status: "explored" });
  log.log(`simulateMove complete moveId=${moveId} createdInstances=${createdInstances.length}`);

  return createdInstances;
}

export async function evaluateMove(
  moveId: string
): Promise<EvaluateResult> {
  log.log(`evaluateMove start moveId=${moveId}`);
  const move = await strategyStorage.getMoveInstance(moveId);
  if (!move) throw new Error(`Move instance ${moveId} not found`);

  const context = await buildMoveContext(move.goalId, moveId);
  const evalProcess = await getPromptModulePrompt("strategy-evaluatestate");

  log.log(`evaluateMove calling LLM moveId=${moveId}`);
  const response = await callLLM(
    evalProcess || "You are a strategic evaluator.",
    `Evaluate this strategic position:\n\n${context}`
  );

  const result = parseJsonResponse<EvaluateResult>(response);

  await strategyStorage.updateMoveInstance(moveId, {
    probability: result.probability,
    evaluation: result.evaluation,
  });

  log.log(`evaluateMove complete moveId=${moveId} probability=${result.probability}`);
  return result;
}

export async function simulateTree(
  moveId: string,
  options: SimulationOptions
): Promise<string> {
  log.log(`simulateTree start moveId=${moveId} mode=${options.mode}`);
  const rootMove = await strategyStorage.getMoveInstance(moveId);
  if (!rootMove) throw new Error(`Move instance ${moveId} not found`);

  const run = await strategyStorage.createSimulationRun({
    goalId: rootMove.goalId,
    rootMoveInstanceId: moveId,
    mode: options.mode,
    status: "running",
    progress: { movesProcessed: 0, movesTotal: 1, currentDepth: rootMove.depth, currentMoveName: rootMove.title },
  });

  const controller = new AbortController();
  activeSimulations.set(run.id, controller);

  const runId = run.id;
  log.log(`simulateTree runId=${runId} goalId=${rootMove.goalId}`);

  (async () => {
    try {
      if (options.mode === "clear_and_simulate") {
        log.log(`simulateTree clearing existing children runId=${runId} moveId=${moveId}`);
        const children = await strategyStorage.getChildMoveInstances(moveId);
        for (const child of children) {
          await strategyStorage.deleteMoveInstanceAndChildren(child.id);
        }
        await strategyStorage.updateMoveInstance(moveId, { status: "unexplored" });
        log.log(`simulateTree cleared ${children.length} children runId=${runId}`);
      }

      let movesProcessed = 0;
      let movesTotal = 1;

      const processMove = async (currentMoveId: string, depth: number): Promise<void> => {
        if (controller.signal.aborted) return;

        const currentMove = await strategyStorage.getMoveInstance(currentMoveId);
        if (!currentMove) return;

        log.log(`simulateTree processMove runId=${runId} moveId=${currentMoveId} depth=${depth} status=${currentMove.status}`);

        eventBus.publish({
          category: "strategy",
          event: "strategy.simulation.progress",
          payload: {
            runId,
            goalId: rootMove.goalId,
            movesProcessed,
            movesTotal,
            currentDepth: depth,
            currentMoveName: currentMove.title,
          },
          runId,
          sessionKey: options.sessionKey,
        });

        await strategyStorage.updateSimulationRun(runId, {
          progress: {
            movesProcessed,
            movesTotal,
            currentDepth: depth,
            currentMoveName: currentMove.title,
          },
        });

        if (options.mode === "update" && currentMove.status === "explored") {
          log.log(`simulateTree evaluating explored move runId=${runId} moveId=${currentMoveId}`);
          await evaluateMove(currentMoveId);
          movesProcessed++;

          const children = await strategyStorage.getChildMoveInstances(currentMoveId);
          movesTotal = Math.max(movesTotal, movesProcessed + children.length);
          for (const child of children) {
            if (controller.signal.aborted) return;
            await processMove(child.id, depth + 1);
          }
        } else if (currentMove.status === "unexplored" || options.mode === "clear_and_simulate") {
          log.log(`simulateTree simulating unexplored move runId=${runId} moveId=${currentMoveId}`);
          const newChildren = await simulateMove(currentMoveId);
          movesProcessed++;

          movesTotal = Math.max(movesTotal, movesProcessed + newChildren.length);
          for (const child of newChildren) {
            if (controller.signal.aborted) return;
            if (child.status !== "terminal") {
              await processMove(child.id, depth + 1);
            }
          }
        } else {
          movesProcessed++;
        }
      };

      await processMove(moveId, rootMove.depth);

      if (controller.signal.aborted) {
        log.log(`simulateTree cancelled runId=${runId} movesProcessed=${movesProcessed}`);
        await strategyStorage.updateSimulationRun(runId, {
          status: "cancelled",
          completedAt: new Date(),
          progress: { movesProcessed, movesTotal, currentDepth: 0, currentMoveName: "" },
        });
        eventBus.publish({
          category: "strategy",
          event: "strategy.simulation.cancelled",
          payload: { runId, goalId: rootMove.goalId, movesProcessed },
          runId,
          sessionKey: options.sessionKey,
        });
      } else {
        log.log(`simulateTree completed runId=${runId} movesProcessed=${movesProcessed}`);
        await strategyStorage.updateSimulationRun(runId, {
          status: "completed",
          completedAt: new Date(),
          progress: { movesProcessed, movesTotal: movesProcessed, currentDepth: 0, currentMoveName: "" },
        });
        eventBus.publish({
          category: "strategy",
          event: "strategy.simulation.complete",
          payload: { runId, goalId: rootMove.goalId, movesProcessed },
          runId,
          sessionKey: options.sessionKey,
        });
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || controller.signal.aborted) {
        log.log(`simulateTree aborted runId=${runId}`);
        await strategyStorage.updateSimulationRun(runId, {
          status: "cancelled",
          completedAt: new Date(),
        });
      } else {
        log.error(`simulateTree error runId=${runId}:`, err?.message || String(err));
        await strategyStorage.updateSimulationRun(runId, {
          status: "error",
          completedAt: new Date(),
          error: err?.message || String(err),
        });
        eventBus.publish({
          category: "strategy",
          event: "strategy.simulation.error",
          payload: { runId, goalId: rootMove.goalId, error: err?.message || String(err) },
          runId,
          sessionKey: options.sessionKey,
        });
      }
    } finally {
      activeSimulations.delete(runId);
    }
  })();

  return runId;
}

export async function evaluateMoveWithAgent(
  moveId: string,
  options?: { sessionKey?: string; awaitResult?: boolean }
): Promise<string> {
  log.log(`evaluateMoveWithAgent start moveId=${moveId}`);
  const move = await strategyStorage.getMoveInstance(moveId);
  if (!move) throw new Error(`Move instance ${moveId} not found`);

  const run = await strategyStorage.createSimulationRun({
    goalId: move.goalId,
    rootMoveInstanceId: moveId,
    mode: "evaluate",
    status: "running",
    progress: { movesProcessed: 0, movesTotal: 1, currentDepth: move.depth, currentMoveName: move.title },
  });

  const controller = new AbortController();
  activeSimulations.set(run.id, controller);
  const runId = run.id;
  const sessionKey = options?.sessionKey;

  log.log(`evaluateMoveWithAgent runId=${runId} goalId=${move.goalId}`);

  const work = async () => {
    try {
      const evalMoveProcess = await getPromptModulePrompt("strategy-evaluatemove");
      const systemMessage = evalMoveProcess || "You are a strategic move evaluator. Evaluate the move using the strategy tool.";

      const context = await buildMoveContext(move.goalId, moveId);
      const userMessage = `Evaluate this move:\n\nMove ID: ${moveId}\nGoal ID: ${move.goalId}\n\n${context}\n\nUse the strategy tool to pull any additional context you need, then update the move with your analysis, probability, actor states, child moves, and assumption links.`;

      const { agentExecutor } = await import("./agent-executor");
      const { executeBridgeTool } = await import("./bridge-tools");

      const { getAllTools } = await import("./tool-registry");
      const allTools = await getAllTools();
      const strategyToolReg = allTools.find(t => t.name === "strategy");
      if (!strategyToolReg) throw new Error("Strategy tool not found in tool registry");

      const tools = [{
        name: "strategy",
        description: strategyToolReg.description,
        parameters: {
          type: "object" as const,
          properties: strategyToolReg.parameters?.properties || {},
          required: strategyToolReg.parameters?.required,
        },
      }];

      const toolExecutor = async (name: string, args: Record<string, any>) => {
        log.log(`evaluateMoveWithAgent toolCall runId=${runId} tool=${name} action=${args.action}`);
        const result = await executeBridgeTool(name, `eval-${runId}-${Date.now()}`, args);
        return { result: result.result, error: result.error, sideEffectOnly: (result as any).sideEffectOnly };
      };

      eventBus.publish({
        category: "strategy",
        event: "strategy.evaluation.started",
        payload: { runId, goalId: move.goalId, moveId, moveTitle: move.title },
        runId,
        sessionKey,
      });

      const result = await agentExecutor.run({
        sessionKey: sessionKey || `strategy-eval:${runId}`,
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage },
        ],
        tools,
        toolExecutor,
        activity: ACTIVITY_STRATEGY,
        signal: controller.signal,
      });

      log.log(`evaluateMoveWithAgent completed runId=${runId} iterations=${result.iterations} toolCalls=${result.toolCalls.length}`);

      await strategyStorage.updateSimulationRun(runId, {
        status: "completed",
        completedAt: new Date(),
        progress: { movesProcessed: 1, movesTotal: 1, currentDepth: move.depth, currentMoveName: move.title },
      });

      eventBus.publish({
        category: "strategy",
        event: "strategy.evaluation.complete",
        payload: { runId, goalId: move.goalId, moveId, summary: result.content?.slice(0, 500) },
        runId,
        sessionKey,
      });

      return result.content || "Evaluation completed successfully.";
    } catch (err: any) {
      if (err?.name === "AbortError" || controller.signal.aborted) {
        log.log(`evaluateMoveWithAgent cancelled runId=${runId}`);
        await strategyStorage.updateSimulationRun(runId, {
          status: "cancelled",
          completedAt: new Date(),
        });
        return "Evaluation was cancelled.";
      } else {
        log.error(`evaluateMoveWithAgent error runId=${runId}:`, err?.message || String(err));
        await strategyStorage.updateSimulationRun(runId, {
          status: "error",
          completedAt: new Date(),
          error: err?.message || String(err),
        });
        eventBus.publish({
          category: "strategy",
          event: "strategy.evaluation.error",
          payload: { runId, goalId: move.goalId, moveId, error: err?.message || String(err) },
          runId,
          sessionKey,
        });
        throw err;
      }
    } finally {
      activeSimulations.delete(runId);
    }
  };

  if (options?.awaitResult) {
    await work();
  } else {
    work();
  }

  return runId;
}

export async function cascadeAssumption(assumptionId: string): Promise<void> {
  log.log(`cascadeAssumption assumptionId=${assumptionId}`);
  const assumption = await strategyStorage.getAssumption(assumptionId);
  if (!assumption) throw new Error(`Assumption ${assumptionId} not found`);
  log.log(`cascadeAssumption complete assumptionId=${assumptionId} title="${assumption.title}"`);
}
