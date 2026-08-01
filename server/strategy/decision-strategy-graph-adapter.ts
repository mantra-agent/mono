import type { GraphAdapterResult, GraphEdge, GraphNode, PersonalGraphAdapter } from "@shared/life-addressing";
import { normalizeProtocolAddress } from "@shared/life-addressing";
import { addressLinks, referenceOccurrences, strategyActors, strategyArtifacts } from "@shared/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { createLogger } from "../log";
import { db } from "../db";
import { combineWithVisibleScope } from "../scoped-storage";
import { decisionsStorage } from "../decisions-storage";
import { strategyStorage } from "../strategy-storage";

const log = createLogger("DecisionStrategyGraphAdapter");
const DOMAIN_LIMIT = 500;
const SELECTED_STRATEGY_LIMIT = 5;
const MOVES_PER_STRATEGY = 40;
const ASSUMPTIONS_PER_STRATEGY = 20;
const END_CONDITIONS_PER_STRATEGY = 20;
const STATES_PER_STRATEGY = 20;
const ARTIFACTS_PER_STRATEGY = 20;
const RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export function decisionStrategyGraphAdapterEnabled(): boolean {
  return process.env.DECISION_STRATEGY_GRAPH_ADAPTER_ENABLED !== "false";
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function recency(value: Date | string | null | undefined): number {
  const timestamp = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / MS_PER_DAY);
  return Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);
}

function node(address: string, type: string, label: string, summary?: string, updatedAt?: Date | string | null): GraphNode {
  const updated = iso(updatedAt);
  return {
    id: address,
    type,
    label: label || address,
    ...(summary ? { summary } : {}),
    ...(updated ? { updatedAt: updated } : {}),
    recency: recency(updatedAt),
    layoutSeed: stableHash(address),
  };
}

function edge(id: string, from: string, to: string, predicate: string, weight: number, sourceClass: GraphEdge["sourceClass"] = "domain", updatedAt?: Date | string | null): GraphEdge {
  const updated = iso(updatedAt);
  return { id, from, to, predicate, weight, sourceClass, ...(updated ? { updatedAt: updated } : {}) };
}

function selectedStrategyIds(addresses: readonly string[] | undefined): string[] {
  const ids = new Set<string>();
  for (const address of addresses ?? []) {
    const normalized = normalizeProtocolAddress(address);
    if (normalized.outcome === "valid" && normalized.type === "strategy") ids.add(normalized.id);
    if (ids.size >= SELECTED_STRATEGY_LIMIT) break;
  }
  return [...ids];
}

/**
 * Default projection is intentionally flat: Decision and Strategy roots, actors,
 * artifacts, authored occurrences, and explicit Decision links. Internal
 * simulation topology appears only for explicitly selected Strategy addresses.
 */
