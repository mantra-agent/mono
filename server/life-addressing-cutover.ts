import { asc } from "drizzle-orm";
import { libraryPages } from "@shared/models/info";
import { REFERENCE_REGISTRY } from "@shared/references";
import type { GraphAdapterResult, PersonalGraphAdapter } from "@shared/life-addressing";
import type { Principal } from "./principal";
import { db } from "./db";
import { combineWithVisibleScope } from "./scoped-storage";
import { libraryPageIsLive } from "./library-trash";
import { ADDRESS_RESOLUTION_BATCH_LIMIT, getMissingAddressResolverTypes, resolveAddressBatch, type AddressResolutionOutcome } from "./address-resolver";
import { meetingGraphAdapter, meetingGraphAdapterEnabled } from "./meetings/meeting-graph-adapter";
import { workGraphAdapter, workGraphAdapterEnabled } from "./work/work-graph-adapter";
import { relationshipGraphAdapter, relationshipGraphAdapterEnabled } from "./relationships/relationship-graph-adapter";
import { decisionStrategyGraphAdapter, decisionStrategyGraphAdapterEnabled } from "./strategy/decision-strategy-graph-adapter";
import { executionProvenanceGraphAdapter, executionProvenanceGraphAdapterEnabled } from "./execution-provenance-graph-adapter";
import { assemblePersonalGraph, libraryFirstGraphEnabled } from "./memory/personal-graph-projection";
import { backfillLibraryReferences, getLibraryReferenceNeighborhood, libraryPageLinksCompatibilityEnabled } from "./library-reference-index";
import { backfillIntroducedByLinksForPrincipal } from "./relationships/introduced-by-links";
import { backfillExecutionProvenance } from "./execution-provenance-backfill";
import { decisionsStorage } from "./decisions-storage";
import { chatFileStorage } from "./chat-file-storage";
import { indexSettledSessionReferences } from "./session-reference-index";
import { createLogger } from "./log";
import { eventBus } from "./event-bus";

const log = createLogger("LifeAddressingCutover");
const MAX_AUDIT_LIMIT = 100;
const MAX_ENDPOINT_SAMPLE = 500;
const MAX_DECISION_SAMPLE = 25;
const GRAPH_COLD_BUDGET_MS = 750;
const GRAPH_WARM_BUDGET_MS = 300;
const GRAPH_PAYLOAD_BUDGET_BYTES = 250 * 1024;
const pageScope = { scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, vaultId: libraryPages.vaultId };

const adapters: Array<{ id: string; adapter: PersonalGraphAdapter<Principal>; enabled: () => boolean }> = [
  { id: "meetings", adapter: meetingGraphAdapter, enabled: meetingGraphAdapterEnabled },
  { id: "work", adapter: workGraphAdapter, enabled: workGraphAdapterEnabled },
  { id: "relationships", adapter: relationshipGraphAdapter, enabled: relationshipGraphAdapterEnabled },
  { id: "decisions_strategy", adapter: decisionStrategyGraphAdapter, enabled: decisionStrategyGraphAdapterEnabled },
  { id: "execution_provenance", adapter: executionProvenanceGraphAdapter, enabled: executionProvenanceGraphAdapterEnabled },
];

type OutcomeCounts = Record<AddressResolutionOutcome, number>;

function emptyOutcomeCounts(): OutcomeCounts {
  return { resolved: 0, redirected: 0, missing: 0, unauthorized: 0, unknown_type: 0, invalid: 0, error: 0 };
}

