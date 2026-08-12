import type { ChatCompletionStreamOptions, StreamMessage } from "./model-client";

const CONTINUATION_INSTRUCTION = "Continue the same response from the exact cutoff. Do not repeat text already written; preserve the original objective, format, and tool intent.";

function longestSafeOverlap(existing: string, continuation: string): number {
  const suffix = existing.slice(-2000);
  const prefix = continuation.slice(0, 2000);
  const limit = Math.min(suffix.length, prefix.length);
  for (let length = limit; length >= 1; length--) {
    if (suffix.slice(-length) === prefix.slice(0, length)) return length;
  }
  return 0;
}

export function normalizeContinuationDelta(existing: string, delta: string): string {
  const overlap = longestSafeOverlap(existing, delta);
  return delta.slice(overlap);
}

export function buildContinuationMessages(
  messages: ChatCompletionStreamOptions["messages"],
  partialText: string,
): ChatCompletionStreamOptions["messages"] {
  const bounded = partialText.slice(-120_000);
  const continuation: StreamMessage[] = [
    ...messages,
    { role: "assistant", content: bounded },
    { role: "user", content: CONTINUATION_INSTRUCTION },
  ];
  return continuation;
}
