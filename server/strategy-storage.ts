// Use createLogger for logging ONLY
import { db } from "./db";
import { pool } from "./db";
import { eq, and, desc, asc, like, inArray } from "drizzle-orm";

const REF_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function generateRefId(len = 6): string {
  let result = "";
  for (let i = 0; i < len; i++) {
    result += REF_ID_CHARS[Math.floor(Math.random() * REF_ID_CHARS.length)];
  }
  return result;
}
import {
  strategies,
  strategyActors,
  strategyMoveDefinitions,
  strategyMoveInstances,
  strategyAssumptions,
  strategyEndConditions,
  strategyContextEntries,
  strategySimulationRuns,
  strategyArtifacts,
  strategyStates,
  strategyMoveEndConditionEffects,
  strategyAssumptionLinks,
  type Strategy,
  type InsertStrategy,
  type StrategyActor,
  type InsertStrategyActor,
  type StrategyMoveDefinition,
  type InsertStrategyMoveDefinition,
  type StrategyMoveInstance,
  type InsertStrategyMoveInstance,
  type StrategyAssumption,
  type InsertStrategyAssumption,
  type StrategyEndCondition,
  type InsertStrategyEndCondition,
  type StrategyContextEntry,
  type InsertStrategyContextEntry,
  type StrategySimulationRun,
  type InsertStrategySimulationRun,
  type StrategyArtifact,
  type InsertStrategyArtifact,
  type StrategyState,
  type InsertStrategyState,
  type StrategyMoveEndConditionEffect,
  type StrategyMoveEndConditionEffectValue,
  type StrategyAssumptionLink,
  type InsertStrategyAssumptionLink,
} from "@shared/schema";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const log = createLogger("StrategyStorage");

const strategyScopeColumns = {
  scope: strategies.scope,
  ownerUserId: strategies.ownerUserId,
  accountId: strategies.accountId,
};

let schemaMigrated = false;

async function autoHeal<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err: any) {
    const code = err?.code;
    if ((code === "42703" || code === "42P01") && !schemaMigrated) {
      log.debug(`auto-heal: migrating schema after column/relation error (${err.message})`);
      await migrateStrategySchema();
      schemaMigrated = true;
      try {
        return await operation();
      } catch (retryErr: any) {
        log.warn(`auto-heal: retry failed after migration (${retryErr.message})`);
        throw retryErr;
      }
    }
    throw err;
  }
}

