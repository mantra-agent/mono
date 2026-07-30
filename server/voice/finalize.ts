import type { Principal } from "../principal";
import { chatFileStorage } from "../chat-file-storage";
import { createLogger } from "../log";
import { sessionManager } from "../session-manager";
import { storage } from "../storage";
import { endVoiceSession } from "./session";

const log = createLogger("VoiceFinalize");

export interface FinalizeVoiceSessionInput {
  chatSessionId: string;
  voiceSessionId?: string;
  principal: Principal;
  title: string;
}

/**
 * Canonical user-triggered voice completion boundary.
 *
 * Replacement/reconnect cleanup stays in session.ts. This boundary is only for
 * terminal completion of the chat session visible to the user.
 */
export type FinalizeVoiceSessionResult =
  | { outcome: "finalized"; replayed: boolean }
  | { outcome: "not_finalized"; reason: "not_completable" };

export async function finalizeVoiceSession(
  input: FinalizeVoiceSessionInput,
): Promise<FinalizeVoiceSessionResult> {
  const { chatSessionId, voiceSessionId, principal, title } = input;

  if (!voiceSessionId) {
    return { outcome: "not_finalized", reason: "not_completable" };
  }

  const leaseOutcome = await storage.completeOwnedVoiceSession(
    voiceSessionId,
    chatSessionId,
    principal,
  );
  if (leaseOutcome === "not_completable") {
    return { outcome: "not_finalized", reason: "not_completable" };
  }
  if (leaseOutcome === "superseded") {
    log.warn(
      `replayed completion is superseded chatSessionId=${chatSessionId} voiceSessionId=${voiceSessionId}`,
    );
    return { outcome: "finalized", replayed: true };
  }
  endVoiceSession(voiceSessionId, "user_finalize");

  // Persist the terminal Session document before publishing the terminal stream
  // so subscribers receive a durable revision they can reconcile exactly.
  const durableRevision = await chatFileStorage.saveSession(chatSessionId, title || "Voice Chat");
  sessionManager.finalizeSession(chatSessionId, undefined, durableRevision);

  const replayed = leaseOutcome === "already_complete";
  log.log(
    `completed chatSessionId=${chatSessionId} voiceSessionId=${voiceSessionId} replayed=${replayed}`,
  );
  return { outcome: "finalized", replayed };
}
