import { createLogger } from "../../log";
import { resolvePersonId } from "../shared/person";
import type { Person, PersonIndexEntry } from "../../people-storage";
import type { ToolHandlerResult } from "../contracts";

/**
 * People read/query/vault-membership/agenda handlers extracted from
 * bridge-tools.ts, together with the people field-projection and filter
 * helpers that only these read handlers use. Behavior, result shapes, and
 * error handling are preserved verbatim; person resolution stays on the shared
 * resolvePersonId boundary, and public identity (tool-registry),
 * ownership/composition (domain-adapters), and the executeTool
 * invocation/authority boundary remain owned by their canonical modules. The
 * mutation, interaction, relationship, and import handlers remain in
 * bridge-tools until their own extraction slice.
 */

const toolExec = createLogger("ToolExec");

const PEOPLE_AGENDA_SURFACE_LIMIT = 3;

function clampPeopleLimit(value: unknown, fallback = 100, max = 500): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function clampPeopleOffset(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

type PeopleField = "id" | "name" | "email" | "company" | "role" | "relation" | "professionalRelations" | "cabinetLevel" | "tags" | "introducedBy" | "familiarity" | "trust" | "met" | "lastInteractionDate" | "createdAt" | "updatedAt" | "slackUserId";
type PeopleOperator = "equals" | "empty" | "not_empty" | "contains" | "fuzzy" | "in";

const PEOPLE_QUERY_FIELDS = new Set<PeopleField>(["id", "name", "email", "company", "role", "relation", "professionalRelations", "cabinetLevel", "tags", "introducedBy", "familiarity", "trust", "met", "lastInteractionDate", "createdAt", "updatedAt", "slackUserId"]);
const PEOPLE_QUERY_OPERATORS = new Set<PeopleOperator>(["equals", "empty", "not_empty", "contains", "fuzzy", "in"]);

function normalizePeopleFields(fields: unknown): PeopleField[] {
  if (!Array.isArray(fields)) return ["id", "name", "email", "cabinetLevel", "company", "role", "relation", "tags", "lastInteractionDate"];
  const normalized = fields.filter((field): field is PeopleField => typeof field === "string" && PEOPLE_QUERY_FIELDS.has(field as PeopleField));
  return normalized.length > 0 ? normalized : ["id", "name", "cabinetLevel"];
}

function emailsForPerson(person: Person): string[] {
  return (person.contactInfo || []).filter(ci => ci.type === "email" && ci.value).map(ci => ci.value);
}

function slackUserIdForPerson(person: Person): string | undefined {
  const slack = person.socialProfiles?.slack;
  return typeof slack === "string" && slack.trim() ? slack.trim() : undefined;
}

function getPeopleFieldValue(person: Person, field: PeopleField): unknown {
  if (field === "email") return emailsForPerson(person);
  if (field === "slackUserId") return slackUserIdForPerson(person);
  if (field === "lastInteractionDate") {
    const sorted = [...(person.interactions || [])].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return sorted[0]?.date;
  }
  return (person as any)[field];
}

function valueIsEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0 || value.every(valueIsEmpty);
  return false;
}

function scalarMatches(value: unknown, matcher: (s: string) => boolean): boolean {
  if (Array.isArray(value)) return value.some(v => scalarMatches(v, matcher));
  if (value === undefined || value === null) return false;
  return matcher(String(value).toLowerCase());
}

function personMatchesFilter(person: Person, field: PeopleField, operator: PeopleOperator, rawValue: unknown): boolean {
  const value = getPeopleFieldValue(person, field);
  if (operator === "empty") return valueIsEmpty(value);
  if (operator === "not_empty") return !valueIsEmpty(value);

  const wantedValues = Array.isArray(rawValue) ? rawValue.map(v => String(v).toLowerCase().trim()).filter(Boolean) : [String(rawValue ?? "").toLowerCase().trim()].filter(Boolean);
  if (wantedValues.length === 0) return false;

  if (operator === "in") return scalarMatches(value, s => wantedValues.includes(s));
  if (operator === "equals") return scalarMatches(value, s => wantedValues.some(w => s === w));
  if (operator === "contains" || operator === "fuzzy") return scalarMatches(value, s => wantedValues.some(w => s.includes(w)));
  return false;
}

function projectPerson(person: Person, fields: PeopleField[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of fields) row[field] = getPeopleFieldValue(person, field);
  return row;
}

function formatPeopleRows(rows: Record<string, unknown>[], total: number, offset: number, limit: number): string {
  if (rows.length === 0) return `No matching people. total=${total}, offset=${offset}, limit=${limit}`;
  return JSON.stringify({ total, offset, limit, count: rows.length, nextOffset: offset + rows.length < total ? offset + rows.length : null, people: rows }, null, 2);
}

