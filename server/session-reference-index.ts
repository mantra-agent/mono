import { createHash } from "crypto";
import { extractPositionedReferences } from "@shared/reference-parser";
import { normalizeProtocolAddress, REFERENCE_OCCURRENCE_BATCH_LIMIT } from "@shared/life-addressing";
import type { Principal } from "./principal";
import { resolveAddressBatch, ADDRESS_RESOLUTION_BATCH_LIMIT } from "./address-resolver";
import { replaceReferenceOccurrences } from "./life-addressing-storage";
import { createLogger } from "./log";

const log = createLogger("SessionReferenceIndex");

interface SessionReferenceSource {
  id: string;
  durableRevision?: number;
  updatedAt: string;
  status: string;
  type?: "text" | "voice" | "meeting";
  sessionType: string;
  messages: Array<{ role: string; content: string; visibility?: "chat" | "diagnostic"; assistantState?: string }>;
}

function requireUserPrincipal(principal: Principal): asserts principal is Principal & { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw Object.assign(new Error("Session reference indexing requires an authenticated user principal"), { status: 401 });
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function sessionReferenceContent(session: SessionReferenceSource): string {
  return session.messages
    .filter(message => message.visibility !== "diagnostic" && ["user", "assistant"].includes(message.role) && message.content.trim())
    .map(message => message.content)
    .join("\n\n");
}

/**
 * Settled ordinary Sessions are durable authored artifacts. Index only their
 * visible user/assistant prose; active checkpoints and Meeting transcripts stay
 * out of this projection to avoid write amplification and duplicate semantics.
 */
export async function indexSettledSessionReferences(principal: Principal, session: SessionReferenceSource): Promise<void> {
  requireUserPrincipal(principal);
  if (
    session.type === "meeting"
    || session.sessionType === "meeting"
    || ["streaming", "pending"].includes(session.status)
    || session.messages.some(message => message.assistantState === "streaming")
  ) return;

  const content = sessionReferenceContent(session);
  const positioned = extractPositionedReferences(content, { includeUnknownTypes: true });
  if (positioned.length > REFERENCE_OCCURRENCE_BATCH_LIMIT) {
    log.warn("Session reference projection exceeds the bounded occurrence limit", { sessionId: session.id, count: positioned.length });
    return;
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

  const occurrences = positioned.flatMap(item => {
    const normalized = normalizeProtocolAddress(item.ref.canonical);
    const targetAddress = item.ref.type === "page"
      ? canonicalPages.get(item.ref.canonical)
      : normalized.outcome === "valid"
        ? normalized.address
        : undefined;
    return targetAddress ? [{ targetAddress, location: { start: item.start, end: item.end } }] : [];
  });
  const contentHash = createHash("sha256").update(content).digest("hex");
  const result = await replaceReferenceOccurrences(principal, {
    sourceAddress: `@session:${session.id}`,
    sourceRevision: `sha256:${contentHash}`,
    observedAt: new Date(session.updatedAt),
    occurrences,
  });
  log.debug("Indexed settled Session references", { outcome: result.outcome, occurrenceCount: result.occurrenceCount });
}
