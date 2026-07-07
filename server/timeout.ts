export const SECTION_RESOLVE_TIMEOUT_MS = 15_000;
export const CONTEXT_ASSEMBLY_TIMEOUT_MS = 30_000;
export const STREAM_IDLE_TIMEOUT_MS = 120_000;
export const STREAM_IDLE_TIMEOUT_EXTENDED_MS = 600_000;
export const COMPACTION_LLM_TIMEOUT_MS = 30_000;
export const STREAM_FINAL_MESSAGE_TIMEOUT_MS = 5_000;
export const EMBEDDING_API_TIMEOUT_MS = 10_000;
export const DB_STATEMENT_TIMEOUT_MS = 10_000;
export const DB_POOL_MAX = 30;
export const DB_POOL_MIN = 20;
export const DB_IDLE_TIMEOUT_MS = 60_000;
// Bounded grace window the executor waits for a run's spawned background work
// (in-flight cost-log inserts, iterator-return chains, interrupt acks) to drain
// before it releases the admission slot and forgets the run. Same order of
// magnitude as COST_LOG_DEADLINE_MS — abort cleanup is a cleanup contract, not
// a place to grow latency. Keep this value here, not scattered through code.
export const POST_ABORT_DRAIN_GRACE_MS = 10_000;


export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    }),
  ]);
}

export function withAbortTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  if (parentSignal?.aborted) {
    controller.abort();
    return Promise.reject(new TimeoutError(label, 0));
  }
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout>;

  const cleanup = () => {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  };

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      cleanup();
      reject(new TimeoutError(label, ms));
    }, ms);

    fn(controller.signal).then(
      (val) => { cleanup(); resolve(val); },
      (err) => { cleanup(); reject(err); },
    );
  });
}

export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof TimeoutError;
}

/** Extract the reason string from an AbortSignal, if present. */
function getAbortReason(signal: AbortSignal): string | undefined {
  const reason = "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * Race a promise against an AbortSignal with a grace period.
 * When the signal fires, waits `graceMs` for the promise to resolve before rejecting.
 * The abort reason (if set on the signal) is included in the error message.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  graceMs: number,
  label: string,
): Promise<T> {
  if (signal.aborted) {
    const reason = getAbortReason(signal);
    return Promise.reject(new Error(`${label}: aborted${reason ? ` (reason: ${reason})` : ""}`));
  }
  return new Promise<T>((resolve, reject) => {
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      graceTimer = setTimeout(() => {
        const reason = getAbortReason(signal);
        reject(new Error(`${label}: aborted after ${graceMs}ms grace${reason ? ` (reason: ${reason})` : ""}`));
      }, graceMs);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => { if (graceTimer) clearTimeout(graceTimer); signal.removeEventListener("abort", onAbort); resolve(val); },
      (err) => { if (graceTimer) clearTimeout(graceTimer); signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

export function createInactivityTimer(
  ms: number,
  onTimeout: () => void,
  options?: { deferred?: boolean },
): { start: () => void; reset: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  const begin = () => {
    started = true;
    timer = setTimeout(onTimeout, ms);
  };

  const start = () => {
    if (!started) begin();
  };

  const reset = () => {
    if (timer !== null) clearTimeout(timer);
    if (started) {
      timer = setTimeout(onTimeout, ms);
    }
  };

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  if (!options?.deferred) {
    begin();
  }
  return { start, reset, clear };
}
