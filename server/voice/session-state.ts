/**
 * V2.5 Session State — SHIM over the v2 session store.
 *
 * Per "Leave No Zombies": no v2.5-specific state today. The wrapper exists
 * solely so callers import `./session-state` (engine-scoped) and a future
 * v2.5-only store change can land here without churning every call site.
 *
 * If v2.5 is retired or merged with v2, delete this file.
 */
// Re-export VoiceSession type from the legacy module so other v2.5 modules
// have a single import surface. (The runtime store still lives in v2.)
import type { VoiceSession } from "./types";
export type { VoiceSession };

export async function getSession(sessionId: string): Promise<VoiceSession | null> {
  const { getVoiceSession } = await import("./session");
  return getVoiceSession(sessionId);
}

export async function findForChat(chatSessionId: string): Promise<VoiceSession | null> {
  const { findSessionForChat } = await import("./session");
  return findSessionForChat(chatSessionId);
}

export async function endSession(sessionId: string, reason?: string): Promise<VoiceSession | null> {
  const { endVoiceSession } = await import("./session");
  return endVoiceSession(sessionId, reason);
}
