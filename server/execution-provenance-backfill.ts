import { and, asc, eq, isNull, or } from "drizzle-orm";
import { sessionArtifacts, workflowArtifacts } from "@shared/schema";
import { db } from "./db";
import type { Principal } from "./principal";
import { combineWithVisibleScope, combineWithWritableScope } from "./scoped-storage";
import { canonicalExecutionArtifactAddress } from "./execution-provenance-address";
import { linkSessionArtifactProduced, linkWorkflowArtifactProduced } from "./execution-provenance-links";
import { createLogger } from "./log";

const log = createLogger("ExecutionProvenanceBackfill");
const MAX_BATCH_SIZE = 100;
const sessionScope = { ownerUserId: sessionArtifacts.ownerUserId, accountId: sessionArtifacts.accountId };
const workflowScope = { scope: workflowArtifacts.scope, ownerUserId: workflowArtifacts.ownerUserId, accountId: workflowArtifacts.accountId };

export interface ExecutionProvenanceBackfillResult {
  limit: number;
  sessionArtifacts: { scanned: number; addressed: number; linked: number; unresolved: number; errors: number };
  workflowArtifacts: { scanned: number; addressed: number; linked: number; unresolved: number; errors: number };
}

function requireUserPrincipal(principal: Principal): void {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw Object.assign(new Error("Execution provenance backfill requires an authenticated user principal"), { status: 401 });
  }
}

/**
 * Replay one bounded principal-visible batch of legacy execution artifact rows.
 * The legacy coordinates remain intact for rollback; replay only fills canonical
 * addresses and replay-keyed explicit `produced` assertions.
 */
export async function backfillExecutionProvenance(
  principal: Principal,
  input: { limit?: number } = {},
): Promise<ExecutionProvenanceBackfillResult> {
  requireUserPrincipal(principal);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? MAX_BATCH_SIZE), 1), MAX_BATCH_SIZE);
  const [sessionRows, workflowRows] = await Promise.all([
    db.select().from(sessionArtifacts).where(combineWithVisibleScope(
      principal,
      sessionScope,
      or(isNull(sessionArtifacts.artifactAddress), isNull(sessionArtifacts.addressLinkId)),
    )).orderBy(asc(sessionArtifacts.id)).limit(limit),
    db.select().from(workflowArtifacts).where(combineWithVisibleScope(
      principal,
      workflowScope,
      or(isNull(workflowArtifacts.artifactAddress), isNull(workflowArtifacts.addressLinkId)),
    )).orderBy(asc(workflowArtifacts.id)).limit(limit),
  ]);
  const result: ExecutionProvenanceBackfillResult = {
    limit,
    sessionArtifacts: { scanned: sessionRows.length, addressed: 0, linked: 0, unresolved: 0, errors: 0 },
    workflowArtifacts: { scanned: workflowRows.length, addressed: 0, linked: 0, unresolved: 0, errors: 0 },
  };

  for (const row of sessionRows) {
    try {
      const artifactAddress = row.artifactAddress ?? await canonicalExecutionArtifactAddress(principal, row.artifactType, row.artifactId, row.metadata);
      if (!artifactAddress) { result.sessionArtifacts.unresolved += 1; continue; }
      let current = row;
      if (!row.artifactAddress) {
        const [updated] = await db.update(sessionArtifacts).set({ artifactAddress }).where(combineWithWritableScope(
          principal,
          sessionScope,
          and(eq(sessionArtifacts.id, row.id), isNull(sessionArtifacts.artifactAddress)),
        )).returning();
        current = updated ?? { ...row, artifactAddress };
        result.sessionArtifacts.addressed += 1;
      }
      if (!current.addressLinkId) {
        await linkSessionArtifactProduced(principal, current);
        result.sessionArtifacts.linked += 1;
      }
    } catch {
      result.sessionArtifacts.errors += 1;
    }
  }

  for (const row of workflowRows) {
    try {
      const artifactAddress = row.artifactAddress ?? await canonicalExecutionArtifactAddress(principal, row.refType, row.refId, row.metadata);
      if (!artifactAddress) { result.workflowArtifacts.unresolved += 1; continue; }
      let current = row;
      if (!row.artifactAddress) {
        const [updated] = await db.update(workflowArtifacts).set({ artifactAddress }).where(combineWithWritableScope(
          principal,
          workflowScope,
          and(eq(workflowArtifacts.id, row.id), isNull(workflowArtifacts.artifactAddress)),
        )).returning();
        current = updated ?? { ...row, artifactAddress };
        result.workflowArtifacts.addressed += 1;
      }
      if (!current.addressLinkId) {
        await linkWorkflowArtifactProduced(principal, current);
        result.workflowArtifacts.linked += 1;
      }
    } catch {
      result.workflowArtifacts.errors += 1;
    }
  }

  log.info("Execution provenance backfill batch", result);
  return result;
}