export const decisionStrategyGraphAdapter: PersonalGraphAdapter<Principal> = {
  id: "decision_strategy",
  sourceClass: "domain",
  async project(principal, input): Promise<GraphAdapterResult> {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw Object.assign(new Error("Decision/Strategy graph projection requires an authenticated user principal"), { status: 401 });
    }
    if (!decisionStrategyGraphAdapterEnabled()) return { nodes: [], edges: [] };

    return runWithPrincipal(principal, async () => {
      const limit = Math.min(Math.max(input.limit || DOMAIN_LIMIT, 1), DOMAIN_LIMIT);
      const [decisions, strategies] = await Promise.all([
        decisionsStorage.listDecisions(),
        strategyStorage.getStrategies({ archived: false }),
      ]);
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      const visibleDecisions = decisions.slice(0, limit);
      const visibleStrategies = strategies.slice(0, limit);

      for (const decision of visibleDecisions) {
        const address = `@decision:${decision.id}`;
        nodes.push(node(address, "decision", decision.title, decision.description || `${decision.status} decision`, decision.updatedAt));
      }
      const decisionAddresses = visibleDecisions.map(decision => `@decision:${decision.id}`);
      if (decisionAddresses.length > 0) {
        const occurrenceScope = {
          scope: referenceOccurrences.scope,
          ownerUserId: referenceOccurrences.ownerUserId,
          accountId: referenceOccurrences.accountId,
        };
        const addressLinkScope = {
          scope: addressLinks.scope,
          ownerUserId: addressLinks.ownerUserId,
          accountId: addressLinks.accountId,
        };
        const [occurrences, explicitLinks] = await Promise.all([
          db.select({
            id: referenceOccurrences.id,
            sourceAddress: referenceOccurrences.sourceAddress,
            targetAddress: referenceOccurrences.targetAddress,
            observedAt: referenceOccurrences.observedAt,
          }).from(referenceOccurrences)
            .where(combineWithVisibleScope(principal, occurrenceScope, inArray(referenceOccurrences.sourceAddress, decisionAddresses)))
            .orderBy(asc(referenceOccurrences.observedAt), asc(referenceOccurrences.id))
            .limit(500),
          db.select({
            id: addressLinks.id,
            sourceAddress: addressLinks.sourceAddress,
            targetAddress: addressLinks.targetAddress,
            predicate: addressLinks.predicate,
            createdAt: addressLinks.createdAt,
          }).from(addressLinks)
            .where(combineWithVisibleScope(principal, addressLinkScope, and(
              inArray(addressLinks.sourceAddress, decisionAddresses),
              eq(addressLinks.lifecycle, "active"),
            )))
            .orderBy(asc(addressLinks.createdAt), asc(addressLinks.id))
            .limit(500),
        ]);
        for (const occurrence of occurrences) {
          edges.push(edge(`decision:authored:${occurrence.id}`, occurrence.sourceAddress, occurrence.targetAddress, "references", 0.55, "authored", occurrence.observedAt));
        }
        for (const link of explicitLinks) {
          if (!["relates_to", "governs", "evidence_for", "triggered_by", "produced"].includes(link.predicate)) continue;
          edges.push(edge(`decision:explicit:${link.id}`, link.sourceAddress, link.targetAddress, link.predicate, 0.9, "explicit", link.createdAt));
        }
      }

      const strategyIds = visibleStrategies.map(strategy => strategy.id);
      const [actors, artifacts] = strategyIds.length > 0 ? await Promise.all([
        db.select().from(strategyActors).where(inArray(strategyActors.goalId, strategyIds)).orderBy(asc(strategyActors.createdAt)).limit(500),
        db.select().from(strategyArtifacts).where(inArray(strategyArtifacts.goalId, strategyIds)).orderBy(asc(strategyArtifacts.createdAt)).limit(500),
      ]) : [[], []];
      const actorsByStrategy = new Map<string, typeof actors>();
      const artifactsByStrategy = new Map<string, typeof artifacts>();
      for (const actor of actors) actorsByStrategy.set(actor.goalId, [...(actorsByStrategy.get(actor.goalId) ?? []), actor]);
      for (const artifact of artifacts) artifactsByStrategy.set(artifact.goalId, [...(artifactsByStrategy.get(artifact.goalId) ?? []), artifact]);

      for (const strategy of visibleStrategies) {
        const address = `@strategy:${strategy.id}`;
        nodes.push(node(address, "strategy", strategy.title, strategy.description, strategy.updatedAt));
        const strategyActorRows = actorsByStrategy.get(strategy.id) ?? [];
        const strategyArtifactRows = artifactsByStrategy.get(strategy.id) ?? [];
        for (const actor of strategyActorRows) {
          edges.push(edge(`strategy:${strategy.id}:actor:${actor.id}`, address, `@person:${actor.personId}`, "has_actor", 0.85, "domain", actor.createdAt));
        }
        for (const artifact of strategyArtifactRows.slice(0, ARTIFACTS_PER_STRATEGY)) {
          const fileAddress = artifact.objectPath.startsWith("/objects/") ? `@file:${artifact.objectPath}` : `@file:/objects/${artifact.objectPath}`;
          edges.push(edge(`strategy:${strategy.id}:artifact:${artifact.id}`, address, fileAddress, "has_artifact", 0.7, "domain", artifact.createdAt));
        }
      }

      const visibleStrategyIds = new Set(visibleStrategies.map(strategy => strategy.id));
      let selectedTopologyCount = 0;
      for (const strategyId of selectedStrategyIds(input.selectedAddresses)) {
        if (!visibleStrategyIds.has(strategyId)) continue;
        const strategyAddress = `@strategy:${strategyId}`;
        const [moves, assumptions, endConditions, states, assumptionLinks, effects] = await Promise.all([
          strategyStorage.getMoveTree(strategyId),
          strategyStorage.getAssumptions(strategyId),
          strategyStorage.getEndConditions(strategyId),
          strategyStorage.getStates(strategyId),
          strategyStorage.getAssumptionLinksForGoal(strategyId),
          strategyStorage.getMoveEndConditionEffectsForGoal(strategyId),
        ]);
        const selectedMoves = moves.slice(0, MOVES_PER_STRATEGY);
        const moveIds = new Set(selectedMoves.map(move => move.id));
        for (const move of selectedMoves) {
          const address = `@strategy_move:${move.id}`;
          nodes.push(node(address, "strategy_move", move.title || `Move ${move.refId || move.id}`, move.description || move.impact, move.createdAt));
          const parentAddress = move.parentMoveInstanceId && moveIds.has(move.parentMoveInstanceId)
            ? `@strategy_move:${move.parentMoveInstanceId}`
            : strategyAddress;
          edges.push(edge(`strategy:${strategyId}:move:${move.id}`, address, parentAddress, move.parentMoveInstanceId ? "follows_move" : "move_of", 0.8, "domain", move.createdAt));
          if (move.parentStateId) edges.push(edge(`strategy:${strategyId}:move:${move.id}:from_state`, address, `@strategy_state:${move.parentStateId}`, "starts_from", 0.7));
          if (move.terminatingStateId) edges.push(edge(`strategy:${strategyId}:move:${move.id}:to_state`, address, `@strategy_state:${move.terminatingStateId}`, "terminates_at", 0.7));
        }
        for (const assumption of assumptions.slice(0, ASSUMPTIONS_PER_STRATEGY)) {
          nodes.push(node(`@strategy_assumption:${assumption.id}`, "strategy_assumption", assumption.title, assumption.description, assumption.createdAt));
          edges.push(edge(`strategy:${strategyId}:assumption:${assumption.id}`, `@strategy_assumption:${assumption.id}`, strategyAddress, "assumption_of", 0.65, "domain", assumption.createdAt));
        }
        for (const condition of endConditions.slice(0, END_CONDITIONS_PER_STRATEGY)) {
          nodes.push(node(`@strategy_end_condition:${condition.id}`, "strategy_end_condition", condition.description.slice(0, 120), condition.isSatisfied ? "satisfied" : "unsatisfied"));
          edges.push(edge(`strategy:${strategyId}:end:${condition.id}`, `@strategy_end_condition:${condition.id}`, strategyAddress, "end_condition_of", 0.7));
        }
        for (const state of states.slice(0, STATES_PER_STRATEGY)) {
          nodes.push(node(`@strategy_state:${state.id}`, "strategy_state", state.name, state.description, state.createdAt));
          edges.push(edge(`strategy:${strategyId}:state:${state.id}`, `@strategy_state:${state.id}`, strategyAddress, "state_of", 0.65, "domain", state.createdAt));
        }
        for (const link of assumptionLinks) {
          if (!moveIds.has(link.moveInstanceId)) continue;
          edges.push(edge(`strategy:${strategyId}:assumption-link:${link.id}`, `@strategy_assumption:${link.assumptionId}`, `@strategy_move:${link.moveInstanceId}`, link.polarity === "negative" ? "reduces_probability" : "supports_probability", 0.6, "domain", link.createdAt));
        }
        for (const effect of effects) {
          if (!moveIds.has(effect.moveInstanceId) || effect.effect === "none") continue;
          edges.push(edge(`strategy:${strategyId}:effect:${effect.id}`, `@strategy_move:${effect.moveInstanceId}`, `@strategy_end_condition:${effect.endConditionId}`, effect.effect, 0.7));
        }
        selectedTopologyCount += selectedMoves.length + assumptions.length + endConditions.length + states.length;
      }

      log.info(`[decision-strategy-graph] decisions=${visibleDecisions.length} strategies=${visibleStrategies.length} edges=${edges.length} selectedTopology=${selectedTopologyCount}`);
      return { nodes, edges };
    });
  },
};
