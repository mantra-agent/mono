import type { FileSession, IChatFileStorage } from "../chat-file-storage";
import { chatFileStorage } from "../chat-file-storage";
import { createLogger } from "../log";
import { runWithPrincipal } from "../principal-context";
import type { VoiceSession } from "./types";

const log = createLogger("VoiceChatOwner");

export type VoiceChatAccessOutcome<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "persistence_disabled" }
  | { outcome: "superseded" }
  | { outcome: "owner_context_missing" }
  | { outcome: "chat_unavailable" }
  | { outcome: "storage_failure"; error: Error };

export interface VoiceChatAccessOptions {
  isCurrent?: () => boolean;
  nullMeansUnavailable?: boolean;
}

/**
 * Canonical owner-bound access boundary for authenticated voice chat state.
 * Every callback, retry, reconnect, and deferred write re-enters the Principal
 * captured by the durable voice lease before touching principal-scoped chat data.
 */
export async function accessVoiceChat<T>(
  session: VoiceSession,
  operation: string,
  execute: (storage: IChatFileStorage, chat: FileSession) => Promise<T>,
  options: VoiceChatAccessOptions = {},
): Promise<VoiceChatAccessOutcome<T>> {
  if (!session.chatSessionId) return { outcome: "persistence_disabled" };
  if (options.isCurrent && !options.isCurrent()) return { outcome: "superseded" };

  const principal = session.principal;
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    log.error("voice chat owner context missing", {
      operation,
      voiceSessionId: session.id,
      chatSessionId: session.chatSessionId,
      actorType: principal.actorType,
    });
    return { outcome: "owner_context_missing" };
  }

  try {
    return await runWithPrincipal(principal, async () => {
      if (options.isCurrent && !options.isCurrent()) return { outcome: "superseded" as const };
      const chat = await chatFileStorage.getSession(session.chatSessionId!);
      if (!chat) {
        log.warn("voice chat unavailable to durable owner scope", {
          operation,
          voiceSessionId: session.id,
          chatSessionId: session.chatSessionId,
        });
        return { outcome: "chat_unavailable" as const };
      }
      if (options.isCurrent && !options.isCurrent()) return { outcome: "superseded" as const };
      const value = await execute(chatFileStorage, chat);
      if (options.nullMeansUnavailable && value == null) {
        log.warn("voice chat became unavailable during owner-bound mutation", {
          operation,
          voiceSessionId: session.id,
          chatSessionId: session.chatSessionId,
        });
        return { outcome: "chat_unavailable" as const };
      }
      return { outcome: "ok" as const, value };
    });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    log.error("owner-bound voice chat operation failed", {
      operation,
      voiceSessionId: session.id,
      chatSessionId: session.chatSessionId,
      error: normalized.message,
    });
    return { outcome: "storage_failure", error: normalized };
  }
}

export function voiceChatAccessError(
  operation: string,
  outcome: Extract<VoiceChatAccessOutcome<unknown>, { outcome: "owner_context_missing" | "storage_failure" }>,
): Error {
  if (outcome.outcome === "storage_failure") return outcome.error;
  return new Error(`Voice ownership invariant failed during ${operation}: owner context missing`);
}
