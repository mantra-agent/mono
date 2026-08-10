import { resolvePersonId } from "../shared/person";
import { withPeopleSummaryStatus } from "../shared/people";
import type { Interaction } from "../../people-storage";
import type { ToolHandlerResult } from "../contracts";

/**
 * People notes and interactions handlers extracted from bridge-tools.ts:
 * note add/update/delete plus interaction log/get/update/delete. Behavior,
 * result shapes, and error handling are preserved verbatim; person resolution
 * stays on the shared resolvePersonId boundary and the empty-summary quality
 * warning stays on the shared withPeopleSummaryStatus helper. Public identity
 * (tool-registry), ownership/composition (domain-adapters), and the executeTool
 * invocation/authority boundary remain owned by their canonical modules. Core
 * mutations (merge/update/create/set_daily_contact) and imports remain in
 * bridge-tools until their own extraction slices.
 */

async function handlePeopleAddNote(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found or ambiguous match — use a more specific name or provide an id.", error: true };
  const content = args.content;
  if (!content) return { result: "Missing note content", error: true };
  const title = args.title?.trim();
  if (!title) return { result: "Missing required field: title. Every note needs a descriptive title.", error: true };
  let action = "add_note";
  if (title) {
    const person = await peopleStorage.getPerson(resolved.id);
    const existing = person?.notes.find((n: { id: string; title: string }) => n.title.trim().toLowerCase() === title.toLowerCase());
    if (existing) {
      await peopleStorage.updateNote(resolved.id, existing.id, content, title);
      action = "update_note";
    } else {
      await peopleStorage.addNote(resolved.id, content, title);
    }
  }
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action, personId: resolved.id, personName: resolved.name },
  });
  const updatedPerson = await peopleStorage.getPerson(resolved.id);
  const result = action === "update_note"
    ? `Note "${title}" updated for ${resolved.name} [person:${resolved.id}]`
    : `Note added to ${resolved.name} [person:${resolved.id}]`;
  return withPeopleSummaryStatus(result, updatedPerson?.quickSummary, true);
}

async function handlePeopleUpdateNote(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const noteId = args.noteId;
  if (!noteId) return { result: "Missing noteId", error: true };
  const content = args.content;
  if (!content) return { result: "Missing note content", error: true };
  const title = args.title;
  await peopleStorage.updateNote(resolved.id, noteId, content, title);
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "update_note", personId: resolved.id, personName: resolved.name },
  });
  return { result: `Note ${noteId} updated for ${resolved.name} [person:${resolved.id}]` };
}

async function handlePeopleDeleteNote(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const noteId = args.noteId;
  if (!noteId) return { result: "Missing noteId", error: true };
  await peopleStorage.deleteNote(resolved.id, noteId);
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "delete_note", personId: resolved.id, personName: resolved.name },
  });
  return { result: `Note ${noteId} deleted from ${resolved.name} [person:${resolved.id}]` };
}

async function handlePeopleLogInteraction(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const summary = args.summary;
  if (!summary) return { result: "Missing interaction summary", error: true };
  const interaction: Omit<Interaction, "id"> = {
    date: args.date || (await import("../../timezone")).getDateInTimezone(),
    type: args.type || "note",
    summary,
    direction: args.direction || undefined,
    meaningfulness: args.meaningfulness || undefined,
    responseOwed: args.responseOwed !== undefined ? args.responseOwed : undefined,
    responseDueBy: args.responseDueBy || undefined,
    capitalImpact: args.capitalImpact || undefined,
    context: args.context || undefined,
    tags: args.tags || undefined,
  };
  await peopleStorage.addInteraction(resolved.id, interaction);
  const { eventBus: eb } = await import("../../event-bus");
  eb.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "log_interaction", personId: resolved.id, personName: resolved.name },
  });
  return { result: `Interaction logged for ${resolved.name} [person:${resolved.id}]: ${summary}` };
}

async function handlePeopleGetInteractions(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: `Person ${resolved.id} not found`, error: true };
  if (person.interactions.length === 0) return { result: `No interactions recorded for ${resolved.name} [person:${resolved.id}].` };
  const sorted = [...person.interactions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const limit = Math.min(args.limit || 10, 50);
  const offset = args.offset || 0;
  const page = sorted.slice(offset, offset + limit);
  const pageIds = new Set(page.map(i => i.id));
  // Always surface responseOwed interactions even if they're outside the current page
  const extraOwed = sorted.filter(i => i.responseOwed && !pageIds.has(i.id));
  const formatLine = (i: any) => {
    const flags = i.responseOwed ? ' ⚑response-owed' : '';
    return `- [id:${i.id}] [${i.date}] ${i.type}${flags}: ${i.summary}`;
  };
  const lines = page.map(formatLine);
  const total = person.interactions.length;
  const hasMore = offset + limit < total;
  const header = `${total} total interactions for ${resolved.name} [person:${resolved.id}] (showing ${offset + 1}–${Math.min(offset + limit, total)} of ${total})`;
  const parts = [`${header}:\n${lines.join("\n")}`];
  if (extraOwed.length > 0) {
    parts.push(`\n⚠️ ${extraOwed.length} interaction(s) with response owed outside this page:\n${extraOwed.map(formatLine).join("\n")}`);
  }
  if (hasMore) {
    parts.push(`\n→ ${total - offset - limit} more interactions. Use offset=${offset + limit} to see next page.`);
  }
  return { result: parts.join("") };
}

async function handlePeopleUpdateInteraction(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const interactionId = args.interactionId;
  if (!interactionId) return { result: "Missing interactionId", error: true };
  const updates: Record<string, any> = {};
  if (args.summary !== undefined) updates.summary = args.summary;
  if (args.context !== undefined) updates.context = args.context;
  if (args.type !== undefined) updates.type = args.type;
  if (args.responseOwed !== undefined) updates.responseOwed = args.responseOwed;
  if (args.responseDueBy !== undefined) updates.responseDueBy = args.responseDueBy;
  if (Object.keys(updates).length === 0) return { result: "No update fields provided (summary, context, type, responseOwed, responseDueBy)", error: true };
  await peopleStorage.updateInteraction(resolved.id, interactionId, updates);
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "update_interaction", personId: resolved.id, personName: resolved.name },
  });
  return { result: `Interaction ${interactionId} updated for ${resolved.name} [person:${resolved.id}]` };
}

async function handlePeopleDeleteInteraction(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const interactionId = args.interactionId;
  if (!interactionId) return { result: "Missing interactionId", error: true };
  await peopleStorage.deleteInteraction(resolved.id, interactionId);
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "delete_interaction", personId: resolved.id, personName: resolved.name },
  });
  return { result: `Interaction ${interactionId} deleted from ${resolved.name} [person:${resolved.id}]` };
}

/** action → handler map for the people notes + interactions surface. */
export const peopleInteractionHandlers: Record<string, (args: Record<string, any>) => Promise<ToolHandlerResult>> = {
  add_note: handlePeopleAddNote,
  update_note: handlePeopleUpdateNote,
  delete_note: handlePeopleDeleteNote,
  log_interaction: handlePeopleLogInteraction,
  get_interactions: handlePeopleGetInteractions,
  update_interaction: handlePeopleUpdateInteraction,
  delete_interaction: handlePeopleDeleteInteraction,
};
