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
