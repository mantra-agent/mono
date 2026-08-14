/**
 * Canonical best-effort telemetry write path.
 *
 * Observability samples (browser performance, mobile startup, ambient metrics)
 * share one serial log-sink delivery so call sites do not reinvent queues.
 * Durable correctness writes (ACL, settings, billing) must not use this module.
 */
import { withQueryAttributionAsync } from "./db";
import { areDatabasePoolsClosing } from "./database-adapters";
import { createLogger } from "./log";
import { createSerialAsyncDelivery } from "./utils/serial-async-delivery";

const log = createLogger("TelemetryWrite");

type TelemetryWriteJob = {
  label: string;
  run: () => Promise<void>;
};

const telemetryLogSink = createSerialAsyncDelivery<TelemetryWriteJob>(
  async (job) => {
    // Once graceful shutdown has begun ending the DB pools, best-effort telemetry
    // must not touch a pool. Writing to an ended pool throws, and the failure is
    // itself an application error that re-enqueues here — a self-amplifying flood
    // that trips the provider log-rate limiter and starves shutdown/boot evidence.
    // Degrade gracefully: drop the sample silently.
    if (areDatabasePoolsClosing()) return;
    await withQueryAttributionAsync("log-sink", job.run, job.label);
  },
  {
    label: "telemetry-log-sink",
    maxPending: 128,
    onFailure: (error) => {
      log.warn("telemetry log-sink write failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  },
);

/**
 * Enqueue a best-effort observability write on the shared log-sink lane.
 * Returns immediately. The insert runs serially in the background; backlog
 * overflow is logged and dropped rather than blocking the producer.
 */
export function enqueueTelemetryWrite(label: string, run: () => Promise<void>): void {
  telemetryLogSink.enqueue({ label, run });
}

/** Current backlog depth (queued + in-flight) on the shared telemetry sink. */
export function telemetryWritePending(): number {
  return telemetryLogSink.pending();
}