async function handlePeopleList(args: Record<string, any> = {}): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const people = await peopleStorage.listPeople();
  if (people.length === 0) return { result: "No people in the system yet." };
  const offset = clampPeopleOffset(args.offset);
  const limit = clampPeopleLimit(args.limit, 100, 500);
  const page = people.slice(offset, offset + limit);
  const fields = normalizePeopleFields(args.fields);
  if (args.format === "json" || Array.isArray(args.fields)) {
    const rows = page.map((p: PersonIndexEntry) => {
      const row: Record<string, unknown> = {};
      for (const field of fields) {
        if (field === "relation" || field === "professionalRelations" || field === "email" || field === "introducedBy" || field === "familiarity" || field === "trust" || field === "met" || field === "slackUserId") continue;
        row[field] = (p as any)[field];
      }
      return row;
    });
    return { result: formatPeopleRows(rows, people.length, offset, limit) };
  }
  const lines = page.map(p => `- ${p.name} [person:${p.id}] (${p.cabinetLevel})${p.lastInteractionDate ? ` — last contact ${p.lastInteractionDate}` : ""}`);
  return { result: `${people.length} people (showing ${page.length}, offset ${offset}, nextOffset ${offset + page.length < people.length ? offset + page.length : "none"}):\n${lines.join("\n")}` };
}

async function handlePeopleGet(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: `Person ${resolved.id} not found`, error: true };
  const nicknameStr = person.nicknames?.length ? ` ("${person.nicknames.join('", "')}")` : "";
  const parts = [`**${person.name}** [person:${person.id}]${nicknameStr} — ${person.cabinetLevel}`];
  const contactLines = (person.contactInfo || [])
    .filter(contact => contact.value)
    .map(contact => `  - ${contact.label || contact.type}: ${contact.value}`);
  const slackUserId = slackUserIdForPerson(person);
  if (slackUserId) contactLines.push(`  - Slack: ${slackUserId}`);
  const operationalLines = [
    person.company ? `Company: ${person.company}` : null,
    person.role ? `Role: ${person.role}` : null,
    person.relation ? `Relation: ${person.relation}` : null,
    person.introducedBy ? `Introduced by: ${person.introducedBy}` : null,
    person.familiarity ? `Familiarity: ${person.familiarity}` : null,
    person.trust ? `Trust: ${person.trust}` : null,
    person.met ? `Met: ${person.met}` : null,
  ].filter(Boolean);
  if (contactLines.length > 0) parts.push(`Contact:\n${contactLines.join("\n")}`);
  if (operationalLines.length > 0) parts.push(`Operational:\n${operationalLines.map(line => `  - ${line}`).join("\n")}`);
  if (person.notes.length > 0) parts.push(`Notes:\n${person.notes.map(n => `  - [id: ${n.id}]${n.title ? ` ${n.title} —` : ""} ${n.content}`).join("\n")}`);
  if (person.interactions.length > 0) {
    const recent = [...person.interactions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 10);
    parts.push(`Interactions (${person.interactions.length} total, showing ${recent.length} most recent):\n${recent.map(i => `  - [${i.date}] ${i.type}: ${i.summary}`).join("\n")}`);
  } else {
    parts.push("No interactions recorded.");
  }
  if (person.importantDates.length > 0) parts.push(`Important dates: ${person.importantDates.map(d => `${d.label}: ${d.date}`).join(", ")}`);
  if (person.tags.length > 0) parts.push(`Tags: ${person.tags.join(", ")}`);
  if (person.aiSummary) parts.push(`AI Summary: ${person.aiSummary}`);
  return { result: parts.join("\n") };
}

async function handlePeopleSearch(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const query = args.query;
  if (!query) return { result: "Missing search query", error: true };
  const results = await peopleStorage.searchPeople(query);
  if (results.length === 0) return { result: `No people matching "${query}"` };
  const offset = clampPeopleOffset(args.offset);
  const limit = clampPeopleLimit(args.limit, results.length, 500);
  const page = results.slice(offset, offset + limit);
  const lines = page.map(p => `- ${p.name} [person:${p.id}] (${p.cabinetLevel})${p.lastInteractionDate ? ` — last contact ${p.lastInteractionDate}` : ""}`);
  return { result: `Found ${results.length} people (showing ${page.length}, offset ${offset}, nextOffset ${offset + page.length < results.length ? offset + page.length : "none"}):\n${lines.join("\n")}` };
}

async function resolvePeopleVaultPerson(args: Record<string, any>): Promise<ToolHandlerResult | { id: string; name: string }> {
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  return resolved;
}

function normalizePeopleVaultIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string")) return null;
  return [...new Set(value.map(id => id.trim()).filter(Boolean))];
}

async function handlePeopleGetVaultMemberships(args: Record<string, any>): Promise<ToolHandlerResult> {
  const resolved = await resolvePeopleVaultPerson(args);
  if ("result" in resolved) return resolved;
  const { peopleStorage } = await import("../../people-storage");
  const vaults = await peopleStorage.listVaultMemberships(resolved.id);
  return {
    result: JSON.stringify({
      person: { id: resolved.id, name: resolved.name },
      vaults,
    }, null, 2),
  };
}

async function handlePeopleAddVaultMembership(args: Record<string, any>): Promise<ToolHandlerResult> {
  const resolved = await resolvePeopleVaultPerson(args);
  if ("result" in resolved) return resolved;
  const vaultId = typeof args.vaultId === "string" ? args.vaultId.trim() : "";
  if (!vaultId) return { result: "add_vault_membership requires vaultId", error: true };

  const { peopleStorage } = await import("../../people-storage");
  const mutation = await peopleStorage.addVaultMembership(resolved.id, vaultId);
  if (mutation.changed) {
    const { eventBus } = await import("../../event-bus");
    eventBus.publish({
      category: "agent",
      event: "data:people_changed",
      payload: { source: "people_tool", action: "add_vault_membership", personId: mutation.person.id },
    });
  }
  return {
    result: mutation.changed
      ? `Added Vault ${vaultId} to ${mutation.person.name} @person:${mutation.person.id}.`
      : `${mutation.person.name} @person:${mutation.person.id} already belongs to Vault ${vaultId}.`,
  };
}

async function handlePeopleRemoveVaultMembership(args: Record<string, any>): Promise<ToolHandlerResult> {
  const resolved = await resolvePeopleVaultPerson(args);
  if ("result" in resolved) return resolved;
  const vaultId = typeof args.vaultId === "string" ? args.vaultId.trim() : "";
  if (!vaultId) return { result: "remove_vault_membership requires vaultId", error: true };

  const { peopleStorage } = await import("../../people-storage");
  const mutation = await peopleStorage.removeVaultMembership(resolved.id, vaultId);
  if (mutation.changed) {
    const { eventBus } = await import("../../event-bus");
    eventBus.publish({
      category: "agent",
      event: "data:people_changed",
      payload: { source: "people_tool", action: "remove_vault_membership", personId: mutation.person.id },
    });
  }
  return {
    result: mutation.changed
      ? `Removed Vault ${vaultId} from ${mutation.person.name} @person:${mutation.person.id}.`
      : `${mutation.person.name} @person:${mutation.person.id} did not belong to Vault ${vaultId}.`,
  };
}

async function handlePeopleSetVaultMemberships(args: Record<string, any>): Promise<ToolHandlerResult> {
  const resolved = await resolvePeopleVaultPerson(args);
  if ("result" in resolved) return resolved;
  const vaultIds = normalizePeopleVaultIds(args.vaultIds);
  if (!vaultIds || vaultIds.length === 0) {
    return { result: "set_vault_memberships requires a non-empty vaultIds array. A Person must belong to at least one Vault.", error: true };
  }
  if (args.confirmReplace !== true) {
    return { result: "set_vault_memberships replaces the complete membership set and requires confirmReplace=true.", error: true };
  }

  const { peopleStorage } = await import("../../people-storage");
  const person = await peopleStorage.replaceVaultMemberships(resolved.id, vaultIds, { requireVisibleTargets: true });
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "set_vault_memberships", personId: person.id },
  });
  return { result: `Set ${person.vaultIds?.length || vaultIds.length} Vault membership${(person.vaultIds?.length || vaultIds.length) === 1 ? "" : "s"} for ${person.name} @person:${person.id}.` };
}

async function handlePeopleGetMany(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const ids = Array.isArray(args.ids) ? args.ids.map((id: unknown) => String(id)).filter(Boolean).slice(0, 100) : [];
  if (ids.length === 0) return { result: "Missing ids array for get_many", error: true };
  const people = await peopleStorage.getPeopleByIds(ids);
  const fields = normalizePeopleFields(args.fields);
  const rows = people.map(person => projectPerson(person, fields));
  return { result: formatPeopleRows(rows, rows.length, 0, ids.length) };
}

