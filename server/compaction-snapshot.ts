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

export interface CompactionSnapshotOptions {
  expectedRemovedMessageIds?: readonly string[];
  retentionTokenBudget?: number;
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

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 3.5) : 0;
}

export function estimateCompactionMessageTokens(message: FileMessage): number {
  let tokens = estimateTokens(message.content);
  if (message.thinking) tokens += estimateTokens(message.thinking);
  if (Array.isArray(message.toolCalls)) {
    for (const toolCall of message.toolCalls as Array<Record<string, unknown>>) {
      const result = toolCall?.result ?? toolCall?.output;
      if (typeof result === "string") tokens += estimateTokens(result);
      else if (result != null) tokens += estimateTokens(JSON.stringify(result));
    }
  }
  return tokens;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function immutableCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function selectTokenAwareBoundary(
  messages: readonly FileMessage[],
  retentionTokenBudget: number,
): number | null {
  const contextIndices = messages.flatMap((message, index) =>
    isCommittedContextMessage(message) ? [index] : [],
  );
  if (contextIndices.length <= 1) return null;

  const newestUserIndex = contextIndices.reduce(
    (latest, index) => (messages[index].role === "user" ? index : latest),
    -1,
  );
  const mandatoryKeepIndex = newestUserIndex >= 0
    ? newestUserIndex
    : contextIndices[contextIndices.length - 1];

  let keptTokens = 0;
  let earliestKeptContextIndex = mandatoryKeepIndex;
  for (let position = contextIndices.length - 1; position >= 0; position -= 1) {
    const index = contextIndices[position];
    if (index < mandatoryKeepIndex) continue;
    keptTokens += estimateCompactionMessageTokens(messages[index]);
    earliestKeptContextIndex = Math.min(earliestKeptContextIndex, index);
  }

  for (let position = contextIndices.length - 1; position >= 0; position -= 1) {
    const index = contextIndices[position];
    if (index >= mandatoryKeepIndex) continue;
    const messageTokens = estimateCompactionMessageTokens(messages[index]);
    if (keptTokens + messageTokens > retentionTokenBudget) break;
    keptTokens += messageTokens;
    earliestKeptContextIndex = index;
  }

  return earliestKeptContextIndex > 0 ? earliestKeptContextIndex : null;
}

export function buildCompactionSnapshot(
  sessionId: string,
  sourceMessages: readonly FileMessage[],
  options: CompactionSnapshotOptions = {},
): CompactionSnapshot | null {
  const messages = immutableCopy(sourceMessages);
  let boundaryIndex: number;

  if (options.expectedRemovedMessageIds) {
    const expectedRemovedMessageIds = options.expectedRemovedMessageIds;
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
  } else if (typeof options.retentionTokenBudget === "number") {
    const selectedBoundary = selectTokenAwareBoundary(
      messages,
      Math.max(0, options.retentionTokenBudget),
    );
    if (selectedBoundary == null) return null;
    boundaryIndex = selectedBoundary;
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
