import { createHash } from "crypto";
import { extractPositionedReferences } from "@shared/reference-parser";
import { normalizeProtocolAddress, REFERENCE_OCCURRENCE_BATCH_LIMIT } from "@shared/life-addressing";
import { decisionUpdates, type Decision } from "@shared/schema";
import type { Principal } from "./principal";
import { resolveAddressBatch, ADDRESS_RESOLUTION_BATCH_LIMIT } from "./address-resolver";
import { replaceReferenceOccurrences } from "./life-addressing-storage";
import { createLogger } from "./log";
import { db } from "./db";
import { asc, eq } from "drizzle-orm";

const log = createLogger("DecisionReferenceIndex");

function requireUserPrincipal(principal: Principal): asserts principal is Principal & { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw Object.assign(new Error("Decision reference indexing requires an authenticated user principal"), { status: 401 });
  }
}

function revisionForContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

/**
 * Index the Decision aggregate (Data, Scenarios, Plan, and append-only updates)
 * as one durable authored source. This runs inside the ambient Decision mutation
 * transaction so the occurrence projection can never observe a partial revision.
 */
export async function indexDecisionReferences(principal: Principal, decision: Decision): Promise<void> {
  requireUserPrincipal(principal);
  const updates = await db.select().from(decisionUpdates)
    .where(eq(decisionUpdates.decisionId, decision.id))
    .orderBy(asc(decisionUpdates.createdAt));
  const content = [
    decision.dataPlainText,
    decision.scenariosPlainText,
    decision.planPlainText,
    ...updates.slice().reverse().map(update => update.content),
  ].filter(Boolean).join("\n\n");
  const positioned = extractPositionedReferences(content, { includeUnknownTypes: true });
  if (positioned.length > REFERENCE_OCCURRENCE_BATCH_LIMIT) {
    throw Object.assign(new Error(`Decision contains too many references (max ${REFERENCE_OCCURRENCE_BATCH_LIMIT})`), { status: 400 });
  }

  const pageAddresses = [...new Set(positioned.filter(item => item.ref.type === "page").map(item => item.ref.canonical))];
  const canonicalPages = new Map<string, string>();
  for (const batch of chunks(pageAddresses, ADDRESS_RESOLUTION_BATCH_LIMIT)) {
    for (const result of await resolveAddressBatch(principal, batch)) {
      if ((result.outcome === "resolved" || result.outcome === "redirected") && result.resolution) {
        canonicalPages.set(result.requestedAddress, result.resolution.address);
      }
    }
  }

  let unresolvedCount = 0;
  const occurrences = positioned.flatMap(item => {
    const normalized = normalizeProtocolAddress(item.ref.canonical);
    const targetAddress = item.ref.type === "page"
      ? canonicalPages.get(item.ref.canonical)
      : normalized.outcome === "valid"
        ? normalized.address
        : undefined;
    if (!targetAddress) {
      unresolvedCount += 1;
      return [];
    }
    return [{ targetAddress, location: { start: item.start, end: item.end } }];
  });

  const result = await replaceReferenceOccurrences(principal, {
    sourceAddress: `@decision:${decision.id}`,
    sourceRevision: revisionForContent(content),
    observedAt: decision.updatedAt,
    occurrences,
  });
  log.debug("Indexed Decision references", {
    outcome: result.outcome,
    occurrenceCount: result.occurrenceCount,
    unresolvedCount,
  });
}
