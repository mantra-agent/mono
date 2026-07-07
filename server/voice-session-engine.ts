// Use createLogger for logging ONLY
import { stringify, parse } from "yaml";
import { createLogger } from "./log";
import { documentStorage } from "./memory/document-storage";

const log = createLogger("VoiceSessionEngine");

export interface ToolCallRecord {
  name: string;
  parameters: Record<string, unknown>;
  result: string;
  timestamp: string;
  durationMs?: number;
}

export interface TranscriptEntry {
  source: "user" | "ai" | "system" | "tool";
  message: string;
  timestamp: string;
  toolCall?: ToolCallRecord;
}

export interface VoiceSessionMetadata {
  durationMs?: number;
  connectLatencyMs?: number;
  firstDeltaMs?: number;
  model?: string;
  profile?: string;
  voiceId?: string;
  endedBy?: "agent" | "user" | "error";
}

export interface VoiceSessionAgenda {
  topics: Array<{ title: string; reason: string }>;
  opening: string;
  tone: string;
  approach: string;
}

export interface VoiceSession {
  id: string;
  templateName: string;
  date: string;
  createdAt: string;
  transcript: TranscriptEntry[];
  toolCalls: ToolCallRecord[];
  metadata: VoiceSessionMetadata;
  systemPrompt: string;
  firstMessage: string;
  toolDefinitions: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  structuredResults?: Record<string, unknown>;
  summary?: string;
  agenda?: VoiceSessionAgenda;
}

function generateSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `vs_${ts}_${rand}`;
}

function sessionToMarkdown(session: VoiceSession): string {
  const fm: Record<string, unknown> = {
    id: session.id,
    templateName: session.templateName,
    date: session.date,
    createdAt: session.createdAt,
    metadata: session.metadata,
    toolDefinitions: session.toolDefinitions,
  };

  if (session.structuredResults && Object.keys(session.structuredResults).length > 0) {
    fm.structuredResults = session.structuredResults;
  }

  if (session.agenda) {
    fm.agenda = session.agenda;
  }

  let body = "";

  body += "## System Prompt\n\n" + session.systemPrompt + "\n\n";
  body += "## First Message\n\n" + session.firstMessage + "\n\n";

  if (session.summary) {
    body += "## Summary\n\n" + session.summary + "\n\n";
  }

  if (session.transcript.length > 0) {
    body += "## Transcript\n\n";
    for (const entry of session.transcript) {
      const ts = entry.timestamp ? ` (${entry.timestamp})` : "";
      if (entry.source === "tool" && entry.toolCall) {
        body += `**[tool:${entry.toolCall.name}]**${ts}: ${entry.message}\n`;
        if (entry.toolCall.durationMs !== undefined) {
          body += `_Duration: ${entry.toolCall.durationMs}ms_\n`;
        }
        body += `\`\`\`json\n${JSON.stringify({ params: entry.toolCall.parameters, result: entry.toolCall.result }, null, 2)}\n\`\`\`\n\n`;
      } else {
        body += `**${entry.source}**${ts}: ${entry.message}\n\n`;
      }
    }
  }

  if (session.toolCalls.length > 0) {
    body += "## Tool Calls\n\n";
    for (const tc of session.toolCalls) {
      const dur = tc.durationMs !== undefined ? ` (${tc.durationMs}ms)` : "";
      body += `- **${tc.name}**${dur} at ${tc.timestamp}\n`;
      body += `  - Params: \`${JSON.stringify(tc.parameters)}\`\n`;
      body += `  - Result: ${tc.result}\n`;
    }
    body += "\n";
  }

  return `---\n${stringify(fm).trim()}\n---\n\n${body.trim()}\n`;
}


