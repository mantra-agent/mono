import type { SessionAgenda, SessionAgendaItem } from "@shared/models/chat";

/**
 * Discussion-message grammar for an individual item from a live session's
 * runtime agenda (SessionAgendaTree). The definition-level Agendas tree
 * (/agendas) no longer dumps its agenda as prose — it instantiates the agenda
 * into structured session state via the session-agenda route instead.
 */

function sessionAgendaItemLine(item: SessionAgendaItem): string {
  return [
    `- ${item.title}`,
    `  - ID: ${item.id}`,
    `  - Description: ${item.description}`,
    `  - Status: ${item.status}`,
    `  - Resolution: ${item.resolution ?? "None"}`,
  ].join("\n");
}

export interface SessionAgendaDiscussionSource {
  sessionId: string;
  sessionTitle?: string;
  parentSessionId?: string;
  parentSessionTitle?: string;
  agenda: SessionAgenda;
  item: SessionAgendaItem;
}

/** Discuss a single item from a live session's runtime agenda. */
export function buildSessionAgendaDiscussionMessage({
  sessionId,
  sessionTitle,
  parentSessionId,
  parentSessionTitle,
  agenda,
  item,
}: SessionAgendaDiscussionSource): string {
  const parts = [
    `Let's discuss this agenda item: **${item.title}**`,
    "",
    "Source conversation:",
    `- Session ID: ${sessionId}`,
  ];
  if (sessionTitle) parts.push(`- Title: ${sessionTitle}`);
  if (parentSessionId) {
    parts.push(`- Parent session ID: ${parentSessionId}`);
    if (parentSessionTitle) parts.push(`- Parent title: ${parentSessionTitle}`);
  }
  parts.push(
    "",
    "Selected agenda item:",
    sessionAgendaItemLine(item),
    "",
    "Full agenda:",
    agenda.items.map(sessionAgendaItemLine).join("\n"),
  );
  return parts.join("\n");
}
