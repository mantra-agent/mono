import type { AgendaDefinition } from "@shared/models/agendas";
import type { SessionAgenda, SessionAgendaItem } from "@shared/models/chat";

/**
 * Shared discussion-message grammar for both agenda surfaces:
 * the Session Window runtime agenda (SessionAgendaTree) and the canonical
 * Agendas definition tree (/agendas). Keeping both builders here prevents the
 * two surfaces from drifting into divergent prompt formats.
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

function definitionAgendaItemLine(item: AgendaDefinition["items"][number]): string {
  return [`- ${item.title}`, `  - Description: ${item.description}`].join("\n");
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

/** Discuss a reusable agenda definition from the canonical Agendas tree. */
export function buildAgendaDefinitionDiscussionMessage(agenda: AgendaDefinition): string {
  const parts = [`Let's discuss this agenda: **${agenda.name}**`];
  if (agenda.description) parts.push("", agenda.description);
  parts.push(
    "",
    "Full agenda:",
    agenda.items.length
      ? agenda.items.map(definitionAgendaItemLine).join("\n")
      : "- (no items yet)",
  );
  return parts.join("\n");
}