function parseVoiceSession(content: string): VoiceSession | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;

  let fm: Record<string, unknown>;
  try {
    fm = parse(fmMatch[1]) as Record<string, unknown>;
  } catch (err: unknown) {
    log.error(`parseVoiceSession YAML parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const body = fmMatch[2].trim();

  let systemPrompt = "";
  const spMatch = body.match(/## System Prompt\n\n([\s\S]*?)(?=\n## )/);
  if (spMatch) systemPrompt = spMatch[1].trim();

  let firstMessage = "";
  const fmMsgMatch = body.match(/## First Message\n\n([\s\S]*?)(?=\n## )/);
  if (fmMsgMatch) firstMessage = fmMsgMatch[1].trim();

  let summary: string | undefined;
  const sumMatch = body.match(/## Summary\n\n([\s\S]*?)(?=\n## )/);
  if (sumMatch) summary = sumMatch[1].trim();

  const transcript: TranscriptEntry[] = [];
  const trMatch = body.match(/## Transcript\n\n([\s\S]*?)(?=\n## Tool Calls|\n$|$)/);
  if (trMatch) {
    const blocks = trMatch[1].trim().split(/\n\n/);
    for (const block of blocks) {
      const toolMatch = block.match(/^\*\*\[tool:(\w+)\]\*\*(?:\s*\(([^)]*)\))?:\s*([\s\S]*)/m);
      if (toolMatch) {
        const entry: TranscriptEntry = {
          source: "tool",
          message: toolMatch[3].split("\n")[0].trim(),
          timestamp: toolMatch[2] || "",
        };
        transcript.push(entry);
        continue;
      }

      const msgMatch = block.match(/^\*\*(\w+)\*\*(?:\s*\(([^)]*)\))?:\s*([\s\S]*)$/);
      if (msgMatch) {
        transcript.push({
          source: msgMatch[1] as "user" | "ai" | "system",
          message: msgMatch[3].trim(),
          timestamp: msgMatch[2] || "",
        });
      }
    }
  }

  const toolCalls: ToolCallRecord[] = [];
  const tcMatch = body.match(/## Tool Calls\n\n([\s\S]*)$/);
  if (tcMatch) {
    const tcLines = tcMatch[1].trim().split("\n");
    let current: Partial<ToolCallRecord> | null = null;
    for (const line of tcLines) {
      const nameMatch = line.match(/^- \*\*(\w+)\*\*(?:\s*\((\d+)ms\))?\s+at\s+(.*)/);
      if (nameMatch) {
        if (current && current.name) toolCalls.push(current as ToolCallRecord);
        current = {
          name: nameMatch[1],
          durationMs: nameMatch[2] ? parseInt(nameMatch[2]) : undefined,
          timestamp: nameMatch[3],
          parameters: {},
          result: "",
        };
        continue;
      }
      if (current) {
        const paramMatch = line.match(/^\s+- Params:\s*`(.*)`/);
        if (paramMatch) {
          try { current.parameters = JSON.parse(paramMatch[1]); } catch (err) { log.debug("tool param parse failed", err); }
        }
        const resultMatch = line.match(/^\s+- Result:\s*(.*)/);
        if (resultMatch) {
          current.result = resultMatch[1];
        }
      }
    }
    if (current && current.name) toolCalls.push(current as ToolCallRecord);
  }

  return {
    id: fm.id as string,
    templateName: (fm.templateName as string) || "unknown",
    date: fm.date as string,
    createdAt: (fm.createdAt as string) || (fm.date as string),
    transcript,
    toolCalls,
    metadata: (fm.metadata as VoiceSessionMetadata) || {},
    systemPrompt,
    firstMessage,
    toolDefinitions: (fm.toolDefinitions as Array<{ name: string; description: string; parameters: Record<string, unknown> }>) || [],
    structuredResults: fm.structuredResults as Record<string, unknown> | undefined,
    summary,
    agenda: (fm.agenda as VoiceSessionAgenda) || undefined,
  };
}

export class VoiceSessionEngine {
  async saveSession(session: VoiceSession): Promise<VoiceSession> {
    if (!session.id) session.id = generateSessionId();
    if (!session.createdAt) session.createdAt = new Date().toISOString();
    const markdown = sessionToMarkdown(session);
    log.debug(`saveSession id=${session.id} template=${session.templateName} date=${session.date} transcriptEntries=${session.transcript.length} toolCalls=${session.toolCalls.length}`);
    try {
      await documentStorage.upsertDocument(
        "voice_session",
        session.id,
        `voice/${session.date}_${session.templateName}_${session.id}`,
        `Voice Session ${session.id}`,
        markdown,
        {
          templateName: session.templateName,
          date: session.date,
          createdAt: session.createdAt,
          transcriptCount: session.transcript.length,
          toolCallCount: session.toolCalls.length,
          summary: session.summary || "",
        }
      );
      log.debug(`saveSession written id=${session.id}`);
    } catch (err: unknown) {
      log.error(`saveSession write failed id=${session.id} error=${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    return session;
  }

  async getSessions(limit = 50): Promise<VoiceSession[]> {
    log.debug(`getSessions limit=${limit}`);
    const docs = await documentStorage.getDocumentsByType("voice_session");
    const sessions: VoiceSession[] = [];

    for (const doc of docs) {
      try {
        const session = parseVoiceSession(doc.content);
        if (session) sessions.push(session);
      } catch (err: unknown) {
        log.error(`getSessions parse failed docId=${doc.docId} error=${err instanceof Error ? err.message : String(err)}`);
      }
    }

    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    log.debug(`getSessions returning=${Math.min(sessions.length, limit)} of ${sessions.length} parsed`);
    return sessions.slice(0, limit);
  }

  async getSession(id: string): Promise<VoiceSession | undefined> {
    log.debug(`getSession id=${id}`);
    const doc = await documentStorage.getDocument("voice_session", id);
    if (doc) {
      const session = parseVoiceSession(doc.content);
      if (session) {
        log.debug(`getSession found id=${id}`);
        return session;
      }
    }

    const allDocs = await documentStorage.getDocumentsByType("voice_session");
    for (const d of allDocs) {
      const session = parseVoiceSession(d.content);
      if (session && session.id === id) {
        log.debug(`getSession found (full scan) id=${id}`);
        return session;
      }
    }

    log.debug(`getSession not-found id=${id}`);
    return undefined;
  }

  async createSessionFromCheckIn(
    templateName: string,
    transcript: Array<{ source: string; message: string; timestamp?: string }>,
    toolCalls: ToolCallRecord[],
    config: { systemPrompt: string; firstMessage: string; tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> },
    metadata?: Partial<VoiceSessionMetadata>,
    structuredResults?: Record<string, unknown>,
    summary?: string,
  ): Promise<VoiceSession> {
    log.debug(`createSessionFromCheckIn template=${templateName} transcriptEntries=${transcript.length} toolCalls=${toolCalls.length}`);
    const now = new Date();
    const session: VoiceSession = {
      id: generateSessionId(),
      templateName,
      date: now.toISOString().split("T")[0],
      createdAt: now.toISOString(),
      transcript: transcript.map(t => ({
        source: t.source as TranscriptEntry["source"],
        message: t.message,
        timestamp: t.timestamp || now.toISOString(),
      })),
      toolCalls,
      metadata: metadata || {},
      systemPrompt: config.systemPrompt,
      firstMessage: config.firstMessage,
      toolDefinitions: config.tools,
      structuredResults,
      summary,
    };

    log.debug(`createSessionFromCheckIn saving id=${session.id}`);
    return this.saveSession(session);
  }

}


export const voiceSessionEngine = new VoiceSessionEngine();