export class StrategyStorage {
  private async requireVisibleGoal(goalId: string): Promise<Strategy> {
    const [strategy] = await db.select().from(strategies)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), strategyScopeColumns, eq(strategies.id, goalId)))
      .limit(1);
    if (!strategy) throw new Error(`Strategy ${goalId} not found or not visible`);
    return strategy;
  }

  private async requireWritableGoal(goalId: string): Promise<Strategy> {
    const [strategy] = await db.select().from(strategies)
      .where(combineWithWritableScope(getCurrentPrincipalOrSystem(), strategyScopeColumns, eq(strategies.id, goalId)))
      .limit(1);
    if (!strategy) throw new Error(`Strategy ${goalId} not found or not writable`);
    return strategy;
  }

  private async requireVisibleMove(moveId: string): Promise<StrategyMoveInstance> {
    const [move] = await db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.id, moveId)).limit(1);
    if (!move) throw new Error(`Move ${moveId} not found or not visible`);
    await this.requireVisibleGoal(move.goalId);
    return move;
  }

  private async requireWritableMove(moveId: string): Promise<StrategyMoveInstance> {
    const [move] = await db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.id, moveId)).limit(1);
    if (!move) throw new Error(`Move ${moveId} not found or not writable`);
    await this.requireWritableGoal(move.goalId);
    return move;
  }

  private async requireVisibleAssumption(assumptionId: string): Promise<StrategyAssumption> {
    const [assumption] = await db.select().from(strategyAssumptions).where(eq(strategyAssumptions.id, assumptionId)).limit(1);
    if (!assumption) throw new Error(`Assumption ${assumptionId} not found or not visible`);
    await this.requireVisibleGoal(assumption.goalId);
    return assumption;
  }

  private async requireWritableAssumption(assumptionId: string): Promise<StrategyAssumption> {
    const [assumption] = await db.select().from(strategyAssumptions).where(eq(strategyAssumptions.id, assumptionId)).limit(1);
    if (!assumption) throw new Error(`Assumption ${assumptionId} not found or not writable`);
    await this.requireWritableGoal(assumption.goalId);
    return assumption;
  }

  async getStrategies(opts?: { archived?: boolean }): Promise<Strategy[]> {
    return autoHeal(async () => {
      const archived = opts?.archived ?? false;
      const results = await db.select().from(strategies)
        .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), strategyScopeColumns, eq(strategies.archived, archived)))
        .orderBy(desc(strategies.createdAt));
      log.debug(`getStrategies archived=${archived} count=${results.length}`);
      return results;
    });
  }

  async getAllStrategies(): Promise<Strategy[]> {
    return autoHeal(async () => {
      const results = await db.select().from(strategies)
        .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), strategyScopeColumns))
        .orderBy(desc(strategies.createdAt));
      log.debug(`getAllStrategies count=${results.length}`);
      return results;
    });
  }

  async getStrategy(id: string): Promise<Strategy | undefined> {
    return autoHeal(async () => {
      const [strategy] = await db.select().from(strategies)
        .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), strategyScopeColumns, eq(strategies.id, id)));
      log.debug(`getStrategy id=${id} found=${!!strategy}`);
      return strategy;
    });
  }

  async createStrategy(data: InsertStrategy): Promise<Strategy> {
    return autoHeal(async () => {
      const [strategy] = await db.insert(strategies).values({
        ...data,
        ...ownedInsertValues(getCurrentPrincipalOrSystem(), strategyScopeColumns),
      }).returning();
      log.debug(`createStrategy id=${strategy.id} title="${strategy.title}"`);
      return strategy;
    });
  }

  async updateStrategy(id: string, updates: Partial<InsertStrategy>): Promise<Strategy | undefined> {
    return autoHeal(async () => {
      const [strategy] = await db.update(strategies).set({ ...updates, updatedAt: new Date() })
        .where(combineWithWritableScope(getCurrentPrincipalOrSystem(), strategyScopeColumns, eq(strategies.id, id)))
        .returning();
      log.debug(`updateStrategy id=${id} found=${!!strategy} fields=${Object.keys(updates).join(",")}`);
      return strategy;
    });
  }

  async deleteStrategy(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const result = await db.delete(strategies)
        .where(combineWithWritableScope(getCurrentPrincipalOrSystem(), strategyScopeColumns, eq(strategies.id, id)))
        .returning();
      log.debug(`deleteStrategy id=${id} deleted=${result.length > 0}`);
      return result.length > 0;
    });
  }

  async getActors(goalId: string): Promise<StrategyActor[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      const actors = await db.select().from(strategyActors).where(eq(strategyActors.goalId, goalId)).orderBy(asc(strategyActors.createdAt));
      return actors;
    });
  }

  async getActor(id: string): Promise<StrategyActor | undefined> {
    return autoHeal(async () => {
      const [actor] = await db.select().from(strategyActors).where(eq(strategyActors.id, id));
      if (actor) await this.requireVisibleGoal(actor.goalId);
      return actor;
    });
  }

  async createActor(data: InsertStrategyActor): Promise<StrategyActor> {
    return autoHeal(async () => {
      await this.requireWritableGoal(data.goalId);
      const [actor] = await db.insert(strategyActors).values(data).returning();
      return actor;
    });
  }

  async updateActor(id: string, updates: Partial<InsertStrategyActor>): Promise<StrategyActor | undefined> {
    return autoHeal(async () => {
      const existing = await this.getActor(id);
      if (!existing) return undefined;
      await this.requireWritableGoal(existing.goalId);
      const [actor] = await db.update(strategyActors).set(updates).where(eq(strategyActors.id, id)).returning();
      return actor;
    });
  }

  async deleteActor(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const existing = await this.getActor(id);
      if (!existing) return false;
      await this.requireWritableGoal(existing.goalId);
      const result = await db.delete(strategyActors).where(eq(strategyActors.id, id)).returning();
      return result.length > 0;
    });
  }

  async getMoveDefinitions(goalId: string): Promise<StrategyMoveDefinition[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      return db.select().from(strategyMoveDefinitions).where(eq(strategyMoveDefinitions.goalId, goalId)).orderBy(asc(strategyMoveDefinitions.createdAt));
    });
  }

  async getMoveDefinitionsByActor(actorId: string): Promise<StrategyMoveDefinition[]> {
    return autoHeal(async () => {
      const actor = await this.getActor(actorId);
      if (!actor) return [];
      return db.select().from(strategyMoveDefinitions).where(eq(strategyMoveDefinitions.actorId, actorId)).orderBy(asc(strategyMoveDefinitions.createdAt));
    });
  }

  async getMoveDefinition(id: string): Promise<StrategyMoveDefinition | undefined> {
    return autoHeal(async () => {
      const [def] = await db.select().from(strategyMoveDefinitions).where(eq(strategyMoveDefinitions.id, id));
      if (def) await this.requireVisibleGoal(def.goalId);
      return def;
    });
  }

  async createMoveDefinition(data: InsertStrategyMoveDefinition): Promise<StrategyMoveDefinition> {
    return autoHeal(async () => {
      await this.requireWritableGoal(data.goalId);
      const actor = await this.getActor(data.actorId);
      if (!actor || actor.goalId !== data.goalId) throw new Error("Move definition actor must belong to the same visible strategy");
      const [def] = await db.insert(strategyMoveDefinitions).values(data).returning();
      return def;
    });
  }

  async updateMoveDefinition(id: string, updates: Partial<InsertStrategyMoveDefinition>): Promise<StrategyMoveDefinition | undefined> {
    return autoHeal(async () => {
      const existing = await this.getMoveDefinition(id);
      if (!existing) return undefined;
      await this.requireWritableGoal(existing.goalId);
      const [def] = await db.update(strategyMoveDefinitions).set(updates).where(eq(strategyMoveDefinitions.id, id)).returning();
      return def;
    });
  }

  async deleteMoveDefinition(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const existing = await this.getMoveDefinition(id);
      if (!existing) return false;
      await this.requireWritableGoal(existing.goalId);
      const result = await db.delete(strategyMoveDefinitions).where(eq(strategyMoveDefinitions.id, id)).returning();
      return result.length > 0;
    });
  }

  async getMoveTree(goalId: string): Promise<StrategyMoveInstance[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      return db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.goalId, goalId)).orderBy(asc(strategyMoveInstances.path), asc(strategyMoveInstances.depth));
    });
  }

  async getMovePath(moveId: string): Promise<StrategyMoveInstance[]> {
    return autoHeal(async () => {
      const move = await this.getMoveInstance(moveId);
      if (!move) return [];
      const allMoves = await db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.goalId, move.goalId));
      const byId = new Map(allMoves.map(m => [m.id, m]));
      const path: StrategyMoveInstance[] = [];
      let current: StrategyMoveInstance | undefined = move;
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        path.unshift(current);
        seen.add(current.id);
        current = current.parentMoveInstanceId ? byId.get(current.parentMoveInstanceId) : undefined;
      }
      return path;
    });
  }

  async getMoveInstance(id: string): Promise<StrategyMoveInstance | undefined> {
    return autoHeal(async () => {
      const [inst] = await db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.id, id));
      if (inst) await this.requireVisibleGoal(inst.goalId);
      return inst;
    });
  }

  async getMoveInstanceByRefId(refId: string): Promise<StrategyMoveInstance | undefined> {
    return autoHeal(async () => {
      const [inst] = await db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.refId, refId));
      if (inst) await this.requireVisibleGoal(inst.goalId);
      return inst;
    });
  }

  async resolveMoveInstance(idOrRef: string): Promise<StrategyMoveInstance | undefined> {
    const isUuid = idOrRef.length > 20 && idOrRef.includes("-");
    if (isUuid) return this.getMoveInstance(idOrRef);
    const cleanRef = idOrRef.startsWith("#") ? idOrRef.slice(1) : idOrRef;
    return (await this.getMoveInstanceByRefId(cleanRef)) ?? this.getMoveInstance(idOrRef);
  }

  async createMoveInstance(data: InsertStrategyMoveInstance): Promise<StrategyMoveInstance> {
    return autoHeal(async () => {
      await this.requireWritableGoal(data.goalId);
      if (data.parentMoveInstanceId) {
        const parent = await this.getMoveInstance(data.parentMoveInstanceId);
        if (!parent || parent.goalId !== data.goalId) throw new Error("Parent move must belong to the same visible strategy");
      }
      if (data.moveDefinitionId) {
        const def = await this.getMoveDefinition(data.moveDefinitionId);
        if (!def || def.goalId !== data.goalId) throw new Error("Move definition must belong to the same visible strategy");
      }
      if (data.actorId) {
        const actor = await this.getActor(data.actorId);
        if (!actor || actor.goalId !== data.goalId) throw new Error("Move actor must belong to the same visible strategy");
      }
      const refId = generateRefId();
      const baseProb = (data as any).baseProbability ?? (data as any).probability ?? 0.5;
      const [inst] = await db.insert(strategyMoveInstances).values({ ...data, refId, baseProbability: baseProb, probability: baseProb } as any).returning();
      return inst;
    });
  }

  async updateMoveInstance(id: string, updates: Partial<InsertStrategyMoveInstance>): Promise<StrategyMoveInstance | undefined> {
    return autoHeal(async () => {
      const existing = await this.getMoveInstance(id);
      if (!existing) return undefined;
      await this.requireWritableGoal(existing.goalId);
      if (updates.parentMoveInstanceId) {
        const parent = await this.getMoveInstance(updates.parentMoveInstanceId);
        if (!parent || parent.goalId !== existing.goalId) throw new Error("Parent move must belong to the same visible strategy");
      }
      const patch: any = { ...updates };
      const baseChanged = Object.prototype.hasOwnProperty.call(updates, "baseProbability");
      const [inst] = await db.update(strategyMoveInstances).set(patch).where(eq(strategyMoveInstances.id, id)).returning();
      if (inst && baseChanged) {
        await this.recomputeMoveProbability(id);
        const [refreshed] = await db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.id, id));
        return refreshed;
      }
      return inst;
    });
  }

  async deleteMoveInstance(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const existing = await this.getMoveInstance(id);
      if (!existing) return false;
      await this.requireWritableGoal(existing.goalId);
      const result = await db.delete(strategyMoveInstances).where(eq(strategyMoveInstances.id, id)).returning();
      return result.length > 0;
    });
  }

  async deleteMoveInstanceAndChildren(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const move = await this.requireWritableMove(id);
      const descendants = await db.select().from(strategyMoveInstances).where(like(strategyMoveInstances.path, `${move.path}%`));
      const ids = descendants.map(d => d.id);
      if (ids.length === 0) ids.push(id);
      const result = await db.delete(strategyMoveInstances).where(inArray(strategyMoveInstances.id, ids)).returning();
      return result.length > 0;
    });
  }

  async reparentMoveInstance(id: string, newParentId: string | null): Promise<StrategyMoveInstance | undefined> {
    return autoHeal(async () => {
      const move = await this.requireWritableMove(id);
      let newDepth = 0;
      let newPath = move.id;
      if (newParentId) {
        const parent = await this.requireVisibleMove(newParentId);
        if (parent.goalId !== move.goalId) throw new Error("Cannot reparent across strategies");
        newDepth = parent.depth + 1;
        newPath = `${parent.path}/${move.id}`;
      }
      const oldPath = move.path;
      const descendants = await db.select().from(strategyMoveInstances).where(like(strategyMoveInstances.path, `${oldPath}/%`));
      const [updated] = await db.update(strategyMoveInstances).set({ parentMoveInstanceId: newParentId, depth: newDepth, path: newPath }).where(eq(strategyMoveInstances.id, id)).returning();
      for (const desc of descendants) {
        const relativePath = desc.path.slice(oldPath.length + 1);
        const updatedPath = `${newPath}/${relativePath}`;
        const updatedDepth = newDepth + relativePath.split("/").length;
        await db.update(strategyMoveInstances).set({ path: updatedPath, depth: updatedDepth }).where(eq(strategyMoveInstances.id, desc.id));
      }
      return updated;
    });
  }

  async getChildMoveInstances(parentId: string): Promise<StrategyMoveInstance[]> {
    return autoHeal(async () => {
      await this.requireVisibleMove(parentId);
      return db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.parentMoveInstanceId, parentId)).orderBy(asc(strategyMoveInstances.createdAt));
    });
  }

  async getMoveInstancesForGoal(goalId: string): Promise<StrategyMoveInstance[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      return db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.goalId, goalId)).orderBy(asc(strategyMoveInstances.createdAt));
    });
  }

  async getAssumptions(goalId: string): Promise<StrategyAssumption[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      return db.select().from(strategyAssumptions).where(eq(strategyAssumptions.goalId, goalId)).orderBy(asc(strategyAssumptions.createdAt));
    });
  }

  async createAssumption(data: InsertStrategyAssumption): Promise<StrategyAssumption> {
    return autoHeal(async () => {
      await this.requireWritableGoal(data.goalId);
      const [assumption] = await db.insert(strategyAssumptions).values(data).returning();
      return assumption;
    });
  }

  async updateAssumption(id: string, updates: Partial<InsertStrategyAssumption>): Promise<StrategyAssumption | undefined> {
    return autoHeal(async () => {
      const existing = await this.getAssumption(id);
      if (!existing) return undefined;
      await this.requireWritableGoal(existing.goalId);
      const probabilityChanged = Object.prototype.hasOwnProperty.call(updates, "probability");
      const [assumption] = await db.update(strategyAssumptions).set(updates).where(eq(strategyAssumptions.id, id)).returning();
      if (assumption && probabilityChanged) await this.recomputeMovesForAssumption(id);
      return assumption;
    });
  }

  async deleteAssumption(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const existing = await this.getAssumption(id);
      if (!existing) return false;
      await this.requireWritableGoal(existing.goalId);
      const result = await db.delete(strategyAssumptions).where(eq(strategyAssumptions.id, id)).returning();
      return result.length > 0;
    });
  }

  async getAssumption(id: string): Promise<StrategyAssumption | undefined> {
    return autoHeal(async () => {
      const [assumption] = await db.select().from(strategyAssumptions).where(eq(strategyAssumptions.id, id));
      if (assumption) await this.requireVisibleGoal(assumption.goalId);
      return assumption;
    });
  }

  async getAssumptionLinksForGoal(goalId: string): Promise<StrategyAssumptionLink[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      const links = await db.select({
        id: strategyAssumptionLinks.id,
        assumptionId: strategyAssumptionLinks.assumptionId,
        moveInstanceId: strategyAssumptionLinks.moveInstanceId,
        polarity: strategyAssumptionLinks.polarity,
        createdAt: strategyAssumptionLinks.createdAt,
      }).from(strategyAssumptionLinks)
        .innerJoin(strategyAssumptions, eq(strategyAssumptionLinks.assumptionId, strategyAssumptions.id))
        .where(eq(strategyAssumptions.goalId, goalId));
      return links as StrategyAssumptionLink[];
    });
  }

  async getAssumptionLinksForMove(moveInstanceId: string): Promise<StrategyAssumptionLink[]> {
    return autoHeal(async () => {
      await this.requireVisibleMove(moveInstanceId);
      return db.select().from(strategyAssumptionLinks).where(eq(strategyAssumptionLinks.moveInstanceId, moveInstanceId));
    });
  }

  async getAssumptionLinksForAssumption(assumptionId: string): Promise<StrategyAssumptionLink[]> {
    return autoHeal(async () => {
      await this.requireVisibleAssumption(assumptionId);
      return db.select().from(strategyAssumptionLinks).where(eq(strategyAssumptionLinks.assumptionId, assumptionId));
    });
  }

  async createAssumptionLink(data: InsertStrategyAssumptionLink): Promise<StrategyAssumptionLink> {
    return autoHeal(async () => {
      const assumption = await this.requireWritableAssumption(data.assumptionId);
      const move = await this.requireVisibleMove(data.moveInstanceId);
      if (move.goalId !== assumption.goalId) throw new Error("Assumption link move must belong to the same strategy");
      const [link] = await db.insert(strategyAssumptionLinks).values(data).onConflictDoUpdate({
        target: [strategyAssumptionLinks.assumptionId, strategyAssumptionLinks.moveInstanceId],
        set: { polarity: data.polarity ?? "positive" },
      }).returning();
      await this.recomputeMoveProbability(data.moveInstanceId);
      return link;
    });
  }

  async updateAssumptionLink(id: string, polarity: "positive" | "negative"): Promise<StrategyAssumptionLink | undefined> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(strategyAssumptionLinks).where(eq(strategyAssumptionLinks.id, id)).limit(1);
      if (!existing) return undefined;
      const assumption = await this.requireWritableAssumption(existing.assumptionId);
      const move = await this.requireVisibleMove(existing.moveInstanceId);
      if (move.goalId !== assumption.goalId) throw new Error("Assumption link move must belong to the same strategy");
      const [link] = await db.update(strategyAssumptionLinks).set({ polarity }).where(eq(strategyAssumptionLinks.id, id)).returning();
      if (link) await this.recomputeMoveProbability(link.moveInstanceId);
      return link;
    });
  }

  async deleteAssumptionLink(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(strategyAssumptionLinks).where(eq(strategyAssumptionLinks.id, id)).limit(1);
      if (!existing) return false;
      await this.requireWritableAssumption(existing.assumptionId);
      const [link] = await db.delete(strategyAssumptionLinks).where(eq(strategyAssumptionLinks.id, id)).returning();
      if (link) await this.recomputeMoveProbability(link.moveInstanceId);
      return !!link;
    });
  }

  async recomputeMoveProbability(moveInstanceId: string): Promise<number | undefined> {
    return autoHeal(async () => {
      const move = await this.getMoveInstance(moveInstanceId);
      if (!move) return undefined;
      const links = await this.getAssumptionLinksForMove(moveInstanceId);
      let probability = move.baseProbability;
      for (const link of links) {
        const assumption = await this.getAssumption(link.assumptionId);
        if (!assumption) continue;
        probability *= link.polarity === "negative" ? (1 - assumption.probability) : assumption.probability;
      }
      const bounded = Math.max(0, Math.min(1, probability));
      await db.update(strategyMoveInstances).set({ probability: bounded }).where(eq(strategyMoveInstances.id, moveInstanceId));
      return bounded;
    });
  }

  async recomputeMovesForAssumption(assumptionId: string): Promise<void> {
    await this.requireVisibleAssumption(assumptionId);
    const links = await this.getAssumptionLinksForAssumption(assumptionId);
    for (const link of links) await this.recomputeMoveProbability(link.moveInstanceId);
  }

  async getEndConditions(goalId: string): Promise<StrategyEndCondition[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      return db.select().from(strategyEndConditions).where(eq(strategyEndConditions.goalId, goalId));
    });
  }

  async createEndCondition(data: InsertStrategyEndCondition): Promise<StrategyEndCondition> {
    return autoHeal(async () => {
      await this.requireWritableGoal(data.goalId);
      const [condition] = await db.insert(strategyEndConditions).values(data).returning();
      return condition;
    });
  }

  async updateEndCondition(id: string, updates: Partial<InsertStrategyEndCondition>): Promise<StrategyEndCondition | undefined> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(strategyEndConditions).where(eq(strategyEndConditions.id, id)).limit(1);
      if (!existing) return undefined;
      await this.requireWritableGoal(existing.goalId);
      const [condition] = await db.update(strategyEndConditions).set(updates).where(eq(strategyEndConditions.id, id)).returning();
      return condition;
    });
  }

  async deleteEndCondition(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(strategyEndConditions).where(eq(strategyEndConditions.id, id)).limit(1);
      if (!existing) return false;
      await this.requireWritableGoal(existing.goalId);
      const result = await db.delete(strategyEndConditions).where(eq(strategyEndConditions.id, id)).returning();
      return result.length > 0;
    });
  }

  async getContextEntries(goalId: string): Promise<StrategyContextEntry[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      return db.select().from(strategyContextEntries).where(eq(strategyContextEntries.goalId, goalId)).orderBy(asc(strategyContextEntries.createdAt));
    });
  }

  async createContextEntry(data: InsertStrategyContextEntry): Promise<StrategyContextEntry> {
    return autoHeal(async () => {
      await this.requireWritableGoal(data.goalId);
      const [entry] = await db.insert(strategyContextEntries).values(data).returning();
      return entry;
    });
  }

  async updateContextEntry(id: string, updates: Partial<InsertStrategyContextEntry>): Promise<StrategyContextEntry | undefined> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(strategyContextEntries).where(eq(strategyContextEntries.id, id)).limit(1);
      if (!existing) return undefined;
      await this.requireWritableGoal(existing.goalId);
      const [entry] = await db.update(strategyContextEntries).set(updates).where(eq(strategyContextEntries.id, id)).returning();
      return entry;
    });
  }

  async deleteContextEntry(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(strategyContextEntries).where(eq(strategyContextEntries.id, id)).limit(1);
      if (!existing) return false;
      await this.requireWritableGoal(existing.goalId);
      const result = await db.delete(strategyContextEntries).where(eq(strategyContextEntries.id, id)).returning();
      return result.length > 0;
    });
  }

  async createSimulationRun(data: InsertStrategySimulationRun): Promise<StrategySimulationRun> {
    return autoHeal(async () => {
      await this.requireWritableGoal(data.goalId);
      await this.requireVisibleMove(data.rootMoveInstanceId);
      const [run] = await db.insert(strategySimulationRuns).values(data).returning();
      return run;
    });
  }

  async updateSimulationRun(id: string, updates: Partial<InsertStrategySimulationRun> & { completedAt?: Date | null }): Promise<StrategySimulationRun | undefined> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(strategySimulationRuns).where(eq(strategySimulationRuns.id, id)).limit(1);
      if (!existing) return undefined;
      await this.requireWritableGoal(existing.goalId);
      const [run] = await db.update(strategySimulationRuns).set(updates as any).where(eq(strategySimulationRuns.id, id)).returning();
      return run;
    });
  }

  async getActiveSimulations(goalId: string): Promise<StrategySimulationRun[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      return db.select().from(strategySimulationRuns).where(and(eq(strategySimulationRuns.goalId, goalId), eq(strategySimulationRuns.status, "running"))).orderBy(desc(strategySimulationRuns.startedAt));
    });
  }

  async getSimulationRuns(goalId: string): Promise<StrategySimulationRun[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      return db.select().from(strategySimulationRuns).where(eq(strategySimulationRuns.goalId, goalId)).orderBy(desc(strategySimulationRuns.startedAt));
    });
  }

  async getArtifacts(goalId: string): Promise<StrategyArtifact[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      return db.select().from(strategyArtifacts).where(eq(strategyArtifacts.goalId, goalId)).orderBy(desc(strategyArtifacts.createdAt));
    });
  }

  async createArtifact(data: InsertStrategyArtifact): Promise<StrategyArtifact> {
    return autoHeal(async () => {
      await this.requireWritableGoal(data.goalId);
      const [artifact] = await db.insert(strategyArtifacts).values(data).returning();
      return artifact;
    });
  }

  async deleteArtifact(id: string): Promise<void> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(strategyArtifacts).where(eq(strategyArtifacts.id, id)).limit(1);
      if (!existing) return;
      await this.requireWritableGoal(existing.goalId);
      await db.delete(strategyArtifacts).where(eq(strategyArtifacts.id, id));
    });
  }

  async getStates(goalId: string): Promise<StrategyState[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      return db.select().from(strategyStates).where(eq(strategyStates.goalId, goalId)).orderBy(asc(strategyStates.createdAt));
    });
  }

  async getState(id: string): Promise<StrategyState | undefined> {
    return autoHeal(async () => {
      const [state] = await db.select().from(strategyStates).where(eq(strategyStates.id, id));
      if (state) await this.requireVisibleGoal(state.goalId);
      return state;
    });
  }

  async createState(data: InsertStrategyState): Promise<StrategyState> {
    return autoHeal(async () => {
      await this.requireWritableGoal(data.goalId);
      const [state] = await db.insert(strategyStates).values(data).returning();
      return state;
    });
  }

  async updateState(id: string, updates: Partial<InsertStrategyState>): Promise<StrategyState | undefined> {
    return autoHeal(async () => {
      const existing = await this.getState(id);
      if (!existing) return undefined;
      await this.requireWritableGoal(existing.goalId);
      const [state] = await db.update(strategyStates).set(updates).where(eq(strategyStates.id, id)).returning();
      return state;
    });
  }

  async getStateReferences(stateId: string): Promise<{ terminatingMoves: StrategyMoveInstance[]; childMoves: StrategyMoveInstance[] }> {
    return autoHeal(async () => {
      const state = await this.getState(stateId);
      if (!state) return { terminatingMoves: [], childMoves: [] };
      const terminatingMoves = await db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.terminatingStateId, stateId));
      const childMoves = await db.select().from(strategyMoveInstances).where(eq(strategyMoveInstances.parentStateId, stateId));
      return { terminatingMoves, childMoves };
    });
  }

  async deleteState(id: string): Promise<{ deleted: boolean; reason?: string }> {
    return autoHeal(async () => {
      const state = await this.getState(id);
      if (!state) return { deleted: false };
      await this.requireWritableGoal(state.goalId);
      const refs = await this.getStateReferences(id);
      if (refs.terminatingMoves.length > 0 || refs.childMoves.length > 0) {
        const reason = `State is referenced by ${refs.terminatingMoves.length} terminating move(s) and ${refs.childMoves.length} child move(s). Clear those references first.`;
        return { deleted: false, reason };
      }
      const result = await db.delete(strategyStates).where(eq(strategyStates.id, id)).returning();
      return { deleted: result.length > 0 };
    });
  }

  async getMoveEndConditionEffects(moveInstanceId: string): Promise<StrategyMoveEndConditionEffect[]> {
    return autoHeal(async () => {
      await this.requireVisibleMove(moveInstanceId);
      return db.select().from(strategyMoveEndConditionEffects).where(eq(strategyMoveEndConditionEffects.moveInstanceId, moveInstanceId));
    });
  }

  async getMoveEndConditionEffectsForGoal(goalId: string): Promise<StrategyMoveEndConditionEffect[]> {
    return autoHeal(async () => {
      await this.requireVisibleGoal(goalId);
      const effects = await db.select({
        id: strategyMoveEndConditionEffects.id,
        moveInstanceId: strategyMoveEndConditionEffects.moveInstanceId,
        endConditionId: strategyMoveEndConditionEffects.endConditionId,
        effect: strategyMoveEndConditionEffects.effect,
      }).from(strategyMoveEndConditionEffects)
        .innerJoin(strategyMoveInstances, eq(strategyMoveEndConditionEffects.moveInstanceId, strategyMoveInstances.id))
        .where(eq(strategyMoveInstances.goalId, goalId));
      return effects as StrategyMoveEndConditionEffect[];
    });
  }

  async setMoveEndConditionEffect(moveInstanceId: string, endConditionId: string, effect: StrategyMoveEndConditionEffectValue): Promise<void> {
    return autoHeal(async () => {
      const move = await this.requireWritableMove(moveInstanceId);
      const [condition] = await db.select().from(strategyEndConditions).where(eq(strategyEndConditions.id, endConditionId)).limit(1);
      if (!condition || condition.goalId !== move.goalId) throw new Error("End condition must belong to the same writable strategy");
      if (effect === "none") {
        await db.delete(strategyMoveEndConditionEffects).where(and(eq(strategyMoveEndConditionEffects.moveInstanceId, moveInstanceId), eq(strategyMoveEndConditionEffects.endConditionId, endConditionId)));
        return;
      }
      await db.insert(strategyMoveEndConditionEffects).values({ moveInstanceId, endConditionId, effect }).onConflictDoUpdate({
        target: [strategyMoveEndConditionEffects.moveInstanceId, strategyMoveEndConditionEffects.endConditionId],
        set: { effect },
      });
    });
  }

  async duplicateStrategy(id: string): Promise<Strategy | undefined> {
    return autoHeal(async () => {
      const original = await this.getStrategy(id);
      if (!original) return undefined;
      await this.requireWritableGoal(id);
      const newStrategy = await this.createStrategy({ title: `${original.title} (Copy)`, description: original.description });

      const actorIdMap = new Map<string, string>();
      const actors = await this.getActors(id);
      for (const actor of actors) {
        const [newActor] = await db.insert(strategyActors).values({ goalId: newStrategy.id, personId: actor.personId, name: actor.name, notes: actor.notes, influence: actor.influence }).returning();
        actorIdMap.set(actor.id, newActor.id);
      }

      const moveDefIdMap = new Map<string, string>();
      const moveDefs = await this.getMoveDefinitions(id);
      for (const def of moveDefs) {
        const [newDef] = await db.insert(strategyMoveDefinitions).values({ goalId: newStrategy.id, actorId: actorIdMap.get(def.actorId) || def.actorId, title: def.title, description: def.description }).returning();
        moveDefIdMap.set(def.id, newDef.id);
      }

      const stateIdMap = new Map<string, string>();
      const states = await this.getStates(id);
      for (const state of states) {
        const [newState] = await db.insert(strategyStates).values({ goalId: newStrategy.id, name: state.name, description: state.description }).returning();
        stateIdMap.set(state.id, newState.id);
      }

      const moveInstanceIdMap = new Map<string, string>();
      const moveInstances = await this.getMoveInstancesForGoal(id);
      for (const inst of moveInstances) {
        const newParentId = inst.parentMoveInstanceId ? moveInstanceIdMap.get(inst.parentMoveInstanceId) || null : null;
        const newPath = inst.path.split("/").map(part => moveInstanceIdMap.get(part) || part).join("/");
        const [newInst] = await db.insert(strategyMoveInstances).values({
          refId: generateRefId(), goalId: newStrategy.id, parentMoveInstanceId: newParentId,
          parentStateId: inst.parentStateId ? stateIdMap.get(inst.parentStateId) || null : null,
          terminatingStateId: inst.terminatingStateId ? stateIdMap.get(inst.terminatingStateId) || null : null,
          moveDefinitionId: inst.moveDefinitionId ? moveDefIdMap.get(inst.moveDefinitionId) || null : null,
          actorId: inst.actorId ? actorIdMap.get(inst.actorId) || null : null,
          title: inst.title, description: inst.description, evaluation: inst.evaluation, impact: inst.impact,
          probability: inst.probability, baseProbability: inst.baseProbability, depth: inst.depth, path: newPath,
          status: inst.status, actorStates: inst.actorStates, source: inst.source,
        } as any).returning();
        moveInstanceIdMap.set(inst.id, newInst.id);
      }

      const assumptions = await this.getAssumptions(id);
      const assumptionIdMap = new Map<string, string>();
      for (const assumption of assumptions) {
        const [newAssumption] = await db.insert(strategyAssumptions).values({ goalId: newStrategy.id, title: assumption.title, description: assumption.description, probability: assumption.probability }).returning();
        assumptionIdMap.set(assumption.id, newAssumption.id);
      }

      for (const link of await this.getAssumptionLinksForGoal(id)) {
        const newAssumptionId = assumptionIdMap.get(link.assumptionId);
        const newMoveId = moveInstanceIdMap.get(link.moveInstanceId);
        if (newAssumptionId && newMoveId) await db.insert(strategyAssumptionLinks).values({ assumptionId: newAssumptionId, moveInstanceId: newMoveId, polarity: link.polarity });
      }

      for (const entry of await this.getContextEntries(id)) {
        await db.insert(strategyContextEntries).values({ goalId: newStrategy.id, type: entry.type, content: entry.content });
      }

      const endConditionIdMap = new Map<string, string>();
      for (const cond of await this.getEndConditions(id)) {
        const [newCond] = await db.insert(strategyEndConditions).values({ goalId: newStrategy.id, description: cond.description, isRequired: cond.isRequired, isSatisfied: cond.isSatisfied }).returning();
        endConditionIdMap.set(cond.id, newCond.id);
      }

      for (const e of await this.getMoveEndConditionEffectsForGoal(id)) {
        const newMoveId = moveInstanceIdMap.get(e.moveInstanceId);
        const newEcId = endConditionIdMap.get(e.endConditionId);
        if (newMoveId && newEcId) await db.insert(strategyMoveEndConditionEffects).values({ moveInstanceId: newMoveId, endConditionId: newEcId, effect: e.effect });
      }

      return newStrategy;
    });
  }
}

