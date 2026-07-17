export const COMPACTION_ARCHIVE_FORMAT = "compaction.v1" as const;

export interface CompactionArchiveSourceMessage {
  role: string;
  content: string;
  thinking?: string;
  toolCalls?: unknown[];
  publicRole?: "user" | "assistant";
  archiveRefId?: string;
}

interface CompactionArchiveMessageEntry {
  kind: "message";
  role: string;
  content: string;
  thinking?: string;
  toolCalls?: unknown[];
  publicRole?: "user" | "assistant";
}

interface CompactionArchiveReferenceEntry {
  kind: "archive";
  archiveRefId: string;
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

interface PublicTranscriptTurn {
  role: "user" | "assistant";
  content: string;
}

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
): string {
  const entries: CompactionArchiveEntry[] = messages.map((message) => {
    if (message.archiveRefId) {
      return { kind: "archive", archiveRefId: message.archiveRefId };
    }
    return {
      kind: "message",
      role: message.role,
      content: message.content,
      thinking: message.thinking,
      toolCalls: message.toolCalls,
      publicRole: message.publicRole,
    };
  });
  const archive: CompactionArchiveV1 = {
    format: COMPACTION_ARCHIVE_FORMAT,
    sessionId,
    createdAt: new Date().toISOString(),
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

async function expandArchive(
  archiveRefId: string,
  loadArchive: CompactionArchiveLoader,
  visited: Set<string>,
  depth: number,
): Promise<PublicTranscriptTurn[]> {
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

  const turns: PublicTranscriptTurn[] = [];
  for (const entry of archiveEntries(content)) {
    if (entry.kind === "archive") {
      turns.push(
        ...(await expandArchive(
          entry.archiveRefId,
          loadArchive,
          visited,
          depth + 1,
        )),
      );
      continue;
    }
    if (entry.publicRole && entry.content.trim()) {
      turns.push({ role: entry.publicRole, content: entry.content.trim() });
    }
  }
  return turns;
}

export async function renderCompactionTranscript(
  archiveRefId: string,
  loadArchive: CompactionArchiveLoader,
): Promise<string> {
  const turns = await expandArchive(
    archiveRefId,
    loadArchive,
    new Set<string>(),
    0,
  );
  if (turns.length === 0) {
    throw new CompactionArchiveUnavailableError(
      "Compaction archive contains no user-visible conversation",
    );
  }
  return turns
    .map((turn) => {
      const label = turn.role === "user" ? "User" : "Agent";
      return `## ${label}\n\n${turn.content}`;
    })
    .join("\n\n");
}
