import { createHash } from "crypto";
import type { FileMessage } from "./chat-file-storage";

export interface CompactionSnapshot {
  sessionId: string;
  snapshotHash: string;
  boundaryHash: string;
  lastRemovedMessageId: string;
  removedMessageIds: readonly string[];
  keptMessageIds: readonly string[];
  removedMessages: readonly FileMessage[];
  keptMessages: readonly FileMessage[];
}

export function isCommittedContextMessage(message: Pick<FileMessage, "role" | "model" | "assistantState">): boolean {
  if (message.role === "assistant" && message.assistantState === "streaming") {
    return false;
  }
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "system_prompt" ||
    (message.role === "system" && message.model === "compaction-marker")
  );
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function immutableCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildCompactionSnapshot(
  sessionId: string,
  sourceMessages: readonly FileMessage[],
  expectedRemovedMessageIds?: readonly string[],
): CompactionSnapshot | null {
  const messages = immutableCopy(sourceMessages);
  let boundaryIndex: number;

  if (expectedRemovedMessageIds) {
    if (expectedRemovedMessageIds.length === 0 || expectedRemovedMessageIds.length > messages.length) {
      return null;
    }
    for (let index = 0; index < expectedRemovedMessageIds.length; index += 1) {
      if (messages[index]?.id !== expectedRemovedMessageIds[index]) return null;
      if (
        messages[index].role === "assistant" &&
        messages[index].assistantState === "streaming"
      ) {
        return null;
      }
    }
    boundaryIndex = expectedRemovedMessageIds.length;
  } else {
    const contextIndices = messages.flatMap((message, index) =>
      isCommittedContextMessage(message) ? [index] : [],
    );
    const keepRecentContextMessages = 2;
    if (contextIndices.length <= keepRecentContextMessages) return null;
    boundaryIndex = contextIndices[contextIndices.length - keepRecentContextMessages];
  }

  const removedMessages = messages.slice(0, boundaryIndex);
  const keptMessages = messages.slice(boundaryIndex);
  if (removedMessages.length === 0) return null;
  if (
    removedMessages.some(
      (message) =>
        message.role === "assistant" && message.assistantState === "streaming",
    )
  ) {
    return null;
  }

  const removedMessageIds = removedMessages.map((message) => message.id);
  const keptMessageIds = keptMessages.map((message) => message.id);
  const lastRemovedMessageId = removedMessageIds[removedMessageIds.length - 1];
  const boundaryHash = hashJson({ removedMessageIds, lastRemovedMessageId });
  const snapshotHash = hashJson({ sessionId, removedMessages });

  return Object.freeze({
    sessionId,
    snapshotHash,
    boundaryHash,
    lastRemovedMessageId,
    removedMessageIds: Object.freeze(removedMessageIds),
    keptMessageIds: Object.freeze(keptMessageIds),
    removedMessages: Object.freeze(removedMessages),
    keptMessages: Object.freeze(keptMessages),
  });
}
