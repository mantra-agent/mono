import { db } from "./db";
import type { Principal } from "./principal";
import { createAddressLink } from "./life-addressing-storage";
import { sessionArtifacts, workflowArtifacts } from "@shared/schema";
import { combineWithWritableScope } from "./scoped-storage";
import { eq } from "drizzle-orm";

export async function linkSessionArtifactProduced(
  principal: Principal,
  row: typeof sessionArtifacts.$inferSelect,
): Promise<string | null> {
  if (!row.artifactAddress) return null;
  const link = await createAddressLink(principal, {
    sourceAddress: `@session:${row.sessionId}`,
    predicate: "produced",
    targetAddress: row.artifactAddress,
    provenanceAddress: `@session:${row.sessionId}`,
    createdBy: "session_artifacts",
    idempotencyKey: `session_artifact:${row.id}`,
  });
  await db.update(sessionArtifacts).set({ addressLinkId: link.id }).where(combineWithWritableScope(principal, {
    ownerUserId: sessionArtifacts.ownerUserId,
    accountId: sessionArtifacts.accountId,
  }, eq(sessionArtifacts.id, row.id)));
  return link.id;
}

export async function linkWorkflowArtifactProduced(
  principal: Principal,
  row: typeof workflowArtifacts.$inferSelect,
): Promise<string | null> {
  if (!row.artifactAddress) return null;
  const link = await createAddressLink(principal, {
    sourceAddress: `@workflow:${row.workflowRunId}`,
    predicate: "produced",
    targetAddress: row.artifactAddress,
    provenanceAddress: row.createdBySessionId ? `@session:${row.createdBySessionId}` : `@workflow:${row.workflowRunId}`,
    createdBy: "workflow_artifacts",
    idempotencyKey: `workflow_artifact:${row.id}`,
  });
  await db.update(workflowArtifacts).set({ addressLinkId: link.id }).where(combineWithWritableScope(principal, {
    scope: workflowArtifacts.scope,
    ownerUserId: workflowArtifacts.ownerUserId,
    accountId: workflowArtifacts.accountId,
  }, eq(workflowArtifacts.id, row.id)));
  return link.id;
}
