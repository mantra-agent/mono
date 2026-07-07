// Use createLogger for logging ONLY
import type { Express } from "express";
import { requireAuth } from "./auth";
import { strategyStorage, migrateStrategySchema } from "./strategy-storage";
import { peopleStorage } from "./people-storage";
import {
  insertStrategySchema,
  insertStrategyActorSchema,
  insertStrategyMoveDefinitionSchema,
  insertStrategyMoveInstanceSchema,
  insertStrategyAssumptionSchema,
  insertStrategyAssumptionLinkSchema,
  assumptionLinkPolarityValues,
  insertStrategyEndConditionSchema,
  insertStrategyContextEntrySchema,
  insertStrategyArtifactSchema,
  insertStrategyStateSchema,
  strategyMoveEndConditionEffectValues,
  type StrategyMoveInstance,
  type StrategyEndCondition,
  type StrategyMoveEndConditionEffect,
} from "@shared/schema";
import { z } from "zod";
import { createLogger } from "./log";

interface OptimalPathResult {
  targetNodeId: string;
  targetNodeTitle: string;
  nodes: StrategyMoveInstance[];
  score: number;
  satisfiedEndConditions: StrategyEndCondition[];
}

function computeOptimalPaths(
  moves: StrategyMoveInstance[],
  endConditions: StrategyEndCondition[],
  effects: StrategyMoveEndConditionEffect[],
  currentPositionId: string | null,
): { currentPositionId: string | null; paths: OptimalPathResult[]; unsatisfiedEndConditions: StrategyEndCondition[] } {
  if (moves.length === 0) {
    return { currentPositionId, paths: [], unsatisfiedEndConditions: endConditions };
  }

  const byId = new Map(moves.map(m => [m.id, m]));
  const currentPos = currentPositionId && byId.has(currentPositionId) ? currentPositionId : null;
  const endConditionMap = new Map(endConditions.map(ec => [ec.id, ec]));
  const requiredEcIds = new Set(endConditions.filter(ec => ec.isRequired).map(ec => ec.id));

  const satisfiesByMove = new Map<string, Set<string>>();
  const blocksByMove = new Map<string, Set<string>>();
  for (const e of effects) {
    if (e.effect === "satisfies") {
      if (!satisfiesByMove.has(e.moveInstanceId)) satisfiesByMove.set(e.moveInstanceId, new Set());
      satisfiesByMove.get(e.moveInstanceId)!.add(e.endConditionId);
    } else if (e.effect === "blocks") {
      if (!blocksByMove.has(e.moveInstanceId)) blocksByMove.set(e.moveInstanceId, new Set());
      blocksByMove.get(e.moveInstanceId)!.add(e.endConditionId);
    }
  }

  const movesTerminatingAtState = new Map<string, StrategyMoveInstance[]>();
  for (const m of moves) {
    if (m.terminatingStateId) {
      if (!movesTerminatingAtState.has(m.terminatingStateId)) movesTerminatingAtState.set(m.terminatingStateId, []);
      movesTerminatingAtState.get(m.terminatingStateId)!.push(m);
    }
  }

  function getParentMoves(node: StrategyMoveInstance): StrategyMoveInstance[] {
    if (node.parentMoveInstanceId) {
      const p = byId.get(node.parentMoveInstanceId);
      return p ? [p] : [];
    }
    if (node.parentStateId) {
      return movesTerminatingAtState.get(node.parentStateId) || [];
    }
    return [];
  }

  function enumeratePathsToRoot(toId: string, fromId: string | null): StrategyMoveInstance[][] {
    const start = byId.get(toId);
    if (!start) return [];
    const results: StrategyMoveInstance[][] = [];
    const dfs = (cur: StrategyMoveInstance, acc: StrategyMoveInstance[], visited: Set<string>) => {
      if (visited.has(cur.id)) return;
      const nextAcc = [cur, ...acc];
      const nextVisited = new Set(visited); nextVisited.add(cur.id);
      if (fromId && cur.id === fromId) { results.push(nextAcc); return; }
      const parents = getParentMoves(cur);
      if (parents.length === 0) {
        if (!fromId) results.push(nextAcc);
        return;
      }
      for (const p of parents) dfs(p, nextAcc, nextVisited);
    };
    dfs(start, [], new Set());
    return results;
  }

  function reachableFrom(targetId: string, fromId: string): boolean {
    if (targetId === fromId) return true;
    const paths = enumeratePathsToRoot(targetId, fromId);
    return paths.length > 0;
  }

  const candidates = moves.filter(m => {
    if (!satisfiesByMove.has(m.id)) return false;
    if (!currentPos) return true;
    return reachableFrom(m.id, currentPos);
  });

  const allSatisfiedIds = new Set<string>();
  for (const [, set] of satisfiesByMove) for (const id of set) allSatisfiedIds.add(id);

  const paths: OptimalPathResult[] = [];

  for (const candidate of candidates) {
    const pathOptions = enumeratePathsToRoot(candidate.id, currentPos);
    let bestPath: StrategyMoveInstance[] | null = null;
    let bestScore = -1;
    for (const pathNodes of pathOptions) {
      let blockedRequired = false;
      for (const node of pathNodes) {
        const blocks = blocksByMove.get(node.id);
        if (blocks) {
          for (const ecId of blocks) {
            if (requiredEcIds.has(ecId)) { blockedRequired = true; break; }
          }
        }
        if (blockedRequired) break;
      }
      if (blockedRequired) continue;
      let score = 1;
      for (const node of pathNodes) {
        if (node.id === currentPos) continue;
        score *= node.probability;
      }
      if (score > bestScore) { bestScore = score; bestPath = pathNodes; }
    }
    if (!bestPath) continue;

    const satisfiedEcs = Array.from(satisfiesByMove.get(candidate.id) || [])
      .map(id => endConditionMap.get(id))
      .filter((ec): ec is StrategyEndCondition => !!ec);

    paths.push({
      targetNodeId: candidate.id,
      targetNodeTitle: candidate.title,
      nodes: bestPath,
      score: bestScore,
      satisfiedEndConditions: satisfiedEcs,
    });
  }

  paths.sort((a, b) => b.score - a.score);

  const unsatisfiedEndConditions = endConditions.filter(ec => !allSatisfiedIds.has(ec.id));

  return { currentPositionId: currentPos, paths, unsatisfiedEndConditions };
}

