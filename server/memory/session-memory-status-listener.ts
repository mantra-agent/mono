import { eventBus, type BusEvent } from "../event-bus";
import { createLogger } from "../log";
const log = createLogger("SessionMemorySyncListener");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let registered = false;

export function registerSessionMemorySyncListener(): void {
  if (registered) return;
  registered = true;

  eventBus.on("event", async (busEvent: BusEvent) => {
    if (busEvent.event !== "chat.session.status_changed") return;
    const { sessionId, status, previousStatus } = busEvent.payload as {
      sessionId?: string;
      status?: string;
      previousStatus?: string;
    };

    if (!sessionId || status !== "saved" || previousStatus === "saved") return;

    try {
      const { chatFileStorage } = await import("../chat-file-storage");
      const session = await chatFileStorage.getSession(sessionId);
      if (!session) {
        log.warn(`[ingest] skip source=chat_journal sessionId=${sessionId} reason=session_not_found`);
        return;
      }
      if (!session.summary?.trim()) {
        log.debug(
          `[ingest] observed_empty_summary source=chat_journal sessionId=${sessionId} ` +
          `reason=empty_summary_on_saved_transition messageCount=${session.messageCount} hasMemorySummary=${Boolean(session.memorySummary?.trim())} topics=${session.topics?.length || 0}`,
        );
      }

      await chatFileStorage.syncSessionMemoryMirror(sessionId);
    } catch (error: unknown) {
      log.error(`[ingest] error source=chat_journal sessionId=${sessionId} reason=saved_transition_sync_failed error=${errorMessage(error)}`);
    }
  });

  log.debug("Registered session memory sync listener for saved sessions");
}
