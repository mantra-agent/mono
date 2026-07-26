export const COMPACTION_ARCHIVE_FORMAT = "compaction.v1" as const;

export interface CompactionArchiveSourceMessage {
  role: string;
  content: string;
  thinking?: string;
  toolCalls?: unknown[];
  publicRole?: "user" | "assistant";
  archiveRefId?: string;
  /** Full persisted message record, when the archive is built from doc-store entries. Additive: parsers tolerate its absence. */
  record?: unknown;
}

interface CompactionArchiveMessageEntry {
  kind: "message";
  role: string;
  content: string;
  thinking?: string;
  toolCalls?: unknown[];
  publicRole?: "user" | "assistant";
  record?: unknown;
}

interface CompactionArchiveReferenceEntry {
  kind: "archive";
  archiveRefId: string;
  record?: unknown;
}

type CompactionArchiveEntry =
  | CompactionArchiveMessageEntry
  | CompactionArchiveReferenceEntry;

interface CompactionArchiveV1 {
  format: typeof COMPACTION_ARCHIVE_FORMAT;
  sessionId: string;
  createdAt: string;
  entries: CompactionArchiveEntry[];
}

export interface PublicCompactionMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  thinking: string | null;
  toolCalls: unknown;
  systemSteps: unknown[] | null;
  model: string | null;
  createdAt: string;
  [key: string]: unknown;
}

const PUBLIC_RECORD_ROLES = new Set([
  "user",
  "assistant",
  "system_prompt",
  "child_session_block",
  "cross_session",
  "system_notice",
]);

const PUBLIC_RECORD_FIELDS = [
  "updatedAt",
  "cost",
  "apiCallCount",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "segmentChronology",
  "isError",
  "crossSession",
  "childSession",
  "pageContext",
  "assistantState",
  "assistantRunId",
  "voice",
  "persona",
  "speaker",
  "questionResponse",
  "questionCancellation",
  "artifactKey",
  "turnId",
  "visibility",
] as const;

export type CompactionArchiveLoader = (
  archiveRefId: string,
) => Promise<string | null>;

export class CompactionArchiveUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionArchiveUnavailableError";
  }
}

export function encodeCompactionArchive(
  sessionId: string,
  messages: CompactionArchiveSourceMessage[],
  createdAt = new Date().toISOString(),
): string {
  const entries: CompactionArchiveEntry[] = messages.map((message) => {
    if (message.archiveRefId) {
      return {
        kind: "archive",
        archiveRefId: message.archiveRefId,
        record: message.record,
      };
    }
    return {
      kind: "message",
      role: message.role,
      content: message.content,
      thinking: message.thinking,
      toolCalls: message.toolCalls,
      publicRole: message.publicRole,
      record: message.record,
    };
  });
  const archive: CompactionArchiveV1 = {
    format: COMPACTION_ARCHIVE_FORMAT,
    sessionId,
    createdAt,
    entries,
  };
  return JSON.stringify(archive);
}

function parseStructuredArchive(content: string): CompactionArchiveV1 | null {
  try {
    const parsed = JSON.parse(content) as Partial<CompactionArchiveV1>;
    if (
      parsed.format !== COMPACTION_ARCHIVE_FORMAT ||
      !Array.isArray(parsed.entries)
    ) {
      return null;
    }
    return parsed as CompactionArchiveV1;
  } catch {
    return null;
  }
}

function findNestedArchiveRef(content: string): string | null {
  return (
    content.match(/\[Full original messages archived\s+—\s+ref:([^\s\]]+)/i)?.[1] ||
    null
  );
}

function parseLegacyArchive(content: string): CompactionArchiveEntry[] {
  if (/^\[(?:thinking|tool:[^\]]+)\]:/m.test(content)) {
    throw new CompactionArchiveUnavailableError(
      "Legacy compaction archive contains ambiguous internal sections",
    );
  }
  const rolePattern = /^\[(user|assistant|system|tool)\]:\s?/gm;
  const matches = Array.from(content.matchAll(rolePattern));
  return matches.map((match, index) => {
    const role = match[1];
    const start = (match.index || 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const rawBody = content.slice(start, end).trim();
    const internalMarker = rawBody.search(/\n\[(?:thinking|tool:[^\]]+)\]:/);
    const visibleContent = (
      internalMarker >= 0 ? rawBody.slice(0, internalMarker) : rawBody
    ).trim();
    const nestedRef = role === "system" ? findNestedArchiveRef(visibleContent) : null;
    if (nestedRef) {
      return { kind: "archive", archiveRefId: nestedRef };
    }
    return {
      kind: "message",
      role,
      content: visibleContent,
      publicRole:
        role === "user" || role === "assistant" ? role : undefined,
    };
  });
}