const log = createLogger("StrategyRoutes");

export function registerStrategyRoutes(app: Express): void {
  app.use("/api/strategy", requireAuth);

  migrateStrategySchema().catch(err => {
    log.error("schema migration error:", err.message);
  });

  app.get("/api/strategy/goals", async (req, res) => {
    log.debug("GET /api/strategy/goals");
    try {
      const includeArchived = req.query.includeArchived === "true" || req.query.archived === "true";
      const list = includeArchived
        ? await strategyStorage.getAllStrategies()
        : await strategyStorage.getStrategies({ archived: false });
      res.json(list);
    } catch (error: any) {
      log.error("GET /api/strategy/goals error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/goals", async (req, res) => {
    log.debug("POST /api/strategy/goals");
    try {
      const parsed = insertStrategySchema.parse(req.body);
      const strategy = await strategyStorage.createStrategy(parsed);
      res.status(201).json(strategy);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn("POST /api/strategy/goals validation error:", error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error("POST /api/strategy/goals error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:id", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.id}`);
    try {
      const strategy = await strategyStorage.getStrategy(req.params.id);
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      res.json(strategy);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/strategy/goals/:id", async (req, res) => {
    log.debug(`PATCH /api/strategy/goals/${req.params.id}`);
    try {
      const parsed = insertStrategySchema.partial().parse(req.body);
      const strategy = await strategyStorage.updateStrategy(req.params.id, parsed);
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      res.json(strategy);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`PATCH /api/strategy/goals/${req.params.id} validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`PATCH /api/strategy/goals/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/goals/:id/duplicate", async (req, res) => {
    log.debug(`POST /api/strategy/goals/${req.params.id}/duplicate`);
    try {
      const newStrategy = await strategyStorage.duplicateStrategy(req.params.id);
      if (!newStrategy) return res.status(404).json({ error: "Strategy not found" });
      res.status(201).json(newStrategy);
    } catch (error: any) {
      log.error(`POST /api/strategy/goals/${req.params.id}/duplicate error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/strategy/goals/:id", async (req, res) => {
    log.debug(`DELETE /api/strategy/goals/${req.params.id}`);
    try {
      const deleted = await strategyStorage.deleteStrategy(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Strategy not found" });
      res.json({ success: true });
    } catch (error: any) {
      log.error(`DELETE /api/strategy/goals/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/actors", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/actors`);
    try {
      const actors = await strategyStorage.getActors(req.params.goalId);
      res.json(actors);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.goalId}/actors error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/goals/:goalId/actors", async (req, res) => {
    log.debug(`POST /api/strategy/goals/${req.params.goalId}/actors`);
    try {
      const parsed = insertStrategyActorSchema.parse({ ...req.body, goalId: req.params.goalId });
      const actor = await strategyStorage.createActor(parsed);
      res.status(201).json(actor);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`POST /api/strategy/goals/${req.params.goalId}/actors validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`POST /api/strategy/goals/${req.params.goalId}/actors error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/actors/:id", async (req, res) => {
    log.debug(`GET /api/strategy/actors/${req.params.id}`);
    try {
      const actor = await strategyStorage.getActor(req.params.id);
      if (!actor) return res.status(404).json({ error: "Actor not found" });
      res.json(actor);
    } catch (error: any) {
      log.error(`GET /api/strategy/actors/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/strategy/actors/:id", async (req, res) => {
    log.debug(`PATCH /api/strategy/actors/${req.params.id}`);
    try {
      const parsed = insertStrategyActorSchema.partial().parse(req.body);
      if (parsed.influence !== undefined) {
        parsed.influence = Math.max(0, Math.min(1, parsed.influence));
      }
      const actor = await strategyStorage.updateActor(req.params.id, parsed);
      if (!actor) return res.status(404).json({ error: "Actor not found" });
      res.json(actor);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`PATCH /api/strategy/actors/${req.params.id} validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`PATCH /api/strategy/actors/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/strategy/actors/:id", async (req, res) => {
    log.debug(`DELETE /api/strategy/actors/${req.params.id}`);
    try {
      const deleted = await strategyStorage.deleteActor(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Actor not found" });
      res.json({ success: true });
    } catch (error: any) {
      log.error(`DELETE /api/strategy/actors/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/actors/:actorId/person-details", async (req, res) => {
    log.debug(`GET /api/strategy/actors/${req.params.actorId}/person-details`);
    try {
      const actor = await strategyStorage.getActor(req.params.actorId);
      if (!actor) return res.status(404).json({ error: "Actor not found" });
      if (!actor.personId) return res.json({ trust: null, company: null, aiSummary: null });

      const person = await peopleStorage.getPerson(actor.personId);
      if (!person) return res.json({ trust: null, company: null, aiSummary: null });

      res.json({
        trust: person.trust || null,
        company: person.company || null,
        role: person.role || null,
        aiSummary: person.aiSummary || null,
        quickSummary: person.quickSummary || null,
      });
    } catch (error: any) {
      log.error(`GET /api/strategy/actors/${req.params.actorId}/person-details error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/move-definitions", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/move-definitions`);
    try {
      const defs = await strategyStorage.getMoveDefinitions(req.params.goalId);
      res.json(defs);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.goalId}/move-definitions error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/actors/:actorId/move-definitions", async (req, res) => {
    log.debug(`GET /api/strategy/actors/${req.params.actorId}/move-definitions`);
    try {
      const defs = await strategyStorage.getMoveDefinitionsByActor(req.params.actorId);
      res.json(defs);
    } catch (error: any) {
      log.error(`GET /api/strategy/actors/${req.params.actorId}/move-definitions error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/goals/:goalId/move-definitions", async (req, res) => {
    log.debug(`POST /api/strategy/goals/${req.params.goalId}/move-definitions`);
    try {
      const parsed = insertStrategyMoveDefinitionSchema.parse({ ...req.body, goalId: req.params.goalId });
      const def = await strategyStorage.createMoveDefinition(parsed);
      res.status(201).json(def);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`POST /api/strategy/goals/${req.params.goalId}/move-definitions validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`POST /api/strategy/goals/${req.params.goalId}/move-definitions error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/strategy/move-definitions/:id", async (req, res) => {
    log.debug(`PATCH /api/strategy/move-definitions/${req.params.id}`);
    try {
      const parsed = insertStrategyMoveDefinitionSchema.partial().parse(req.body);
      const def = await strategyStorage.updateMoveDefinition(req.params.id, parsed);
      if (!def) return res.status(404).json({ error: "Move definition not found" });
      res.json(def);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`PATCH /api/strategy/move-definitions/${req.params.id} validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`PATCH /api/strategy/move-definitions/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/strategy/move-definitions/:id", async (req, res) => {
    log.debug(`DELETE /api/strategy/move-definitions/${req.params.id}`);
    try {
      const deleted = await strategyStorage.deleteMoveDefinition(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Move definition not found" });
      res.json({ success: true });
    } catch (error: any) {
      log.error(`DELETE /api/strategy/move-definitions/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/move-tree", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/move-tree`);
    try {
      const moves = await strategyStorage.getMoveTree(req.params.goalId);
      res.json(moves);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.goalId}/move-tree error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/move-instances", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/move-instances`);
    try {
      const instances = await strategyStorage.getMoveInstancesForGoal(req.params.goalId);
      res.json(instances);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.goalId}/move-instances error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/goals/:goalId/move-instances", async (req, res) => {
    log.debug(`POST /api/strategy/goals/${req.params.goalId}/move-instances`);
    try {
      const data = { ...req.body, goalId: req.params.goalId };

      if (data.parentMoveInstanceId && data.parentStateId) {
        return res.status(400).json({
          error: "A move cannot have both parentMoveInstanceId and parentStateId — they are mutually exclusive.",
        });
      }
      if (data.parentStateId && data.terminatingStateId && data.parentStateId === data.terminatingStateId) {
        return res.status(400).json({
          error: "A move cannot start from a state and terminate at the same state (creates a cycle).",
        });
      }
      if (data.parentMoveInstanceId) {
        const parent = await strategyStorage.getMoveInstance(data.parentMoveInstanceId);
        if (parent) {
          if (parent.terminatingStateId) {
            return res.status(400).json({
              error: "Parent move terminates at a state and cannot have direct child moves. Add the new move under that state (set parentStateId) instead.",
            });
          }
          data.depth = parent.depth + 1;
          data.path = parent.path ? `${parent.path}/${parent.id}` : parent.id;
        }
      }

      const parsed = insertStrategyMoveInstanceSchema.parse(data);
      const instance = await strategyStorage.createMoveInstance(parsed);
      res.status(201).json(instance);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`POST /api/strategy/goals/${req.params.goalId}/move-instances validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`POST /api/strategy/goals/${req.params.goalId}/move-instances error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/move-instances/:id", async (req, res) => {
    log.debug(`GET /api/strategy/move-instances/${req.params.id}`);
    try {
      const instance = await strategyStorage.getMoveInstance(req.params.id);
      if (!instance) return res.status(404).json({ error: "Move instance not found" });
      res.json(instance);
    } catch (error: any) {
      log.error(`GET /api/strategy/move-instances/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/strategy/move-instances/:id", async (req, res) => {
    log.debug(`PATCH /api/strategy/move-instances/${req.params.id}`);
    try {
      const parsed: Record<string, any> = insertStrategyMoveInstanceSchema.partial().parse(req.body);
      if (parsed.terminatingStateId) {
        const children = await strategyStorage.getChildMoveInstances(req.params.id);
        if (children.length > 0) {
          return res.status(400).json({
            error: "This move has child moves and cannot also terminate at a state. Move or remove the child moves first.",
          });
        }
      }
      if (parsed.parentMoveInstanceId && parsed.parentStateId) {
        return res.status(400).json({
          error: "A move cannot have both parentMoveInstanceId and parentStateId set.",
        });
      }
      const existing = await strategyStorage.getMoveInstance(req.params.id);
      const finalParentStateId = parsed.parentStateId !== undefined ? parsed.parentStateId : existing?.parentStateId;
      const finalTerminatingStateId = parsed.terminatingStateId !== undefined ? parsed.terminatingStateId : existing?.terminatingStateId;
      if (finalParentStateId && finalTerminatingStateId && finalParentStateId === finalTerminatingStateId) {
        return res.status(400).json({
          error: "A move cannot start from a state and terminate at the same state (creates a cycle).",
        });
      }
      if (parsed.parentMoveInstanceId) {
        if (parsed.parentMoveInstanceId === req.params.id) {
          return res.status(400).json({ error: "A move cannot be its own parent." });
        }
        const parent = await strategyStorage.getMoveInstance(parsed.parentMoveInstanceId);
        if (parent?.terminatingStateId) {
          return res.status(400).json({
            error: "Cannot reparent under a move that terminates at a state. Use parentStateId instead.",
          });
        }
        if (existing) {
          const allMoves = await strategyStorage.getMoveTree(existing.goalId);
          const childrenOf = (id: string) => allMoves.filter(m => m.parentMoveInstanceId === id);
          const stack = [...childrenOf(req.params.id)];
          const seen = new Set<string>();
          while (stack.length) {
            const cur = stack.pop()!;
            if (seen.has(cur.id)) continue;
            seen.add(cur.id);
            if (cur.id === parsed.parentMoveInstanceId) {
              return res.status(400).json({ error: "Cannot reparent a move under one of its own descendants (would create a cycle)." });
            }
            stack.push(...childrenOf(cur.id));
          }
        }
        parsed.parentStateId = null;
      } else if (parsed.parentStateId) {
        parsed.parentMoveInstanceId = null;
      }
      const instance = await strategyStorage.updateMoveInstance(req.params.id, parsed);
      if (!instance) return res.status(404).json({ error: "Move instance not found" });
      res.json(instance);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`PATCH /api/strategy/move-instances/${req.params.id} validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`PATCH /api/strategy/move-instances/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/strategy/move-instances/:id", async (req, res) => {
    log.debug(`DELETE /api/strategy/move-instances/${req.params.id}`);
    try {
      const deleted = await strategyStorage.deleteMoveInstanceAndChildren(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Move instance not found" });
      res.json({ success: true });
    } catch (error: any) {
      log.error(`DELETE /api/strategy/move-instances/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/move-instances/:id/children", async (req, res) => {
    log.debug(`GET /api/strategy/move-instances/${req.params.id}/children`);
    try {
      const children = await strategyStorage.getChildMoveInstances(req.params.id);
      res.json(children);
    } catch (error: any) {
      log.error(`GET /api/strategy/move-instances/${req.params.id}/children error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/move-instances/:id/path", async (req, res) => {
    log.debug(`GET /api/strategy/move-instances/${req.params.id}/path`);
    try {
      const path = await strategyStorage.getMovePath(req.params.id);
      res.json(path);
    } catch (error: any) {
      log.error(`GET /api/strategy/move-instances/${req.params.id}/path error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/assumptions", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/assumptions`);
    try {
      const assumptions = await strategyStorage.getAssumptions(req.params.goalId);
      res.json(assumptions);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.goalId}/assumptions error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/goals/:goalId/assumptions", async (req, res) => {
    log.debug(`POST /api/strategy/goals/${req.params.goalId}/assumptions`);
    try {
      const parsed = insertStrategyAssumptionSchema.parse({ ...req.body, goalId: req.params.goalId });
      const assumption = await strategyStorage.createAssumption(parsed);
      res.status(201).json(assumption);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`POST /api/strategy/goals/${req.params.goalId}/assumptions validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`POST /api/strategy/goals/${req.params.goalId}/assumptions error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/strategy/assumptions/:id", async (req, res) => {
    log.debug(`PATCH /api/strategy/assumptions/${req.params.id}`);
    try {
      const parsed = insertStrategyAssumptionSchema.partial().parse(req.body);
      const assumption = await strategyStorage.updateAssumption(req.params.id, parsed);
      if (!assumption) return res.status(404).json({ error: "Assumption not found" });
      res.json(assumption);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`PATCH /api/strategy/assumptions/${req.params.id} validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`PATCH /api/strategy/assumptions/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/strategy/assumptions/:id", async (req, res) => {
    log.debug(`DELETE /api/strategy/assumptions/${req.params.id}`);
    try {
      const deleted = await strategyStorage.deleteAssumption(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Assumption not found" });
      res.json({ success: true });
    } catch (error: any) {
      log.error(`DELETE /api/strategy/assumptions/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/assumptions/:id/cascade", async (req, res) => {
    log.debug(`POST /api/strategy/assumptions/${req.params.id}/cascade`);
    try {
      const assumption = await strategyStorage.getAssumption(req.params.id);
      if (!assumption) return res.status(404).json({ error: "Assumption not found" });
      res.json({ assumption, updatedMoves: [] });
    } catch (error: any) {
      log.error(`POST /api/strategy/assumptions/${req.params.id}/cascade error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/assumption-links", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/assumption-links`);
    try {
      const links = await strategyStorage.getAssumptionLinksForGoal(req.params.goalId);
      res.json(links);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.goalId}/assumption-links error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/assumptions/:id/links", async (req, res) => {
    log.debug(`POST /api/strategy/assumptions/${req.params.id}/links body=${JSON.stringify(req.body)}`);
    try {
      const parsed = insertStrategyAssumptionLinkSchema.parse({
        ...req.body,
        assumptionId: req.params.id,
      });
      const link = await strategyStorage.createAssumptionLink(parsed);
      res.status(201).json(link);
    } catch (error: any) {
      if (error.name === "ZodError") return res.status(400).json({ error: "Invalid assumption link", details: error.errors });
      log.error(`POST /api/strategy/assumptions/${req.params.id}/links error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/strategy/assumption-links/:id", async (req, res) => {
    log.debug(`PATCH /api/strategy/assumption-links/${req.params.id} body=${JSON.stringify(req.body)}`);
    try {
      const polarity = req.body?.polarity;
      if (!assumptionLinkPolarityValues.includes(polarity)) {
        return res.status(400).json({ error: "polarity must be 'positive' or 'negative'" });
      }
      const link = await strategyStorage.updateAssumptionLink(req.params.id, polarity);
      if (!link) return res.status(404).json({ error: "Assumption link not found" });
      res.json(link);
    } catch (error: any) {
      log.error(`PATCH /api/strategy/assumption-links/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/strategy/assumption-links/:id", async (req, res) => {
    log.debug(`DELETE /api/strategy/assumption-links/${req.params.id}`);
    try {
      const ok = await strategyStorage.deleteAssumptionLink(req.params.id);
      if (!ok) return res.status(404).json({ error: "Assumption link not found" });
      res.status(204).send();
    } catch (error: any) {
      log.error(`DELETE /api/strategy/assumption-links/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/end-conditions", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/end-conditions`);
    try {
      const conditions = await strategyStorage.getEndConditions(req.params.goalId);
      res.json(conditions);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.goalId}/end-conditions error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/goals/:goalId/end-conditions", async (req, res) => {
    log.debug(`POST /api/strategy/goals/${req.params.goalId}/end-conditions`);
    try {
      const parsed = insertStrategyEndConditionSchema.parse({ ...req.body, goalId: req.params.goalId });
      const condition = await strategyStorage.createEndCondition(parsed);
      res.status(201).json(condition);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`POST /api/strategy/goals/${req.params.goalId}/end-conditions validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`POST /api/strategy/goals/${req.params.goalId}/end-conditions error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/strategy/end-conditions/:id", async (req, res) => {
    log.debug(`PATCH /api/strategy/end-conditions/${req.params.id}`);
    try {
      const parsed = insertStrategyEndConditionSchema.partial().parse(req.body);
      const condition = await strategyStorage.updateEndCondition(req.params.id, parsed);
      if (!condition) return res.status(404).json({ error: "End condition not found" });
      res.json(condition);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`PATCH /api/strategy/end-conditions/${req.params.id} validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`PATCH /api/strategy/end-conditions/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/strategy/end-conditions/:id", async (req, res) => {
    log.debug(`DELETE /api/strategy/end-conditions/${req.params.id}`);
    try {
      const deleted = await strategyStorage.deleteEndCondition(req.params.id);
      if (!deleted) return res.status(404).json({ error: "End condition not found" });
      res.json({ success: true });
    } catch (error: any) {
      log.error(`DELETE /api/strategy/end-conditions/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/context", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/context`);
    try {
      const entries = await strategyStorage.getContextEntries(req.params.goalId);
      res.json(entries);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.goalId}/context error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/goals/:goalId/context", async (req, res) => {
    log.debug(`POST /api/strategy/goals/${req.params.goalId}/context`);
    try {
      const parsed = insertStrategyContextEntrySchema.parse({ ...req.body, goalId: req.params.goalId });
      const entry = await strategyStorage.createContextEntry(parsed);
      res.status(201).json(entry);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`POST /api/strategy/goals/${req.params.goalId}/context validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`POST /api/strategy/goals/${req.params.goalId}/context error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/strategy/context/:id", async (req, res) => {
    log.debug(`PATCH /api/strategy/context/${req.params.id}`);
    try {
      const parsed = insertStrategyContextEntrySchema.partial().parse(req.body);
      const entry = await strategyStorage.updateContextEntry(req.params.id, parsed);
      if (!entry) return res.status(404).json({ error: "Context entry not found" });
      res.json(entry);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`PATCH /api/strategy/context/${req.params.id} validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`PATCH /api/strategy/context/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/strategy/context/:id", async (req, res) => {
    log.debug(`DELETE /api/strategy/context/${req.params.id}`);
    try {
      const deleted = await strategyStorage.deleteContextEntry(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Context entry not found" });
      res.json({ success: true });
    } catch (error: any) {
      log.error(`DELETE /api/strategy/context/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  const simulateBodySchema = z.object({
    mode: z.enum(["clear_and_simulate", "update"]).optional().default("clear_and_simulate"),
  });

  app.post("/api/strategy/move-instances/:id/simulate", async (req, res) => {
    log.debug(`POST /api/strategy/move-instances/${req.params.id}/simulate`);
    try {
      const move = await strategyStorage.getMoveInstance(req.params.id);
      if (!move) return res.status(404).json({ error: "Move instance not found" });

      const run = await strategyStorage.createSimulationRun({
        goalId: move.goalId,
        rootMoveInstanceId: req.params.id,
        mode: "clear_and_simulate",
        status: "running",
        progress: { movesProcessed: 0, movesTotal: 1, currentDepth: move.depth, currentMoveName: move.title },
      });

      res.status(202).json(run);
    } catch (error: any) {
      log.error(`POST /api/strategy/move-instances/${req.params.id}/simulate error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/move-instances/:id/simulate-tree", async (req, res) => {
    log.debug(`POST /api/strategy/move-instances/${req.params.id}/simulate-tree`);
    try {
      const move = await strategyStorage.getMoveInstance(req.params.id);
      if (!move) return res.status(404).json({ error: "Move instance not found" });

      const parsed = simulateBodySchema.parse(req.body);

      const run = await strategyStorage.createSimulationRun({
        goalId: move.goalId,
        rootMoveInstanceId: req.params.id,
        mode: parsed.mode,
        status: "running",
        progress: { movesProcessed: 0, movesTotal: 0, currentDepth: move.depth, currentMoveName: move.title },
      });

      res.status(202).json(run);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`POST /api/strategy/move-instances/${req.params.id}/simulate-tree validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`POST /api/strategy/move-instances/${req.params.id}/simulate-tree error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/move-instances/:id/evaluate", async (req, res) => {
    log.debug(`POST /api/strategy/move-instances/${req.params.id}/evaluate`);
    try {
      const move = await strategyStorage.getMoveInstance(req.params.id);
      if (!move) return res.status(404).json({ error: "Move instance not found" });

      const { evaluateMoveWithAgent } = await import("./strategy-simulation");
      const runId = await evaluateMoveWithAgent(req.params.id, {
        sessionKey: req.body?.sessionKey,
      });

      res.status(202).json({ ok: true, runId });
    } catch (error: any) {
      log.error(`POST /api/strategy/move-instances/${req.params.id}/evaluate error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/simulation-runs/:id/cancel", async (req, res) => {
    log.debug(`POST /api/strategy/simulation-runs/${req.params.id}/cancel`);
    try {
      const run = await strategyStorage.updateSimulationRun(req.params.id, {
        status: "cancelled",
        completedAt: new Date(),
      } as any);
      if (!run) return res.status(404).json({ error: "Simulation run not found" });
      res.json(run);
    } catch (error: any) {
      log.error(`POST /api/strategy/simulation-runs/${req.params.id}/cancel error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/simulation-runs", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/simulation-runs`);
    try {
      const runs = await strategyStorage.getSimulationRuns(req.params.goalId);
      res.json(runs);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.goalId}/simulation-runs error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/artifacts", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/artifacts`);
    try {
      const artifacts = await strategyStorage.getArtifacts(req.params.goalId);
      res.json(artifacts);
    } catch (error: any) {
      log.error(`GET /api/strategy/goals/${req.params.goalId}/artifacts error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/goals/:goalId/artifacts", async (req, res) => {
    log.debug(`POST /api/strategy/goals/${req.params.goalId}/artifacts`);
    try {
      const parsed = insertStrategyArtifactSchema.parse({
        ...req.body,
        goalId: req.params.goalId,
      });
      const artifact = await strategyStorage.createArtifact(parsed);
      res.status(201).json(artifact);
    } catch (error: any) {
      if (error.name === "ZodError") {
        log.warn(`POST artifacts validation error:`, error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      log.error(`POST artifacts error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/states", async (req, res) => {
    log.debug(`GET /api/strategy/goals/${req.params.goalId}/states`);
    try {
      const states = await strategyStorage.getStates(req.params.goalId);
      res.json(states);
    } catch (error: any) {
      log.error(`GET states error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/strategy/goals/:goalId/states", async (req, res) => {
    log.debug(`POST /api/strategy/goals/${req.params.goalId}/states`);
    try {
      const parsed = insertStrategyStateSchema.parse({ ...req.body, goalId: req.params.goalId });
      const state = await strategyStorage.createState(parsed);
      res.status(201).json(state);
    } catch (error: any) {
      if (error.name === "ZodError") return res.status(400).json({ error: "Validation failed", details: error.errors });
      log.error(`POST states error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/states/:id", async (req, res) => {
    try {
      const state = await strategyStorage.getState(req.params.id);
      if (!state) return res.status(404).json({ error: "State not found" });
      const refs = await strategyStorage.getStateReferences(req.params.id);
      res.json({ ...state, terminatingMoves: refs.terminatingMoves, childMoves: refs.childMoves });
    } catch (error: any) {
      log.error(`GET state error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/strategy/states/:id", async (req, res) => {
    try {
      const parsed = insertStrategyStateSchema.partial().parse(req.body);
      const state = await strategyStorage.updateState(req.params.id, parsed);
      if (!state) return res.status(404).json({ error: "State not found" });
      res.json(state);
    } catch (error: any) {
      if (error.name === "ZodError") return res.status(400).json({ error: "Validation failed", details: error.errors });
      log.error(`PATCH state error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/strategy/states/:id", async (req, res) => {
    try {
      const result = await strategyStorage.deleteState(req.params.id);
      if (!result.deleted) {
        return res.status(409).json({ error: result.reason || "State not found" });
      }
      res.json({ success: true });
    } catch (error: any) {
      log.error(`DELETE state error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/move-end-condition-effects", async (req, res) => {
    try {
      const effects = await strategyStorage.getMoveEndConditionEffectsForGoal(req.params.goalId);
      res.json(effects);
    } catch (error: any) {
      log.error(`GET move-end-condition-effects error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/move-instances/:id/end-condition-effects", async (req, res) => {
    try {
      const effects = await strategyStorage.getMoveEndConditionEffects(req.params.id);
      res.json(effects);
    } catch (error: any) {
      log.error(`GET move end-condition-effects error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  const setEffectSchema = z.object({
    endConditionId: z.string(),
    effect: z.enum(strategyMoveEndConditionEffectValues),
  });

  app.put("/api/strategy/move-instances/:id/end-condition-effects", async (req, res) => {
    try {
      const parsed = setEffectSchema.parse(req.body);
      await strategyStorage.setMoveEndConditionEffect(req.params.id, parsed.endConditionId, parsed.effect);
      const effects = await strategyStorage.getMoveEndConditionEffects(req.params.id);
      res.json(effects);
    } catch (error: any) {
      if (error.name === "ZodError") return res.status(400).json({ error: "Validation failed", details: error.errors });
      log.error(`PUT move end-condition-effects error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/strategy/artifacts/:id", async (req, res) => {
    log.debug(`DELETE /api/strategy/artifacts/${req.params.id}`);
    try {
      await strategyStorage.deleteArtifact(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      log.error(`DELETE artifact error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/strategy/goals/:goalId/current-position", async (req, res) => {
    const { goalId } = req.params;
    log.debug(`PATCH /api/strategy/goals/${goalId}/current-position`);
    try {
      const { moveInstanceId } = req.body;
      const strategy = await strategyStorage.updateStrategy(goalId, { currentMoveInstanceId: moveInstanceId || null });
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      res.json(strategy);
    } catch (error: any) {
      log.error(`PATCH current-position error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/strategy/goals/:goalId/optimal-path", async (req, res) => {
    const { goalId } = req.params;
    log.debug(`GET /api/strategy/goals/${goalId}/optimal-path`);
    try {
      const strategy = await strategyStorage.getStrategy(goalId);
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });

      const [moves, endConditions, effects] = await Promise.all([
        strategyStorage.getMoveInstancesForGoal(goalId),
        strategyStorage.getEndConditions(goalId),
        strategyStorage.getMoveEndConditionEffectsForGoal(goalId),
      ]);

      const result = computeOptimalPaths(moves, endConditions, effects, strategy.currentMoveInstanceId || null);
      res.json(result);
    } catch (error: any) {
      log.error(`GET optimal-path error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });
}
