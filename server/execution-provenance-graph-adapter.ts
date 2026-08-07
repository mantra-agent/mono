import type { GraphAdapterResult, GraphEdge, GraphNode, PersonalGraphAdapter } from "@shared/life-addressing";
import {
  addressLinks,
  referenceOccurrences,
  sessionArtifacts,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { Principal } from "./principal";
import { runWithPrincipal } from "./principal-context";
import { db } from "./db";
import { combineWithVisibleScope } from "./scoped-storage";
import { chatFileStorage } from "./chat-file-storage";
import { canonicalSessionTriggerAddress, legacyExecutionArtifactAddress } from "./execution-provenance-address";
import { createLogger } from "./log";

const log = createLogger("ExecutionProvenanceGraphAdapter");
const DOMAIN_LIMIT = 500;
const MS_PER_DAY = 86_400_000;
const RECENCY_HALF_LIFE_DAYS = 7;
const sessionArtifactScope = { ownerUserId: sessionArtifacts.ownerUserId, accountId: sessionArtifacts.accountId };
const occurrenceScope = { scope: referenceOccurrences.scope, ownerUserId: referenceOccurrences.ownerUserId, accountId: referenceOccurrences.accountId };
const addressLinkScope = { scope: addressLinks.scope, ownerUserId: addressLinks.ownerUserId, accountId: addressLinks.accountId };

export function executionProvenanceGraphAdapterEnabled(): boolean {
  return process.env.EXECUTION_PROVENANCE_GRAPH_ADAPTER_ENABLED !== "false";
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function recency(value?: Date | string | null): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / MS_PER_DAY);
  return Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);
}

function node(address: string, type: string, label: string, summary?: string | null, updatedAt?: Date | string | null): GraphNode {
  const updated = updatedAt ? new Date(updatedAt).toISOString() : undefined;
  return { id: address, type, label: label || address, ...(summary ? { summary } : {}), ...(updated ? { updatedAt: updated } : {}), recency: recency(updatedAt), layoutSeed: stableHash(address) };
}
function edge(id: string, from: string, to: string, predicate: string, weight: number, sourceClass: GraphEdge["sourceClass"] = "domain", updatedAt?: Date | string | null): GraphEdge {
  const updated = updatedAt ? new Date(updatedAt).toISOString() : undefined;
  return { id, from, to, predicate, sourceClass, weight, ...(updated ? { updatedAt: updated } : {}) };
}

/**
 * Session provenance for the Memory Graph. Plans, plan attempts, workflows,
 * workflow gates, and PR artifact nodes are intentionally excluded from this
 * surface; domain truth remains in their owning systems.
 */
export const executionProvenanceGraphAdapter: PersonalGraphAdapter<Principal> = {
  id: "execution_provenance",
  sourceClass: "domain",
  async project(principal, input): Promise<GraphAdapterResult> {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw Object.assign(new Error("Execution provenance projection requires an authenticated user principal"), { status: 401 });
    }
    if (!executionProvenanceGraphAdapterEnabled()) return { nodes: [], edges: [] };
    return runWithPrincipal(principal, async () => {
      const limit = Math.min(Math.max(input.limit || DOMAIN_LIMIT, 1), DOMAIN_LIMIT);
      const allSessions = await chatFileStorage.getAllSessions(limit);
      const sessions = allSessions.slice(0, limit);
      const sessionIds = sessions.map(session => session.id);
      const visibleSessionIds = new Set(sessionIds);
      const sessionAddresses = sessionIds.map(id => `@session:${id}`);
      const [sessionArtifactRows, authoredRows, explicitRows] = await Promise.all([
        sessionIds.length ? db.select().from(sessionArtifacts).where(combineWithVisibleScope(principal, sessionArtifactScope, inArray(sessionArtifacts.sessionId, sessionIds))).limit(1_000) : [],
        sessionIds.length ? db.select().from(referenceOccurrences).where(combineWithVisibleScope(principal, occurrenceScope, inArray(referenceOccurrences.sourceAddress, sessionAddresses))).limit(1_000) : [],
        sessionIds.length
          ? db.select().from(addressLinks).where(combineWithVisibleScope(principal, addressLinkScope, and(
              eq(addressLinks.lifecycle, "active"),
              inArray(addressLinks.sourceAddress, sessionAddresses),
            ))).limit(1_000)
          : [],
      ]);

      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      for (const session of sessions) {
        const address = `@session:${session.id}`;
        nodes.push(node(address, "session", session.title || "Untitled session", session.summary, session.updatedAt));
        if (session.parentSessionId && visibleSessionIds.has(session.parentSessionId)) {
          edges.push(edge(`session:${session.id}:parent`, address, `@session:${session.parentSessionId}`, "child_of", 0.9, "domain", session.updatedAt));
        }
        const triggerAddress = session.triggerAddress || canonicalSessionTriggerAddress(session.triggerType, session.triggerId);
        if (triggerAddress) {
          edges.push(edge(`session:${session.id}:trigger`, address, triggerAddress, "triggered_by", 0.85, "domain", session.createdAt));
        }
      }
      for (const artifact of sessionArtifactRows) {
        const target = artifact.artifactAddress || legacyExecutionArtifactAddress(artifact.artifactType, artifact.artifactId, artifact.metadata);
        // Skip excluded Memory Graph targets (plans/workflows/tasks/prs/etc).
        // Assembler also fail-closes these, but avoid dangling unresolved edges.
        if (!target) continue;
        if (/^@(?:plan|plan_attempt|workflow|workflow_gate|task|pr|interaction):/i.test(target)) continue;
        edges.push(edge(`session-artifact:${artifact.id}`, `@session:${artifact.sessionId}`, target, "produced", 0.85, artifact.addressLinkId ? "explicit" : "domain", artifact.createdAt));
      }
      for (const occurrence of authoredRows) {
        if (/^@(?:plan|plan_attempt|workflow|workflow_gate|task|pr|interaction):/i.test(occurrence.targetAddress)) continue;
        edges.push(edge(`session-authored:${occurrence.id}`, occurrence.sourceAddress, occurrence.targetAddress, "references", 0.55, "authored", occurrence.observedAt));
      }
      for (const link of explicitRows) {
        if (/^@(?:plan|plan_attempt|workflow|workflow_gate|task|pr|interaction):/i.test(link.sourceAddress)) continue;
        if (/^@(?:plan|plan_attempt|workflow|workflow_gate|task|pr|interaction):/i.test(link.targetAddress)) continue;
        edges.push(edge(`execution-explicit:${link.id}`, link.sourceAddress, link.targetAddress, link.predicate, 0.9, "explicit", link.createdAt));
      }

      const legacySessionArtifacts = sessionArtifactRows.filter(row => !row.artifactAddress).length;
      const legacyTriggers = sessions.filter(session => session.triggerId && !session.triggerAddress).length;
      log.info(`[execution-provenance-graph] sessions=${sessions.length} edges=${edges.length} legacySessionArtifacts=${legacySessionArtifacts} legacyTriggers=${legacyTriggers}`);
      return { nodes, edges };
    });
  },
};
