export interface SerialAsyncDeliveryOptions {
  label: string;
  maxPending?: number;
  onFailure: (error: unknown) => void;
}

export interface SerialAsyncDelivery<T> {
  enqueue(value: T): void;
  pending(): number;
}

/**
 * Owns settlement and ordering for async callbacks emitted by a synchronous
 * transport event. A consumer failure is reported and fenced from later items;
 * it never becomes a transport error or an unhandled rejection.
 *
 * Use this for best-effort work (telemetry, STT transcript delivery) where the
 * producer must not await durability. For ordered durable writes that must
 * return a result, use `createSerialQueue`.
 */
export function createSerialAsyncDelivery<T>(
  consume: (value: T) => Promise<void> | void,
  options: SerialAsyncDeliveryOptions,
): SerialAsyncDelivery<T> {
  const maxPending = Math.max(1, Math.min(options.maxPending ?? 64, 256));
  const queue: T[] = [];
  let consuming = false;
  let inFlight = false;

  const drain = async (): Promise<void> => {
    if (consuming) return;
    consuming = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift()!;
        inFlight = true;
        try {
          await consume(next);
        } catch (error) {
          options.onFailure(error);
        } finally {
          inFlight = false;
        }
      }
    } finally {
      consuming = false;
      if (queue.length > 0) void drain();
    }
  };

  return {
    enqueue(value) {
      if (queue.length + (inFlight ? 1 : 0) >= maxPending) {
        options.onFailure(new Error(`${options.label} callback backlog exceeded ${maxPending}`));
        return;
      }
      queue.push(value);
      void drain();
    },
    pending() {
      return queue.length + (inFlight ? 1 : 0);
    },
  };
}

export interface SerialQueueOptions {
  label: string;
}

export interface SerialQueue {
  /** Enqueue work and await its result. Prior items settle before this one runs. */
  enqueueAndWait<T>(fn: () => Promise<T>): Promise<T>;
  pending(): number;
}

/**
 * Process-local serial queue for ordered durable writes that must return a
 * result to the caller. Failures reject the waiting promise and do not stall
 * later items.
 *
 * Prefer this over a hand-rolled `let writeQueue = Promise.resolve()` chain.
 * Do not use this for best-effort telemetry — use `createSerialAsyncDelivery`
 * via `server/telemetry-write.ts` instead.
 */
export function createSerialQueue(_options: SerialQueueOptions): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  let pendingCount = 0;

  return {
    enqueueAndWait<T>(fn: () => Promise<T>): Promise<T> {
      pendingCount += 1;
      const result = tail.then(fn, fn);
      tail = result.then(
        () => {
          pendingCount -= 1;
        },
        () => {
          pendingCount -= 1;
        },
      );
      return result;
    },
    pending() {
      return pendingCount;
    },
  };
}
