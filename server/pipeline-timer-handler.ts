// Use createLogger for logging ONLY
import type { Timer, TimerRun } from "@shared/models/timers";
import { createLogger } from "./log";
import type { TimerHandler, TimerHandlerResult } from "./timer-handlers";

const log = createLogger("PipelineTimerHandler");

type PipelineCommandHandler = (
  timer: Timer,
  run: TimerRun,
) => Promise<TimerHandlerResult>;

const PIPELINE_COMMAND_HANDLERS: Record<string, PipelineCommandHandler> = {
  "news:scan": async (timer, _run) => {
    const { runLandscapeScan } = await import("./news-scan-service");
    const result = await runLandscapeScan();

    // LandscapeScanResult uses `outcome` as the single discriminant. Never read
    // `.status` or assume a defined result — absent/malformed contracts fail closed.
    if (!result || typeof result !== "object") {
      const error = new Error(
        "News scan returned no result contract",
      ) as Error & { code?: string };
      error.code = "NEWS_SCAN_RESULT_MISSING";
      throw error;
    }

    const outcome = result.outcome;
    if (outcome !== "already_running" && outcome !== "failed" && outcome !== "completed") {
      const error = new Error(
        `News scan returned invalid outcome discriminant: ${String(outcome)}`,
      ) as Error & { code?: string };
      error.code = "NEWS_SCAN_RESULT_INVALID";
      throw error;
    }

    if (outcome === "already_running") {
      return {
        outcome: "deferred",
        reason: "news_scan_already_running",
        output: result,
      };
    }

    if (outcome === "failed") {
      return {
        outcome: "failed",
        error: result.message || "News scan failed without message",
        output: result,
      };
    }

    log.info(
      `Pipeline timer "${timer.name}" news scan complete: sources=${result.sourcesScanned} found=${result.itemsFound} surfaced=${result.itemsSurfaced} deduped=${result.itemsDeduped}`,
    );
    return { outcome: "success", output: result };
  },
};

export class PipelineTimerHandler implements TimerHandler {
  async execute(timer: Timer, run: TimerRun): Promise<TimerHandlerResult> {
    const command = timer.prompt?.trim();
    const handler = command ? PIPELINE_COMMAND_HANDLERS[command] : undefined;

    if (!handler) {
      throw new Error(`Unknown pipeline timer command: ${command || "<empty>"}`);
    }

    return handler(timer, run);
  }
}
