// Use createLogger for logging ONLY
import type { Timer, TimerRun } from "@shared/models/timers";
import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import type { TimerHandler, TimerHandlerResult } from "./timer-handlers";

const log = createLogger("SystemTimerHandler");

type SystemCommandHandler = (
  timer: Timer,
  run: TimerRun,
) => Promise<TimerHandlerResult>;

const SYSTEM_COMMAND_HANDLERS: Record<string, SystemCommandHandler> = {
  "tactical:loop": async (timer, run) => {
    log.debug(`Publishing system:command event: command=tactical:loop`);
    eventBus.publish({
      category: "system",
      event: "system:command",
      payload: { command: "tactical:loop", timerId: timer.id, runId: run.id },
    });
    return { outcome: "success" };
  },

  prioritize: async (timer, run) => {
    log.debug(`Publishing system:command event: command=prioritize`);
    eventBus.publish({
      category: "system",
      event: "system:command",
      payload: { command: "prioritize", timerId: timer.id, runId: run.id },
    });
    return { outcome: "success" };
  },

  "reflection:run": async (timer, run) => {
    log.debug(`Publishing system:command event: command=reflection:run`);
    eventBus.publish({
      category: "system",
      event: "system:command",
      payload: { command: "reflection:run", timerId: timer.id, runId: run.id },
    });
    return { outcome: "success" };
  },

  "email-sync": async (_timer, _run) => {
    log.debug(`Executing owner-scoped email-sync system command (tier: realtime)`);
    const { runEmailSyncTimer } = await import("./email-sync-timer");
    const result = await runEmailSyncTimer();

    if (result.status === "already_running") {
      return {
        outcome: "deferred",
        reason: "email_sync_already_running",
        output: result,
      };
    }
    if (result.errors.length > 0) {
      return {
        outcome: "degraded",
        reason: "owner_scoped_email_pipeline_errors",
        output: result,
      };
    }
    if (result.ownersWithAccounts === 0) {
      return {
        outcome: "skipped",
        reason: "no_connected_gmail_accounts",
        output: result,
      };
    }
    return { outcome: "success", output: result };
  },

  "plaid-refresh": async (_timer, _run) => {
    log.debug(`Executing plaid-refresh system command`);
    const { isPlaidConfigured, refreshAllItems } =
      await import("./plaid-service");
    if (!isPlaidConfigured()) {
      log.warn(`plaid-refresh: Plaid is not configured — skipping refresh`);
      return { outcome: "skipped", reason: "plaid_not_configured" };
    }
    await refreshAllItems();
    log.log(`plaid-refresh complete`);
    return { outcome: "success" };
  },

  "backup:create": async (_timer, _run) => {
    log.debug(`Executing backup:create system command`);
    const { createBackup, getBackup } = await import("./backup-storage");
    const job = await createBackup("scheduled");
    const startedAt = Date.now();
    // Live dumps now run 15–25+ minutes as row counts grow past ~3.5M.
    // Waiting too short projects TIMER_HANDLER_FAILED while the job still
    // finishes successfully (2026-08-17 job b4d067c5: 1194s complete after
    // a 10m wait throw). Keep a hard ceiling so the serial scheduler does
    // not park forever on a stuck job.
    const timeoutMs = 45 * 60 * 1000;

    while (Date.now() - startedAt < timeoutMs) {
      const current = await getBackup(job.id);
      if (current?.status === "complete") {
        log.log(
          `backup:create complete: job=${job.id} size=${current.size_bytes ?? "unknown"} rows=${current.row_count ?? "unknown"}`,
        );
        return {
          outcome: "success",
          output: {
            jobId: job.id,
            sizeBytes: current.size_bytes,
            rowCount: current.row_count,
          },
        };
      }
      if (current?.status === "failed") {
        throw new Error(
          `backup:create failed: job=${job.id} error=${current.error || "unknown"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }

    const current = await getBackup(job.id);
    // Job is still running (or status unknown) after the wait ceiling.
    // Do not throw: backup continues in-process and createBackup already
    // owns durable completion/failure. Degrade so Nightly Backup does not
    // flood TIMER_HANDLER_FAILED for slow-but-healthy dumps.
    if (current?.status === "complete") {
      log.log(
        `backup:create complete after wait ceiling: job=${job.id} size=${current.size_bytes ?? "unknown"} rows=${current.row_count ?? "unknown"}`,
      );
      return {
        outcome: "success",
        output: {
          jobId: job.id,
          sizeBytes: current.size_bytes,
          rowCount: current.row_count,
        },
      };
    }
    if (current?.status === "failed") {
      throw new Error(
        `backup:create failed: job=${job.id} error=${current.error || "unknown"}`,
      );
    }
    log.warn(
      `backup:create wait ceiling reached with job still ${current?.status ?? "unknown"}: job=${job.id} waitedMs=${timeoutMs}`,
    );
    return {
      outcome: "degraded",
      reason: "backup_wait_timeout_still_running",
      output: {
        jobId: job.id,
        waitedMs: timeoutMs,
        status: current?.status ?? "unknown",
      },
    };
  },

  "oura-sync": async (_timer, _run) => {
    log.debug("Executing bounded Oura sync system command");
    const { getAccount } = await import("./connected-accounts");
    const { syncOuraAccount } = await import("./integrations/oura/sync");
    const account = await getAccount("oura:primary");
    if (!account) return { outcome: "skipped", reason: "oura_not_connected" };
    try {
      const result = await syncOuraAccount({ accountId: account.accountId, mode: "incremental" });
      return { outcome: "success", output: result };
    } catch (error) {
      return { outcome: "degraded", reason: "oura_sync_failed", output: { error: error instanceof Error ? error.message : String(error) } };
    }
  },

  "content-publish": async (_timer, _run) => {
    log.debug(`Executing content-publish system command`);
    const { publishScheduledContent } = await import("./content-publisher");
    await publishScheduledContent();
    log.log(`content-publish cycle complete`);
    return { outcome: "success" };
  },

  "meeting-watchdog": async (_timer, _run) => {
    log.debug("Executing owner-scoped meeting-watchdog system command");
    const { runMeetingWatchdog } = await import("./meeting/watchdog");
    const result = await runMeetingWatchdog();
    if (result.errors.length > 0) {
      return {
        outcome: "degraded",
        reason: "owner_scoped_meeting_watchdog_errors",
        output: result,
      };
    }
    if (result.eventsScanned === 0) {
      return {
        outcome: "skipped",
        reason: "no_ended_events_with_attendees",
        output: result,
      };
    }
    return { outcome: "success", output: result };
  },
};


export class SystemTimerHandler implements TimerHandler {
  async execute(timer: Timer, run: TimerRun): Promise<TimerHandlerResult> {
    const command = timer.prompt?.trim();
    const handler = command ? SYSTEM_COMMAND_HANDLERS[command] : undefined;

    if (handler) {
      return handler(timer, run);
    }

    throw new Error(`Unknown system timer command: ${command || "<empty>"}`);
  }

}
