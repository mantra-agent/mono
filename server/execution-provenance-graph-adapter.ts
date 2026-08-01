import type { GraphAdapterResult, GraphEdge, GraphNode, PersonalGraphAdapter } from "@shared/life-addressing";
import {
  addressLinks,
  planExecutions,
  planSessionLinks,
  planStepAttempts,
  planSteps,
  referenceOccurrences,
  sessionArtifacts,
  workflowArtifacts,
  workflowGates,
  workflowRuns,
  workflowSessions,
  workflowStageAttempts,
} from "@shared/schema";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
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
const planScope = { ownerUserId: planExecutions.ownerUserId, accountId: planExecutions.accountId };
const planStepScope = { ownerUserId: planSteps.ownerUserId, accountId: planSteps.accountId };
const planAttemptScope = { ownerUserId: planStepAttempts.ownerUserId, accountId: planStepAttempts.accountId };
const planSessionScope = { ownerUserId: planSessionLinks.ownerUserId, accountId: planSessionLinks.accountId };
const sessionArtifactScope = { ownerUserId: sessionArtifacts.ownerUserId, accountId: sessionArtifacts.accountId };
const workflowScope = { scope: workflowRuns.scope, ownerUserId: workflowRuns.ownerUserId, accountId: workflowRuns.accountId };
const workflowAttemptScope = { scope: workflowStageAttempts.scope, ownerUserId: workflowStageAttempts.ownerUserId, accountId: workflowStageAttempts.accountId };
const workflowSessionScope = { scope: workflowSessions.scope, ownerUserId: workflowSessions.ownerUserId, accountId: workflowSessions.accountId };
const workflowGateScope = { scope: workflowGates.scope, ownerUserId: workflowGates.ownerUserId, accountId: workflowGates.accountId };
const workflowArtifactScope = { scope: workflowArtifacts.scope, ownerUserId: workflowArtifacts.ownerUserId, accountId: workflowArtifacts.accountId };
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
function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function recency(value: Date | string | null | undefined): number {
  const timestamp = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return 0;
  return Math.pow(2, -Math.max(0, (Date.now() - timestamp) / MS_PER_DAY) / RECENCY_HALF_LIFE_DAYS);
}
function node(address: string, type: string, label: string, summary?: string | null, updatedAt?: Date | string | null): GraphNode {
  const updated = iso(updatedAt);
  return { id: address, type, label: label || address, ...(summary ? { summary } : {}), ...(updated ? { updatedAt: updated } : {}), recency: recency(updatedAt), layoutSeed: stableHash(address) };
}
function edge(id: string, from: string, to: string, predicate: string, weight: number, sourceClass: GraphEdge["sourceClass"] = "domain", updatedAt?: Date | string | null): GraphEdge {
  const updated = iso(updatedAt);
  return { id, from, to, predicate, sourceClass, weight, ...(updated ? { updatedAt: updated } : {}) };
}

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
      const [allSessions, plans, workflows] = await Promise.all([
        chatFileStorage.getAllSessions(limit),
        db.select().from(planExecutions).where(combineWithVisibleScope(principal, planScope, isNull(planExecutions.archivedAt))).orderBy(desc(planExecutions.updatedAt)).limit(limit),
        db.select().from(workflowRuns).where(combineWithVisibleScope(principal, workflowScope, isNull(workflowRuns.archivedAt))).orderBy(desc(workflowRuns.updatedAt)).limit(Math.min(limit, 100)),
      ]);
      const sessions = allSessions.slice(0, limit);
      const sessionIds = sessions.map(session => session.id);
      const visibleSessionIds = new Set(sessionIds);
      const planIds = plans.map(plan => plan.id);
      const workflowIds = workflows.map(workflow => workflow.id);
      const [sessionArtifactRows, planStepsRows, planAttemptRows, planLinkRows, workflowAttemptRows, workflowSessionRows, workflowGateRows, workflowArtifactRows, authoredRows, explicitRows] = await Promise.all([
        sessionIds.length ? db.select().from(sessionArtifacts).where(combineWithVisibleScope(principal, sessionArtifactScope, inArray(sessionArtifacts.sessionId, sessionIds))).limit(1_000) : [],
        planIds.length ? db.select().from(planSteps).where(combineWithVisibleScope(principal, planStepScope, inArray(planSteps.planId, planIds))).limit(1_000) : [],
        planIds.length ? db.select().from(planStepAttempts).where(combineWithVisibleScope(principal, planAttemptScope, inArray(planStepAttempts.planId, planIds))).limit(1_000) : [],
        planIds.length ? db.select().from(planSessionLinks).where(combineWithVisibleScope(principal, planSessionScope, and(inArray(planSessionLinks.planId, planIds), isNull(planSessionLinks.unlinkedAt)))).limit(1_000) : [],
        workflowIds.length ? db.select().from(workflowStageAttempts).where(combineWithVisibleScope(principal, workflowAttemptScope, inArray(workflowStageAttempts.workflowRunId, workflowIds))).limit(1_000) : [],
        workflowIds.length ? db.select().from(workflowSessions).where(combineWithVisibleScope(principal, workflowSessionScope, inArray(workflowSessions.workflowRunId, workflowIds))).limit(1_000) : [],
        workflowIds.length ? db.select().from(workflowGates).where(combineWithVisibleScope(principal, workflowGateScope, inArray(workflowGates.workflowRunId, workflowIds))).limit(500) : [],
        workflowIds.length ? db.select().from(workflowArtifacts).where(combineWithVisibleScope(principal, workflowArtifactScope, inArray(workflowArtifacts.workflowRunId, workflowIds))).limit(1_000) : [],
        sessionIds.length ? db.select().from(referenceOccurrences).where(combineWithVisibleScope(principal, occurrenceScope, inArray(referenceOccurrences.sourceAddress, sessionIds.map(id => `@session:${id}`)))).limit(1_000) : [],
        sessionIds.length || workflowIds.length
          ? db.select().from(addressLinks).where(combineWithVisibleScope(principal, addressLinkScope, and(
              eq(addressLinks.lifecycle, "active"),
              or(
                ...(sessionIds.length ? [inArray(addressLinks.sourceAddress, sessionIds.map(id => `@session:${id}`))] : []),
                ...(workflowIds.length ? [inArray(addressLinks.sourceAddress, workflowIds.map(id => `@workflow:${id}`))] : []),
              ),
            ))).limit(1_000)
          : [],
      ]);

      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      for (const session of sessions) {
        const address = `@session:${session.id}`;
        nodes.push(node(address, "session", session.title || "Untitled session", session.summary, session.updatedAt));
        if (session.parentSessionId && visibleSessionIds.has(session.parentSessionId)) edges.push(edge(`session:${session.id}:parent`, address, `@session:${session.parentSessionId}`, "child_of", 0.9, "domain", session.updatedAt));
        const triggerAddress = session.triggerAddress || canonicalSessionTriggerAddress(session.triggerType, session.triggerId);
        if (triggerAddress) edges.push(edge(`session:${session.id}:trigger`, address, triggerAddress, "triggered_by", 0.85, "domain", session.createdAt));
      }
      for (const artifact of sessionArtifactRows) {
        const target = artifact.artifactAddress || legacyExecutionArtifactAddress(artifact.artifactType, artifact.artifactId, artifact.metadata);
        if (target) edges.push(edge(`session-artifact:${artifact.id}`, `@session:${artifact.sessionId}`, target, "produced", 0.85, artifact.addressLinkId ? "explicit" : "domain", artifact.createdAt));
      }
      for (const occurrence of authoredRows) edges.push(edge(`session-authored:${occurrence.id}`, occurrence.sourceAddress, occurrence.targetAddress, "references", 0.55, "authored", occurrence.observedAt));
      for (const link of explicitRows) edges.push(edge(`execution-explicit:${link.id}`, link.sourceAddress, link.targetAddress, link.predicate, 0.9, "explicit", link.createdAt));

      const attemptsByPlan = new Map<string, typeof planAttemptRows>();
      for (const attempt of planAttemptRows) attemptsByPlan.set(attempt.planId, [...(attemptsByPlan.get(attempt.planId) || []), attempt]);
      const stepSessionByPlan = new Map<string, string[]>();
      for (const step of planStepsRows) if (step.sessionId) stepSessionByPlan.set(step.planId, [...(stepSessionByPlan.get(step.planId) || []), step.sessionId]);
      for (const plan of plans) {
        const address = `@plan:${plan.id}`;
        nodes.push(node(address, "plan", `Plan ${plan.id}`, plan.status, plan.updatedAt));
        edges.push(edge(`plan:${plan.id}:page`, address, `@page:${plan.pageId}`, "rendered_as", 0.95, "domain", plan.updatedAt));
        edges.push(edge(`plan:${plan.id}:origin`, address, `@session:${plan.originSessionId}`, "originated_in", 0.95, "domain", plan.createdAt));
        if (plan.goalId) edges.push(edge(`plan:${plan.id}:goal`, address, `@goal:${plan.goalId}`, "advances", 0.85));
        if (plan.projectId) edges.push(edge(`plan:${plan.id}:project`, address, `@project:${plan.projectId}`, "executes_project", 0.85));
        const sessionSet = new Set([...(stepSessionByPlan.get(plan.id) || []), ...planLinkRows.filter(link => link.planId === plan.id).map(link => link.sessionId)]);
        for (const sessionId of sessionSet) edges.push(edge(`plan:${plan.id}:session:${sessionId}`, address, `@session:${sessionId}`, sessionId === plan.originSessionId ? "originated_in" : "has_step_session", 0.8));
        for (const attempt of attemptsByPlan.get(plan.id) || []) {
          const attemptAddress = `@plan_attempt:${attempt.id}`;
          const stepTitle = planStepsRows.find(step => step.planId === plan.id && step.id === attempt.stepId)?.title || attempt.stepId;
          nodes.push(node(attemptAddress, "plan_attempt", `${stepTitle} · Attempt ${attempt.attemptNumber}`, attempt.status, attempt.updatedAt));
          edges.push(edge(`plan-attempt:${attempt.id}:plan`, attemptAddress, address, "attempt_of", 0.9, "domain", attempt.updatedAt));
          if (attempt.childSessionId) edges.push(edge(`plan-attempt:${attempt.id}:session`, attemptAddress, `@session:${attempt.childSessionId}`, "executed_in", 0.9, "domain", attempt.updatedAt));
        }
      }

      for (const workflow of workflows) {
        const address = `@workflow:${workflow.id}`;
        nodes.push(node(address, "workflow", workflow.title, workflow.objective, workflow.updatedAt));
        if (workflow.linkedLibraryPageId) edges.push(edge(`workflow:${workflow.id}:page`, address, `@page:${workflow.linkedLibraryPageId}`, "rendered_as", 0.95));
        if (workflow.linkedPlanId) edges.push(edge(`workflow:${workflow.id}:plan`, address, `@plan:${workflow.linkedPlanId}`, "governs_plan", 0.9));
        if (workflow.linkedProjectId) edges.push(edge(`workflow:${workflow.id}:project`, address, `@project:${workflow.linkedProjectId}`, "executes_project", 0.85));
        if (workflow.linkedEnvironmentId) edges.push(edge(`workflow:${workflow.id}:environment`, address, `@environment:${workflow.linkedEnvironmentId}`, "targets_environment", 0.9));
        for (const relation of workflowSessionRows.filter(row => row.workflowRunId === workflow.id)) edges.push(edge(`workflow-session:${relation.id}`, address, `@session:${relation.sessionId}`, relation.role === "parent" ? "parent_session" : "stage_session", 0.85, "domain", relation.createdAt));
        for (const attempt of workflowAttemptRows.filter(row => row.workflowRunId === workflow.id)) {
          if (attempt.childSessionId) edges.push(edge(`workflow-attempt:${attempt.id}:session`, address, `@session:${attempt.childSessionId}`, "stage_session", 0.8, "domain", attempt.updatedAt));
          if (attempt.linkedPlanId) edges.push(edge(`workflow-attempt:${attempt.id}:plan`, address, `@plan:${attempt.linkedPlanId}`, "stage_plan", 0.8, "domain", attempt.updatedAt));
        }
        for (const gate of workflowGateRows.filter(row => row.workflowRunId === workflow.id)) {
          const gateAddress = `@workflow_gate:${gate.id}`;
          nodes.push(node(gateAddress, "workflow_gate", `${gate.gateType} gate`, gate.status, gate.resolvedAt || gate.openedAt));
          edges.push(edge(`workflow-gate:${gate.id}`, gateAddress, address, "gate_of", 0.8, "domain", gate.openedAt));
        }
        for (const artifact of workflowArtifactRows.filter(row => row.workflowRunId === workflow.id)) {
          const target = artifact.artifactAddress || legacyExecutionArtifactAddress(artifact.refType, artifact.refId, artifact.metadata);
          if (target) edges.push(edge(`workflow-artifact:${artifact.id}`, address, target, "produced", 0.85, artifact.addressLinkId ? "explicit" : "domain", artifact.createdAt));
        }
      }
      const legacySessionArtifacts = sessionArtifactRows.filter(row => !row.artifactAddress).length;
      const legacyWorkflowArtifacts = workflowArtifactRows.filter(row => !row.artifactAddress).length;
      const legacyTriggers = sessions.filter(session => session.triggerId && !session.triggerAddress).length;
      log.info(`[execution-provenance-graph] sessions=${sessions.length} plans=${plans.length} workflows=${workflows.length} edges=${edges.length} legacySessionArtifacts=${legacySessionArtifacts} legacyWorkflowArtifacts=${legacyWorkflowArtifacts} legacyTriggers=${legacyTriggers}`);
      return { nodes, edges };
    });
  },
};
