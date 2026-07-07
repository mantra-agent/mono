import { createLogger } from "./log";
import type { FileSession, FileMessage, CrossSessionMeta } from "./chat-file-storage";

const log = createLogger("SessionTree");

const DEFAULT_CHAIN_CAP = 20;

function getCap(): number {
  const raw = process.env.CROSS_SESSION_CHAIN_CAP;
  if (!raw) return DEFAULT_CHAIN_CAP;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CHAIN_CAP;
}

export function chainCap(): number {
  return getCap();
}

export interface SessionLike {
  id: string;
  parentSessionId?: string;
  sessionKey?: string | null;
  title?: string;
  spawnReason?: string;
  spawnerSkillRun?: string;
}

export type SessionFetcher = (id: string) => Promise<SessionLike | undefined>;
export type ChildrenFetcher = (parentId: string) => Promise<SessionLike[]>;
export type RecentInboundFetcher = (sessionId: string) => Promise<FileMessage | undefined>;

export async function getAncestry(
  sessionId: string,
  fetch: SessionFetcher,
  maxDepth = 64,
): Promise<SessionLike[]> {
  const out: SessionLike[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = sessionId;
  for (let i = 0; i < maxDepth && cur; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const s = await fetch(cur);
    if (!s) break;
    out.push(s);
    cur = s.parentSessionId;
  }
  return out;
}

export async function getRoot(
  sessionId: string,
  fetch: SessionFetcher,
): Promise<SessionLike | undefined> {
  const chain = await getAncestry(sessionId, fetch);
  return chain[chain.length - 1];
}

export type ScopeResult =
  | { ok: true; target: SessionLike; direction: "sibling" | "parent" | "child" }
  | { ok: false; reason: string };

/**
 * Validate that `caller` is allowed to message `target` based on tree position.
 * Sibling: same non-null parentSessionId, target !== caller.
 * Parent:  target.id === caller.parentSessionId.
 * Child:   target.parentSessionId === caller.id (mirror of parent).
 */
export function validateCrossSessionScope(
  caller: SessionLike,
  target: SessionLike,
  direction: "sibling" | "parent" | "child",
): ScopeResult {
  if (caller.id === target.id) {
    return { ok: false, reason: "Cannot message self." };
  }
  if (direction === "parent") {
    if (!caller.parentSessionId) {
      return { ok: false, reason: "Caller has no parent session." };
    }
    if (caller.parentSessionId !== target.id) {
      return {
        ok: false,
        reason: `Target ${target.id} is not the direct parent of ${caller.id}.`,
      };
    }
    return { ok: true, target, direction: "parent" };
  }
  if (direction === "child") {
    if (!target.parentSessionId) {
      return { ok: false, reason: "Target is a root session and cannot be a child." };
    }
    if (target.parentSessionId !== caller.id) {
      return {
        ok: false,
        reason: `Target ${target.id} is not a direct child of ${caller.id}.`,
      };
    }
    return { ok: true, target, direction: "child" };
  }
  // sibling
  if (!caller.parentSessionId) {
    return { ok: false, reason: "Caller is a root session and has no siblings." };
  }
  if (!target.parentSessionId) {
    return { ok: false, reason: "Target is a root session and cannot be a sibling." };
  }
  if (caller.parentSessionId !== target.parentSessionId) {
    return {
      ok: false,
      reason: `Target ${target.id} is not a sibling of ${caller.id} (different parents).`,
    };
  }
  return { ok: true, target, direction: "sibling" };
}

/**
 * Resolve a sibling target by spawn reason. Looks at the parent's direct
 * children. Matches against the explicit `spawnReason` field first; falls back
 * to title/sessionKey heuristics for legacy sessions that did not record an
 * explicit spawn reason.
 */
export async function resolveSiblingBySpawnReason(
  caller: SessionLike,
  spawnReason: string,
  childrenOf: ChildrenFetcher,
): Promise<SessionLike | undefined> {
  if (!caller.parentSessionId) return undefined;
  const siblings = await childrenOf(caller.parentSessionId);
  const reason = spawnReason.trim();
  // Pass 1: explicit spawnReason match.
  const exact = siblings.find(s => s.id !== caller.id && s.spawnReason === reason);
  if (exact) return exact;
  // Pass 2: legacy fallback for sessions without spawnReason metadata.
  return siblings.find(s => {
    if (s.id === caller.id) return false;
    if (s.spawnReason) return false;
    if (s.title === reason) return true;
    if (s.sessionKey === reason) return true;
    if (s.sessionKey === `auto:${reason}`) return true;
    return false;
  });
}

export interface ChainTokenOk {
  ok: true;
  chainId: string;
  depth: number;
  cap: number;
}
export interface ChainTokenAbort {
  ok: false;
  chainId: string;
  depth: number;
  cap: number;
  reason: string;
}

function generateChainId(): string {
  return `chain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Compute the next chain token for an outbound cross-session message based on
 * the caller's most recent inbound cross-session message. If a recent inbound
 * message exists, inherit its chainId and increment its depth. Otherwise begin
 * a fresh chain at depth 1.
 *
 * Depth metadata is propagated **inside the message stream itself**, so a
 * chain naturally resets when no upstream message is feeding it. There is no
 * permanent process-level counter that could lock out future messages.
 */
export function nextChainToken(
  recentInbound: FileMessage | undefined,
): ChainTokenOk | ChainTokenAbort {
  const cap = getCap();
  const inboundMeta = recentInbound?.crossSession;
  const chainId = inboundMeta?.chainId || generateChainId();
  const depth = (inboundMeta?.depth ?? 0) + 1;
  if (depth > cap) {
    log.error(
      `[CrossSessionMsg] chain-depth-cap exceeded chainId=${chainId} depth=${depth} cap=${cap} — aborting chain`,
    );
    return {
      ok: false,
      chainId,
      depth,
      cap,
      reason: `Cross-session message chain exceeded cap of ${cap} (current depth ${depth}).`,
    };
  }
  return { ok: true, chainId, depth, cap };
}

export function buildSessionFetcher(
  storage: { getSession(id: string): Promise<FileSession | undefined> },
): SessionFetcher {
  return async (id: string) => {
    const s = await storage.getSession(id);
    return s
      ? {
          id: s.id,
          parentSessionId: s.parentSessionId,
          sessionKey: s.sessionKey,
          title: s.title,
          spawnReason: s.spawnReason,
          spawnerSkillRun: s.spawnerSkillRun,
        }
      : undefined;
  };
}

export function buildChildrenFetcher(
  storage: { getAllSessions(): Promise<FileSession[]> },
): ChildrenFetcher {
  return async (parentId: string) => {
    const all = await storage.getAllSessions();
    return all
      .filter(s => s.parentSessionId === parentId)
      .map(s => ({
        id: s.id,
        parentSessionId: s.parentSessionId,
        sessionKey: s.sessionKey,
        title: s.title,
        spawnReason: s.spawnReason,
        spawnerSkillRun: s.spawnerSkillRun,
      }));
  };
}

export function buildRecentInboundFetcher(
  storage: { getMessagesBySession(id: string): Promise<FileMessage[]> },
): RecentInboundFetcher {
  return async (sessionId: string) => {
    const msgs = await storage.getMessagesBySession(sessionId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "cross_session" && m.crossSession?.toSessionId === sessionId) {
        return m;
      }
    }
    return undefined;
  };
}

// Re-export for callers needing the meta type.
export type { CrossSessionMeta };