function requireUserPrincipal(principal: Principal): void {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw Object.assign(new Error("Life Addressing cutover audit requires an authenticated user principal"), { status: 401 });
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function resolveEndpointSample(principal: Principal, projections: GraphAdapterResult[]): Promise<{
  sampled: number;
  truncated: boolean;
  outcomes: OutcomeCounts;
}> {
  const endpoints = [...new Set(projections.flatMap(result => result.edges.flatMap(edge => [edge.from, edge.to])))];
  const sample = endpoints.slice(0, MAX_ENDPOINT_SAMPLE);
  const outcomes = emptyOutcomeCounts();
  for (const batch of chunks(sample, ADDRESS_RESOLUTION_BATCH_LIMIT)) {
    for (const result of await resolveAddressBatch(principal, batch)) outcomes[result.outcome] += 1;
  }
  return { sampled: sample.length, truncated: endpoints.length > sample.length, outcomes };
}

export interface LifeAddressingCutoverInput {
  limit?: number;
  runBackfills?: boolean;
}

/**
 * One bounded acceptance boundary for Phase 4. It derives evidence from the
 * canonical resolver/adapters/stores, logs counts only, and never changes flags
 * or deletes compatibility state.
 */
export async function runLifeAddressingCutoverAudit(
  principal: Principal,
  input: LifeAddressingCutoverInput = {},
) {
  requireUserPrincipal(principal);
  const startedAt = Date.now();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), MAX_AUDIT_LIMIT);
  const runBackfills = input.runBackfills === true;

  const backfills: Record<string, unknown> = {};
  if (runBackfills) {
    backfills.library = await backfillLibraryReferences(principal, { limit });
    backfills.introducedBy = await backfillIntroducedByLinksForPrincipal(principal, { limit });
    backfills.executionProvenance = await backfillExecutionProvenance(principal, { limit });

    const sessions = (await chatFileStorage.getAllSessions(limit)).slice(0, limit);
    let indexed = 0;
    let errors = 0;
    for (const session of sessions) {
      try {
        await indexSettledSessionReferences(principal, session);
        indexed += 1;
      } catch {
        errors += 1;
      }
    }
    backfills.sessionReferences = { scanned: sessions.length, indexed, errors };

    const decisions = (await decisionsStorage.listDecisions()).slice(0, Math.min(limit, MAX_DECISION_SAMPLE));
    let linkRows = 0;
    let compatibilityRows = 0;
    for (const decision of decisions) {
      const links = await decisionsStorage.listLinks(decision.id);
      linkRows += links.length;
      compatibilityRows += links.filter(link => link.source === "compatibility").length;
    }
    backfills.decisions = { scanned: decisions.length, linkRows, compatibilityRows };
  }

  const [pageRows, adapterResults] = await Promise.all([
    db.select({ id: libraryPages.id }).from(libraryPages)
      .where(combineWithVisibleScope(principal, pageScope, libraryPageIsLive()))
      .orderBy(asc(libraryPages.id)).limit(Math.min(limit, 50)),
    Promise.all(adapters.map(async entry => ({
      id: entry.id,
      enabled: entry.enabled(),
      result: await entry.adapter.project(principal, { limit }),
    }))),
  ]);
  const projections = adapterResults.map(entry => entry.result);
  const endpointAuthorization = await resolveEndpointSample(principal, projections);
  const libraryParity = await getLibraryReferenceNeighborhood(principal, pageRows.map(page => page.id));

  const coldStartedAt = Date.now();
  const coldGraph = await assemblePersonalGraph(principal);
  const coldMeasuredMs = Date.now() - coldStartedAt;
  const warmStartedAt = Date.now();
  const warmGraph = await assemblePersonalGraph(principal);
  const warmMeasuredMs = Date.now() - warmStartedAt;

  const admittedByAdapter: Record<string, number> = {
    meetings: warmGraph.projection.meetingEdgeCount,
    work: warmGraph.projection.workEdgeCount,
    relationships: warmGraph.projection.relationshipEdgeCount,
    decisions_strategy: warmGraph.projection.decisionStrategyEdgeCount,
    execution_provenance: warmGraph.projection.executionProvenanceEdgeCount,
  };
  const projectionParity = adapterResults.map(entry => ({
    adapter: entry.id,
    enabled: entry.enabled,
    candidateNodes: entry.result.nodes.length,
    candidateEdges: entry.result.edges.length,
    admittedEdges: admittedByAdapter[entry.id] ?? 0,
    droppedEdges: Math.max(0, entry.result.edges.length - (admittedByAdapter[entry.id] ?? 0)),
  }));

  const report = {
    version: 1,
    ranBackfills: runBackfills,
    durationMs: Date.now() - startedAt,
    registry: {
      registeredTypes: Object.keys(REFERENCE_REGISTRY).length,
      graphTypes: Object.values(REFERENCE_REGISTRY).filter(entry => entry.graph).length,
      missingResolverTypes: getMissingAddressResolverTypes(),
    },
    flags: {
      canonicalGraphPreferred: libraryFirstGraphEnabled(),
      libraryCompatibility: libraryPageLinksCompatibilityEnabled(),
      adapters: Object.fromEntries(adapterResults.map(entry => [entry.id, entry.enabled])),
    },
    backfills,
    endpointAuthorization,
    libraryParity: {
      sampledPages: pageRows.length,
      ...libraryParity.parity,
      usedCompatibilityFallback: libraryParity.usedCompatibilityFallback,
    },
    projectionParity,
    performance: {
      cold: { measuredMs: coldMeasuredMs, assemblyMs: coldGraph.projection.assemblyMs, withinBudget: coldMeasuredMs <= GRAPH_COLD_BUDGET_MS, budgetMs: GRAPH_COLD_BUDGET_MS },
      warm: { measuredMs: warmMeasuredMs, assemblyMs: warmGraph.projection.assemblyMs, withinBudget: warmMeasuredMs <= GRAPH_WARM_BUDGET_MS, budgetMs: GRAPH_WARM_BUDGET_MS },
      payload: { bytes: warmGraph.projection.payloadBytes, withinBudget: warmGraph.projection.payloadBytes <= GRAPH_PAYLOAD_BUDGET_BYTES, budgetBytes: GRAPH_PAYLOAD_BUDGET_BYTES },
      adapterQueryCount: warmGraph.projection.adapterQueryCount,
    },
    retention: [
      { mechanism: "library_page_links", disposition: "retain", rollbackFlag: "LIBRARY_PAGE_LINKS_COMPATIBILITY_ENABLED", reason: "Stop writes only after a stable zero-fallback parity window." },
      { mechanism: "decision_links(target_type,target_id)", disposition: "retain", rollbackFlag: "DECISION_LINKS_COMPATIBILITY_ENABLED", reason: "Historical rows migrate lazily; remove only after zero compatibility rows across the observation window." },
      { mechanism: "session_artifacts(artifact_type,artifact_id)", disposition: "retain", reason: "Scoring and rollback still consume legacy coordinates; canonical artifact_address/address_link_id are additive." },
      { mechanism: "workflow_artifacts(ref_type,ref_id)", disposition: "retain", reason: "Workflow execution and rollback still consume legacy coordinates; canonical fields are additive." },
      { mechanism: "Chat triggerType+triggerId+triggerName", disposition: "retain", reason: "Execution orchestration still owns the legacy trigger triple; triggerAddress is an additive discovery projection." },
      { mechanism: "Project people/pages/files JSON", disposition: "retain", reason: "The Work domain remains authoritative; adapter projection removes the need for graph-specific copies without replacing domain state." },
      { mechanism: "Meeting copied page bundles and draftIds[]", disposition: "retain", rollbackFlag: "MEETING_GRAPH_ADAPTER_ENABLED", reason: "Meeting/Calendar records remain domain truth while the adapter canonicalizes graph identity." },
      { mechanism: "Person introducedBy", disposition: "retain", rollbackFlag: "RELATIONSHIP_GRAPH_ADAPTER_ENABLED", reason: "Free text remains required for unresolved historical names; resolvable IDs dual-project introduced_by links." },
      { mechanism: "Principle relatedIds JSON", disposition: "retain", reason: "Principle-to-Principle ordering and forge semantics remain domain-owned; no canonical Principle address type exists, so migration would invent identity rather than converge it." },
    ],
    retirementDecision: "deferred_pending_stable_observation_window",
  };

  log.info("Life Addressing Phase 4 cutover audit", {
    ranBackfills: report.ranBackfills,
    durationMs: report.durationMs,
    registeredTypes: report.registry.registeredTypes,
    missingResolverTypes: report.registry.missingResolverTypes.length,
    endpointOutcomes: report.endpointAuthorization.outcomes,
    libraryOldOnly: report.libraryParity.oldOnlyEdges,
    libraryNewOnly: report.libraryParity.newOnlyEdges,
    coldMs: report.performance.cold.measuredMs,
    warmMs: report.performance.warm.measuredMs,
    payloadBytes: report.performance.payload.bytes,
  });
  eventBus.publish({ category: "life_addressing", event: "phase4_cutover_audited", payload: {
    ranBackfills: report.ranBackfills,
    durationMs: report.durationMs,
    missingResolverTypes: report.registry.missingResolverTypes.length,
    endpointOutcomes: report.endpointAuthorization.outcomes,
    performance: report.performance,
    retirementDecision: report.retirementDecision,
  } });
  return report;
}
