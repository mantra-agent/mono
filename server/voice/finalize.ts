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
export async function finalizeVoiceSession(input: FinalizeVoiceSessionInput): Promise<void> {
  const { chatSessionId, voiceSessionId, principal, title } = input;

  if (!voiceSessionId) {
    throw new Error("Voice session ID is required for finalization");
  }

  const completed = await storage.completeOwnedVoiceSession(
    voiceSessionId,
    chatSessionId,
    principal,
  );
  if (!completed) {
    throw new Error("Voice session is not active for this chat");
  }
  endVoiceSession(voiceSessionId, "user_finalize");

  // Clear process-local activity before publishing the durable terminal row so
  // a concurrent /api/sessions read cannot project this session as active.
  sessionManager.finalizeSession(chatSessionId);
  await chatFileStorage.saveSession(chatSessionId, title || "Voice Chat");

  log.log(`completed chatSessionId=${chatSessionId} voiceSessionId=${voiceSessionId}`);
}