function archiveEntries(content: string): CompactionArchiveEntry[] {
  return parseStructuredArchive(content)?.entries ?? parseLegacyArchive(content);
}

function projectArchivedMessage(
  entry: CompactionArchiveMessageEntry,
  archiveSessionId: string,
  archiveCreatedAt: string,
  ordinal: number,
): PublicCompactionMessage | null {
  const record = entry.record && typeof entry.record === "object"
    ? entry.record as Record<string, unknown>
    : null;
  const role = typeof record?.role === "string" ? record.role : entry.publicRole;
  if (!role || !PUBLIC_RECORD_ROLES.has(role)) return null;

  const content = typeof record?.content === "string" ? record.content : entry.content;
  const projected: PublicCompactionMessage = {
    id: typeof record?.id === "string"
      ? record.id
      : `archive-${archiveSessionId}-${archiveCreatedAt}-${ordinal}`,
    sessionId: typeof record?.sessionId === "string" ? record.sessionId : archiveSessionId,
    role,
    content,
    thinking: typeof record?.thinking === "string"
      ? record.thinking
      : typeof entry.thinking === "string"
        ? entry.thinking
        : null,
    toolCalls: record?.toolCalls ?? entry.toolCalls ?? null,
    systemSteps: Array.isArray(record?.systemSteps) ? record.systemSteps : null,
    model: typeof record?.model === "string" ? record.model : null,
    createdAt: typeof record?.createdAt === "string" ? record.createdAt : archiveCreatedAt,
  };

  for (const field of PUBLIC_RECORD_FIELDS) {
    if (record?.[field] !== undefined) projected[field] = record[field];
  }
  return projected;
}

async function expandArchiveMessages(
  archiveRefId: string,
  loadArchive: CompactionArchiveLoader,
  visited: Set<string>,
  depth: number,
): Promise<PublicCompactionMessage[]> {
  if (depth > 32 || visited.has(archiveRefId)) {
    throw new CompactionArchiveUnavailableError("Compaction archive chain is invalid");
  }
  visited.add(archiveRefId);
  const content = await loadArchive(archiveRefId);
  if (!content) {
    throw new CompactionArchiveUnavailableError(
      `Compaction archive ${archiveRefId} is unavailable`,
    );
  }

  const structured = parseStructuredArchive(content);
  const archiveSessionId = structured?.sessionId || "archived-session";
  const archiveCreatedAt = structured?.createdAt || new Date(0).toISOString();
  const messages: PublicCompactionMessage[] = [];
  for (const [ordinal, entry] of archiveEntries(content).entries()) {
    if (entry.kind === "archive") {
      messages.push(
        ...(await expandArchiveMessages(
          entry.archiveRefId,
          loadArchive,
          visited,
          depth + 1,
        )),
      );
      continue;
    }
    const message = projectArchivedMessage(
      entry,
      archiveSessionId,
      archiveCreatedAt,
      ordinal,
    );
    if (message) messages.push(message);
  }
  return messages;
}

export async function loadPublicCompactionMessages(
  archiveRefId: string,
  loadArchive: CompactionArchiveLoader,
): Promise<PublicCompactionMessage[]> {
  const messages = await expandArchiveMessages(
    archiveRefId,
    loadArchive,
    new Set<string>(),
    0,
  );
  if (messages.length === 0) {
    throw new CompactionArchiveUnavailableError(
      "Compaction archive contains no user-visible conversation",
    );
  }
  return messages;
}

export async function renderCompactionTranscript(
  archiveRefId: string,
  loadArchive: CompactionArchiveLoader,
): Promise<string> {
  const messages = await loadPublicCompactionMessages(archiveRefId, loadArchive);
  return messages
    .map((message) => {
      const label = message.role === "user"
        ? "User"
        : message.role === "assistant"
          ? "Agent"
          : "Conversation event";
      return `## ${label}\n\n${message.content}`;
    })
    .join("\n\n");
}