export const strategyStorage = new StrategyStorage();

export async function migrateStrategySchema(): Promise<void> {
  const migrations = [
    `ALTER TABLE strategy_goals ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false`,
    `ALTER TABLE strategy_goals ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user'`,
    `ALTER TABLE strategy_goals ADD COLUMN IF NOT EXISTS owner_user_id text`,
    `ALTER TABLE strategy_goals ADD COLUMN IF NOT EXISTS account_id text`,
    `WITH legacy_owner AS (
       SELECT u.id AS user_id, a.id AS account_id
       FROM users u
       INNER JOIN accounts a ON a.owner_user_id = u.id AND a.kind = 'personal'
       ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.created_at ASC
       LIMIT 1
     )
     UPDATE strategy_goals s
     SET scope = 'user',
         owner_user_id = COALESCE(s.owner_user_id, legacy_owner.user_id),
         account_id = COALESCE(s.account_id, legacy_owner.account_id)
     FROM legacy_owner
     WHERE s.owner_user_id IS NULL OR s.account_id IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_goals_scope_owner ON strategy_goals(scope, owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_goals_account ON strategy_goals(account_id)`,
    `ALTER TABLE strategy_actors ADD COLUMN IF NOT EXISTS influence real NOT NULL DEFAULT 0.5`,
    `ALTER TABLE strategy_move_instances ADD COLUMN IF NOT EXISTS ref_id text NOT NULL DEFAULT ''`,
    `ALTER TABLE strategy_move_instances ADD COLUMN IF NOT EXISTS actor_states jsonb NOT NULL DEFAULT '[]'::jsonb`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='strategy_simulation_runs' AND column_name='root_move_instance_id') THEN
         ALTER TABLE strategy_simulation_runs ADD COLUMN root_move_instance_id text REFERENCES strategy_move_instances(id) ON DELETE CASCADE;
       END IF;
     END $$`,
    `CREATE TABLE IF NOT EXISTS strategy_states (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       goal_id text NOT NULL REFERENCES strategy_goals(id) ON DELETE CASCADE,
       name text NOT NULL,
       description text NOT NULL DEFAULT '',
       created_at timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_states_goal ON strategy_states(goal_id)`,
    `ALTER TABLE strategy_move_instances ADD COLUMN IF NOT EXISTS terminating_state_id text`,
    `ALTER TABLE strategy_move_instances ADD COLUMN IF NOT EXISTS parent_state_id text`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='strategy_move_instances_terminating_state_fkey') THEN
         ALTER TABLE strategy_move_instances
           ADD CONSTRAINT strategy_move_instances_terminating_state_fkey
           FOREIGN KEY (terminating_state_id) REFERENCES strategy_states(id) ON DELETE SET NULL;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='strategy_move_instances_parent_state_fkey') THEN
         ALTER TABLE strategy_move_instances
           ADD CONSTRAINT strategy_move_instances_parent_state_fkey
           FOREIGN KEY (parent_state_id) REFERENCES strategy_states(id) ON DELETE SET NULL;
       END IF;
     END $$`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_move_inst_terminating_state ON strategy_move_instances(terminating_state_id)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_move_inst_parent_state ON strategy_move_instances(parent_state_id)`,
    `CREATE TABLE IF NOT EXISTS strategy_move_end_condition_effects (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       move_instance_id text NOT NULL REFERENCES strategy_move_instances(id) ON DELETE CASCADE,
       end_condition_id text NOT NULL REFERENCES strategy_end_conditions(id) ON DELETE CASCADE,
       effect text NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_move_ec_effects_move ON strategy_move_end_condition_effects(move_instance_id)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_move_ec_effects_ec ON strategy_move_end_condition_effects(end_condition_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_strategy_move_ec_effects ON strategy_move_end_condition_effects(move_instance_id, end_condition_id)`,
    `ALTER TABLE strategy_move_instances ADD COLUMN IF NOT EXISTS base_probability real NOT NULL DEFAULT 0.5`,
    `UPDATE strategy_move_instances SET base_probability = probability WHERE base_probability = 0.5 AND probability <> 0.5`,
    `CREATE TABLE IF NOT EXISTS strategy_assumption_links (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       assumption_id text NOT NULL REFERENCES strategy_assumptions(id) ON DELETE CASCADE,
       move_instance_id text NOT NULL REFERENCES strategy_move_instances(id) ON DELETE CASCADE,
       polarity text NOT NULL DEFAULT 'positive',
       created_at timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_assumption_links_assumption ON strategy_assumption_links(assumption_id)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_assumption_links_move ON strategy_assumption_links(move_instance_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_strategy_assumption_links ON strategy_assumption_links(assumption_id, move_instance_id)`,
    `INSERT INTO strategy_assumption_links (assumption_id, move_instance_id, polarity)
       SELECT a.id, m_id, 'positive'
       FROM strategy_assumptions a
       CROSS JOIN LATERAL unnest(COALESCE(a.affected_move_ids, '{}'::text[])) AS m_id
       WHERE EXISTS (SELECT 1 FROM strategy_move_instances mi WHERE mi.id = m_id)
         AND NOT EXISTS (
           SELECT 1 FROM strategy_assumption_links l
           WHERE l.assumption_id = a.id AND l.move_instance_id = m_id
         )`,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'strategy_move_instances'
           AND column_name = 'satisfied_end_condition_ids'
       ) THEN
         INSERT INTO strategy_move_end_condition_effects (move_instance_id, end_condition_id, effect)
         SELECT mi.id, ec_id, 'satisfies'
         FROM strategy_move_instances mi
         CROSS JOIN LATERAL unnest(COALESCE(mi.satisfied_end_condition_ids, '{}'::text[])) AS ec_id
         WHERE EXISTS (SELECT 1 FROM strategy_end_conditions ec WHERE ec.id = ec_id)
           AND NOT EXISTS (
             SELECT 1 FROM strategy_move_end_condition_effects e
             WHERE e.move_instance_id = mi.id AND e.end_condition_id = ec_id
           );
       END IF;
     END$$`,
    `ALTER TABLE strategy_move_instances DROP COLUMN IF EXISTS satisfied_end_condition_ids`,
  ];
  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (err: any) {
      log.error("migration failed:", err.message, "sql:", sql.slice(0, 80));
    }
  }
  log.debug("schema migration complete");
}
