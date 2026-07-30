import type { SerializedRecognitionSink, STTUtterance } from "./contracts";

const MAX_PENDING_UTTERANCES = 64;

/** One bounded serialized callback queue shared by every recognition adapter. */
export interface SerializedRecognitionSinkOptions {
  onProviderFailure?(error: Error): void;
  onConsumerFailure?(error: Error): void;
}

export function createSerializedRecognitionSink(
  consume: (utterance: STTUtterance) => void | Promise<void>,
  onTerminalError: (error: Error) => void,
  options: SerializedRecognitionSinkOptions = {},
): SerializedRecognitionSink {
  const queue: STTUtterance[] = [];
  let draining = false;
  let terminalError: Error | null = null;
  let settleResolve: (() => void) | null = null;

  const maybeSettle = (): void => {
    if (!draining && queue.length === 0) {
      settleResolve?.();
      settleResolve = null;
    }
  };

  const fail = (error: unknown, source: "provider" | "consumer"): void => {
    if (terminalError) return;
    terminalError = error instanceof Error ? error : new Error(String(error));
    queue.length = 0;
    onTerminalError(terminalError);
    if (source === "provider") options.onProviderFailure?.(terminalError);
    else options.onConsumerFailure?.(terminalError);
    maybeSettle();
  };

  const drain = async (): Promise<void> => {
    if (draining || terminalError) return;
    draining = true;
    try {
      while (queue.length > 0 && !terminalError) {
        await consume(queue.shift()!);
      }
    } catch (error) {
      fail(error, "consumer");
    } finally {
      draining = false;
      if (queue.length > 0 && !terminalError) void drain();
      else maybeSettle();
    }
  };

  return {
    onUtterance(utterance) {
      if (terminalError) return;
      if (queue.length >= MAX_PENDING_UTTERANCES) {
        fail(new Error(`Recognition consumer backlog exceeded ${MAX_PENDING_UTTERANCES}`), "consumer");
        return;
      }
      queue.push(utterance);
      void drain();
    },
    onError(error) {
      fail(error, "provider");
    },
    async settle() {
      if (!draining && queue.length === 0) return;
      await new Promise<void>((resolve) => {
        settleResolve = resolve;
      });
    },
  };
}
