/**
 * Session Output Buffer Listener
 *
 * Subscribes to session close events and writes a compact output summary to
 * the session_output_buffer table.
 *
 * Single event path:
 *   chat.session.status_changed — emitted by chat-file-storage when
 *   session.status transitions. `saved` is the complete/resolved lifecycle state.
 *
 * Pattern mirrors intention-lifecycle-listener.ts.
 */

import { eventBus, type BusEvent } from "./event-bus";
import { createLogger } from "./log";

const log = createLogger("SessionOutputBufferListener");

export function registerSessionOutputBufferListener(): void {
  eventBus.on("event", async (busEvent: BusEvent) => {
    if (busEvent.event !== "chat.session.status_changed") return;
    const { sessionId, status, previousStatus } = busEvent.payload as {
      sessionId?: string;
      status?: string;
      previousStatus?: string;
    };

    if (!sessionId || status !== "saved" || previousStatus === "saved") return;

    try {
      const { writeSessionToBuffer } = await import("./session-output-buffer");
      await writeSessionToBuffer(sessionId);
    } catch (err: unknown) {
      log.warn(
        `Failed to write session ${sessionId} to output buffer: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  log.debug(
    "Registered session output buffer listener for chat.session.status_changed saved transitions",
  );
}
