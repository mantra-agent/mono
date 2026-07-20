// Use createLogger for logging ONLY
import type { Timer, TimerRun } from "@shared/models/timers";
import { createLogger } from "./log";
import { AgentTimerHandler } from "./agent-timer-handler";
import type { TimerHandler, TimerHandlerResult } from "./timer-handlers";

const log = createLogger("ReminderTimerHandler");

export class ReminderTimerHandler implements TimerHandler {
  constructor(private readonly agentTimerHandler = new AgentTimerHandler()) {}

  async execute(timer: Timer, run: TimerRun): Promise<TimerHandlerResult> {
    const sessionReminderId = timer.description?.startsWith("session-reminder:")
      ? timer.description.slice("session-reminder:".length)
      : null;
    const libraryPageId = timer.description?.startsWith("library-reminder:")
      ? timer.description.slice("library-reminder:".length)
      : null;

    if (sessionReminderId) {
      const { chatFileStorage } = await import("./chat-file-storage");
      await chatFileStorage.setHasUnreadResult(sessionReminderId, true);
      log.debug(`session reminder fired for session=${sessionReminderId}`);
      return {
        outcome: "success",
        output: { sessionReminderId },
      };
    }

    if (libraryPageId) {
      const { db } = await import("./db");
      const { libraryPages } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const { requireCurrentUserPrincipal } = await import("./principal-context");
      const { combineWithWritableScope } = await import("./scoped-storage");
      const { publishLibraryChanged } = await import("./library-save");
      const [updatedPage] = await db
        .update(libraryPages)
        .set({
          surface: true,
          surfaceUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
          surfaceReason: "Reminder",
          surfaceSection: "inbox",
          updatedAt: new Date(),
        })
        .where(combineWithWritableScope(requireCurrentUserPrincipal(), {
          scope: libraryPages.scope,
          ownerUserId: libraryPages.ownerUserId,
          accountId: libraryPages.accountId,
          vaultId: libraryPages.vaultId,
        }, eq(libraryPages.id, libraryPageId)))
        .returning();
      if (!updatedPage) {
        throw new Error(`Library reminder target was not writable: page=${libraryPageId}`);
      }
      publishLibraryChanged("reminder_fired", updatedPage);
      log.debug(`library reminder fired for page=${libraryPageId}`);
      return {
        outcome: "success",
        output: { libraryPageId },
      };
    }

    const result = await this.agentTimerHandler.execute(timer, run);
    if (result.outcome !== "success") return result;
    const output =
      result.output &&
      typeof result.output === "object" &&
      !Array.isArray(result.output)
        ? (result.output as Record<string, unknown>)
        : {};
    return { outcome: "success", output };
  }

}