async function handlePeopleQuery(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const field = args.field as PeopleField;
  const operator = args.operator as PeopleOperator;
  if (!PEOPLE_QUERY_FIELDS.has(field)) return { result: `Invalid or missing field. Available: ${Array.from(PEOPLE_QUERY_FIELDS).join(", ")}`, error: true };
  if (!PEOPLE_QUERY_OPERATORS.has(operator)) return { result: `Invalid or missing operator. Available: ${Array.from(PEOPLE_QUERY_OPERATORS).join(", ")}`, error: true };

  const index = await peopleStorage.listPeople();
  const people = await peopleStorage.getPeopleByIds(index.map(p => p.id));
  const matched = people.filter(person => personMatchesFilter(person, field, operator, args.value));
  const offset = clampPeopleOffset(args.offset);
  const limit = clampPeopleLimit(args.limit, 100, 500);
  const fields = normalizePeopleFields(args.fields);
  const rows = matched.slice(offset, offset + limit).map(person => projectPerson(person, fields));
  return { result: formatPeopleRows(rows, matched.length, offset, limit) };
}

async function handlePeopleAgenda(): Promise<ToolHandlerResult> {
  const { peopleStorage, computeAgendaSignals } = await import("../../people-storage");
  const allPeople = await peopleStorage.listPeople();
  const cabinetConfig = await peopleStorage.getCabinetConfig();
  const cabinetWeights: Record<string, number> = {};
  for (const level of cabinetConfig.levels) {
    cabinetWeights[level.id] = Math.max(1, 7 - level.order);
  }
  const now = Date.now();

  let calendarAttendees: Set<string> | undefined;
  try {
    const { listAllEvents } = await import("../../google-calendar");
    const { getTzOffsetISO, getTzDateStr, getTimezone } = await import("../../timezone");
    const tz = getTimezone();
    const offset = getTzOffsetISO(tz);
    const todayStr = getTzDateStr(tz);
    const weekEnd = new Date(new Date(todayStr + "T12:00:00").getTime() + 7 * 86400000);
    const endStr = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, "0")}-${String(weekEnd.getDate()).padStart(2, "0")}`;
    const { events } = await listAllEvents({
      timeMin: `${todayStr}T00:00:00${offset}`,
      timeMax: `${endStr}T23:59:59${offset}`,
      maxResults: 100,
    });
    calendarAttendees = new Set<string>();
    for (const ev of events) {
      if (ev.attendees) {
        for (const a of ev.attendees) {
          if (a.displayName) calendarAttendees.add(a.displayName.toLowerCase());
          if (a.email) calendarAttendees.add(a.email.toLowerCase());
        }
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    toolExec.warn(`people agenda calendar attendee enrichment degraded: ${msg}`);
  }

  type ScoredLine = { line: string; score: number };
  const obligations: ScoredLine[] = [];
  const maintenanceLines: ScoredLine[] = [];

  for (const entry of allPeople) {
    if (entry.cabinetLevel === "self" || entry.cabinetLevel === "agent" || entry.cabinetLevel === "user") continue;
    const person = await peopleStorage.getPerson(entry.id);
    if (!person) continue;

    const item = computeAgendaSignals(person, cabinetWeights, now, calendarAttendees);
    if (!item) continue;

    const line = `- **${person.name}** [person:${person.id}] (${person.cabinetLevel}): ${item.reason} — ${item.suggestedAction}`;
    if (item.surfaceTier === "follow_up") {
      obligations.push({ line, score: item.surfaceRank });
    } else {
      maintenanceLines.push({ line, score: item.surfaceRank });
    }
  }

  obligations.sort((a, b) => b.score - a.score);
  maintenanceLines.sort((a, b) => b.score - a.score);

  const sections: string[] = [];
  if (obligations.length > 0) sections.push(`**Follow-ups:**\n${obligations.map(o => o.line).join("\n")}`);
  const maintenanceLimit = Math.max(0, PEOPLE_AGENDA_SURFACE_LIMIT - obligations.length);
  if (maintenanceLimit > 0 && maintenanceLines.length > 0) sections.push(`**Maintenance:**\n${maintenanceLines.slice(0, maintenanceLimit).map(m => m.line).join("\n")}`);
  if (sections.length === 0) return { result: "No outreach needed right now. All relationships on track." };
  return { result: sections.join("\n\n") };
}

/** action → handler map for the people read/query/vault/agenda surface. */
export const peopleReadHandlers: Record<string, (args: Record<string, any>) => Promise<ToolHandlerResult>> = {
  list: handlePeopleList,
  get: handlePeopleGet,
  get_many: handlePeopleGetMany,
  get_vault_memberships: handlePeopleGetVaultMemberships,
  add_vault_membership: handlePeopleAddVaultMembership,
  remove_vault_membership: handlePeopleRemoveVaultMembership,
  set_vault_memberships: handlePeopleSetVaultMemberships,
  query: handlePeopleQuery,
  search: handlePeopleSearch,
  agenda: handlePeopleAgenda,
};
