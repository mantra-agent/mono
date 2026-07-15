export type VoiceTranscriptStatus = "provisional" | "committed" | "placeholder";

export interface VoiceTranscriptEntry {
  source: "user" | "ai" | "system";
  message: string;
  timestamp: string;
  transcriptId?: string;
  turnId?: string;
  turnKey?: string;
  sequence?: number;
  status: VoiceTranscriptStatus;
  isError?: boolean;
  isTentative?: boolean;
  isToolCall?: boolean;
  persona?: { id: number; name: string; icon: string };
}

export interface VoiceUserTranscriptInput {
  message: string;
  turnId: string;
  turnKey?: string;
  sequence?: number;
  status: VoiceTranscriptStatus;
  transcriptId?: string;
  timestamp: string;
}

export type VoiceTranscriptMutationReason =
  | "empty"
  | "stale_sequence"
  | "committed_authority"
  | "duplicate_status"
  | "shorter_provisional"
  | "updated"
  | "placeholder_replaced"
  | "committed_duplicate"
  | "appended";

export interface VoiceTranscriptMutation {
  transcript: VoiceTranscriptEntry[];
  reason: VoiceTranscriptMutationReason;
  turnId?: string;
  messageLength: number;
}

export function cleanVoiceTranscriptText(value: string): string {
  return (value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTranscript(value: string): string {
  return cleanVoiceTranscriptText(value).replace(/\s+/g, " ").toLowerCase();
}

function sameTranscriptText(entry: VoiceTranscriptEntry, normalizedMessage: string): boolean {
  const prior = normalizeTranscript(entry.message || "");
  return prior === normalizedMessage || prior.startsWith(normalizedMessage) || normalizedMessage.startsWith(prior);
}

export function reduceVoiceUserTranscript(
  previous: VoiceTranscriptEntry[],
  input: VoiceUserTranscriptInput,
): VoiceTranscriptMutation {
  const message = cleanVoiceTranscriptText(input.message);
  if (!message) return { transcript: previous, reason: "empty", messageLength: 0 };

  const normalizedMessage = normalizeTranscript(message);
  const turnId = input.turnId;
  const transcriptId = input.transcriptId || (input.turnKey ? `voice:user:${input.turnKey}` : `voice:user:${turnId}`);
  let existingIndex = previous.findIndex((entry) =>
    entry.source === "user" &&
    !entry.isToolCall &&
    ((input.turnKey && entry.turnKey === input.turnKey) ||
      (input.turnId && entry.turnId === input.turnId) ||
      entry.transcriptId === transcriptId),
  );
  if (existingIndex < 0) {
    existingIndex = previous.findLastIndex((entry) =>
      entry.source === "user" &&
      entry.status === "provisional" &&
      !entry.isToolCall &&
      sameTranscriptText(entry, normalizedMessage),
    );
  }

  if (existingIndex >= 0) {
    const existing = previous[existingIndex];
    const existingNormalized = normalizeTranscript(existing.message || "");
    if (existing.sequence !== undefined && input.sequence !== undefined && input.sequence < existing.sequence) {
      return { transcript: previous, reason: "stale_sequence", turnId, messageLength: message.length };
    }
    if (existing.status === "committed" && input.status !== "committed") {
      return { transcript: previous, reason: "committed_authority", turnId, messageLength: message.length };
    }
    if (existingNormalized === normalizedMessage && existing.status === input.status) {
      return { transcript: previous, reason: "duplicate_status", turnId, messageLength: message.length };
    }
    if (existingNormalized.length > normalizedMessage.length && existingNormalized.startsWith(normalizedMessage) && input.status === "provisional") {
      return { transcript: previous, reason: "shorter_provisional", turnId, messageLength: message.length };
    }
    const transcript = [...previous];
    transcript[existingIndex] = {
      ...existing,
      message,
      timestamp: input.timestamp,
      transcriptId,
      turnId,
      turnKey: input.turnKey ?? existing.turnKey,
      sequence: input.sequence ?? existing.sequence,
      status: input.status,
    };
    return { transcript, reason: "updated", turnId, messageLength: message.length };
  }

  const last = previous[previous.length - 1];
  if (last?.source === "user" && last.status === "placeholder") {
    const transcript = [...previous];
    transcript[previous.length - 1] = {
      source: "user",
      message,
      timestamp: input.timestamp,
      transcriptId,
      turnId,
      turnKey: input.turnKey,
      sequence: input.sequence,
      status: input.status,
    };
    return { transcript, reason: "placeholder_replaced", turnId, messageLength: message.length };
  }

  const committedDuplicate = [...previous].reverse().slice(0, 12).find((entry) =>
    entry.source === "user" && entry.status === "committed" && !entry.isToolCall && sameTranscriptText(entry, normalizedMessage),
  );
  if (committedDuplicate && input.status === "committed") {
    return { transcript: previous, reason: "committed_duplicate", turnId, messageLength: message.length };
  }

  return {
    transcript: [...previous, {
      source: "user",
      message,
      timestamp: input.timestamp,
      transcriptId,
      turnId,
      turnKey: input.turnKey,
      sequence: input.sequence,
      status: input.status,
    }],
    reason: "appended",
    turnId,
    messageLength: message.length,
  };
}
