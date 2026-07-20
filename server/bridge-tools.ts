import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { join, resolve, relative, basename } from "path";
import type { SQL } from "drizzle-orm";
import { recordToolCallStart, recordToolCallEnd } from "./file-storage";
import { MIME_MAP, TEXT_ARTIFACT_MIME_MAP } from "./lib/mime";
import { getInstanceName } from "@shared/instance-config";
import { objectStorageService } from "./object_storage";
import { setObjectAclPolicy } from "./object_storage/objectAcl";
import { contextBuilder } from "./context-builder";
import {
  checkAccountPermission,
  checkPermissionAnyAccount,
  type GoogleAccountPermissions,
} from "./connected-accounts";
import { isSimilarText } from "./utils/text-similarity";
import { safeStringify } from "./utils/safe-stringify";
import { eventBus } from "./event-bus";
import type { Interaction, Mobilization, RelationshipProfile, NetworkProfile, ScoredAgendaItem, Person, PersonIndexEntry } from "./people-storage";
import { ACTIVITY_CHAT, ACTIVITY_FRAMING, type ActivityId } from "./job-profiles";
import { semanticTierSchema, type SemanticTier } from "@shared/model-connectors";
import { formatTaskForBridge } from "./lib/task-format";
import { WORKSPACE_DIR } from "./paths";
import { pathExists, resolveWorkspacePath } from "./fs-utils";
import { TRIAGE_LOOKBACK_HOURS, TRIAGE_MAX_RESULTS } from "./skill-defaults";
import { getToolSchemas, type ToolSchema } from "./tool-registry";
import { getSecretSync } from "./secrets-store";
import { searchVnextMemory, type VnextSearchOptions } from "./memory/vnext-search";
import { sensitiveOwnershipValues } from "./sensitive-scope";
import { visibleFinanceForCurrentPrincipal } from "./finance-scope";
// Priority handling delegated to GoalsService

import { createLogger } from "./log";

const toolExec = createLogger("ToolExec");

async function isSpecSkillSession(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const { chatFileStorage } = await import("./chat-file-storage");
    const session = await chatFileStorage.getSession(sessionId);
    if (!session) return false;
    const values = [
      session.sessionKey,
      session.triggerId,
      session.spawnReason,
      session.spawnerSkillRun,
    ]
      .filter((value): value is string => typeof value === "string")
      .map(value => value.toLowerCase());

    return values.some(value =>
      value === "auto:spec" ||
      value === "spec" ||
      value === "skill:spec" ||
      value.includes(":spec")
    );
  } catch (err: unknown) {
    toolExec.warn(`Spec skill session guard lookup failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function normalizeSkillIdentifier(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isSpecChildSpawnRequest(...values: unknown[]): boolean {
  return values
    .map(value => String(value ?? "").trim().toLowerCase())
    .filter(Boolean)
    .some(value =>
      value === "spec" ||
      value === "skill:spec" ||
      /(^|[^a-z0-9])spec([^a-z0-9]|$)/.test(value) ||
      value.includes("spec skill") ||
      value.includes("run spec") ||
      value.includes("skills.run") && value.includes("spec")
    );
}

export interface BridgeToolContext {
  sessionKey: string;
  sessionId: string;
  orientationPersonaPolicy?: "replace" | "preserve_existing";
}

export interface ToolResult {
  result: string;
  error?: boolean;
  sideEffectOnly?: boolean;
  continuation?: import("./agent-executor").ToolContinuation;
  durationMs: number;
}

export type ToolHandler = (args: Record<string, any>) => Promise<{
  result: string;
  error?: boolean;
  continuation?: import("./agent-executor").ToolContinuation;
}>;
type ToolHandlerResult = { result: string; error?: boolean; data?: Record<string, unknown> };

const PEOPLE_AGENDA_SURFACE_LIMIT = 3;

function formatChecklistForXyz(checklist: unknown): string {
  if (!Array.isArray(checklist) || checklist.length === 0) {
    return "Checklist: (no structured checklist defined — scorer will fall back to default checks)";
  }
  const lines = checklist.map((item: unknown, i: number) => {
    const obj = (item ?? {}) as { check?: unknown; weight?: unknown };
    const text = typeof obj.check === "string" ? obj.check : JSON.stringify(item);
    const weight = typeof obj.weight === "number" ? obj.weight : 1;
    return `${i + 1}. ${text} (w:${weight})`;
  });
  return `Checklist (${checklist.length} weighted items used by the scorer):\n${lines.join("\n")}`;
}

async function safeInvalidateCalendarCache(source: string): Promise<void> {
  try {
    const { invalidateCalendarCache } = await import("./context-builder");
    invalidateCalendarCache();
  } catch (e: any) {
    toolExec.warn(`Failed to invalidate calendar cache after ${source}: ${e?.message}`);
  }
}

async function resolvePersonId(args: Record<string, any>): Promise<{ id: string; name: string } | null> {
  const { peopleStorage } = await import("./people-storage");
  const id = args.id;
  if (id) {
    const person = await peopleStorage.getPerson(id);
    if (person) return { id: person.id, name: person.name };
    const allPeople = await peopleStorage.listPeople();
    const fuzzy = allPeople.find(p => p.id.startsWith(id) || id.startsWith(p.id));
    if (fuzzy) return { id: fuzzy.id, name: fuzzy.name };
    const closeMatch = allPeople.find(p => {
      if (Math.abs(p.id.length - id.length) > 1) return false;
      let diffs = 0;
      for (let i = 0; i < Math.max(p.id.length, id.length); i++) {
        if (p.id[i] !== id[i]) diffs++;
      }
      return diffs <= 2;
    });
    if (closeMatch) return { id: closeMatch.id, name: closeMatch.name };
    const byName = await peopleStorage.searchPeople(id);
    if (byName.length === 1) return { id: byName[0].id, name: byName[0].name };
    if (byName.length > 1) {
      const exact = byName.find(r => r.name.toLowerCase() === id.toLowerCase());
      if (exact) return { id: exact.id, name: exact.name };
      toolExec.warn(`resolvePersonId: ambiguous match for "${id}" — ${byName.length} candidates: ${byName.map(r => `${r.name} (${r.id})`).join(", ")}`);
      return null;
    }
  }
  const name = args.query;
  if (name) {
    const results = await peopleStorage.searchPeople(name);
    if (results.length === 1) return { id: results[0].id, name: results[0].name };
    if (results.length > 1) {
      const exact = results.find(r => r.name.toLowerCase() === name.toLowerCase());
      if (exact) return { id: exact.id, name: exact.name };
      toolExec.warn(`resolvePersonId: ambiguous match for "${name}" — ${results.length} candidates: ${results.map(r => `${r.name} (${r.id})`).join(", ")}`);
      return null;
    }
  }
  return null;
}

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

type PeopleField = "id" | "name" | "email" | "company" | "role" | "relation" | "professionalRelations" | "cabinetLevel" | "tags" | "introducedBy" | "familiarity" | "trust" | "met" | "lastInteractionDate" | "createdAt" | "updatedAt";
type PeopleOperator = "equals" | "empty" | "not_empty" | "contains" | "fuzzy" | "in";

const PEOPLE_QUERY_FIELDS = new Set<PeopleField>(["id", "name", "email", "company", "role", "relation", "professionalRelations", "cabinetLevel", "tags", "introducedBy", "familiarity", "trust", "met", "lastInteractionDate", "createdAt", "updatedAt"]);
const PEOPLE_QUERY_OPERATORS = new Set<PeopleOperator>(["equals", "empty", "not_empty", "contains", "fuzzy", "in"]);

function normalizePeopleFields(fields: unknown): PeopleField[] {
  if (!Array.isArray(fields)) return ["id", "name", "email", "cabinetLevel", "company", "role", "relation", "tags", "lastInteractionDate"];
  const normalized = fields.filter((field): field is PeopleField => typeof field === "string" && PEOPLE_QUERY_FIELDS.has(field as PeopleField));
  return normalized.length > 0 ? normalized : ["id", "name", "cabinetLevel"];
}

function emailsForPerson(person: Person): string[] {
  return (person.contactInfo || []).filter(ci => ci.type === "email" && ci.value).map(ci => ci.value);
}

function getPeopleFieldValue(person: Person, field: PeopleField): unknown {
  if (field === "email") return emailsForPerson(person);
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
  const { peopleStorage } = await import("./people-storage");
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
        if (field === "relation" || field === "professionalRelations" || field === "email" || field === "introducedBy" || field === "familiarity" || field === "trust" || field === "met") continue;
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
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: `Person ${resolved.id} not found`, error: true };
  const nicknameStr = person.nicknames?.length ? ` ("${person.nicknames.join('", "')}")` : "";
  const parts = [`**${person.name}** [person:${person.id}]${nicknameStr} — ${person.cabinetLevel}`];
  const contactLines = (person.contactInfo || [])
    .filter(contact => contact.value)
    .map(contact => `  - ${contact.label || contact.type}: ${contact.value}`);
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
  const { peopleStorage } = await import("./people-storage");
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

async function handlePeopleGetMany(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const ids = Array.isArray(args.ids) ? args.ids.map((id: unknown) => String(id)).filter(Boolean).slice(0, 100) : [];
  if (ids.length === 0) return { result: "Missing ids array for get_many", error: true };
  const people = await peopleStorage.getPeopleByIds(ids);
  const fields = normalizePeopleFields(args.fields);
  const rows = people.map(person => projectPerson(person, fields));
  return { result: formatPeopleRows(rows, rows.length, 0, ids.length) };
}

async function handlePeopleQuery(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
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
  const { peopleStorage, computeAgendaSignals } = await import("./people-storage");
  const allPeople = await peopleStorage.listPeople();
  const cabinetConfig = await peopleStorage.getCabinetConfig();
  const cabinetWeights: Record<string, number> = {};
  for (const level of cabinetConfig.levels) {
    cabinetWeights[level.id] = Math.max(1, 7 - level.order);
  }
  const now = Date.now();

  let calendarAttendees: Set<string> | undefined;
  try {
    const { listAllEvents } = await import("./google-calendar");
    const { getTzOffsetISO, getTzDateStr, getTimezone } = await import("./timezone");
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

async function handlePeopleAddNote(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
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
  const { eventBus } = await import("./event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action, personId: resolved.id, personName: resolved.name },
  });
  return { result: action === "update_note" ? `Note "${title}" updated for ${resolved.name} [person:${resolved.id}]` : `Note added to ${resolved.name} [person:${resolved.id}]` };
}

async function handlePeopleUpdateNote(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const noteId = args.noteId;
  if (!noteId) return { result: "Missing noteId", error: true };
  const content = args.content;
  if (!content) return { result: "Missing note content", error: true };
  const title = args.title;
  await peopleStorage.updateNote(resolved.id, noteId, content, title);
  const { eventBus } = await import("./event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "update_note", personId: resolved.id, personName: resolved.name },
  });
  return { result: `Note ${noteId} updated for ${resolved.name} [person:${resolved.id}]` };
}

async function handlePeopleDeleteNote(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const noteId = args.noteId;
  if (!noteId) return { result: "Missing noteId", error: true };
  await peopleStorage.deleteNote(resolved.id, noteId);
  const { eventBus } = await import("./event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "delete_note", personId: resolved.id, personName: resolved.name },
  });
  return { result: `Note ${noteId} deleted from ${resolved.name} [person:${resolved.id}]` };
}

async function handlePeopleLogInteraction(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const summary = args.summary;
  if (!summary) return { result: "Missing interaction summary", error: true };
  const interaction: Omit<Interaction, "id"> = {
    date: args.date || (await import("./timezone")).getDateInTimezone(),
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
  const { eventBus: eb } = await import("./event-bus");
  eb.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "log_interaction", personId: resolved.id, personName: resolved.name },
  });
  return { result: `Interaction logged for ${resolved.name} [person:${resolved.id}]: ${summary}` };
}

async function handleUpdateRelationshipProfile(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const rp = person.relationshipProfile || {};
  if (args.temperature || args.momentum || args.status) {
    rp.state = {
      temperature: args.temperature || rp.state?.temperature || "warm",
      momentum: args.momentum || rp.state?.momentum || "steady",
      status: args.status || rp.state?.status || "active",
    };
  }
  if (args.targetDays || args.flexDays || args.cadenceClass) {
    rp.cadence = {
      targetDays: args.targetDays ?? rp.cadence?.targetDays ?? 30,
      flexDays: args.flexDays ?? rp.cadence?.flexDays ?? 14,
      cadenceClass: args.cadenceClass || rp.cadence?.cadenceClass || "monthly",
    };
  }
  await peopleStorage.updatePerson(resolved.id, { relationshipProfile: rp as RelationshipProfile });
  const { eventBus } = await import("./event-bus");
  eventBus.publish({ category: "agent", event: "data:people_changed", payload: { source: "people_tool", action: "update_relationship_profile", personId: resolved.id, personName: resolved.name } });
  return { result: `Relationship profile updated for ${resolved.name} [person:${resolved.id}]` };
}

async function handleUpdateNetworkProfile(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const np = person.networkProfile || {};
  if (args.expertise) np.expertise = Array.isArray(args.expertise) ? args.expertise : [args.expertise];
  if (args.domains) np.domains = Array.isArray(args.domains) ? args.domains : [args.domains];
  if (args.resources) np.resources = Array.isArray(args.resources) ? args.resources : [args.resources];
  if (args.canHelpWith) np.canHelpWith = Array.isArray(args.canHelpWith) ? args.canHelpWith : [args.canHelpWith];
  if (args.connections) np.connections = args.connections;
  await peopleStorage.updatePerson(resolved.id, { networkProfile: np as NetworkProfile });
  const { eventBus } = await import("./event-bus");
  eventBus.publish({ category: "agent", event: "data:people_changed", payload: { source: "people_tool", action: "update_network_profile", personId: resolved.id, personName: resolved.name } });
  return { result: `Network profile updated for ${resolved.name} [person:${resolved.id}]` };
}

async function handleUpdateCapital(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const np = person.networkProfile || {};
  const cap = np.capital || { balance: "balanced", depositsFromRay: [], depositsToRay: [] };
  if (args.balance) cap.balance = args.balance;
  if (args.deposit_from_ray) {
    cap.depositsFromRay.push(args.deposit_from_ray);
    cap.lastDeposit = new Date().toISOString();
  }
  if (args.deposit_to_ray) {
    cap.depositsToRay.push(args.deposit_to_ray);
    cap.lastDeposit = new Date().toISOString();
  }
  if (args.withdrawal) {
    cap.lastWithdrawal = new Date().toISOString();
  }
  np.capital = cap;
  await peopleStorage.updatePerson(resolved.id, { networkProfile: np as NetworkProfile });
  return { result: `Social capital updated for ${resolved.name} [person:${resolved.id}]: balance=${cap.balance}` };
}

async function handleAddCommitment(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const { randomBytes } = await import("crypto");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  if (!args.description) return { result: "Missing commitment description", error: true };
  if (!args.direction || !["from_ray", "to_ray"].includes(args.direction)) return { result: "direction must be 'from_ray' or 'to_ray'", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const np = person.networkProfile || {};
  if (!np.commitments) np.commitments = [];
  const commitment = {
    id: randomBytes(4).toString("hex"),
    direction: args.direction as "from_ray" | "to_ray",
    description: args.description,
    status: "open" as const,
    createdAt: new Date().toISOString(),
  };
  np.commitments.push(commitment);
  await peopleStorage.updatePerson(resolved.id, { networkProfile: np as NetworkProfile });
  return { result: `Commitment added for ${resolved.name} [person:${resolved.id}]: "${args.description}" (${args.direction})` };
}

async function handleUpdateCommitment(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  if (!args.commitmentId) return { result: "Missing commitmentId", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const np = person.networkProfile || {};
  const commitment = np.commitments?.find(c => c.id === args.commitmentId);
  if (!commitment) return { result: `Commitment ${args.commitmentId} not found`, error: true };
  if (args.status && ["open", "fulfilled", "expired"].includes(args.status)) {
    commitment.status = args.status;
    if (args.status !== "open") commitment.resolvedAt = new Date().toISOString();
  }
  if (args.description) commitment.description = args.description;
  await peopleStorage.updatePerson(resolved.id, { networkProfile: np as NetworkProfile });
  return { result: `Commitment ${args.commitmentId} updated for ${resolved.name} [person:${resolved.id}]: status=${commitment.status}` };
}

async function handleAskRoute(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage, computeMobilization } = await import("./people-storage");
  const query = (args.query || args.need || "").toLowerCase();
  if (!query) return { result: "Missing query — what do you need help with?", error: true };
  const allPeople = await peopleStorage.listPeople();
  const results: Array<{ name: string; id: string; score: number; expertise: string[]; mobilization: Mobilization | undefined; capital: string; reason: string }> = [];

  for (const entry of allPeople) {
    if (entry.cabinetLevel === "self" || entry.cabinetLevel === "agent" || entry.cabinetLevel === "user") continue;
    const person = await peopleStorage.getPerson(entry.id);
    if (!person) continue;
    const np = person.networkProfile;
    if (!np) continue;

    let score = 0;
    const matchReasons: string[] = [];

    for (const field of [np.expertise, np.domains, np.resources, np.canHelpWith] as (string[] | undefined)[]) {
      if (!field) continue;
      for (const item of field) {
        if (item.toLowerCase().includes(query) || query.includes(item.toLowerCase())) {
          score += 10;
          matchReasons.push(item);
        }
      }
    }

    if (np.connections) {
      for (const conn of np.connections) {
        const connStr = `${conn.name} ${conn.relationship} ${conn.domain || ""}`.toLowerCase();
        if (connStr.includes(query)) {
          score += 5;
          matchReasons.push(`knows ${conn.name} (${conn.relationship})`);
        }
      }
    }

    if (score > 0) {
      const mob = computeMobilization(person);
      if (mob.ready) score += 20;
      else if (mob.blockers.length === 1) score += 5;
      const capBal = np.capital?.balance || "balanced";
      if (capBal === "invested") score += 10;
      else if (capBal === "balanced") score += 5;
      else if (capBal === "drawing") score -= 5;
      else if (capBal === "overdrawn") score -= 15;
      results.push({
        name: person.name,
        id: person.id,
        score,
        expertise: np.expertise || [],
        mobilization: mob,
        capital: capBal,
        reason: matchReasons.join(", "),
      });
    }
  }

  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const aReady = a.mobilization?.ready ? 1 : 0;
    const bReady = b.mobilization?.ready ? 1 : 0;
    return bReady - aReady;
  });
  if (results.length === 0) return { result: "No one in the network matches that need." };

  const lines = results.slice(0, 5).map((r, i) => {
    let line = `${i + 1}. **${r.name}** (id: ${r.id}) — ${r.reason}`;
    const mob = r.mobilization;
    if (mob) {
      line += `\n   Capital: ${r.capital}. Mobilization: ${mob.ready ? "ready" : "not ready"}`;
      if (!mob.ready && mob.blockers.length > 0) {
        line += `\n   Blockers: ${mob.blockers.join("; ")}`;
      }
      if (mob.warmingPath) {
        line += `\n   → ${mob.warmingPath}`;
      }
    } else {
      line += `\n   Capital: ${r.capital}. Mobilization: unknown`;
    }
    return line;
  });

  return { result: `${results.length} people can help:\n\n${lines.join("\n\n")}` };
}

async function handleAddRelationshipMemory(args: Record<string, any>): Promise<ToolHandlerResult> {
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  if (!args.content) return { result: "Missing memory content", error: true };
  const validCategories = ["dynamic", "preference", "channel", "expertise", "network", "capital", "risk", "repair", "ritual", "opportunity"];
  const category = args.category || "dynamic";
  if (!validCategories.includes(category)) return { result: `Invalid category. Must be one of: ${validCategories.join(", ")}`, error: true };

  const { documentStorage } = await import("./memory");
  const tags = ["relationship-model", `rm:${resolved.id}`, `rm-cat:${category}`];
  if (args.tags && Array.isArray(args.tags)) tags.push(...args.tags);

  const { randomBytes } = await import("crypto");
  const memId = randomBytes(4).toString("hex");
  await documentStorage.upsertDocument(
    "memory",
    `rm-${memId}`,
    `relationship-memories/${resolved.id}/${memId}.md`,
    `${resolved.name} — ${category}`,
    args.content,
    { tags, personId: resolved.id, personName: resolved.name, category, createdAt: new Date().toISOString() }
  );

  return { result: `Relationship memory added for ${resolved.name} [person:${resolved.id}] (category: ${category})` };
}

async function handleGetRelationshipMemories(args: Record<string, any>): Promise<ToolHandlerResult> {
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };

  const { documentStorage } = await import("./memory");
  const docs = await documentStorage.getDocumentsByType("memory");
  const memories = docs.filter(d => {
    const meta = d.metadata as any;
    const tags = meta?.tags || [];
    return tags.includes(`rm:${resolved.id}`);
  });

  if (memories.length === 0) return { result: `No relationship memories found for ${resolved.name} [person:${resolved.id}].` };

  const lines = memories.map(d => {
    const meta = d.metadata as any;
    const cat = (meta?.tags || []).find((t: string) => t.startsWith("rm-cat:"))?.replace("rm-cat:", "") || "uncategorized";
    return `- [${cat}] ${d.title}: ${(d.content || "").slice(0, 300)}${(d.content || "").length > 300 ? ` [ref:memory-${d.docId}]` : ""}`;
  });

  return { result: `${memories.length} relationship memories for ${resolved.name} [person:${resolved.id}]:\n${lines.join("\n")}` };
}

async function handleEnrichmentPrompt(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) {
    const allPeople = await peopleStorage.listPeople();
    const thinPeople = [];
    for (const entry of allPeople) {
      if (entry.cabinetLevel === "self" || entry.cabinetLevel === "agent" || entry.cabinetLevel === "user") continue;
      const person = await peopleStorage.getPerson(entry.id);
      if (!person) continue;
      const np = person.networkProfile;
      const hasExpertise = np?.expertise && np.expertise.length > 0;
      const hasConnections = np?.connections && np.connections.length > 0;
      const hasCanHelpWith = np?.canHelpWith && np.canHelpWith.length > 0;
      if (!hasExpertise && !hasConnections && !hasCanHelpWith) {
        thinPeople.push({ id: person.id, name: person.name, cabinetLevel: person.cabinetLevel });
      }
    }
    if (thinPeople.length === 0) return { result: "All people have network data populated." };
    const lines = thinPeople.slice(0, 10).map(p => `- ${p.name} (id: ${p.id}, ${p.cabinetLevel})`);
    return { result: `${thinPeople.length} people with thin network data:\n${lines.join("\n")}\n\nUse enrichment_prompt with a specific person to get conversation prompts.` };
  }

  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const np = person.networkProfile;
  const missing: string[] = [];
  if (!np?.expertise?.length) missing.push("expertise");
  if (!np?.domains?.length) missing.push("domains");
  if (!np?.connections?.length) missing.push("connections");
  if (!np?.canHelpWith?.length) missing.push("what they can help with");
  if (!np?.capital) missing.push("social capital status");

  if (missing.length === 0) return { result: `${resolved.name}'s network profile is well populated.` };

  const prompts = [
    `Tell me about ${resolved.name}'s professional expertise and what domains they work in.`,
    `Who does ${resolved.name} know that might be useful? What connections do they have?`,
    `What could ${resolved.name} specifically help with if you needed something?`,
    `How would you describe the balance of favors between you and ${resolved.name}?`,
  ];

  return { result: `${resolved.name} [person:${resolved.id}] is missing: ${missing.join(", ")}.\n\nSuggested enrichment questions:\n${prompts.map((p, i) => `${i + 1}. "${p}"`).join("\n")}` };
}

async function handlePeopleGetInteractions(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
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
  const { peopleStorage } = await import("./people-storage");
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
  const { eventBus } = await import("./event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "update_interaction", personId: resolved.id, personName: resolved.name },
  });
  return { result: `Interaction ${interactionId} updated for ${resolved.name} [person:${resolved.id}]` };
}

async function handlePeopleDeleteInteraction(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const interactionId = args.interactionId;
  if (!interactionId) return { result: "Missing interactionId", error: true };
  await peopleStorage.deleteInteraction(resolved.id, interactionId);
  const { eventBus } = await import("./event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "delete_interaction", personId: resolved.id, personName: resolved.name },
  });
  return { result: `Interaction ${interactionId} deleted from ${resolved.name} [person:${resolved.id}]` };
}

async function handlePeopleMerge(args: Record<string, any>): Promise<ToolHandlerResult> {
  const sourcePersonId = typeof args.sourcePersonId === "string" ? args.sourcePersonId.trim() : "";
  const targetPersonId = typeof args.targetPersonId === "string" ? args.targetPersonId.trim() : "";
  const expectedSourceName = typeof args.expectedSourceName === "string" ? args.expectedSourceName.trim() : "";
  const expectedTargetName = typeof args.expectedTargetName === "string" ? args.expectedTargetName.trim() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey.trim() : "";
  if (
    !sourcePersonId ||
    !targetPersonId ||
    !expectedSourceName ||
    !expectedTargetName ||
    !reason ||
    !idempotencyKey
  ) {
    return {
      result:
        "merge requires sourcePersonId, targetPersonId, expectedSourceName, expectedTargetName, reason, and idempotencyKey",
      error: true,
    };
  }

  const { peopleStorage } = await import("./people-storage");
  const result = await peopleStorage.mergePeople({
    sourcePersonId,
    targetPersonId,
    expectedSourceName,
    expectedTargetName,
    reason,
    idempotencyKey,
  });
  const { eventBus } = await import("./event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: {
      source: "people_tool",
      action: "merge",
      sourcePersonId: result.sourcePersonId,
      targetPersonId: result.targetPersonId,
      personName: result.targetName,
      alreadyMerged: result.alreadyMerged,
    },
  });
  return {
    result: result.alreadyMerged
      ? `Person already merged: @person:${result.sourcePersonId} resolves to @person:${result.targetPersonId} (${result.targetName}).`
      : `Merged ${result.sourceName} (@person:${result.sourcePersonId}) into ${result.targetName} (@person:${result.targetPersonId}). Profile/history data and structured references were preserved, and the source ID remains a durable alias.`,
  };
}

async function handlePeopleUpdate(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: `Person not found: ${args.id || args.name}`, error: true };

  const requestedNewName = typeof args.newName === "string" ? args.newName.trim() : "";
  const expectedCurrentName = typeof args.expectedCurrentName === "string" ? args.expectedCurrentName.trim() : "";
  if (expectedCurrentName && !requestedNewName) {
    return { result: "expectedCurrentName was provided without newName. Provide both to rename.", error: true };
  }

  const updates: Record<string, any> = {};
  if (typeof args.quickSummary === "string") updates.quickSummary = args.quickSummary || undefined;
  if (typeof args.cabinetLevel === "string") updates.cabinetLevel = args.cabinetLevel;
  if (typeof args.company === "string") updates.company = args.company || undefined;
  if (typeof args.role === "string") updates.role = args.role || undefined;
  if (typeof args.relation === "string") updates.relation = args.relation || undefined;
  if (typeof args.familiarity === "string") updates.familiarity = args.familiarity;
  if (typeof args.trust === "string") updates.trust = args.trust;
  if (Array.isArray(args.tags)) updates.tags = args.tags;

  if (!requestedNewName && Object.keys(updates).length === 0) {
    return { result: "No updatable fields provided. Supported: newName (with expectedCurrentName), quickSummary, cabinetLevel, company, role, relation, familiarity, trust, tags.", error: true };
  }

  let renamed = false;
  if (requestedNewName) {
    if (!expectedCurrentName) {
      return { result: `Rename requires expectedCurrentName confirmation. Current name is "${resolved.name}" — pass it back exactly as expectedCurrentName along with newName.`, error: true };
    }
    await peopleStorage.renamePerson({
      personId: resolved.id,
      newName: requestedNewName,
      expectedCurrentName,
    });
    renamed = true;
  }

  const person = Object.keys(updates).length > 0
    ? await peopleStorage.updatePerson(resolved.id, updates)
    : await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: `Person not found after update: ${resolved.id}`, error: true };
  const { eventBus } = await import("./event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "update", personId: person.id, personName: person.name },
  });

  const changed = [
    ...(renamed ? [`name (was "${expectedCurrentName}", preserved as nickname)`] : []),
    ...Object.keys(updates),
  ].join(", ");
  return { result: `Updated ${person.name} [person:${person.id}]: ${changed}` };
}

async function handlePeopleCreate(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const name = args.name;
  if (!name) return { result: "Missing person name", error: true };
  const contactInfo: Array<{ type: "email"; label: string; value: string }> = [];
  if (args.email) {
    contactInfo.push({ type: "email", label: "primary", value: args.email });
  }
  const person = await peopleStorage.createPerson({
    name,
    nicknames: [],
    cabinetLevel: args.cabinetLevel || "network",
    company: args.company || undefined,
    role: args.role || undefined,
    relation: args.relation || undefined,
    introducedBy: args.introducedBy || undefined,
    familiarity: args.familiarity || undefined,
    trust: args.trust || undefined,
    dailyContact: args.dailyContact || undefined,
    socialProfiles: {},
    contactInfo,
    importantDates: [],
    notes: [],
    interactions: [],
    tags: Array.isArray(args.tags) ? args.tags : [],
    private: false,
  });
  if (args.notes) {
    await peopleStorage.addNote(person.id, args.notes);
  }
  const { eventBus: createBus } = await import("./event-bus");
  createBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "create", personId: person.id, personName: person.name },
  });
  return { result: `Person created: "${person.name}" [person:${person.id}] (cabinet: ${person.cabinetLevel})${args.email ? `, email: ${args.email}` : ""}` };
}

async function handlePeopleSetDailyContact(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: `Person not found: ${args.id || args.name}`, error: true };
  const value = args.dailyContact !== false;
  await peopleStorage.updatePerson(resolved.id, { dailyContact: value });
  const { eventBus } = await import("./event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "set_daily_contact", personId: resolved.id, personName: resolved.name },
  });
  return { result: `${resolved.name} [person:${resolved.id}] dailyContact set to ${value}` };
}

async function handlePeopleScanImports(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { loadQueueState, getPendingCandidates } = await import("./import-queue");
  const queueState = await loadQueueState();
  const pending = getPendingCandidates(queueState);
  if (pending.length === 0) return { result: "No pending import candidates." };
  const lines = pending.map(c => {
    const total = c.sentCount + c.receivedCount;
    const parts = [
      `- **${c.name}** <${c.email}>`,
      `  sent: ${c.sentCount}, received: ${c.receivedCount}, total: ${total}, threads: ${c.threadCount}`,
      `  first: ${c.firstInteraction}, last: ${c.lastInteraction}`,
    ];
    if (c.sampleSubjects && c.sampleSubjects.length > 0) {
      parts.push(`  subjects: ${c.sampleSubjects.slice(0, 5).join("; ")}`);
    }
    if (c.interactions && c.interactions.length > 0) {
      const recentIx = c.interactions.slice(0, 5);
      parts.push(`  recent interactions: ${recentIx.map(ix => `[${ix.date}] ${ix.direction}: ${ix.subject}`).join("; ")}`);
    }
    return parts.join("\n");
  });
  return { result: `${pending.length} pending import candidates:\n\n${lines.join("\n\n")}` };
}


async function handlePeopleImportApi(args: Record<string, any>): Promise<ToolHandlerResult> {
  const service = await import("./people-import-decision-service");
  const action = String(args.action || "");
  if (action === "search_import_candidates") return { result: JSON.stringify(await service.searchImportCandidates({ query: args.query, candidateId: args.candidateId, decision: args.decision, limit: args.limit, offset: args.offset }), null, 2) };
  if (action === "list_import_candidates") return { result: JSON.stringify(await service.listImportCandidates({ limit: args.limit, offset: args.offset }), null, 2) };
  if (action === "get_import_candidate") return { result: JSON.stringify(await service.getImportCandidate(String(args.candidateId || "")), null, 2) };
  if (action === "find_import_matches") return { result: JSON.stringify(await service.findImportMatches(String(args.candidateId || ""), args.limit), null, 2) };
  if (action === "add_import_candidate") return { result: JSON.stringify(await service.addImportCandidate({ ...args, candidateId: String(args.candidateId || "") }), null, 2) };
  if (action === "merge_import_candidate") return { result: JSON.stringify(await service.mergeImportCandidate({ ...args, candidateId: String(args.candidateId || ""), mergePersonId: args.personId || args.mergePersonId }), null, 2) };
  if (action === "skip_import_candidate") return { result: JSON.stringify(await service.skipImportCandidate({ ...args, candidateId: String(args.candidateId || "") }), null, 2) };
  if (action === "undo_import_decision") return { result: JSON.stringify(await service.undoImportDecision(String(args.decisionId || ""), String(args.idempotencyKey || "")), null, 2) };
  if (action === "preview_import_batch") return { result: JSON.stringify(await service.previewImportBatch(args.decisions || []), null, 2) };
  if (action === "apply_import_batch") return { result: JSON.stringify(await service.applyImportBatch(String(args.batchId || ""), String(args.batchToken || ""), String(args.idempotencyKey || "")), null, 2) };
  if (action === "get_import_batch") return { result: JSON.stringify(await service.getImportBatch(String(args.batchId || "")), null, 2) };
  return { result: `Unsupported People import action: ${action}`, error: true };
}

async function handlePeopleScanIgnored(): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("./people-storage");
  const skipList = await peopleStorage.getGmailSkipList();
  if (skipList.length === 0) return { result: "No entries on the Gmail skip/ignore list." };
  const lines = skipList.map(e => `- ${e.name || "(no name)"} <${e.email}> — skipped ${e.skippedAt}`);
  return { result: `${skipList.length} ignored contacts:\n${lines.join("\n")}` };
}

const peopleSubHandlers: Record<string, (args: Record<string, any>) => Promise<ToolHandlerResult>> = {
  list: handlePeopleList,
  get: handlePeopleGet,
  get_many: handlePeopleGetMany,
  query: handlePeopleQuery,
  search: handlePeopleSearch,
  agenda: handlePeopleAgenda,
  add_note: handlePeopleAddNote,
  update_note: handlePeopleUpdateNote,
  delete_note: handlePeopleDeleteNote,
  log_interaction: handlePeopleLogInteraction,
  get_interactions: handlePeopleGetInteractions,
  update_interaction: handlePeopleUpdateInteraction,
  delete_interaction: handlePeopleDeleteInteraction,
  update_relationship_profile: handleUpdateRelationshipProfile,
  update_network_profile: handleUpdateNetworkProfile,
  update_capital: handleUpdateCapital,
  add_commitment: handleAddCommitment,
  update_commitment: handleUpdateCommitment,
  ask_route: handleAskRoute,
  add_relationship_memory: handleAddRelationshipMemory,
  get_relationship_memories: handleGetRelationshipMemories,
  enrichment_prompt: handleEnrichmentPrompt,
  update: handlePeopleUpdate,
  merge: handlePeopleMerge,
  create: handlePeopleCreate,
  set_daily_contact: handlePeopleSetDailyContact,
  scan_imports: handlePeopleScanImports,
  search_import_candidates: handlePeopleImportApi,
  list_import_candidates: handlePeopleImportApi,
  get_import_candidate: handlePeopleImportApi,
  find_import_matches: handlePeopleImportApi,
  add_import_candidate: handlePeopleImportApi,
  merge_import_candidate: handlePeopleImportApi,
  skip_import_candidate: handlePeopleImportApi,
  undo_import_decision: handlePeopleImportApi,
  preview_import_batch: handlePeopleImportApi,
  apply_import_batch: handlePeopleImportApi,
  get_import_batch: handlePeopleImportApi,
  scan_ignored: handlePeopleScanIgnored,
};

async function handleGmailStatus(): Promise<ToolHandlerResult> {
  const { listGmailAccounts, getAccountScopes, isConnectorConnected } = await import("./gmail");
  const accounts = await listGmailAccounts();
  const connector = await isConnectorConnected();
  if (accounts.length === 0 && !connector) {
    return { result: "Gmail: not connected — no accounts linked" };
  }
  const parts: string[] = [];
  for (const a of accounts) {
    const scopes = await getAccountScopes(a.id);
    const caps = [scopes.hasGmailRead ? "read" : null, scopes.hasSend ? "send" : null, scopes.hasDraft ? "draft" : null].filter(Boolean).join("+");
    parts.push(`${a.email} (${a.label || a.id}${caps ? ", " + caps : ""})`);
  }
  let msg = `Gmail: ${accounts.length} account${accounts.length !== 1 ? "s" : ""} connected — ${parts.join(", ")}`;
  if (connector) msg += " | external connector also available";
  return { result: msg };
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePayload[];
  filename?: string;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePayload;
  [key: string]: unknown;
}

const BATCH_READ_MAX_RESULTS = TRIAGE_MAX_RESULTS;

function extractHeaders(msg: GmailMessage): { from: string; subject: string; date: string; headers: GmailHeader[] } {
  const headers = msg.payload?.headers || [];
  return {
    from: headers.find(h => h.name === 'From')?.value || 'Unknown',
    subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
    date: headers.find(h => h.name === 'Date')?.value || '',
    headers,
  };
}

function formatMessageLine(msg: GmailMessage, messageId: string, acctId: string, acctLabel?: string): string {
  const { from, subject, date } = extractHeaders(msg);
  const tag = acctLabel ? `[${acctLabel}] ` : '';
  return `- ${tag}**${subject}** from ${from} (${date}) [id:${messageId}|acct:${acctId}]`;
}

interface GmailAccountTarget { id: string; label: string }

function resolveTargetAccounts(
  resolvedAccountId: string | undefined,
  accounts: GmailAccountTarget[],
): GmailAccountTarget[] {
  if (accounts.length === 0) {
    return [];
  }
  if (resolvedAccountId) {
    const acct = accounts.find(a => a.id === resolvedAccountId);
    if (!acct) {
      toolExec.error(`resolveTargetAccounts: specified account ${resolvedAccountId} not found in ${accounts.length} connected accounts`);
      return [];
    }
    return [acct];
  }
  if (accounts.length <= 1) {
    return [accounts[0]];
  }
  return accounts;
}

export async function diagnoseGmailBatchRead(query = "newer_than:3d"): Promise<void> {
  const { listMessages, listGmailAccounts } = await import("./gmail");
  const accounts = await listGmailAccounts();
  if (accounts.length === 0) {
    toolExec.log(`[GmailDiag] No Gmail accounts connected — skipping diagnostic`);
    return;
  }
  toolExec.log(`[GmailDiag] Running batch_read diagnostic: query="${query}" accounts=${accounts.length}`);
  for (const acct of accounts) {
    try {
      const results = await listMessages(query, 5, acct.id);
      toolExec.log(`[GmailDiag] acct=${acct.id} label="${acct.email || acct.id}" query="${query}" results=${results.length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toolExec.error(`[GmailDiag] acct=${acct.id} query="${query}" ERROR: ${msg}`);
    }
  }
}

interface ListMultiAccountOptions {
  paginate?: boolean;
  paginationCap?: number;
}


async function listMessagesMultiAccount(
  query: string | undefined,
  maxResults: number,
  targetAccounts: GmailAccountTarget[],
  caller: string,
  options?: ListMultiAccountOptions,
): Promise<{ stubs: Array<{ id: string; acctId: string; acctLabel: string }>; errors: string[] }> {
  const { listMessages } = await import("./gmail");
  const { createLogger } = await import("./log");
  const log = createLogger(`BridgeTools:${caller}`);
  const stubs: Array<{ id: string; acctId: string; acctLabel: string }> = [];
  const errors: string[] = [];
  for (const acct of targetAccounts) {
    try {
      const results = await listMessages(query, maxResults, acct.id, {
        paginate: options?.paginate,
        paginationCap: options?.paginationCap,
      });
      log.debug(`list acct=${acct.id} query="${query || '(none)'}" results=${results.length}`);
      for (const s of results) {
        if (s.id) stubs.push({ id: s.id as string, acctId: acct.id, acctLabel: acct.label });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`list FAILED for account "${acct.label}" (${acct.id}): ${errMsg}`);
      errors.push(`Account "${acct.label}" (${acct.id}): ${errMsg}`);
    }
  }

  return { stubs, errors };
}

function formatListErrors(errors: string[], fallbackMessage: string, expectData = false): ToolHandlerResult {
  if (errors.length > 0) {
    return {
      result: `Gmail API errors prevented fetching messages:\n${errors.join("\n")}\n\nThis likely means the account tokens need to be refreshed. The user should re-authorize the Gmail accounts in Settings → Connections.`,
      error: true,
    };
  }
  return { result: fallbackMessage, ...(expectData ? { error: true } : {}) };
}

async function handleGmailSearch(args: Record<string, any>): Promise<ToolHandlerResult> {
  const permCheck = await checkGmailPermission(args.account, "gmailRead", "read emails");
  if (permCheck.denied) return permCheck.result;

  const { getMessage, listGmailAccounts } = await import("./gmail");
  const query = args.query;
  if (!query) return { result: "Missing search query", error: true };
  const maxResults = args.maxResults || 10;

  const accounts = await listGmailAccounts();
  if (accounts.length === 0) return { result: "No Gmail accounts connected. Add a Gmail account in Settings → Connections.", error: true };
  const resolvedAccountId = permCheck.resolvedAccountId || await resolveGmailAccountId(args.account);
  const targets = resolveTargetAccounts(resolvedAccountId, accounts);
  if (targets.length === 0) return { result: `Gmail account "${args.account}" not found in connected accounts.`, error: true };

  const { stubs, errors } = await listMessagesMultiAccount(query, maxResults, targets, "search");
  if (stubs.length === 0) return formatListErrors(errors, `No emails found for "${query}" across all accounts`);

  const lines: string[] = [];
  for (const stub of stubs) {
    try {
      const msg = await getMessage(stub.id, 'metadata', stub.acctId);
      lines.push(formatMessageLine(msg as any, stub.id, stub.acctId, targets.length > 1 ? stub.acctLabel : undefined));
    } catch (err) {
      lines.push(`- [ERROR] Message ${stub.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { result: `Found ${lines.length} emails:\n${lines.join("\n")}` };
}

function findTextBody(payload: GmailMessagePayload | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = findTextBody(part);
      if (text) return text;
    }
  }
  return '';
}

interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

function findAttachments(payload: GmailMessagePayload | undefined): GmailAttachment[] {
  if (!payload) return [];
  const attachments: GmailAttachment[] = [];
  function walk(part: GmailMessagePayload) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  if (payload.parts) payload.parts.forEach(walk);
  return attachments;
}

async function handleGmailRead(args: Record<string, any>): Promise<ToolHandlerResult> {
  const permCheck = await checkGmailPermission(args.account, "gmailRead", "read emails");
  if (permCheck.denied) return permCheck.result;

  const { getMessage, listGmailAccounts } = await import("./gmail");
  const id = args.id;
  if (!id) return { result: "Missing message id", error: true };
  const readAccountId = permCheck.resolvedAccountId || await resolveGmailAccountId(args.account);

  let msg: any = null;
  if (readAccountId) {
    msg = await getMessage(id, 'full', readAccountId);
  } else {
    const accts = await listGmailAccounts();
    for (const acct of accts) {
      try {
        msg = await getMessage(id, 'full', acct.id);
        break;
      } catch (err) { toolExec.debug("gmail read account fallback", acct.id, err); }
    }
    if (!msg) return { result: `Message ${id} not found in any connected account`, error: true };
  }

  const { from, subject, date } = extractHeaders(msg!);

  let body = findTextBody(msg!.payload);
  if (!body && msg!.payload?.body?.data) {
    body = Buffer.from(msg!.payload.body.data, 'base64').toString('utf-8');
  }

  const attachments = findAttachments(msg!.payload);
  let result = `**${subject}**\nFrom: ${from}\nDate: ${date}\n\n${body}`;
  if (attachments.length > 0) {
    result += `\n\n**Attachments (${attachments.length}):**`;
    for (const att of attachments) {
      const sizeKB = Math.round(att.size / 1024);
      result += `\n- ${att.filename} (${att.mimeType}, ${sizeKB}KB) [attachmentId:${att.attachmentId}]`;
    }
    result += `\n\nUse action "download_attachment" with the message id, attachmentId, and account to download.`;
  }
  return { result };
}

async function handleGmailRecent(args: Record<string, any>): Promise<ToolHandlerResult> {
  const permCheck = await checkGmailPermission(args.account, "gmailRead", "read emails");
  if (permCheck.denied) return permCheck.result;

  const { getMessage, listGmailAccounts } = await import("./gmail");
  const maxResults = args.maxResults || 5;

  const accounts = await listGmailAccounts();
  if (accounts.length === 0) return { result: "No Gmail accounts connected. Add a Gmail account in Settings → Connections.", error: true };
  const resolvedAccountId = permCheck.resolvedAccountId || await resolveGmailAccountId(args.account);
  const targets = resolveTargetAccounts(resolvedAccountId, accounts);
  if (targets.length === 0) return { result: `Gmail account "${args.account}" not found in connected accounts.`, error: true };

  const { stubs, errors } = await listMessagesMultiAccount(undefined, maxResults, targets, "recent");
  if (stubs.length === 0) return formatListErrors(errors, "No recent emails found across any account");

  const lines: string[] = [];
  for (const stub of stubs) {
    try {
      const msg = await getMessage(stub.id, 'metadata', stub.acctId);
      lines.push(formatMessageLine(msg as any, stub.id, stub.acctId, targets.length > 1 ? stub.acctLabel : undefined));
    } catch (err) {
      lines.push(`- [ERROR] Message ${stub.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { result: `${lines.length} recent emails:\n${lines.join("\n")}` };
}

async function resolveGmailAccountId(accountIdRaw: string | undefined): Promise<string | undefined> {
  if (!accountIdRaw) return undefined;
  const { listGmailAccounts } = await import("./gmail");
  const accts = await listGmailAccounts();
  const exactIdMatch = accts.find(a => a.id === accountIdRaw);
  if (exactIdMatch) return exactIdMatch.id;
  const labelOrEmailMatch = accts.find(a =>
    a.email.toLowerCase() === accountIdRaw.toLowerCase() ||
    a.label.toLowerCase() === accountIdRaw.toLowerCase() ||
    a.email.split('@')[0].toLowerCase() === accountIdRaw.toLowerCase() ||
    a.email.split('@')[1]?.split('.')[0]?.toLowerCase() === accountIdRaw.toLowerCase()
  );
  if (labelOrEmailMatch) {
    toolExec.log(`resolveGmailAccountId resolved "${accountIdRaw}" → ${labelOrEmailMatch.id} (${labelOrEmailMatch.email})`);
    return labelOrEmailMatch.id;
  }
  toolExec.warn(`resolveGmailAccountId could not resolve "${accountIdRaw}" — no matching account found among: ${accts.map(a => a.id + ' (' + a.label + ', ' + a.email + ')').join(', ')}`);
  return accountIdRaw;
}

async function checkGmailPermission(
  accountIdRaw: string | undefined,
  permKey: keyof GoogleAccountPermissions,
  actionLabel: string,
): Promise<{ denied: true; result: ToolHandlerResult } | { denied: false; resolvedAccountId: string | undefined }> {
  const resolvedId = await resolveGmailAccountId(accountIdRaw);
  if (resolvedId) {
    const allowed = await checkAccountPermission(resolvedId, permKey);
    if (!allowed) {
      const { getAccount } = await import("./connected-accounts");
      const acct = await getAccount(resolvedId);
      const label = acct?.label || resolvedId;
      const email = acct?.email || '';
      return {
        denied: true,
        result: {
          result: `Permission denied: ${label}${email ? ` (${email})` : ''} is not allowed to ${actionLabel}. This can be changed in Settings → Connections.`,
          error: true,
        },
      };
    }
    return { denied: false, resolvedAccountId: resolvedId };
  }
  const check = await checkPermissionAnyAccount(permKey);
  if (!check.allowed) {
    return {
      denied: true,
      result: {
        result: `Permission denied: No connected Google account is allowed to ${actionLabel}. This can be changed in Settings → Connections.`,
        error: true,
      },
    };
  }
  return { denied: false, resolvedAccountId: undefined };
}

function optionalDraftText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().length > 0 ? value : undefined;
}

function optionalDraftRecipients(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const recipients = value.filter(
    (recipient): recipient is string => typeof recipient === "string" && recipient.trim().length > 0,
  );
  return recipients.length > 0 ? recipients : undefined;
}

function extractReplyAddress(fromAddress: string | null): string | undefined {
  if (!fromAddress) return undefined;
  const angleMatch = fromAddress.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angleMatch) return angleMatch[1];
  const plainMatch = fromAddress.match(/[^\s<>]+@[^\s<>]+/);
  return plainMatch?.[0];
}

async function handleGmailReply(args: Record<string, any>): Promise<ToolHandlerResult> {
  const ref = optionalDraftText(args.ref);
  const body = optionalDraftText(args.body);
  if (!ref || !body) return { result: "Missing ref or body", error: true };

  const withoutAt = ref.startsWith("@") ? ref.slice(1) : ref;
  const firstColon = withoutAt.indexOf(":");
  const refType = firstColon > 0 ? withoutAt.slice(0, firstColon) : "email_thread";
  const refId = firstColon > 0 ? withoutAt.slice(firstColon + 1) : withoutAt;

  const { db } = await import("./db");
  const { emailMessages } = await import("@shared/schema");
  const { getCurrentPrincipalOrSystem } = await import("./principal-context");
  const { combineWithVisibleScope } = await import("./scoped-storage");
  const { and: andOp, desc: descOp, eq: eqOp } = await import("drizzle-orm");
  const principal = getCurrentPrincipalOrSystem();
  const emailScope = { ownerUserId: emailMessages.ownerUserId, accountId: emailMessages.principalAccountId };

  let accountId: string | undefined;
  let providerThreadId: string | null = null;
  if (refType === "email_message") {
    const messageId = Number(refId);
    if (!Number.isFinite(messageId)) return { result: `Invalid email_message ref: ${ref}`, error: true };
    const [message] = await db.select({ accountId: emailMessages.accountId, providerThreadId: emailMessages.providerThreadId, providerMessageId: emailMessages.providerMessageId })
      .from(emailMessages)
      .where(combineWithVisibleScope(principal, emailScope, eqOp(emailMessages.id, messageId)))
      .limit(1);
    if (!message) return { result: `Email message ${messageId} not found.`, error: true };
    accountId = message.accountId;
    providerThreadId = message.providerThreadId || message.providerMessageId;
  } else if (refType === "email_thread") {
    const idColon = refId.indexOf(":");
    if (idColon > 0) {
      accountId = refId.slice(0, idColon);
      providerThreadId = refId.slice(idColon + 1);
    } else {
      providerThreadId = refId;
    }
  } else {
    return { result: `Unsupported reply ref: ${ref}`, error: true };
  }
  if (!providerThreadId) return { result: `Invalid email thread ref: ${ref}`, error: true };

  const conditions = [eqOp(emailMessages.providerThreadId, providerThreadId)];
  if (accountId) conditions.push(eqOp(emailMessages.accountId, accountId));
  const [latest] = await db.select({
    accountId: emailMessages.accountId,
    subject: emailMessages.subject,
    fromAddress: emailMessages.fromAddress,
  }).from(emailMessages)
    .where(combineWithVisibleScope(principal, emailScope, andOp(...conditions)))
    .orderBy(descOp(emailMessages.date))
    .limit(1);
  if (!latest) return { result: `Email thread ${providerThreadId} not found.`, error: true };

  const to = extractReplyAddress(latest.fromAddress);
  if (!to) return { result: "Could not derive a reply recipient from the latest message", error: true };
  const subject = latest.subject?.toLowerCase().startsWith("re:") ? latest.subject : `Re: ${latest.subject || ""}`;
  return handleGmailDraft({
    ...args,
    account: latest.accountId,
    to,
    subject,
    body,
    thread_id: providerThreadId,
  });
}

async function handleGmailDraft(args: Record<string, any>): Promise<ToolHandlerResult> {
  const permCheck = await checkGmailPermission(args.account, "gmailDraft", "create drafts");
  if (permCheck.denied) return permCheck.result;

  const { to, subject, body } = args;
  if (!to || !subject || !body) return { result: "Missing to, subject, or body", error: true };
  const draftAccountId = permCheck.resolvedAccountId || await resolveGmailAccountId(args.account);

  try {
    const { emailDraftStorage } = await import("./email-draft-storage");
    const { getCurrentPrincipalOrSystem } = await import("./principal-context");
    const principal = getCurrentPrincipalOrSystem();

    const draft = await emailDraftStorage.create(principal, {
      gmailAccountId: draftAccountId || undefined,
      to: Array.isArray(to) ? to : [to],
      subject,
      body,
      threadId: args.thread_id || undefined,
      inReplyTo: args.in_reply_to || undefined,
      sessionId: args._sessionId || undefined,
    });

    return { result: `Email draft created. @email_draft:${draft.id}` };
  } catch (err: any) {
    toolExec.error(`handleGmailDraft: Failed to create draft: ${err.message}`);
    return { result: `Failed to create email draft: ${err.message}`, error: true };
  }
}

type ParsedDraftBodyMutation =
  | { mutation?: import("./email-draft-storage").EmailDraftBodyMutation }
  | { error: string };

function isSubstantiveDraftBodyOperation(key: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "object" || Array.isArray(value)) return true;

  const operation = value as Record<string, unknown>;
  if (key === "findReplace") {
    return operation.find !== "" || operation.replace !== "" || operation.replaceAll === true;
  }
  if (key === "rangePatch") {
    return operation.start !== 0
      || operation.end !== 0
      || operation.replacement !== ""
      || operation.expectedBodyHash !== "";
  }
  if (key === "replaceBody") {
    return operation.body !== "" || operation.clear === true;
  }
  return Object.keys(operation).length > 0;
}

function parseDraftBodyMutation(args: Record<string, any>): ParsedDraftBodyMutation {
  const supplied = ["findReplace", "rangePatch", "replaceBody"].filter((key) =>
    isSubstantiveDraftBodyOperation(key, args[key]),
  );
  if (optionalDraftText(args.body)) {
    return { error: "update_draft body changes require findReplace, rangePatch, or replaceBody; body is for draft creation only" };
  }
  if (supplied.length > 1) {
    return { error: "Provide only one body operation: findReplace, rangePatch, or replaceBody" };
  }
  if (supplied.length === 0) return {};

  const operation = supplied[0];
  const value = args[operation];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: `${operation} must be an object` };
  }

  if (operation === "findReplace") {
    if (typeof value.find !== "string" || value.find.length === 0 || typeof value.replace !== "string") {
      return { error: "findReplace requires a non-empty find string and a replace string" };
    }
    if (value.replaceAll !== undefined && typeof value.replaceAll !== "boolean") {
      return { error: "findReplace.replaceAll must be a boolean" };
    }
    return {
      mutation: {
        type: "find_replace",
        find: value.find,
        replace: value.replace,
        replaceAll: value.replaceAll,
      },
    };
  }

  if (operation === "rangePatch") {
    if (
      !Number.isInteger(value.start)
      || !Number.isInteger(value.end)
      || typeof value.replacement !== "string"
      || typeof value.expectedBodyHash !== "string"
      || value.expectedBodyHash.trim().length === 0
    ) {
      return { error: "rangePatch requires integer start/end, a replacement string, and non-empty expectedBodyHash" };
    }
    return {
      mutation: {
        type: "range_patch",
        start: value.start,
        end: value.end,
        replacement: value.replacement,
        expectedBodyHash: value.expectedBodyHash.trim(),
      },
    };
  }

  if (value.clear !== undefined && typeof value.clear !== "boolean") {
    return { error: "replaceBody.clear must be a boolean" };
  }
  if (typeof value.body !== "string") {
    return { error: "replaceBody requires a body string" };
  }
  if (value.body.length === 0 && value.clear !== true) {
    return { error: "Clearing a draft body requires replaceBody.clear=true" };
  }
  return { mutation: { type: "replace_body", body: value.body } };
}

function describeDraftBodyMutationFailure(
  draftId: string,
  result: Exclude<
    import("./email-draft-storage").EmailDraftBodyMutationResult,
    { status: "updated" }
  >,
): string {
  switch (result.status) {
    case "not_found":
      return `Email draft ${draftId} not found`;
    case "missing_match":
      return "Draft body edit failed: exact find text was not present";
    case "ambiguous_match":
      return "Draft body edit failed: exact find text matched more than once; provide more context or set replaceAll=true";
    case "stale_body":
      return `Draft body edit failed: body changed since the patch was prepared${result.bodyHash ? `. Current body hash: ${result.bodyHash}` : ""}`;
    case "invalid_range":
      return `Draft body edit failed: range is invalid for the current body${result.bodyHash ? `. Current body hash: ${result.bodyHash}` : ""}`;
    case "immutable_draft":
      return "Draft body edit failed: sent and discarded drafts are immutable";
  }
}

async function handleGmailDraftUpdate(args: Record<string, any>): Promise<ToolHandlerResult> {
  const draftId = optionalDraftText(args.draft_id);
  if (!draftId) return { result: "Missing draft_id", error: true };

  const parsedBodyMutation = parseDraftBodyMutation(args);
  if ("error" in parsedBodyMutation) {
    return { result: parsedBodyMutation.error, error: true };
  }

  try {
    const { emailDraftStorage } = await import("./email-draft-storage");
    const { getCurrentPrincipalOrSystem } = await import("./principal-context");
    const principal = getCurrentPrincipalOrSystem();
    const account = optionalDraftText(args.account);
    let gmailAccountId: string | undefined;
    if (account) {
      const permission = await checkGmailPermission(account, "gmailDraft", "update drafts");
      if (permission.denied) return permission.result;
      gmailAccountId = permission.resolvedAccountId;
    }
    const patch = {
      gmailAccountId,
      to: optionalDraftRecipients(args.update_to),
      cc: optionalDraftRecipients(args.update_cc),
      bcc: optionalDraftRecipients(args.update_bcc),
      subject: optionalDraftText(args.subject),
    };
    const hasNonBodyPatch = Object.values(patch).some((value) => value !== undefined);
    if (!hasNonBodyPatch && !parsedBodyMutation.mutation) {
      return { result: "No non-empty editable fields or body operation provided", error: true };
    }

    let draft = hasNonBodyPatch
      ? await emailDraftStorage.update(principal, draftId, patch)
      : null;
    if (hasNonBodyPatch && !draft) {
      return { result: `Email draft ${draftId} not found`, error: true };
    }

    if (parsedBodyMutation.mutation) {
      const bodyResult = await emailDraftStorage.mutateBody(
        principal,
        draftId,
        parsedBodyMutation.mutation,
      );
      if (bodyResult.status !== "updated") {
        return {
          result: describeDraftBodyMutationFailure(draftId, bodyResult),
          error: true,
        };
      }
      draft = bodyResult.draft;
    }

    return { result: `Email draft updated. @email_draft:${draft!.id}` };
  } catch (err: any) {
    toolExec.error(`handleGmailDraftUpdate: Failed to update draft: ${err.message}`);
    return { result: `Failed to update email draft: ${err.message}`, error: true };
  }
}

export async function handleGmailDraftFromReview(args: {
  to: string;
  subject: string;
  sourceEmailId: number;
  accountId: string;
  context: string;
}): Promise<{ draft: any; toolResult: string }> {
  const result = await handleGmailDraft({
    action: "draft",
    to: args.to,
    subject: args.subject,
    body: args.context,
    account: args.accountId,
  });

  // The draft was created via emailDraftStorage in handleGmailDraft.
  // Return the tool result — the @email_draft reference is in the result string.
  return { draft: null, toolResult: result.result };
}

async function handleGmailDownloadAttachment(args: Record<string, any>): Promise<ToolHandlerResult> {
  const permCheck = await checkGmailPermission(args.account, "gmailDownloadAttachments", "download attachments");
  if (permCheck.denied) return permCheck.result;

  const { getAttachment, listGmailAccounts } = await import("./gmail");
  const messageId = args.id;
  const attachmentId = args.attachmentId;
  if (!messageId || !attachmentId) return { result: "Missing message id or attachmentId", error: true };
  let dlAccountId = permCheck.resolvedAccountId || await resolveGmailAccountId(args.account);

  let attData: { data: string; size: number } | null = null;
  if (dlAccountId) {
    attData = await getAttachment(messageId, attachmentId, dlAccountId);
  } else {
    const accts = await listGmailAccounts();
    for (const acct of accts) {
      try {
        attData = await getAttachment(messageId, attachmentId, acct.id);
        dlAccountId = acct.id;
        break;
      } catch (err) { toolExec.debug("gmail attachment account fallback", acct.id, err); }
    }
    if (!attData) return { result: `Attachment not found in any connected account`, error: true };
  }

  const rawData = attData.data.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(rawData, 'base64');
  const attachFileName = args.fileName || `attachment-${Date.now()}`;

  const { promises: fs } = await import("fs");
  const { join, extname } = await import("path");
  const { WORKSPACE_DIR } = await import("./paths");
  const uploadsDir = join(WORKSPACE_DIR, "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  const safeName = attachFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(uploadsDir, `${Date.now()}-${safeName}`);
  await fs.writeFile(filePath, buffer);
  const workspacePath = filePath.replace(WORKSPACE_DIR + "/", "");

  const textExts = [".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".html", ".css", ".js", ".ts", ".py", ".sh", ".log", ".ini", ".cfg", ".toml", ".rst", ".tex", ".svg"];
  const ext = extname(attachFileName).toLowerCase();
  const isText = textExts.includes(ext);

  if (isText && buffer.length <= 100000) {
    const content = buffer.toString("utf-8");
    if (content.length > 5000) {
      const { indexAndArchiveWithFallback } = await import("./content-indexer");
      const refBlock = await indexAndArchiveWithFallback({
        content,
        sourceType: "file",
        sourceLabel: attachFileName,
      });
      return { result: `Downloaded "${attachFileName}" (${buffer.length} bytes, saved to ${workspacePath})\n\n${refBlock}` };
    }
    return { result: `Downloaded "${attachFileName}" (${buffer.length} bytes, saved to ${workspacePath})\n\n**Content:**\n${content}` };
  }

  return { result: `Downloaded "${attachFileName}" (${buffer.length} bytes) to workspace: ${workspacePath}\n\nTo attach this file to a project, use the work tool: { "action": "add_file", "id": PROJECT_ID, "workspacePath": "${workspacePath}" }` };
}

interface MessageStub { id: string; acctId: string; acctLabel: string }

function filterExcluded(stubs: MessageStub[], excludeSet: Set<string>): MessageStub[] {
  const filtered = stubs.filter(s => !excludeSet.has(s.id));
  const excludedCount = stubs.length - filtered.length;
  if (excludedCount > 0) {
    toolExec.log(`batch_read excluded ${excludedCount} already-triaged messages`);
  }
  return filtered;
}

async function fetchFullMessages(
  stubs: MessageStub[],
  getMessage: (id: string, format: 'full' | 'metadata' | 'minimal', accountId?: string) => Promise<any>,
): Promise<string[]> {
  const results: string[] = [];
  for (const stub of stubs) {
    try {
      const msg = await getMessage(stub.id, 'full', stub.acctId);
      const { from, subject, headers } = extractHeaders(msg);

      let body = findTextBody(msg.payload);
      if (!body && msg.payload?.body?.data) {
        body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
      }
      if (body.length > 3000) {
        const { indexAndArchive, formatReferenceBlock } = await import("./content-indexer");
        const ref = await indexAndArchive({ content: body, sourceType: "email", sourceLabel: `${msg.payload?.headers?.find((h: any) => h.name === "Subject")?.value || "email"} (${stub.id})` });
        if (ref) {
          body = formatReferenceBlock(ref);
        }
      }

      const headerLines = headers.map(h => `- **${h.name}:** ${h.value}`).join('\n');
      const entry = `### [${stub.acctLabel}] ${subject}\n- **Message ID:** ${stub.id}\n- **Account:** ${stub.acctId}\n\n**Headers:**\n${headerLines}\n\n**Body:**\n${body}`;
      results.push(entry);
    } catch (err) {
      toolExec.error(`batch_read getMessage failed id=${stub.id} acct=${stub.acctId}`, err);
      results.push(`### Message ${stub.id} — ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return results;
}

async function handleGmailBatchRead(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { createLogger } = await import("./log");
  const log = createLogger("BridgeTools:batch_read");

  log.debug(`called args.account=${args.account} args.query=${args.query} args.maxResults=${args.maxResults} excludeCount=${(args.excludeMessageIds || []).length} hasIds=${!!args.ids}`);

  const permCheck = await checkGmailPermission(args.account, "gmailRead", "read emails");
  if (permCheck.denied) return permCheck.result;

  const { getMessage, listGmailAccounts } = await import("./gmail");
  const ids: string[] | undefined = args.ids;
  const query: string | undefined = args.query;
  log.debug(`effective query: "${query}"`);
  const excludeSet = new Set<string>(args.excludeMessageIds || []);
  const maxResults = Math.min(args.maxResults || BATCH_READ_MAX_RESULTS, BATCH_READ_MAX_RESULTS);

  if (!ids && !query) return { result: "Provide either 'ids' (array of message IDs) or 'query' (search string) for batch_read", error: true };

  const accounts = await listGmailAccounts();
  if (accounts.length === 0) {
    log.error(`failed: no Gmail accounts connected`);
    return { result: "No Gmail accounts connected. Connect an account in Settings → Connections.", error: true };
  }

  const resolvedAccountId = permCheck.resolvedAccountId || await resolveGmailAccountId(args.account);
  const targets = resolveTargetAccounts(resolvedAccountId, accounts);

  if (targets.length === 0) {
    log.error(`failed: resolveTargetAccounts returned empty for resolvedAccountId=${resolvedAccountId}`);
    return { result: "Could not resolve target Gmail account. Check that the account is still connected in Settings → Connections.", error: true };
  }

  log.debug(`resolvedAccountId=${resolvedAccountId} targets=${targets.map(t => t.id + '(' + t.label + ')').join(', ')}`);

  let messageStubs: MessageStub[] = [];
  let listErrors: string[] = [];

  if (ids) {
    messageStubs = filterExcluded(
      ids.map(mid => ({ id: mid, acctId: targets[0].id, acctLabel: targets[0].label })),
      excludeSet,
    );
  } else if (query) {
    const listResult = await listMessagesMultiAccount(query, maxResults, targets, "batch_read", {
      paginate: true,
      paginationCap: BATCH_READ_MAX_RESULTS,
    });
    listErrors.push(...listResult.errors);
    log.debug(`listMulti stubs=${listResult.stubs.length} errors=${listResult.errors.length} query="${query}" targetAccounts=${targets.length}${listResult.errors.length > 0 ? ` errDetails=${listResult.errors.join('; ')}` : ''}`);
    messageStubs = filterExcluded(listResult.stubs, excludeSet);
  }

  messageStubs = messageStubs.slice(0, maxResults);
  log.debug(`final stubs=${messageStubs.length} excludeSetSize=${excludeSet.size} listErrors=${listErrors.length}`);

  if (messageStubs.length === 0) {
    log.warn(`returning empty — query="${query}" targets=${targets.length} excludeSetSize=${excludeSet.size} listErrors=${listErrors.length}${listErrors.length > 0 ? ` errors: ${listErrors.join('; ')}` : ''}`);
    return formatListErrors(listErrors, "No messages found (or all excluded)", true);
  }

  const results = await fetchFullMessages(messageStubs, getMessage);
  const errorSuffix = listErrors.length > 0 ? `\n\n⚠️ Errors encountered for some accounts:\n${listErrors.join("\n")}` : "";
  return { result: `Batch read ${results.length} messages:\n\n${results.join("\n\n---\n\n")}${errorSuffix}` };
}

async function handleGmailTriageLog(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { storage } = await import("./storage");
  const subAction = args.triage_action || "get_triaged_ids";

  if (subAction === "get_triaged_ids") {
    const sinceHours = args.sinceHours || TRIAGE_LOOKBACK_HOURS;
    const ids = await storage.getTriagedMessageIds(sinceHours);
    return { result: ids.length > 0 ? `${ids.length} previously triaged message IDs:\n${ids.join("\n")}` : "No previously triaged messages found." };
  }

  if (subAction === "record") {
    const VALID_TIERS = new Set(["🔴", "🟡", "🟢", "📋", "🗑️", "respond_now", "respond_today", "acknowledge", "fyi", "noise"]);
    const TIER_NORMALIZE: Record<string, string> = { respond_now: "🔴", respond_today: "🟡", acknowledge: "🟢", fyi: "📋", noise: "🗑️" };
    const entries: Array<{ gmailMessageId: string; accountId: string; tier: string; senderEmail?: string; subject?: string; cachedMessageId?: number }> = args.entries;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return { result: "Missing or empty 'entries' array. Each entry needs: gmailMessageId, accountId, tier.", error: true };
    }
    for (const e of entries) {
      if (!e.gmailMessageId || !e.accountId || !e.tier) {
        return { result: `Invalid entry — each needs gmailMessageId, accountId, and tier. Got: ${JSON.stringify(e)}`, error: true };
      }
      if (!VALID_TIERS.has(e.tier)) {
        return { result: `Invalid tier "${e.tier}". Valid: 🔴, 🟡, 🟢, 📋, 🗑️ (or respond_now, respond_today, acknowledge, fyi, noise)`, error: true };
      }
      e.tier = TIER_NORMALIZE[e.tier] || e.tier;
    }
    await storage.recordTriagedEmails(entries.map(e => ({
      gmailMessageId: e.gmailMessageId,
      accountId: e.accountId,
      tier: e.tier,
      senderEmail: e.senderEmail || null,
      subject: e.subject || null,
      cachedMessageId: e.cachedMessageId ?? null,
    })));
    return { result: `Recorded ${entries.length} triaged email(s) in triage log.` };
  }

  return { result: `Unknown triage_action "${subAction}". Use "get_triaged_ids" or "record".`, error: true };
}

async function handleGmailEmailCache(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { storage } = await import("./storage");
  const { createLogger } = await import("./log");
  const log = createLogger("EmailCache");
  const subAction = args.cache_action || "get_untriaged";

  if (subAction === "get_untriaged") {
    const limit = Math.min(args.limit || 5000, 5000);
    const emails = await storage.getUntriagedCachedEmails(limit);
    log.debug(`get_untriaged returned ${emails.length} emails`);

    const { triageJob } = await import("./triage-job-state");
    if (triageJob.status === "running") {
      triageJob.total = emails.length;
    }

    if (emails.length === 0) {
      return { result: "No untriaged emails in the cache." };
    }

    const lines = emails.map(e => {
      const from = e.fromAddress || "unknown";
      const date = e.date ? new Date(e.date).toISOString().slice(0, 16) : "unknown";
      const snip = e.snippet ? ` — ${e.snippet.slice(0, 120)}` : "";
      return `### [${e.accountId}] ${e.subject || "(no subject)"}\n- **Cache ID:** ${e.id}\n- **Provider ID:** ${e.providerMessageId}\n- **From:** ${from}\n- **Date:** ${date}\n- **Account:** ${e.accountId}${snip}${e.bodyText ? `\n\n**Body:**\n${e.bodyText.slice(0, 2000)}` : ""}`;
    });

    return { result: `${emails.length} untriaged cached emails:\n\n${lines.join("\n\n---\n\n")}` };
  }

  if (subAction === "mark_triaged") {
    const VALID_TIERS = new Set(["🔴", "🟡", "🟢", "📋", "🗑️", "respond_now", "respond_today", "acknowledge", "fyi", "noise"]);
    const TIER_NORMALIZE: Record<string, string> = { respond_now: "🔴", respond_today: "🟡", acknowledge: "🟢", fyi: "📋", noise: "🗑️" };
    const entries: Array<{ cacheId: number; tier: string; reason: string }> = args.entries;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return { result: "Missing or empty 'entries' array. Each entry needs: cacheId, tier, reason.", error: true };
    }
    for (const e of entries) {
      if (!e.cacheId || !e.tier) {
        return { result: `Invalid entry — each needs cacheId and tier. Got: ${JSON.stringify(e)}`, error: true };
      }
      if (!VALID_TIERS.has(e.tier)) {
        return { result: `Invalid tier "${e.tier}". Valid: 🔴, 🟡, 🟢, 📋, 🗑️ (or respond_now, respond_today, acknowledge, fyi, noise)`, error: true };
      }
      e.tier = TIER_NORMALIZE[e.tier] || e.tier;
    }

    const dismissed = await storage.batchUpdateEmailTriageState(entries.map(e => ({
      id: e.cacheId,
      tier: e.tier,
      reason: e.reason || "",
    })));

    if (dismissed.length > 0) {
      const { archiveEmail } = await import("./gmail");
      for (const d of dismissed) {
        await archiveEmail(d.accountId, d.providerMessageId).catch(() => {});
      }
    }

    const triageLogEntries = [];
    for (const e of entries) {
      const cached = await storage.getCachedEmailById(e.cacheId);
      if (cached) {
        triageLogEntries.push({
          gmailMessageId: cached.providerMessageId,
          accountId: cached.accountId,
          cachedMessageId: cached.id,
          tier: e.tier,
          senderEmail: cached.fromAddress || null,
          subject: cached.subject || null,
        });
      }
    }
    if (triageLogEntries.length > 0) {
      await storage.recordTriagedEmails(triageLogEntries);
    }

    let importQueued = 0;
    let interactionsLogged = 0;

    try {
      const { processEmailPeopleSignals, fromCachedEmail } = await import("./email-people-signals");
      const cachedRows = [];
      const tierByMessageId = new Map<number, { tier: string; reason?: string }>();
      for (const e of entries) {
        const cached = await storage.getCachedEmailById(e.cacheId);
        if (!cached) continue;
        cachedRows.push(fromCachedEmail(cached as any));
        tierByMessageId.set(cached.id, { tier: e.tier, reason: e.reason || "" });
      }
      const peopleResult = await processEmailPeopleSignals(cachedRows, { source: "email_triage", tierByMessageId });
      importQueued = peopleResult.importQueued;
      interactionsLogged = peopleResult.interactionsLogged;
    } catch (autoErr: any) {
      log.debug(`mark_triaged: people signal error (non-fatal): ${autoErr.message}`);
    }

    const { triageJob } = await import("./triage-job-state");
    if (triageJob.status === "running") {
      triageJob.processed += entries.length;
      triageJob.triaged += entries.length;
    }

    log.debug(`mark_triaged: updated ${entries.length} emails, recorded ${triageLogEntries.length} audit log entries, queued ${importQueued} imports, logged ${interactionsLogged} interactions`);
    return { result: `Marked ${entries.length} email(s) as triaged and recorded audit log entries.${importQueued > 0 ? ` Queued ${importQueued} unknown sender(s) for import review.` : ""}${interactionsLogged > 0 ? ` Logged ${interactionsLogged} interaction(s) on matched people.` : ""}` };
  }

  if (subAction === "sync_status") {
    const { getEmailPipelineHealth } = await import("./email-sync");
    const health = await getEmailPipelineHealth();
    if (health.accounts.length === 0) {
      return { result: "No email sync history found. Sync has not run yet." };
    }
    const lines = health.accounts.map(account => {
      const staleWarning = account.stale ? " ⚠️ STALE" : "";
      const lastSuccessStr = account.lastGoodAt || "never";
      return `- **${account.accountId}**: status=${account.status}, last success=${lastSuccessStr}${staleWarning}, total synced=${account.totalSynced}, total reconciled (Superhuman/done sweeps)=${account.totalReconciled}${account.currentError ? `, current error: ${account.currentError}` : ""}`;
    });
    return { result: `Email sync health: ${health.status}\n${lines.join("\n")}` };
  }

  if (subAction === "search") {
    const query = args.query;
    if (!query || typeof query !== "string") {
      return { result: "Missing 'query' string parameter for search action.", error: true };
    }
    const days = Math.max(1, Math.min(args.days || 7, 90));
    const searchLimit = Math.max(1, Math.min(args.limit || 20, 100));
    const { db } = await import("./db");
    const { emailMessages } = await import("@shared/schema");
    const { and: andOp, or: orOp, desc: descOp, gte: gteOp, ilike: ilikeOp } = await import("drizzle-orm");

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const pattern = `%${query}%`;

    const results = await db.select().from(emailMessages)
      .where(andOp(
        gteOp(emailMessages.date, since),
        orOp(
          ilikeOp(emailMessages.subject, pattern),
          ilikeOp(emailMessages.fromAddress, pattern),
          ilikeOp(emailMessages.toAddresses, pattern),
          ilikeOp(emailMessages.ccAddresses, pattern),
        ),
      ))
      .orderBy(descOp(emailMessages.date))
      .limit(searchLimit);

    if (results.length === 0) {
      return { result: `No emails matching "${query}" in the last ${days} days.` };
    }

    const lines = results.map(e => {
      const direction = e.direction === "outbound" ? "Sent to" : "Received from";
      const participant = e.direction === "outbound" ? (e.toAddresses || e.ccAddresses || "unknown") : (e.fromAddress || "unknown");
      const date = e.date ? new Date(e.date).toISOString().slice(0, 16) : "unknown";
      const tier = e.triageTier ? ` [${e.triageTier}]` : "";
      return `- **${e.subject || "(no subject)"}** ${direction} ${participant} (${date})${tier} — ID: ${e.id}`;
    });

    return { result: `${results.length} email(s) matching "${query}" (last ${days} days):\n${lines.join("\n")}` };
  }

  if (subAction === "get_unenriched") {
    const unenriched = await storage.getUnenrichedTriagedEmails(30);
    if (unenriched.length === 0) {
      return { result: "No unenriched triaged emails found." };
    }

    const threadMap = new Map<string, typeof unenriched>();
    for (const email of unenriched) {
      const tid = email.providerThreadId || email.providerMessageId;
      if (!threadMap.has(tid)) threadMap.set(tid, []);
      threadMap.get(tid)!.push(email);
    }

    const threads = Array.from(threadMap.entries()).map(([threadId, msgs]) => {
      const latest = msgs[msgs.length - 1];
      return {
        threadId,
        accountId: latest.accountId,
        messageCount: msgs.length,
        latestMessageId: latest.id,
        subject: latest.subject || "(no subject)",
        sender: latest.fromAddress || "unknown",
        tier: latest.triageTier || "unknown",
        reason: latest.triageReason || "",
        date: latest.date ? new Date(latest.date).toISOString() : "unknown",
        snippet: latest.snippet || "",
        body: latest.bodyText ? latest.bodyText.slice(0, 800) : "",
      };
    });

    return { result: safeStringify({ threads, count: threads.length }, { label: "bridge.gmail.threads" }) };
  }

  if (subAction === "store_enrichment") {
    const { thread_id, account_id, message_id, summary, decisions, actions: enrichActions, dismissed, dismiss_reason, model: enrichModel, tokens_used } = args;
    if (!thread_id || !account_id) {
      return { result: "Missing required thread_id and account_id.", error: true };
    }

    const NEVER_DISMISS_TIERS = new Set(["🟡", "🔴"]);

    let shouldDismiss = !!dismissed;

    const { db } = await import("./db");
    const { emailMessages } = await import("@shared/schema");
    const { and: andOp, eq: eqOp, gt: gtOp, inArray: inArrayOp } = await import("drizzle-orm");

    const importantThreadMessages = await db.select({
      id: emailMessages.id,
      triageTier: emailMessages.triageTier,
    })
      .from(emailMessages)
      .where(andOp(
        eqOp(emailMessages.providerThreadId, thread_id),
        eqOp(emailMessages.accountId, account_id),
        eqOp(emailMessages.direction, "inbound"),
        eqOp(emailMessages.triageStatus, "triaged"),
        inArrayOp(emailMessages.triageTier, Array.from(NEVER_DISMISS_TIERS)),
      ))
      .limit(1);

    if (importantThreadMessages.length > 0) {
      shouldDismiss = false;
      if (dismissed) {
        log.debug(`store_enrichment: SAFETY RAIL — blocked dismissal of important email thread=${thread_id} tier=${importantThreadMessages[0].triageTier}`);
      }
    }

    let normalizedActions = Array.isArray(enrichActions) ? enrichActions : null;
    if (normalizedActions && message_id) {
      const email = await storage.getCachedEmailById(message_id);
      if (email?.providerThreadId && email.date) {
        const outbound = await db.select({ id: emailMessages.id })
          .from(emailMessages)
          .where(andOp(
            eqOp(emailMessages.providerThreadId, email.providerThreadId),
            eqOp(emailMessages.accountId, email.accountId),
            eqOp(emailMessages.direction, "outbound"),
            gtOp(emailMessages.date, email.date),
          ))
          .limit(1);
        if (outbound.length > 0) {
          const before = normalizedActions.length;
          normalizedActions = normalizedActions.filter((action: string) => !/\b(reply|respond|response|follow up|follow-up)\b/i.test(String(action)));
          if (normalizedActions.length !== before) {
            log.debug(`store_enrichment: removed stale reply/follow-up action(s) for replied thread=${thread_id}`);
          }
        }
      }
    }

    await storage.upsertEmailEnrichment({
      providerThreadId: thread_id,
      accountId: account_id,
      messageId: message_id || null,
      summary: summary || null,
      decisions: decisions || null,
      actions: normalizedActions,
      dismissed: shouldDismiss,
      dismissReason: dismiss_reason || null,
      model: enrichModel || null,
      tokensUsed: tokens_used || null,
    });

    if (shouldDismiss && message_id) {
      const email = await storage.getCachedEmailById(message_id);
      if (email) {
        await storage.markEmailDone(message_id, true);
        await storage.recordEmailDismissal({
          messageId: message_id,
          providerThreadId: thread_id,
          accountId: account_id,
          tier: email.triageTier || null,
          sender: email.fromAddress || null,
          subject: email.subject || null,
          reason: dismiss_reason || "LLM-dismissed via enrichment",
          dismissedBy: "auto_enrich",
        });
      }
    }

    return { result: `Enrichment stored for thread=${thread_id}${shouldDismiss ? " (dismissed)" : ""}.` };
  }

  if (subAction === "pipeline_counts") {
    const counts = await storage.getEmailPipelineCounts();
    return { result: safeStringify({ ...counts, description: "Pipeline counts from getEmailPipelineCounts(). untriaged=non-outbound emails with triageStatus='untriaged' (last 30 days), matching get_untriaged candidate scope. awaitingEnrichment=triageStatus='triaged' with no/stale enrichment (last 30 days). reviewReady=triageStatus='triaged' with current enrichment (last 30 days). triageStatus='dismissed' emails (auto-dismissed noise/FYI) are excluded from enrichment/review counts." }, { label: "bridge.gmail.pipeline_counts" }) };
  }

  if (subAction === "resolve" || subAction === "get_thread") {
    const rawRef = String(args.ref || args.query || args.thread_id || "").trim();
    const explicitAccountId = typeof args.account_id === "string" && args.account_id.trim() ? args.account_id.trim() : null;
    if (!rawRef) {
      return { result: "Missing email ref. Provide ref, query, or thread_id.", error: true };
    }

    const withoutAt = rawRef.startsWith("@") ? rawRef.slice(1) : rawRef;
    const firstColon = withoutAt.indexOf(":");
    const refType = firstColon > 0 ? withoutAt.slice(0, firstColon) : "email_thread";
    const refId = firstColon > 0 ? withoutAt.slice(firstColon + 1) : withoutAt;

    const { db } = await import("./db");
    const { emailMessages, emailEnrichments } = await import("@shared/schema");
    const { getCurrentPrincipalOrSystem } = await import("./principal-context");
    const { combineWithVisibleScope } = await import("./scoped-storage");
    const { and: andOp, asc: ascOp, desc: descOp, eq: eqOp } = await import("drizzle-orm");
    const principal = getCurrentPrincipalOrSystem();
    const emailScope = { ownerUserId: emailMessages.ownerUserId, accountId: emailMessages.principalAccountId };

    let accountId = explicitAccountId;
    let providerThreadId: string | null = null;
    let messageId: number | null = null;

    if (refType === "email_message") {
      messageId = Number(refId);
      if (!Number.isFinite(messageId)) return { result: `Invalid email_message ref: ${rawRef}`, error: true };
      const [msg] = await db.select({ accountId: emailMessages.accountId, providerThreadId: emailMessages.providerThreadId, providerMessageId: emailMessages.providerMessageId })
        .from(emailMessages)
        .where(combineWithVisibleScope(principal, emailScope, eqOp(emailMessages.id, messageId)))
        .limit(1);
      if (!msg) return { result: `Email message ${messageId} not found.`, error: true };
      accountId = msg.accountId;
      providerThreadId = msg.providerThreadId || msg.providerMessageId;
    } else {
      const idColon = refId.indexOf(":");
      if (idColon > 0) {
        accountId = refId.slice(0, idColon);
        providerThreadId = refId.slice(idColon + 1);
      } else {
        providerThreadId = refId;
      }
    }

    if (!providerThreadId) return { result: `Invalid email thread ref: ${rawRef}`, error: true };

    const threadConditions = [eqOp(emailMessages.providerThreadId, providerThreadId)];
    if (accountId) threadConditions.push(eqOp(emailMessages.accountId, accountId));
    const messages = await db.select({
      id: emailMessages.id,
      providerMessageId: emailMessages.providerMessageId,
      providerThreadId: emailMessages.providerThreadId,
      accountId: emailMessages.accountId,
      subject: emailMessages.subject,
      fromAddress: emailMessages.fromAddress,
      toAddresses: emailMessages.toAddresses,
      ccAddresses: emailMessages.ccAddresses,
      date: emailMessages.date,
      direction: emailMessages.direction,
      triageStatus: emailMessages.triageStatus,
      triageTier: emailMessages.triageTier,
      triageReason: emailMessages.triageReason,
      snippet: emailMessages.snippet,
      bodyText: emailMessages.bodyText,
      isDone: emailMessages.isDone,
    }).from(emailMessages)
      .where(combineWithVisibleScope(principal, emailScope, andOp(...threadConditions)))
      .orderBy(ascOp(emailMessages.date))
      .limit(50);

    if (messages.length === 0) {
      return { result: `Email thread ${providerThreadId} not found.`, error: true };
    }

    const latest = messages[messages.length - 1];
    const [enrichment] = await db.select().from(emailEnrichments)
      .where(andOp(eqOp(emailEnrichments.providerThreadId, providerThreadId), eqOp(emailEnrichments.accountId, latest.accountId)))
      .orderBy(descOp(emailEnrichments.updatedAt))
      .limit(1);

    return { result: safeStringify({
      ref: rawRef,
      type: "email_thread",
      canonical: `@email_thread:${latest.accountId}:${providerThreadId}`,
      accountId: latest.accountId,
      providerThreadId,
      latestMessageId: latest.id,
      subject: latest.subject,
      messageCount: messages.length,
      messages,
      enrichment: enrichment ? {
        id: enrichment.id,
        summary: enrichment.summary,
        decisions: enrichment.decisions,
        actions: enrichment.actions,
        dismissed: enrichment.dismissed,
        updatedAt: enrichment.updatedAt,
      } : null,
    }, { label: "bridge.gmail.email_ref" }) };
  }

  if (subAction === "get_message") {
    const messageId = args.message_id;
    if (!messageId) {
      return { result: "Missing 'message_id' parameter.", error: true };
    }
    const { db } = await import("./db");
    const { emailMessages, emailEnrichments } = await import("@shared/schema");
    const { eq: eqOp } = await import("drizzle-orm");
    const [msg] = await db.select().from(emailMessages).where(eqOp(emailMessages.id, Number(messageId))).limit(1);
    if (!msg) {
      return { result: `Email message ${messageId} not found.`, error: true };
    }
    // Check for enrichment row
    let enrichment = null;
    if (msg.providerThreadId) {
      const { and: andOp } = await import("drizzle-orm");
      const [enr] = await db.select().from(emailEnrichments)
        .where(andOp(
          eqOp(emailEnrichments.providerThreadId, msg.providerThreadId),
          eqOp(emailEnrichments.accountId, msg.accountId),
        )).limit(1);
      enrichment = enr || null;
    }
    return { result: safeStringify({
      id: msg.id,
      providerMessageId: msg.providerMessageId,
      providerThreadId: msg.providerThreadId,
      accountId: msg.accountId,
      ownerUserId: msg.ownerUserId,
      subject: msg.subject,
      fromAddress: msg.fromAddress,
      date: msg.date,
      triageStatus: msg.triageStatus,
      triageTier: msg.triageTier,
      triageReason: msg.triageReason,
      isDone: msg.isDone,
      direction: msg.direction,
      hasEnrichmentRow: !!enrichment,
      enrichment: enrichment ? {
        id: enrichment.id,
        summary: enrichment.summary,
        dismissed: enrichment.dismissed,
        createdAt: enrichment.createdAt,
      } : null,
    }, { label: "bridge.gmail.message_detail" }) };
  }

  if (subAction === "diagnose") {
    const counts = await storage.getEmailPipelineCounts();
    const sampleLimit = Math.min(Number(args.limit) || 50, 200);
    const unenriched = await storage.getUnenrichedTriagedEmails(sampleLimit);
    const unenrichedSummary = unenriched.map(e => ({
      id: e.id,
      providerThreadId: e.providerThreadId,
      providerMessageId: e.providerMessageId,
      accountId: e.accountId,
      triageStatus: e.triageStatus,
      triageTier: e.triageTier,
      isDone: e.isDone,
      subject: e.subject?.slice(0, 80),
    }));

    const exactComparison = counts.awaitingEnrichment <= sampleLimit && unenriched.length < sampleLimit;
    const divergence = exactComparison && counts.awaitingEnrichment !== unenriched.length;
    const sampleNote = !exactComparison
      ? `Sample only: getUnenrichedTriagedEmails returned ${unenriched.length}/${sampleLimit} rows from ${counts.awaitingEnrichment} awaiting. No divergence conclusion from a capped sample.`
      : "Exact comparison: sample covers the full awaiting set.";

    return { result: safeStringify({
      pipelineCounts: counts,
      unenrichedQuery: { sampleCount: unenriched.length, sampleLimit, emails: unenrichedSummary },
      exactComparison,
      divergence,
      divergenceNote: divergence
        ? `DIVERGENCE: getEmailPipelineCounts says ${counts.awaitingEnrichment} awaiting, getUnenrichedTriagedEmails returns ${unenriched.length}. These should agree when the sample is complete.`
        : sampleNote,
    }, { label: "bridge.gmail.diagnose" }) };
  }

  if (subAction === "run_downstream") {
    log.log(`Manual run_downstream triggered via tool`);
    const counts = await storage.getEmailPipelineCounts();
    log.log(`run_downstream counts: untriaged=${counts.untriaged} awaitingEnrichment=${counts.awaitingEnrichment} reviewReady=${counts.reviewReady}`);

    let triageResult = null;
    if (counts.untriaged > 0) {
      const { runTriagePipeline } = await import("./triage-runner");
      triageResult = await runTriagePipeline();
      log.log(`run_downstream triage: processed=${triageResult.processed} triaged=${triageResult.triaged} status=${triageResult.status}`);
    }

    const afterCounts = await storage.getEmailPipelineCounts();
    let enrichmentResult = null;
    if (afterCounts.awaitingEnrichment > 0) {
      const { runEnrichment } = await import("./email-enrichment");
      enrichmentResult = await runEnrichment();
      log.log(`run_downstream enrichment: dismissed=${enrichmentResult.dismissed} runStatus=${enrichmentResult.runStatus}`);
    }

    const finalCounts = await storage.getEmailPipelineCounts();
    return { result: safeStringify({
      beforeCounts: counts,
      triageResult: triageResult ? { processed: triageResult.processed, triaged: triageResult.triaged, status: triageResult.status } : "skipped (untriaged=0)",
      afterTriageCounts: afterCounts,
      enrichmentResult: enrichmentResult ? { dismissed: enrichmentResult.dismissed, runStatus: enrichmentResult.runStatus } : "skipped (awaitingEnrichment=0)",
      finalCounts,
    }, { label: "bridge.gmail.run_downstream" }) };
  }

  return { result: `Unknown cache_action "${subAction}". Use "get_untriaged", "mark_triaged", "get_unenriched", "store_enrichment", "search", "sync_status", "pipeline_counts", "get_message", "diagnose", or "run_downstream".`, error: true };
}

const gmailSubHandlers: Record<string, (args: Record<string, any>) => Promise<ToolHandlerResult>> = {
  status: handleGmailStatus,
  search: handleGmailSearch,
  read: handleGmailRead,
  batch_read: handleGmailBatchRead,
  draft: handleGmailDraft,
  reply: handleGmailReply,
  update_draft: handleGmailDraftUpdate,
  recent: handleGmailRecent,
  download_attachment: handleGmailDownloadAttachment,
  triage_log: handleGmailTriageLog,
  email_cache: handleGmailEmailCache,
};

const STRATEGY_ACTIONS = "list_strategies, get_strategy, create_strategy, update_strategy, delete_strategy, list_actors, get_actor, add_actor, update_actor, remove_actor, get_move_tree, get_move, get_move_path, create_move, update_move, delete_move, reparent_move, list_child_moves, list_move_definitions, get_move_definition, create_move_definition, update_move_definition, delete_move_definition, set_actor_states, link_assumption_to_move, unlink_assumption_from_move, list_notes, add_note, update_note, delete_note, list_context, add_context, update_context, delete_context, add_end_condition, list_end_conditions, update_end_condition, delete_end_condition, add_assumption, list_assumptions, update_assumption, delete_assumption, cascade_assumption, list_artifacts, get_artifact, create_artifact, delete_artifact, evaluate_move, list_states, get_state, create_state, update_state, delete_state, set_end_condition_effect";

async function handleStrategyListStrategies(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const list = await ss.getStrategies();
  if (list.length === 0) return { result: "No strategies yet." };
  const lines = list.map((g: any) => `- **${g.title}** (id: ${g.id})`);
  return { result: `${list.length} strategies:\n${lines.join("\n")}` };
}

async function handleStrategyGetStrategy(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.goalId;
  if (!id) return { result: "Missing goalId. Call list_strategies first to get available strategy IDs.", error: true };
  const strategy = await ss.getStrategy(id);
  if (!strategy) return { result: `Strategy ${id} not found`, error: true };
  const actors = await ss.getActors(id);
  const moves = await ss.getMoveTree(id);
  const assumptions = await ss.getAssumptions(id);
  const endConditions = await ss.getEndConditions(id);
  const contextEntries = await ss.getContextEntries(id);
  const parts = [`**${strategy.title}** (id: ${strategy.id})`];
  if (strategy.description) parts.push(`Description: ${strategy.description}`);
  parts.push(`Actors: ${actors.length}, Moves: ${moves.length}, Assumptions: ${assumptions.length}, End Conditions: ${endConditions.length}, Notes: ${contextEntries.length}`);
  return { result: parts.join("\n") };
}

async function handleStrategyCreateStrategy(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const title = args.title;
  if (!title) return { result: "Missing strategy title", error: true };
  const existing = await ss.getStrategies();
  const normalizedTitle = title.toLowerCase().trim();
  const similar = existing.find((g: any) => {
    const existingNorm = g.title.toLowerCase().trim();
    return existingNorm === normalizedTitle || existingNorm.includes(normalizedTitle) || normalizedTitle.includes(existingNorm);
  });
  if (similar) {
    return { result: `A strategy with a similar title already exists: "${similar.title}" (ID: ${similar.id}). Use update_strategy with strategyId="${similar.id}" to modify it, or provide a distinctly different title to create_strategy.`, error: true };
  }
  const strategy = await ss.createStrategy({ title, description: args.description || "" });
  return { result: `Strategy created: "${strategy.title}" (ID: ${strategy.id})` };
}

async function handleStrategyUpdateStrategy(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.goalId;
  if (!id) return { result: "Missing goalId. Call list_strategies first to get available strategy IDs.", error: true };
  const updates: Record<string, any> = {};
  if (args.title) updates.title = args.title;
  if (args.description) updates.description = args.description;
  const strategy = await ss.updateStrategy(id, updates);
  if (!strategy) return { result: `Strategy ${id} not found`, error: true };
  return { result: `Strategy updated: "${strategy.title}" — ${Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(", ")}` };
}

async function handleStrategyDeleteStrategy(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.goalId;
  if (!id) return { result: "Missing goalId. Call list_strategies first to get available strategy IDs.", error: true };
  const deleted = await ss.deleteStrategy(id);
  if (!deleted) return { result: `Strategy ${id} not found`, error: true };
  return { result: `Strategy ${id} deleted` };
}

async function handleStrategyListActors(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const actors = await ss.getActors(goalId);
  if (actors.length === 0) return { result: "No actors for this strategy." };
  const lines = actors.map((a: any) => {
    const inf = `${Math.round((a.influence ?? 0.5) * 100)}% influence`;
    return `- **${a.name}** (id: ${a.id}, ${inf}) [person: ${a.personId}]`;
  });
  return { result: `${actors.length} actors:\n${lines.join("\n")}` };
}

async function handleStrategyGetActor(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing actor id", error: true };
  const actor = await ss.getActor(id);
  if (!actor) return { result: `Actor ${id} not found`, error: true };
  const parts = [`**${actor.name}** (id: ${actor.id})`];
  parts.push(`Influence: ${Math.round((actor.influence ?? 0.5) * 100)}%`);
  if (actor.notes) parts.push(`Notes: ${actor.notes}`);
  parts.push(`Person ID: ${actor.personId}`);
  return { result: parts.join("\n") };
}

async function handleStrategyAddActor(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const name = args.name;
  if (!name) return { result: "Missing actor name", error: true };
  const personId = args.personId;
  if (!personId) return { result: "Missing personId - actors must be linked to a person", error: true };
  const influence = Math.max(0, Math.min(1, args.influence ?? 0.5));
  const actor = await ss.createActor({ goalId, name, notes: args.notes || "", personId, influence });
  return { result: `Actor added: "${actor.name}" (ID: ${actor.id}, influence: ${Math.round((actor.influence ?? 0.5) * 100)}%)` };
}

async function handleStrategyUpdateActor(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing actor id", error: true };
  const updates: Record<string, any> = {};
  if (args.name) updates.name = args.name;
  if (args.notes) updates.notes = args.notes;
  if (args.influence !== undefined) updates.influence = Math.max(0, Math.min(1, args.influence));
  const actor = await ss.updateActor(id, updates);
  if (!actor) return { result: `Actor ${id} not found`, error: true };
  return { result: `Actor updated: "${actor.name}" — ${Object.entries(updates).map(([k, v]) => k === "influence" ? `influence: ${Math.round(v * 100)}%` : `${k}: ${v}`).join(", ")}` };
}

async function handleStrategyRemoveActor(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing actor id", error: true };
  const deleted = await ss.deleteActor(id);
  if (!deleted) return { result: `Actor ${id} not found`, error: true };
  return { result: `Actor ${id} removed` };
}

async function handleStrategyGetMoveTree(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const moves = await ss.getMoveTree(goalId);
  if (moves.length === 0) return { result: "No moves in this strategy's tree." };
  const treeActors = await ss.getActors(goalId);
  const treeActorMap = new Map(treeActors.map((a: any) => [a.id, a.name]));
  const lines = moves.map((m: any) => {
    const indent = "  ".repeat(m.depth);
    const prob = `${(m.probability * 100).toFixed(0)}%`;
    const actorName = m.actorId ? (treeActorMap.get(m.actorId) || "Unknown") : "";
    const actorStr = actorName ? ` by ${actorName}` : "";
    const ref = m.refId ? ` #${m.refId}` : "";
    const states = (m.actorStates as any[] || []);
    const stateStr = states.length > 0
      ? ` | states: ${states.map((s: any) => `${treeActorMap.get(s.actorId) || s.actorId}: "${s.state}"`).join(", ")}`
      : "";
    const idPart = ref ? `${ref}, prob: ${prob}` : `prob: ${prob}`;
    return `${indent}- [${m.status}] **${m.title}**${actorStr} (${idPart})${stateStr}`;
  });
  return { result: `${moves.length} moves:\n${lines.join("\n")}` };
}

async function handleStrategyGetMove(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.moveId;
  if (!id) return { result: "Missing moveId", error: true };
  const move = await ss.resolveMoveInstance(id);
  if (!move) return { result: `Move ${id} not found`, error: true };
  const moveActors = await ss.getActors(move.goalId);
  const moveActorMap = new Map(moveActors.map((a: any) => [a.id, a.name]));
  const actorName = move.actorId ? (moveActorMap.get(move.actorId) || "Unknown") : "";
  const ref = (move as any).refId ? `#${(move as any).refId}` : "";
  const idLabel = ref ? `${ref}, id: ${move.id}` : `id: ${move.id}`;
  const parts = [`**${move.title}**${actorName ? ` by ${actorName}` : ""} (${idLabel}, ${move.status})`];
  parts.push(`Probability: ${(move.probability * 100).toFixed(0)}%, Depth: ${move.depth}`);
  if (move.description) parts.push(`Description: ${move.description}`);
  if (move.evaluation) parts.push(`Analysis: ${move.evaluation}`);
  if (move.impact) parts.push(`Impact: ${move.impact}`);
  parts.push(`Source: ${move.source}`);

  const historyPath = await ss.getMovePath(id);
  if (historyPath.length > 1) {
    const historyLines = historyPath.map((h: any, i: number) => {
      const hActor = h.actorId ? (moveActorMap.get(h.actorId) || "Unknown") : "—";
      const hRef = h.refId ? `#${h.refId}` : "";
      const marker = h.id === move.id ? " ← current" : "";
      const hIdPart = hRef ? `${hRef}, prob: ${(h.probability * 100).toFixed(0)}%` : `prob: ${(h.probability * 100).toFixed(0)}%`;
      return `  ${i + 1}. ${hActor}: **${h.title}** (${hIdPart})${marker}`;
    });
    parts.push(`\nMove History (${historyPath.length} moves):\n${historyLines.join("\n")}`);
  }

  const accumulatedStates = new Map<string, string>();
  for (const h of historyPath) {
    const hStates = (h.actorStates as any[] || []);
    for (const s of hStates) {
      if (s.state && s.state.trim() !== "") accumulatedStates.set(s.actorId, s.state);
    }
  }
  if (accumulatedStates.size > 0 || moveActors.length > 0) {
    const stateLines = moveActors.map((a: any) => {
      const state = accumulatedStates.get(a.id);
      const inf = `${Math.round((a.influence ?? 0.5) * 100)}% influence`;
      return state
        ? `  - ${a.name} (${inf}): "${state}"`
        : `  - ${a.name} (${inf}): (no state set)`;
    });
    parts.push(`\nAccumulated Actor States:\n${stateLines.join("\n")}`);
  }

  const moveAssumptions = await ss.getAssumptions(move.goalId);
  const assumptionLinks = await ss.getAssumptionLinksForGoal(move.goalId);
  const linkedAssumptionIds = new Set(assumptionLinks.filter((l: any) => l.moveInstanceId === move.id).map((l: any) => l.assumptionId));
  const linked = moveAssumptions.filter((a: any) => linkedAssumptionIds.has(a.id));
  if (linked.length > 0) {
    const assumptionLines = linked.map((a: any) => `  - "${a.title}" (prob: ${(a.probability * 100).toFixed(0)}%)`);
    parts.push(`Linked Assumptions:\n${assumptionLines.join("\n")}`);
  }

  const goalStates = await ss.getStates(move.goalId);
  const stateMap = new Map(goalStates.map((s: any) => [s.id, s.name]));
  if (move.parentStateId) {
    parts.push(`Parent State: "${stateMap.get(move.parentStateId) || "?"}" (id: ${move.parentStateId})`);
  } else if (move.parentMoveInstanceId) {
    parts.push(`Parent Move: ${move.parentMoveInstanceId}`);
  }
  if (move.terminatingStateId) {
    parts.push(`Terminating State: "${stateMap.get(move.terminatingStateId) || "?"}" (id: ${move.terminatingStateId})`);
  }

  const moveEffects = await ss.getMoveEndConditionEffects(move.id);
  if (moveEffects.length > 0) {
    const ecs = await ss.getEndConditions(move.goalId);
    const ecMap = new Map(ecs.map((e: any) => [e.id, e]));
    const effectLines = moveEffects.map((e: any) => {
      const ec: any = ecMap.get(e.endConditionId);
      const label = ec ? `"${ec.title}"${ec.isRequired ? " [required]" : ""}` : e.endConditionId;
      return `  - ${e.effect.toUpperCase()}: ${label}`;
    });
    parts.push(`End Condition Effects:\n${effectLines.join("\n")}`);
  }

  return { result: parts.join("\n") };
}

async function handleStrategyGetMovePath(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.moveId;
  if (!id) return { result: "Missing move id", error: true };
  const resolvedMove = await ss.resolveMoveInstance(id);
  if (!resolvedMove) return { result: `Move ${id} not found`, error: true };
  const path = await ss.getMovePath(resolvedMove.id);
  if (path.length === 0) return { result: `Move ${id} not found`, error: true };
  const pathActors = await ss.getActors(path[0].goalId);
  const pathActorMap = new Map(pathActors.map((a: any) => [a.id, a.name]));
  const accStates = new Map<string, string>();
  const lines = path.map((m: any) => {
    const prefix = m.depth === 0 ? "ROOT" : `Depth ${m.depth}`;
    const actorName = m.actorId ? (pathActorMap.get(m.actorId) || "Unknown") : "—";
    const ref = m.refId ? `#${m.refId}` : "";
    const mStates = (m.actorStates as any[] || []);
    const changes: string[] = [];
    for (const s of mStates) {
      if (s.state && s.state.trim() !== "" && accStates.get(s.actorId) !== s.state) {
        changes.push(`${pathActorMap.get(s.actorId) || s.actorId}: "${s.state}"`);
      }
      if (s.state && s.state.trim() !== "") accStates.set(s.actorId, s.state);
    }
    const changeStr = changes.length > 0 ? ` | state changes: ${changes.join(", ")}` : "";
    const pIdPart = ref ? `${ref}, prob: ${(m.probability * 100).toFixed(0)}%` : `prob: ${(m.probability * 100).toFixed(0)}%`;
    return `[${prefix}] ${actorName}: ${m.title} (${pIdPart}, ${m.status})${changeStr}`;
  });
  return { result: `Path (${path.length} moves):\n${lines.join("\n")}` };
}

async function applyMoveEcEffectsArg(args: Record<string, any>, moveId: string, ss: any): Promise<void> {
  const list: Array<{ endConditionId: string; effect: "satisfies" | "blocks" | "none" }> = Array.isArray(args.endConditionEffects) ? args.endConditionEffects : [];
  for (const e of list) {
    if (!e?.endConditionId || !e?.effect) continue;
    if (!["satisfies", "blocks", "none"].includes(e.effect)) continue;
    await ss.setMoveEndConditionEffect(moveId, e.endConditionId, e.effect);
  }
}

async function handleStrategyCreateMove(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const title = args.title;
  if (!title) return { result: "Missing move title", error: true };
  const moveDefinitionId = args.moveDefinitionId;
  if (!moveDefinitionId) return { result: "Missing moveDefinitionId. You must instantiate from an existing move definition. Use list_move_definitions to find one, or create_move_definition to create one first.", error: true };

  const moveDef = await ss.getMoveDefinition(moveDefinitionId);
  if (!moveDef) return { result: `Move definition ${moveDefinitionId} not found`, error: true };

  const data: Record<string, any> = {
    goalId, title, description: args.description || "", evaluation: args.analysis || "",
    impact: args.impact || "", actorStates: args.actorStates || [],
    probability: args.probability ?? 0.5, status: args.status || "unexplored", source: args.source || "manual",
    actorId: moveDef.actorId, moveDefinitionId,
    parentMoveInstanceId: args.parentMoveInstanceId || null,
    parentStateId: args.parentStateId || null,
    terminatingStateId: args.terminatingStateId || null,
    depth: 0, path: "",
  };

  if (data.parentMoveInstanceId) {
    const parent = await ss.resolveMoveInstance(data.parentMoveInstanceId);
    if (parent) {
      data.parentMoveInstanceId = parent.id;
      data.depth = parent.depth + 1;
      data.path = parent.path ? `${parent.path}/${parent.id}` : parent.id;
    }
  }

  const move = await ss.createMoveInstance(data);
  await applyMoveEcEffectsArg(args, move.id, ss);
  const ref = (move as any).refId ? `#${(move as any).refId}` : "";
  const createLabel = ref ? `${ref}, ID: ${move.id}` : `ID: ${move.id}`;
  return { result: `Move created: "${move.title}" (${createLabel}, depth: ${move.depth}, actor: ${moveDef.actorId})` };
}

async function handleStrategyUpdateMove(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.moveId;
  if (!id) return { result: "Missing move id", error: true };
  const resolvedUpdate = await ss.resolveMoveInstance(id);
  if (!resolvedUpdate) return { result: `Move ${id} not found`, error: true };
  const updates: Record<string, any> = {};
  if (args.title) updates.title = args.title;
  if (args.description) updates.description = args.description;
  if (args.analysis) updates.evaluation = args.analysis;
  if (args.impact) updates.impact = args.impact;
  if (args.probability !== undefined) updates.probability = args.probability;
  if (args.status) updates.status = args.status;
  if (args.actorStates) updates.actorStates = args.actorStates;
  if (args.parentStateId !== undefined) updates.parentStateId = args.parentStateId || null;
  if (args.terminatingStateId !== undefined) updates.terminatingStateId = args.terminatingStateId || null;
  const move = await ss.updateMoveInstance(resolvedUpdate.id, updates);
  if (!move) return { result: `Move ${id} not found`, error: true };
  await applyMoveEcEffectsArg(args, move.id, ss);
  return { result: `Move updated: "${move.title}" — ${Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(", ")}` };
}

async function handleStrategyListStates(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId", error: true };
  const states = await ss.getStates(goalId);
  if (states.length === 0) return { result: "No states defined for this strategy." };
  const lines = states.map((s: any) => `- ${s.name} (ID: ${s.id})${s.description ? ` — ${s.description}` : ""}`);
  return { result: `${states.length} state(s):\n${lines.join("\n")}` };
}

async function handleStrategyCreateState(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  const name = args.name;
  if (!goalId || !name) return { result: "Missing goalId or name", error: true };
  const state = await ss.createState({ goalId, name, description: args.description || "" });
  return { result: `State created: "${state.name}" (ID: ${state.id})` };
}

async function handleStrategyGetState(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.stateId;
  if (!id) return { result: "Missing stateId", error: true };
  const state = await ss.getState(id);
  if (!state) return { result: `State ${id} not found`, error: true };
  const refs = await ss.getStateReferences(id);
  const lines = [
    `State: ${state.name} (ID: ${state.id})`,
    state.description ? `Description: ${state.description}` : "",
    `Reached by ${refs.terminatingMoves.length} move(s); branches into ${refs.childMoves.length} move(s).`,
  ].filter(Boolean);
  return { result: lines.join("\n") };
}

async function handleStrategyUpdateState(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.stateId;
  if (!id) return { result: "Missing stateId", error: true };
  const updates: Record<string, any> = {};
  if (args.name !== undefined) updates.name = args.name;
  if (args.description !== undefined) updates.description = args.description;
  const state = await ss.updateState(id, updates);
  if (!state) return { result: `State ${id} not found`, error: true };
  return { result: `State updated: "${state.name}"` };
}

async function handleStrategyDeleteState(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.stateId;
  if (!id) return { result: "Missing stateId", error: true };
  const result = await ss.deleteState(id);
  if (!result.deleted) return { result: result.reason || `State ${id} not found`, error: true };
  return { result: `State ${id} deleted` };
}

async function handleStrategySetEndConditionEffect(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const moveId = args.moveId;
  const endConditionId = args.endConditionId;
  const effect = args.effect;
  if (!moveId || !endConditionId || !effect) return { result: "Missing moveId, endConditionId, or effect", error: true };
  if (!["satisfies", "blocks", "none"].includes(effect)) return { result: "effect must be one of: satisfies, blocks, none", error: true };
  const resolved = await ss.resolveMoveInstance(moveId);
  if (!resolved) return { result: `Move ${moveId} not found`, error: true };
  await ss.setMoveEndConditionEffect(resolved.id, endConditionId, effect);
  return { result: `End-condition effect set: move=${resolved.id}, endCondition=${endConditionId}, effect=${effect}` };
}

async function handleStrategyDeleteMove(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.moveId;
  if (!id) return { result: "Missing move id", error: true };
  const resolvedDelete = await ss.resolveMoveInstance(id);
  if (!resolvedDelete) return { result: `Move ${id} not found`, error: true };
  const deleted = await ss.deleteMoveInstanceAndChildren(resolvedDelete.id);
  if (!deleted) return { result: `Move ${id} not found`, error: true };
  return { result: `Move ${id} and all children deleted` };
}

async function handleStrategyReparentMove(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.moveId;
  if (!id) return { result: "Missing move id", error: true };
  const resolved = await ss.resolveMoveInstance(id);
  if (!resolved) return { result: `Move ${id} not found`, error: true };

  const newParentRaw = args.newParentId ?? args.parentMoveInstanceId ?? undefined;
  let newParentId: string | null = null;
  if (newParentRaw !== undefined && newParentRaw !== null) {
    const resolvedParent = await ss.resolveMoveInstance(newParentRaw);
    if (!resolvedParent) return { result: `New parent move ${newParentRaw} not found`, error: true };
    newParentId = resolvedParent.id;
  }

  try {
    const moved = await ss.reparentMoveInstance(resolved.id, newParentId);
    if (!moved) return { result: `Failed to reparent move ${id}`, error: true };
    return { result: `Move "${moved.title}" reparented successfully (new depth: ${moved.depth}, parent: ${newParentId || "root"})` };
  } catch (e: any) {
    if (e.message?.includes("Circular") || e.message?.includes("Cannot reparent")) {
      return { result: e.message, error: true };
    }
    throw e;
  }
}

async function handleStrategyListChildMoves(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const parentId = args.parentId;
  if (!parentId) return { result: "Missing parentId / moveId", error: true };
  const resolvedParent = await ss.resolveMoveInstance(parentId);
  const resolvedParentId = resolvedParent?.id || parentId;
  const children = await ss.getChildMoveInstances(resolvedParentId);
  if (children.length === 0) return { result: "No child moves from this position." };
  const parentMove = resolvedParent;
  const parentStates = (parentMove?.actorStates as any[] || []);
  const parentStateMap = new Map(parentStates.map((s: any) => [s.actorId, s.state]));
  const childActors = await ss.getActors(children[0].goalId);
  const childActorMap = new Map(childActors.map((a: any) => [a.id, a.name]));
  const childAssumptions = await ss.getAssumptions(children[0].goalId);
  const childAssumptionLinks = await ss.getAssumptionLinksForGoal(children[0].goalId);
  const lines = children.map((c: any) => {
    const actorName = c.actorId ? (childActorMap.get(c.actorId) || "Unknown") : "—";
    const states = (c.actorStates as any[] || []);
    const changedStates = states.filter((s: any) => {
      const prev = parentStateMap.get(s.actorId);
      return s.state && s.state.trim() !== "" && prev !== s.state;
    });
    const stateStr = changedStates.length > 0
      ? ` | state changes: ${changedStates.map((s: any) => `${childActorMap.get(s.actorId) || s.actorId}: "${s.state}"`).join(", ")}`
      : "";
    const linkedCount = childAssumptionLinks.filter((l: any) => l.moveInstanceId === c.id).length;
    const assumptionStr = linkedCount > 0 ? ` | ${linkedCount} linked assumptions` : "";
    const ref = c.refId ? `#${c.refId}` : "";
    const cIdPart = ref ? `${ref}, ${c.source}, prob: ${(c.probability * 100).toFixed(0)}%` : `${c.source}, prob: ${(c.probability * 100).toFixed(0)}%`;
    return `- **${c.title}** by ${actorName} (${cIdPart})${stateStr}${assumptionStr}`;
  });
  return { result: `${children.length} child moves:\n${lines.join("\n")}` };
}

async function handleStrategyContextList(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const entries = await ss.getContextEntries(goalId);
  if (entries.length === 0) return { result: "No context entries for this strategy." };
  const lines = entries.map((e: any) => `- [${e.type}] ${e.content.slice(0, 100)}${e.content.length > 100 ? "..." : ""} (id: ${e.id})`);
  return { result: `${entries.length} context entries:\n${lines.join("\n")}` };
}

async function handleStrategyContextAdd(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const content = args.content;
  if (!content) return { result: "Missing content", error: true };
  const entry = await ss.createContextEntry({ goalId, type: args.type || "historical", content });
  return { result: `Context entry added (ID: ${entry.id}, type: ${entry.type})` };
}

async function handleStrategyContextUpdate(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing context entry id", error: true };
  const updates: Record<string, any> = {};
  if (args.content) updates.content = args.content;
  if (args.type) updates.type = args.type;
  const entry = await ss.updateContextEntry(id, updates);
  if (!entry) return { result: `Context entry ${id} not found`, error: true };
  return { result: `Context entry ${id} updated` };
}

async function handleStrategyContextDelete(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing context entry id", error: true };
  const deleted = await ss.deleteContextEntry(id);
  if (!deleted) return { result: `Context entry ${id} not found`, error: true };
  return { result: `Context entry ${id} deleted` };
}

async function handleStrategyListEndConditions(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const conditions = await ss.getEndConditions(goalId);
  if (conditions.length === 0) return { result: "No end conditions for this strategy." };
  const lines = conditions.map((c: any) => {
    const req = c.isRequired ? "[REQUIRED]" : "[OPTIONAL]";
    const sat = c.isSatisfied ? " [SATISFIED]" : "";
    return `- ${req}${sat} ${c.description} (id: ${c.id})`;
  });
  return { result: `${conditions.length} end conditions:\n${lines.join("\n")}` };
}

async function handleStrategyAddEndCondition(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const description = args.description;
  if (!description) return { result: "Missing description", error: true };
  const condition = await ss.createEndCondition({ goalId, description, isRequired: args.isRequired ?? false, isSatisfied: args.isSatisfied ?? false });
  return { result: `End condition added (ID: ${condition.id})` };
}

async function handleStrategyUpdateEndCondition(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing end condition id", error: true };
  const updates: Record<string, any> = {};
  if (args.description) updates.description = args.description;
  if (args.isRequired !== undefined) updates.isRequired = args.isRequired;
  if (args.isSatisfied !== undefined) updates.isSatisfied = args.isSatisfied;
  const condition = await ss.updateEndCondition(id, updates);
  if (!condition) return { result: `End condition ${id} not found`, error: true };
  return { result: `End condition ${id} updated` };
}

async function handleStrategyDeleteEndCondition(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing end condition id", error: true };
  const deleted = await ss.deleteEndCondition(id);
  if (!deleted) return { result: `End condition ${id} not found`, error: true };
  return { result: `End condition ${id} deleted` };
}

async function handleStrategyListAssumptions(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const assumptions = await ss.getAssumptions(goalId);
  if (assumptions.length === 0) return { result: "No assumptions for this strategy." };
  const assumptionLinks = await ss.getAssumptionLinksForGoal(goalId);
  const linkCountByAssumption = new Map<string, number>();
  for (const l of assumptionLinks) linkCountByAssumption.set(l.assumptionId, (linkCountByAssumption.get(l.assumptionId) || 0) + 1);
  const lines = assumptions.map((a: any) => {
    const linkCount = linkCountByAssumption.get(a.id) || 0;
    return `- **${a.title}** (id: ${a.id}, prob: ${(a.probability * 100).toFixed(0)}%)${linkCount > 0 ? ` — linked to ${linkCount} move(s)` : ""}`;
  });
  return { result: `${assumptions.length} assumptions:\n${lines.join("\n")}` };
}

async function handleStrategyAddAssumption(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const title = args.title;
  if (!title) return { result: "Missing assumption title", error: true };
  const assumption = await ss.createAssumption({ goalId, title, description: args.description || "", probability: args.probability ?? 0.5 });
  return { result: `Assumption added: "${assumption.title}" (ID: ${assumption.id}, prob: ${(assumption.probability * 100).toFixed(0)}%)` };
}

async function handleStrategyUpdateAssumption(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing assumption id", error: true };
  const updates: Record<string, any> = {};
  if (args.title) updates.title = args.title;
  if (args.description) updates.description = args.description;
  if (args.probability !== undefined) updates.probability = args.probability;
  const assumption = await ss.updateAssumption(id, updates);
  if (!assumption) return { result: `Assumption ${id} not found`, error: true };
  return { result: `Assumption updated: "${assumption.title}" — ${Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(", ")}` };
}

async function handleStrategyDeleteAssumption(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing assumption id", error: true };
  const deleted = await ss.deleteAssumption(id);
  if (!deleted) return { result: `Assumption ${id} not found`, error: true };
  return { result: `Assumption ${id} deleted` };
}

async function handleStrategyCascadeAssumption(args: Record<string, any>): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing assumption id", error: true };
  const { cascadeAssumption } = await import("./strategy-simulation");
  await cascadeAssumption(id);
  return { result: `Assumption ${id} cascaded — affected move probabilities recalculated` };
}

async function handleStrategySetActorStates(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const moveId = args.moveId;
  if (!moveId) return { result: "Missing moveId", error: true };
  if (!args.actorStates || !Array.isArray(args.actorStates)) return { result: "Missing actorStates array (expected [{actorId, state}])", error: true };
  const resolvedSetStates = await ss.resolveMoveInstance(moveId);
  if (!resolvedSetStates) return { result: `Move ${moveId} not found`, error: true };
  const move = await ss.updateMoveInstance(resolvedSetStates.id, { actorStates: args.actorStates });
  if (!move) return { result: `Move ${moveId} not found`, error: true };
  const stateActors = await ss.getActors(move.goalId);
  const stateActorMap = new Map(stateActors.map((a: any) => [a.id, a.name]));
  const stateLines = args.actorStates.map((s: any) => `  - ${stateActorMap.get(s.actorId) || s.actorId}: "${s.state}"`);
  return { result: `Actor states updated on move "${move.title}":\n${stateLines.join("\n")}` };
}

async function handleStrategyLinkAssumptionToMove(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const assumptionId = args.assumptionId;
  const moveId = args.moveId;
  const polarity = args.polarity === "negative" ? "negative" : "positive";
  if (!assumptionId) return { result: "Missing assumptionId", error: true };
  if (!moveId) return { result: "Missing moveId", error: true };
  const resolvedLink = await ss.resolveMoveInstance(moveId);
  if (!resolvedLink) return { result: `Move ${moveId} not found`, error: true };
  const assumption = await ss.getAssumption(assumptionId);
  if (!assumption) return { result: `Assumption ${assumptionId} not found`, error: true };
  await ss.createAssumptionLink({ assumptionId, moveInstanceId: resolvedLink.id, polarity });
  return { result: `Move ${moveId} linked to assumption "${assumption.title}" with polarity=${polarity}` };
}

async function handleStrategyUnlinkAssumptionFromMove(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const assumptionId = args.assumptionId;
  const moveId = args.moveId;
  if (!assumptionId) return { result: "Missing assumptionId", error: true };
  if (!moveId) return { result: "Missing moveId", error: true };
  const resolvedUnlink = await ss.resolveMoveInstance(moveId);
  if (!resolvedUnlink) return { result: `Move ${moveId} not found`, error: true };
  const assumption = await ss.getAssumption(assumptionId);
  if (!assumption) return { result: `Assumption ${assumptionId} not found`, error: true };
  const links = await ss.getAssumptionLinksForAssumption(assumptionId);
  const link = links.find((l: any) => l.moveInstanceId === resolvedUnlink.id);
  if (!link) return { result: `Move ${moveId} is not linked to assumption "${assumption.title}"` };
  await ss.deleteAssumptionLink(link.id);
  return { result: `Move ${moveId} unlinked from assumption "${assumption.title}"` };
}

async function handleStrategyListArtifacts(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const artifacts = await ss.getArtifacts(goalId);
  if (artifacts.length === 0) return { result: "No artifacts for this strategy." };
  const lines = artifacts.map((a: any) => {
    const sizeKB = (a.fileSize / 1024).toFixed(1);
    return `- **${a.fileName}** (${sizeKB} KB, ${a.contentType}, id: ${a.id}, path: ${a.objectPath})`;
  });
  return { result: `${artifacts.length} artifacts:\n${lines.join("\n")}\n\nUse get_artifact with the artifact id to read its content.` };
}

async function handleStrategyGetArtifact(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing artifact id. Call list_artifacts first.", error: true };
  const allGoalArtifacts = args.goalId ? await ss.getArtifacts(args.goalId) : [];
  let artifact = allGoalArtifacts.find((a: any) => a.id === id);
  if (!artifact) {
    const { db } = await import("./db");
    const { strategyArtifacts } = await import("@shared/models/strategy");
    const { eq } = await import("drizzle-orm");
    const [found] = await db.select().from(strategyArtifacts).where(eq(strategyArtifacts.id, id));
    artifact = found || null;
  }
  if (!artifact) return { result: `Artifact ${id} not found`, error: true };

  const textExts = [".md", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv", ".js", ".ts", ".py", ".sh", ".toml", ".ini", ".html", ".css", ".svg", ".log"];
  const textTypes = ["text/", "application/json", "application/xml", "application/javascript", "application/yaml", "application/toml"];
  const isText = textTypes.some(t => artifact!.contentType.startsWith(t)) ||
    (artifact.contentType === "application/octet-stream" && textExts.some(ext => artifact!.fileName.toLowerCase().endsWith(ext)));
  if (!isText) return { result: `Artifact "${artifact.fileName}" is a binary file (${artifact.contentType}) and cannot be read as text. View it in the Strategy UI instead.`, error: true };

  try {
    const storageService = objectStorageService;
    const objectPath = artifact.objectPath.startsWith("/objects/") ? artifact.objectPath : `/objects/${artifact.objectPath}`;
    const objectFile = await storageService.getObjectEntityFile(objectPath);
    const [buffer] = await objectFile.download();
    const content = buffer.toString("utf-8");
    const offset = typeof args?.offset === "number" && args.offset >= 0 ? args.offset : 0;
    const limit = typeof args?.limit === "number" && args.limit > 0 ? args.limit : undefined;
    if (offset > 0 || limit !== undefined) {
      const slice = limit !== undefined ? content.slice(offset, offset + limit) : content.slice(offset);
      return { result: `**${artifact.fileName}** (offset=${offset}, showing ${slice.length} of ${content.length} chars):\n\n${slice}` };
    }
    if (content.length > 50000) {
      const { indexAndArchiveWithFallback } = await import("./content-indexer");
      const refBlock = await indexAndArchiveWithFallback({
        content,
        sourceType: "file",
        sourceLabel: artifact.fileName,
      });
      return { result: `**${artifact.fileName}** (${content.length} chars):\n\n${refBlock}` };
    }
    return { result: `**${artifact.fileName}** (${content.length} chars):\n\n${content}` };
  } catch (err: any) {
    return { result: `Failed to read artifact "${artifact.fileName}": ${err.message}`, error: true };
  }
}

async function handleStrategyCreateArtifact(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const goalId = args.goalId;
  if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
  const fileName = args.fileName;
  if (!fileName) return { result: "Missing fileName (e.g. 'analysis.md')", error: true };
  const content = args.content;
  if (content === undefined || content === null) return { result: "Missing content — provide the text content to store", error: true };
  const MAX_ARTIFACT_SIZE = 50 * 1024;
  if (content.length > MAX_ARTIFACT_SIZE) return { result: `Content too large (${(content.length / 1024).toFixed(1)} KB). Maximum size is ${MAX_ARTIFACT_SIZE / 1024} KB.`, error: true };

  const { extname } = await import("path");
  const ext = extname(fileName).toLowerCase();
  if (ext && !TEXT_ARTIFACT_MIME_MAP[ext]) return { result: `Unsupported file extension "${ext}". create_artifact only supports text formats: ${Object.keys(TEXT_ARTIFACT_MIME_MAP).join(", ")}`, error: true };
  const contentType = TEXT_ARTIFACT_MIME_MAP[ext] || "text/plain";
  const contentBuffer = Buffer.from(content, "utf-8");

  try {
    const { objectPath } = await objectStorageService.uploadObjectEntity(contentBuffer, {
      extension: ext || ".md",
      contentType,
    });

    const artifact = await ss.createArtifact({ goalId, fileName, fileSize: contentBuffer.length, contentType, objectPath });
    return { result: `Artifact created: "${artifact.fileName}" (ID: ${artifact.id}, ${(contentBuffer.length / 1024).toFixed(1)} KB)` };
  } catch (err: any) {
    return { result: `Failed to create artifact: ${err.message}`, error: true };
  }
}

async function handleStrategyDeleteArtifact(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const id = args.id;
  if (!id) return { result: "Missing artifact id", error: true };
  const deleted = await ss.deleteArtifact(id);
  if (!deleted) return { result: `Artifact ${id} not found`, error: true };
  return { result: `Artifact ${id} deleted` };
}

async function handleStrategyMoveDefinitions(action: string, args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  switch (action) {
    case "list_move_definitions": {
      const goalId = args.goalId;
      const actorId = args.actorId;
      if (!goalId && !actorId) return { result: "Missing strategyId or actorId. Call list_strategies first to get strategyIds, then list_actors to get actorIds.", error: true };
      const defs = actorId ? await ss.getMoveDefinitionsByActor(actorId) : await ss.getMoveDefinitions(goalId);
      if (defs.length === 0) return { result: "No move definitions found." };
      const lines = defs.map((d: any) => `- ${d.title} (id: ${d.id}, actorId: ${d.actorId})${d.description ? `: ${d.description.slice(0, 100)}` : ""}`);
      return { result: `${defs.length} move definitions:\n${lines.join("\n")}` };
    }
    case "get_move_definition": {
      const id = args.id;
      if (!id) return { result: "Missing move definition id", error: true };
      const def = await ss.getMoveDefinition(id);
      if (!def) return { result: `Move definition ${id} not found`, error: true };
      const parts = [`**${def.title}** (id: ${def.id})`, `Actor: ${def.actorId}`, `Goal: ${def.goalId}`];
      if (def.description) parts.push(`Description: ${def.description}`);
      return { result: parts.join("\n") };
    }
    case "create_move_definition": {
      const goalId = args.goalId;
      const actorId = args.actorId;
      const title = args.title;
      if (!goalId) return { result: "Missing strategyId. Call list_strategies first to get available strategy IDs.", error: true };
      if (!actorId) return { result: "Missing actorId", error: true };
      if (!title) return { result: "Missing title", error: true };
      const def = await ss.createMoveDefinition({ goalId, actorId, title, description: args.description || "" });
      return { result: `Move definition created: "${def.title}" (id: ${def.id}, actorId: ${def.actorId}, goalId: ${def.goalId})` };
    }
    case "update_move_definition": {
      const id = args.id;
      if (!id) return { result: "Missing move definition id", error: true };
      const updates: Record<string, any> = {};
      if (args.title) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.actorId) updates.actorId = args.actorId;
      const def = await ss.updateMoveDefinition(id, updates);
      if (!def) return { result: `Move definition ${id} not found`, error: true };
      return { result: `Move definition updated: "${def.title}" — ${Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(", ")}` };
    }
    case "delete_move_definition": {
      const id = args.id;
      if (!id) return { result: "Missing move definition id", error: true };
      const deleted = await ss.deleteMoveDefinition(id);
      if (!deleted) return { result: `Move definition ${id} not found`, error: true };
      return { result: `Move definition ${id} deleted` };
    }
    default:
      return { result: `Unknown move definition action: ${action}`, error: true };
  }
}

async function handleStrategyEvaluateMove(args: Record<string, any>, ss: any): Promise<ToolHandlerResult> {
  const evalMoveId = args.moveId;
  if (!evalMoveId) return { result: "Missing moveId for evaluate_move", error: true };
  const resolvedEval = await ss.resolveMoveInstance(evalMoveId);
  if (!resolvedEval) return { result: `Move instance ${evalMoveId} not found`, error: true };
  const { evaluateMoveWithAgent } = await import("./strategy-simulation");
  const runId = await evaluateMoveWithAgent(resolvedEval.id, { awaitResult: true });
  const updatedMove = await ss.getMoveInstance(resolvedEval.id);
  const summary = [
    `Evaluation complete for "${resolvedEval.title}" (run ${runId}).`,
    updatedMove?.probability != null ? `Probability: ${(updatedMove.probability * 100).toFixed(0)}%` : null,
    updatedMove?.evaluation ? `Analysis: ${updatedMove.evaluation.slice(0, 800)}` : null,
  ].filter(Boolean).join("\n");
  return { result: summary };
}

type StrategySubHandler = (args: Record<string, any>, ss: any) => Promise<ToolHandlerResult>;

const strategySubHandlers: Record<string, StrategySubHandler> = {
  list_strategies: handleStrategyListStrategies,
  get_strategy: handleStrategyGetStrategy,
  create_strategy: handleStrategyCreateStrategy,
  update_strategy: handleStrategyUpdateStrategy,
  delete_strategy: handleStrategyDeleteStrategy,
  list_goals: handleStrategyListStrategies,
  get_goal: handleStrategyGetStrategy,
  create_goal: handleStrategyCreateStrategy,
  update_goal: handleStrategyUpdateStrategy,
  delete_goal: handleStrategyDeleteStrategy,
  list_actors: handleStrategyListActors,
  get_actor: handleStrategyGetActor,
  add_actor: handleStrategyAddActor,
  update_actor: handleStrategyUpdateActor,
  remove_actor: handleStrategyRemoveActor,
  get_move_tree: handleStrategyGetMoveTree,
  get_move: handleStrategyGetMove,
  get_move_path: handleStrategyGetMovePath,
  create_move: handleStrategyCreateMove,
  update_move: handleStrategyUpdateMove,
  delete_move: handleStrategyDeleteMove,
  reparent_move: handleStrategyReparentMove,
  list_child_moves: handleStrategyListChildMoves,
  list_notes: handleStrategyContextList,
  list_context: handleStrategyContextList,
  add_note: handleStrategyContextAdd,
  add_context: handleStrategyContextAdd,
  update_note: handleStrategyContextUpdate,
  update_context: handleStrategyContextUpdate,
  delete_note: handleStrategyContextDelete,
  delete_context: handleStrategyContextDelete,
  list_end_conditions: handleStrategyListEndConditions,
  add_end_condition: handleStrategyAddEndCondition,
  update_end_condition: handleStrategyUpdateEndCondition,
  delete_end_condition: handleStrategyDeleteEndCondition,
  list_assumptions: handleStrategyListAssumptions,
  add_assumption: handleStrategyAddAssumption,
  update_assumption: handleStrategyUpdateAssumption,
  delete_assumption: handleStrategyDeleteAssumption,
  cascade_assumption: (args) => handleStrategyCascadeAssumption(args),
  set_actor_states: handleStrategySetActorStates,
  link_assumption_to_move: handleStrategyLinkAssumptionToMove,
  unlink_assumption_from_move: handleStrategyUnlinkAssumptionFromMove,
  list_artifacts: handleStrategyListArtifacts,
  get_artifact: handleStrategyGetArtifact,
  create_artifact: handleStrategyCreateArtifact,
  delete_artifact: handleStrategyDeleteArtifact,
  list_move_definitions: (args, ss) => handleStrategyMoveDefinitions("list_move_definitions", args, ss),
  get_move_definition: (args, ss) => handleStrategyMoveDefinitions("get_move_definition", args, ss),
  create_move_definition: (args, ss) => handleStrategyMoveDefinitions("create_move_definition", args, ss),
  update_move_definition: (args, ss) => handleStrategyMoveDefinitions("update_move_definition", args, ss),
  delete_move_definition: (args, ss) => handleStrategyMoveDefinitions("delete_move_definition", args, ss),
  evaluate_move: handleStrategyEvaluateMove,
  list_states: handleStrategyListStates,
  get_state: handleStrategyGetState,
  create_state: handleStrategyCreateState,
  update_state: handleStrategyUpdateState,
  delete_state: handleStrategyDeleteState,
  set_end_condition_effect: handleStrategySetEndConditionEffect,
};

type NotionResolveAccountId = (a: Record<string, any>) => Promise<{ id: string } | { error: string }>;
type NotionModule = typeof import("./notion");

async function handleNotionStatus(notion: NotionModule): Promise<ToolHandlerResult> {
  const accounts = await notion.listNotionAccounts();
  if (accounts.length === 0) return { result: "Notion: no accounts connected. Add one in Settings > Integrations." };
  const lines = accounts.map(a => `- **${a.workspaceName}** (${a.label})`);
  return { result: `Notion: ${accounts.length} account(s) connected:\n${lines.join("\n")}` };
}

async function handleNotionSearch(args: Record<string, any>, resolveAccountId: NotionResolveAccountId, notion: NotionModule): Promise<ToolHandlerResult> {
  const resolved = await resolveAccountId(args);
  if ("error" in resolved) return { result: resolved.error, error: true };
  const query = args.query || "";
  const pages = await notion.searchPages(resolved.id, query, args.limit || 10);
  if (pages.length === 0) return { result: query ? `No Notion pages found for "${query}"` : "No pages found in Notion." };
  const lines = pages.map((p: any) => {
    const title = p.properties?.title?.title?.[0]?.plain_text || p.properties?.Name?.title?.[0]?.plain_text || "(untitled)";
    const lastEdited = p.last_edited_time ? ` — edited ${new Date(p.last_edited_time).toLocaleDateString()}` : "";
    return `- **${title}** (id: ${p.id})${lastEdited}`;
  });
  return { result: `Found ${pages.length} pages:\n${lines.join("\n")}` };
}

async function handleNotionGetPage(args: Record<string, any>, resolveAccountId: NotionResolveAccountId, notion: NotionModule): Promise<ToolHandlerResult> {
  const resolved = await resolveAccountId(args);
  if ("error" in resolved) return { result: resolved.error, error: true };
  const pageId = args.id;
  if (!pageId) return { result: "Missing page id", error: true };
  const page = await notion.getPage(resolved.id, pageId);
  const props = page.properties || {};
  const title = (props as any).title?.title?.[0]?.plain_text || (props as any).Name?.title?.[0]?.plain_text || "(untitled)";
  const lastEdited = page.last_edited_time ? new Date(page.last_edited_time as any).toLocaleString() : "unknown";
  const propLines = Object.entries(props)
    .filter(([k]) => k !== "title" && k !== "Name")
    .slice(0, 10)
    .map(([k, v]: [string, any]) => {
      if (v.type === "rich_text") return `  ${k}: ${v.rich_text?.[0]?.plain_text || ""}`;
      if (v.type === "select") return `  ${k}: ${v.select?.name || ""}`;
      if (v.type === "multi_select") return `  ${k}: ${v.multi_select?.map((s: any) => s.name).join(", ") || ""}`;
      if (v.type === "date") return `  ${k}: ${v.date?.start || ""}`;
      if (v.type === "number") return `  ${k}: ${v.number ?? ""}`;
      if (v.type === "checkbox") return `  ${k}: ${v.checkbox ? "Yes" : "No"}`;
      return `  ${k}: (${v.type})`;
    });
  return { result: `**${title}**\nLast edited: ${lastEdited}\n${propLines.length ? "Properties:\n" + propLines.join("\n") : ""}` };
}

async function handleNotionGetContent(args: Record<string, any>, resolveAccountId: NotionResolveAccountId, notion: NotionModule): Promise<ToolHandlerResult> {
  const resolved = await resolveAccountId(args);
  if ("error" in resolved) return { result: resolved.error, error: true };
  const pageId = args.id;
  if (!pageId) return { result: "Missing page id", error: true };
  const blocks = await notion.getPageContent(resolved.id, pageId);
  const lines = blocks.slice(0, 50).map((b: any) => {
    const type = b.type;
    const content = b[type];
    if (!content) return `[${type}]`;
    if (content.rich_text) {
      const text = content.rich_text.map((t: any) => t.plain_text).join("");
      if (type === "heading_1") return `# ${text}`;
      if (type === "heading_2") return `## ${text}`;
      if (type === "heading_3") return `### ${text}`;
      if (type === "bulleted_list_item") return `- ${text}`;
      if (type === "numbered_list_item") return `1. ${text}`;
      if (type === "to_do") return `${content.checked ? "[x]" : "[ ]"} ${text}`;
      return text;
    }
    if (type === "divider") return "---";
    if (type === "image") return `[image: ${content.external?.url || content.file?.url || "embedded"}]`;
    return `[${type}]`;
  });
  if (blocks.length > 50) lines.push(`... and ${blocks.length - 50} more blocks`);
  return { result: lines.join("\n") || "(empty page)" };
}

async function handleNotionListDatabases(args: Record<string, any>, resolveAccountId: NotionResolveAccountId, notion: NotionModule): Promise<ToolHandlerResult> {
  const resolved = await resolveAccountId(args);
  if ("error" in resolved) return { result: resolved.error, error: true };
  const dbs = await notion.searchDatabases(resolved.id, args.query, args.limit || 10);
  if (dbs.length === 0) return { result: "No databases found in Notion." };
  const lines = dbs.map((db: any) => {
    const title = db.title?.[0]?.plain_text || "(untitled)";
    return `- **${title}** (id: ${db.id})`;
  });
  return { result: `Found ${dbs.length} databases:\n${lines.join("\n")}` };
}

async function handleNotionQueryDatabase(args: Record<string, any>, resolveAccountId: NotionResolveAccountId, notion: NotionModule): Promise<ToolHandlerResult> {
  const resolved = await resolveAccountId(args);
  if ("error" in resolved) return { result: resolved.error, error: true };
  const dbId = args.id;
  if (!dbId) return { result: "Missing database id", error: true };
  const { results, hasMore } = await notion.queryDatabase(resolved.id, dbId, { pageSize: args.limit || 20 });
  if (results.length === 0) return { result: "No entries in this database." };
  const lines = results.map((row: any) => {
    const props = row.properties || {};
    const title = Object.values(props).find((v: any) => v.type === "title") as any;
    const name = title?.title?.[0]?.plain_text || "(untitled)";
    return `- **${name}** (id: ${row.id})`;
  });
  const more = hasMore ? `\n(more results available)` : "";
  return { result: `${results.length} entries:\n${lines.join("\n")}${more}` };
}

export interface CrossSessionDeps {
  storage: import("./chat-file-storage").IChatFileStorage;
  publishEvent?: (
    sessionKey: string,
    payload: {
      type: "cross_session_message";
      sessionId: string;
      fromSessionId: string;
      toSessionId: string;
      direction: "sibling" | "parent" | "child" | "direct";
      content: string;
      chainId: string;
      depth: number;
    },
  ) => void;
}

export async function handleCrossSessionMessage(
  args: Record<string, any>,
  direction: "sibling" | "parent" | "child",
  depsOverride?: CrossSessionDeps,
): Promise<ToolHandlerResult> {
  const fromSessionId: string | undefined = args._sessionId;
  const content: string = (args.content ?? "").toString();
  if (!fromSessionId) {
    return { result: "No active session — cross-session messaging requires an active conversation context.", error: true };
  }
  if (!content.trim()) {
    return { result: "Missing 'content' — message body cannot be empty.", error: true };
  }

  const storage = depsOverride?.storage || (await import("./chat-file-storage")).chatFileStorage;
  const {
    buildSessionFetcher,
    buildChildrenFetcher,
    buildRecentInboundFetcher,
    validateCrossSessionScope,
    resolveSiblingBySpawnReason,
    nextChainToken,
  } = await import("./session-tree");

  const sessFetch = buildSessionFetcher(storage);
  const childrenFetch = buildChildrenFetcher(storage);
  const inboundFetch = buildRecentInboundFetcher(storage);

  const caller = await sessFetch(fromSessionId);
  if (!caller) {
    return { result: `Caller session ${fromSessionId} not found.`, error: true };
  }

  let target: { id: string; parentSessionId?: string; sessionKey?: string | null; title?: string } | undefined;

  if (direction === "parent") {
    if (!caller.parentSessionId) {
      toolExec.warn(`[CrossSessionMsg] event=scope-reject from=${fromSessionId} direction=parent reason=no_parent`);
      return { result: "This session has no parent to message.", error: true };
    }
    target = await sessFetch(caller.parentSessionId);
    if (!target) {
      return { result: `Parent session ${caller.parentSessionId} not found.`, error: true };
    }
  } else if (direction === "child") {
    const toSessionId: string | undefined = args.toSessionId;
    const toSpawnReason: string | undefined = args.toSpawnReason;
    if (!toSessionId && !toSpawnReason) {
      return { result: "Missing target — provide 'toSessionId' or 'toSpawnReason' to identify the child.", error: true };
    }
    if (toSessionId) {
      target = await sessFetch(toSessionId);
      if (!target) {
        return { result: `Target session ${toSessionId} not found.`, error: true };
      }
    } else if (toSpawnReason) {
      // Resolve a child of the caller by spawn reason. Reuse
      // `resolveSiblingBySpawnReason` semantics by walking the caller's own
      // children directly (not siblings).
      const reason = toSpawnReason.trim();
      const children = await childrenFetch(fromSessionId);
      const exact = children.find(s => s.id !== fromSessionId && s.spawnReason === reason);
      let matched = exact;
      if (!matched) {
        matched = children.find(s => {
          if (s.id === fromSessionId) return false;
          if (s.spawnReason) return false;
          if (s.title === reason) return true;
          if (s.sessionKey === reason) return true;
          if (s.sessionKey === `auto:${reason}`) return true;
          return false;
        });
      }
      if (!matched) {
        toolExec.warn(`[CrossSessionMsg] event=scope-reject from=${fromSessionId} direction=child reason=spawn_reason_not_found spawnReason=${toSpawnReason}`);
        return { result: `No child session matched spawn reason "${toSpawnReason}".`, error: true };
      }
      target = matched;
    }
  } else {
    const toSessionId: string | undefined = args.toSessionId;
    const toSpawnReason: string | undefined = args.toSpawnReason;
    if (!toSessionId && !toSpawnReason) {
      return { result: "Missing target — provide 'toSessionId' or 'toSpawnReason'.", error: true };
    }
    if (toSessionId) {
      target = await sessFetch(toSessionId);
      if (!target) {
        return { result: `Target session ${toSessionId} not found.`, error: true };
      }
    } else if (toSpawnReason) {
      target = await resolveSiblingBySpawnReason(caller, toSpawnReason, childrenFetch);
      if (!target) {
        toolExec.warn(`[CrossSessionMsg] event=scope-reject from=${fromSessionId} direction=sibling reason=spawn_reason_not_found spawnReason=${toSpawnReason}`);
        return { result: `No sibling session matched spawn reason "${toSpawnReason}".`, error: true };
      }
    }
  }

  if (!target) {
    return { result: "Could not resolve target session.", error: true };
  }

  const scope = validateCrossSessionScope(caller, target, direction);
  if (!scope.ok) {
    toolExec.warn(`[CrossSessionMsg] event=scope-reject from=${fromSessionId} to=${target.id} direction=${direction} reason=${scope.reason}`);
    return { result: `Scope rejected: ${scope.reason}`, error: true };
  }

  const recentInbound = await inboundFetch(fromSessionId);
  const chain = nextChainToken(recentInbound);
  if (!chain.ok) {
    toolExec.warn(
      `[CrossSessionMsg] event=chain-cap-abort from=${fromSessionId} fromRunId=${caller.spawnerSkillRun || "-"} to=${target.id} toRunId=${target.spawnerSkillRun || "-"} direction=${direction} chainId=${chain.chainId} depth=${chain.depth} cap=${chain.cap}`,
    );
    return { result: chain.reason, error: true };
  }

  const { fromMessage, toMessage } = await storage.createCrossSessionMessage(
    fromSessionId,
    target.id,
    content,
    direction,
    { chainId: chain.chainId, depth: chain.depth },
  );

  const fromRunId = caller.spawnerSkillRun || "-";
  const toRunId = target.spawnerSkillRun || "-";
  toolExec.log(
    `[CrossSessionMsg] event=sent from=${fromSessionId} fromRunId=${fromRunId} to=${target.id} toRunId=${toRunId} direction=${direction} chainId=${chain.chainId} depth=${chain.depth} cap=${chain.cap} fromMsgId=${fromMessage?.id || "?"} contentLen=${content.length}`,
  );
  toolExec.log(
    `[CrossSessionMsg] event=receive sessionId=${target.id} runId=${toRunId} from=${fromSessionId} fromRunId=${fromRunId} direction=${direction} chainId=${chain.chainId} depth=${chain.depth} toMsgId=${toMessage?.id || "?"} contentLen=${content.length}`,
  );

  const publish =
    depsOverride?.publishEvent ||
    ((sessionKey: string, payload: any) => {
      eventBus.publish({
        category: "chat",
        event: "chat.cross_session_message",
        sessionKey,
        payload,
      });
    });

  try {
    const fromConv = await storage.getSession(fromSessionId);
    const toConv = await storage.getSession(target.id);
    const basePayload = {
      type: "cross_session_message" as const,
      fromSessionId,
      toSessionId: target.id,
      direction,
      content,
      chainId: chain.chainId,
      depth: chain.depth,
      fromLabel: fromConv?.title,
      toLabel: toConv?.title,
    };
    publish(fromConv?.sessionKey || `dashboard:${fromSessionId}`, { ...basePayload, sessionId: fromSessionId });
    if (target.id !== fromSessionId) {
      publish(toConv?.sessionKey || `dashboard:${target.id}`, { ...basePayload, sessionId: target.id });
    }
  } catch (e: any) {
    toolExec.warn(`[CrossSessionMsg] event publish failed: ${e?.message || e}`);
  }

  // When messaging a child session, trigger an agent run if none is active.
  // This uses the same execution path as spawn_child auto-start so child
  // sessions have one source of truth for response activation.
  if (direction === "child") {
    await triggerChildSessionResponse(target.id, "CrossSessionMsg");
  }

  return { result: `Sent ${direction} message to ${target.title || target.id} (${target.id}). Chain depth ${chain.depth}/${chain.cap}.` };
}


export async function handleAnySessionMessage(
  args: Record<string, any>,
  depsOverride?: CrossSessionDeps,
): Promise<ToolHandlerResult> {
  const fromSessionId: string | undefined = args._sessionId;
  const toSessionId: string | undefined = (args.toSessionId || args.sessionId)?.toString().trim();
  const content: string = (args.content ?? args.message ?? "").toString();

  if (!fromSessionId) {
    return { result: "No active session — session messaging requires an active conversation context.", error: true };
  }
  if (!toSessionId) {
    return { result: "Missing target — provide 'sessionId' or 'toSessionId'.", error: true };
  }
  if (!content.trim()) {
    return { result: "Missing 'content' — message body cannot be empty.", error: true };
  }
  if (toSessionId === fromSessionId) {
    return { result: "Cannot message self.", error: true };
  }

  const storage = depsOverride?.storage || (await import("./chat-file-storage")).chatFileStorage;
  const { buildSessionFetcher, buildRecentInboundFetcher, nextChainToken } = await import("./session-tree");
  const sessFetch = buildSessionFetcher(storage);
  const inboundFetch = buildRecentInboundFetcher(storage);

  const [caller, target] = await Promise.all([sessFetch(fromSessionId), sessFetch(toSessionId)]);
  if (!caller) {
    return { result: `Caller session ${fromSessionId} not found.`, error: true };
  }
  if (!target) {
    return { result: `Target session ${toSessionId} not found.`, error: true };
  }

  const recentInbound = await inboundFetch(fromSessionId);
  const chain = nextChainToken(recentInbound);
  if (!chain.ok) {
    toolExec.warn(
      `[CrossSessionMsg] event=chain-cap-abort from=${fromSessionId} fromRunId=${caller.spawnerSkillRun || "-"} to=${target.id} toRunId=${target.spawnerSkillRun || "-"} direction=direct chainId=${chain.chainId} depth=${chain.depth} cap=${chain.cap}`,
    );
    return { result: chain.reason, error: true };
  }

  const { fromMessage, toMessage } = await storage.createCrossSessionMessage(
    fromSessionId,
    target.id,
    content,
    "direct",
    { chainId: chain.chainId, depth: chain.depth },
  );

  const fromRunId = caller.spawnerSkillRun || "-";
  const toRunId = target.spawnerSkillRun || "-";
  toolExec.log(
    `[CrossSessionMsg] event=sent from=${fromSessionId} fromRunId=${fromRunId} to=${target.id} toRunId=${toRunId} direction=direct chainId=${chain.chainId} depth=${chain.depth} cap=${chain.cap} fromMsgId=${fromMessage?.id || "?"} contentLen=${content.length}`,
  );
  toolExec.log(
    `[CrossSessionMsg] event=receive sessionId=${target.id} runId=${toRunId} from=${fromSessionId} fromRunId=${fromRunId} direction=direct chainId=${chain.chainId} depth=${chain.depth} toMsgId=${toMessage?.id || "?"} contentLen=${content.length}`,
  );

  const publish =
    depsOverride?.publishEvent ||
    ((sessionKey: string, payload: any) => {
      eventBus.publish({
        category: "chat",
        event: "chat.cross_session_message",
        sessionKey,
        payload,
      });
    });

  try {
    const fromConv = await storage.getSession(fromSessionId);
    const toConv = await storage.getSession(target.id);
    const basePayload = {
      type: "cross_session_message" as const,
      fromSessionId,
      toSessionId: target.id,
      direction: "direct" as const,
      content,
      chainId: chain.chainId,
      depth: chain.depth,
      fromLabel: fromConv?.title,
      toLabel: toConv?.title,
    };
    publish(fromConv?.sessionKey || `dashboard:${fromSessionId}`, { ...basePayload, sessionId: fromSessionId });
    publish(toConv?.sessionKey || `dashboard:${target.id}`, { ...basePayload, sessionId: target.id });
  } catch (e: any) {
    toolExec.warn(`[CrossSessionMsg] direct event publish failed: ${e?.message || e}`);
  }

  await triggerChildSessionResponse(target.id, "session.send_message");

  return { result: `Sent direct message to ${target.title || target.id} (${target.id}). Chain depth ${chain.depth}/${chain.cap}.` };
}

export async function triggerChildSessionResponse(childSessionId: string, source: string): Promise<void> {
  try {
    const { triggerResponseOnChildSession } = await import("./autonomous-skill-runner");
    // Fire-and-forget: don't block the parent's tool return on the child run.
    // triggerResponseOnChildSession is idempotent via agentExecutor.hasActiveRunForSession.
    void triggerResponseOnChildSession(childSessionId).catch((err: unknown) => {
      toolExec.warn(`[${source}] triggerResponseOnChildSession failed for ${childSessionId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (importErr: any) {
    toolExec.warn(`[${source}] failed to import triggerResponseOnChildSession: ${importErr?.message || importErr}`);
  }
}

async function buildFallbackBrief(opts: {
  parentSessionId: string;
  childTopic: string;
  reason?: string;
}): Promise<string> {
  const { chatFileStorage } = await import("./chat-file-storage");
  const parent = await chatFileStorage.getSession(opts.parentSessionId);
  const messages = await chatFileStorage.getMessagesBySession(opts.parentSessionId);
  const recent = messages.slice(-10).filter(m => m.role === "user" || m.role === "assistant");
  const transcript = recent
    .map(m => `[${m.role}]: ${(m.content || "").slice(0, 800)}`)
    .join("\n\n");
  const lines: string[] = [];
  lines.push(`# Warm-start brief from parent session`);
  lines.push("");
  lines.push(`## Parent`);
  lines.push(`- Title: ${parent?.title || "(untitled)"}`);
  lines.push(`- Session ID: ${opts.parentSessionId}`);
  if (parent?.topics && parent.topics.length > 0) {
    lines.push(`- Topics: ${parent.topics.join(", ")}`);
  }
  lines.push("");
  lines.push(`## Spawn`);
  lines.push(`- Child topic: ${opts.childTopic}`);
  if (opts.reason) lines.push(`- Reason: ${opts.reason}`);
  lines.push("");
  if (transcript) {
    lines.push(`## Recent transcript (last ${recent.length} messages)`);
    lines.push(transcript);
  }
  return lines.join("\n");
}

async function buildWarmStartBrief(opts: {
  parentSessionId: string;
  childTopic: string;
  reason?: string;
}): Promise<string> {
  const { chatFileStorage } = await import("./chat-file-storage");
  const parent = await chatFileStorage.getSession(opts.parentSessionId);
  const messages = await chatFileStorage.getMessagesBySession(opts.parentSessionId);
  const userAssistantMsgs = messages.filter(m => m.role === "user" || m.role === "assistant");
  const keepRecent = Math.min(6, Math.floor(userAssistantMsgs.length / 2));
  const olderMessages = keepRecent > 0 && userAssistantMsgs.length > keepRecent
    ? userAssistantMsgs.slice(0, -keepRecent)
    : userAssistantMsgs.slice(0, Math.max(0, userAssistantMsgs.length - keepRecent));

  const serializedAll = userAssistantMsgs
    .map(m => `[${m.role}]: ${(m.content || "").slice(0, 2000)}`)
    .join("\n\n");

  // 1) generateTitleSummaryTags over the entire transcript for title/summary/tags.
  let summaryBlock = "";
  let tagsBlock = "";
  if (serializedAll.length > 80) {
    try {
      const { generateTitleSummaryTags } = await import("./memory/memory-enrichment");
      const tst = await generateTitleSummaryTags({
        content: serializedAll,
        source: `session:${opts.parentSessionId}`,
        title: parent?.title || null,
      });
      if (tst.summary) summaryBlock = tst.summary;
      const mergedTags = Array.from(new Set([...(parent?.topics ?? []), ...(tst.tags ?? [])]));
      if (mergedTags.length > 0) tagsBlock = mergedTags.join(", ");
    } catch (err: unknown) {
      toolExec.warn(`[buildWarmStartBrief] generateTitleSummaryTags failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!tagsBlock && parent?.topics && parent.topics.length > 0) {
    tagsBlock = parent.topics.join(", ");
  }

  // 2) chat-compactrunhistory-backed summarization for the older chunk.
  let condensedTranscript = "";
  if (olderMessages.length >= 4) {
    try {
      const { chatCompletion } = await import("./model-client");
      const { getPromptModulePromptEntry } = await import("./prompt-modules");
      const { ACTIVITY_FRAMING } = await import("./job-profiles");
      let systemMsg = "Summarize this conversation history concisely. Preserve key decisions, facts discussed, user requests, and any commitments made. Output a dense summary paragraph.";
      let maxTokens = 1500;
      try {
        const entry = await getPromptModulePromptEntry("chat-compactrunhistory", ACTIVITY_FRAMING);
        if (entry?.prompt) systemMsg = entry.prompt;
      } catch { /* keep defaults */ }
      const compactInput = olderMessages
        .map(m => `[${m.role}]: ${(m.content || "").length > 2000 ? m.content.slice(0, 2000) + "..." : m.content}`)
        .join("\n\n");
      const result = await chatCompletion({
        activity: ACTIVITY_FRAMING,
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: compactInput },
        ],
        maxTokens,
        metadata: { source: "warm-start-compaction", activity: ACTIVITY_FRAMING },
      });
      if (result?.content) condensedTranscript = result.content.trim();
    } catch (err: unknown) {
      toolExec.warn(`[buildWarmStartBrief] compactrunhistory summarization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3) Recent verbatim tail.
  const recentTail = userAssistantMsgs
    .slice(-keepRecent)
    .map(m => `[${m.role}]: ${(m.content || "").slice(0, 1200)}`)
    .join("\n\n");

  const lines: string[] = [];
  lines.push(`# Warm-start brief from parent session`);
  lines.push("");
  lines.push(`## Parent`);
  lines.push(`- Title: ${parent?.title || "(untitled)"}`);
  lines.push(`- Session ID: ${opts.parentSessionId}`);
  if (tagsBlock) lines.push(`- Topics: ${tagsBlock}`);
  lines.push("");
  lines.push(`## Spawn`);
  lines.push(`- Child topic: ${opts.childTopic}`);
  if (opts.reason) lines.push(`- Reason: ${opts.reason}`);
  lines.push("");
  if (summaryBlock) {
    lines.push(`## Key decisions / summary`);
    lines.push(summaryBlock);
    lines.push("");
  }
  if (condensedTranscript) {
    lines.push(`## Condensed earlier transcript`);
    lines.push(condensedTranscript);
    lines.push("");
  }
  if (recentTail) {
    lines.push(`## Recent transcript tail`);
    lines.push(recentTail);
  }
  return lines.join("\n");
}

export const bridgeHandlers: Record<string, ToolHandler> = {

  async question(args) {
    const { handleQuestion } = await import("./tools/question");
    return handleQuestion(args);
  },

  async plan(args) {
    const { handlePlan } = await import("./tools/plan");
    return handlePlan(args);
  },

  async workflows(args) {
    const { handleWorkflows } = await import("./tools/workflows");
    return handleWorkflows(args);
  },

  async message_sibling(args) {
    return handleCrossSessionMessage(args, "sibling");
  },

  async message_parent(args) {
    return handleCrossSessionMessage(args, "parent");
  },

  async message_child(args) {
    return handleCrossSessionMessage(args, "child");
  },

  async agent_profile(args) {
    const { getCurrentPrincipal } = await import("./principal-context");
    const principal = getCurrentPrincipal();
    if (!principal?.userId) return { result: "No authenticated user context", error: true };

    const { agentProfiles } = await import("@shared/schema");
    const { db } = await import("./db");
    const { eq, sql } = await import("drizzle-orm");

    const action = args.action;
    if (action === "get") {
      const [profile] = await db
        .select({ agentName: agentProfiles.agentName, metadata: agentProfiles.metadata, relationshipState: agentProfiles.relationshipState })
        .from(agentProfiles)
        .where(eq(agentProfiles.userId, principal.userId))
        .limit(1);
      if (!profile) return { result: "No agent profile found", error: true };
      return { result: JSON.stringify(profile) };
    }

    if (action === "update") {
      const updates: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };
      let updatedAgentName: string | undefined;
      if (args.agentName) {
        const name = String(args.agentName).trim().slice(0, 80);
        if (name.length < 1) return { result: "Agent name must be at least 1 character", error: true };
        updates.agentName = name;
        updatedAgentName = name;
      }
      if (args.metadata && typeof args.metadata === "object") {
        const [existing] = await db
          .select({ metadata: agentProfiles.metadata })
          .from(agentProfiles)
          .where(eq(agentProfiles.userId, principal.userId))
          .limit(1);
        const merged = { ...(existing?.metadata as Record<string, unknown> || {}), ...args.metadata };
        updates.metadata = merged;
      }
      await db
        .update(agentProfiles)
        .set(updates)
        .where(eq(agentProfiles.userId, principal.userId));
      if (updatedAgentName && principal.accountId) {
        const { ensureAgentLibraryRoot } = await import("./onboarding");
        await ensureAgentLibraryRoot({ ...principal, userId: principal.userId, accountId: principal.accountId }, updatedAgentName);
      }
      const [updated] = await db
        .select({ agentName: agentProfiles.agentName, metadata: agentProfiles.metadata })
        .from(agentProfiles)
        .where(eq(agentProfiles.userId, principal.userId))
        .limit(1);
      return { result: `Agent profile updated: ${JSON.stringify(updated)}` };
    }

    return { result: `Unknown action: ${action}`, error: true };
  },

  async orient(args) {
    const sessionId = args._sessionId;
    if (!sessionId) return { result: "No active session — orient tool requires an active conversation context.", error: true };

    const hasTitle = args.title !== undefined;
    const hasTopics = args.topics !== undefined;
    const hasPersona = args.persona !== undefined;
    const hasContextFlags = args.contextFlags !== undefined;

    if (!hasTitle && !hasTopics && !hasPersona && !hasContextFlags) {
      return { result: "No orientation parameters provided. Pass at least one of: title, topics, persona, contextFlags.", error: true };
    }

    // First-turn enforcement: if no meaningful title is set yet, persona is required
    if (!hasPersona) {
      const { chatFileStorage } = await import("./chat-file-storage");
      const { hasRealSessionTitle } = await import("./session-orientation");
      const conv = await chatFileStorage.getSession(sessionId);
      if (!hasRealSessionTitle(conv?.title)) {
        return { result: "First-turn orientation requires `persona`. Include the `persona` parameter (name or id) alongside title and topics on the initial orient call.", error: true };
      }
    }

    let validatedTitle: string | undefined;
    if (hasTitle) {
      validatedTitle = args.title?.trim();
      if (!validatedTitle) return { result: "Title must not be empty", error: true };
      if (validatedTitle.split(/\s+/).length > 3) return { result: "Title must be 1-3 words", error: true };
    }

    let cleanedTopics: string[] | undefined;
    if (hasTopics) {
      if (!Array.isArray(args.topics)) return { result: `Expected 'topics' to be an array of strings, got ${args.topics === null ? "null" : typeof args.topics}`, error: true };
      cleanedTopics = args.topics.filter((t: unknown) => typeof t === "string" && t.trim()).map((t: string) => t.trim()).slice(0, 8);
    }

    let resolvedPersona: { id: number; name: string } | undefined;
    let effectivePersonaName: string | undefined;
    if (hasPersona) {
      const { personaStorage } = await import("./file-storage/persona-storage");
      const numId = Number(args.persona);
      if (!isNaN(numId) && String(numId) === String(args.persona)) {
        const p = await personaStorage.getById?.(numId) ?? (await personaStorage.list()).find(x => x.id === numId);
        if (!p) return { result: `Persona with id ${numId} not found`, error: true };
        resolvedPersona = { id: p.id, name: p.name };
      } else {
        const found = await personaStorage.getByName(args.persona);
        if (!found) return { result: `Persona "${args.persona}" not found`, error: true };
        resolvedPersona = { id: found.id, name: found.name };
      }
    }

    const results: string[] = [];
    const { chatFileStorage } = await import("./chat-file-storage");

    if (validatedTitle) {
      const existing = await chatFileStorage.getSession(sessionId);
      if (existing?.manualTitle) {
        results.push(`Title preserved as manually set "${existing.title}"`);
      } else {
        await chatFileStorage.updateSessionTitle(sessionId, validatedTitle, { source: "orient" });
        results.push(`Title set to "${validatedTitle}"`);
      }
    }

    if (cleanedTopics) {
      await chatFileStorage.updateSessionTopics(sessionId, cleanedTopics);
      results.push(`Topics set: ${cleanedTopics.join(", ")}`);
    }

    if (validatedTitle || cleanedTopics) {
      const conv = await chatFileStorage.getSession(sessionId);
      const sessionKey = conv?.sessionKey || `dashboard:${sessionId}`;
      eventBus.publish({
        category: "chat",
        event: "chat.stream",
        payload: { type: "session_updated", sessionId, title: conv?.title, topics: conv?.topics || [] },
        sessionKey,
      });

      // Refresh session memory mirror so title/topics/tags stay in sync
      chatFileStorage.syncSessionMemoryMirror(sessionId).catch(() => {});
    }

    if (resolvedPersona) {
      const preserveExisting = args._orientationPersonaPolicy === "preserve_existing";
      const { setSessionPersona, setSessionPersonaIfUnset } = await import("./session-persona");
      const selection = preserveExisting
        ? await setSessionPersonaIfUnset(sessionId, resolvedPersona.id)
        : null;
      const activated = preserveExisting
        ? selection?.persona ?? null
        : await setSessionPersona(sessionId, resolvedPersona.id);
      if (!activated) return { result: `Persona with id ${resolvedPersona.id} not found`, error: true };
      effectivePersonaName = activated.name;
      if (!preserveExisting || selection?.applied) {
        eventBus.publish({
          category: "agent",
          event: "cognition.persona.switched",
          payload: { sessionId, personaId: activated.id, personaName: activated.name },
        });
        results.push(`Persona activated for this session: ${activated.name} (id=${activated.id})`);
      } else {
        results.push(`Persona preserved for this session: ${activated.name} (id=${activated.id})`);
      }
    }

    // --- Context flags ---
    if (args.contextFlags !== undefined || validatedTitle || cleanedTopics || resolvedPersona) {
      if (args.contextFlags !== undefined && (typeof args.contextFlags !== "object" || args.contextFlags === null || Array.isArray(args.contextFlags))) {
        return { result: "contextFlags must be an object mapping semantic context flags or section IDs to booleans.", error: true };
      }

      const providedFlags = (args.contextFlags || {}) as Record<string, unknown>;
      const { getSectionConfig, getBootstrapSectionIds } = await import("./context-spine-config");
      const { isSemanticContextFlag, recommendSemanticContextFlags } = await import("./context-instruction-groups");
      const bootstrapIds = getBootstrapSectionIds();
      const recommendedFlags = recommendSemanticContextFlags({
        title: validatedTitle,
        topics: cleanedTopics,
        personaName: effectivePersonaName ?? resolvedPersona?.name,
      });
      const mergedFlags: Record<string, unknown> = { ...recommendedFlags, ...providedFlags };
      const validatedFlags: Record<string, boolean> = {};
      const warnings: string[] = [];

      for (const [key, value] of Object.entries(mergedFlags)) {
        const config = getSectionConfig(key);
        if (!config && !isSemanticContextFlag(key)) {
          warnings.push(`Unknown context flag "${key}" — ignored`);
          continue;
        }
        if (bootstrapIds.has(key) && value === false) {
          warnings.push(`Bootstrap section "${key}" cannot be excluded — ignored`);
          continue;
        }
        validatedFlags[key] = !!value;
      }

      // An empty flag map is meaningful: orientation considered optional context
      // and chose the bootstrap/default sections only. Persist it so null remains
      // the single "orientation has not established context scope" state.
      const existingFlags = await chatFileStorage.readSessionContextFlags(sessionId);
      await chatFileStorage.updateSessionContextFlags(sessionId, { ...(existingFlags || {}), ...validatedFlags });
      const included = Object.entries(validatedFlags).filter(([, v]) => v).map(([k]) => k);
      const excluded = Object.entries(validatedFlags).filter(([, v]) => !v).map(([k]) => k);
      const parts: string[] = [];
      if (included.length > 0) parts.push(`included: ${included.join(", ")}`);
      if (excluded.length > 0) parts.push(`excluded: ${excluded.join(", ")}`);
      results.push(parts.length > 0
        ? `Context flags set (${parts.join("; ")})`
        : "Context flags set (bootstrap/default sections only)");

      if (warnings.length > 0) {
        results.push(`Context flag warnings: ${warnings.join("; ")}`);
      }
    }

    if (args.reasoning) {
      results.push(`Reasoning: ${args.reasoning}`);
    }

    return { result: results.join("; ") };
  },

  async session(args) {
    const action = args.action;
    const sessionId = args._sessionId;
    if (!sessionId) return { result: "No active session — session tool requires an active conversation context.", error: true };

    const { chatFileStorage } = await import("./chat-file-storage");

    if (action === "get") {
      const targetId = args.sessionId || sessionId;
      const conv = await chatFileStorage.getSession(targetId);
      if (!conv) return { result: `Session "${targetId}" not found`, error: true };
      const parts = [
        `**Session: ${conv.title}** (id: ${conv.id})`,
        `Turn: ${conv.status === "streaming" ? "active" : "idle"} | Status: ${conv.status} | Type: ${conv.sessionType}`,
        `Created: ${conv.createdAt} | Updated: ${conv.updatedAt}`,
      ];
      if (conv.parentSessionId) parts.push(`Parent Session: ${conv.parentSessionId}`);
      // Provenance
      const provParts: string[] = [];
      if (conv.triggerType) provParts.push(`${conv.triggerType}${conv.triggerName ? ` → "${conv.triggerName}"` : ""}${conv.triggerId ? ` (${conv.triggerId})` : ""}`);
      if (conv.rootSessionId) provParts.push(`Root: ${conv.rootSessionId}`);
      if (conv.depth !== undefined && conv.depth !== null) provParts.push(`Depth: ${conv.depth}`);
      if (provParts.length > 0) parts.push(`Provenance: ${provParts.join(" | ")}`);
      if (conv.topics && conv.topics.length > 0) parts.push(`Topics: ${conv.topics.join(", ")}`);
      if (conv.messageCount !== undefined) parts.push(`Messages: ${conv.messageCount}`);
      return { result: parts.join("\n") };
    }

    if (action === "send_message") {
      return handleAnySessionMessage(args);
    }

    if (action === "set_status") {
      const requested = args.runStatus;
      const status = requested === "resolved" ? "saved" : requested;
      if (!status || !["saved", "failed"].includes(status)) {
        return { result: "Missing or invalid 'runStatus' parameter. Must be resolved/saved or failed. Session lifecycle is stored in session.status.", error: true };
      }

      if (status === "failed") {
        await chatFileStorage.setErrorSeverity(sessionId, "error");
      }
      await chatFileStorage.updateSessionStatus(sessionId, status);
      await chatFileStorage.setSessionPinned(sessionId, false);
      try {
        const { runDeferredPostRunVerify } = await import("./autonomous-skill-runner");
        await runDeferredPostRunVerify(sessionId);
      } catch (e: unknown) {
        toolExec.warn(`[converse] [${sessionId}] deferred postRunVerify on set_status ${status} failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      return { result: `Session status set to "${status === "saved" ? "complete" : status}"` };
    }

    if (action === "end") {
      const summary = args.summary || "Session ended";
      const conv = await chatFileStorage.getSession(sessionId);
      const sessionKey = conv?.sessionKey || `dashboard:${sessionId}`;

      await chatFileStorage.updateSessionStatus(sessionId, "saved", summary);
      await chatFileStorage.setSessionPinned(sessionId, false);

      try {
        const { runDeferredPostRunVerify } = await import("./autonomous-skill-runner");
        await runDeferredPostRunVerify(sessionId);
      } catch (e: unknown) {
        toolExec.warn(`[converse] [${sessionId}] deferred postRunVerify on session end failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      eventBus.publish({
        category: "chat",
        event: "session.end",
        payload: { sessionId, summary },
        sessionKey,
      });

      return { result: `Session ended and completed. Summary: ${summary}` };
    }

    if (action === "list") {
      const allConvs = await chatFileStorage.getAllSessions();
      let filtered = allConvs;
      if (args.type) filtered = filtered.filter(c => c.sessionType === args.type);
      if (args.status) filtered = filtered.filter(c => c.status === args.status);
      const limit = Math.min(args.limit || 50, 200);
      filtered = filtered.slice(0, limit);
      return { result: safeStringify({ total: filtered.length, items: filtered.map(c => ({ id: c.id, title: c.title, type: c.sessionType, status: c.status, messageCount: c.messageCount || 0, updatedAt: c.updatedAt })) }, { label: "bridge.session.list" }) };
    }

    if (action === "search") {
      const query = args.query?.trim();
      if (!query) return { result: "Missing 'query' parameter for search", error: true };
      const { searchSessionSummaries } = await import("./chat-file-storage");
      const limit = Math.min(args.limit || 10, 50);
      const matches = await searchSessionSummaries(query, 24 * 30, limit);
      return { result: safeStringify({ query, total: matches.length, items: matches.map(s => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, snippet: s.snippet.slice(0, 200) })) }, { label: "bridge.session.search" }) };
    }

    if (action === "get_messages") {
      const targetId = args.sessionId || sessionId;
      const messages = await chatFileStorage.getMessagesBySession(targetId);
      const limit = Math.min(args.limit || 50, 200);
      const sliced = messages.slice(-limit);
      return { result: safeStringify({ sessionId: targetId, total: messages.length, returned: sliced.length, messages: sliced.map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt })) }, { label: "bridge.session.messages" }) };
    }

    if (action === "spawn_child") {
      const topicRaw: string | undefined = (args.topic ?? args.title ?? "").toString().trim();
      if (!topicRaw) return { result: "Missing 'topic' (or 'title') for spawn_child", error: true };
      const reason: string | undefined = args.reason ? String(args.reason).trim() : undefined;
      const explicitSpawnReason: string | undefined = args.spawnReason ? String(args.spawnReason).trim() : undefined;
      const shortTitle = topicRaw.split(/\s+/).slice(0, 5).join(" ");
      const spawnReason = explicitSpawnReason || `spawn_child:${topicRaw.slice(0, 60)}`;
      const spawnerSkillRun = `session.spawn_child:${sessionId}:${spawnReason}`;

      if (await isSpecSkillSession(sessionId) && isSpecChildSpawnRequest(topicRaw, reason, explicitSpawnReason, spawnReason)) {
        return {
          result: "Guard blocked recursive spec child launch: this session is already the spec skill. Continue producing the current spec artifact instead of spawning another spec session.",
          error: true,
        };
      }

      try {
        const { recordSpawn } = await import("./sessions/tree");
        const spawnResult = await recordSpawn(
          sessionId,
          { spawnReason, spawnerTool: "session.spawn_child", spawnerSkillRun },
          async () => {
            const created = await chatFileStorage.createAutonomousSession(
              shortTitle,
              "agent",
              undefined,
              undefined,
              undefined,
              { parentSessionId: sessionId, spawnReason, spawnerTool: "session.spawn_child", spawnerSkillRun, triggerType: "spawn" as const, triggerId: sessionId, triggerName: shortTitle },
            );
            return { sessionId: created.id };
          },
        );
        const childId = spawnResult.sessionId;

        if (spawnResult.reused) {
          const childConv = await chatFileStorage.getSession(childId);
          const childMessages = await chatFileStorage.getMessagesBySession(childId);
          const hasAssistantResponse = childMessages.some(m => m.role === "assistant");
          if (!hasAssistantResponse && childMessages.length > 0) {
            await triggerChildSessionResponse(childId, "session.spawn_child.reused");
            return { result: `Reused existing child session ${childId}${childConv?.title ? ` (${childConv.title})` : ""} for spawn reason "${spawnReason}". Started execution.` };
          }
          return { result: `Reused existing child session ${childId}${childConv?.title ? ` (${childConv.title})` : ""} for spawn reason "${spawnReason}".` };
        }

        // Build the warm-start brief from existing summarization paths.
        let brief = "";
        try {
          brief = await buildWarmStartBrief({
            parentSessionId: sessionId,
            childTopic: topicRaw,
            reason,
          });
        } catch (briefErr: unknown) {
          toolExec.warn(`[session.spawn_child] warm-start brief failed: ${briefErr instanceof Error ? briefErr.message : String(briefErr)}`);
          // Fallback: assemble a minimal brief without LLM-based summaries.
          brief = await buildFallbackBrief({
            parentSessionId: sessionId,
            childTopic: topicRaw,
            reason,
          });
        }

        // Seat the brief as the first child message (system role).
        await chatFileStorage.createMessage(childId, "system", brief);

        // Drop a cross-session reference into the parent thread so the
        // existing inline-session-blocks renderer picks it up.
        const childConv = await chatFileStorage.getSession(childId);
        const parentRefContent = `Spawned child session "${childConv?.title || shortTitle}" (${childId})${reason ? ` — reason: ${reason}` : ""}`;
        await chatFileStorage.createCrossSessionMessage(
          sessionId,
          childId,
          parentRefContent,
          "child",
        );

        // Publish event to the parent so live UI sees the new linkage.
        try {
          const parentConv = await chatFileStorage.getSession(sessionId);
          eventBus.publish({
            category: "chat",
            event: "chat.cross_session_message",
            sessionKey: parentConv?.sessionKey || `dashboard:${sessionId}`,
            payload: {
              type: "cross_session_message",
              sessionId,
              fromSessionId: sessionId,
              toSessionId: childId,
              direction: "child",
              content: parentRefContent,
              chainId: "",
              depth: 0,
              fromLabel: parentConv?.title,
              toLabel: childConv?.title,
            } as any,
          });
        } catch (e: any) {
          toolExec.warn(`[session.spawn_child] event publish failed: ${e?.message || e}`);
        }

        // Emit child_session_block so inline widget renders in parent
        try {
          const { onChildSessionSpawned } = await import("./sessions/child-block-lifecycle");
          await onChildSessionSpawned(sessionId, childId, {
            spawnReason,
            title: shortTitle,
          });
        } catch (e: any) {
          toolExec.warn(`[session.spawn_child] child block emission failed: ${e?.message || e}`);
        }

        await triggerChildSessionResponse(childId, "session.spawn_child");

        toolExec.log(`[session.spawn_child] parent=${sessionId} child=${childId} spawnReason=${spawnReason} briefLen=${brief.length} autoStart=true`);
        return { result: `Spawned child session ${childId}${childConv?.title ? ` (${childConv.title})` : ""}. Warm-start brief seated (${brief.length} chars). Started execution.` };
      } catch (err: any) {
        return { result: `spawn_child failed: ${err?.message || err}`, error: true };
      }
    }

    return { result: `Unknown session action: ${action}. Available: get, set_status, end, list, search, get_messages, spawn_child, send_message`, error: true };
  },

  async create_task(args) {
    const { fileTaskStorage } = await import("./file-storage/tasks");
    const { chatFileStorage } = await import("./chat-file-storage");

    const title = args.title;
    if (!title) return { result: "Missing task title", error: true };
    const description = args.description?.trim();
    if (!description) return { result: "Missing task description", error: true };

    const owner = args.owner === "xyz" ? "agent" : (args.owner || "me");
    const milestoneId = typeof args.milestoneId === "number" ? args.milestoneId : Number(args.milestoneId);
    if (!Number.isInteger(milestoneId) || milestoneId <= 0) {
      return {
        result: "Missing milestoneId. Every new task must be assigned to a real milestone. If the right milestone is unclear, ask Ray which milestone it belongs under before creating the task.",
        error: true,
      };
    }

    const sourceSessionId = typeof args._sessionId === "string" && args._sessionId.trim() ? args._sessionId.trim() : null;
    let sourceSessionLine = "";
    if (sourceSessionId) {
      const sourceSession = await chatFileStorage.getSession(sourceSessionId).catch(() => undefined);
      const titlePart = sourceSession?.title ? ` (${sourceSession.title})` : "";
      sourceSessionLine = `Source session: @session:${sourceSessionId}${titlePart}`;
    }

    try {
      const context = sourceSessionLine || "";

      const taskData = {
        title,
        description,
        priority: args.priority || "mid",
        owner,
        projectId: args.projectId ?? null,
        status: args.status || "ready",
        requiresReview: args.requiresReview ?? false,
        impact: args.impact ?? null,
        effort: args.effort ?? null,
        milestoneId,
        context,
        deadline: args.deadline ?? null,
      };
      const task = await fileTaskStorage.createTask(taskData);
      return { result: `Task created: "${task.title}" (ID: ${task.id}, priority: ${task.priority}, owner: ${task.owner}, milestone: ${task.milestoneId})${sourceSessionId ? `, source: @session:${sourceSessionId}` : ""}` };
    } catch (err: any) {
      return { result: `Failed to create task: ${err.message}`, error: true };
    }
  },

  async complete_task(args) {
    const { fileTaskStorage } = await import("./file-storage/tasks");

    let task: any = null;
    if (args.taskId) {
      task = await fileTaskStorage.getTask(args.taskId);
    }
    if (!task && args.title) {
      const tasks = await fileTaskStorage.getTasks({});
      task = tasks.find((t: any) => t.title.toLowerCase().includes(args.title.toLowerCase()));
    }
    if (!task) return { result: `Task not found: ${args.taskId || args.title}`, error: true };

    try {
      const updated = await fileTaskStorage.updateTask(task.id, { status: "done" });
      if (!updated) return { result: `Failed to update task ${task.id}`, error: true };
      return { result: `Task completed: "${updated.title}" (ID: ${updated.id})` };
    } catch (err: any) {
      return { result: `Failed to complete task: ${err.message}`, error: true };
    }
  },

  async delete_task(args) {
    const { fileTaskStorage } = await import("./file-storage/tasks");

    let task: any = null;
    if (args.taskId) {
      task = await fileTaskStorage.getTask(args.taskId);
    }
    if (!task && args.title) {
      const tasks = await fileTaskStorage.getTasks({});
      task = tasks.find((t: any) => t.title.toLowerCase().includes(args.title.toLowerCase()));
    }
    if (!task) return { result: `Task not found: ${args.taskId || args.title}`, error: true };

    try {
      const deleted = await fileTaskStorage.deleteTask(task.id);
      if (!deleted) return { result: `Failed to delete task ${task.id}`, error: true };
      return { result: `Task deleted: "${task.title}" (ID: ${task.id})` };
    } catch (err: any) {
      return { result: `Failed to delete task: ${err.message}`, error: true };
    }
  },

  async update_task(args) {
    const { fileTaskStorage } = await import("./file-storage/tasks");
    const { sanitizePatch, PatchGuardError, logPatchClearAudit } = await import("./lib/patch-guard");

    let task: any = null;
    if (args.taskId) {
      task = await fileTaskStorage.getTask(args.taskId);
    }
    if (!task && args.title) {
      const tasks = await fileTaskStorage.getTasks({});
      task = tasks.find((t: any) => t.title.toLowerCase().includes(args.title.toLowerCase()));
    }
    if (!task) return { result: `Task not found: ${args.taskId || args.title}`, error: true };

    // Build raw updates from args, then sanitize through patch guard
    const raw: Record<string, unknown> = {};
    if (args.newTitle !== undefined) raw.title = args.newTitle;
    if (args.description !== undefined) raw.description = args.description;
    if (args.priority !== undefined) raw.priority = args.priority;
    if (args.status !== undefined) raw.status = args.status;
    if (args.impact !== undefined) raw.impact = args.impact;
    if (args.effort !== undefined) raw.effort = args.effort;
    if (args.owner !== undefined) raw.owner = args.owner;
    if (args.requiresReview !== undefined) raw.requiresReview = args.requiresReview;
    if (args.projectId !== undefined) raw.projectId = args.projectId;
    if (args.milestoneId !== undefined) raw.milestoneId = args.milestoneId;
    if (args.deadline !== undefined) raw.deadline = args.deadline;
    if (args.clearFields !== undefined) raw.clearFields = args.clearFields;
    if (args.confirmDestructiveUpdate !== undefined) raw.confirmDestructiveUpdate = args.confirmDestructiveUpdate;
    if (args.destructiveUpdateReason !== undefined) raw.destructiveUpdateReason = args.destructiveUpdateReason;

    try {
      const { patch: updates, clearFields, destructiveUpdateReason } = sanitizePatch(raw, {
        protectedFields: ['title', 'description', 'deadline', 'projectId', 'milestoneId'] as Array<keyof any>,
        clearableFields: ['description', 'deadline', 'projectId', 'milestoneId'] as Array<keyof any>,
        destructiveFields: ['description'] as Array<keyof any>,
      });

      // Apply explicit clears as null values
      for (const field of clearFields) {
        (updates as Record<string, unknown>)[field as string] = null;
      }
      logPatchClearAudit(toolExec, {
        operation: "tasks.update",
        entityType: "task",
        entityId: task.id,
        clearFields,
        destructiveUpdateReason,
      });

      if (Object.keys(updates).length === 0) return { result: "No fields to update after sanitization. Empty strings on protected fields are dropped — use clearFields to explicitly clear a field.", error: true };

      const updated = await fileTaskStorage.updateTask(task.id, updates);
      if (!updated) return { result: `Failed to update task ${task.id}`, error: true };
      return { result: `Task updated: "${updated.title}" — ${Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(", ")}` };
    } catch (err: any) {
      if (err instanceof PatchGuardError) {
        return { result: `Patch guard rejected update: ${err.message}${err.required ? ` Required: ${JSON.stringify(err.required)}` : ''}`, error: true };
      }
      return { result: `Failed to update task: ${err.message}`, error: true };
    }
  },

  async create_issue(args) {
    const { storage } = await import("./storage");

    const title = args.title;
    if (!title) return { result: "Missing issue title", error: true };

    try {
      const issue = await storage.createIssue({
        title,
        description: args.description || "",
        status: "open",
        page: null,
        screenshot: null,
        logs: null,
      });
      return { result: `Issue created: "${issue.title}" (ID: ${issue.id})` };
    } catch (err: any) {
      return { result: `Failed to create issue: ${err.message}`, error: true };
    }
  },

  async goals(args) {
    const { goalsService } = await import("./goals-service");

    const action = args.action || "list";

    async function resolveLibraryPageUUID(rawId: string): Promise<{ uuid: string } | { error: string }> {
      const { db } = await import("./db");
      const { libraryPages } = await import("@shared/models/info");
      const { eq } = await import("drizzle-orm");
      const byId = await db.select({ id: libraryPages.id }).from(libraryPages).where(eq(libraryPages.id, rawId));
      if (byId[0]) return { uuid: byId[0].id };
      const bySlug = await db.select({ id: libraryPages.id }).from(libraryPages).where(eq(libraryPages.slug, rawId));
      if (bySlug[0]) return { uuid: bySlug[0].id };
      return { error: `Library page "${rawId}" not found. Use the exact id or slug returned by the library tool when creating/updating the page.` };
    }

    function parseLocalDate(date: string, label: string): { date: Date } | { error: string } {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `Invalid '${label}' format: expected YYYY-MM-DD` };
      const [year, month, day] = date.split("-").map(Number);
      const parsed = new Date(date + "T12:00:00");
      if (isNaN(parsed.getTime()) || parsed.getFullYear() !== year || parsed.getMonth() + 1 !== month || parsed.getDate() !== day) {
        return { error: `Invalid '${label}' value: date does not exist` };
      }
      return { date: parsed };
    }

    async function setCheckInArtifact(
      artifactAction: string,
      args: Record<string, any>,
    ): Promise<ToolHandlerResult> {
      const rawPageId = args.libraryPageId;
      if (!rawPageId) return { result: "Missing libraryPageId parameter", error: true };
      const resolved = await resolveLibraryPageUUID(String(rawPageId));
      if ("error" in resolved) return { result: resolved.error, error: true };
      const libraryPageId = resolved.uuid;
      const { setArtifact } = await import("./period-artifact-storage");
      const { getDateInTimezone } = await import("./timezone");
      const { invalidateSimpleFeedCache } = await import("./simple/generate-feed");

      if (artifactAction === "set_review" || artifactAction === "set_daily_plan") {
        const date = args.date ? String(args.date) : getDateInTimezone();
        const parsed = parseLocalDate(date, "date");
        if ("error" in parsed) return { result: parsed.error, error: true };
        const updates = artifactAction === "set_review" ? { reviewPageId: libraryPageId } : { dailyPlanPageId: libraryPageId };
        await setArtifact(date, "daily", updates);
        invalidateSimpleFeedCache();
        const field = artifactAction === "set_review" ? "reviewPageId" : "dailyPlanPageId";
        return { result: `${field} set for ${date}: ${libraryPageId}` };
      }

      if (artifactAction === "set_weekly_reflection" || artifactAction === "set_weekly_plan") {
        const baseStr = args.week ? String(args.week) : getDateInTimezone();
        const parsed = parseLocalDate(baseStr, "week");
        if ("error" in parsed) return { result: parsed.error, error: true };
        const d = parsed.date;
        const day = d.getDay();
        const diff = day === 0 ? 6 : day - 1;
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
        const mondayDate = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
        const field = artifactAction === "set_weekly_reflection" ? "weeklyReflectionPageId" : "weeklyPlanPageId";
        await setArtifact(mondayDate, "weekly", { [field]: libraryPageId });
        invalidateSimpleFeedCache();
        return { result: `${field} set for week of ${mondayDate}: ${libraryPageId}` };
      }

      if (artifactAction === "set_monthly_plan" || artifactAction === "set_monthly_reflection") {
        let firstOfMonth: string;
        if (args.month) {
          const monthStr = String(args.month);
          if (!/^\d{4}-\d{2}$/.test(monthStr)) return { result: "Invalid 'month' format: expected YYYY-MM", error: true };
          const parsed = new Date(monthStr + "-01T12:00:00");
          if (isNaN(parsed.getTime()) || parsed.getMonth() !== parseInt(monthStr.slice(5, 7), 10) - 1) {
            return { result: "Invalid 'month' value: month does not exist", error: true };
          }
          firstOfMonth = `${monthStr}-01`;
        } else {
          const todayStr = getDateInTimezone();
          const d = new Date(todayStr + "T12:00:00");
          firstOfMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
        }
        const field = artifactAction === "set_monthly_plan" ? "monthlyPlanPageId" : "monthlyReflectionPageId";
        await setArtifact(firstOfMonth, "monthly", { [field]: libraryPageId });
        invalidateSimpleFeedCache();
        return { result: `${field} set for month of ${firstOfMonth}: ${libraryPageId}` };
      }

      if (artifactAction === "set_quarterly_plan" || artifactAction === "set_quarterly_reflection") {
        let firstOfQuarter: string;
        if (args.quarter) {
          const quarterStr = String(args.quarter);
          const match = quarterStr.match(/^(\d{4})-Q([1-4])$/);
          if (!match) return { result: "Invalid 'quarter' format: expected YYYY-QN", error: true };
          const year = Number(match[1]);
          const q = Number(match[2]);
          firstOfQuarter = `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
        } else {
          const todayStr = getDateInTimezone();
          const d = new Date(todayStr + "T12:00:00");
          const startMonth = Math.floor(d.getMonth() / 3) * 3 + 1;
          firstOfQuarter = `${d.getFullYear()}-${String(startMonth).padStart(2, "0")}-01`;
        }
        const field = artifactAction === "set_quarterly_plan" ? "quarterlyPlanPageId" : "quarterlyReflectionPageId";
        await setArtifact(firstOfQuarter, "quarterly", { [field]: libraryPageId });
        invalidateSimpleFeedCache();
        return { result: `${field} set for quarter of ${firstOfQuarter}: ${libraryPageId}` };
      }

      return { result: `Unknown goals artifact action: ${artifactAction}`, error: true };
    }

    async function getDailyArtifacts(args: Record<string, any>): Promise<ToolHandlerResult> {
      const { getArtifacts } = await import("./period-artifact-storage");
      const date = args.date || (await import("./timezone")).getDateInTimezone();
      const parsed = parseLocalDate(String(date), "date");
      if ("error" in parsed) return { result: parsed.error, error: true };
      const artifacts = await getArtifacts(String(date), "daily");
      const lines: string[] = [`Daily artifacts for ${date}:`];
      lines.push(artifacts?.briefPageId ? `- Brief: ${artifacts.briefPageId}${artifacts.briefViewedAt ? ` (viewed ${artifacts.briefViewedAt})` : ""}` : "- Brief: not set");
      lines.push(artifacts?.reviewPageId ? `- Review: ${artifacts.reviewPageId}${artifacts.reviewViewedAt ? ` (viewed ${artifacts.reviewViewedAt})` : ""}` : "- Review: not set");
      if (artifacts?.dailyPlanPageId) lines.push(`- Daily plan: ${artifacts.dailyPlanPageId}`);
      return { result: lines.join("\n") };
    }

    try {
      switch (action) {
        case "list": {
          // The agent goals tool is a management surface: it must see dormant goals to update/reactivate them.
          const goals = await goalsService.listAll({ ...(args.filters || {}), includeDormant: true });
          if (goals.length === 0) return { result: "No goals in the system yet." };
          const lines = goals.map(g => `- ${g.shortName} [goal:${g.id}] (${g.horizon}, ${g.status || "active"}${(g.tags || []).length > 0 ? `, tags: ${g.tags.join(", ")}` : ""})`);
          return { result: `${goals.length} goals:\n${lines.join("\n")}` };
        }
        case "get": {
          const id = args.id;
          if (!id) return { result: "Missing goal id", error: true };
          const goal = await goalsService.get(id);
          if (!goal) return { result: `Goal ${id} not found`, error: true };
          const parts = [`**${goal.shortName}** [goal:${goal.id}] — ${goal.horizon} — ${goal.status || "active"}`];
          parts.push(`Description: ${goal.description}`);
          if (goal.tags.length > 0) parts.push(`Tags: ${goal.tags.join(", ")}`);
          parts.push(`Owner: ${goal.owner}`);
          if (goal.parentId) parts.push(`Parent: ${goal.parentId}`);
          if (goal.notes.length > 0) parts.push(`Notes: ${goal.notes.map(n => n.content).join("; ")}`);
          return { result: parts.join("\n") };
        }
        case "create": {
          const shortName = args.shortName;
          if (!shortName) return { result: "Missing goal shortName", error: true };
          const { goal } = await goalsService.create({
            shortName,
            description: args.description || shortName,
            rawInput: args.rawInput || shortName,
            horizon: args.horizon || "this_year",
            owner: args.owner || "me",
            tags: args.tags || [],
            status: args.status || "active",
            targetDate: args.targetDate,
            periodDate: args.periodDate,
            periodWeek: args.periodWeek,
            periodMonth: args.periodMonth,
            source: args.source,
          });
          return { result: `Goal created: "${goal.shortName}" [goal:${goal.id}] (horizon: ${goal.horizon}, status: ${goal.status}, tags: ${goal.tags.join(", ") || "none"})` };
        }
        case "update": {
          const id = args.id;
          if (!id) return { result: "Missing goal id", error: true };
          const updates: Record<string, any> = {};
          if (args.shortName) updates.shortName = args.shortName;
          if (args.description) updates.description = args.description;
          if (args.horizon) updates.horizon = args.horizon;
          if (args.owner) updates.owner = args.owner;
          if (args.status) updates.status = args.status;
          if (args.targetDate !== undefined) updates.targetDate = args.targetDate;
          if (args.periodDate !== undefined) updates.periodDate = args.periodDate;
          if (args.periodWeek !== undefined) updates.periodWeek = args.periodWeek;
          if (args.periodMonth !== undefined) updates.periodMonth = args.periodMonth;
          if (args.source !== undefined) updates.source = args.source;
          const goal = await goalsService.update(id, updates);
          return { result: `Goal updated: "${goal.shortName}" [goal:${id}] — ${Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(", ")}` };
        }
        case "search": {
          const query = args.query;
          if (!query) return { result: "Missing search query", error: true };
          const results = await goalsService.listAll({ search: query, includeDormant: true });
          if (results.length === 0) return { result: `No goals matching "${query}"` };
          const lines = results.map(g => `- ${g.shortName} [goal:${g.id}] (${g.horizon}, ${g.status || "active"}${(g.tags || []).length > 0 ? `, tags: ${g.tags.join(", ")}` : ""})`);
          return { result: `Found ${results.length} goals:\n${lines.join("\n")}` };
        }
        case "set_parent": {
          const id = args.id;
          const parentId = args.parentId;
          if (!id || !parentId) return { result: "Missing goal id or parentId", error: true };
          const goal = await goalsService.get(id);
          if (!goal) return { result: `Goal ${id} not found`, error: true };
          if (goal.parentId && goal.parentId !== parentId) {
            await goalsService.update(id, { parentId: null });
          }
          await goalsService.update(id, { parentId });
          return { result: `Parent set: [goal:${parentId}] → [goal:${id}]` };
        }
        case "unlink_parent": {
          const id = args.id;
          if (!id) return { result: "Missing goal id", error: true };
          const goal = await goalsService.get(id);
          if (!goal) return { result: `Goal ${id} not found`, error: true };
          await goalsService.update(id, { parentId: null });
          return { result: `Parent unlinked from goal [goal:${id}]` };
        }
        case "delete": {
          const id = args.id;
          if (!id) return { result: "Missing goal id", error: true };
          const goal = await goalsService.get(id);
          if (!goal) return { result: `Goal ${id} not found`, error: true };
          await goalsService.delete(id);
          return { result: `Goal deleted: "${goal.shortName}" [goal:${id}]` };
        }
        case "set_review":
        case "set_daily_plan":
        case "set_weekly_reflection":
        case "set_weekly_plan":
        case "set_monthly_plan":
        case "set_monthly_reflection":
        case "set_quarterly_plan":
        case "set_quarterly_reflection":
          return await setCheckInArtifact(action, args);
        case "get_daily_artifacts":
          return await getDailyArtifacts(args);
        default:
          return { result: `Unknown goals action: ${action}. Available: list, get, create, update, delete, search, set_parent, unlink_parent, set_review, set_daily_plan, get_daily_artifacts, set_weekly_reflection, set_weekly_plan, set_monthly_plan, set_monthly_reflection, set_quarterly_plan, set_quarterly_reflection`, error: true };
      }
    } catch (err: any) {
      return { result: `Goals tool error: ${err.message}`, error: true };
    }
  },

  async companies(args) {
    try {
      const { companyStorage } = await import("./company-storage");
      const action = String(args.action || "list");
      if (action === "list") return { result: JSON.stringify(await companyStorage.list(args.query), null, 2) };
      const company = args.id ? await companyStorage.resolve(String(args.id)) : null;
      if (action === "get") {
        if (!company) return { result: "Company not found", error: true };
        return { result: JSON.stringify({ ...company, people: await companyStorage.listPeople(company.id), opportunities: await companyStorage.listOpportunities(company.id) }, null, 2) };
      }
      if (action === "create") {
        if (!args.name) return { result: "Missing company name", error: true };
        const created = await companyStorage.create(args);
        return { result: `Company created: ${created.name} @company:${created.id}` };
      }
      if (!company) return { result: "Company not found. Provide id or exact name.", error: true };
      if (action === "update") {
        const updated = await companyStorage.update(company.id, args);
        return { result: `Company updated: ${updated.name} @company:${updated.id}` };
      }
      if (action === "delete") {
        await companyStorage.delete(company.id);
        return { result: `Company deleted: ${company.name}` };
      }
      if (action === "add_opportunity" || action === "remove_opportunity") {
        if (typeof args.opportunityId !== "number") return { result: "Missing opportunityId", error: true };
        if (action === "add_opportunity") {
          await companyStorage.addOpportunity(company.id, args.opportunityId);
          return { result: `Added opportunity ${args.opportunityId} to @company:${company.id}` };
        }
        await companyStorage.removeOpportunity(company.id, args.opportunityId);
        return { result: `Removed opportunity ${args.opportunityId} from @company:${company.id}` };
      }
      if (!args.personId) return { result: "Missing personId", error: true };
      if (action === "add_person") {
        await companyStorage.addPerson(company.id, String(args.personId));
        return { result: `Added @person:${args.personId} to @company:${company.id}` };
      }
      if (action === "remove_person") {
        await companyStorage.removePerson(company.id, String(args.personId));
        return { result: `Removed @person:${args.personId} from @company:${company.id}` };
      }
      return { result: `Unknown companies action: ${action}`, error: true };
    } catch (err: any) {
      return { result: `Companies tool error: ${err.message}`, error: true };
    }
  },

  async people(args) {
    const action = args.action || "list";
    const handler = peopleSubHandlers[action];
    if (!handler) return { result: `Unknown people action: ${action}. Available: list, get, get_many, query, search, agenda, add_note, update_note, delete_note, log_interaction, get_interactions, update_interaction, delete_interaction, update_relationship_profile, update_network_profile, update_capital, add_commitment, update_commitment, ask_route, add_relationship_memory, get_relationship_memories, enrichment_prompt, create, update, set_daily_contact, scan_imports, scan_ignored, search_import_candidates, list_import_candidates, get_import_candidate, find_import_matches, add_import_candidate, merge_import_candidate, skip_import_candidate, undo_import_decision, preview_import_batch, apply_import_batch, get_import_batch`, error: true };
    try {
      return await handler(args);
    } catch (err: any) {
      return { result: `People tool error: ${err.message}`, error: true };
    }
  },

  async twitter(args) {
    const action = args.action || "status";
    try {
      const twitter = await import("./twitter");
      const twitterActions: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
        status: async () => {
          const connected = await twitter.isTwitterConnected();
          if (!connected) return { result: "X (Twitter) is not connected. The user needs to add their API credentials in Settings → Connections." };
          const accounts = await twitter.listTwitterAccounts();
          const results = [];
          for (const acct of accounts) {
            const check = await twitter.verifyStoredCredentials(acct.id);
            const perms = await twitter.getTwitterPermissions(acct.id);
            results.push({
              id: acct.id,
              label: acct.label,
              valid: check.valid,
              username: check.username,
              error: check.error,
              permissions: perms,
            });
          }
          return { result: safeStringify({ connected: true, accounts: results }, { label: "bridge.accounts.connected" }) };
        },
        post: async (a) => {
          const account = await twitter.getFirstAccountTokens();
          if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
          const allowed = await twitter.checkTwitterPermission(account.accountId, "post");
          if (!allowed) return { result: "Posting is disabled for this X account. The user can enable it in Settings → Connections → X (Twitter) permissions.", error: true };
          if (!a.text) return { result: "Missing tweet text. Provide the 'text' parameter.", error: true };
          const result = await twitter.postTweet(account.tokens, a.text);
          return { result: `Tweet posted successfully!\nURL: ${result.url}\nID: ${result.id}` };
        },
        reply: async (a) => {
          const account = await twitter.getFirstAccountTokens();
          if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
          const allowed = await twitter.checkTwitterPermission(account.accountId, "reply");
          if (!allowed) return { result: "Replying is disabled for this X account. The user can enable it in Settings → Connections → X (Twitter) permissions.", error: true };
          if (!a.tweet_id) return { result: "Missing tweet_id. Provide the tweet ID or URL to reply to.", error: true };
          if (!a.text) return { result: "Missing reply text. Provide the 'text' parameter.", error: true };
          const tweetId = twitter.parseTweetId(a.tweet_id);
          if (!tweetId) return { result: `Could not parse tweet ID from: ${a.tweet_id}`, error: true };
          const result = await twitter.replyToTweet(account.tokens, tweetId, a.text);
          return { result: `Reply posted successfully!\nURL: ${result.url}\nID: ${result.id}` };
        },
        lookup: async (a) => {
          const account = await twitter.getFirstAccountTokens();
          if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
          if (!a.tweet_id) return { result: "Missing tweet_id. Provide a tweet ID or URL to look up.", error: true };
          const articleId = twitter.parseArticleId(a.tweet_id);
          if (articleId && /\/i\/articles\//i.test(a.tweet_id)) {
            if (!account.tokens.bearerToken) return { result: "This is an X Article URL. A Bearer Token is required to read articles. Add one in Settings → Connections → X (Twitter).", error: true };
            const article = await twitter.lookupNews(account.tokens.bearerToken, articleId);
            return { result: JSON.stringify(article) };
          }
          const tweetId = twitter.parseTweetId(a.tweet_id);
          if (!tweetId) return { result: `Could not parse tweet ID from: ${a.tweet_id}`, error: true };
          const tweet = await twitter.lookupTweet(account.tokens, tweetId);
          return { result: JSON.stringify(tweet) };
        },
        delete: async (a) => {
          const account = await twitter.getFirstAccountTokens();
          if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
          const allowed = await twitter.checkTwitterPermission(account.accountId, "delete");
          if (!allowed) return { result: "Deleting tweets is disabled for this X account. The user can enable it in Settings → Connections → X (Twitter) permissions.", error: true };
          if (!a.tweet_id) return { result: "Missing tweet_id. Provide the tweet ID or URL to delete.", error: true };
          const tweetId = twitter.parseTweetId(a.tweet_id);
          if (!tweetId) return { result: `Could not parse tweet ID from: ${a.tweet_id}`, error: true };
          await twitter.deleteTweet(account.tokens, tweetId);
          return { result: `Tweet ${tweetId} deleted successfully.` };
        },
        news_search: async (a) => {
          const account = await twitter.getFirstAccountTokens();
          if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
          if (!account.tokens.bearerToken) return { result: "No Bearer Token configured for this X account. Add a Bearer Token in Settings → Connections → X (Twitter) to use news/article endpoints.", error: true };
          if (!a.query) return { result: "Missing query. Provide a search query for news articles.", error: true };
          let maxResults: number | undefined;
          if (a.max_results) {
            maxResults = parseInt(a.max_results, 10);
            if (isNaN(maxResults) || maxResults < 1 || maxResults > 100) {
              return { result: "max_results must be a number between 1 and 100.", error: true };
            }
          }
          const results = await twitter.searchNews(account.tokens.bearerToken, a.query, maxResults);
          return { result: JSON.stringify(results) };
        },
        news_lookup: async (a) => {
          const account = await twitter.getFirstAccountTokens();
          if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
          if (!account.tokens.bearerToken) return { result: "No Bearer Token configured for this X account. Add a Bearer Token in Settings → Connections → X (Twitter) to use news/article endpoints.", error: true };
          if (!a.article_id) return { result: "Missing article_id. Provide an article ID or URL to look up.", error: true };
          const articleId = twitter.parseArticleId(a.article_id);
          if (!articleId) return { result: `Could not parse article ID from: ${a.article_id}`, error: true };
          const article = await twitter.lookupNews(account.tokens.bearerToken, articleId);
          return { result: JSON.stringify(article) };
        },
      };

      const handler = twitterActions[action];
      if (!handler) return { result: `Unknown twitter action: ${action}. Available: status, post, reply, lookup, delete, news_search, news_lookup`, error: true };
      return await handler(args);
    } catch (err: any) {
      return { result: `Twitter tool error: ${err.message}`, error: true };
    }
  },

  async gmail(args) {
    const action = args.action || "status";
    const handler = gmailSubHandlers[action];
    if (!handler) return { result: `Unknown gmail action: ${action}. Available: status, search, read, batch_read, draft, reply, update_draft, recent, download_attachment, triage_log, email_cache`, error: true };
    try {
      return await handler(args);
    } catch (err: any) {
      const { isInvalidGrantError } = await import("./gmail");
      if (isInvalidGrantError(err)) {
        return {
          result: `Gmail authentication expired — the OAuth token has been revoked or expired. The user needs to re-authorize their Google account in Settings → Connections. Let them know their Gmail connection needs to be refreshed.`,
          error: true,
          needsReauth: true,
        };
      }
      return { result: `Gmail tool error: ${err.message}`, error: true };
    }
  },

  async notion(args) {
    const action = args.action || "status";

    try {
      const notionModule = await import("./notion");

      const resolveAccountId = async (a: Record<string, any>): Promise<{ id: string } | { error: string }> => {
        const accounts = await notionModule.listNotionAccounts();
        if (accounts.length === 0) return { error: "No Notion account connected. Add one in Settings > Integrations." };
        if (a.account) {
          const match = accounts.find(acc => acc.id === a.account || acc.label.toLowerCase() === a.account.toLowerCase() || acc.workspaceName.toLowerCase().includes(a.account.toLowerCase()));
          if (!match) return { error: `Notion account "${a.account}" not found. Connected accounts: ${accounts.map(acc => acc.label).join(", ")}` };
          return { id: match.id };
        }
        return { id: accounts[0].id };
      };

      const notionActionHandlers: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
        status: (a) => handleNotionStatus(notionModule),
        search: (a) => handleNotionSearch(a, resolveAccountId, notionModule),
        get_page: (a) => handleNotionGetPage(a, resolveAccountId, notionModule),
        get_content: (a) => handleNotionGetContent(a, resolveAccountId, notionModule),
        list_databases: (a) => handleNotionListDatabases(a, resolveAccountId, notionModule),
        query_database: (a) => handleNotionQueryDatabase(a, resolveAccountId, notionModule),
      };

      const handler = notionActionHandlers[action];
      if (!handler) return { result: `Unknown notion action: ${action}. Available: status, search, get_page, get_content, list_databases, query_database`, error: true };
      return await handler(args);
    } catch (err: any) {
      return { result: `Notion tool error: ${err.message}`, error: true };
    }
  },

  async add_meeting(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarCreate", "create calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      const { createEvent, listAllEvents, hasCalendarAccess } = await import("./google-calendar");
      const { listGmailAccounts } = await import("./gmail");
      const { getTimezone } = await import("./timezone");

      const accounts = await listGmailAccounts();
      const connected = [];
      for (const a of accounts) {
        if (await hasCalendarAccess(a.id)) connected.push(a);
      }
      if (connected.length === 0) return { result: "No Google accounts with calendar access. Connect one in Settings > Integrations.", error: true };

      const summary = args.summary;
      if (!summary) return { result: "Missing meeting summary/title", error: true };

      const accountId = args.accountId || connected[0].id;
      const calendarId = args.calendarId || "primary";
      const tz = getTimezone();

      const event: any = { summary };
      if (args.description) event.description = args.description;
      if (args.location) event.location = args.location;

      if (args.start) {
        event.start = args.start.date
          ? { date: args.start.date }
          : { dateTime: args.start.dateTime || args.start, timeZone: args.start.timeZone || tz };
        if (typeof event.start === "object" && typeof args.start === "string") {
          event.start = { dateTime: args.start, timeZone: tz };
        }
      } else {
        return { result: "Missing start time. Provide start.dateTime (ISO 8601) or start.date (YYYY-MM-DD).", error: true };
      }

      if (args.end) {
        event.end = args.end.date
          ? { date: args.end.date }
          : { dateTime: args.end.dateTime || args.end, timeZone: args.end.timeZone || tz };
        if (typeof event.end === "object" && typeof args.end === "string") {
          event.end = { dateTime: args.end, timeZone: tz };
        }
      } else {
        const startDt = event.start.dateTime || event.start.date;
        if (startDt && startDt.includes("T")) {
          const endDt = new Date(new Date(startDt).getTime() + 60 * 60 * 1000).toISOString();
          event.end = { dateTime: endDt, timeZone: tz };
        } else {
          event.end = { ...event.start };
        }
      }

      if (args.attendees) {
        event.attendees = args.attendees.map((a: any) =>
          typeof a === "string" ? { email: a } : a
        );
      }

      if (args.visibility) event.visibility = args.visibility;

      const created = await createEvent(accountId, calendarId, event);
      await safeInvalidateCalendarCache("create_meeting");
      const startStr = created.start?.dateTime || created.start?.date || "";
      return { result: `Meeting created: "${created.summary}" on ${startStr}${created.attendees?.length ? ` with ${created.attendees.filter((a: any) => !a.self).map((a: any) => a.displayName || a.email).join(", ")}` : ""}${created.htmlLink ? ` — ${created.htmlLink}` : ""}` };
    } catch (err: any) {
      return { result: `Failed to create meeting: ${err.message}`, error: true };
    }
  },

  async list_meetings(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarView", "view calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      const { listAllEvents, hasCalendarAccess } = await import("./google-calendar");
      const { listGmailAccounts } = await import("./gmail");

      const accounts = await listGmailAccounts();
      const connected = [];
      for (const a of accounts) {
        if (await hasCalendarAccess(a.id)) connected.push(a);
      }
      if (connected.length === 0) return { result: "No Google accounts with calendar access. Connect one in Settings > Integrations.", error: true };

      const now = new Date();
      const defaultMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const timeMin = args.from || now.toISOString();
      const timeMax = args.to || defaultMax.toISOString();
      const maxResults = args.limit || 20;

      const { events, errors } = await listAllEvents({ timeMin, timeMax, maxResults });

      if (events.length === 0 && errors.length > 0) {
        const errorDetails = errors.map(e => `- Account ${e.accountId}: ${e.message}`).join("\n");
        return { result: `Failed to retrieve calendar events:\n${errorDetails}`, error: true };
      }

      if (events.length === 0) return { result: "No upcoming meetings found in the specified time range." };

      const formatTime = (iso: string) => {
        if (!iso || iso.length <= 10) return iso;
        try { return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
        catch { return iso; }
      };

      const { listMetadataByEvents, getLinkedPeopleByMetadataIds, makeMetaKey } = await import("./calendar-metadata");

      const eventIdentities = events.filter(e => e.id).map(e => ({
        googleEventId: e.id,
        accountId: e.accountId,
        calendarId: e.calendarId,
      }));
      const allMeta = await listMetadataByEvents(eventIdentities).catch(() => []);
      const metaIds = allMeta.map(m => m.id);
      const allLinkedPeople = await getLinkedPeopleByMetadataIds(metaIds).catch(() => []);

      type MetaPerson = typeof allLinkedPeople[number];

      const metaByKey = new Map(allMeta.map(m => [makeMetaKey(m.googleEventId, m.accountId, m.calendarId), m]));
      const peopleByMetaId = new Map<number, MetaPerson[]>();
      for (const p of allLinkedPeople) {
        if (!peopleByMetaId.has(p.metadataId)) peopleByMetaId.set(p.metadataId, []);
        peopleByMetaId.get(p.metadataId)!.push(p);
      }

      const lines = events.map(e => {
        const attendees = (e.attendees || []).filter((a: any) => !a.self);
        const attendeeStr = attendees.length > 0 ? ` (with ${attendees.map((a: any) => a.displayName || a.email).slice(0, 4).join(", ")}${attendees.length > 4 ? ` +${attendees.length - 4}` : ""})` : "";
        const loc = e.location ? ` @ ${e.location}` : "";

        const meta = metaByKey.get(makeMetaKey(e.id, e.accountId, e.calendarId));
        let metaBadge = "";
        if (meta) {
          const linkedPeople = peopleByMetaId.get(meta.id) ?? [];

          if (meta.eventType === "meeting" && linkedPeople.length > 0) {
            metaBadge = ` [meeting — ${linkedPeople.map(p => p.personName).join(", ")}]`;
          } else {
            metaBadge = ` [${meta.eventType}]`;
          }
        }

        return `- ${formatTime(e.start?.dateTime || e.start?.date || "")} — **${e.summary}**${attendeeStr}${loc}${metaBadge} [id: ${e.id}, cal: ${e.calendarId}, acct: ${e.accountId}]`;
      });

      let result = `${events.length} meetings:\n${lines.join("\n")}`;
      if (errors.length > 0) {
        const errorDetails = errors.map(e => `- Account ${e.accountId}: ${e.message}`).join("\n");
        result += `\n\n⚠️ Some accounts had errors:\n${errorDetails}`;
      }

      return { result };
    } catch (err: any) {
      return { result: `Failed to list meetings: ${err.message}`, error: true };
    }
  },

  async update_meeting(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarEdit", "edit calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      const { updateEvent, hasCalendarAccess } = await import("./google-calendar");
      const { listGmailAccounts } = await import("./gmail");
      const { getTimezone } = await import("./timezone");

      const eventId = args.eventId;
      if (!eventId) return { result: "Missing eventId", error: true };

      const accounts = await listGmailAccounts();
      const connected = [];
      for (const a of accounts) {
        if (await hasCalendarAccess(a.id)) connected.push(a);
      }
      if (connected.length === 0) return { result: "No Google accounts with calendar access.", error: true };

      const accountId = args.accountId || connected[0].id;
      const calendarId = args.calendarId || "primary";
      const tz = getTimezone();

      const updates: any = {};
      if (args.summary) updates.summary = args.summary;
      if (args.description) updates.description = args.description;
      if (args.location) updates.location = args.location;
      if (args.start) {
        updates.start = typeof args.start === "string"
          ? { dateTime: args.start, timeZone: tz }
          : args.start;
      }
      if (args.end) {
        updates.end = typeof args.end === "string"
          ? { dateTime: args.end, timeZone: tz }
          : args.end;
      }
      if (args.attendees) {
        updates.attendees = args.attendees.map((a: any) =>
          typeof a === "string" ? { email: a } : a
        );
      }
      if (args.visibility) updates.visibility = args.visibility;

      const updated = await updateEvent(accountId, calendarId, eventId, updates);
      await safeInvalidateCalendarCache("update_meeting");
      const changeStr = Object.keys(updates).join(", ");
      return { result: `Meeting updated: "${updated.summary}" — changed: ${changeStr}` };
    } catch (err: any) {
      return { result: `Failed to update meeting: ${err.message}`, error: true };
    }
  },

  async delete_meeting(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarDelete", "delete calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      const { deleteEvent, hasCalendarAccess } = await import("./google-calendar");
      const { listGmailAccounts } = await import("./gmail");

      const eventId = args.eventId;
      if (!eventId) return { result: "Missing eventId", error: true };

      const accounts = await listGmailAccounts();
      const connected = [];
      for (const a of accounts) {
        if (await hasCalendarAccess(a.id)) connected.push(a);
      }
      if (connected.length === 0) return { result: "No Google accounts with calendar access.", error: true };

      const accountId = args.accountId || connected[0].id;
      const calendarId = args.calendarId || "primary";

      await deleteEvent(accountId, calendarId, eventId);
      await safeInvalidateCalendarCache("delete_meeting");
      return { result: `Meeting deleted (id: ${eventId})` };
    } catch (err: any) {
      return { result: `Failed to delete meeting: ${err.message}`, error: true };
    }
  },

  async set_metadata_meeting(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarEdit", "edit calendar event metadata");
      if (calPermCheck.denied) return calPermCheck.result;

      const { setMetadata, EVENT_TYPES, classifyEventByTitle, getLinkedPeople, autoLogMeetingInteractions } = await import("./calendar-metadata");
      const googleEventId = args.googleEventId || args.eventId;
      const accountId = args.accountId;
      const calendarId = args.calendarId || "primary";
      if (!googleEventId) return { result: "Missing googleEventId", error: true };
      if (!accountId) return { result: "Missing accountId", error: true };

      let eventType = args.eventType;
      let summary = args.summary;
      let eventEndTime: string | undefined;
      let eventDate: string | undefined;

      let attendeeEmails: string[] | undefined = args.attendeeEmails;
      if (!attendeeEmails || attendeeEmails.length === 0) {
        try {
          const { getEvent } = await import("./google-calendar");
          const calEvent = await getEvent(accountId, calendarId, googleEventId);
          if (!summary) summary = calEvent.summary || "";
          eventEndTime = calEvent.end?.dateTime || calEvent.end?.date;
          eventDate = (calEvent.start?.dateTime || calEvent.start?.date || "").slice(0, 10);
          attendeeEmails = (calEvent.attendees || [])
            .filter((a: any) => a.email && !a.self)
            .map((a: any) => a.email as string);
        } catch (_) {
          attendeeEmails = [];
        }
      }

      if (!eventType && summary) {
        eventType = classifyEventByTitle(summary) || "meeting";
      }
      if (!eventType) return { result: `Missing eventType. Valid types: ${EVENT_TYPES.join(", ")}`, error: true };
      if (!EVENT_TYPES.includes(eventType)) {
        return { result: `Invalid eventType "${eventType}". Valid types: ${EVENT_TYPES.join(", ")}`, error: true };
      }

      const speakerPolicy = typeof args.sharedRoom === "boolean"
        ? { mode: args.sharedRoom ? "shared_room" as const : "participant_streams" as const }
        // Legacy attendee-email input now toggles the meeting-level topology.
        // The room occupants never need to match a calendar identity.
        : args.sharedAudioAttendeeEmail
          ? { mode: "shared_room" as const }
          : args.sharedAudioAttendeeEmail === null
            ? { mode: "participant_streams" as const }
            : undefined;
      const meta = await setMetadata(googleEventId, accountId, calendarId, eventType, args.notes, attendeeEmails, undefined, undefined, speakerPolicy);
      if (args.agendaLibraryPageId || args.agenda !== undefined) {
        const { setMeetingAgendaPage } = await import("./calendar-metadata");
        await setMeetingAgendaPage(meta, args.agendaLibraryPageId, args.agenda, summary || "Meeting");
      }
      const linkedPeople = await getLinkedPeople(meta.id);
      const peopleStr = linkedPeople.length > 0
        ? ` Auto-linked people: ${linkedPeople.map(p => p.personName).join(", ")}.`
        : "";

      // Auto-log meeting interactions for linked people when the event has ended
      let interactionStr = "";
      if (linkedPeople.length > 0 && eventEndTime) {
        const hasEnded = new Date(eventEndTime) <= new Date();
        if (hasEnded) {
          const logDate = eventDate || new Date().toISOString().slice(0, 10);
          const logResults = await autoLogMeetingInteractions(linkedPeople, summary || "Meeting", logDate);
          const logged = logResults.filter(r => r.logged);
          if (logged.length > 0) {
            interactionStr = ` Auto-logged interactions (responseOwed +3d) for: ${logged.map(r => r.personName).join(", ")}.`;
          }
        } else {
          const { createLogger } = await import("./log");
          createLogger("BridgeTools:set_metadata").debug(`skipping auto-log — event "${summary}" has not ended yet (ends ${eventEndTime})`);
        }
      }

      return { result: `Metadata set for event ${googleEventId}: type=${eventType}${args.notes ? `, notes recorded` : ""}${args.agendaLibraryPageId || args.agenda !== undefined ? `, agenda page linked` : ""}.${peopleStr}${interactionStr} (metadataId: ${meta.id})` };
    } catch (err: any) {
      return { result: `Failed to set metadata: ${err.message}`, error: true };
    }
  },

  async get_metadata_meeting(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarView", "view calendar event metadata");
      if (calPermCheck.denied) return calPermCheck.result;

      const { getMetadata, getLinkedPeople, getLinkedArtifacts, resolveMeetingAgendaPage } = await import("./calendar-metadata");
      const googleEventId = args.googleEventId || args.eventId;
      const accountId = args.accountId;
      const calendarId = args.calendarId || "primary";
      if (!googleEventId) return { result: "Missing googleEventId", error: true };
      if (!accountId) return { result: "Missing accountId", error: true };

      const meta = await getMetadata(googleEventId, accountId, calendarId);
      if (!meta) return { result: `No metadata found for event ${googleEventId}` };

      const [people, artifacts, agendaPage] = await Promise.all([
        getLinkedPeople(meta.id),
        getLinkedArtifacts(meta.id),
        resolveMeetingAgendaPage(meta),
      ]);

      const lines: string[] = [
        `Event: ${googleEventId}`,
        `Type: ${meta.eventType}`,
        ...(meta.notes ? [`Notes: ${meta.notes}`] : []),
        ...(agendaPage ? [`Agenda: @page:${agendaPage.id}`] : meta.agenda ? [`Legacy private agenda:\n${meta.agenda}`] : []),
      ];


      if (people.length > 0) {
        lines.push(`Linked people: ${people.map(p => p.personName).join(", ")}`);
      }

      if (artifacts.length > 0) {
        lines.push(`Linked artifacts:`);
        for (const a of artifacts) {
          const label = a.title || a.libraryPageId;
          lines.push(`  - [linkId: ${a.id}] ${label} (${a.artifactKind}) @page:${a.libraryPageId}`);
        }
      }

      return { result: lines.join("\n") };
    } catch (err: any) {
      return { result: `Failed to get metadata: ${err.message}`, error: true };
    }
  },

  async link_artifact_meeting(args) {
    try {
      const { linkArtifact, getMetadataByIds } = await import("./calendar-metadata");
      const metadataId = args.metadataId;
      const libraryPageId = args.libraryPageId || args.pageId || args.artifactId;
      if (!metadataId) return { result: "Missing metadataId", error: true };
      if (!libraryPageId) return { result: "Missing libraryPageId", error: true };

      const metaRows = await getMetadataByIds([metadataId]);
      if (!metaRows[0]) return { result: `No calendar event metadata found for id ${metadataId}`, error: true };
      const accountId = metaRows[0].accountId;

      const calPermCheck = await checkGmailPermission(accountId, "calendarEdit", "link artifacts to calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      let title = args.title;
      try {
        const { db } = await import("./db");
        const { libraryPages } = await import("@shared/models/info");
        const { eq } = await import("drizzle-orm");
        const page = (await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug }).from(libraryPages).where(eq(libraryPages.id, libraryPageId)).limit(1))[0]
          || (await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug }).from(libraryPages).where(eq(libraryPages.slug, libraryPageId)).limit(1))[0];
        if (!page) return { result: `Library page not found: ${libraryPageId}`, error: true };
        title = title || page.title;
        const link = await linkArtifact(metadataId, page.id, args.artifactKind || args.kind || "brief", title, args.source || "meetings_tool");
        return { result: `Linked artifact "${title || page.id}" to calendar event metadata (linkId: ${link.id})` };
      } catch (lookupErr: any) {
        return { result: `Failed to resolve library page: ${lookupErr.message}`, error: true };
      }
    } catch (err: any) {
      return { result: `Failed to link artifact: ${err.message}`, error: true };
    }
  },

  async unlink_artifact_meeting(args) {
    try {
      const { unlinkArtifact, getLinkedArtifactById, getMetadataByIds } = await import("./calendar-metadata");
      const linkId = args.linkId;
      if (!linkId) return { result: "Missing linkId", error: true };

      const artifactLink = await getLinkedArtifactById(linkId);
      if (!artifactLink) return { result: `Artifact link ${linkId} not found`, error: true };

      const metaRows = await getMetadataByIds([artifactLink.metadataId]);
      if (!metaRows[0]) return { result: `Calendar event metadata not found for link ${linkId}`, error: true };
      const accountId = metaRows[0].accountId;

      const calPermCheck = await checkGmailPermission(accountId, "calendarEdit", "remove artifact links from calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      await unlinkArtifact(linkId);
      return { result: `Artifact link ${linkId} removed` };
    } catch (err: any) {
      return { result: `Failed to unlink artifact: ${err.message}`, error: true };
    }
  },

  async strategy(args) {
    const { strategyStorage } = await import("./strategy-storage");
    const action = args.action || "list_strategies";
    const handler = strategySubHandlers[action];
    if (!handler) return { result: `Unknown strategy action: ${action}. Available: ${STRATEGY_ACTIONS}`, error: true };
    try {
      return await handler(args, strategyStorage);
    } catch (err: any) {
      return { result: `Strategy tool error: ${err.message}`, error: true };
    }
  },

  async decisions(args) {
    const { decisionsStorage } = await import("./decisions-storage");
    const { eventBus } = await import("./event-bus");
    const { markdownToTiptap } = await import("../shared/markdown-tiptap");
    const {
      decisionStatuses,
      decisionTrafficLights,
      decisionLinkTargetTypes,
    } = await import("@shared/schema");
    type DecisionRow = Awaited<ReturnType<typeof decisionsStorage.getDecision>>;
    type DecisionFull = NonNullable<DecisionRow>;

    const action = (args.action as string | undefined) || "list";

    const sectionToFields = (section: "data" | "scenarios" | "plan", markdown: string): Record<string, unknown> => {
      const json = markdownToTiptap(markdown || "");
      if (section === "data") return { dataContent: json, dataPlainText: markdown };
      if (section === "scenarios") return { scenariosContent: json, scenariosPlainText: markdown };
      return { planContent: json, planPlainText: markdown };
    };

    const summarize = (d: DecisionFull): string => {
      const lines = [
        `[${d.id}] ${d.title}`,
        `  status=${d.status}${d.trafficLight ? ` trafficLight=${d.trafficLight}` : ""}`,
        d.description ? `  ${d.description}` : null,
        d.dataPlainText ? `  data: ${d.dataPlainText.slice(0, 120)}` : null,
        d.scenariosPlainText ? `  scenarios: ${d.scenariosPlainText.slice(0, 120)}` : null,
        d.planPlainText ? `  plan: ${d.planPlainText.slice(0, 120)}` : null,
      ].filter((l): l is string => Boolean(l));
      return lines.join("\n");
    };

    const publish = (source: string): void => {
      eventBus.publish({ category: "system", event: "data:decisions_changed", payload: { source: `bridge_tool:${source}` } });
    };

    const requireString = (v: unknown, name: string): string => {
      if (typeof v !== "string" || !v) throw new Error(`Missing required: ${name}`);
      return v;
    };

    type DecisionsArgs = {
      action?: string;
      id?: string;
      title?: string;
      description?: string;
      status?: string;
      dataContent?: string;
      scenariosContent?: string;
      planContent?: string;
      trafficLight?: string;
      content?: string;
      updateId?: string;
      targetType?: string;
      targetId?: string | number;
      linkId?: string;
    };
    const a = args as DecisionsArgs;

    try {
      switch (action) {
        case "list": {
          const statusRaw = a.status;
          let status: "open" | "closed" | undefined;
          if (statusRaw && statusRaw !== "all") {
            if (!(decisionStatuses as readonly string[]).includes(statusRaw)) {
              return { result: `Invalid status: ${statusRaw}. Use open, closed, or all.`, error: true };
            }
            status = statusRaw as "open" | "closed";
          }
          const list = await decisionsStorage.listDecisions(status ? { status } : undefined);
          if (list.length === 0) return { result: status ? `No ${status} decisions.` : "No decisions found." };
          return { result: `${list.length} decision(s):\n${list.map(summarize).join("\n\n")}` };
        }
        case "get": {
          const id = requireString(a.id, "id");
          const d = await decisionsStorage.getDecision(id);
          if (!d) return { result: `Decision ${id} not found`, error: true };
          const updates = await decisionsStorage.listUpdates(id);
          const links = await decisionsStorage.listLinks(id);
          const sections = [
            summarize(d),
            d.dataPlainText ? `\nData:\n${d.dataPlainText}` : "",
            d.scenariosPlainText ? `\nScenarios:\n${d.scenariosPlainText}` : "",
            d.planPlainText ? `\nPlan:\n${d.planPlainText}` : "",
            links.length ? `\nLinks:\n${links.map(l => `  - ${l.targetType}:${l.targetId}`).join("\n")}` : "",
            updates.length ? `\nUpdates (${updates.length}):\n${updates.map(u => `  - [${u.id}] ${u.createdAt.toISOString?.() ?? u.createdAt} ${u.content.slice(0, 200)}`).join("\n")}` : "",
          ].filter(Boolean).join("\n");
          return { result: sections };
        }
        case "create": {
          const title = requireString(a.title, "title");
          const fields: Record<string, unknown> = { title };
          if (typeof a.description === "string") fields.description = a.description;
          if (typeof a.dataContent === "string") Object.assign(fields, sectionToFields("data", a.dataContent));
          if (typeof a.scenariosContent === "string") Object.assign(fields, sectionToFields("scenarios", a.scenariosContent));
          if (typeof a.planContent === "string") Object.assign(fields, sectionToFields("plan", a.planContent));
          const row = await decisionsStorage.createDecision(fields as Parameters<typeof decisionsStorage.createDecision>[0]);
          publish("create");
          return { result: `Created decision ${row.id} "${row.title}" (${row.status}).` };
        }
        case "update": {
          const id = requireString(a.id, "id");
          const updates: Record<string, unknown> = {};
          if (a.title !== undefined) updates.title = String(a.title);
          if (a.description !== undefined) updates.description = String(a.description);
          if (a.trafficLight !== undefined) {
            if (a.trafficLight !== null && !(decisionTrafficLights as readonly string[]).includes(a.trafficLight)) {
              return { result: `Invalid trafficLight: ${a.trafficLight}. Use green, yellow, or red.`, error: true };
            }
            updates.trafficLight = a.trafficLight;
          }
          if (typeof a.dataContent === "string") Object.assign(updates, sectionToFields("data", a.dataContent));
          if (typeof a.scenariosContent === "string") Object.assign(updates, sectionToFields("scenarios", a.scenariosContent));
          if (typeof a.planContent === "string") Object.assign(updates, sectionToFields("plan", a.planContent));
          const row = await decisionsStorage.updateDecision(id, updates);
          if (!row) return { result: `Decision ${id} not found`, error: true };
          publish("update");
          return { result: `Updated decision ${row.id}.` };
        }
        case "delete": {
          const id = requireString(a.id, "id");
          const ok = await decisionsStorage.deleteDecision(id);
          if (!ok) return { result: `Decision ${id} not found`, error: true };
          publish("delete");
          return { result: `Deleted decision ${id}.` };
        }
        case "lock": {
          const id = requireString(a.id, "id");
          const row = await decisionsStorage.lockDecision(id);
          if (!row) return { result: `Decision ${id} not found`, error: true };
          publish("lock");
          return { result: `Locked decision ${id}. trafficLight=${row.trafficLight ?? "green"}.` };
        }
        case "reopen": {
          const id = requireString(a.id, "id");
          const row = await decisionsStorage.reopenDecision(id);
          if (!row) return { result: `Decision ${id} not found`, error: true };
          publish("reopen");
          return { result: `Reopened decision ${id}.` };
        }
        case "add_update": {
          const id = requireString(a.id, "id");
          const content = requireString(a.content, "content");
          const d = await decisionsStorage.getDecision(id);
          if (!d) return { result: `Decision ${id} not found`, error: true };
          if (d.status !== "closed") return { result: `Decision ${id} is not closed; updates only allowed on closed decisions.`, error: true };
          const row = await decisionsStorage.addUpdate({ decisionId: id, content });
          publish("add_update");
          return { result: `Added update ${row.id} to decision ${id}.` };
        }
        case "edit_update": {
          const updateId = requireString(a.updateId, "updateId");
          const content = requireString(a.content, "content");
          const row = await decisionsStorage.editUpdate(updateId, content);
          if (!row) return { result: `Update ${updateId} not found`, error: true };
          publish("edit_update");
          return { result: `Edited update ${updateId}.` };
        }
        case "delete_update": {
          const updateId = requireString(a.updateId, "updateId");
          const ok = await decisionsStorage.deleteUpdate(updateId);
          if (!ok) return { result: `Update ${updateId} not found`, error: true };
          publish("delete_update");
          return { result: `Deleted update ${updateId}.` };
        }
        case "add_link": {
          const id = requireString(a.id, "id");
          const targetType = requireString(a.targetType, "targetType");
          if (!(decisionLinkTargetTypes as readonly string[]).includes(targetType)) {
            return { result: `Invalid targetType: ${targetType}. Use strategy or project.`, error: true };
          }
          const targetId = a.targetId === undefined ? "" : String(a.targetId);
          if (!targetId) return { result: "Missing required: targetId", error: true };
          const row = await decisionsStorage.addLink({
            decisionId: id,
            targetType: targetType as "strategy" | "project",
            targetId,
          });
          publish("add_link");
          return { result: `Linked decision ${id} → ${targetType}:${targetId} (link ${row.id}).` };
        }
        case "remove_link": {
          const linkId = requireString(a.linkId, "linkId");
          const ok = await decisionsStorage.deleteLink(linkId);
          if (!ok) return { result: `Link ${linkId} not found`, error: true };
          publish("remove_link");
          return { result: `Removed link ${linkId}.` };
        }
        default:
          return {
            result: `Unknown decisions action: ${action}. Available: list, get, create, update, delete, lock, reopen, add_update, edit_update, delete_update, add_link, remove_link`,
            error: true,
          };
      }
    } catch (err) {
      return { result: `Decisions tool error: ${err instanceof Error ? err.message : String(err)}`, error: true };
    }
  },


  async work(args) {
    const { fileProjectStorage } = await import("./file-storage/projects");
    const { fileTaskStorage } = await import("./file-storage/tasks");
    const { goalsService: goalsServiceWork } = await import("./goals-service");

    const action = args.action || "status";

    try {
      switch (action) {
        case "create_project": {
          if (!args.title) return { result: "Missing required field: title", error: true };
          const { insertProjectSchema: projectInsertSchema } = await import("../shared/models/work");
          const input = projectInsertSchema.parse({
            title: args.title,
            ...(args.description !== undefined && { description: args.description }),
            ...(args.status !== undefined && { status: args.status }),
            ...(args.priority !== undefined && { priority: args.priority }),
            ...(args.owner !== undefined && { owner: args.owner }),
            ...(args.dueDate !== undefined && { dueDate: args.dueDate }),
            ...(args.tags !== undefined && { tags: args.tags }),
            ...(args.people !== undefined && { people: args.people }),
            ...(args.goalId !== undefined && { goalId: args.goalId }),
          });
          const project = await fileProjectStorage.createProject(input);
          return { result: `Project created successfully. ID: ${project.id}, title: "${project.title}", status: ${project.status}, priority: ${project.priority}.` };
        }
        case "status":
        case "list_projects": {
          const statusFilter = args.status || undefined;
          const projects = await fileProjectStorage.getProjects(statusFilter ? { status: statusFilter } : undefined);
          if (projects.length === 0) return { result: statusFilter ? `No ${statusFilter} projects.` : "No projects found." };
          const allGoals = await goalsServiceWork.listAll({ includeDormant: true });
          const goalMap = new Map(allGoals.map((g: any) => [g.id, g.shortName]));

          const projectsByStatus = new Map<string, any[]>();
          for (const p of projects) {
            const s = p.status || "unknown";
            if (!projectsByStatus.has(s)) projectsByStatus.set(s, []);
            projectsByStatus.get(s)!.push(p);
          }

          const statusOrder = ["active", "planning", "idea", "completed", "archived"];
          const sortedStatuses = [...projectsByStatus.keys()].sort((a, b) => {
            const ia = statusOrder.indexOf(a);
            const ib = statusOrder.indexOf(b);
            return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
          });

          const sections: string[] = [];
          for (const status of sortedStatuses) {
            const group = projectsByStatus.get(status)!;
            const lines = await Promise.all(group.map(async (p: any) => {
              const milestoneCount = p.milestones?.length || 0;
              const taskCount = (await fileTaskStorage.getTasks({ projectId: p.id })).length;
              const goalPart = p.goalId ? `, goalId: ${p.goalId}, goalName: "${goalMap.get(p.goalId) || "unknown"}"` : "";
              return `- **${p.title}** (id: ${p.id}, ${p.status}${goalPart}) — ${milestoneCount} milestones, ${taskCount} tasks`;
            }));
            sections.push(`## ${status.charAt(0).toUpperCase() + status.slice(1)}\n${lines.join("\n")}`);
          }

          const label = statusFilter ? `${projects.length} ${statusFilter} projects` : `${projects.length} projects across all statuses`;
          return { result: `${label}:\n\n${sections.join("\n\n")}` };
        }
        case "get_project": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const project = await fileProjectStorage.getProject(Number(projectId));
          if (!project) return { result: `Project ${projectId} not found`, error: true };
          const tasks = await fileTaskStorage.getTasks({ projectId: project.id });
          let goalName = "";
          if (project.goalId) {
            const goal = await goalsServiceWork.get(project.goalId);
            goalName = goal ? goal.shortName : project.goalId;
          }
          const parts = [`**${project.title}** (id: ${project.id}, ${project.status}, priority: ${project.priority}${project.goalId ? `, goalId: ${project.goalId}, goalName: "${goalName}"` : ""})`];
          if (project.description) parts.push(`Description: ${project.description}`);
          if (project.milestones?.length) {
            parts.push(`Milestones: ${project.milestones.map((m: any) => `[${m.id}] ${m.name} (${m.status || "pending"})`).join(", ")}`);
          }
          if (tasks.length > 0) {
            const taskLines = tasks.map((t: any) => formatTaskForBridge(t));
            parts.push(`Tasks (${tasks.length}):\n${taskLines.join("\n")}`);
          } else {
            parts.push("No tasks.");
          }
          if (project.notes?.length) {
            const noteLines = project.notes.map((n: any) => `  - [${n.id}] ${n.content.slice(0, 100)}${n.content.length > 100 ? "..." : ""}`);
            parts.push(`Notes (${project.notes.length}):\n${noteLines.join("\n")}`);
          }
          if (project.files?.length) {
            const fileLines = project.files.map((f: any) => `  - [${f.id}] ${f.name} (${f.mimeType})`);
            parts.push(`Files (${project.files.length}):\n${fileLines.join("\n")}`);
          }
          return { result: parts.join("\n") };
        }
        case "list_tasks": {
          const projectId = args.id;
          const opts: any = {};
          if (projectId) opts.projectId = Number(projectId);
          if (args.status) opts.status = args.status;
          const tasks = await fileTaskStorage.getTasks(opts);
          if (tasks.length === 0) return { result: projectId ? `No tasks for project ${projectId}.` : "No tasks found." };
          const lines = tasks.map((t: any) => formatTaskForBridge(t));
          return { result: `${tasks.length} tasks:\n${lines.join("\n")}` };
        }
        case "add_file": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const workspacePath = args.workspacePath;
          let objectKey = args.fileObjectKey;
          let fileName = args.fileName;
          let fileSize = args.fileSize || 0;
          let mimeType = args.fileMimeType || "";

          if (workspacePath) {
            const { promises: fs } = await import("fs");
            const { join, basename, extname, resolve } = await import("path");
            const { WORKSPACE_DIR } = await import("./paths");
            const absPath = resolve(WORKSPACE_DIR, workspacePath);
            if (!absPath.startsWith(WORKSPACE_DIR + "/")) {
              return { result: "workspacePath must be within the workspace directory", error: true };
            }
            try {
              await fs.access(absPath);
            } catch {
              return { result: `File not found at workspace path: ${workspacePath}`, error: true };
            }
            const stat = await fs.stat(absPath);
            fileSize = stat.size;
            if (!fileName) fileName = basename(absPath);
            if (!mimeType) {
              const ext = extname(fileName).toLowerCase();
              mimeType = MIME_MAP[ext] || "application/octet-stream";
            }

            const fileBuffer = await fs.readFile(absPath);
            const uploaded = await objectStorageService.uploadObjectEntity(fileBuffer, {
              extension: extname(fileName),
              contentType: mimeType,
            });
            objectKey = uploaded.objectPath;
          }

          if (!fileName || !objectKey) return { result: "Missing fileName or fileObjectKey (or workspacePath)", error: true };
          if (!mimeType) mimeType = "application/octet-stream";
          const fileEntry = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name: fileName,
            mimeType,
            objectKey,
            size: fileSize,
            uploadedAt: new Date().toISOString(),
          };
          const fileProject = await fileProjectStorage.addFile(Number(projectId), fileEntry);
          if (!fileProject) return { result: `Project ${projectId} not found`, error: true };
          return { result: `File "${fileName}" attached to project ${projectId} (file id: ${fileEntry.id}, stored in object storage)` };
        }
        case "read_file": {
          const projectId = args.id;
          const fileId = args.fileId;
          if (!projectId || !fileId) return { result: "Missing project id or file id", error: true };
          const proj = await fileProjectStorage.getProject(Number(projectId));
          if (!proj) return { result: `Project ${projectId} not found`, error: true };
          const fileEntry = proj.files.find((f: any) => f.id === fileId);
          if (!fileEntry) return { result: `File ${fileId} not found in project ${projectId}`, error: true };
          const textTypes = ["text/", "application/json", "application/xml", "application/javascript", "application/typescript", "application/x-yaml", "application/yaml", "application/toml"];
          const textExts = [".md", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv", ".js", ".ts", ".py", ".sh", ".toml", ".ini", ".cfg", ".html", ".css", ".svg", ".log"];
          const isText = textTypes.some(t => fileEntry.mimeType.startsWith(t)) ||
            fileEntry.mimeType === "application/octet-stream" && textExts.some(ext => fileEntry.name.toLowerCase().endsWith(ext));
          if (!isText) return { result: `File "${fileEntry.name}" is a binary file (${fileEntry.mimeType}) and cannot be read as text. It can be viewed in the web UI.`, error: true };
          try {
            const objectPath = fileEntry.objectKey.startsWith("/objects/") ? fileEntry.objectKey : `/objects/${fileEntry.objectKey}`;
            const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
            const [buffer] = await objectFile.download();
            const content = buffer.toString("utf-8");
            const offset = typeof args?.offset === "number" && args.offset >= 0 ? args.offset : 0;
            const limit = typeof args?.limit === "number" && args.limit > 0 ? args.limit : undefined;
            if (offset > 0 || limit !== undefined) {
              const slice = limit !== undefined ? content.slice(offset, offset + limit) : content.slice(offset);
              return { result: `File "${fileEntry.name}" (offset=${offset}, showing ${slice.length} of ${content.length} chars):\n\n${slice}` };
            }
            if (content.length > 50000) {
              const { indexAndArchiveWithFallback } = await import("./content-indexer");
              const refBlock = await indexAndArchiveWithFallback({
                content,
                sourceType: "file",
                sourceLabel: fileEntry.name,
              });
              return { result: `File "${fileEntry.name}" (${content.length} chars):\n\n${refBlock}` };
            }
            return { result: `File "${fileEntry.name}" (${content.length} chars):\n\n${content}` };
          } catch (err: any) {
            return { result: `Failed to read file "${fileEntry.name}": ${err.message}`, error: true };
          }
        }
        case "remove_file": {
          const projectId = args.id;
          const fileId = args.fileId;
          if (!projectId || !fileId) return { result: "Missing project id or file id", error: true };
          const removedFile = await fileProjectStorage.removeFile(Number(projectId), fileId);
          if (!removedFile) return { result: `Project ${projectId} or file ${fileId} not found`, error: true };
          return { result: `File "${removedFile.name}" removed from project ${projectId}` };
        }
        case "add_milestone": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const name = args.name;
          if (!name) return { result: "Missing milestone name", error: true };
          const milestoneProject = await fileProjectStorage.addMilestone(Number(projectId), {
            name,
            status: args.milestoneStatus,
            startDate: args.startDate || null,
            dueDate: args.dueDate || null,
          });
          if (!milestoneProject) return { result: `Project ${projectId} not found`, error: true };
          const addedMilestone = milestoneProject.milestones[milestoneProject.milestones.length - 1];
          return { result: `Milestone "${name}" added to project ${projectId} (milestone id: ${addedMilestone.id})` };
        }
        case "update_milestone": {
          const projectId = args.id;
          const milestoneId = args.milestoneId;
          if (!projectId || !milestoneId) return { result: "Missing project id or milestone id", error: true };
          const preUpdateProject = await fileProjectStorage.getProject(Number(projectId));
          if (!preUpdateProject) return { result: `Project ${projectId} not found`, error: true };
          if (!preUpdateProject.milestones.some(m => m.id === Number(milestoneId))) {
            return { result: `Milestone ${milestoneId} not found in project ${projectId}`, error: true };
          }
          const updates: Record<string, string | number | null> = {};
          if (args.name) updates.name = args.name;
          const msStatus = args.milestoneStatus;
          if (msStatus) updates.status = msStatus;
          if (args.startDate) updates.startDate = args.startDate;
          if (args.dueDate) updates.dueDate = args.dueDate;
          if (args.order !== undefined) updates.order = args.order;
          await fileProjectStorage.updateMilestone(Number(projectId), Number(milestoneId), updates);
          return { result: `Milestone ${milestoneId} updated on project ${projectId}` };
        }
        case "remove_milestone": {
          const projectId = args.id;
          const milestoneId = args.milestoneId;
          if (!projectId || !milestoneId) return { result: "Missing project id or milestone id", error: true };
          const preRemoveProject = await fileProjectStorage.getProject(Number(projectId));
          if (!preRemoveProject) return { result: `Project ${projectId} not found`, error: true };
          if (!preRemoveProject.milestones.some(m => m.id === Number(milestoneId))) {
            return { result: `Milestone ${milestoneId} not found in project ${projectId}`, error: true };
          }
          await fileProjectStorage.removeMilestone(Number(projectId), Number(milestoneId));
          return { result: `Milestone ${milestoneId} removed from project ${projectId}` };
        }
        case "set_goal": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const goalId = args.goalId || null;
          if (goalId) {
            const goal = await goalsServiceWork.get(goalId);
            if (!goal) return { result: `Goal ${goalId} not found`, error: true };
          }
          const updated = await fileProjectStorage.updateProject(Number(projectId), { goalId });
          if (!updated) return { result: `Project ${projectId} not found`, error: true };
          if (goalId) {
            const goal = await goalsServiceWork.get(goalId);
            return { result: `Project ${projectId} linked to goal "${goal?.shortName || goalId}"` };
          }
          return { result: `Goal cleared from project ${projectId}` };
        }
        case "update_project": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };

          const { sanitizePatch, PatchGuardError, logPatchClearAudit } = await import("./lib/patch-guard");

          const raw: Record<string, unknown> = {};
          if (args.title !== undefined) raw.title = args.title;
          if (args.description !== undefined) raw.description = args.description;
          if (args.status !== undefined) raw.status = args.status;
          if (args.priority !== undefined) raw.priority = args.priority;
          if (args.owner !== undefined) raw.owner = args.owner;
          if (args.dueDate !== undefined) raw.dueDate = args.dueDate;
          if (args.tags !== undefined) raw.tags = args.tags;
          if (args.people !== undefined) raw.people = args.people;
          if (args.goalId !== undefined) raw.goalId = args.goalId;
          if (args.clearFields !== undefined) raw.clearFields = args.clearFields;
          if (args.confirmDestructiveUpdate !== undefined) raw.confirmDestructiveUpdate = args.confirmDestructiveUpdate;
          if (args.destructiveUpdateReason !== undefined) raw.destructiveUpdateReason = args.destructiveUpdateReason;

          try {
            const { patch: updates, clearFields, destructiveUpdateReason } = sanitizePatch(raw, {
              protectedFields: ['title', 'description'] as Array<keyof any>,
              clearableFields: ['description'] as Array<keyof any>,
              destructiveFields: ['description'] as Array<keyof any>,
            });

            // Apply explicit clears as null values
            for (const field of clearFields) {
              (updates as Record<string, unknown>)[field as string] = null;
            }
            logPatchClearAudit(toolExec, {
              operation: "projects.update_project",
              entityType: "project",
              entityId: projectId,
              clearFields,
              destructiveUpdateReason,
            });

            if (Object.keys(updates).length === 0) return { result: "No fields to update after sanitization. Empty strings on protected fields are dropped — use clearFields to explicitly clear a field.", error: true };

            const updatedProject = await fileProjectStorage.updateProject(Number(projectId), updates);
            if (!updatedProject) return { result: `Project ${projectId} not found`, error: true };
            return { result: `Project ${projectId} updated: ${Object.keys(updates).join(", ")}` };
          } catch (err: any) {
            if (err instanceof PatchGuardError) {
              return { result: `Patch guard rejected update: ${err.message}${err.required ? ` Required: ${JSON.stringify(err.required)}` : ''}`, error: true };
            }
            return { result: `Failed to update project: ${err instanceof Error ? err.message : String(err)}`, error: true };
          }
        }
        case "set_status": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const newStatus = args.status;
          if (!newStatus) return { result: "Missing status. Options: idea, planning, active, on_hold, completed", error: true };
          const validStatuses = ["idea", "planning", "active", "on_hold", "completed"];
          if (!validStatuses.includes(newStatus)) return { result: `Invalid status "${newStatus}". Options: ${validStatuses.join(", ")}`, error: true };
          const statusProject = await fileProjectStorage.updateProject(Number(projectId), { status: newStatus });
          if (!statusProject) return { result: `Project ${projectId} not found`, error: true };
          return { result: `Project ${projectId} status set to "${newStatus}"` };
        }
        case "delete_project": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const deleted = await fileProjectStorage.deleteProject(Number(projectId));
          if (!deleted) return { result: `Project ${projectId} not found`, error: true };
          return { result: `Project ${projectId} deleted` };
        }
        default:
          return { result: `Unknown work action: ${action}. Available: create_project, update_project, set_status, delete_project, status, list_projects, get_project, list_tasks, set_goal, add_note, update_note, remove_note, read_note, add_file, read_file, remove_file, add_milestone, update_milestone, remove_milestone`, error: true };
      }
    } catch (err: any) {
      return { result: `Work tool error: ${err.message}`, error: true };
    }
  },
  async git(args) {
    const { execFile } = await import("child_process");
    const { constants } = await import("fs");
    const { createHash } = await import("crypto");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { resolve, basename, relative, sep } = await import("path");
    const { mkdir: mkdirAsync, writeFile: writeFileAsync, unlink: unlinkAsync, access: accessAsync, symlink: symlinkAsync, readFile: readFileAsync, rm: rmAsync, lstat: lstatAsync, readlink: readlinkAsync } = await import("fs/promises");

    async function dirExists(p: string): Promise<boolean> {
      try { await accessAsync(p); return true; } catch { return false; }
    }

    async function executableExists(p: string): Promise<boolean> {
      try { await accessAsync(p, constants.X_OK); return true; } catch { return false; }
    }

    const REPOS_DIR = resolve(WORKSPACE_DIR, "repos");
    const MAX_OUTPUT = 10000;
    const action = args.action;

    if (!action) return { result: "Missing action parameter", error: true };

    const SAFE_REF = /^[a-zA-Z0-9_.\/~@^{}\-]+$/;
    const SAFE_BRANCH = /^[a-zA-Z0-9_.\/-]+$/;

    function sanitizeRef(val: string | undefined): string | null {
      if (!val) return null;
      if (!SAFE_REF.test(val)) return null;
      return val;
    }

    function sanitizeBranch(val: string | undefined): string | null {
      if (!val) return null;
      if (!SAFE_BRANCH.test(val)) return null;
      return val;
    }

    function truncate(output: string, limit = MAX_OUTPUT): string {
      if (output.length <= limit) return output;
      return output.slice(0, limit) + `\n... [truncated, ${output.length - limit} chars omitted]`;
    }

    function scrubTokens(text: string): string {
      return text
        .replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@")
        .replace(/https:\/\/[^@\s]+@github\.com/g, "https://***@github.com");
    }

    function resolveRepoDir(directory?: string): string | null {
      if (!directory) return null;
      const dir = resolve(REPOS_DIR, directory);
      const rel = relative(REPOS_DIR, dir);
      if (rel.startsWith("..") || rel.startsWith(sep)) return null;
      if (rel.length === 0) return null;
      return dir;
    }

    const SELF_DIR_ALIASES = new Set([".", "self", ""]);

    // Session isolation: extract the first 8 chars of the calling session ID.
    // Every clone gets a session-scoped directory. Write operations are restricted
    // to directories owned by the calling session. Read operations are unrestricted.
    const callingSessionId: string | undefined = args._sessionId;
    const sessionSuffix = callingSessionId ? callingSessionId.slice(0, 8) : "";

    function isOwnedBySession(dirName: string): boolean {
      if (!sessionSuffix) return true; // no session context → skip check (e.g. system calls)
      return dirName.endsWith(`-${sessionSuffix}`);
    }

    function requireWriteOwnership(dirName: string): string | null {
      if (!isOwnedBySession(dirName)) {
        return `Directory repos/${dirName} belongs to another session. Clone your own copy with git(action: "clone", url: "..."). Each session operates on its own working tree.`;
      }
      return null;
    }

    async function resolveReadOnlyRepoDir(directory?: string): Promise<string | null> {
      if (directory === undefined || directory === null || SELF_DIR_ALIASES.has(directory)) {
        const gitDir = resolve(WORKSPACE_DIR, ".git");
        if (await dirExists(gitDir)) return WORKSPACE_DIR;
        return null;
      }
      return resolveRepoDir(directory);
    }

    async function git(gitArgs: string[], cwd: string, env?: Record<string, string>): Promise<string> {
      const { stdout } = await execFileAsync("git", gitArgs, {
        cwd,
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 5,
        encoding: "utf-8",
        env: { ...process.env, ...env },
      });
      return stdout.toString().trim();
    }

    type GitAuthMode = "platform" | "legacy";
    type GitAuthCandidate = {
      mode: GitAuthMode;
      token: string;
      context: Record<string, unknown>;
    };

    function parseGitHubRepoUrl(repoUrl?: string): { owner: string; repo: string } | null {
      if (!repoUrl) return null;
      try {
        const parsed = new URL(repoUrl);
        if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
        const parts = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
        if (parts.length < 2 || !parts[0] || !parts[1]) return null;
        return { owner: parts[0], repo: parts[1] };
      } catch {
        return null;
      }
    }

    async function createAskpassEnv(token: string): Promise<Record<string, string>> {
      // Use unique askpass file per invocation to avoid race conditions between concurrent sessions.
      const askpassId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const askpass = resolve(`/tmp/.git-askpass-${askpassId}.sh`);
      await writeFileAsync(askpass, `#!/bin/sh\necho "${token}"\n`, { mode: 0o700 });
      return { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" };
    }

    async function resolvePlatformGitAuth(repoUrl?: string): Promise<GitAuthCandidate | null> {
      const repoRef = parseGitHubRepoUrl(repoUrl);
      if (!repoRef) return null;

      const explicitEnvironmentId = Number.isFinite(Number(args.platformEnvironmentId)) ? Number(args.platformEnvironmentId) : null;
      const explicitConnectionId = Number.isFinite(Number(args.connectionId)) ? Number(args.connectionId) : null;

      try {
        const { resolveGitSource } = await import("./git-source-resolver");
        const source = await resolveGitSource({
          repoUrl,
          platformEnvironmentId: explicitEnvironmentId,
          connectionId: explicitConnectionId,
          branch: sanitizeBranch(args.branch),
          matchBranch: action === "clone",
          requireIndexingEnabled: false,
        });
        if (!source) {
          toolExec.debug("git.clone.platform_auth_no_binding", {
            owner: repoRef.owner,
            repo: repoRef.repo,
            platformEnvironmentId: explicitEnvironmentId,
            connectionId: explicitConnectionId,
          });
          return null;
        }
        toolExec.log("git.clone.platform_auth_resolved", {
          owner: source.owner,
          repo: source.repo,
          platformEnvironmentId: source.environmentId,
          connectionId: source.connectionId,
          branch: source.branch || null,
        });
        return {
          mode: "platform",
          token: source.token,
          context: {
            platformEnvironmentId: source.environmentId,
            connectionId: source.connectionId,
            owner: source.owner,
            repo: source.repo,
            branch: source.branch || null,
          },
        };
      } catch (err: any) {
        toolExec.warn("git.clone.platform_auth_lookup_failed", {
          owner: repoRef.owner,
          repo: repoRef.repo,
          platformEnvironmentId: explicitEnvironmentId,
          connectionId: explicitConnectionId,
          error: err?.message || String(err),
        });
        return null;
      }
    }

    async function resolveLegacyGitAuth(repoUrl?: string): Promise<GitAuthCandidate> {
      const { getGitHubTokenForUrl, getGitHubAccessToken } = await import("./github-auth");
      const token = repoUrl
        ? await getGitHubTokenForUrl(repoUrl)
        : await getGitHubAccessToken();
      return { mode: "legacy", token, context: {} };
    }

    async function resolveGitHubApiToken(repoUrl: string): Promise<string> {
      const platform = await resolvePlatformGitAuth(repoUrl);
      if (platform) {
        toolExec.log("git.api.platform_auth_selected", {
          mode: platform.mode,
          ...platform.context,
        });
        return platform.token;
      }

      const legacy = await resolveLegacyGitAuth(repoUrl);
      toolExec.log("git.api.legacy_auth_selected", { repoUrl: scrubTokens(repoUrl) });
      return legacy.token;
    }

    async function getAuthEnv(repoUrl?: string): Promise<Record<string, string>> {
      const platform = repoUrl ? await resolvePlatformGitAuth(repoUrl) : null;
      if (platform) {
        toolExec.log("git.auth.platform_auth_selected", {
          mode: platform.mode,
          ...platform.context,
        });
        return createAskpassEnv(platform.token);
      }

      const legacy = await resolveLegacyGitAuth(repoUrl);
      toolExec.log("git.auth.legacy_auth_selected", { repoUrl: repoUrl ? scrubTokens(repoUrl) : null });
      return createAskpassEnv(legacy.token);
    }

    async function getCloneAuthCandidates(repoUrl: string): Promise<GitAuthCandidate[]> {
      const candidates: GitAuthCandidate[] = [];
      const platform = await resolvePlatformGitAuth(repoUrl);
      if (platform) candidates.push(platform);
      return candidates;
    }

    async function runNpm(commandArgs: string[], cwd: string): Promise<string> {
      const { stdout, stderr } = await execFileAsync("npm", commandArgs, {
        cwd,
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 20,
        encoding: "utf-8",
        env: { ...process.env, NODE_ENV: "development" },
      });
      return [stdout, stderr].filter(Boolean).join("\n").trim();
    }

    async function withDirectoryLock<T>(lockDir: string, actionName: string, fn: () => Promise<T>): Promise<T> {
      const startedAt = Date.now();
      const timeoutMs = 120000;

      while (true) {
        try {
          await mkdirAsync(lockDir);
          break;
        } catch (err: any) {
          if (err?.code !== "EEXIST") throw err;
          if (Date.now() - startedAt > timeoutMs) {
            throw new Error(`${actionName}: timed out waiting for lock ${lockDir}`);
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      try {
        return await fn();
      } finally {
        await rmAsync(lockDir, { recursive: true, force: true });
      }
    }

    async function ensureWorkspaceDependenciesHydrated(): Promise<string> {
      const packageLockPath = resolve(WORKSPACE_DIR, "package-lock.json");
      const rootNodeModules = resolve(WORKSPACE_DIR, "node_modules");
      const stampPath = resolve(rootNodeModules, ".xyz-hydrated-lock-hash");
      const lockDir = resolve(WORKSPACE_DIR, ".xyz-deps-hydration.lock");
      const requiredBins = ["tsx", "tsc", "vite"];

      const lockfile = await readFileAsync(packageLockPath, "utf-8");
      const lockHash = createHash("sha256").update(lockfile).digest("hex");

      async function hydrationProblem(): Promise<string | null> {
        if (!await dirExists(rootNodeModules)) return "node_modules missing";

        let stampedHash = "";
        try {
          stampedHash = (await readFileAsync(stampPath, "utf-8")).trim();
        } catch {
          return "hydration stamp missing";
        }

        if (stampedHash !== lockHash) return "package-lock hash changed";

        for (const bin of requiredBins) {
          const binPath = resolve(rootNodeModules, ".bin", bin);
          if (!await executableExists(binPath)) return `required binary missing: ${bin}`;
        }

        return null;
      }

      const initialProblem = await hydrationProblem();
      if (!initialProblem) return "workspace dependencies already hydrated";

      return await withDirectoryLock(lockDir, "workspace dependency hydration", async () => {
        const problemAfterLock = await hydrationProblem();
        if (!problemAfterLock) return "workspace dependencies already hydrated by another session";

        toolExec.log(`post-clone: hydrating workspace dependencies (${problemAfterLock})`);
        const installOutput = await runNpm(["ci", "--include=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], WORKSPACE_DIR);
        await writeFileAsync(stampPath, `${lockHash}\n`, "utf-8");

        const remainingProblem = await hydrationProblem();
        if (remainingProblem) {
          throw new Error(`workspace dependency hydration incomplete after npm ci: ${remainingProblem}`);
        }

        const summary = installOutput.split("\n").filter(Boolean).slice(-3).join("; ");
        return summary ? `workspace dependencies hydrated (${summary})` : "workspace dependencies hydrated";
      });
    }

    async function ensureCloneUsesSharedNodeModules(targetDir: string, dirName: string): Promise<string> {
      const hydrationStatus = await ensureWorkspaceDependenciesHydrated();

      // Post-clone: symlink node_modules from workspace root so builds work
      // without a full npm install in each session-scoped clone.
      const rootNodeModules = resolve(WORKSPACE_DIR, "node_modules");
      const clonedNodeModules = resolve(targetDir, "node_modules");
      let shouldCreateSymlink = true;

      try {
        const nodeModulesStat = await lstatAsync(clonedNodeModules);
        if (!nodeModulesStat.isSymbolicLink()) {
          await rmAsync(clonedNodeModules, { recursive: true, force: true });
          toolExec.warn(`post-clone: removed local node_modules in ${dirName}; replacing with shared workspace symlink`);
        } else {
          const currentTarget = resolve(targetDir, await readlinkAsync(clonedNodeModules));
          if (currentTarget === rootNodeModules) {
            shouldCreateSymlink = false;
          } else {
            await unlinkAsync(clonedNodeModules);
            toolExec.warn(`post-clone: replaced stale node_modules symlink in ${dirName} (${currentTarget} → ${rootNodeModules})`);
          }
        }
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }

      if (shouldCreateSymlink) {
        try {
          await symlinkAsync(rootNodeModules, clonedNodeModules, "dir");
          toolExec.log(`post-clone: symlinked node_modules from workspace root into ${dirName}`);
        } catch (symErr: any) {
          throw new Error(`post-clone: node_modules symlink failed: ${symErr.message}`);
        }
      }

      return hydrationStatus;
    }

    async function getRemoteUrl(dir: string): Promise<string | undefined> {
      try {
        return await git(["config", "--get", "remote.origin.url"], dir);
      } catch {
        return undefined;
      }
    }

    async function cleanupAskpass(env?: Record<string, string>) {
      try {
        if (env?.GIT_ASKPASS) {
          await unlinkAsync(env.GIT_ASKPASS);
        }
      } catch (err) { toolExec.debug("askpass cleanup failed", err); }
    }

    function triggerMobileBuildFromMainGitChange(input: { sourceRef?: string | null; reason: string }) {
      const sourceRef = input.sourceRef?.trim() || null;
      import("./system-settings")
        .then(({ getSetting }) => getSetting<boolean>("system.mobile_auto_build"))
        .then((autoBuildEnabled) => {
          if (autoBuildEnabled === false) {
            toolExec.log("Git tool main change skipped mobile build: auto-build is disabled", {
              reason: input.reason,
              sourceRef,
            });
            return { triggered: false, reason: "auto_build_disabled" };
          }
          return import("./integrations/expo")
            .then(({ triggerMainMobileBuild }) => triggerMainMobileBuild({
              profile: "preview",
              platform: "ios",
              sourceRef,
              reason: input.reason,
            }));
        })
        .then(result => {
          toolExec.log("Git tool main change mobile build trigger completed", {
            reason: input.reason,
            sourceRef,
            triggered: result.triggered,
            resultReason: result.reason,
            existingRunId: result.existingRunId,
          });
        })
        .catch((error: any) => {
          toolExec.error("Git tool main change mobile build trigger failed", {
            reason: input.reason,
            sourceRef,
            error: error?.message || String(error),
            stack: error?.stack,
          });
        });
    }

    try {
      switch (action) {
        case "clone": {
          const url = args.url;
          if (!url) return { result: "Missing url parameter for clone", error: true };

          try { new URL(url); } catch {
            return { result: "Invalid repository URL", error: true };
          }

          if (!await dirExists(REPOS_DIR)) await mkdirAsync(REPOS_DIR, { recursive: true });

          // Session isolation: always append -{sessionId[:8]} to the directory name.
          // This ensures each session gets its own working tree. No shared mutable state.
          const baseName = args.directory || basename(url.replace(/\.git$/, "")).replace(/[^a-zA-Z0-9._-]/g, "-");
          if (SELF_DIR_ALIASES.has(baseName)) return { result: "Cannot clone into the workspace root. Clones always go into repos/.", error: true };

          const dirName = sessionSuffix ? `${baseName}-${sessionSuffix}` : baseName;
          const targetDir = resolveRepoDir(dirName);
          if (!targetDir) return { result: "Invalid directory name", error: true };

          // Idempotent: if this session already cloned here, return the existing clone.
          if (await dirExists(targetDir)) {
            const hydrationStatus = await ensureCloneUsesSharedNodeModules(targetDir, dirName);
            const log = await git(["log", "--oneline", "-5"], targetDir);
            const currentBranch = await git(["branch", "--show-current"], targetDir);
            return { result: `Already cloned at repos/${dirName} (reusing existing clone)\nBranch: ${currentBranch}\nDependencies: ${hydrationStatus}\nRecent commits:\n${log}` };
          }

          const cloneArgs = ["clone"];
          const branch = sanitizeBranch(args.branch);
          if (branch) cloneArgs.push("--branch", branch);
          cloneArgs.push(url, targetDir);

          const candidates = await getCloneAuthCandidates(url);
          const failures: Array<{ mode: GitAuthMode; context: Record<string, unknown>; error: string }> = [];
          let usedMode: GitAuthMode | null = null;
          let degraded = false;
          let usedContext: Record<string, unknown> = {};
          let legacyFallbackQueued = false;

          if (candidates.length === 0) {
            const legacy = await resolveLegacyGitAuth(url);
            candidates.push(legacy);
            legacyFallbackQueued = true;
            toolExec.log("git.clone.legacy_auth_started_no_platform_binding", {
              directory: dirName,
              url,
            });
          }

          for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            const authEnv = await createAskpassEnv(candidate.token);
            try {
              toolExec.log(`git.clone.${candidate.mode}_auth_attempted`, {
                directory: dirName,
                url,
                ...candidate.context,
              });
              await git(cloneArgs, REPOS_DIR, authEnv);
              usedMode = candidate.mode;
              degraded = candidate.mode === "legacy" && failures.some(failure => failure.mode === "platform");
              usedContext = candidate.context;
              const successPayload = {
                directory: dirName,
                url,
                authMode: candidate.mode,
                degraded,
                ...candidate.context,
              };
              if (degraded) {
                toolExec.warn("git.clone.legacy_fallback_succeeded_degraded", successPayload);
              } else {
                toolExec.log(`git.clone.${candidate.mode}_auth_succeeded`, successPayload);
              }
              break;
            } catch (err: any) {
              const message = scrubTokens(err?.stderr || err?.message || String(err));
              failures.push({ mode: candidate.mode, context: candidate.context, error: message });
              toolExec.warn(`git.clone.${candidate.mode}_auth_failed`, {
                directory: dirName,
                url,
                authMode: candidate.mode,
                error: message,
                ...candidate.context,
              });
              await rmAsync(targetDir, { recursive: true, force: true });
              if (candidate.mode === "platform" && !legacyFallbackQueued) {
                try {
                  const legacy = await resolveLegacyGitAuth(url);
                  candidates.push(legacy);
                  legacyFallbackQueued = true;
                  toolExec.warn("git.clone.legacy_fallback_started", {
                    directory: dirName,
                    url,
                    platformFailure: message,
                    ...candidate.context,
                  });
                } catch (legacyErr: any) {
                  const legacyError = scrubTokens(legacyErr?.message || String(legacyErr));
                  failures.push({ mode: "legacy", context: {}, error: legacyError });
                  toolExec.warn("git.clone.legacy_fallback_unavailable", {
                    directory: dirName,
                    url,
                    error: legacyError,
                  });
                }
              }
            } finally {
              await cleanupAskpass(authEnv);
            }
          }

          if (!usedMode) {
            const failureSummary = failures.map(failure => {
              const context = Object.keys(failure.context).length > 0 ? ` ${JSON.stringify(failure.context)}` : "";
              return `${failure.mode}${context}: ${failure.error}`;
            }).join("\n");
            return { result: `Git clone failed after platform-first auth and legacy fallback.\n${failureSummary}`, error: true };
          }

          const hydrationStatus = await ensureCloneUsesSharedNodeModules(targetDir, dirName);

          const log = await git(["log", "--oneline", "-5"], targetDir);
          const currentBranch = await git(["branch", "--show-current"], targetDir);
          const authLine = `Auth: ${usedMode}${degraded ? " (legacy fallback, degraded)" : ""}`;
          const contextLine = Object.keys(usedContext).length > 0 ? `\nAuth context: ${JSON.stringify(usedContext)}` : "";
          return { result: `Cloned into repos/${dirName}\nBranch: ${currentBranch}\n${authLine}${contextLine}\nDependencies: ${hydrationStatus}\nRecent commits:\n${log}` };
        }

        case "pull": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return { result: "Cannot pull into the workspace root. Pull only works on cloned repos in repos/.", error: true };
          const ownershipErr = requireWriteOwnership(args.directory);
          if (ownershipErr) return { result: ownershipErr, error: true };
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Specify the directory name inside repos/.", error: true };

          const remoteUrl = await getRemoteUrl(dir);
          const authEnv = await getAuthEnv(remoteUrl);
          try {
            const pullArgs = ["pull"];
            const branch = sanitizeBranch(args.branch);
            if (branch) pullArgs.push("origin", branch);
            const output = await git(pullArgs, dir, authEnv);
            return { result: truncate(output) };
          } finally {
            cleanupAskpass(authEnv);
          }
        }

        case "status": {
          const dir = await resolveReadOnlyRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Use \".\" for the workspace repo, or specify a cloned repo name in repos/.", error: true };

          const currentBranch = await git(["branch", "--show-current"], dir);
          const status = await git(["status", "--short"], dir);

          let result = `Branch: ${currentBranch}\n`;
          result += status || "(clean working tree)";
          return { result: truncate(result) };
        }

        case "log": {
          const dir = await resolveReadOnlyRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Use \".\" for the workspace repo, or specify a cloned repo name in repos/.", error: true };

          // If workspace root is shallow, warn the caller
          if (SELF_DIR_ALIASES.has(args.directory || ".") || !args.directory) {
            const isShallow = (await git(["rev-parse", "--is-shallow-repository"], dir)).trim();
            if (isShallow === "true") {
              return { result: "The workspace root is a Railway shallow clone (depth 1). For full git history, use the GitHub API (fetchGitHubCommits, fetchMergedPRs) or clone the repo into repos/ first." };
            }
          }

          const count = Math.min(args.count || 20, 100);
          const logArgs = ["log", "--oneline", `--format=%h %an | %s (%cr)`, `-${count}`];
          if (args.grep) {
            const grepVal = String(args.grep).slice(0, 200);
            logArgs.push(`--grep=${grepVal}`);
          }

          const output = await git(logArgs, dir);
          return { result: truncate(output) };
        }

        case "diff": {
          const dir = await resolveReadOnlyRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Use \".\" for the workspace repo, or specify a cloned repo name in repos/.", error: true };

          const diffArgs = ["diff"];
          const r1 = sanitizeRef(args.ref1);
          const r2 = sanitizeRef(args.ref2);
          if (r1 && r2) { diffArgs.push(r1, r2); }
          else if (r1) { diffArgs.push(r1); }
          if (args.file) { diffArgs.push("--", String(args.file)); }

          const output = await git(diffArgs, dir);
          return { result: output ? truncate(output) : "(no differences)" };
        }

        case "branch": {
          const subAction = args.branchAction || "list";
          if (subAction === "list") {
            const dir = await resolveReadOnlyRepoDir(args.directory);
            if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Use \".\" for the workspace repo, or specify a cloned repo name in repos/.", error: true };
            const output = await git(["branch", "-a"], dir);
            return { result: output };
          }
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return { result: "Branch create/switch only works on cloned repos in repos/, not the workspace root.", error: true };
          const branchOwnerErr = requireWriteOwnership(args.directory);
          if (branchOwnerErr) return { result: branchOwnerErr, error: true };
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Branch create/switch only works on cloned repos in repos/.", error: true };
          switch (subAction) {
            case "create": {
              const name = sanitizeBranch(args.name);
              if (!name) return { result: "Missing or invalid branch name", error: true };
              await git(["checkout", "-b", name], dir);
              return { result: `Created and switched to branch: ${name}` };
            }
            case "switch": {
              const name = sanitizeBranch(args.name);
              if (!name) return { result: "Missing or invalid branch name", error: true };
              await git(["checkout", name], dir);
              return { result: `Switched to branch: ${name}` };
            }
            default:
              return { result: `Unknown branch action: ${subAction}. Use list, create, or switch.`, error: true };
          }
        }

        case "checkout": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return { result: "Checkout only works on cloned repos in repos/, not the workspace root.", error: true };
          const checkoutOwnerErr = requireWriteOwnership(args.directory);
          if (checkoutOwnerErr) return { result: checkoutOwnerErr, error: true };
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Checkout only works on cloned repos in repos/.", error: true };

          const ref = sanitizeRef(args.ref);
          if (!ref) return { result: "Missing or invalid ref/branch to checkout", error: true };

          const checkoutArgs = ["checkout", ref];
          if (args.file) checkoutArgs.push("--", String(args.file));

          await git(checkoutArgs, dir);
          let current: string;
          try { current = await git(["branch", "--show-current"], dir); } catch { current = ref; }
          return { result: `Checked out: ${current || ref}` };
        }

        case "show": {
          const dir = await resolveReadOnlyRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Use \".\" for the workspace repo, or specify a cloned repo name in repos/.", error: true };

          const ref = sanitizeRef(args.ref) || "HEAD";
          const output = await git(["show", "--stat", "--format=Commit: %H%nAuthor: %an <%ae>%nDate: %ci%n%n%s%n%n%b", ref], dir);
          return { result: truncate(output) };
        }

        case "add": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return { result: "git add only works on cloned repos in repos/, not the workspace root.", error: true };
          const addOwnerErr = requireWriteOwnership(args.directory);
          if (addOwnerErr) return { result: addOwnerErr, error: true };
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Specify the directory name inside repos/.", error: true };

          const files: string[] = Array.isArray(args.files) && args.files.length > 0
            ? args.files.map((f: string) => String(f))
            : ["."];
          await git(["add", ...files], dir);
          const staged = await git(["diff", "--cached", "--name-only"], dir);
          return { result: staged ? `Staged files:\n${staged}` : "(no changes to stage)" };
        }

        case "commit": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return { result: "git commit only works on cloned repos in repos/, not the workspace root.", error: true };
          const commitOwnerErr = requireWriteOwnership(args.directory);
          if (commitOwnerErr) return { result: commitOwnerErr, error: true };
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Specify the directory name inside repos/.", error: true };

          const message = args.message;
          if (!message || typeof message !== "string" || !message.trim()) return { result: "Missing commit message", error: true };

          const currentName = await git(["config", "--get", "user.name"], dir).catch(() => "");
          const currentEmail = await git(["config", "--get", "user.email"], dir).catch(() => "");
          if (!currentName) await git(["config", "user.name", getInstanceName()], dir);
          if (!currentEmail) await git(["config", "user.email", "xyz@xyz.bot"], dir);

          const output = await git(["commit", "-m", message.trim()], dir);
          const hash = await git(["rev-parse", "--short", "HEAD"], dir);
          return { result: `Committed ${hash}\n${truncate(output)}` };
        }

        case "push": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return { result: "git push only works on cloned repos in repos/, not the workspace root.", error: true };
          const pushOwnerErr = requireWriteOwnership(args.directory);
          if (pushOwnerErr) return { result: pushOwnerErr, error: true };
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Specify the directory name inside repos/.", error: true };

          const pushRemoteUrl = await getRemoteUrl(dir);
          const authEnv = await getAuthEnv(pushRemoteUrl);
          try {
            const currentBranch = await git(["branch", "--show-current"], dir);
            const branch = sanitizeBranch(args.branch) || currentBranch;
            if (!branch) return { result: "Could not determine branch to push", error: true };

            const hasUpstream = await git(["config", `branch.${branch}.remote`], dir).catch(() => "");
            const pushArgs = ["push"];
            if (args.force) pushArgs.push("--force");
            if (!hasUpstream) pushArgs.push("-u");
            pushArgs.push("origin", branch);

            const output = await git(pushArgs, dir, authEnv);
            if (branch === "main") {
              const sourceRef = await git(["rev-parse", "HEAD"], dir).catch(() => null);
              triggerMobileBuildFromMainGitChange({
                sourceRef,
                reason: `git_tool_push:main:${sourceRef || "unknown"}`,
              });
            }
            return { result: scrubTokens(output || `Pushed branch ${branch} to origin`) };
          } finally {
            cleanupAskpass(authEnv);
          }
        }

        case "create_pr": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return { result: "create_pr only works on cloned repos in repos/, not the workspace root.", error: true };
          const prOwnerErr = requireWriteOwnership(args.directory);
          if (prOwnerErr) return { result: prOwnerErr, error: true };
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Specify the directory name inside repos/.", error: true };

          const title = args.title;
          if (!title || typeof title !== "string" || !title.trim()) return { result: "Missing PR title", error: true };

          const remoteUrl = await git(["config", "--get", "remote.origin.url"], dir);
          const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
          if (!match) return { result: `Could not parse owner/repo from remote URL: ${scrubTokens(remoteUrl)}`, error: true };
          const [, owner, repo] = match;

          const head = await git(["branch", "--show-current"], dir);
          if (!head) return { result: "Could not determine current branch. Make sure you are on a feature branch.", error: true };

          const base = sanitizeBranch(args.base) || "main";

          const token = await resolveGitHubApiToken(remoteUrl);

          const prBody: Record<string, unknown> = {
            title: title.trim(),
            head,
            base,
            draft: !!args.draft,
          };
          if (args.body && typeof args.body === "string") prBody.body = args.body;

          const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify(prBody),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => "unknown error");
            return { result: `GitHub API error (${response.status}): ${scrubTokens(errText)}`, error: true };
          }

          const pr = await response.json() as { number: number; html_url: string; title: string };
          return { result: `PR #${pr.number} created: ${pr.html_url}\nTitle: ${pr.title}` };
        }
        case "merge_pr": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return { result: "merge_pr only works on cloned repos in repos/, not the workspace root.", error: true };
          const mergeOwnerErr = requireWriteOwnership(args.directory);
          if (mergeOwnerErr) return { result: mergeOwnerErr, error: true };
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Specify the directory name inside repos/.", error: true };

          const prNumber = args.pr_number;
          if (!prNumber) return { result: "Missing pr_number parameter", error: true };

          const remoteUrl = await git(["config", "--get", "remote.origin.url"], dir);
          const match = remoteUrl.match(/github\.com[:/]([^\/]+)\/(.+?)(?:\.git)?$/);
          if (!match) return { result: `Could not parse owner/repo from remote URL: ${scrubTokens(remoteUrl)}`, error: true };
          const [, owner, repo] = match;

          const token = await resolveGitHubApiToken(remoteUrl);

          const mergeBody: Record<string, unknown> = {
            merge_method: args.merge_method || "squash",
          };
          if (args.commit_title && typeof args.commit_title === "string") mergeBody.commit_title = args.commit_title;
          if (args.commit_message && typeof args.commit_message === "string") mergeBody.commit_message = args.commit_message;

          const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });

          if (!prResponse.ok) {
            const errText = await prResponse.text().catch(() => "unknown error");
            return { result: `GitHub API error (${prResponse.status}): ${scrubTokens(errText)}`, error: true };
          }

          const prDetails = await prResponse.json() as { base?: { ref?: string } };
          const baseBranch = prDetails.base?.ref || "";

          const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
            method: "PUT",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify(mergeBody),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => "unknown error");
            return { result: `GitHub API error (${response.status}): ${scrubTokens(errText)}`, error: true };
          }

          const result = await response.json() as { sha: string; message: string; merged: boolean };
          if (!result.merged) return { result: `Merge failed: ${result.message}`, error: true };
          if (baseBranch === "main") {
            triggerMobileBuildFromMainGitChange({
              sourceRef: result.sha,
              reason: `git_tool_merge_pr:${prNumber}:main:${result.sha || "unknown"}`,
            });
          }
          return { result: `PR #${prNumber} merged successfully.\nSHA: ${result.sha}\nMessage: ${result.message}` };
        }

        case "delete_branch": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return { result: "delete_branch only works on cloned repos in repos/, not the workspace root.", error: true };
          const delBranchOwnerErr = requireWriteOwnership(args.directory);
          if (delBranchOwnerErr) return { result: delBranchOwnerErr, error: true };
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return { result: "Repository directory not found. Specify the directory name inside repos/.", error: true };

          const branchName = sanitizeBranch(args.branch);
          if (!branchName) return { result: "Missing or invalid branch name", error: true };

          const remoteUrl = await git(["config", "--get", "remote.origin.url"], dir);
          const match = remoteUrl.match(/github\.com[:/]([^\/]+)\/(.+?)(?:\.git)?$/);
          if (!match) return { result: `Could not parse owner/repo from remote URL: ${scrubTokens(remoteUrl)}`, error: true };
          const [, owner, repo] = match;

          const token = await resolveGitHubApiToken(remoteUrl);

          const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branchName}`, {
            method: "DELETE",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });

          if (!response.ok && response.status !== 422) {
            const errText = await response.text().catch(() => "unknown error");
            return { result: `GitHub API error (${response.status}): ${scrubTokens(errText)}`, error: true };
          }

          return { result: `Remote branch '${branchName}' deleted from origin.` };
        }


        default:
          return { result: `Unknown git action: ${action}. Available: clone, pull, status, log, diff, branch, checkout, show, add, commit, push, create_pr, merge_pr, delete_branch`, error: true };
      }
    } catch (err: any) {
      const msg = err.stderr?.toString?.() || err.stdout?.toString?.() || err.message || String(err);
      return { result: `Git error: ${truncate(scrubTokens(msg), 2000)}`, error: true };
    }
  },

  async pronunciation(args) {
    const action = args.action || "list";

    try {
      const { listEntries, addEntry, updateEntry, removeEntry } = await import("./pronunciation");

      switch (action) {
        case "list": {
          const entries = await listEntries();
          if (entries.length === 0) return { result: "No pronunciation entries yet. Add one with action: 'add', word, and alias." };
          const lines = entries.map(e => `- "${e.word}" → "${e.alias}"`);
          return { result: `${entries.length} pronunciation entries:\n${lines.join("\n")}` };
        }
        case "add": {
          const word = args.word as string;
          const alias = args.alias as string;
          if (!word || !alias) return { result: "Missing word or alias (pronunciation)", error: true };
          const entry = await addEntry(word, alias);
          return { result: `Pronunciation added: "${entry.word}" → "${entry.alias}". This will take effect on the next voice session.` };
        }
        case "update": {
          const word = args.word as string;
          const alias = args.alias as string;
          if (!word || !alias) return { result: "Missing word or alias (pronunciation)", error: true };
          const entry = await updateEntry(word, alias);
          return { result: `Pronunciation updated: "${entry.word}" → "${entry.alias}"` };
        }
        case "remove": {
          const word = args.word as string;
          if (!word) return { result: "Missing word to remove", error: true };
          await removeEntry(word);
          return { result: `Pronunciation removed for "${word}"` };
        }
        default:
          return { result: `Unknown pronunciation action: ${action}. Available: list, add, update, remove`, error: true };
      }
    } catch (err: any) {
      return { result: `Pronunciation tool error: ${err.message}`, error: true };
    }
  },

  async rules(args) {
    const { fileRuleStorage } = await import("./file-storage/rules");
    const action = args.action || "list";

    try {
      switch (action) {
        case "list": {
          const all = await fileRuleStorage.getAll();
          if (all.length === 0) return { result: "No personal Rules saved yet." };
          const lines = all.map((rule) =>
            `- [${rule.id}] ${rule.rule} (source: ${rule.source}, scope: ${rule.scope}${rule.context ? `, context: ${rule.context}` : ""}${rule.tags.length > 0 ? `, tags: ${rule.tags.join(", ")}` : ""})`,
          );
          return { result: `${all.length} personal Rules:
${lines.join("\n")}` };
        }
        case "get": {
          const id = args.id;
          if (!id) return { result: "Missing Rule id", error: true };
          const rule = await fileRuleStorage.getById(id);
          if (!rule) return { result: `Rule ${id} not found`, error: true };
          return {
            result: [
              `**Rule**: ${rule.rule}`,
              `ID: ${rule.id}`,
              `Source: ${rule.source}`,
              `Scope: ${rule.scope}`,
              `Context: ${rule.context || "N/A"}`,
              `Tags: ${rule.tags.length > 0 ? rule.tags.join(", ") : "none"}`,
            ].join("\n"),
          };
        }
        case "save":
        case "create": {
          const ruleText = typeof args.rule === "string" ? args.rule.trim() : "";
          if (!ruleText) return { result: "Missing Rule text", error: true };
          const existingRules = await fileRuleStorage.getAll().catch(() => []);
          const duplicate = existingRules.find((rule) => isSimilarText(rule.rule, ruleText));
          if (duplicate) {
            return { result: `Equivalent personal Rule already exists: "${duplicate.rule}" (ID: ${duplicate.id})` };
          }
          const rule = await fileRuleStorage.create({
            rule: ruleText,
            source: args.source,
            scope: args.scope,
            context: args.context,
            tags: args.tags,
          });
          eventBus.publish({ category: "agent", event: "data:rule_created", payload: { id: rule.id, rule: rule.rule, scope: rule.scope } });
          return { result: `Personal Rule saved: "${rule.rule}" (ID: ${rule.id}, scope: ${rule.scope})` };
        }
        case "update": {
          const id = args.id;
          if (!id) return { result: "Missing Rule id", error: true };
          const updates: Record<string, unknown> = {};
          if (typeof args.rule === "string" && args.rule.trim()) updates.rule = args.rule.trim();
          if (args.source) updates.source = args.source;
          if (args.scope) updates.scope = args.scope;
          if (typeof args.context === "string" && args.context.trim()) updates.context = args.context.trim();
          if (Array.isArray(args.tags) && args.tags.length > 0) updates.tags = args.tags;
          const updated = await fileRuleStorage.update(id, updates);
          if (!updated) return { result: `Rule ${id} not found`, error: true };
          eventBus.publish({ category: "agent", event: "data:rule_updated", payload: { id, fields: Object.keys(updates) } });
          return { result: `Personal Rule updated: "${updated.rule}"` };
        }
        case "delete": {
          const id = args.id;
          if (!id) return { result: "Missing Rule id", error: true };
          const deleted = await fileRuleStorage.delete(id);
          if (!deleted) return { result: `Rule ${id} not found`, error: true };
          return { result: `Rule ${id} deleted.` };
        }
        default:
          return { result: `Unknown rules action: ${action}. Available: list, get, save, create, update, delete`, error: true };
      }
    } catch (err: any) {
      return { result: `Rules tool error: ${err.message}`, error: true };
    }
  },

  async skills(args) {
    const action = args.action || "list";
    const { storage } = await import("./storage");

    try {
      switch (action) {
        case "list": {
          const filters: { status?: string; category?: string } = {};
          if (args.status) filters.status = args.status;
          if (args.category) filters.category = args.category;
          const allSkills = await storage.getSkills(Object.keys(filters).length > 0 ? filters : undefined);
          if (allSkills.length === 0) return { result: "No skills found." };
          const lines = allSkills.map(s =>
            `- **${s.name}** (${s.category || "general"}) [${s.status}]\n  ${s.description?.slice(0, 120) || "No description"}${s.author === "system" ? " [built-in]" : ""}`
          );
          return { result: `${allSkills.length} skills:\n${lines.join("\n")}` };
        }
        case "get": {
          const identifier = args.name;
          if (!identifier) return { result: "Missing skill name", error: true };
          let skill = await storage.getSkillByName(identifier);
          if (!skill) skill = await storage.getSkill(identifier);
          if (!skill) return { result: `Skill "${identifier}" not found`, error: true };
          const parts = [
            `**${skill.name}** (id: ${skill.id})`,
            `Category: ${skill.category || "general"} | Activity: ${skill.activity || "n/a"} | Status: ${skill.status}`,
            `Author: ${skill.author || "user"} | Version: ${skill.version} | Session Type: ${skill.sessionType || "default (autonomous)"}`,
          ];
          if (skill.description) parts.push(`Description: ${skill.description}`);
          parts.push(`\nProcess:\n${skill.process}`);
          if (skill.whenToUse) parts.push(`\nWhen To Use:\n${skill.whenToUse}`);
          if (skill.outputSpec) parts.push(`Output Spec:\n${skill.outputSpec}`);
          parts.push(`\n${formatChecklistForXyz(skill.checklist)}`);
          return { result: parts.join("\n") };
        }
        case "create": {
          if (!args.name || !args.process) return { result: "Missing required fields: name, process", error: true };
          const newSkill = await storage.createSkill({
            name: args.name,
            description: args.description || "",
            process: args.process,
            whenToUse: args.whenToUse || "",
            outputSpec: args.outputSpec || "",
            qualityCriteria: "",
            checklist: Array.isArray(args.checklist) ? args.checklist : [],
            status: "active",
            author: getInstanceName(),
            version: args.version || "1.0",
            category: args.category || "general",
            activity: args.activity || ACTIVITY_FRAMING,
            sessionType: args.sessionType || null,
          } as any);
          return { result: `Created skill "${newSkill.name}" (id: ${newSkill.id})` };
        }
        case "update": {
          const id = args.id;
          if (!id) return { result: "Missing skill id", error: true };
          const existing = await storage.getSkill(id);
          if (!existing) return { result: `Skill "${id}" not found`, error: true };
          const updates: Record<string, unknown> = {};
          for (const key of ["name", "description", "process", "whenToUse", "outputSpec", "status", "version", "category", "activity", "sessionType"]) {
            if (args[key] !== undefined) updates[key] = args[key];
          }
          if (args.checklist !== undefined) updates.checklist = Array.isArray(args.checklist) ? args.checklist : [];
          const updated = await storage.updateSkill(id, updates);
          if (!updated) return { result: `Failed to update skill "${id}"`, error: true };
          return { result: `Updated skill "${updated.name}" (id: ${updated.id})` };
        }
        case "set_persona": {
          const identifier = args.id || args.name;
          if (!identifier) return { result: "Missing skill id or name", error: true };
          let skill = await storage.getSkill(identifier);
          if (!skill) skill = await storage.getSkillByName(identifier);
          if (!skill) return { result: `Skill "${identifier}" not found`, error: true };
          const personaId = args.personaId;
          if (personaId !== null && (typeof personaId !== "number" || !Number.isInteger(personaId))) {
            return { result: "personaId must be an integer or null", error: true };
          }
          const { setSkillPersonaPreference } = await import("./skill-persona-service");
          await setSkillPersonaPreference(skill.id, personaId);
          if (personaId === null) {
            return { result: `Cleared persona override for "${skill.name}"; it will use the product recommendation.` };
          }
          const { personaStorage } = await import("./file-storage/persona-storage");
          const persona = await personaStorage.get(personaId);
          return { result: `Set persona override for "${skill.name}" to ${persona?.name || personaId}.` };
        }
        case "delete": {
          const id = args.id;
          if (!id) return { result: "Missing skill id", error: true };
          const existing = await storage.getSkill(id);
          if (!existing) return { result: `Skill "${id}" not found`, error: true };
          if (existing.author === "system") return { result: `Cannot delete built-in skill "${existing.name}"`, error: true };
          await storage.deleteSkill(id);
          return { result: `Deleted skill "${existing.name}" (id: ${id})` };
        }
        case "search": {
          const query = (args.query || "").toLowerCase();
          if (!query) return { result: "Missing search query", error: true };
          const allSkills = await storage.getSkills();
          const matches = allSkills.filter(s =>
            s.name.toLowerCase().includes(query) ||
            (s.description || "").toLowerCase().includes(query) ||
            (s.category || "").toLowerCase().includes(query) ||
            (s.process || "").toLowerCase().includes(query)
          );
          if (matches.length === 0) return { result: `No skills matching "${query}"` };
          const lines = matches.map(s =>
            `- **${s.name}** (${s.category || "general"}) [${s.status}]\n  ${s.description?.slice(0, 120) || "No description"}${s.author === "system" ? " [built-in]" : ""}`
          );
          return { result: `${matches.length} skills matching "${query}":\n${lines.join("\n")}` };
        }
        case "run": {
          const skillId = args.id || args.name;
          if (!skillId) return { result: "Missing skill ID or name (use 'id' or 'name' parameter)", error: true };

          const callingConversationId = args._sessionId;
          if (normalizeSkillIdentifier(skillId) === "spec" && await isSpecSkillSession(callingConversationId)) {
            return {
              result: "Guard blocked recursive spec skill launch: this session is already the spec skill. Continue producing the current spec artifact instead of starting another spec run.",
              error: true,
            };
          }

          const { executeAutonomousSkillRun } = await import("./autonomous-skill-runner");

          const waitForResult = args.wait !== false;
          const preContext = args.preContext;
          const runOptions: {
            preContext?: string;
            parentSessionId?: string;
            spawnReason?: string;
            spawnerTool?: string;
            spawnerSkillRun?: string;
            onSessionCreated?: (id: string) => void;
          } = {
            preContext,
            parentSessionId: callingConversationId || undefined,
            spawnReason: callingConversationId ? `skill:${skillId}` : undefined,
            spawnerTool: "skills.run",
            // Idempotency tuple: same (parent, skill) combination from the
            // same parent session collapses into one child instead of
            // spawning duplicates.
            spawnerSkillRun: callingConversationId ? `skills.run:${callingConversationId}:${skillId}` : undefined,
          };

          if (waitForResult) {
            const result = await executeAutonomousSkillRun(skillId, runOptions);
            if (!result) return { result: `Skill "${skillId}" could not be started — not found in registry or database, or already running`, error: true };

            return {
              result: `Skill "${skillId}" ${result.status} in ${Math.round(result.durationMs / 1000)}s. Session: ${result.sessionId}${result.error ? ` Error: ${result.error}` : ""}`,
            };
          } else {
            let childSessionId: string | null = null;
            const sessionCreatedPromise = new Promise<string>((resolve) => {
              runOptions.onSessionCreated = (id: string) => {
                childSessionId = id;
                resolve(id);
              };
            });

            const runPromise = executeAutonomousSkillRun(skillId, runOptions);

            const raceResult = await Promise.race([
              runPromise,
              sessionCreatedPromise.then(() => "session_created" as const),
              new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 5000)),
            ]);

            if (raceResult === null) {
              return { result: `Skill "${skillId}" could not be started — not found in registry or database, or already running`, error: true };
            }

            if (typeof raceResult === "object" && raceResult !== null && "sessionId" in raceResult) {
              const result = raceResult as { sessionId: string; status: string; durationMs: number; error?: string };
              return {
                result: `Skill "${skillId}" ${result.status} in ${Math.round(result.durationMs / 1000)}s. Session: ${result.sessionId}${result.error ? ` Error: ${result.error}` : ""}`,
              };
            }

            return {
              result: `Skill "${skillId}" spawned (fire-and-forget). Status: started. Session: ${childSessionId || "pending"}. The run is executing in the background.`,
            };
          }
        }
        case "runs": {
          const skillName = args.name as string;
          const limit = typeof args.limit === "number" ? args.limit : 20;
          if (!skillName) return { result: "Missing 'name' parameter", error: true };
          const runs = await storage.getSkillRuns(skillName, limit);

          // Pull failure context (endReason + last crash/error snippet) from
          // the chat session for each run. skill_runs has no dedicated error
          // column — the dashboard surfaces this by reading the underlying
          // session, so we mirror that here for Agent.
          const { chatFileStorage } = await import("./chat-file-storage");
          const enriched = await Promise.all(runs.map(async (r) => {
            let endReason: string | undefined;
            let failureReason: string | null = null;
            try {
              const session = await chatFileStorage.getSession(r.sessionId);
              endReason = session?.endReason;
              if (r.status === "failed") {
                if (endReason && endReason !== "complete") {
                  failureReason = endReason;
                }
                // For crashes/failures, try to surface the last assistant or
                // system message as additional context.
                try {
                  const messages = await chatFileStorage.getMessagesBySession(r.sessionId);
                  for (let i = messages.length - 1; i >= 0; i--) {
                    const m = messages[i];
                    if (m.role === "system" || m.role === "assistant") {
                      const snippet = (m.content || "").slice(0, 240);
                      if (snippet.trim()) {
                        failureReason = failureReason
                          ? `${failureReason}: ${snippet}`
                          : snippet;
                      }
                      break;
                    }
                  }
                } catch {}
              }
            } catch {}
            return {
              id: r.id,
              sessionId: r.sessionId,
              status: r.status,
              endReason: endReason ?? null,
              failureReason,
              startedAt: r.startedAt,
              completedAt: r.completedAt,
              durationMs: r.durationMs,
              passRate: r.passRate,
              checklistTotal: r.checklistTotal,
              checklistPassed: r.checklistPassed,
              comparativeWinner: r.comparativeWinner,
              comparativeReason: r.comparativeReason,
            };
          }));

          return {
            result: JSON.stringify({
              skillName,
              count: enriched.length,
              runs: enriched,
            }),
          };
        }
        case "scores": {
          const skillName = args.name as string;
          const limit = typeof args.limit === "number" ? args.limit : 20;
          if (!skillName) return { result: "Missing 'name' parameter", error: true };

          const runs = await storage.getSkillRuns(skillName, limit);
          const scoredRuns = runs.filter(r => r.passRate !== null && r.passRate !== undefined);

          const scoreView = scoredRuns.map(r => ({
            id: r.id,
            source: "skill_runs" as const,
            sessionId: r.sessionId,
            status: r.status,
            checklistTotal: r.checklistTotal,
            checklistPassed: r.checklistPassed,
            checklistResults: r.checklistResults,
            comparativeWinner: r.comparativeWinner,
            comparativeReason: r.comparativeReason,
            passRate: r.passRate as number,
            durationMs: r.durationMs,
            scoredAt: r.completedAt ?? r.startedAt,
          }));

          return {
            result: JSON.stringify({
              skillName,
              source: "skill_runs",
              totalRuns: runs.length,
              scoredRuns: scoredRuns.length,
              scores: scoreView,
              trend: scoreView.length >= 2
                ? (scoreView[0].passRate > scoreView[scoreView.length - 1].passRate ? "improving" : scoreView[0].passRate === scoreView[scoreView.length - 1].passRate ? "stable" : "declining")
                : "insufficient_data",
            }),
          };
        }
        default:
          return { result: `Unknown skills action: ${action}. Available: list, get, create, update, set_persona, delete, search, run, runs, scores`, error: true };
      }
    } catch (err: any) {
      return { result: `Skills tool error: ${err.message}`, error: true };
    }
  },

  async router(args) {
    const action = args.action || "list_inference_calls";

    const resolveDiagnosticTier = (profile: string | undefined): SemanticTier | undefined => {
      if (!profile) return undefined;
      const parsed = semanticTierSchema.safeParse(String(profile).toLowerCase());
      return parsed.success ? parsed.data : undefined;
    };

    try {
      switch (action) {
        case "list_inference_calls": {
          const { fileApiCallStorage } = await import("./file-storage/api-calls");
          const limit = Math.min(parseInt(args.limit) || 50, 200);
          let calls = await fileApiCallStorage.getApiCalls(limit, 0);

          if (args.profile) calls = calls.filter(c => c.profile === args.profile);
          if (args.model) calls = calls.filter(c => c.model === args.model);
          if (args.status) {
            const { eventBus } = await import("./event-bus");
            const bootTime = new Date(eventBus.bootTimestamp).getTime();
            if (args.status === "complete") {
              calls = calls.filter(c => new Date(c.timestamp as any).getTime() >= bootTime);
            } else if (args.status === "past") {
              calls = calls.filter(c => new Date(c.timestamp as any).getTime() < bootTime);
            }
          }

          if (calls.length === 0) return { result: "No inference calls found matching the criteria." };
          const lines = calls.slice(0, limit).map(c => {
            const ts = c.timestamp instanceof Date ? c.timestamp.toISOString() : c.timestamp;
            const cost = c.costTotal ? `$${c.costTotal.toFixed(4)}` : "$0";
            const duration = c.durationMs ? `${(c.durationMs / 1000).toFixed(1)}s` : "n/a";
            return `- [${ts}] id:${c.id} model:${c.model} profile:${c.profile || "unknown"} cost:${cost} in:${c.inputTokens} out:${c.outputTokens} dur:${duration}`;
          });
          return { result: `${calls.length} inference calls:\n${lines.join("\n")}` };
        }
        case "get_inference_call": {
          const id = parseInt(args.id || "");
          if (isNaN(id)) return { result: "Missing or invalid inference call id", error: true };
          const { fileApiCallStorage } = await import("./file-storage/api-calls");
          const call = await fileApiCallStorage.getApiCall(id);
          if (!call) return { result: `Inference call ${id} not found`, error: true };
          const ts = call.timestamp instanceof Date ? call.timestamp.toISOString() : call.timestamp;
          const parts = [
            `**Inference Call #${call.id}**`,
            `Model: ${call.model} | Provider: ${call.provider}`,
            `Profile: ${call.profile || "unknown"}`,
            `Tokens: ${call.inputTokens} in / ${call.outputTokens} out (${call.totalTokens} total)`,
            `Cost: $${(call.costTotal || 0).toFixed(4)} (input: $${(call.costInput || 0).toFixed(4)}, output: $${(call.costOutput || 0).toFixed(4)})`,
            `Duration: ${call.durationMs ? `${(call.durationMs / 1000).toFixed(1)}s` : "n/a"}`,
            `Timestamp: ${ts}`,
            `Stop Reason: ${call.stopReason || "n/a"}`,
          ];
          if (call.requestContent) parts.push(`\n--- Input ---\n${call.requestContent}`);
          if (call.responseContent) parts.push(`\n--- Output ---\n${call.responseContent}`);
          return { result: parts.join("\n") };
        }
        case "eval": {
          const systemPrompt = String(args.systemPrompt || "");
          const userPrompt = String(args.userPrompt || "");
          if (!systemPrompt.trim() && !userPrompt.trim()) return { result: "Missing systemPrompt or userPrompt", error: true };

          const maxPromptChars = 120_000;
          if (systemPrompt.length + userPrompt.length > maxPromptChars) {
            return { result: `Prompt too large for router.eval (${systemPrompt.length + userPrompt.length} chars > ${maxPromptChars})`, error: true };
          }
          const maxTokens = Math.max(1, Math.min(parseInt(args.maxTokens) || 1200, 4000));
          const temperatureRaw = typeof args.temperature === "number" ? args.temperature : parseFloat(args.temperature);
          const temperature = Number.isFinite(temperatureRaw) ? Math.max(0, Math.min(temperatureRaw, 1)) : 0.2;
          const requestedProfile = args.profile ? String(args.profile) : undefined;
          const diagnosticTier = resolveDiagnosticTier(requestedProfile);
          if (requestedProfile && !diagnosticTier) {
            return { result: "router.eval profile is now a diagnostic semantic-tier override. Use max, high, balanced, or fast.", error: true };
          }
          const activity = args.activityId ? String(args.activityId) as ActivityId : ACTIVITY_CHAT;
          const sessionKey = `router_eval:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

          const { chatCompletion } = await import("./model-client");
          const result = await chatCompletion({
            activity,
            messages: [
              ...(systemPrompt.trim() ? [{ role: "system" as const, content: systemPrompt }] : []),
              { role: "user" as const, content: userPrompt },
            ],
            jsonMode: !!args.jsonMode,
            maxTokens,
            temperature,
            semanticTierOverride: diagnosticTier,
            overrideReason: diagnosticTier ? "router.eval diagnostic semantic-tier override" : undefined,
            metadata: {
              source: "router.eval",
              activity,
              sessionKey,
              toolName: "router",
              ...(args.metadata && typeof args.metadata === "object" ? args.metadata : {}),
            },
          });

          let parsedJson: unknown = undefined;
          if (args.jsonMode) {
            try {
              const { extractJson } = await import("./utils/extract-json");
              parsedJson = JSON.parse(extractJson(result.content));
            } catch (jsonErr: unknown) {
              parsedJson = { parseError: jsonErr instanceof Error ? jsonErr.message : String(jsonErr) };
            }
          }

          const { fileApiCallStorage } = await import("./file-storage/api-calls");
          const recent = await fileApiCallStorage.getApiCalls(10, 0);
          const audit = recent.find(c => c.sessionKey === sessionKey);
          return {
            result: JSON.stringify({
              provider: result.provider,
              model: result.model,
              requestedProfile: requestedProfile ?? null,
              requestedSemanticTier: diagnosticTier ?? null,
              resolvedTier: result.metadata?.routing?.tier ?? audit?.metadata?.routing?.tier ?? audit?.profile ?? null,
              auditProfile: audit?.profile ?? null,
              activity,
              inputTokens: result.usage?.promptTokens ?? null,
              outputTokens: result.usage?.completionTokens ?? null,
              totalTokens: result.usage?.totalTokens ?? null,
              inferenceCallId: audit?.id ?? null,
              rawOutput: result.content,
              parsedJson,
            }, null, 2),
          };
        }
        default:
          return { result: `Unknown router action: ${action}. Available: eval, list_inference_calls, get_inference_call`, error: true };
      }
    } catch (err: any) {
      return { result: `Router tool error: ${err.message}`, error: true };
    }
  },

  async converse(args) {
    const action = args.action || "initiate";

    if (action === "set_attention") {
      const sessionId = args.sessionId;
      if (!sessionId) return { result: "Missing 'sessionId' parameter for set_attention action", error: true };
      try {
        const { chatFileStorage } = await import("./chat-file-storage");
        const conv = await chatFileStorage.getSession(sessionId);
        if (!conv) return { result: `Session ${sessionId} not found`, error: true };
        const isPinned = (args.isPinned ?? args.needsAttention) !== false;
        await chatFileStorage.setSessionPinned(sessionId, isPinned);
        return { result: `Session ${sessionId} pin flag set to ${isPinned}` };
      } catch (err: any) {
        return { result: `set_attention error: ${err.message}`, error: true };
      }
    }

    const topic = args.topic?.trim();
    const message = args.message?.trim();
    if (!topic) return { result: "Missing 'topic' parameter", error: true };
    if (!message) return { result: "Missing 'message' parameter", error: true };

    try {
      const { chatFileStorage } = await import("./chat-file-storage");

      const shortTitle = topic.split(/\s+/).slice(0, 3).join(" ");
      const callingSessionId: string | undefined = args._sessionId || undefined;
      const spawnReason = `converse:${topic.slice(0, 40)}`;

      let convId: string;
      {
        // Converse sessions are always top-level so they appear in the main
        // SessionMenu. Never parent them under the calling autonomous session,
        // which would hide them behind the autonomous-sessions fold.
        const created = await chatFileStorage.createAutonomousSession(
          shortTitle,
          "agent",
          undefined,
          undefined,
          undefined,
          { spawnReason, spawnerTool: "converse.initiate", triggerType: "agent" as const, triggerId: callingSessionId || undefined, triggerName: topic },
        );
        convId = created.id;
      }
      const conv = { id: convId };

      const fullMessage = message;
      await chatFileStorage.createMessage(conv.id, "assistant", fullMessage);
      await chatFileStorage.setSessionPinned(conv.id, true);
      // Mark unread so the session gets unread emphasis in the session menu and
      // trips the global notification indicator, matching timer/reminder-initiated
      // sessions. Cleared when the user opens the conversation.
      await chatFileStorage.setHasUnreadResult(conv.id, true);
      await chatFileStorage.saveSession(conv.id, shortTitle);

      const { eventBus } = await import("./event-bus");
      eventBus.publish({
        category: "chat",
        event: "chat.xyz.initiated",
        payload: { sessionId: conv.id, topic },
      });

      return { result: `Created conversation "${topic}" (${conv.id}) pinned and marked unread. It will stay highlighted in the session menu until the user opens it.` };
    } catch (err: any) {
      return { result: `Failed to create conversation: ${err.message}`, error: true };
    }
  },


  async memory_graph(args) {
    return {
      result: JSON.stringify({
        deprecated: true,
        storage: "memory_entries",
        message: "Legacy memory_graph is retired. Use vNext claim graph endpoints and memory tool actions: search_claims, vnext_claim_detail, get_entity_links, and run_vnext_lifecycle.",
        requestedAction: args?.action || "create_link",
      }),
      error: true,
    };
  },
  async list_amortizations(_args: Record<string, any>): Promise<ToolHandlerResult> {
    const log = createLogger("BridgeTools:list_amortizations");
    try {
      const { listAmortizationsWithTxn } = await import("./finance-amortization");
      const rows = await listAmortizationsWithTxn({ activeOnly: false });
      if (rows.length === 0) return { result: "No transaction amortizations configured." };
      const lines = rows.map(r => {
        const status = r.isActive ? (r.orphaned ? "ORPHANED" : "active") : "inactive";
        const txnLabel = r.txnMonth ? `${r.txnMonth} ${r.txnName ?? ""}` : `(deleted txn #${r.transactionId})`;
        return `- #${r.id} [${status}] ${txnLabel}: $${r.originalAmount.toLocaleString()} spread over ${r.spreadMonths}mo from ${r.startMonth} (${r.category})${r.notes ? ` — ${r.notes}` : ""}`;
      });
      return { result: `**Transaction Amortizations** (${rows.length})\n${lines.join("\n")}` };
    } catch (e: any) {
      log.error("[Finance] list_amortizations error:", e?.message);
      return { result: `Error listing amortizations: ${e?.message}`, error: true };
    }
  },

  async amortize(args: Record<string, any>): Promise<ToolHandlerResult> {
    const log = createLogger("BridgeTools:amortize");
    try {
      const { createAmortization, updateAmortization } = await import("./finance-amortization");

      // Update existing amortization when an `id` is provided.
      const idArg = args.id;
      const id = typeof idArg === "number" ? idArg : (typeof idArg === "string" && idArg.length > 0 ? parseInt(idArg) : NaN);
      if (!isNaN(id)) {
        const patch: Partial<{ spreadMonths: number; startMonth: string; category: string; isActive: boolean; notes: string | null }> = {};
        if (typeof args.spreadMonths === "number") {
          if (args.spreadMonths < 1 || args.spreadMonths > 120) return { result: "spreadMonths must be 1-120", error: true };
          patch.spreadMonths = args.spreadMonths;
        }
        if (typeof args.startMonth === "string") {
          if (!/^\d{4}-\d{2}$/.test(args.startMonth)) return { result: "startMonth must be YYYY-MM", error: true };
          patch.startMonth = args.startMonth;
        }
        if (typeof args.category === "string") patch.category = args.category;
        if (typeof args.isActive === "boolean") patch.isActive = args.isActive;
        if (typeof args.notes === "string" || args.notes === null) patch.notes = args.notes;
        const row = await updateAmortization(id, patch);
        if (!row) return { result: `Amortization #${id} not found`, error: true };
        return { result: `Updated amortization #${row.id}.` };
      }

      // Otherwise create a new amortization.
      if (typeof args.transactionId !== "string") return { result: "transactionId is required (Plaid transaction ID string)", error: true };
      if (typeof args.originalAmount !== "number") return { result: "originalAmount is required", error: true };
      if (typeof args.spreadMonths !== "number" || args.spreadMonths < 1 || args.spreadMonths > 120) return { result: "spreadMonths must be 1-120", error: true };
      if (typeof args.startMonth !== "string" || !/^\d{4}-\d{2}$/.test(args.startMonth)) return { result: "startMonth must be YYYY-MM", error: true };
      if (typeof args.category !== "string") return { result: "category is required", error: true };
      const row = await createAmortization({
        transactionId: args.transactionId,
        originalAmount: args.originalAmount,
        spreadMonths: args.spreadMonths,
        startMonth: args.startMonth,
        category: args.category,
        isActive: args.isActive !== false,
        notes: typeof args.notes === "string" ? args.notes : null,
      });
      return { result: `Created amortization #${row.id}: $${row.originalAmount.toLocaleString()} spread over ${row.spreadMonths}mo from ${row.startMonth}.` };
    } catch (e: any) {
      log.error("[Finance] amortize error:", e?.message);
      return { result: `Error amortizing transaction: ${e?.message}`, error: true };
    }
  },

  async remove_amortization(args: Record<string, any>): Promise<ToolHandlerResult> {
    const log = createLogger("BridgeTools:remove_amortization");
    try {
      const id = typeof args.id === "number" ? args.id : parseInt(args.id);
      if (isNaN(id)) return { result: "id is required (numeric)", error: true };
      const { softDeleteAmortization } = await import("./finance-amortization");
      const ok = await softDeleteAmortization(id);
      if (!ok) return { result: `Amortization #${id} not found`, error: true };
      return { result: `Deactivated amortization #${id}.` };
    } catch (e: any) {
      log.error("[Finance] remove_amortization error:", e?.message);
      return { result: `Error removing amortization: ${e?.message}`, error: true };
    }
  },

  async get_finance_summary(): Promise<ToolHandlerResult> {
    try {
      const { getFinanceSummary, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV in Settings → Connections.` };
      }
      const summary = await getFinanceSummary();
      if (summary.accountCount === 0) return { result: "No financial accounts connected yet. Connect a bank account in Settings → Connections." };
      const parts: string[] = [];

      if (summary.trajectory) {
        const t = summary.trajectory;
        const statusLabel = t.trajectoryStatus === "on_track" ? "On Track" : t.trajectoryStatus === "drifting" ? "Drifting" : "Off Track";
        parts.push(`**Financial Trajectory** [${statusLabel}]`);
        parts.push(`Net Worth: $${t.currentNetWorth.toLocaleString()} → $${t.projectedNetWorth12mo.toLocaleString()} (projected 12mo)`);
        parts.push(`Monthly Net Cash Flow: $${t.monthlyNetCashFlow.toLocaleString()}/mo`);
        parts.push(`Liquid Cash: $${t.liquidCash.toLocaleString()} | Total Liabilities: $${t.totalLiabilities.toLocaleString()}`);
        if (t.lastCompletedMonth) {
          const lm = t.lastCompletedMonth;
          parts.push(``);
          parts.push(`Last Completed Month (${lm.month}):`);
          parts.push(`  Income: expected $${lm.expectedIncome.toLocaleString()}, actual $${lm.actualIncome.toLocaleString()}`);
          parts.push(`  Spending: expected $${lm.expectedSpending.toLocaleString()}, actual $${lm.actualSpending.toLocaleString()}`);
          parts.push(`  Net Cash Flow: expected $${lm.expectedNetCashFlow.toLocaleString()}, actual $${lm.actualNetCashFlow.toLocaleString()}` + (lm.netCashFlowDeviationPct !== null ? ` (${lm.netCashFlowDeviationPct >= 0 ? "+" : ""}${lm.netCashFlowDeviationPct.toFixed(1)}%)` : ""));
          if (lm.topDivergentCategories.length > 0) {
            parts.push(`  Top Divergences:`);
            for (const c of lm.topDivergentCategories) {
              const sign = c.deltaAbs >= 0 ? "+" : "";
              parts.push(`    - ${c.category}: ${sign}$${c.deltaAbs.toFixed(0)}` + (c.deltaPct !== null ? ` (${sign}${c.deltaPct.toFixed(0)}%)` : ""));
            }
          }
        }
        parts.push(``);
      }

      parts.push(`**Snapshot**`);
      parts.push(`Net Worth: $${summary.netWorth.toLocaleString()}`);
      parts.push(`Total Assets: $${summary.totalAssets.toLocaleString()}`);
      parts.push(`Total Liabilities: $${summary.totalLiabilities.toLocaleString()}`);
      parts.push(`Accounts: ${summary.accountCount}`);
      if (summary.savingsRate !== null) parts.push(`Savings Rate (30-day, trailing): ${summary.savingsRate}%`);
      if (Object.keys(summary.spendingByCategory).length > 0) {
        const catLines = Object.entries(summary.spendingByCategory)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, amount]) => `  - ${cat}: $${amount.toFixed(2)}`);
        parts.push(`\nSpending by Category (30-day):\n${catLines.join("\n")}`);
      }
      if (Object.keys(summary.investmentAllocation).length > 0) {
        const allocLines = Object.entries(summary.investmentAllocation)
          .sort((a, b) => b[1] - a[1])
          .map(([type, pct]) => `  - ${type}: ${pct}%`);
        parts.push(`\nInvestment Allocation:\n${allocLines.join("\n")}`);
      }
      if (summary.recurringObligations > 0) parts.push(`\nRecurring Obligations: $${summary.recurringObligations.toLocaleString()}/month`);
      return { result: parts.join("\n") };
    } catch (err: any) {
      return { result: `Finance summary error: ${err.message}`, error: true };
    }
  },

  async get_accounts(): Promise<ToolHandlerResult> {
    try {
      const { getAccountsList, getPlaidItems, isPlaidConfigured } = await import("./plaid-service");
      const { db } = await import("./db");
      const { manualAssets, manual401kAccounts, incomeDeductions, incomeSources } = await import("@shared/schema");

      const parts: string[] = ["**Account Balances**\n"];

      if (isPlaidConfigured()) {
        const items = await getPlaidItems();
        const accounts = await getAccountsList();
        const byItem = new Map<string, typeof accounts>();
        for (const a of accounts) {
          const list = byItem.get(a.itemId) || [];
          list.push(a);
          byItem.set(a.itemId, list);
        }
        for (const item of items) {
          parts.push(`**${item.institutionName}** ${item.healthy ? "✓" : "⚠ " + (item.healthError || "unhealthy")}`);
          const itemAccounts = byItem.get(item.itemId) || [];
          for (const a of itemAccounts) {
            const bal = a.currentBalance !== null ? `$${a.currentBalance.toLocaleString()}` : "N/A";
            const avail = a.availableBalance !== null ? ` (available: $${a.availableBalance.toLocaleString()})` : "";
            const limit = a.creditLimit !== null ? ` (limit: $${a.creditLimit.toLocaleString()})` : "";
            parts.push(`  - ${a.name} [${a.type}/${a.subtype || "—"}]: ${bal}${avail}${limit}`);
          }
        }
      }

      const assets = await db.select().from(manualAssets).where(visibleFinanceForCurrentPrincipal(manualAssets));
      if (assets.length > 0) {
        parts.push("\n**Manual Assets**");
        for (const a of assets) {
          parts.push(`  - ${a.name} [${a.category}]: $${a.currentValue.toLocaleString()}`);
        }
      }

      const [k401Rows, deductionRows, sourceRows] = await Promise.all([
        db.select().from(manual401kAccounts).where(visibleFinanceForCurrentPrincipal(manual401kAccounts)),
        db.select().from(incomeDeductions).where(visibleFinanceForCurrentPrincipal(incomeDeductions)),
        db.select().from(incomeSources).where(visibleFinanceForCurrentPrincipal(incomeSources)),
      ]);
      if (k401Rows.length > 0) {
        const FREQ_MULT: Record<string, number> = { weekly: 52/12, biweekly: 26/12, semimonthly: 2, monthly: 1, quarterly: 1/3, annually: 1/12 };
        const deductionMap = new Map(deductionRows.map(d => [d.id, d]));
        const sourceMap = new Map(sourceRows.map(s => [s.id, s]));
        parts.push("\n**401k Accounts**");
        for (const a of k401Rows) {
          const ded = a.linkedDeductionId ? deductionMap.get(a.linkedDeductionId) : null;
          const source = ded ? sourceMap.get(ded.sourceId) : null;
          const mult = source ? (FREQ_MULT[source.payFrequency] || 1) : 1;
          const monthly = ded ? ded.amount * mult : 0;
          parts.push(`  - ${a.name}: $${a.currentBalance.toLocaleString()}${monthly > 0 ? ` (contribution $${monthly.toFixed(0)}/mo)` : ""}`);
        }
      }

      if (parts.length <= 1) return { result: "No financial accounts connected, no manual assets, and no 401k accounts." };
      return { result: parts.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Accounts error: ${msg}`, error: true };
    }
  },

  async get_transactions(args: Record<string, any>): Promise<ToolHandlerResult> {
    try {
      const { getTransactions, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV.` };
      }
      const { transactions: txns } = await getTransactions({
        startDate: args.startDate,
        endDate: args.endDate,
        category: args.category,
        accountId: args.accountId,
        limit: args.limit,
      });
      if (txns.length === 0) return { result: "No transactions found for the given filters." };
      const lines = txns.map((t: any) => {
        const sign = t.amount >= 0 ? "-" : "+";
        const absAmt = Math.abs(t.amount).toFixed(2);
        const merchant = t.merchantName || t.name;
        const cat = t.categoryPrimary ? ` [${t.categoryPrimary}]` : "";
        const pending = t.pending ? " (pending)" : "";
        return `${t.date} ${sign}$${absAmt} ${merchant}${cat}${pending}`;
      });
      return { result: `${txns.length} transactions:\n${lines.join("\n")}` };
    } catch (err: any) {
      return { result: `Transactions error: ${err.message}`, error: true };
    }
  },

  async get_holdings(): Promise<ToolHandlerResult> {
    try {
      const { getHoldingsList, isPlaidConfigured } = await import("./plaid-service");
      const { db } = await import("./db");
      const { manual401kAccounts, incomeDeductions, incomeSources } = await import("@shared/schema");

      const [k401Rows, deductionRows, sourceRows] = await Promise.all([
        db.select().from(manual401kAccounts).where(visibleFinanceForCurrentPrincipal(manual401kAccounts)),
        db.select().from(incomeDeductions).where(visibleFinanceForCurrentPrincipal(incomeDeductions)),
        db.select().from(incomeSources).where(visibleFinanceForCurrentPrincipal(incomeSources)),
      ]);

      let holdings: any[] = [];
      if (isPlaidConfigured()) {
        holdings = await getHoldingsList();
      }

      if (holdings.length === 0 && k401Rows.length === 0) {
        if (!isPlaidConfigured()) {
          const { getPlaidConfigDiagnostics } = await import("./plaid-service");
          const diag = getPlaidConfigDiagnostics();
          const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
          return { result: `No investment holdings found. Plaid is not configured: ${issues.join("; ")}.` };
        }
        return { result: "No investment holdings found." };
      }

      const parts: string[] = [];

      if (holdings.length > 0) {
        const lines = holdings.map((h: any) => {
          const ticker = h.tickerSymbol ? ` (${h.tickerSymbol})` : "";
          const value = h.institutionValue ? `$${h.institutionValue.toFixed(2)}` : "N/A";
          const costBasis = h.costBasis ? `cost basis: $${h.costBasis.toFixed(2)}` : "";
          return `- ${h.securityName || "Unknown"}${ticker}: ${h.quantity} shares @ ${value}${costBasis ? ` (${costBasis})` : ""}`;
        });
        const brokerageTotal = holdings.reduce((s: number, h: any) => s + (h.institutionValue || 0), 0);
        parts.push(`**Brokerage Holdings (${holdings.length})**\nSubtotal: $${brokerageTotal.toLocaleString()}\n${lines.join("\n")}`);
      }

      if (k401Rows.length > 0) {
        const FREQ_MULT: Record<string, number> = { weekly: 52/12, biweekly: 26/12, semimonthly: 2, monthly: 1, quarterly: 1/3, annually: 1/12 };
        const deductionMap = new Map(deductionRows.map(d => [d.id, d]));
        const sourceMap = new Map(sourceRows.map(s => [s.id, s]));
        const k401Total = k401Rows.reduce((s, a) => s + a.currentBalance, 0);
        const lines = k401Rows.map(a => {
          const ded = a.linkedDeductionId ? deductionMap.get(a.linkedDeductionId) : null;
          const source = ded ? sourceMap.get(ded.sourceId) : null;
          const mult = source ? (FREQ_MULT[source.payFrequency] || 1) : 1;
          const monthly = ded ? ded.amount * mult : 0;
          return `- **${a.name}**: balance $${a.currentBalance.toLocaleString()}${monthly > 0 ? `, contribution $${monthly.toFixed(0)}/mo` : ""}`;
        });
        parts.push(`**401k Accounts (${k401Rows.length})**\nSubtotal: $${k401Total.toLocaleString()}\n${lines.join("\n")}`);
      }

      const brokerageTotal = holdings.reduce((s: number, h: any) => s + (h.institutionValue || 0), 0);
      const k401Total = k401Rows.reduce((s, a) => s + a.currentBalance, 0);
      const grandTotal = brokerageTotal + k401Total;
      parts.push(`\n**Total Invested: $${grandTotal.toLocaleString()}**`);

      return { result: parts.join("\n\n") };
    } catch (err: any) {
      return { result: `Holdings error: ${err.message}`, error: true };
    }
  },

  async get_liabilities(): Promise<ToolHandlerResult> {
    try {
      const { db } = await import("./db");
      const { manualLiabilities, debtPayments, plaidLiabilities: plaidLiabilitiesTable, financedAssets, plaidTransactions } = await import("@shared/schema");
      const { desc, inArray, lt, and } = await import("drizzle-orm");

      const [manual, plaid, payments, financedAssetRows] = await Promise.all([
        db.select().from(manualLiabilities).where(visibleFinanceForCurrentPrincipal(manualLiabilities)),
        db.select().from(plaidLiabilitiesTable).where(visibleFinanceForCurrentPrincipal(plaidLiabilitiesTable)),
        db.select().from(debtPayments).where(visibleFinanceForCurrentPrincipal(debtPayments)).orderBy(desc(debtPayments.date)),
        db.select().from(financedAssets).where(visibleFinanceForCurrentPrincipal(financedAssets)),
      ]);

      let autoPayments: Array<{ source: "auto"; liabilityType: string; liabilityId: number; amount: number; date: string; notes: string | null }> = [];
      if (plaid.length > 0) {
        const accountIds = plaid.map(l => l.accountId);
        const txns = await db.select().from(plaidTransactions)
          .where(visibleFinanceForCurrentPrincipal(plaidTransactions, and(inArray(plaidTransactions.accountId, accountIds), lt(plaidTransactions.amount, 0))))
          .orderBy(desc(plaidTransactions.date));
        const accountToLiability = new Map(plaid.map(l => [l.accountId, l]));
        autoPayments = txns.map(t => {
          const liability = accountToLiability.get(t.accountId)!;
          return {
            source: "auto" as const,
            liabilityType: "plaid",
            liabilityId: liability.id,
            amount: Math.abs(t.amount),
            date: t.date,
            notes: t.merchantName || t.name,
          };
        });
      }

      const allPayments = [
        ...payments.map(p => ({ source: "manual" as const, liabilityType: p.liabilityType, liabilityId: p.liabilityId, amount: p.amount, date: p.date, notes: p.notes })),
        ...autoPayments,
      ].sort((a, b) => b.date.localeCompare(a.date));

      const lines: string[] = [];
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const paymentsThisMonth = allPayments.filter(p => p.date.startsWith(currentMonth));
      let totalDebt = 0;
      let totalMin = 0;

      for (const p of plaid) {
        const payCount = allPayments.filter(pay => pay.liabilityType === "plaid" && pay.liabilityId === p.id).length;
        const parts = [`- [Plaid] ${p.liabilityType}`];
        if (p.balance !== null) { parts.push(`balance: $${p.balance.toFixed(2)}`); totalDebt += p.balance; }
        if (p.aprPercentage !== null) parts.push(`APR: ${p.aprPercentage}%`);
        if (p.minimumPayment !== null) { parts.push(`min: $${p.minimumPayment.toFixed(2)}`); totalMin += p.minimumPayment; }
        if (p.nextPaymentDueDate) parts.push(`due: ${p.nextPaymentDueDate}`);
        if (payCount > 0) parts.push(`${payCount} payments logged`);
        if (p.notes) parts.push(`notes: ${p.notes}`);
        lines.push(parts.join(", "));
      }

      for (const m of manual) {
        const payCount = allPayments.filter(pay => pay.liabilityType === "manual" && pay.liabilityId === m.id).length;
        const parts = [`- [Manual] ${m.name} (${m.category})`];
        parts.push(`balance: $${m.balance.toFixed(2)}`);
        totalDebt += m.balance;
        if (m.aprPercentage !== null) parts.push(`APR: ${m.aprPercentage}%`);
        if (m.minimumPayment !== null) { parts.push(`min: $${m.minimumPayment.toFixed(2)}`); totalMin += m.minimumPayment; }
        if (m.nextPaymentDueDate) parts.push(`due: ${m.nextPaymentDueDate}`);
        if (payCount > 0) parts.push(`${payCount} payments logged`);
        if (m.notes) parts.push(`notes: ${m.notes}`);
        lines.push(parts.join(", "));
      }

      for (const fa of financedAssetRows) {
        if (fa.loanBalance && fa.loanBalance > 0) {
          const parts = [`- [Financed] ${fa.name} (${fa.category})`];
          parts.push(`loan balance: $${fa.loanBalance.toFixed(2)}`);
          totalDebt += fa.loanBalance;
          if (fa.loanApr !== null && fa.loanApr !== undefined) parts.push(`APR: ${fa.loanApr}%`);
          if (fa.monthlyPayment !== null && fa.monthlyPayment !== undefined) { parts.push(`payment: $${fa.monthlyPayment.toFixed(2)}/mo`); totalMin += fa.monthlyPayment; }
          if (fa.notes) parts.push(`notes: ${fa.notes}`);
          lines.push(parts.join(", "));
        }
      }

      const totalPaidThisMonth = paymentsThisMonth.reduce((s, p) => s + p.amount, 0);
      const header = `Total debt: $${totalDebt.toFixed(2)}, min payments: $${totalMin.toFixed(2)}/mo, paid this month: $${totalPaidThisMonth.toFixed(2)} (${paymentsThisMonth.length} payments)`;

      const totalLineItems = plaid.length + manual.length + financedAssetRows.filter(fa => fa.loanBalance && fa.loanBalance > 0).length;
      if (lines.length === 0) return { result: "No liabilities found (Plaid, manual, or financed)." };
      return { result: `${header}\n\n${totalLineItems} liabilities:\n${lines.join("\n")}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Liabilities error: ${msg}`, error: true };
    }
  },

  async get_debt_payments(): Promise<ToolHandlerResult> {
    try {
      const { db } = await import("./db");
      const { debtPayments, manualLiabilities, plaidLiabilities: plaidLiabilitiesTable, plaidTransactions } = await import("@shared/schema");
      const { desc, inArray, lt, and } = await import("drizzle-orm");

      const [manualPayments, manual, plaid] = await Promise.all([
        db.select().from(debtPayments).where(visibleFinanceForCurrentPrincipal(debtPayments)).orderBy(desc(debtPayments.date)),
        db.select().from(manualLiabilities).where(visibleFinanceForCurrentPrincipal(manualLiabilities)),
        db.select().from(plaidLiabilitiesTable).where(visibleFinanceForCurrentPrincipal(plaidLiabilitiesTable)),
      ]);

      let autoPayments: Array<{ source: "auto"; liabilityType: string; liabilityId: number; amount: number; date: string; notes: string | null }> = [];
      if (plaid.length > 0) {
        const accountIds = plaid.map(l => l.accountId);
        const txns = await db.select().from(plaidTransactions)
          .where(visibleFinanceForCurrentPrincipal(plaidTransactions, and(inArray(plaidTransactions.accountId, accountIds), lt(plaidTransactions.amount, 0))))
          .orderBy(desc(plaidTransactions.date));
        const accountToLiability = new Map(plaid.map(l => [l.accountId, l]));
        autoPayments = txns.map(t => {
          const liability = accountToLiability.get(t.accountId)!;
          return {
            source: "auto" as const,
            liabilityType: "plaid",
            liabilityId: liability.id,
            amount: Math.abs(t.amount),
            date: t.date,
            notes: t.merchantName || t.name,
          };
        });
      }

      const allPayments = [
        ...manualPayments.map(p => ({ source: "manual" as const, liabilityType: p.liabilityType, liabilityId: p.liabilityId, amount: p.amount, date: p.date, notes: p.notes })),
        ...autoPayments,
      ].sort((a, b) => b.date.localeCompare(a.date));

      if (allPayments.length === 0) return { result: "No debt payments recorded." };

      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const thisMonth = allPayments.filter(p => p.date.startsWith(currentMonth));
      const totalAll = allPayments.reduce((s, p) => s + p.amount, 0);
      const totalThisMonth = thisMonth.reduce((s, p) => s + p.amount, 0);
      const manualCount = allPayments.filter(p => p.source === "manual").length;
      const autoCount = allPayments.filter(p => p.source === "auto").length;

      const balanceLines: string[] = [];
      for (const m of manual) {
        const paid = allPayments.filter(p => p.liabilityType === "manual" && p.liabilityId === m.id).reduce((s, p) => s + p.amount, 0);
        balanceLines.push(`- [Manual] ${m.name}: balance $${m.balance.toFixed(2)}, paid $${paid.toFixed(2)}`);
      }
      for (const p of plaid) {
        const paid = allPayments.filter(pay => pay.liabilityType === "plaid" && pay.liabilityId === p.id).reduce((s, pay) => s + pay.amount, 0);
        if (paid > 0) {
          balanceLines.push(`- [Plaid] ${p.liabilityType}: balance $${(p.balance || 0).toFixed(2)}, paid $${paid.toFixed(2)}`);
        }
      }

      const recent = allPayments.slice(0, 10).map(p => {
        const parts = [`- ${p.date}: $${p.amount.toFixed(2)} [${p.source}] (${p.liabilityType} #${p.liabilityId})`];
        if (p.notes) parts.push(`"${p.notes}"`);
        return parts.join(" ");
      });

      const header = `${allPayments.length} total payments ($${totalAll.toFixed(2)}), ${thisMonth.length} this month ($${totalThisMonth.toFixed(2)})\n${manualCount} manual, ${autoCount} auto-detected from Plaid transactions`;
      const sections = [header];
      if (balanceLines.length > 0) sections.push(`\nPer-liability balances:\n${balanceLines.join("\n")}`);
      sections.push(`\nRecent payments:\n${recent.join("\n")}`);

      return { result: sections.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Debt payments error: ${msg}`, error: true };
    }
  },

  async get_categories(): Promise<ToolHandlerResult> {
    try {
      const { db } = await import("./db");
      const { expenseCategories, merchantCategoryOverrides } = await import("@shared/schema");

      const [cats, overrides] = await Promise.all([
        db.select().from(expenseCategories).where(visibleFinanceForCurrentPrincipal(expenseCategories)),
        db.select().from(merchantCategoryOverrides).where(visibleFinanceForCurrentPrincipal(merchantCategoryOverrides)),
      ]);

      if (cats.length === 0) return { result: "No expense categories configured yet." };

      const catById = new Map(cats.map(c => [c.id, c]));
      const catLines = cats
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(c => {
          const plaid = c.plaidCategory ? ` → ${c.plaidCategory}` : "";
          const def = c.isDefault ? " (default)" : "";
          return `- ${c.name}${plaid}${def}`;
        });

      const parts = [`${cats.length} categories:\n${catLines.join("\n")}`];

      if (overrides.length > 0) {
        const overrideLines = overrides.map(o => {
          const cat = catById.get(o.categoryId);
          return `- "${o.merchantName}" → ${cat?.name || `category #${o.categoryId}`}`;
        });
        parts.push(`\n${overrides.length} merchant overrides:\n${overrideLines.join("\n")}`);
      }

      return { result: parts.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Categories error: ${msg}`, error: true };
    }
  },

  async get_budget(args: Record<string, unknown>): Promise<ToolHandlerResult> {
    try {
      const { isPlaidConfigured, getPlaidConfigDiagnostics } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV. Budget comparisons require transaction data from Plaid.` };
      }

      const { db } = await import("./db");
      const { budgetEntries, plaidTransactions, expenseCategories, merchantCategoryOverrides } = await import("@shared/schema");
      const { and, gte, lte } = await import("drizzle-orm");

      const mode = typeof args.mode === "string" ? args.mode : "this_month";
      const month = typeof args.month === "string" ? args.month : null;
      const now = new Date();
      let startDate: string;
      let endDate: string;
      let divisor = 1;

      if (month && /^\d{4}-\d{2}$/.test(month)) {
        const [year, mon] = month.split("-").map(Number);
        const monthStart = new Date(year, mon - 1, 1);
        startDate = monthStart.toISOString().split("T")[0];
        const monthEnd = new Date(year, mon, 0);
        endDate = monthEnd.toISOString().split("T")[0];
      } else if (mode === "last_month") {
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        startDate = lastMonth.toISOString().split("T")[0];
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        endDate = lastMonthEnd.toISOString().split("T")[0];
      } else if (mode === "trailing_avg") {
        const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1);
        startDate = twelveMonthsAgo.toISOString().split("T")[0];
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        endDate = lastMonthEnd.toISOString().split("T")[0];
        divisor = 12;
      } else {
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        startDate = thisMonthStart.toISOString().split("T")[0];
        endDate = now.toISOString().split("T")[0];
      }

      const { listAmortizationsWithTxn, getAmortizedSpendingForMonth } = await import("./finance-amortization");
      const [budgets, txns, catRows, overrideRows, amortizations] = await Promise.all([
        db.select().from(budgetEntries).where(visibleFinanceForCurrentPrincipal(budgetEntries)),
        db.select().from(plaidTransactions).where(visibleFinanceForCurrentPrincipal(plaidTransactions, and(gte(plaidTransactions.date, startDate), lte(plaidTransactions.date, endDate)))),
        db.select().from(expenseCategories).where(visibleFinanceForCurrentPrincipal(expenseCategories)),
        db.select().from(merchantCategoryOverrides).where(visibleFinanceForCurrentPrincipal(merchantCategoryOverrides)),
        listAmortizationsWithTxn({ activeOnly: true }),
      ]);

      const catById = new Map(catRows.map(c => [c.id, c]));
      const catByPlaid = new Map(catRows.filter(c => c.plaidCategory).map(c => [c.plaidCategory!, c]));
      const merchantMap = new Map(overrideRows.map(o => [o.merchantName.toLowerCase(), o.categoryId]));

      let income = 0;
      let spending = 0;
      const spendingByCategory: Record<string, number> = {};
      // Track per-month spending for amortization overlay
      const spendingByMonthByCategory: Record<string, Record<string, number>> = {};

      for (const txn of txns) {
        if (txn.amount < 0) {
          income += Math.abs(txn.amount);
        } else {
          spending += txn.amount;
          let cat = txn.categoryPrimary || "UNCATEGORIZED";
          const merchant = (txn.merchantName || txn.name || "").toLowerCase();
          const overrideCatId = merchantMap.get(merchant);
          if (overrideCatId !== undefined) {
            const catObj = catById.get(overrideCatId);
            cat = catObj?.plaidCategory || catObj?.name || cat;
          }
          spendingByCategory[cat] = (spendingByCategory[cat] || 0) + txn.amount;
          const m = txn.date.substring(0, 7);
          if (!spendingByMonthByCategory[m]) spendingByMonthByCategory[m] = {};
          spendingByMonthByCategory[m][cat] = (spendingByMonthByCategory[m][cat] || 0) + txn.amount;
        }
      }

      // Apply amortization overlay: rebuild spendingByCategory & spending from per-month adjusted spending
      if (amortizations.length > 0) {
        const monthsInRange = Object.keys(spendingByMonthByCategory);
        // Also include any month that an amortization spreads into (within range),
        // plus the txn's own month so the lump-subtraction fires even when the
        // spread starts later than the txn month.
        const startM = startDate.substring(0, 7);
        const endM = endDate.substring(0, 7);
        for (const a of amortizations) {
          if (!a.isActive || a.orphaned) continue;
          for (let i = 0; i < a.spreadMonths; i++) {
            const [sy, sm] = a.startMonth.split("-").map(Number);
            const d = new Date(sy, sm - 1 + i, 1);
            const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            if (m >= startM && m <= endM && !monthsInRange.includes(m)) monthsInRange.push(m);
          }
          if (a.txnMonth && a.txnMonth >= startM && a.txnMonth <= endM && !monthsInRange.includes(a.txnMonth)) {
            monthsInRange.push(a.txnMonth);
          }
        }
        const newTotals: Record<string, number> = {};
        let newSpending = 0;
        for (const m of monthsInRange) {
          const adjusted = getAmortizedSpendingForMonth(m, spendingByMonthByCategory[m] || {}, amortizations);
          for (const [cat, amt] of Object.entries(adjusted)) {
            newTotals[cat] = (newTotals[cat] || 0) + amt;
            newSpending += amt;
          }
        }
        for (const k of Object.keys(spendingByCategory)) delete spendingByCategory[k];
        for (const [k, v] of Object.entries(newTotals)) spendingByCategory[k] = v;
        spending = newSpending;
      }

      if (divisor > 1) {
        income = income / divisor;
        spending = spending / divisor;
        for (const cat in spendingByCategory) {
          spendingByCategory[cat] = Math.round(spendingByCategory[cat] / divisor * 100) / 100;
        }
      }

      const totalBudget = budgets.reduce((s, b) => s + b.monthlyAmount, 0);
      const modeLabel = mode === "trailing_avg" ? "12-month trailing average" : mode === "last_month" ? "last month" : "this month";

      const lines: string[] = [];
      lines.push(`**Budget vs Actual (${modeLabel})**`);
      lines.push(`Period: ${startDate} to ${endDate}`);
      lines.push(`Total Budget: $${totalBudget.toFixed(2)}/mo`);
      lines.push(`Actual Spending: $${Math.round(spending * 100) / 100}`);
      lines.push(`Income: $${Math.round(income * 100) / 100}`);
      lines.push(`Remaining: $${(totalBudget - spending).toFixed(2)} (note: income is actual-to-date vs full-month budget)`);

      if (budgets.length > 0) {
        lines.push("");
        const budgetLines = budgets
          .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
          .map(b => {
            const cat = catByPlaid.get(b.category);
            const catName = cat?.name || b.category;
            const actual = spendingByCategory[b.category] || 0;
            const pct = b.monthlyAmount > 0 ? Math.round((actual / b.monthlyAmount) * 100) : 0;
            const status = pct > 100 ? "OVER" : pct > 80 ? "WARNING" : "OK";
            return `- ${catName}: budget $${b.monthlyAmount} vs actual $${actual.toFixed(2)} (${pct}%) [${status}]`;
          });
        lines.push(`Per-category:\n${budgetLines.join("\n")}`);
      }

      return { result: lines.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Budget error: ${msg}`, error: true };
    }
  },

  async get_income(): Promise<ToolHandlerResult> {
    try {
      const { db } = await import("./db");
      const { incomeSources, incomeDeductions, incomeDeposits } = await import("@shared/schema");

      const FREQ: Record<string, number> = { weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1, annually: 1 / 12 };

      const [sources, deductions, deposits] = await Promise.all([
        db.select().from(incomeSources).where(visibleFinanceForCurrentPrincipal(incomeSources)),
        db.select().from(incomeDeductions).where(visibleFinanceForCurrentPrincipal(incomeDeductions)),
        db.select().from(incomeDeposits).where(visibleFinanceForCurrentPrincipal(incomeDeposits)),
      ]);

      if (sources.length === 0) return { result: "No income sources configured yet. Add income sources in the Finance → Income tab." };

      const lines: string[] = [];
      let totalMonthlyGross = 0;
      let totalMonthlyNet = 0;

      for (const src of sources) {
        const mult = FREQ[src.payFrequency] || 1;
        const srcDeductions = deductions.filter(d => d.sourceId === src.id);
        const srcDeposits = deposits.filter(d => d.sourceId === src.id);
        const totalDed = srcDeductions.reduce((s, d) => s + d.amount, 0);
        const takeHome = src.grossPay - totalDed;
        const monthlyGross = src.grossPay * mult;
        const monthlyNet = takeHome * mult;

        const active = src.isActive ? "" : " (INACTIVE)";
        lines.push(`**${src.name}**${active}`);
        lines.push(`  Gross: $${src.grossPay.toFixed(2)}/${src.payFrequency} ($${monthlyGross.toFixed(2)}/mo)`);

        if (srcDeductions.length > 0) {
          const monthlyTotalDed = totalDed * mult;
          const dedLines = srcDeductions.map(d => {
            const monthlyDed = d.amount * mult;
            return `    - ${d.name} (${(d as any).category || ""}): $${monthlyDed.toFixed(2)}/mo ($${d.amount.toFixed(2)}/${src.payFrequency === "annually" ? "yr" : src.payFrequency === "monthly" ? "mo" : "paycheck"})`;
          });
          lines.push(`  Deductions: $${monthlyTotalDed.toFixed(2)}/mo\n${dedLines.join("\n")}`);
        }

        lines.push(`  Take-home: $${takeHome.toFixed(2)}/${src.payFrequency} ($${monthlyNet.toFixed(2)}/mo)`);

        if (srcDeposits.length > 0) {
          const depLines = srcDeposits.map(d => `    - ${(d as any).accountName || d.accountLabel || ""}: $${d.amount.toFixed(2)} (${(d as any).depositType || ""})`);
          lines.push(`  Deposits:\n${depLines.join("\n")}`);
        }

        lines.push("");

        if (src.isActive) {
          totalMonthlyGross += monthlyGross;
          totalMonthlyNet += monthlyNet;
        }
      }

      lines.push(`**Totals (active sources)**`);
      lines.push(`Monthly Gross: $${totalMonthlyGross.toFixed(2)}`);
      lines.push(`Monthly Net: $${totalMonthlyNet.toFixed(2)}`);

      return { result: lines.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Income error: ${msg}`, error: true };
    }
  },

  async get_recurring(): Promise<ToolHandlerResult> {
    try {
      const { getRecurringTransactions, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV.` };
      }
      const txns = await getRecurringTransactions();
      if (txns.length === 0) return { result: "No recurring transactions identified yet." };
      const streamMap = new Map<string, { name: string; amount: number; count: number }>();
      for (const t of txns) {
        const key = t.recurringStreamId || t.name;
        const existing = streamMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          streamMap.set(key, { name: t.merchantName || t.name, amount: t.amount, count: 1 });
        }
      }
      const lines = Array.from(streamMap.values())
        .sort((a, b) => b.amount - a.amount)
        .map(s => `- ${s.name}: $${Math.abs(s.amount).toFixed(2)} (${s.count} occurrences)`);
      return { result: `${streamMap.size} recurring streams:\n${lines.join("\n")}` };
    } catch (err: any) {
      return { result: `Recurring error: ${err.message}`, error: true };
    }
  },

  async get_forecast(args: Record<string, unknown>): Promise<ToolHandlerResult> {
    try {
      const months = typeof args.months === "number" ? args.months : 12;
      const { fetchAndComputeForecast } = await import("./routes/finance");
      const forecast = await fetchAndComputeForecast({ months, pastMonths: 3 });

      const fmt = (n: number) => {
        if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
        return `$${n.toFixed(0)}`;
      };

      const lines: string[] = [];

      const current = forecast.months.find(m => m.isCurrent);
      if (current) {
        lines.push(`=== CURRENT MONTH (${current.month}) ===`);
        lines.push(`Income: Gross ${fmt(current.income.gross)}/mo, Net ${fmt(current.income.net)}/mo${current.income.actual !== null ? `, Actual ${fmt(current.income.actual)}` : ""}`);
        lines.push(`Taxes: ${fmt(current.taxes)}/mo | 401k/Retirement: ${fmt(current.retirement401k)}/mo`);

        const dedEntries = Object.entries(current.deductions);
        if (dedEntries.length > 0) {
          lines.push(`Deductions: ${dedEntries.map(([k, v]) => `${k}: ${fmt(v)}`).join(", ")}`);
        }

        const expEntries = Object.entries(current.expenses).sort((a, b) => b[1] - a[1]);
        if (expEntries.length > 0) {
          lines.push(`Expenses (${fmt(current.totalExpenses)} total):`);
          for (const [cat, amt] of expEntries) {
            lines.push(`  ${cat}: ${fmt(amt)}`);
          }
        }

        lines.push(`Investments: ${fmt(current.investments)}`);
        const invEntries = Object.entries(current.investmentBreakdown);
        if (invEntries.length > 0) {
          for (const [name, val] of invEntries) {
            lines.push(`  ${name}: ${fmt(val)}`);
          }
        }

        if (current.manual401kBalance > 0) {
          lines.push(`401k Accounts: ${fmt(current.manual401kBalance)}`);
          const k401Entries = Object.entries(current.manual401kBreakdown);
          for (const [name, val] of k401Entries) {
            lines.push(`  ${name}: ${fmt(val)}`);
          }
        }

        lines.push(`Assets: ${fmt(current.assets)} (Cash: ${fmt(current.cashBalance)}, Financed: ${fmt(current.financedAssetValue)}, Manual: ${fmt(current.manualAssetValue)})`);

        lines.push(`Liabilities: ${fmt(current.liabilities)} (Financed Loans: ${fmt(current.financedLoanBalance)})`);
        const liabEntries = Object.entries(current.liabilityBreakdown);
        if (liabEntries.length > 0) {
          for (const [name, bal] of liabEntries) {
            lines.push(`  ${name}: ${fmt(bal)}`);
          }
        }

        lines.push(`Debt Payments: ${fmt(current.totalDebtPayments)}/mo`);
        lines.push(`Net Cash Flow: ${fmt(current.netCashFlow)}/mo`);
        lines.push(`Net Worth: ${fmt(current.cumulativeNetWorth)}`);
        lines.push("");
      }

      const pastMonths = forecast.months.filter(m => m.isPast);
      if (pastMonths.length > 0) {
        lines.push(`=== PAST MONTHS (Actuals) ===`);
        for (const pm of pastMonths) {
          const actualIncome = pm.income.actual !== null ? fmt(pm.income.actual) : "N/A";
          const topExpenses = Object.entries(pm.expenses).sort((a, b) => b[1] - a[1]).slice(0, 5);
          const expStr = topExpenses.map(([c, a]) => `${c}: ${fmt(a)}`).join(", ");
          lines.push(`${pm.month}: Income ${actualIncome}, Expenses ${fmt(pm.totalExpenses)} [${expStr}], Cash Flow ${fmt(pm.netCashFlow)}, NW ${fmt(pm.cumulativeNetWorth)}`);
        }
        lines.push("");
      }

      const futureMonths = forecast.months.filter(m => !m.isPast && !m.isCurrent);
      if (futureMonths.length > 0) {
        lines.push(`=== PROJECTIONS (${forecast.growthRate}% annual growth) ===`);
        const milestoneIndices = new Set<number>();
        const targets = [2, 5, 11, 23, 35, 47, 59];
        for (const t of targets) {
          if (t < futureMonths.length) milestoneIndices.add(t);
        }
        if (futureMonths.length > 0) milestoneIndices.add(0);
        if (futureMonths.length > 1) milestoneIndices.add(futureMonths.length - 1);

        const showAll = futureMonths.length <= 12;

        for (let i = 0; i < futureMonths.length; i++) {
          if (!showAll && !milestoneIndices.has(i)) continue;
          const fm = futureMonths[i];
          const invBreak = Object.entries(fm.investmentBreakdown).map(([n, v]) => `${n}: ${fmt(v)}`).join(", ");
          const liabBreak = Object.entries(fm.liabilityBreakdown).map(([n, v]) => `${n}: ${fmt(v)}`).join(", ");
          const expBreak = Object.entries(fm.expenses).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, a]) => `${c}: ${fmt(a)}`).join(", ");

          const k401Break = Object.entries(fm.manual401kBreakdown).map(([n, v]) => `${n}: ${fmt(v)}`).join(", ");

          lines.push(`--- ${fm.month} ---`);
          lines.push(`Income: Net ${fmt(fm.income.net)} | Expenses: ${fmt(fm.totalExpenses)} [${expBreak}]`);
          lines.push(`Cash Flow: ${fmt(fm.netCashFlow)} | Cash: ${fmt(fm.cashBalance)}`);
          lines.push(`Investments: ${fmt(fm.investments)}${invBreak ? ` (${invBreak})` : ""}`);
          if (fm.manual401kBalance > 0) {
            lines.push(`401k: ${fmt(fm.manual401kBalance)}${k401Break ? ` (${k401Break})` : ""}`);
          }
          lines.push(`Liabilities: ${fmt(fm.liabilities)}${liabBreak ? ` (${liabBreak})` : ""}`);
          lines.push(`Net Worth: ${fmt(fm.cumulativeNetWorth)}`);
        }
      }

      return { result: lines.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Forecast error: ${msg}`, error: true };
    }
  },

  async link_account(): Promise<ToolHandlerResult> {
    try {
      const { createLinkToken, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV in environment secrets first.` };
      }
      const { linkToken } = await createLinkToken();
      return { result: `Link token created. The user can connect their bank account through the Plaid Link flow in Settings → Connections. Link token: ${linkToken}` };
    } catch (err: any) {
      return { result: `Link account error: ${err.message}`, error: true };
    }
  },

  async refresh_data(): Promise<ToolHandlerResult> {
    try {
      const { refreshAllItems, isPlaidConfigured, getPlaidConfigDiagnostics, getPlaidItems } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV.` };
      }
      const items = await getPlaidItems();
      if (items.length === 0) return { result: "No financial accounts connected yet." };
      await refreshAllItems();
      return { result: `Refreshed financial data for ${items.length} connected institution(s). Latest transactions, holdings, and liabilities are now up to date.` };
    } catch (err: any) {
      return { result: `Refresh error: ${err.message}`, error: true };
    }
  },


  async meta(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    const allowed = new Set(["queue", "call", "results", "commands", "status", "preflight", "initialize", "listDevices", "requestCamera", "register", "connect", "capture"]);
    if (!action) return { result: "Missing 'action' parameter", error: true };
    if (!allowed.has(action)) {
      return { result: `Unknown meta action: ${action}. Allowed: queue, call, results, commands, status, preflight, initialize, listDevices, requestCamera, register, connect, capture`, error: true };
    }

    try {
      const bridge = await import("./routes/mobile-dat-debug");
      if (action === "results" || action === "commands") {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
        return { result: JSON.stringify(bridge.listMobileDATDebugState(limit), null, 2) };
      }

      const datAction = action === "queue" || action === "call" ? String(args.datAction || "") : action;
      const datAllowed = new Set(["status", "preflight", "initialize", "listDevices", "requestCamera", "register", "connect", "capture"]);
      if (!datAllowed.has(datAction)) return { result: `Missing or invalid datAction. Allowed DAT actions: ${[...datAllowed].join(", ")}`, error: true };

      const params = args.params && typeof args.params === "object" ? args.params : {};
      const note = typeof args.note === "string" ? args.note : null;
      const command = bridge.queueMobileDATDebugCommand({ action: datAction as any, params, note });
      const wait = action === "call" || args.wait === true || !["queue"].includes(action);
      if (!wait) return { result: JSON.stringify({ queued: true, command }, null, 2) };

      const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeoutMs) || 30000));
      const result = await bridge.waitForMobileDATDebugResult(command.id, timeoutMs);
      if (!result) {
        return {
          result: JSON.stringify({
            queued: true,
            timedOut: true,
            command,
            message: "Command queued but no iOS result arrived before timeout. Open the mobile debug overlay so it can poll and execute commands.",
          }, null, 2),
        };
      }
      return { result: JSON.stringify({ command, result }, null, 2), error: result.status === "error" || result.status === "crashed" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `Meta tool failed: ${message}`, error: true };
    }
  },

  async meeting_bot(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    if (!["join", "status", "diagnostics", "leave", "recap"].includes(action)) {
      return { result: `Unknown meeting_bot action: ${action}. Allowed: join, status, diagnostics, leave, recap`, error: true };
    }

    if (action === "diagnostics") {
      const { getRecallDeliveryDiagnostics } = await import("./integrations/recall/delivery-diagnostics");
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      return { result: JSON.stringify({ deliveries: await getRecallDeliveryDiagnostics(limit) }, null, 2) };
    }

    const { chatStorage } = await import("./integrations/chat/storage");

    if (action === "status" || action === "leave" || action === "recap") {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return { result: "Missing sessionId", error: true };
      const session = await chatStorage.getSession(sessionId);
      if (!session || session.type !== "meeting" || !session.meeting) {
        return { result: `No meeting session found for id ${sessionId}`, error: true };
      }
      if (action === "status") {
        return {
          result: JSON.stringify({
            sessionId,
            title: session.meeting.title || session.title,
            botStatus: session.meeting.botStatus,
            statusDetail: session.meeting.statusDetail,
            participants: session.meeting.participants,
            startedAt: session.meeting.startedAt,
            endedAt: session.meeting.endedAt,
            recap: session.meeting.recap,
            link: `/session?c=${sessionId}`,
          }),
        };
      }
      if (action === "recap") {
        const { getCurrentPrincipal } = await import("./principal-context");
        const principal = getCurrentPrincipal();
        if (!principal || principal.actorType !== "user" || !principal.userId || !principal.accountId) {
          return { result: "A user principal is required to prepare recap drafts.", error: true };
        }
        const meeting = session.meeting;
        if (meeting.ownerUserId !== principal.userId || meeting.principalAccountId !== principal.accountId) {
          return { result: `No meeting session found for id ${sessionId}`, error: true };
        }

        let recap = meeting.recap;
        if (!recap || recap.status !== "ready") {
          const { finalizeMeetingSession } = await import("./meeting/recap");
          const finalization = await finalizeMeetingSession(sessionId);
          if (finalization.outcome === "failed") {
            return { result: `Meeting recap is not ready: ${finalization.recap.error ?? "recap generation failed"}`, error: true };
          }
          if (finalization.outcome === "already_generating") {
            return { result: "Meeting recap is still generating. Try again after it is ready.", error: true };
          }
          recap = finalization.recap;
        }

        if (!recap || recap.status !== "ready") {
          return { result: "Meeting recap is not ready yet.", error: true };
        }

        const { distributeRecap } = await import("./meeting/distribution");
        await distributeRecap(sessionId, meeting, recap, principal, { retryFailed: true });

        const { db } = await import("./db");
        const { meetingRecapDistributions } = await import("@shared/schema");
        const { combineWithVisibleScope } = await import("./scoped-storage");
        const { eq } = await import("drizzle-orm");
        const scopeColumns = {
          scope: meetingRecapDistributions.scope,
          ownerUserId: meetingRecapDistributions.ownerUserId,
          accountId: meetingRecapDistributions.accountId,
        };
        const distributions = await db
          .select({
            attendeeEmail: meetingRecapDistributions.attendeeEmail,
            attendeeName: meetingRecapDistributions.attendeeName,
            draftId: meetingRecapDistributions.draftId,
            status: meetingRecapDistributions.status,
            error: meetingRecapDistributions.error,
          })
          .from(meetingRecapDistributions)
          .where(
            combineWithVisibleScope(
              principal,
              scopeColumns,
              eq(meetingRecapDistributions.sessionId, sessionId),
            ),
          )
          .orderBy(meetingRecapDistributions.createdAt);

        const draftIds = distributions
          .map((row) => row.draftId)
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
        const updated = await chatStorage.getSession(sessionId);
        const refs = draftIds.map((id) => `@email_draft:${id}`).join(" ");
        const summary = draftIds.length > 0
          ? `Recap draft widget${draftIds.length === 1 ? "" : "s"} ready for review: ${refs}`
          : `No recap draft widgets were created for this meeting.`;
        return {
          result: JSON.stringify({
            sessionId,
            title: updated?.meeting?.title || updated?.title || meeting.title || session.title,
            recap: updated?.meeting?.recap ?? recap,
            distributions,
            draftIds,
            link: `/session?c=${sessionId}`,
            message: summary,
          }, null, 2) + (refs ? `

${refs}` : ""),
          data: { draftIds },
        };
      }
      // leave — delegate to the same owner-scoped lifecycle boundary as HTTP.
      const { getCurrentPrincipal } = await import("./principal-context");
      const principal = getCurrentPrincipal();
      if (!principal) {
        return { result: "A user principal is required to remove a meeting bot.", error: true };
      }
      const { requestMeetingBotLeave } = await import("./meeting/leave");
      const leave = await requestMeetingBotLeave(sessionId, principal);
      if (leave.outcome === "not_found") {
        return { result: `No meeting session found for id ${sessionId}`, error: true };
      }
      if (leave.outcome === "not_leaveable") {
        return { result: `The meeting bot is no longer active (${leave.session.meeting?.botStatus ?? "unknown"}).`, error: true };
      }
      if (leave.outcome === "failed") {
        return { result: `Failed to remove bot from call: ${leave.error}`, error: true };
      }
      return {
        result: JSON.stringify({
          sessionId,
          botStatus: leave.session.meeting?.botStatus,
          outcome: leave.outcome,
        }),
      };
    }

    // join — delegates to the canonical join path in server/meeting/join.ts
    const { joinMeetingByUrl, MeetingJoinError, MEETING_URL_RE } = await import("./meeting/join");
    const { meetingUrlForEvent } = await import("./meeting/identity");

    let meetingUrl = typeof args.url === "string" ? args.url.trim() : "";
    let resolvedTitle = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "";
    let resolvedAgenda: string | undefined;
    let explicitEvent: import("./meeting/identity").ExplicitMeetingEventIdentity | undefined;

    if (meetingUrl && !MEETING_URL_RE.test(meetingUrl)) {
      return { result: `That doesn't look like a Zoom or Google Meet link: ${meetingUrl}`, error: true };
    }

    if (!meetingUrl) {
      // Resolve from the calendar: current or next event (±15 min back, 8h ahead) with a meeting link.
      try {
        const { listAllEvents } = await import("./google-calendar");
        const now = Date.now();
        const { events } = await listAllEvents({
          timeMin: new Date(now - 15 * 60000).toISOString(),
          timeMax: new Date(now + 8 * 3600000).toISOString(),
          maxResults: 25,
        });
        const sorted = (events || []).slice().sort((a, b) => {
          const ta = new Date(a.start?.dateTime || a.start?.date || 0).getTime();
          const tb = new Date(b.start?.dateTime || b.start?.date || 0).getTime();
          return ta - tb;
        });
        for (const ev of sorted) {
          const found = meetingUrlForEvent(ev);
          if (found) {
            meetingUrl = found;
            if (!resolvedTitle) resolvedTitle = ev.summary || "";
            const { getMetadata } = await import("./calendar-metadata");
            const metadata = await getMetadata(ev.id, ev.accountId, ev.calendarId);
            resolvedAgenda = metadata?.agenda?.trim() || undefined;
            explicitEvent = {
              accountId: ev.accountId,
              calendarId: ev.calendarId,
              providerEventId: ev.id,
              eventStart: ev.start.dateTime || ev.start.date || undefined,
              eventEnd: ev.end.dateTime || ev.end.date || undefined,
              title: ev.summary || undefined,
              agenda: resolvedAgenda,
              attendees: ev.attendees,
            };
            break;
          }
        }
      } catch (err) {
        return { result: `Calendar lookup failed while resolving the meeting link: ${err instanceof Error ? err.message : String(err)}`, error: true };
      }
      if (!meetingUrl) {
        return { result: "No meeting URL provided and no upcoming calendar event with a Zoom/Meet link was found. Paste the meeting link.", error: true };
      }
    }

    let joined;
    try {
      joined = await joinMeetingByUrl({
        meetingUrl,
        title: resolvedTitle || "Meeting",
        agenda: resolvedAgenda,
        explicitEvent,
      });
    } catch (err) {
      if (err instanceof MeetingJoinError) {
        return { result: err.message, error: true };
      }
      return { result: `Meeting join failed: ${err instanceof Error ? err.message : String(err)}`, error: true };
    }

    return {
      result: JSON.stringify({
        sessionId: joined.sessionId,
        botId: joined.botId,
        botStatus: "dialing",
        platform: joined.platform,
        title: joined.title,
        link: `/session?c=${joined.sessionId}`,
        note: "Bot 'Mantra Agent' is joining the call. If it lands in the waiting room, admit it from the participants panel. Live attributed transcript streams into the linked meeting session.",
      }),
    };
  },

  async expo(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    if (!action) return { result: "Missing 'action' parameter", error: true };
    const allowed = new Set(["status", "projects", "builds", "build", "build_logs", "cancel"]);
    if (!allowed.has(action)) {
      return { result: `Unknown expo action: ${action}. Allowed: status, projects, builds, build, build_logs, cancel`, error: true };
    }

    try {
      const expo = await import("./integrations/expo");
      const token = await expo.getExpoToken();
      if (!token) return { result: "Expo is not configured. Missing EXPO_ACCESS_TOKEN integration secret.", error: true };

      switch (action) {
        case "status": {
          const viewer = await expo.getViewer();
          return {
            result: JSON.stringify({
              connected: true,
              username: viewer.username,
              primaryAccount: viewer.primaryAccount,
              accounts: viewer.accounts,
            }),
          };
        }
        case "projects": {
          const projects = await expo.listProjects();
          return { result: JSON.stringify({ count: projects.length, projects }) };
        }
        case "builds": {
          const projectId = typeof args.projectId === "string" && args.projectId.trim()
            ? args.projectId.trim()
            : expo.getProjectConfig().projectId;
          if (!projectId) return { result: "Missing projectId and mobile Expo config has no Expo projectId.", error: true };
          const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
          const builds = await expo.listBuilds(projectId, limit);
          return { result: JSON.stringify({ projectId, count: builds.length, builds }) };
        }
        case "build": {
          const buildId = typeof args.buildId === "string" ? args.buildId.trim() : "";
          if (!buildId) return { result: "Missing buildId", error: true };
          const build = await expo.getBuild(buildId);
          return { result: JSON.stringify({ build }) };
        }
        case "cancel": {
          const buildId = typeof args.buildId === "string" ? args.buildId.trim() : "";
          if (buildId) {
            const cancelled = await expo.cancelBuild(buildId);
            return { result: JSON.stringify({ cancelled: [cancelled] }) };
          }
          const projectId = typeof args.projectId === "string" && args.projectId.trim()
            ? args.projectId.trim()
            : expo.getProjectConfig().projectId;
          if (!projectId) return { result: "Missing buildId/projectId and mobile Expo config has no Expo projectId.", error: true };
          const platform = typeof args.platform === "string" && args.platform.trim() ? args.platform.trim() : undefined;
          const profile = typeof args.profile === "string" && args.profile.trim() ? args.profile.trim() : undefined;
          const cancelled = await expo.cancelInProgressBuilds({ projectId, platform, profile });
          return { result: JSON.stringify({ projectId, platform, profile, cancelled }) };
        }
        case "build_logs": {
          let buildId = typeof args.buildId === "string" ? args.buildId.trim() : "";
          if (!buildId) {
            const projectId = typeof args.projectId === "string" && args.projectId.trim()
              ? args.projectId.trim()
              : expo.getProjectConfig().projectId;
            if (!projectId) return { result: "Missing buildId/projectId and mobile Expo config has no Expo projectId.", error: true };
            const builds = await expo.listBuilds(projectId, 1);
            buildId = builds[0]?.id || "";
            if (!buildId) return { result: JSON.stringify({ projectId, buildId: null, excerpts: [] }) };
          }
          const report = await expo.getBuildLogReport(buildId);
          return {
            result: JSON.stringify({
              buildId,
              build: report.build,
              fetchedUrls: report.fetchedUrls,
              failedUrls: report.failedUrls,
              textBytes: report.textBytes,
              excerpts: report.excerpts,
            }),
          };
        }
      }
      return { result: `Unhandled expo action: ${action}`, error: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Expo ${action} failed: ${msg}`, error: true };
    }
  },

  async railway(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    const platformEnvironmentId = typeof args.platformEnvironmentId === "number"
      && Number.isInteger(args.platformEnvironmentId)
      && args.platformEnvironmentId > 0
      ? args.platformEnvironmentId
      : undefined;
    if (!action) return { result: "Missing 'action' parameter", error: true };

    const allowed = new Set(["status", "deployments", "logs", "build_logs", "list_variables", "redeploy", "restart"]);
    if (!allowed.has(action)) {
      return {
        result: `Unknown railway action: ${action}. Allowed: ${[...allowed].join(", ")}. Destructive actions are intentionally not exposed.`,
        error: true,
      };
    }

    const selfInspectionActions = new Set(["status", "logs", "build_logs"]);
    if (platformEnvironmentId === undefined && !selfInspectionActions.has(action)) {
      return {
        result: `platformEnvironmentId is required for Railway ${action}; omission is permitted only for current-runtime status, logs, and build_logs.`,
        error: true,
      };
    }

    const {
      resolveRailwayEnvironmentControl,
      fetchEnvironmentDeployments,
      fetchEnvironmentRuntimeLogs,
      fetchEnvironmentBuildLogs,
      resolveEnvironmentDeploymentId,
      listEnvironmentVariableNames,
      redeployEnvironment,
      restartEnvironment,
      serializeEnvironmentDeployment,
    } = await import("./integrations/railway/environment-control");
    const { RailwayApiError } = await import("./integrations/railway/client");

    let environmentLabel = platformEnvironmentId ? `platformEnvironment:${platformEnvironmentId}` : "current-runtime";
    try {
      const control = await resolveRailwayEnvironmentControl(platformEnvironmentId, {
        allowCurrentRuntime: platformEnvironmentId === undefined && selfInspectionActions.has(action),
      });
      environmentLabel = `${control.environment.platformName} / ${control.environment.productName} / ${control.environment.platformEnvironmentName}`;
      const base = {
        platformEnvironmentId: control.environment.platformEnvironmentId,
        environment: environmentLabel,
        url: control.publicUrl,
      };

      switch (action) {
        case "status": {
          const deployments = await fetchEnvironmentDeployments(control, 1);
          return { result: JSON.stringify({ ...base, deployment: serializeEnvironmentDeployment(deployments[0] ?? null) }) };
        }
        case "deployments": {
          const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
          const deployments = await fetchEnvironmentDeployments(control, limit);
          return {
            result: JSON.stringify({
              ...base,
              count: deployments.length,
              deployments: deployments.map(serializeEnvironmentDeployment),
            }),
          };
        }
        case "logs": {
          const limit = Math.min(500, Math.max(1, Number(args.limit) || 200));
          const deploymentId = await resolveEnvironmentDeploymentId(
            control,
            typeof args.deploymentId === "string" ? args.deploymentId : undefined,
          );
          if (!deploymentId) return { result: JSON.stringify({ ...base, deploymentId: null, logs: [] }) };
          const logs = await fetchEnvironmentRuntimeLogs(control, deploymentId, limit);
          return { result: JSON.stringify({ ...base, deploymentId, count: logs.length, logs }) };
        }
        case "build_logs": {
          const limit = Math.min(500, Math.max(1, Number(args.limit) || 200));
          const deploymentId = await resolveEnvironmentDeploymentId(
            control,
            typeof args.deploymentId === "string" ? args.deploymentId : undefined,
            true,
          );
          if (!deploymentId) return { result: JSON.stringify({ ...base, deploymentId: null, logs: [] }) };
          const logs = await fetchEnvironmentBuildLogs(control, deploymentId, limit);
          return { result: JSON.stringify({ ...base, deploymentId, count: logs.length, logs }) };
        }
        case "list_variables": {
          const names = await listEnvironmentVariableNames(control);
          return { result: JSON.stringify({ ...base, count: names.length, names }) };
        }
        case "redeploy": {
          const deployment = await redeployEnvironment(
            control,
            typeof args.deploymentId === "string" ? args.deploymentId : undefined,
          );
          return { result: JSON.stringify({ ...base, ok: true, deploymentId: deployment.id, status: deployment.status }) };
        }
        case "restart": {
          const result = await restartEnvironment(
            control,
            typeof args.deploymentId === "string" ? args.deploymentId : undefined,
          );
          return { result: JSON.stringify({ ...base, ...result }) };
        }
      }
      return { result: `Unhandled railway action: ${action}`, error: true };
    } catch (err: unknown) {
      if (err instanceof RailwayApiError) {
        return { result: `Railway ${action} (${environmentLabel}) failed: ${err.message} (status=${err.status})`, error: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Railway ${action} (${environmentLabel}) failed: ${msg}`, error: true };
    }
  },

  async platforms(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    if (!action) return { result: "Missing 'action' parameter", error: true };

    const allowed = new Set(["list_connections", "get_connection", "test_connection", "list_environments", "get_environment", "get_environment_status", "get_build_lifecycle", "set_build_lifecycle", "disable_build_lifecycle", "delete_build_lifecycle", "get_build_status", "start_build_workflow", "list_environment_workflows", "create_platform", "update_platform", "create_product", "update_product", "create_environment", "update_environment", "delete_environment", "save_source_binding", "save_hosting_binding", "create_connection", "save_context_artifact", "get_context_artifacts", "remove_context_artifact", "get_cloudflare_pages_project", "deploy_cloudflare_pages", "cancel_cloudflare_pages_deployment", "poll_cloudflare_pages_deployment", "repair_cloudflare_pages_project"]);
    if (!allowed.has(action)) {
      return { result: `Unknown platforms action: ${action}. Allowed: ${[...allowed].join(", ")}`, error: true };
    }

    try {
      const { db } = await import("./db");
      const { eq, and, sql: sqlTag, desc } = await import("drizzle-orm");
      const {
        providerConnections,
        environmentSourceBindings,
        environmentHostingBindings,
        environmentRuntimeVariables,
        environmentContextArtifacts,
        platforms: platformsTable,
        platformProducts,
        platformProductEnvironments,
        insertProviderConnectionSchema,
        insertPlatformSchema,
        insertPlatformProductSchema,
        insertPlatformProductEnvironmentSchema,
        upsertContextArtifactSchema,
      } = await import("@shared/models/platforms");
      const { getCurrentPrincipalOrSystem } = await import("./principal-context");
      const { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } = await import("./scoped-storage");
      const { storeProviderCredential, getProviderCredential, deleteProviderCredential } = await import("./provider-credential-store");

      const connScopeColumns = { scope: providerConnections.scope, ownerUserId: providerConnections.ownerUserId, accountId: providerConnections.accountId };
      const platScopeColumns = { scope: platformsTable.scope, ownerUserId: platformsTable.ownerUserId, accountId: platformsTable.accountId };

      const visibleConn = (pred?: SQL) => combineWithVisibleScope(getCurrentPrincipalOrSystem(), connScopeColumns, pred);
      const writableConn = (pred?: SQL) => combineWithWritableScope(getCurrentPrincipalOrSystem(), connScopeColumns, pred);
      const visiblePlat = (pred?: SQL) => combineWithVisibleScope(getCurrentPrincipalOrSystem(), platScopeColumns, pred);
      const writablePlat = (pred?: SQL) => combineWithWritableScope(getCurrentPrincipalOrSystem(), platScopeColumns, pred);
      const positiveId = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

      // ── list_connections ──
      if (action === "list_connections") {
        const rows = await db.select({
          id: providerConnections.id,
          provider: providerConnections.provider,
          label: providerConnections.label,
          accountType: providerConnections.accountType,
          status: providerConnections.status,
          lastVerifiedAt: providerConnections.lastVerifiedAt,
          createdAt: providerConnections.createdAt,
        }).from(providerConnections).where(visibleConn()).orderBy(providerConnections.updatedAt);
        return { result: JSON.stringify(rows, null, 2) };
      }

      // ── get_connection ──
      if (action === "get_connection") {
        const id = typeof args.id === "number" ? args.id : null;
        if (!id) return { result: "Missing 'id' parameter for get_connection", error: true };
        const [row] = await db.select({
          id: providerConnections.id,
          provider: providerConnections.provider,
          label: providerConnections.label,
          accountType: providerConnections.accountType,
          status: providerConnections.status,
          credentialRef: providerConnections.credentialRef,
          lastVerifiedAt: providerConnections.lastVerifiedAt,
          createdAt: providerConnections.createdAt,
          updatedAt: providerConnections.updatedAt,
        }).from(providerConnections).where(visibleConn(eq(providerConnections.id, id))).limit(1);
        if (!row) return { result: `Connection ${id} not found`, error: true };
        return { result: JSON.stringify({ ...row, hasCredential: !!row.credentialRef, credentialRef: undefined }, null, 2) };
      }

      // ── test_connection ──
      if (action === "test_connection") {
        const id = typeof args.id === "number" ? args.id : null;
        if (!id) return { result: "Missing 'id' parameter for test_connection", error: true };
        const [conn] = await db.select().from(providerConnections).where(visibleConn(eq(providerConnections.id, id))).limit(1);
        if (!conn) return { result: `Connection ${id} not found`, error: true };
        if (!conn.credentialRef) return { result: "No credential stored for this connection." };

        const token = await getProviderCredential(conn.credentialRef);
        if (!token) return { result: "Credential could not be decrypted or is missing." };

        const { testRailwayToken, testGitHubToken } = await import("./services/provider-connection-service");
        let testResult: { ok: boolean; message: string; projects?: Array<{ id: string; name: string }> };

        if (conn.provider === "railway") {
          testResult = await testRailwayToken(token);
        } else if (conn.provider === "github") {
          testResult = await testGitHubToken(token);
        } else {
          testResult = { ok: false, message: `No test implementation for provider: ${conn.provider}` };
        }

        if (testResult.ok) {
          await db.update(providerConnections).set({ lastVerifiedAt: sqlTag`CURRENT_TIMESTAMP`, status: "active", updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(providerConnections.id, id));
        }
        return { result: JSON.stringify(testResult, null, 2) };
      }

      // ── create_connection ──
      if (action === "create_connection") {
        const provider = typeof args.provider === "string" ? args.provider.trim() : "";
        const label = typeof args.label === "string" ? args.label.trim() : "";
        const credential = typeof args.credential === "string" ? args.credential.trim() : "";
        if (!provider || !label) return { result: "Missing 'provider' and/or 'label' for create_connection", error: true };

        const principal = getCurrentPrincipalOrSystem();
        const parsed = insertProviderConnectionSchema.parse({ provider, label });
        const [created] = await db.insert(providerConnections).values({ ...parsed, ...ownedInsertValues(principal, connScopeColumns) }).returning();

        if (credential) {
          const ref = await storeProviderCredential(created.id, credential, principal.userId ?? null);
          await db.update(providerConnections).set({ credentialRef: ref, updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(providerConnections.id, created.id));
        }

        return { result: JSON.stringify({ id: created.id, provider: created.provider, label: created.label, hasCredential: !!credential, status: created.status }, null, 2) };
      }


      // ── create_platform ──
      if (action === "create_platform") {
        const principal = getCurrentPrincipalOrSystem();
        const parsed = insertPlatformSchema.parse({
          name: typeof args.name === "string" ? args.name : "",
          description: typeof args.description === "string" ? args.description : "",
          status: typeof args.status === "string" ? args.status : undefined,
        });
        const [created] = await db.insert(platformsTable).values({ ...parsed, ...ownedInsertValues(principal, platScopeColumns) }).returning();
        return { result: JSON.stringify({ ...created, products: [] }, null, 2) };
      }

      // ── update_platform ──
      if (action === "update_platform") {
        const id = positiveId(args.id);
        if (!id) return { result: "Missing positive 'id' parameter for update_platform", error: true };
        const patch: Record<string, unknown> = { updatedAt: sqlTag`CURRENT_TIMESTAMP` };
        if (typeof args.name === "string") patch.name = args.name.trim();
        if (typeof args.description === "string") patch.description = args.description;
        if (typeof args.status === "string") patch.status = args.status;
        const parsed = insertPlatformSchema.partial().parse(patch);
        const [updated] = await db.update(platformsTable).set({ ...parsed, updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, id))).returning();
        if (!updated) return { result: `Platform ${id} not found or not writable`, error: true };
        return { result: JSON.stringify(updated, null, 2) };
      }

      // ── create_product ──
      if (action === "create_product") {
        const platformId = positiveId(args.id);
        if (!platformId) return { result: "Missing positive platform 'id' parameter for create_product", error: true };
        const [plat] = await db.select({ id: platformsTable.id }).from(platformsTable).where(writablePlat(eq(platformsTable.id, platformId))).limit(1);
        if (!plat) return { result: `Platform ${platformId} not found or not writable`, error: true };
        const parsed = insertPlatformProductSchema.parse({
          name: typeof args.name === "string" ? args.name : "",
          description: typeof args.description === "string" ? args.description : "",
          status: typeof args.status === "string" ? args.status : undefined,
        });
        const [created] = await db.insert(platformProducts).values({ ...parsed, platformId }).returning();
        await db.update(platformsTable).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, platformId)));
        return { result: JSON.stringify({ ...created, environments: [] }, null, 2) };
      }

      // ── update_product ──
      if (action === "update_product") {
        const productId = positiveId(args.id);
        if (!productId) return { result: "Missing positive product 'id' parameter for update_product", error: true };
        const [prod] = await db.select({ id: platformProducts.id, platformId: platformProducts.platformId }).from(platformProducts).where(eq(platformProducts.id, productId)).limit(1);
        if (!prod) return { result: `Product ${productId} not found`, error: true };
        const [plat] = await db.select({ id: platformsTable.id }).from(platformsTable).where(writablePlat(eq(platformsTable.id, prod.platformId))).limit(1);
        if (!plat) return { result: `No write access to product ${productId}`, error: true };
        const patch: Record<string, unknown> = { updatedAt: sqlTag`CURRENT_TIMESTAMP` };
        if (typeof args.name === "string") patch.name = args.name.trim();
        if (typeof args.description === "string") patch.description = args.description;
        if (typeof args.status === "string") patch.status = args.status;
        const parsed = insertPlatformProductSchema.partial().parse(patch);
        const [updated] = await db.update(platformProducts).set({ ...parsed, updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(platformProducts.id, productId)).returning();
        await db.update(platformsTable).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, prod.platformId)));
        return { result: JSON.stringify(updated, null, 2) };
      }

      // ── create_environment ──
      if (action === "create_environment") {
        const productId = positiveId(args.id);
        if (!productId) return { result: "Missing positive product 'id' parameter for create_environment", error: true };
        const [prod] = await db.select({ id: platformProducts.id, platformId: platformProducts.platformId }).from(platformProducts).where(eq(platformProducts.id, productId)).limit(1);
        if (!prod) return { result: `Product ${productId} not found`, error: true };
        const [plat] = await db.select({ id: platformsTable.id }).from(platformsTable).where(writablePlat(eq(platformsTable.id, prod.platformId))).limit(1);
        if (!plat) return { result: `No write access to product ${productId}`, error: true };
        const parsed = insertPlatformProductEnvironmentSchema.parse({ name: typeof args.name === "string" ? args.name : "" });
        const [created] = await db.insert(platformProductEnvironments).values({ ...parsed, productId }).returning();
        await db.update(platformProducts).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(platformProducts.id, productId));
        await db.update(platformsTable).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, prod.platformId)));
        return { result: JSON.stringify(created, null, 2) };
      }

      // ── update_environment ──
      if (action === "update_environment") {
        const envId = positiveId(args.id);
        if (!envId) return { result: "Missing positive environment 'id' parameter for update_environment", error: true };
        const [env] = await db.select().from(platformProductEnvironments).where(eq(platformProductEnvironments.id, envId)).limit(1);
        if (!env) return { result: `Environment ${envId} not found`, error: true };
        const [prod] = await db.select({ id: platformProducts.id, platformId: platformProducts.platformId }).from(platformProducts).where(eq(platformProducts.id, env.productId)).limit(1);
        if (!prod) return { result: `Product not found for environment ${envId}`, error: true };
        const [plat] = await db.select({ id: platformsTable.id }).from(platformsTable).where(writablePlat(eq(platformsTable.id, prod.platformId))).limit(1);
        if (!plat) return { result: `No write access to environment ${envId}`, error: true };
        const parsed = insertPlatformProductEnvironmentSchema.partial().parse({ name: typeof args.name === "string" ? args.name : undefined });
        const [updated] = await db.update(platformProductEnvironments).set({ ...parsed, updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(platformProductEnvironments.id, envId)).returning();
        await db.update(platformProducts).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(platformProducts.id, prod.id));
        await db.update(platformsTable).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, prod.platformId)));
        return { result: JSON.stringify(updated, null, 2) };
      }

      // ── list_environments ──
      if (action === "list_environments") {
        const plats = await db.select().from(platformsTable).where(visiblePlat()).orderBy(desc(platformsTable.updatedAt));
        const prods = await db.select().from(platformProducts).orderBy(platformProducts.name);
        const envs = await db.select().from(platformProductEnvironments).orderBy(platformProductEnvironments.name);

        // Batch-fetch all bindings in two queries instead of per-environment
        let allSourceBindings: Array<{ environmentId: number; provider: string | null; owner: string | null; repo: string | null; branch: string | null; connectionId: number | null }> = [];
        let allHostingBindings: Array<{ environmentId: number; provider: string | null; projectName: string | null; providerEnvironmentName: string | null; serviceName: string | null; connectionId: number | null }> = [];
        try {
          allSourceBindings = await db.select({
            environmentId: environmentSourceBindings.environmentId,
            provider: environmentSourceBindings.provider,
            owner: environmentSourceBindings.owner,
            repo: environmentSourceBindings.repo,
            branch: environmentSourceBindings.branch,
            connectionId: environmentSourceBindings.connectionId,
          }).from(environmentSourceBindings);
        } catch (err) {
          toolExec.debug("Source bindings table query failed, using empty set", { error: err instanceof Error ? err.message : String(err) });
        }
        try {
          allHostingBindings = await db.select({
            environmentId: environmentHostingBindings.environmentId,
            provider: environmentHostingBindings.provider,
            projectName: environmentHostingBindings.projectName,
            providerEnvironmentName: environmentHostingBindings.providerEnvironmentName,
            serviceName: environmentHostingBindings.serviceName,
            connectionId: environmentHostingBindings.connectionId,
          }).from(environmentHostingBindings);
        } catch (err) {
          toolExec.debug("Hosting bindings table query failed, using empty set", { error: err instanceof Error ? err.message : String(err) });
        }

        // Index bindings by environmentId for O(1) lookup
        const sourceByEnvId = new Map(allSourceBindings.map(sb => [sb.environmentId, sb]));
        const hostingByEnvId = new Map(allHostingBindings.map(hb => [hb.environmentId, hb]));

        // Index products by platformId and environments by productId
        const prodsByPlatId = new Map<number, typeof prods>();
        for (const prod of prods) {
          const list = prodsByPlatId.get(prod.platformId) ?? [];
          list.push(prod);
          prodsByPlatId.set(prod.platformId, list);
        }
        const envsByProdId = new Map<number, typeof envs>();
        for (const env of envs) {
          const list = envsByProdId.get(env.productId) ?? [];
          list.push(env);
          envsByProdId.set(env.productId, list);
        }

        const result = plats.map(plat => ({
          id: plat.id,
          name: plat.name,
          status: plat.status,
          products: (prodsByPlatId.get(plat.id) ?? []).map(prod => ({
            id: prod.id,
            name: prod.name,
            status: prod.status,
            environments: (envsByProdId.get(prod.id) ?? []).map(env => {
              const sb = sourceByEnvId.get(env.id);
              const hb = hostingByEnvId.get(env.id);
              return {
                id: env.id,
                name: env.name,
                source: sb ? { provider: sb.provider, owner: sb.owner, repo: sb.repo, branch: sb.branch, connectionId: sb.connectionId, codeIndexingEnabled: sb.codeIndexingEnabled } : null,
                hosting: hb ? { provider: hb.provider, projectName: hb.projectName, providerEnvironmentName: hb.providerEnvironmentName, serviceName: hb.serviceName, connectionId: hb.connectionId } : null,
              };
            }),
          })),
        }));
        return { result: JSON.stringify(result, null, 2) };
      }

      // ── get_environment ──
      if (action === "get_environment") {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: "Missing 'id' parameter for get_environment", error: true };

        const [env] = await db.select().from(platformProductEnvironments).where(eq(platformProductEnvironments.id, envId)).limit(1);
        if (!env) return { result: `Environment ${envId} not found`, error: true };

        const [prod] = await db.select().from(platformProducts).where(eq(platformProducts.id, env.productId)).limit(1);
        const [plat] = prod ? await db.select().from(platformsTable).where(visiblePlat(eq(platformsTable.id, prod.platformId))).limit(1) : [null];
        if (!plat) return { result: `Environment ${envId} not accessible`, error: true };

        let sourceBinding: Record<string, unknown> | null = null;
        let hostingBinding: Record<string, unknown> | null = null;
        let runtimeVars: Array<{ key: string; category: string | null; required: boolean | null; configured: boolean | null; source: string | null }> = [];
        try {
          const [sb] = await db.select().from(environmentSourceBindings).where(eq(environmentSourceBindings.environmentId, envId)).limit(1);
          sourceBinding = sb || null;
        } catch (err) {
          toolExec.debug("Source binding query failed", { error: err instanceof Error ? err.message : String(err) });
        }
        try {
          const [hb] = await db.select().from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, envId)).limit(1);
          hostingBinding = hb || null;
        } catch (err) {
          toolExec.debug("Hosting binding query failed", { error: err instanceof Error ? err.message : String(err) });
        }
        try {
          runtimeVars = await db.select().from(environmentRuntimeVariables).where(eq(environmentRuntimeVariables.environmentId, envId));
        } catch (err) {
          toolExec.debug("Runtime variables query failed", { error: err instanceof Error ? err.message : String(err) });
        }

        return { result: JSON.stringify({
          environment: { id: env.id, name: env.name },
          product: prod ? { id: prod.id, name: prod.name } : null,
          platform: { id: plat.id, name: plat.name },
          sourceBinding: sourceBinding ? { provider: sourceBinding.provider, connectionId: sourceBinding.connectionId, owner: sourceBinding.owner, repo: sourceBinding.repo, branch: sourceBinding.branch, autoDeploy: sourceBinding.autoDeploy, codeIndexingEnabled: sourceBinding.codeIndexingEnabled } : null,
          hostingBinding: hostingBinding ? { provider: hostingBinding.provider, connectionId: hostingBinding.connectionId, projectId: hostingBinding.projectId, projectName: hostingBinding.projectName, providerEnvironmentId: hostingBinding.providerEnvironmentId, providerEnvironmentName: hostingBinding.providerEnvironmentName, serviceId: hostingBinding.serviceId, serviceName: hostingBinding.serviceName, publicUrl: hostingBinding.publicUrl } : null,
          runtimeVariables: runtimeVars.map(v => ({ key: v.key, category: v.category, required: v.required, configured: v.configured, source: v.source })),
        }, null, 2) };
      }

      // ── Cloudflare Pages provider controls ──
      if (["get_cloudflare_pages_project", "deploy_cloudflare_pages", "cancel_cloudflare_pages_deployment", "poll_cloudflare_pages_deployment", "repair_cloudflare_pages_project"].includes(action)) {
        const envId = positiveId(args.id);
        if (!envId) return { result: "Missing positive environment id", error: true };
        const principal = getCurrentPrincipalOrSystem();
        const { principalHasPermission } = await import("./permissions");
        const permission = action === "get_cloudflare_pages_project" || action === "poll_cloudflare_pages_deployment" ? "build:read" : "build:write";
        if (!principalHasPermission(principal, permission)) return { result: `Permission required: ${permission}`, error: true };
        const [binding] = await db.select().from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, envId)).limit(1);
        if (!binding || binding.provider !== "cloudflare" || !binding.connectionId || !binding.projectId || !binding.projectName) return { result: "Environment has no complete Cloudflare Pages hosting binding", error: true };
        const [connection] = await db.select().from(providerConnections).where(visibleConn(eq(providerConnections.id, binding.connectionId))).limit(1);
        if (!connection?.credentialRef) return { result: "Cloudflare provider connection has no credential", error: true };
        const token = await getProviderCredential(connection.credentialRef);
        if (!token) return { result: "Cloudflare provider credential could not be decrypted", error: true };
        const controls = await import("./platforms/cloudflare-pages-service");
        if (action === "get_cloudflare_pages_project") return { result: JSON.stringify(await controls.getCloudflarePagesProjectTruth(token, binding.projectId, binding.projectName)) };
        const deploymentId = typeof args.deploymentId === "string" && args.deploymentId.trim() ? args.deploymentId.trim() : null;
        if ((action === "cancel_cloudflare_pages_deployment" || action === "poll_cloudflare_pages_deployment") && !deploymentId) return { result: "deploymentId is required", error: true };
        let outcome;
        if (action === "cancel_cloudflare_pages_deployment") outcome = await controls.cancelCloudflarePagesDeployment(token, binding.projectId, binding.projectName, deploymentId!);
        else if (action === "poll_cloudflare_pages_deployment") outcome = await controls.pollCloudflarePagesDeployment(token, binding.projectId, binding.projectName, deploymentId!);
        else if (action === "repair_cloudflare_pages_project") outcome = await controls.repairCloudflarePagesProject(token, binding.projectId, binding.projectName, args.cloudflareRepair && typeof args.cloudflareRepair === "object" ? args.cloudflareRepair as controls.CloudflareProjectRepair : {});
        else outcome = deploymentId ? await controls.retryCloudflarePagesDeployment(token, binding.projectId, binding.projectName, deploymentId) : await controls.triggerCloudflarePagesProductionDeployment(token, binding.projectId, binding.projectName);
        return { result: JSON.stringify(outcome), error: outcome.outcome === "provider_error" || outcome.outcome === "rejected" };
      }

      // ── get_environment_status ──
      if (action === "get_environment_status") {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: "Missing 'id' parameter for get_environment_status", error: true };

        const [env] = await db.select().from(platformProductEnvironments).where(eq(platformProductEnvironments.id, envId)).limit(1);
        if (!env) return { result: `Environment ${envId} not found`, error: true };

        let hostingBinding: Record<string, unknown> | null = null;
        try {
          const [hb] = await db.select().from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, envId)).limit(1);
          hostingBinding = hb || null;
        } catch (err) {
          toolExec.debug("Hosting binding query failed for status check", { error: err instanceof Error ? err.message : String(err) });
        }

        if (!hostingBinding || !hostingBinding.connectionId) {
          return { result: JSON.stringify({ status: "no_binding", message: "No hosting binding configured for this environment." }) };
        }

        // Get the token from the connection
        const [conn] = await db.select().from(providerConnections).where(visibleConn(eq(providerConnections.id, hostingBinding.connectionId))).limit(1);
        if (!conn?.credentialRef) {
          return { result: JSON.stringify({ status: "no_credential", message: "Hosting connection has no credential." }) };
        }
        const token = await getProviderCredential(conn.credentialRef);
        if (!token) {
          return { result: JSON.stringify({ status: "credential_error", message: "Could not decrypt hosting credential." }) };
        }

        // Dispatch based on hosting provider
        const hostingProvider = (hostingBinding.provider as string) || conn.provider || "railway";
        let deployment: Record<string, unknown> | null = null;

        if (hostingProvider === "cloudflare") {
          // Cloudflare Pages: projectId = account ID, projectName = Pages project name
          const { getCloudflareLatestDeployment } = await import("./services/provider-connection-service");
          if (hostingBinding.projectId && hostingBinding.projectName) {
            try {
              const cfEnv = (hostingBinding.providerEnvironmentId as string) || "production";
              const latest = await getCloudflareLatestDeployment(token, hostingBinding.projectId as string, hostingBinding.projectName as string, cfEnv);
              if (latest) {
                deployment = {
                  id: latest.id,
                  status: latest.status,
                  environment: latest.environment,
                  commitHash: latest.commitHash,
                  commitMessage: latest.commitMessage,
                  branch: latest.branch,
                  url: latest.url,
                  createdAt: latest.createdAt,
                };
              }
            } catch (err) {
              return { result: JSON.stringify({ status: "api_error", provider: "cloudflare", message: err instanceof Error ? err.message : String(err) }) };
            }
          }
        } else {
          // Railway (default)
          const { getLatestDeploymentByToken } = await import("./integrations/railway/client");
          if (hostingBinding.serviceId && hostingBinding.providerEnvironmentId && hostingBinding.projectId) {
            try {
              const latest = await getLatestDeploymentByToken(token, hostingBinding.projectId as string, hostingBinding.serviceId as string, hostingBinding.providerEnvironmentId as string);
              if (latest) {
                deployment = {
                  id: latest.id,
                  status: latest.status,
                  commitHash: latest.commitHash,
                  commitMessage: latest.commitMessage,
                  createdAt: latest.createdAt,
                };
              }
            } catch (err) {
              return { result: JSON.stringify({ status: "api_error", provider: "railway", message: err instanceof Error ? err.message : String(err) }) };
            }
          }
        }

        // URL reachability check
        let urlReachable: boolean | null = null;
        const checkUrl = hostingBinding.publicUrl as string | null;
        if (checkUrl) {
          try {
            const urlRes = await fetch(checkUrl.startsWith("http") ? checkUrl : `https://${checkUrl}`, { method: "HEAD", signal: AbortSignal.timeout(5000) });
            urlReachable = urlRes.ok;
          } catch (err) {
            toolExec.debug("URL reachability check failed", { url: checkUrl, error: err instanceof Error ? err.message : String(err) });
            urlReachable = false;
          }
        }

        return { result: JSON.stringify({
          environment: env.name,
          provider: hostingProvider,
          deployment,
          url: checkUrl || null,
          urlReachable,
        }, null, 2) };
      }


      // ── build lifecycle config/status/workflows ──
      if (["get_build_lifecycle", "set_build_lifecycle", "disable_build_lifecycle", "delete_build_lifecycle", "get_build_status", "start_build_workflow", "list_environment_workflows"].includes(action)) {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: `Missing 'id' (environment ID) for ${action}`, error: true };
        const lifecycle = await import("./platforms/build-lifecycle-service");
        if (action === "get_build_lifecycle") {
          const result = await lifecycle.getEnvironmentBuildLifecycleConfig(envId, { includeDisabled: args.includeDisabled === true });
          if (!result) return { result: `Environment ${envId} not found`, error: true };
          return { result: JSON.stringify(result, null, 2) };
        }
        if (action === "set_build_lifecycle") {
          const input = {
            workflowTemplateId: args.workflowTemplateId,
            providerKind: args.providerKind,
            deployPolicy: args.deployPolicy,
            acceptanceTarget: args.acceptanceTarget,
            authMode: args.authMode,
            retryPolicy: args.retryPolicy,
            gatePolicy: args.gatePolicy,
            evidenceConfig: args.evidenceConfig,
            docsConfig: args.docsConfig,
            enabled: args.enabled,
          };
          const result = await lifecycle.setEnvironmentBuildLifecycleConfig(envId, input);
          return { result: JSON.stringify({ saved: true, config: result }, null, 2) };
        }
        if (action === "disable_build_lifecycle") {
          const result = await lifecycle.disableEnvironmentBuildLifecycleConfig(envId);
          return { result: JSON.stringify({ disabled: true, config: result }, null, 2) };
        }
        if (action === "delete_build_lifecycle") {
          const result = await lifecycle.deleteEnvironmentBuildLifecycleConfigs(envId);
          return { result: JSON.stringify(result, null, 2) };
        }
        if (action === "get_build_status") {
          const result = await lifecycle.getEnvironmentBuildStatus(envId);
          if (!result) return { result: `Environment ${envId} not found`, error: true };
          return { result: JSON.stringify(result, null, 2) };
        }
        if (action === "start_build_workflow") {
          const sessionId = typeof args._sessionId === "string" ? args._sessionId.trim() : "";
          const result = await lifecycle.startEnvironmentBuildWorkflow(envId, {
            title: typeof args.title === "string" ? args.title : undefined,
            objective: typeof args.objective === "string" ? args.objective : undefined,
            start: typeof args.start === "boolean" ? args.start : undefined,
            ...(sessionId ? { parentSessionId: sessionId, createdBySessionId: sessionId } : {}),
          });
          return { result: `${JSON.stringify(result, null, 2)}\n\n@workflow:${result.run.id}` };
        }
        if (action === "list_environment_workflows") {
          const result = await lifecycle.listEnvironmentBuildWorkflows(envId, typeof args.limit === "number" ? args.limit : 20);
          if (!result) return { result: `Environment ${envId} not found`, error: true };
          return { result: JSON.stringify(result, null, 2) };
        }
      }

      // ── delete_environment ──
      if (action === "delete_environment") {
        const envId = positiveId(args.id);
        if (!envId) return { result: "Missing positive environment 'id' parameter for delete_environment", error: true };
        const [env] = await db.select().from(platformProductEnvironments).where(eq(platformProductEnvironments.id, envId)).limit(1);
        if (!env) return { result: `Environment ${envId} not found`, error: true };
        const [prod] = await db.select({ id: platformProducts.id, platformId: platformProducts.platformId }).from(platformProducts).where(eq(platformProducts.id, env.productId)).limit(1);
        if (!prod) return { result: `Product not found for environment ${envId}`, error: true };
        const [plat] = await db.select({ id: platformsTable.id }).from(platformsTable).where(writablePlat(eq(platformsTable.id, prod.platformId))).limit(1);
        if (!plat) return { result: `No write access to environment ${envId}`, error: true };
        await db.delete(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, envId));
        await db.delete(environmentSourceBindings).where(eq(environmentSourceBindings.environmentId, envId));
        const [deleted] = await db.delete(platformProductEnvironments).where(eq(platformProductEnvironments.id, envId)).returning();
        await db.update(platformProducts).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(platformProducts.id, prod.id));
        await db.update(platformsTable).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, prod.platformId)));
        return { result: JSON.stringify({ deleted: true, environment: deleted }, null, 2) };
      }

      // ── save_source_binding ──
      if (action === "save_source_binding") {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: "Missing 'id' (environment ID) for save_source_binding", error: true };

        const [env] = await db.select().from(platformProductEnvironments).where(eq(platformProductEnvironments.id, envId)).limit(1);
        if (!env) return { result: `Environment ${envId} not found`, error: true };

        // Verify writable access through platform chain
        const [prod] = await db.select().from(platformProducts).where(eq(platformProducts.id, env.productId)).limit(1);
        if (!prod) return { result: `Product not found for environment ${envId}`, error: true };
        const [plat] = await db.select().from(platformsTable).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), platScopeColumns, eq(platformsTable.id, prod.platformId))).limit(1);
        if (!plat) return { result: `No write access to platform for environment ${envId}`, error: true };

        // Verify connectionId is visible to the current user before saving
        if (typeof args.connectionId === "number") {
          const [conn] = await db.select({ id: providerConnections.id }).from(providerConnections)
            .where(visibleConn(eq(providerConnections.id, args.connectionId))).limit(1);
          if (!conn) return { result: `Connection ${args.connectionId} not found or not visible`, error: true };
        }

        const values: Record<string, unknown> = { environmentId: envId, updatedAt: sqlTag`CURRENT_TIMESTAMP` };
        if (typeof args.connectionId === "number") values.connectionId = args.connectionId;
        if (typeof args.owner === "string") values.owner = args.owner;
        if (typeof args.repo === "string") values.repo = args.repo;
        if (typeof args.branch === "string") values.branch = args.branch;
        if (typeof args.autoDeploy === "boolean") values.autoDeploy = args.autoDeploy;
        if (typeof args.codeIndexingEnabled === "boolean") values.codeIndexingEnabled = args.codeIndexingEnabled;
        values.provider = "github";

        // Upsert
        const [existing] = await db.select({ id: environmentSourceBindings.id }).from(environmentSourceBindings).where(eq(environmentSourceBindings.environmentId, envId)).limit(1);
        let saved;
        if (existing) {
          [saved] = await db.update(environmentSourceBindings).set(values).where(eq(environmentSourceBindings.id, existing.id)).returning();
        } else {
          values.createdAt = sqlTag`CURRENT_TIMESTAMP`;
          [saved] = await db.insert(environmentSourceBindings).values(values).returning();
        }
        return { result: JSON.stringify({ saved: true, binding: { id: saved.id, environmentId: saved.environmentId, provider: saved.provider, owner: saved.owner, repo: saved.repo, branch: saved.branch, connectionId: saved.connectionId, codeIndexingEnabled: saved.codeIndexingEnabled } }, null, 2) };
      }

      // ── save_hosting_binding ──
      if (action === "save_hosting_binding") {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: "Missing 'id' (environment ID) for save_hosting_binding", error: true };

        const [env] = await db.select().from(platformProductEnvironments).where(eq(platformProductEnvironments.id, envId)).limit(1);
        if (!env) return { result: `Environment ${envId} not found`, error: true };

        // Verify writable access through platform chain
        const [prod] = await db.select().from(platformProducts).where(eq(platformProducts.id, env.productId)).limit(1);
        if (!prod) return { result: `Product not found for environment ${envId}`, error: true };
        const [plat] = await db.select().from(platformsTable).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), platScopeColumns, eq(platformsTable.id, prod.platformId))).limit(1);
        if (!plat) return { result: `No write access to platform for environment ${envId}`, error: true };

        // Verify connectionId is visible to the current user before saving
        if (typeof args.connectionId === "number") {
          const [conn] = await db.select({ id: providerConnections.id }).from(providerConnections)
            .where(visibleConn(eq(providerConnections.id, args.connectionId))).limit(1);
          if (!conn) return { result: `Connection ${args.connectionId} not found or not visible`, error: true };
        }

        const values: Record<string, unknown> = { environmentId: envId, updatedAt: sqlTag`CURRENT_TIMESTAMP` };
        if (typeof args.connectionId === "number") values.connectionId = args.connectionId;
        if (typeof args.projectId === "string") values.projectId = args.projectId;
        if (typeof args.projectName === "string") values.projectName = args.projectName;
        if (typeof args.providerEnvironmentId === "string") values.providerEnvironmentId = args.providerEnvironmentId;
        if (typeof args.providerEnvironmentName === "string") values.providerEnvironmentName = args.providerEnvironmentName;
        if (typeof args.serviceId === "string") values.serviceId = args.serviceId;
        if (typeof args.serviceName === "string") values.serviceName = args.serviceName;
        if (typeof args.publicUrl === "string") values.publicUrl = args.publicUrl;
        values.provider = "railway";

        // Upsert
        const [existing] = await db.select({ id: environmentHostingBindings.id }).from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, envId)).limit(1);
        let saved;
        if (existing) {
          [saved] = await db.update(environmentHostingBindings).set(values).where(eq(environmentHostingBindings.id, existing.id)).returning();
        } else {
          values.createdAt = sqlTag`CURRENT_TIMESTAMP`;
          [saved] = await db.insert(environmentHostingBindings).values(values).returning();
        }
        return { result: JSON.stringify({ saved: true, binding: { id: saved.id, environmentId: saved.environmentId, provider: saved.provider, projectId: saved.projectId, projectName: saved.projectName, providerEnvironmentId: saved.providerEnvironmentId, serviceName: saved.serviceName, connectionId: saved.connectionId } }, null, 2) };
      }

      // ── save_context_artifact ──
      if (action === "save_context_artifact") {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: "Missing 'id' (environment ID) for save_context_artifact", error: true };
        const kind = typeof args.kind === "string" ? args.kind.trim() : null;
        const libraryPageId = typeof args.libraryPageId === "string" ? args.libraryPageId.trim() : null;
        if (!kind) return { result: "Missing 'kind' for save_context_artifact", error: true };
        if (!libraryPageId) return { result: "Missing 'libraryPageId' for save_context_artifact", error: true };

        const [env] = await db.select().from(platformProductEnvironments).where(eq(platformProductEnvironments.id, envId)).limit(1);
        if (!env) return { result: `Environment ${envId} not found`, error: true };
        const [prod] = await db.select().from(platformProducts).where(eq(platformProducts.id, env.productId)).limit(1);
        if (!prod) return { result: `Product not found for environment ${envId}`, error: true };
        const [plat] = await db.select().from(platformsTable).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), platScopeColumns, eq(platformsTable.id, prod.platformId))).limit(1);
        if (!plat) return { result: `No write access to platform for environment ${envId}`, error: true };

        // Verify library page exists
        const { libraryPages } = await import("@shared/models/info");
        const [page] = await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(eq(libraryPages.id, libraryPageId)).limit(1);
        if (!page) return { result: `Library page ${libraryPageId} not found`, error: true };

        // Dedup: same environment + kind + libraryPageId = already linked
        const [existingDup] = await db.select({ id: environmentContextArtifacts.id }).from(environmentContextArtifacts)
          .where(and(eq(environmentContextArtifacts.environmentId, envId), eq(environmentContextArtifacts.kind, kind), eq(environmentContextArtifacts.libraryPageId, libraryPageId))).limit(1);

        let saved;
        if (existingDup) {
          saved = existingDup;
        } else {
          [saved] = await db.insert(environmentContextArtifacts).values({ environmentId: envId, kind, libraryPageId }).returning();
        }
        return { result: JSON.stringify({ saved: true, artifact: { id: saved.id, environmentId: saved.environmentId, kind: saved.kind, libraryPageId: saved.libraryPageId, pageTitle: page.title } }, null, 2) };
      }

      // ── get_context_artifacts ──
      if (action === "get_context_artifacts") {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: "Missing 'id' (environment ID) for get_context_artifacts", error: true };

        const { libraryPages } = await import("@shared/models/info");
        const rows = await db
          .select({
            id: environmentContextArtifacts.id,
            environmentId: environmentContextArtifacts.environmentId,
            kind: environmentContextArtifacts.kind,
            libraryPageId: environmentContextArtifacts.libraryPageId,
            pageTitle: libraryPages.title,
          })
          .from(environmentContextArtifacts)
          .leftJoin(libraryPages, eq(environmentContextArtifacts.libraryPageId, libraryPages.id))
          .where(eq(environmentContextArtifacts.environmentId, envId));

        return { result: JSON.stringify(rows.map(r => ({ ...r, pageTitle: r.pageTitle || "Untitled" })), null, 2) };
      }

      // ── remove_context_artifact ──
      if (action === "remove_context_artifact") {
        const envId = typeof args.id === "number" ? args.id : null;
        const kind = typeof args.kind === "string" ? args.kind.trim() : null;
        const libraryPageId = typeof args.libraryPageId === "string" ? args.libraryPageId.trim() : null;
        if (!envId) return { result: "Missing 'id' (environment ID) for remove_context_artifact", error: true };
        if (!kind) return { result: "Missing 'kind' for remove_context_artifact", error: true };

        const [env] = await db.select().from(platformProductEnvironments).where(eq(platformProductEnvironments.id, envId)).limit(1);
        if (!env) return { result: `Environment ${envId} not found`, error: true };
        const [prod] = await db.select().from(platformProducts).where(eq(platformProducts.id, env.productId)).limit(1);
        if (!prod) return { result: `Product not found for environment ${envId}`, error: true };
        const [plat] = await db.select().from(platformsTable).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), platScopeColumns, eq(platformsTable.id, prod.platformId))).limit(1);
        if (!plat) return { result: `No write access to platform for environment ${envId}`, error: true };

        // If libraryPageId provided, remove the specific artifact; otherwise remove all of that kind
        const conditions = [eq(environmentContextArtifacts.environmentId, envId), eq(environmentContextArtifacts.kind, kind)];
        if (libraryPageId) conditions.push(eq(environmentContextArtifacts.libraryPageId, libraryPageId));

        const deleted = await db.delete(environmentContextArtifacts)
          .where(and(...conditions))
          .returning({ id: environmentContextArtifacts.id });

        if (deleted.length === 0) return { result: `Context artifact kind '${kind}'${libraryPageId ? ` with page ${libraryPageId}` : ""} not found for environment ${envId}`, error: true };
        return { result: JSON.stringify({ removed: true, kind, count: deleted.length }) };
      }

      return { result: `Unhandled platforms action: ${action}`, error: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Platforms ${action} failed: ${msg}`, error: true };
    }
  },


  async sentry(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    if (!action) return { result: "Missing 'action' parameter", error: true };
    const allowed = new Set(["status", "issues", "issue", "events", "latest_event", "resolve", "unresolve", "ignore"]);
    if (!allowed.has(action)) {
      return {
        result: `Unknown sentry action: ${action}. Allowed: ${[...allowed].join(", ")}.`,
        error: true,
      };
    }

    const {
      getSentryConfig,
      isSentryConfigured,
      fetchIssues,
      fetchIssue,
      fetchIssueEvents,
      fetchLatestEvent,
      updateIssueStatus,
      SentryApiError,
    } = await import("./integrations/sentry/client");

    const cfg = await getSentryConfig();
    if (!isSentryConfigured(cfg)) {
      const missing: string[] = [];
      if (!cfg.hasToken) missing.push("SENTRY_AUTH_TOKEN");
      if (!cfg.org) missing.push("SENTRY_ORG");
      if (!cfg.project) missing.push("SENTRY_PROJECT");
      return {
        result: `Sentry not configured. Missing: ${missing.join(", ")}. Add them via the Integrations page.`,
        error: true,
      };
    }

    const org = cfg.org;
    const project = cfg.project;

    try {
      switch (action) {
        case "status": {
          return {
            result: JSON.stringify({
              configured: true,
              org,
              project,
              url: `https://sentry.io/organizations/${org}/issues/?project=&query=is%3Aunresolved`,
            }),
          };
        }
        case "issues": {
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
          const query = typeof args.query === "string" ? args.query : "is:unresolved";
          const sort = typeof args.sort === "string" ? args.sort : "date";
          const issues = await fetchIssues(org, project, { query, sort, limit });
          const items = issues.map((i) => ({
            id: i.id,
            shortId: i.shortId,
            title: i.title,
            culprit: i.culprit,
            level: i.level,
            status: i.status,
            count: i.count,
            userCount: i.userCount,
            firstSeen: i.firstSeen,
            lastSeen: i.lastSeen,
            platform: i.platform,
            permalink: i.permalink,
          }));
          return { result: JSON.stringify({ count: items.length, issues: items }) };
        }
        case "issue": {
          const issueId = typeof args.issueId === "string" ? args.issueId : "";
          if (!issueId) return { result: "Missing 'issueId' parameter", error: true };
          const issue = await fetchIssue(org, issueId);
          return { result: JSON.stringify(issue) };
        }
        case "events": {
          const issueId = typeof args.issueId === "string" ? args.issueId : "";
          if (!issueId) return { result: "Missing 'issueId' parameter", error: true };
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 10));
          const full = args.full !== false;
          const events = await fetchIssueEvents(org, issueId, { full, limit });
          return { result: JSON.stringify({ issueId, count: events.length, events }) };
        }
        case "latest_event": {
          const issueId = typeof args.issueId === "string" ? args.issueId : "";
          if (!issueId) return { result: "Missing 'issueId' parameter", error: true };
          const event = await fetchLatestEvent(org, issueId);
          return { result: JSON.stringify(event) };
        }
        case "resolve": {
          const issueId = typeof args.issueId === "string" ? args.issueId : "";
          if (!issueId) return { result: "Missing 'issueId' parameter", error: true };
          const updated = await updateIssueStatus(org, issueId, "resolved");
          return { result: JSON.stringify({ ok: true, id: updated.id, status: updated.status }) };
        }
        case "unresolve": {
          const issueId = typeof args.issueId === "string" ? args.issueId : "";
          if (!issueId) return { result: "Missing 'issueId' parameter", error: true };
          const updated = await updateIssueStatus(org, issueId, "unresolved");
          return { result: JSON.stringify({ ok: true, id: updated.id, status: updated.status }) };
        }
        case "ignore": {
          const issueId = typeof args.issueId === "string" ? args.issueId : "";
          if (!issueId) return { result: "Missing 'issueId' parameter", error: true };
          const updated = await updateIssueStatus(org, issueId, "ignored");
          return { result: JSON.stringify({ ok: true, id: updated.id, status: updated.status }) };
        }
      }
      return { result: `Unhandled sentry action: ${action}`, error: true };
    } catch (err: unknown) {
      if (err instanceof SentryApiError) {
        return { result: `Sentry ${action} failed: ${err.message} (status=${err.status})${err.details ? ` — ${JSON.stringify(err.details)}` : ""}`, error: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Sentry ${action} failed: ${msg}`, error: true };
    }
  },
  async tasks(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      create: (a) => bridgeHandlers.create_task(a),
      complete: (a) => bridgeHandlers.complete_task(a),
      delete: (a) => bridgeHandlers.delete_task(a),
      update: (a) => bridgeHandlers.update_task(a),
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown tasks action: ${action}. Available: create, complete, delete, update`, error: true };
    return handler(args);
  },

  async finance(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      summary: (a) => bridgeHandlers.get_finance_summary(a),
      accounts: (a) => bridgeHandlers.get_accounts(a),
      transactions: (a) => bridgeHandlers.get_transactions(a),
      holdings: (a) => bridgeHandlers.get_holdings(a),
      liabilities: (a) => bridgeHandlers.get_liabilities(a),
      debt_payments: (a) => bridgeHandlers.get_debt_payments(a),
      categories: (a) => bridgeHandlers.get_categories(a),
      budget: (a) => bridgeHandlers.get_budget(a),
      income: (a) => bridgeHandlers.get_income(a),
      recurring: (a) => bridgeHandlers.get_recurring(a),
      forecast: (a) => bridgeHandlers.get_forecast(a),
      assets: async () => {
        try {
          const { db } = await import("./db");
          const { financedAssets, manualAssets, manual401kAccounts, incomeDeductions, incomeSources } = await import("@shared/schema");

          const [financedRows, manualRows, k401Rows, deductionRows, sourceRows] = await Promise.all([
            db.select().from(financedAssets).where(visibleFinanceForCurrentPrincipal(financedAssets)),
            db.select().from(manualAssets).where(visibleFinanceForCurrentPrincipal(manualAssets)),
            db.select().from(manual401kAccounts).where(visibleFinanceForCurrentPrincipal(manual401kAccounts)),
            db.select().from(incomeDeductions).where(visibleFinanceForCurrentPrincipal(incomeDeductions)),
            db.select().from(incomeSources).where(visibleFinanceForCurrentPrincipal(incomeSources)),
          ]);

          if (financedRows.length === 0 && manualRows.length === 0 && k401Rows.length === 0) {
            return { result: "No assets tracked yet." };
          }

          const parts: string[] = [];
          let combinedTotal = 0;

          if (financedRows.length > 0) {
            const totalValue = financedRows.reduce((s, r) => s + (r.currentValue || 0), 0);
            const totalLoans = financedRows.reduce((s, r) => s + (r.loanBalance || 0), 0);
            const totalEquity = totalValue - totalLoans;
            combinedTotal += totalEquity;
            const lines = financedRows.map(r => {
              const equity = (r.currentValue || 0) - (r.loanBalance || 0);
              return `- **${r.name}** (${r.category}): value $${(r.currentValue || 0).toLocaleString()}, loan balance $${(r.loanBalance || 0).toLocaleString()}, equity $${equity.toLocaleString()}${r.monthlyPayment ? `, payment $${r.monthlyPayment}/mo` : ""}${r.loanApr ? `, ${r.loanApr}% APR` : ""}`;
            });
            parts.push(`**Financed Assets (${financedRows.length})**\nValue: $${totalValue.toLocaleString()} | Loans: $${totalLoans.toLocaleString()} | Equity: $${totalEquity.toLocaleString()}\n${lines.join("\n")}`);
          }

          if (manualRows.length > 0) {
            const manualTotal = manualRows.reduce((s, r) => s + r.currentValue, 0);
            combinedTotal += manualTotal;
            const lines = manualRows.map(r => `- **${r.name}** [${r.category}]: $${r.currentValue.toLocaleString()}`);
            parts.push(`**Manual Assets (${manualRows.length})**\nTotal: $${manualTotal.toLocaleString()}\n${lines.join("\n")}`);
          }

          if (k401Rows.length > 0) {
            const FREQ_MULT: Record<string, number> = { weekly: 52/12, biweekly: 26/12, semimonthly: 2, monthly: 1, quarterly: 1/3, annually: 1/12 };
            const deductionMap = new Map(deductionRows.map(d => [d.id, d]));
            const sourceMap = new Map(sourceRows.map(s => [s.id, s]));
            const k401Total = k401Rows.reduce((s, a) => s + a.currentBalance, 0);
            combinedTotal += k401Total;
            const lines = k401Rows.map(a => {
              const ded = a.linkedDeductionId ? deductionMap.get(a.linkedDeductionId) : null;
              const source = ded ? sourceMap.get(ded.sourceId) : null;
              const mult = source ? (FREQ_MULT[source.payFrequency] || 1) : 1;
              const monthly = ded ? ded.amount * mult : 0;
              return `- **${a.name}**: balance $${a.currentBalance.toLocaleString()}${monthly > 0 ? `, contribution $${monthly.toFixed(0)}/mo` : ""}`;
            });
            parts.push(`**401k Accounts (${k401Rows.length})**\nTotal: $${k401Total.toLocaleString()}\n${lines.join("\n")}`);
          }

          parts.push(`\n**Combined Asset Total: $${combinedTotal.toLocaleString()}**`);
          return { result: parts.join("\n\n") };
        } catch (e: any) { return { result: `Error fetching assets: ${e.message}`, error: true }; }
      },
      goals: async (a) => {
        try {
          const { db } = await import("./db");
          const { financialGoals, plaidAccounts, insertFinancialGoalSchema } = await import("@shared/schema");
          const { eq } = await import("drizzle-orm");
          const goalAction = a.goal_action || "list";

          if (goalAction === "list") {
            const goals = await db.select().from(financialGoals).where(visibleFinanceForCurrentPrincipal(financialGoals));
            if (goals.length === 0) return { result: "No financial goals set yet. Create one with goal_action: 'create'." };
            const accounts = await db.select().from(plaidAccounts).where(visibleFinanceForCurrentPrincipal(plaidAccounts));
            const accountMap = new Map(accounts.map(a => [a.accountId, a]));
            const lines = goals.map(g => {
              let computedAmount = g.currentAmount || 0;
              const linkedNames: string[] = [];
              if (g.linkedAccountIds && g.linkedAccountIds.length > 0) {
                computedAmount = 0;
                for (const aid of g.linkedAccountIds) {
                  const acct = accountMap.get(aid);
                  if (acct) {
                    computedAmount += acct.currentBalance || 0;
                    linkedNames.push(acct.officialName || acct.name || aid);
                  }
                }
              }
              const pct = g.targetAmount > 0 ? Math.min(100, Math.round((computedAmount / g.targetAmount) * 100)) : 0;
              let line = `- **${g.name}** [id:${g.id}] (${g.category}): $${computedAmount.toLocaleString()} / $${g.targetAmount.toLocaleString()} (${pct}%)`;
              if (g.targetDate) line += ` — target: ${g.targetDate}`;
              if (linkedNames.length > 0) line += ` — linked: ${linkedNames.join(", ")}`;
              if (g.notes) line += `\n  Notes: ${g.notes}`;
              return line;
            });
            return { result: `Financial Goals (${goals.length}):\n${lines.join("\n")}` };
          }

          if (goalAction === "create") {
            if (!a.name || !a.targetAmount || !a.category) {
              return { result: "Required: name, targetAmount, category. Optional: currentAmount, targetDate, notes, linkedAccountIds (array of Plaid account IDs).", error: true };
            }
            const parsed = insertFinancialGoalSchema.parse({
              name: a.name,
              targetAmount: Number(a.targetAmount),
              currentAmount: Number(a.currentAmount || 0),
              category: a.category,
              targetDate: a.targetDate || null,
              notes: a.notes || null,
              linkedAccountIds: a.linkedAccountIds || null,
            });
            if ((parsed.category?.toLowerCase().includes("emergency") || parsed.category?.toLowerCase().includes("savings")) &&
                (!parsed.linkedAccountIds || parsed.linkedAccountIds.length === 0)) {
              const depositoryAccounts = await db.select({ accountId: plaidAccounts.accountId })
                .from(plaidAccounts).where(eq(plaidAccounts.type, "depository"));
              if (depositoryAccounts.length > 0) {
                parsed.linkedAccountIds = depositoryAccounts.map(a => a.accountId);
              }
            }
            const [goal] = await db.insert(financialGoals).values(parsed).returning();
            return { result: `Created financial goal: "${goal.name}" (id:${goal.id}) — $${goal.targetAmount.toLocaleString()} target in ${goal.category}.` };
          }

          if (goalAction === "update") {
            if (!a.id) return { result: "Required: id. Provide fields to update: name, targetAmount, currentAmount, category, targetDate, notes, linkedAccountIds.", error: true };
            const id = Number(a.id);
            const updates: Record<string, any> = { updatedAt: new Date() };
            if (a.name !== undefined) updates.name = a.name;
            if (a.targetAmount !== undefined) updates.targetAmount = Number(a.targetAmount);
            if (a.currentAmount !== undefined) updates.currentAmount = Number(a.currentAmount);
            if (a.category !== undefined) updates.category = a.category;
            if (a.targetDate !== undefined) updates.targetDate = a.targetDate;
            if (a.notes !== undefined) updates.notes = a.notes;
            if (a.linkedAccountIds !== undefined) updates.linkedAccountIds = a.linkedAccountIds;
            const [updated] = await db.update(financialGoals).set(updates).where(eq(financialGoals.id, id)).returning();
            if (!updated) return { result: `Goal id:${id} not found.`, error: true };
            return { result: `Updated goal "${updated.name}" (id:${updated.id}): target $${updated.targetAmount.toLocaleString()}, current $${(updated.currentAmount || 0).toLocaleString()}.` };
          }

          if (goalAction === "delete") {
            if (!a.id) return { result: "Required: id of the goal to delete.", error: true };
            const id = Number(a.id);
            const [deleted] = await db.delete(financialGoals).where(eq(financialGoals.id, id)).returning();
            if (!deleted) return { result: `Goal id:${id} not found.`, error: true };
            return { result: `Deleted goal "${deleted.name}" (id:${deleted.id}).` };
          }

          return { result: `Unknown goal_action: ${goalAction}. Available: list, create, update, delete.`, error: true };
        } catch (e: any) { return { result: `Error managing financial goals: ${e.message}`, error: true }; }
      },
      import_transactions: async () => {
        return { result: "CSV import is available through the Finance > Transactions tab. Click 'Import CSV' to upload a bank CSV file. The system will auto-detect columns, map merchant names to Plaid categories using existing transaction data and keyword matching, deduplicate against existing transactions, and import them. Supported formats: most bank CSV exports with date, description, and amount columns (or separate debit/credit columns).", error: false };
      },
      link_account: (a) => bridgeHandlers.link_account(a),
      refresh: (a) => bridgeHandlers.refresh_data(a),
      amortize: (a) => bridgeHandlers.amortize(a),
      list_amortizations: (a) => bridgeHandlers.list_amortizations(a),
      remove_amortization: (a) => bridgeHandlers.remove_amortization(a),
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown finance action: ${action}. Available: summary, accounts, transactions, holdings, liabilities, debt_payments, categories, budget, income, recurring, forecast, assets, goals, import_transactions, link_account, refresh, amortize, list_amortizations, remove_amortization`, error: true };
    return handler(args);
  },

  async meetings(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      add: (a) => bridgeHandlers.add_meeting(a),
      list: (a) => bridgeHandlers.list_meetings(a),
      update: (a) => bridgeHandlers.update_meeting(a),
      delete: (a) => bridgeHandlers.delete_meeting(a),
      set_metadata: (a) => bridgeHandlers.set_metadata_meeting(a),
      get_metadata: (a) => bridgeHandlers.get_metadata_meeting(a),
      link_artifact: (a) => bridgeHandlers.link_artifact_meeting(a),
      unlink_artifact: (a) => bridgeHandlers.unlink_artifact_meeting(a),
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown meetings action: ${action}. Available: add, list, update, delete, set_metadata, get_metadata, link_artifact, unlink_artifact`, error: true };
    return handler(args);
  },

  async tools(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter. Available: list, get", error: true };

    if (action === "list") {
      const { TOOLS } = await import("./tool-registry");
      const lines = Object.entries(TOOLS).map(([name, meta]) =>
        `- **${name}** (${meta.category}): ${meta.description.slice(0, 80)}...`
      );
      return { result: `Available tools (${lines.length}):\n${lines.join("\n")}` };
    }

    if (action === "get") {
      const toolName = args.tool;
      if (!toolName) return { result: "Missing tool parameter for get action", error: true };
      const { TOOLS } = await import("./tool-registry");
      const meta = TOOLS[toolName];
      if (!meta) return { result: `Unknown tool: ${toolName}`, error: true };

      let detail = `## ${toolName}\n${meta.description}\nCategory: ${meta.category}`;
      if (meta.parameters?.properties) {
        const params = Object.entries(meta.parameters.properties).map(([k, v]) => {
          const prop = v as { description?: string; type?: string };
          return `  - ${k}: ${prop.description || prop.type || ""}${meta.parameters?.required?.includes(k) ? " (required)" : ""}`;
        });
        detail += `\nParameters:\n${params.join("\n")}`;
      }

      try {
        const { TOOL_DETAILS } = await import("./tool-details");
        const details = TOOL_DETAILS[toolName];
        if (details) {
          detail += `\n\n### Detailed Documentation\n${details.description}`;
          if (details.whenToUse) detail += `\n\n### When to Use\n${details.whenToUse}`;
          if (details.example) detail += `\n\n### Examples\n${details.example}`;
          if (details.actions) {
            const actionLines = Object.entries(details.actions).map(([name, info]) => {
              let line = `  - **${name}**: ${info.description}`;
              if (info.requiredParams?.length) line += ` | Required: ${info.requiredParams.join(", ")}`;
              if (info.optionalParams?.length) line += ` | Optional: ${info.optionalParams.join(", ")}`;
              return line;
            });
            detail += `\n\n### Actions\n${actionLines.join("\n")}`;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        detail += `\n\n(Detailed docs unavailable: ${msg})`;
      }

      return { result: detail };
    }

    return { result: `Unknown tools action: ${action}. Available: list, get`, error: true };
  },

  async content(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter. Available: queue_draft, list, suggest_times", error: true };

    if (action === "queue_draft") {
      const { createContent } = await import("./content-storage");
      const platform = args.platform || "x";
      const content = args.content;
      if (!content) return { result: "Missing content parameter", error: true };
      const post = await createContent({
        platform,
        content,
        threadParts: args.threadParts || null,
        metadata: args.metadata || null,
        status: "draft",
      });
      // Record session artifact link
      const { recordSessionArtifact } = await import("./session-artifacts");
      recordSessionArtifact(args._sessionId, "content_draft", String(post.id), { platform: post.platform });
      return { result: `Draft queued successfully.\nID: ${post.id}\nContent: ${post.content.slice(0, 100)}${post.content.length > 100 ? "..." : ""}\nStatus: draft\nPlatform: ${post.platform}` };
    }

    if (action === "list") {
      const { listContent } = await import("./content-storage");
      const posts = await listContent({
        status: args.status || undefined,
        limit: args.limit ? parseInt(args.limit, 10) : 20,
      });
      if (posts.length === 0) return { result: "No posts found in content queue." };
      const lines = posts.map(p => {
        let line = `- [${p.status}] ${p.content.slice(0, 80)}${p.content.length > 80 ? "..." : ""}`;
        if (p.scheduledAt) line += ` (scheduled: ${new Date(p.scheduledAt).toLocaleString("en-US", { timeZone: "America/Chicago" })})`;
        if (p.platformUrl) line += ` → ${p.platformUrl}`;
        return line;
      });
      return { result: `Content queue (${posts.length} posts):\n${lines.join("\n")}` };
    }

    if (action === "suggest_times") {
      const { suggestPostingTimes } = await import("./content-publisher");
      const { getScheduledPostsInRange } = await import("./content-storage");
      const count = parseInt(args.count || "7", 10);
      const startDate = args.startDate || new Date().toISOString();
      const endDate = args.endDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const existing = await getScheduledPostsInRange(startDate, endDate);
      const existingTimes = existing.filter(p => p.scheduledAt).map(p => new Date(p.scheduledAt!));
      const times = suggestPostingTimes(count, startDate, endDate, existingTimes);
      return { result: `Suggested posting times (${times.length}):\n${times.map(t => `- ${new Date(t).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT`).join("\n")}` };
    }

    return { result: `Unknown content action: ${action}. Available: queue_draft, list, suggest_times`, error: true };
  },

  async memory_ops(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = String(args.action || "");
    try {
      switch (action) {
        case "run_full_sleep_cycle": {
          const includeGSI = args.includeGSI === true || args.includeGSI === "true" || args.include_gsi === true || args.include_gsi === "true";
          const { runFullSleepCycle } = await import("./sleep-cycle");
          const result = await runFullSleepCycle({ includeGSI });
          const parts = [
            `Full sleep cycle complete (${result.durationMs}ms)${result.timedOut ? ` — TIMED OUT (${result.abortReason || "unknown"})` : ""}:`,
          ];
          if (result.vnextLifecycle) {
            const lc = result.vnextLifecycle;
            parts.push(`  vNext lifecycle: ${lc.scanned} scanned, ${lc.canonicalized} canonicalized, ${lc.retired} retired, ${lc.decayed} decayed, ${lc.errors} errors`);
            parts.push(`  Bridges: ${lc.bridges.created} created, ${lc.bridges.replaced} replaced, ${lc.bridges.finalEdges} final edges (${lc.bridges.scanned} scanned)`);
          } else {
            parts.push("  vNext lifecycle: did not complete");
          }
          parts.push(`  REM: ${result.rem.seedCount} seeds, ${result.rem.sessionCount} sessions, ${result.rem.domainsWoven} domains. Dream: "${result.rem.dreamTitle || "none"}"`);
          if (result.gsi) {
            parts.push(`  GSI: ${(result.gsi.overall * 100).toFixed(1)}% (connectivity=${(result.gsi.connectivity * 100).toFixed(1)}%, linkQuality=${(result.gsi.linkQuality * 100).toFixed(1)}%, orphanRate=${(result.gsi.orphanRate * 100).toFixed(1)}%, clusterBalance=${(result.gsi.clusterBalance * 100).toFixed(1)}%, decayHealth=${(result.gsi.decayHealth * 100).toFixed(1)}%)`);
          }
          if (result.errors.length > 0) {
            parts.push(`  Errors (${result.errors.length}): ${result.errors.join("; ")}`);
          }
          if (result.rem.dreamInsight) {
            parts.push("", `Dream insight: ${result.rem.dreamInsight}`);
          }
          if (result.rem.dreamNarrative) {
            parts.push("", "Dream narrative (file to Library per skill instructions):", result.rem.dreamNarrative);
          }
          return { result: parts.join("\n") };
        }
        case "compute_gsi": {
          const { computeGSI } = await import("./memory/graph-metrics");
          const gsi = await computeGSI();
          return { result: `GSI Score: ${(gsi.overall * 100).toFixed(1)}% — connectivity=${(gsi.connectivity * 100).toFixed(1)}%, linkQuality=${(gsi.linkQuality * 100).toFixed(1)}%, orphanRate=${(gsi.orphanRate * 100).toFixed(1)}%, clusterBalance=${(gsi.clusterBalance * 100).toFixed(1)}%, decayHealth=${(gsi.decayHealth * 100).toFixed(1)}% (${gsi.details.activeClaims} active claims)` };
        }
        case "run_rem": {
          const { runREMPhase } = await import("./memory/dream-engine");
          const rem = await runREMPhase();
          const remParts = [
            `REM phase complete (${rem.durationMs}ms): ${rem.seedCount} seeds, ${rem.sessionCount} sessions, ${rem.domainsWoven} domains. Dream: "${rem.dreamTitle || "none"}"`,
          ];
          if (rem.dreamInsight) remParts.push(`Dream insight: ${rem.dreamInsight}`);
          if (rem.dreamNarrative) remParts.push("", "Dream narrative (file to Library per skill instructions):", rem.dreamNarrative);
          if (rem.errors.length > 0) remParts.push(`Errors: ${rem.errors.join("; ")}`);
          return { result: remParts.join("\n") };
        }
        default:
          return { result: `Unknown memory_ops action: "${action}". Valid actions: run_full_sleep_cycle, compute_gsi, run_rem`, error: true };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `memory_ops(${action}) error: ${msg}`, error: true };
    }
  },

  async get_system_state(_args: Record<string, any>): Promise<ToolHandlerResult> {
    try {
      const parts: string[] = ["## System State Summary"];

      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const counts = await memoryVnextClaimStorage.getCounts();
        parts.push(`**Memory:** ${counts.total} vNext claims — source refs: ${counts.sourceRefs}, entity links: ${counts.entityLinks}, claim links: ${counts.claimLinks}`);
      } catch { parts.push("**Memory:** vNext unavailable"); }

      try {
        const { storage } = await import("./storage");
        const skills = await storage.getSkills({ status: "active" });
        parts.push(`**Skills:** ${skills.length} active`);
      } catch { parts.push("**Skills:** unavailable"); }

      try {
        const caps = await specStorage.listSystemCapabilities();
        const health = await specStorage.getUserStoryHealthSummary();
        const active = caps.filter(c => c.status === "active").length;
        const degraded = caps.filter(c => c.status === "degraded").length;
        const missing = caps.filter(c => c.status === "missing").length;
        parts.push(`**Capabilities:** ${caps.length} total — active: ${active}, degraded: ${degraded}, missing: ${missing}`);
        parts.push(`**User Stories:** passing: ${health.passing}, blocked: ${health.blocked}, untested: ${health.untested}, failing: ${health.failing}`);
      } catch { parts.push("**Capabilities:** unavailable"); }

      // Intentions system removed — autonomy skill handles autonomous work

      try {
        const { goalsService: goalsServiceState } = await import("./goals-service");
        const goals = await goalsServiceState.listAll({ includeDormant: true });
        parts.push(`**Goals:** ${goals.length} total`);
      } catch { parts.push("**Goals:** unavailable"); }

      try {
        const { peopleStorage } = await import("./people-storage");
        const people = await peopleStorage.listPeople();
        const byTier: Record<string, number> = {};
        for (const p of people) {
          const tier = p.cabinetLevel || "unknown";
          byTier[tier] = (byTier[tier] || 0) + 1;
        }
        parts.push(`**People:** ${people.length} total — ${Object.entries(byTier).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
      } catch { parts.push("**People:** unavailable"); }

      try {
        const { db } = await import("./db");
        const { connectedAccounts } = await import("@shared/schema");
        const accounts = await db.select().from(connectedAccounts);
        const byProvider: Record<string, number> = {};
        let healthy = 0;
        let unhealthy = 0;
        for (const a of accounts) {
          byProvider[a.provider] = (byProvider[a.provider] || 0) + 1;
          if (a.healthy === false) { unhealthy++; } else { healthy++; }
        }
        parts.push(`**Connected Accounts:** ${accounts.length} total (healthy: ${healthy}, unhealthy: ${unhealthy}) — ${Object.entries(byProvider).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
      } catch { parts.push("**Connected Accounts:** unavailable"); }

      try {
        const { fileProjectStorage } = await import("./file-storage/projects");
        const projects = await fileProjectStorage.getProjects();
        const byStatus: Record<string, number> = {};
        for (const p of projects) {
          const proj = p as unknown as Record<string, unknown>;
          const st = String(proj.status || "unknown");
          byStatus[st] = (byStatus[st] || 0) + 1;
        }
        parts.push(`**Projects:** ${projects.length} total — ${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
      } catch { parts.push("**Projects:** unavailable"); }

      try {
        const { admissionController } = await import("./run-admission");
        const schedulingState = admissionController.getState();
        const tierCounts = admissionController.getTierCounts();
        const activeSlots = admissionController.getSlots().map(s => ({
          runId: s.runId,
          tier: s.tier,
          yieldRequested: s.yieldRequested,
        }));
        const queueDepth = admissionController.getQueueDepth();
        const tierSummary = Object.entries(tierCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(", ");
        parts.push(`**Scheduling:** state=${schedulingState}, activeSlots=${activeSlots.length}, queueDepth=${queueDepth}${tierSummary ? ` — tiers: ${tierSummary}` : ""}`);
        if (activeSlots.length > 0) {
          parts.push(`  Slots: ${activeSlots.map(s => `${s.runId}(${s.tier}${s.yieldRequested ? ",yielding" : ""})`).join(", ")}`);
        }
      } catch { parts.push("**Scheduling:** unavailable"); }

      try {
        const { getInFlightStats } = await import("./db");
        const dbStats = getInFlightStats();
        const breakdown = Object.entries(dbStats.bySubsystem).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(", ");
        parts.push(`**DB In-Flight:** ${dbStats.total} total${breakdown ? ` — ${breakdown}` : ""}`);
      } catch { parts.push("**DB In-Flight:** unavailable"); }

      try {
        const { getDbSaturationInfo } = await import("./db");
        const sat = getDbSaturationInfo();
        const probeMs = sat.lastProbeDurationMs === null ? "—" : `${sat.lastProbeDurationMs}ms`;
        const satFor = sat.saturatedForMs > 0 ? `, saturatedFor=${sat.saturatedForMs}ms` : "";
        parts.push(`**DB Pool:** total=${sat.total}, idle=${sat.idle}, waiting=${sat.waiting}${satFor}, lastProbe=${probeMs}`);
      } catch { parts.push("**DB Pool:** unavailable"); }

      try {
        const { getSlowQueryStats } = await import("./db");
        const s = getSlowQueryStats();
        const last = s.lastSlowDurationMs === null ? "none" : `${s.lastSlowDurationMs}ms`;
        parts.push(`**Slow Queries:** lastMin=${s.lastMinute}, last10m=${s.lastTenMinutes}, threshold=${s.thresholdMs}ms, lastSlow=${last}`);
      } catch { parts.push("**Slow Queries:** unavailable"); }

      try {
        const pm = await import("./performance-monitor");
        const cur = pm.getLatestEventLoopLag?.() ?? 0;
        const diag = pm.getPerformanceDiagnostics?.();
        const max = diag?.eventLoopLag?.max ?? 0;
        const avg = diag?.eventLoopLag?.avg ?? 0;
        parts.push(`**Event Loop:** current=${Math.round(cur * 100) / 100}ms, avg=${Math.round(avg * 100) / 100}ms, max=${Math.round(max * 100) / 100}ms`);
      } catch { parts.push("**Event Loop:** unavailable"); }

      try {
        const { agentExecutor } = await import("./agent-executor");
        const { ACTIVITY_CHAT } = await import("./job-profiles");
        const runs = agentExecutor.getActiveRuns();
        const chat = runs.filter(r => r.activity === ACTIVITY_CHAT).length;
        const aborted = runs.filter(r => r.aborted).length;
        parts.push(`**Executor:** activeRuns=${runs.length} (chat=${chat}, aborted=${aborted})`);
      } catch { parts.push("**Executor:** unavailable"); }

      try {
        const { admissionController } = await import("./run-admission");
        const slots = admissionController.getSlots();
        if (slots.length === 0) {
          parts.push(`**Admission Slots:** none`);
        } else {
          const now = Date.now();
          const summary = slots.map(s => `${s.runId.slice(0, 8)}(${s.tier},${Math.round((now - s.grantedAt) / 1000)}s${s.yieldRequested ? ",yielding" : ""})`).join(", ");
          parts.push(`**Admission Slots:** ${slots.length} — ${summary}`);
        }
      } catch { parts.push("**Admission Slots:** unavailable"); }

      try {
        const { getZombieMetrics } = await import("./cli-sdk-adapter");
        const z = getZombieMetrics();
        parts.push(`**Zombies:** active=${z.active}, peak=${z.peak}`);
      } catch { parts.push("**Zombies:** unavailable"); }

      try {
        const { agentExecutor } = await import("./agent-executor");
        const { admissionController } = await import("./run-admission");
        const { getZombieMetrics } = await import("./cli-sdk-adapter");
        const runs = agentExecutor.getActiveRuns();
        const slots = admissionController.getSlots();
        const zombies = getZombieMetrics();
        const slotIds = new Set(slots.map(s => s.runId));
        let drift = 0;
        const driftParts: string[] = [];
        const orphanRuns = runs.filter(r => !r.aborted && !slotIds.has(r.runId)).length;
        if (orphanRuns > 0) { drift += orphanRuns; driftParts.push(`${orphanRuns} run(s) without slot`); }
        const abortedCount = runs.filter(r => r.aborted).length;
        if (zombies.active > abortedCount) {
          const delta = zombies.active - abortedCount;
          drift += delta;
          driftParts.push(`${delta} unattributed zombie(s)`);
        }
        parts.push(`**Books vs Reality:** drift=${drift}${driftParts.length ? ` — ${driftParts.join("; ")}` : " (in sync)"}`);
      } catch { parts.push("**Books vs Reality:** unavailable"); }

      try {
        const { getBrowserStats, isBrowserLaunching } = await import("./browser-manager");
        const bs = getBrowserStats();
        const launching = isBrowserLaunching() ? ", launching" : "";
        parts.push(`**Browser Manager:** activeBrowsers=${bs.activeBrowsers}, activePages=${bs.activePages}, queued=${bs.queued}${launching}`);
      } catch { parts.push("**Browser Manager:** unavailable"); }

      return { result: parts.join("\n") };
    } catch (err: any) {
      return { result: `get_system_state error: ${err.message}`, error: true };
    }
  },

  library: async (args) => {
    const { db } = await import("./db");
    const { libraryPages, libraryAnnotations, libraryPageLinks } = await import("@shared/models/info");
    const { eq, desc, asc, ilike, or, and, isNull, sql } = await import("drizzle-orm");
    const { getCurrentPrincipalOrSystem } = await import("./principal-context");
    const { combineWithVisibleScope, combineWithWritableScope, visibleScopePredicate } = await import("./scoped-storage");

    const action = args.action;
    const principal = getCurrentPrincipalOrSystem();
    const libScopeColumns = { scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, vaultId: libraryPages.vaultId };
    const visibleLib = (predicate?: SQL) => combineWithVisibleScope(principal, libScopeColumns, predicate);
    const writableLib = (predicate?: SQL) => combineWithWritableScope(principal, libScopeColumns, predicate);

    function publishLibraryChanged(action: string, page?: { id?: string | null; title?: string | null; surface?: boolean | null; surfaceUntil?: Date | string | null }) {
      eventBus.publish({
        category: "system",
        event: "data:library_changed",
        payload: {
          source: "library_tool",
          action,
          pageId: page?.id ?? null,
          title: page?.title ?? null,
          surface: page?.surface ?? null,
          surfaceUntil: page?.surfaceUntil instanceof Date ? page.surfaceUntil.toISOString() : (page?.surfaceUntil ?? null),
        },
      });
    }

    const { buildLibrarySurfaceSet } = await import("./library-save");

    try {
      // ── Breadcrumb helper ──────────────────────────────────────
      async function buildBreadcrumbMap(): Promise<Map<string, { title: string; parentId: string | null }>> {
        const allPages = await db.select({
          id: libraryPages.id,
          title: libraryPages.title,
          parentId: libraryPages.parentId,
        }).from(libraryPages).where(visibleLib());
        const map = new Map<string, { title: string; parentId: string | null }>();
        for (const p of allPages) map.set(p.id, { title: p.title, parentId: p.parentId });
        return map;
      }

      function getBreadcrumb(pageId: string, map: Map<string, { title: string; parentId: string | null }>): string {
        const chain: string[] = [];
        let currentId: string | null = map.get(pageId)?.parentId ?? null;
        const seen = new Set<string>();
        while (currentId && map.has(currentId) && !seen.has(currentId)) {
          seen.add(currentId);
          chain.unshift(map.get(currentId)!.title);
          currentId = map.get(currentId)!.parentId;
        }
        return chain.length > 0 ? chain.join(" > ") : "root";
      }

      // ── Library page actions ──────────────────────────────────────
      if (action === "list_library_pages" || action === "list") {
        const pages = await db.select({
          id: libraryPages.id,
          title: libraryPages.title,
          slug: libraryPages.slug,
          parentId: libraryPages.parentId,
          oneLiner: libraryPages.oneLiner,
          summary: libraryPages.summary,
          updatedAt: libraryPages.updatedAt,
        }).from(libraryPages).where(visibleLib()).orderBy(desc(libraryPages.updatedAt)).limit(50);
        if (pages.length === 0) return { result: "No library pages found." };
        const bcMap = await buildBreadcrumbMap();
        return { result: `Library pages (${pages.length}):\n${pages.map(p => {
          const location = getBreadcrumb(p.id, bcMap);
          const ol = p.oneLiner ? ` — ${p.oneLiner}` : "";
          const sum = p.summary ? `\n  ${p.summary}` : "";
          return `- [${p.id}] **${p.title}** in ${location} (/${p.slug})${ol}${sum}`;
        }).join("\n")}` };
      }

      if (action === "search_library_pages" || action === "search") {
        const q = args.query || "";
        if (!q) return { result: "Provide a query for search.", error: true };
        const words = q.trim().split(/\s+/).filter(Boolean);
        const wordConditions = words.map((word) =>
          or(
            ilike(libraryPages.title, `%${word}%`),
            ilike(libraryPages.oneLiner, `%${word}%`),
            ilike(libraryPages.summary, `%${word}%`),
            sql`array_to_string(${libraryPages.tags}, ' ') ilike ${'%' + word + '%'}`,
            ilike(libraryPages.plainTextContent, `%${word}%`),
          )
        );
        const whereClause = wordConditions.length === 1 ? wordConditions[0] : and(...wordConditions);
        const pages = await db.select({
          id: libraryPages.id,
          title: libraryPages.title,
          slug: libraryPages.slug,
          parentId: libraryPages.parentId,
          oneLiner: libraryPages.oneLiner,
          summary: libraryPages.summary,
          plainTextContent: libraryPages.plainTextContent,
        }).from(libraryPages).where(visibleLib(whereClause)).limit(20);
        if (pages.length === 0) return { result: `No library pages matching "${q}".` };
        const bcMap = await buildBreadcrumbMap();
        return { result: `Search results for "${q}":\n${pages.map(p => {
          const breadcrumb = getBreadcrumb(p.id, bcMap);
          const path = breadcrumb === "root" ? p.title : `${breadcrumb} > ${p.title}`;
          const ol = p.oneLiner ? `\n  ${p.oneLiner}` : "";
          const sum = p.summary ? `\n  ${p.summary}` : "";
          const snippet = (!p.oneLiner && !p.summary) ? `\n  ${(p.plainTextContent || "").slice(0, 500)}` : "";
          return `- [${p.id}] **${p.title}** (${path})${ol}${sum}${snippet}`;
        }).join("\n\n")}` };
      }

      if (action === "browse_tree" || action === "tree") {
        const allPages = await db.select({
          id: libraryPages.id,
          title: libraryPages.title,
          slug: libraryPages.slug,
          parentId: libraryPages.parentId,
          emoji: libraryPages.emoji,
          oneLiner: libraryPages.oneLiner,
        }).from(libraryPages).where(visibleLib()).orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title));

        if (allPages.length === 0) return { result: "No library pages found." };

        type TreeNode = (typeof allPages)[number] & { children: TreeNode[] };
        const buildTree = (parentId: string | null): TreeNode[] => {
          return allPages
            .filter(p => p.parentId === parentId)
            .map(p => ({ ...p, children: buildTree(p.id) }));
        };

        const formatTree = (nodes: TreeNode[], indent: number = 0): string => {
          return nodes.map(n => {
            const prefix = "  ".repeat(indent) + "- ";
            const emoji = n.emoji ? `${n.emoji} ` : "";
            const ol = n.oneLiner ? ` — ${n.oneLiner}` : "";
            const line = `${prefix}${emoji}**${n.title}** [${n.id}] (/${n.slug})${ol}`;
            const childLines = n.children.length > 0 ? "\n" + formatTree(n.children, indent + 1) : "";
            return line + childLines;
          }).join("\n");
        };

        const tree = buildTree(null);
        return { result: `Library tree (${allPages.length} pages):\n${formatTree(tree)}` };
      }

      if (action === "get_library_page" || action === "get") {
        const id = args.id;
        if (!id) return { result: "Provide an id or slug.", error: true };
        const byId = await db.select().from(libraryPages).where(visibleLib(eq(libraryPages.id, id)));
        const page = byId[0] || (await db.select().from(libraryPages).where(visibleLib(eq(libraryPages.slug, id))))[0];
        if (!page) return { result: `Library page "${id}" not found.` };
        const annotations = await db.select().from(libraryAnnotations).where(eq(libraryAnnotations.pageId, page.id));
        const annotationText = annotations.length > 0
          ? `\n\n**Agent Annotations:**\n${annotations.map(a => `- [${a.annotationType}] ${a.content}`).join("\n")}`
          : "";
        const statusLine = page.status ? `\n**Status:** ${page.status}` : "";
        const surfaceLine = page.surface && page.surfaceUntil ? `\n**Surfaced Until:** ${page.surfaceUntil instanceof Date ? page.surfaceUntil.toISOString() : page.surfaceUntil}` : "";
        const tagsLine = page.tags && page.tags.length > 0 ? `\n**Tags:** ${page.tags.join(", ")}` : "";
        const { tiptapToMarkdown } = await import("@shared/markdown-tiptap");
        const mdContent = page.content ? tiptapToMarkdown(page.content as any) : (page.plainTextContent || "[no content]");
        return { result: `# ${page.title}${tagsLine}${statusLine}${surfaceLine}\n\n${mdContent}${annotationText}\n\n**Parent ID:** ${page.parentId || "none"}` };
      }

      if (action === "compile_library_page" || action === "compile") {
        const id = args.id;
        if (!id) return { result: "Provide a Source or Artifact page id or slug to compile.", error: true };
        try {
          const { compileLibraryPageToMantraWiki } = await import("./library-compiler");
          const result = await compileLibraryPageToMantraWiki(String(id), principal);
          publishLibraryChanged("compiled", { id: result.sourcePageId, title: result.sourceTitle });
          return {
            result: `Library compile complete for @page:${result.sourcePageId}. Created ${result.wikiPagesCreated.length}, updated ${result.wikiPagesUpdated.length}, unchanged ${result.wikiPagesUnchanged.length}, links added ${result.linksAdded}. Index: @page:${result.indexPageId}. Log: @page:${result.logPageId}.`,
            compile: result,
          };
        } catch (err: any) {
          return { result: err?.message || String(err), error: true };
        }
      }

      if (action === "query_index" || action === "query_library_index") {
        const q = args.query || args.contentSummary || args.title || "";
        if (!q) return { result: "Provide a query for Index-first Library retrieval.", error: true };
        try {
          const { queryMantraLibraryIndex } = await import("./library-compiler");
          const result = await queryMantraLibraryIndex(String(q), principal);
          const wiki = result.wikiPages.map(p => `- @page:${p.id} **${p.title}** — ${p.summary || "compiled Wiki page"}\n  ${p.contentPreview.slice(0, 500)}`).join("\n");
          const evidence = result.evidencePageIds.length ? `\n\nEvidence/neighbor refs: ${result.evidencePageIds.map(id => `@page:${id}`).join(", ")}` : "";
          const neighbors = result.neighbors?.length ? `\n\nOne-hop Library neighbors: ${result.neighbors.map(n => `@page:${n.id} (${n.direction})`).join(", ")}` : "";
          return {
            result: `Index-first Library query for "${q}" read @page:${result.indexPageId} and selected ${result.wikiPages.length} Wiki page(s)${result.fallbackUsed ? " using bounded fallback" : ""}.\n${wiki}${evidence}${neighbors}`,
            query: result,
          };
        } catch (err: any) {
          return { result: err?.message || String(err), error: true };
        }
      }

      if (action === "resolve_parent") {
        const { placeLibraryPageSemantically } = await import("./library-placement");
        try {
          const resolution = await placeLibraryPageSemantically({
            purpose: args.purpose || null,
            pageContext: args.pageContext || null,
            title: args.title || "Untitled",
            contentSummary: args.contentSummary || args.summary || null,
            tags: Array.isArray(args.tags) ? args.tags : null,
            structuralRole: args.structuralRole || null,
            explicitParentId: args.parentId || null,
          }, principal);
          return {
            result: resolution.lint.requiresReview
              ? `Library placement requires review: ${resolution.reason}`
              : `Resolved Library parent: ${resolution.parentTitle} (${resolution.parentId}) via vault Index.`,
            resolution,
          };
        } catch (err: any) {
          return { result: err.message, error: true };
        }
      }

      if (action === "propose_corpus_migration") {
        try {
          const { proposeLibraryCorpusMigration } = await import("./library-corpus-migration");
          const result = await proposeLibraryCorpusMigration({ idempotencyKey: args.idempotencyKey || null }, principal);
          return {
            result: `Library corpus migration proposal complete. Inventoried ${result.counts.total} pages exactly once: ${result.counts.placed} placed, ${result.counts.unchanged} unchanged, ${result.counts.ambiguous} ambiguous, ${result.counts.invalid} invalid. Report surfaced for review: ${result.reportRef}. Human-review gate: ${result.reviewGate}.`,
            migration: result,
          };
        } catch (err: any) {
          return { result: err?.message || String(err), error: true };
        }
      }

      if (action === "apply_reviewed_corpus_migration") {
        try {
          const runId = String(args.runId || "");
          const itemIds = Array.isArray(args.itemIds) ? args.itemIds.map(String) : [];
          const { applyReviewedLibraryCorpusMigration } = await import("./library-corpus-migration");
          const result = await applyReviewedLibraryCorpusMigration({ runId, itemIds }, principal);
          return {
            result: `Reviewed Library corpus migration apply complete for run ${result.runId}: applied ${result.applied}, skipped ${result.skipped}, remaining placed proposals ${result.remainingPlaced}. Ambiguous and invalid items were not applied.`,
            migrationApply: result,
          };
        } catch (err: any) {
          return { result: err?.message || String(err), error: true };
        }
      }

      // ─── Library page mutations ────────────────────────────────────────
      // create/update/edit/delete coordinate through the Library service or
      // direct transactions that acquire the same parent advisory locks used
      // by reorder, so tool writes do not race user reparenting.
      const { acquireLibraryParentLocks, isSerializationConflict } = await import("./db");

      if (action === "create_library_page" || action === "create" || action === "create_spec") {
        const title = args.title || "Untitled";
        const tags: string[] = Array.isArray(args.tags) ? args.tags : (action === "create_spec" ? ["spec"] : []);
        const status = args.status || null;
        const plain = args.plainTextContent || "";
        const { createFiledLibraryPage } = await import("./library-save");
        try {
          const page = await createFiledLibraryPage({
            title,
            markdown: plain,
            purpose: args.purpose || null,
            explicitParentId: args.parentId || null,
            pageContext: args.pageContext || null,
            contentSummary: args.contentSummary || args.summary || null,
            tags,
            status,
            structuralRole: args.structuralRole || null,
            createdBySessionId: args._sessionId || null,
            surface: args.surface,
            surfaceDurationHours: args.surfaceDurationHours,
            surfaceReason: args.surfaceReason,
            surfaceSection: args.surfaceSection,
          });
          const linkSyntax = ` [page:${page.slug}]`;

          // Record session artifact link
          const { recordSessionArtifact } = await import("./session-artifacts");
          recordSessionArtifact(args._sessionId, "library_page", page.slug, { title: page.title, pageId: page.id });
          return {
            result: `Page created: [${page.id}] **${page.title}** (/${page.slug})${linkSyntax} under ${page.filingResolution.parentTitle}${page.filingResolution.lint.requiresReview ? " — placement requires review" : ""}`,
            resolution: page.filingResolution,
          };
        } catch (err: any) {
          if (isSerializationConflict(err)) {
            toolExec.warn(`create_library_page: serialization conflict — retryable: ${err.message}`);
            return { result: `Library write conflicted with a concurrent reorder, please retry: ${err.message}`, error: true };
          }
          throw err;
        }
      }

      if (action === "update_library_page" || action === "update") {
        const id = args.id;
        if (!id) return { result: "Provide an id to update.", error: true };
        const byId = await db.select({ id: libraryPages.id, parentId: libraryPages.parentId }).from(libraryPages).where(writableLib(eq(libraryPages.id, id)));
        const resolved = byId[0] || (await db.select({ id: libraryPages.id, parentId: libraryPages.parentId }).from(libraryPages).where(writableLib(eq(libraryPages.slug, id))))[0];
        if (!resolved) return { result: `Library page "${id}" not found.`, error: true };
        const resolvedId = resolved.id;
        const oldParentId = resolved.parentId;

        const setData: Partial<typeof libraryPages.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
        if (args.title) { setData.title = args.title; setData.slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page"; }
        if (args.plainTextContent !== undefined) {
          const { syncContentFields } = await import("@shared/markdown-tiptap");
          const synced = syncContentFields({ markdown: args.plainTextContent as string });
          setData.content = synced.content;
          setData.plainTextContent = synced.plainTextContent;
        }
        const parentIdProvided = args.parentId !== undefined;
        const newParentId = parentIdProvided
          ? (args.parentId === "" ? null : (args.parentId as string | null))
          : oldParentId;
        if (parentIdProvided) { setData.parentId = newParentId; }
        if (args.tags !== undefined) setData.tags = args.tags as string[];
        if (args.status !== undefined) setData.status = args.status as string | null;
        if (args.oneLiner !== undefined) setData.oneLiner = args.oneLiner as string | null;
        if (args.summary !== undefined) setData.summary = args.summary as string | null;
        Object.assign(setData, buildLibrarySurfaceSet(args));

        try {
          const updated = await db.transaction(async (tx) => {
            // Lock the old parent always, plus the new parent when it's
            // changing. Sorted dedup happens inside the helper.
            const lockTargets = parentIdProvided && newParentId !== oldParentId
              ? [oldParentId, newParentId]
              : [oldParentId];
            await acquireLibraryParentLocks(tx, lockTargets);
            const [row] = await tx.update(libraryPages).set(setData).where(eq(libraryPages.id, resolvedId)).returning();
            return row;
          });
          if (!updated) return { result: `Library page "${id}" not found.`, error: true };

          const substantiveChange = args.plainTextContent !== undefined || args.title !== undefined;
          if (substantiveChange) {
            try {
              const { syncEmbeddedLibraryPageLinks } = await import("./library-link-graph");
              await syncEmbeddedLibraryPageLinks(updated.id, principal);
            } catch (linkErr: unknown) {
              toolExec.warn(`update_library_page: link sync failed for page ${updated.id}: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`);
            }
            try {
              const { upsertLibraryPageMemory } = await import("./routes/library");
              await upsertLibraryPageMemory(updated);
            } catch (memErr: unknown) {
              toolExec.warn(`update_library_page: memory reset failed for page ${updated.id}: ${memErr instanceof Error ? memErr.message : String(memErr)}`);
            }
          }

          publishLibraryChanged(updated.surface ? "surfaced" : "updated", updated);

          // Record session artifact link
          const { recordSessionArtifact } = await import("./session-artifacts");
          recordSessionArtifact(args._sessionId, "library_page", updated.slug || args.id, { title: updated.title });
          return { result: `Library page updated: [${updated.id}] **${updated.title}**` };
        } catch (err: any) {
          if (isSerializationConflict(err)) {
            toolExec.warn(`update_library_page: serialization conflict (page=${resolvedId} oldParent=${oldParentId} newParent=${newParentId}) — retryable: ${err.message}`);
            return { result: `Library write conflicted with a concurrent reorder, please retry: ${err.message}`, error: true };
          }
          throw err;
        }
      }

      if (action === "edit_library_page" || action === "edit") {
        const id = args.id;
        if (!id) return { result: "Provide an id or slug to edit.", error: true };
        const oldString = args.old_string;
        const newString = args.new_string;
        if (oldString === undefined) return { result: "Missing old_string", error: true };
        if (newString === undefined) return { result: "Missing new_string", error: true };

        const byId = await db.select().from(libraryPages).where(writableLib(eq(libraryPages.id, id)));
        const page = byId[0] || (await db.select().from(libraryPages).where(writableLib(eq(libraryPages.slug, id))))[0];
        if (!page) return { result: `Library page "${id}" not found.`, error: true };

        const { tiptapToMarkdown } = await import("@shared/markdown-tiptap");
        const currentContent = page.plainTextContent || (page.content ? tiptapToMarkdown(page.content as any) : "");
        if (!currentContent) return { result: `Library page "${id}" has no content to edit.`, error: true };

        const occurrences = currentContent.split(oldString).length - 1;
        if (occurrences === 0) {
          return { result: `old_string not found in library page "${page.title}"`, error: true };
        }

        const replaceAll = args.replace_all === true;
        if (occurrences > 1 && !replaceAll) {
          return { result: `old_string found ${occurrences} times in "${page.title}". Use replace_all: true to replace all, or provide more context to make it unique.`, error: true };
        }

        const updatedContent = replaceAll ? currentContent.split(oldString).join(newString) : currentContent.replace(oldString, newString);
        const replacements = replaceAll ? occurrences : 1;

        const { syncContentFields } = await import("@shared/markdown-tiptap");
        const synced = syncContentFields({ markdown: updatedContent });

        try {
          const updated = await db.transaction(async (tx) => {
            await acquireLibraryParentLocks(tx, [page.parentId]);
            const [row] = await tx.update(libraryPages).set({
              content: synced.content,
              plainTextContent: synced.plainTextContent,
              ...buildLibrarySurfaceSet(args),
              updatedAt: new Date(),
            }).where(eq(libraryPages.id, page.id)).returning();
            return row;
          });

          if (!updated) return { result: `Failed to update library page "${id}".`, error: true };

          publishLibraryChanged(updated.surface ? "surfaced" : "updated", updated);

          const lengthDelta = updatedContent.length - currentContent.length;
          toolExec.log(`edit_library_page: page=${updated.id} replacements=${replacements} lengthDelta=${lengthDelta > 0 ? "+" : ""}${lengthDelta}`);

          try {
            const { syncEmbeddedLibraryPageLinks } = await import("./library-link-graph");
            await syncEmbeddedLibraryPageLinks(updated.id, principal);
          } catch (linkErr: unknown) {
            toolExec.warn(`edit_library_page: link sync failed for page ${updated.id}: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`);
          }

          try {
            const { upsertLibraryPageMemory } = await import("./routes/library");
            await upsertLibraryPageMemory(updated);
          } catch (memErr: unknown) {
            toolExec.warn(`edit_library_page: memory sync failed for page ${updated.id}: ${memErr instanceof Error ? memErr.message : String(memErr)}`);
          }

          // Record session artifact link
          const { recordSessionArtifact: recordArtifactEdit } = await import("./session-artifacts");
          recordArtifactEdit(args._sessionId, "library_page", page.slug || args.id, {});
          return { result: `Library page edited: [${updated.id}] **${updated.title}** (${replacements} replacement${replacements > 1 ? "s" : ""})` };
        } catch (err: any) {
          if (isSerializationConflict(err)) {
            toolExec.warn(`edit_library_page: serialization conflict (page=${page.id} parent=${page.parentId}) — retryable: ${err.message}`);
            return { result: `Library write conflicted with a concurrent reorder, please retry: ${err.message}`, error: true };
          }
          throw err;
        }
      }

      if (action === "dismiss_library_page" || action === "desurface_library_page" || action === "dismiss" || action === "desurface") {
        const id = args.id;
        if (!id) return { result: "Provide an id or slug to dismiss.", error: true };
        const byId = await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(writableLib(eq(libraryPages.id, id)));
        const page = byId[0] || (await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(writableLib(eq(libraryPages.slug, id))))[0];
        if (!page) return { result: `Library page "${id}" not found.`, error: true };
        const [updated] = await db.update(libraryPages).set({
          surface: false,
          surfaceUntil: null,
          surfaceReason: null,
          surfaceSection: null,
          updatedAt: new Date(),
        }).where(eq(libraryPages.id, page.id)).returning();
        if (!updated) return { result: `Library page "${id}" not found.`, error: true };
        publishLibraryChanged("desurfaced", updated);
        return { result: `Library page dismissed from surfacing: [${updated.id}] **${updated.title}**` };
      }

      if (action === "delete_library_page" || action === "delete") {
        const id = args.id;
        if (!id) return { result: "Provide an id to delete.", error: true };
        const byId = await db.select({ id: libraryPages.id, parentId: libraryPages.parentId }).from(libraryPages).where(writableLib(eq(libraryPages.id, id)));
        const resolved = byId[0] || (await db.select({ id: libraryPages.id, parentId: libraryPages.parentId }).from(libraryPages).where(writableLib(eq(libraryPages.slug, id))))[0];
        if (!resolved) return { result: `Library page "${id}" not found.`, error: true };
        const resolvedId = resolved.id;
        const parentIdOfPage = resolved.parentId;
        try {
          const deleted = await db.transaction(async (tx) => {
            await acquireLibraryParentLocks(tx, [parentIdOfPage]);
            const [row] = await tx.delete(libraryPages).where(eq(libraryPages.id, resolvedId)).returning();
            return row;
          });
          if (!deleted) return { result: `Library page "${id}" not found.`, error: true };
          publishLibraryChanged("deleted", deleted);
          return { result: `Library page "${deleted.title}" deleted.` };
        } catch (err: any) {
          if (isSerializationConflict(err)) {
            toolExec.warn(`delete_library_page: serialization conflict (page=${resolvedId} parent=${parentIdOfPage}) — retryable: ${err.message}`);
            return { result: `Library write conflicted with a concurrent reorder, please retry: ${err.message}`, error: true };
          }
          throw err;
        }
      }



      if (action === "lint_library" || action === "lint") {
        const { runLibraryLint } = await import("./library-link-graph");
        const report = await runLibraryLint({ repair: args.repair === true, surfaceReport: args.surface === true || args.surfaceReport === true }, principal);
        const reportRef = report.reportPageId ? ` Report: @page:${report.reportPageId}.` : "";
        return { result: `Library lint complete. Pages checked: ${report.checkedPages}. Links checked: ${report.checkedLinks}. Failures: ${report.failures}. Review: ${report.reviewItems}. Warnings: ${report.warnings}. Mechanical repairs inserted ${report.repaired.missingEdgesInserted}, removed ${report.repaired.staleEdgesRemoved}.${reportRef}` };
      }

      if (action === "link_pages") {
        const fromPageId = args.fromPageId || args.sourceId;
        const toPageId = args.toPageId || args.targetId;
        if (!fromPageId || !toPageId) return { result: "Provide fromPageId and toPageId to link pages.", error: true };
        const { getCurrentPrincipalOrSystem: getPrincipalForLink } = await import("./principal-context");
        const { ownedInsertValues: ownedInsertForLink } = await import("./scoped-storage");
        const linkScopeColumns = { scope: libraryPageLinks.scope, ownerUserId: libraryPageLinks.ownerUserId, accountId: libraryPageLinks.accountId };
        const [link] = await db.insert(libraryPageLinks).values({
          sourcePageId: fromPageId,
          targetPageId: toPageId,
          ...ownedInsertForLink(getPrincipalForLink(), linkScopeColumns),
        }).returning();
        return { result: `Pages linked: ${fromPageId} → ${toPageId} (link id: ${link.id})` };
      }

      if (action === "annotate") {
        const id = args.id;
        const content = args.content;
        if (!id || !content) return { result: "Provide id or slug and content for annotation.", error: true };
        const byId = await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug }).from(libraryPages).where(visibleLib(eq(libraryPages.id, id)));
        const page = byId[0] || (await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug }).from(libraryPages).where(visibleLib(eq(libraryPages.slug, id))))[0];
        if (!page) return { result: `Library page "${id}" not found.`, error: true };
        const annotationType = args.annotationType || "observation";
        const { getCurrentPrincipalOrSystem: getPrincipalForAnnotation } = await import("./principal-context");
        const { ownedInsertValues: ownedInsertForAnnotation } = await import("./scoped-storage");
        const annotationScopeColumns = { scope: libraryAnnotations.scope, ownerUserId: libraryAnnotations.ownerUserId, accountId: libraryAnnotations.accountId };
        const [annotation] = await db.insert(libraryAnnotations).values({
          pageId: page.id,
          content,
          annotationType,
          ...ownedInsertForAnnotation(getPrincipalForAnnotation(), annotationScopeColumns),
        }).returning();
        return { result: `Annotation added to page [${page.id}] **${page.title}**: [${annotation.annotationType}] ${annotation.content}` };
      }

      return { result: `Unknown library action: ${action}. Available: list_library_pages, get_library_page, compile_library_page, query_index, resolve_parent, create_library_page, update_library_page, edit_library_page, dismiss_library_page, delete_library_page, search_library_pages, search, browse_tree, tree, link_pages, annotate`, error: true };
    } catch (err: any) {
      return { result: `library tool error: ${err.message}`, error: true };
    }
  },

  async images(args: Record<string, any>): Promise<ToolHandlerResult> {
    const { createLogger } = await import("./log");
    const log = createLogger("Images");
    const action = args.action;
    if (!action) return { result: "Missing action parameter. Use: generate, edit, or analyze", error: true };

    const sub: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      async generate(a) {
        const prompt = a.prompt;
        if (!prompt) return { result: "Missing prompt for image generation", error: true };
        const size = a.size || "1024x1024";
        const quality = a.quality;
        const background = a.background;
        const outputFormat = a.outputFormat || "png";

        // Validate size
        if (size && size !== "1024x1024") {
          const match = size.match(/^(\d+)x(\d+)$/);
          if (!match) return { result: "Invalid size format. Use WIDTHxHEIGHT, e.g. 1920x1080", error: true };
          const [, wStr, hStr] = match;
          const w = parseInt(wStr);
          const h = parseInt(hStr);
          if (w % 16 !== 0 || h % 16 !== 0) return { result: `Invalid size: both dimensions must be divisible by 16. ${w}%16=${w % 16}, ${h}%16=${h % 16}`, error: true };
          if (w > 4096 || h > 4096) return { result: `Size too large: max 4096px per edge. Got ${w}x${h}`, error: true };
          const ratio = Math.max(w, h) / Math.min(w, h);
          if (ratio > 3) return { result: `Aspect ratio too extreme: max 3:1. Got ${ratio.toFixed(1)}:1`, error: true };
        }

        log.debug(`[Images] generate: prompt="${prompt.slice(0, 80)}" size=${size} quality=${quality || "auto"} format=${outputFormat}`);
        try {
          const { generateImageBuffer } = await import("./integrations/image/client");
          const buffer = await generateImageBuffer(prompt, { size, quality, background, outputFormat });

          const ext = outputFormat === "jpeg" ? ".jpg" : `.${outputFormat}`;
          const contentType = outputFormat === "jpeg" ? "image/jpeg" : outputFormat === "webp" ? "image/webp" : "image/png";
          const fileName = `generated-image${ext}`;

          const { objectPath } = await objectStorageService.uploadObjectEntity(buffer, {
            extension: ext,
            contentType,
            acl: { owner: "system", visibility: "public" },
          });
          const downloadLink = `${objectPath}?name=${encodeURIComponent(fileName)}`;
          log.debug(`[Images] generate complete: ${buffer.length} bytes → ${downloadLink}`);
          // Auto-register in media registry
          try {
            const { registerMediaItem } = await import("./media/media-storage");
            await registerMediaItem({
              name: fileName,
              mediaType: "image",
              source: "generated",
              objectPath,
              mimeType: contentType,
              fileSize: buffer.length,
              width: parseInt(size.split("x")[0]) || 1024,
              height: parseInt(size.split("x")[1]) || 1024,
              metadata: { prompt: prompt.slice(0, 500) },
            });
          } catch (regErr: any) {
            log.warn(`[Images] media registry write failed: ${regErr.message}`);
          }
          return { result: `![${fileName}](${downloadLink})\n[Download](${downloadLink})` };
        } catch (err: any) {
          log.error(`[Images] generate error: ${err.message}`);
          return { result: `Image generation failed: ${err.message}`, error: true };
        }
      },

      async edit(a) {
        const prompt = a.prompt;
        const imagePaths: string[] = a.images;
        if (!prompt) return { result: "Missing prompt for image editing", error: true };
        if (!imagePaths || !Array.isArray(imagePaths) || imagePaths.length === 0) {
          return { result: "Missing images array (workspace file paths) for image editing", error: true };
        }
        const outputFormat = a.outputFormat || "png";
        log.debug(`[Images] edit: prompt="${prompt.slice(0, 80)}" images=${imagePaths.length} format=${outputFormat}`);
        try {
          const path = await import("path");
          const fsp = (await import("fs")).promises;
          const os = await import("os");
          const tempFiles: string[] = [];

          // Resolve paths: object storage paths get downloaded to temp files,
          // local paths get resolved normally
          const absolutePaths = await Promise.all(imagePaths.map(async (p: string) => {
            if (p.startsWith("/objects/")) {
              const cleanPath = p.split("?")[0];
              const objectFile = await objectStorageService.getObjectEntityFile(cleanPath);
              const [downloaded] = await objectFile.download();
              const buf = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
              const ext = path.default.extname(cleanPath) || ".png";
              const tmpPath = path.default.join(os.tmpdir(), `img-edit-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
              await fsp.writeFile(tmpPath, buf);
              tempFiles.push(tmpPath);
              log.debug(`[Images] edit: downloaded object storage ${p} → ${tmpPath} (${buf.length} bytes)`);
              return tmpPath;
            }
            return path.default.isAbsolute(p) ? p : path.default.resolve(path.default.join(WORKSPACE_DIR, p));
          }));

          const { editImages } = await import("./integrations/image/client");
          let buffer: Buffer;
          try {
            buffer = await editImages(absolutePaths, prompt);
          } finally {
            // Clean up temp files
            for (const tmp of tempFiles) {
              fsp.unlink(tmp).catch(() => {});
            }
          }

          const ext = outputFormat === "jpeg" ? ".jpg" : `.${outputFormat}`;
          const contentType = outputFormat === "jpeg" ? "image/jpeg" : outputFormat === "webp" ? "image/webp" : "image/png";
          const fileName = `edited-image${ext}`;

          const { objectPath } = await objectStorageService.uploadObjectEntity(buffer, {
            extension: ext,
            contentType,
            acl: { owner: "system", visibility: "public" },
          });
          const downloadLink = `${objectPath}?name=${encodeURIComponent(fileName)}`;
          log.debug(`[Images] edit complete: ${buffer.length} bytes → ${downloadLink}`);
          // Auto-register in media registry
          try {
            const { registerMediaItem } = await import("./media/media-storage");
            await registerMediaItem({
              name: fileName,
              mediaType: "image",
              source: "generated",
              objectPath,
              mimeType: contentType,
              fileSize: buffer.length,
              metadata: { prompt: prompt.slice(0, 500) },
            });
          } catch (regErr: any) {
            log.warn(`[Images] media registry write failed: ${regErr.message}`);
          }
          return { result: `![${fileName}](${downloadLink})\n[Download](${downloadLink})` };
        } catch (err: any) {
          log.error(`[Images] edit error: ${err.message}`);
          return { result: `Image editing failed: ${err.message}`, error: true };
        }
      },

      async analyze(a) {
        const prompt = a.prompt || "Analyze this image thoroughly. Cover the following:\n1. **Text & numbers**: Extract any visible text, labels, captions, watermarks, or numerical values verbatim.\n2. **Objects & subjects**: Identify key objects, people, animals, or landmarks. Note positions, scale, and spatial relationships between them.\n3. **Scene & context**: Describe the setting, environment, and what appears to be happening.\n4. **Colors & visual style**: Note dominant colors, palette, lighting, contrast, and whether it looks like a photo, illustration, screenshot, diagram, meme, etc.\n5. **Tone & composition**: Describe the mood, framing, perspective, and any artistic or design choices.\n6. **Notable details**: Call out anything unusual, subtle, or potentially significant that might be easy to miss.\nBe specific and concrete rather than vague. Quote text exactly as it appears. If something is ambiguous, say so.";
        const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
        log.debug(`[Images] analyze: prompt="${prompt.slice(0, 80)}"`);

        let imageBase64: string;
        let mediaType: string = a.mediaType || "image/png";

        try {
          if (a.path) {
            const pathMod = await import("path");
            const ext = pathMod.default.extname(a.path).toLowerCase();
            mediaType = ext === ".png" ? "image/png"
              : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
              : ext === ".gif" ? "image/gif"
              : ext === ".webp" ? "image/webp"
              : mediaType;

            let fileBuf: Buffer;
            if (a.path.startsWith("/objects/")) {
              // Read from object storage (R2)
              const cleanPath = a.path.split("?")[0];
              const objectFile = await objectStorageService.getObjectEntityFile(cleanPath);
              const [downloaded] = await objectFile.download();
              fileBuf = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
              log.debug(`[Images] analyze: read from object storage ${a.path} (${fileBuf.length} bytes)`);
            } else {
              // Read from local filesystem
              const fsp = (await import("fs")).promises;
              const absPath = pathMod.default.isAbsolute(a.path)
                ? a.path
                : pathMod.default.resolve(pathMod.default.join(WORKSPACE_DIR, a.path));
              fileBuf = await fsp.readFile(absPath);
              log.debug(`[Images] analyze: read file ${a.path} (${fileBuf.length} bytes)`);
            }

            if (fileBuf.length > MAX_IMAGE_SIZE) {
              return { result: `Image file too large (${(fileBuf.length / 1024 / 1024).toFixed(1)}MB, max 10MB)`, error: true };
            }
            imageBase64 = fileBuf.toString("base64");
          } else if (a.url) {
            log.debug(`[Images] analyze: fetching URL ${a.url}`);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            try {
              const resp = await fetch(a.url, { signal: controller.signal });
              clearTimeout(timeout);
              if (!resp.ok) {
                return { result: `Failed to fetch image from URL: ${resp.status} ${resp.statusText}`, error: true };
              }
              const ct = resp.headers.get("content-type") || "";
              if (!ct.startsWith("image/")) {
                return { result: `URL does not point to an image (content-type: ${ct})`, error: true };
              }
              mediaType = ct.split(";")[0].trim();
              const arrayBuf = await resp.arrayBuffer();
              if (arrayBuf.byteLength > MAX_IMAGE_SIZE) {
                return { result: `Image from URL too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)}MB, max 10MB)`, error: true };
              }
              imageBase64 = Buffer.from(arrayBuf).toString("base64");
              log.debug(`[Images] analyze: fetched URL (${arrayBuf.byteLength} bytes)`);
            } catch (fetchErr: any) {
              clearTimeout(timeout);
              if (fetchErr.name === "AbortError") {
                return { result: "Image URL fetch timed out (30s)", error: true };
              }
              return { result: `Failed to fetch image: ${fetchErr.message}`, error: true };
            }
          } else if (a.base64) {
            imageBase64 = a.base64;
            log.debug(`[Images] analyze: using inline base64 (${a.base64.length} chars)`);
          } else {
            return { result: "Missing image source. Provide one of: path (workspace file), url (image URL), or base64 (raw data)", error: true };
          }

          // Route vision through openai-subscription which handles image_url blocks natively
          // via buildCodexInput (converts to input_image). The claude-cli path's buildPrompt
          // JSON.stringifies multimodal content into flat text, causing "prompt too long" errors.
          const dataUrl = `data:${mediaType};base64,${imageBase64}`;
          const { chatCompletion } = await import("./model-client");
          const visionModel = a.depth === "deep"
            ? "openai-subscription/gpt-5.5-sub"
            : "openai-subscription/gpt-5.4-mini-sub";
          const visionMessages = [
            { role: "user" as const, content: [
              { type: "image_url" as const, image_url: { url: dataUrl } },
              { type: "text" as const, text: prompt },
            ] },
          ];
          log.debug(`[Images] analyze: routing to ${visionModel}`);
          const result = await chatCompletion({
            activity: (await import("./job-profiles")).ACTIVITY_MEDIA,
            model: visionModel,
            overrideReason: "image analysis requires multimodal OpenAI subscription model",
            metadata: { source: "bridge-tool", toolName: "images.analyze", activity: (await import("./job-profiles")).ACTIVITY_MEDIA },
            maxTokens: 4000,
            messages: visionMessages,
          });
          const description = result.content.trim() || "Unable to describe image";
          log.debug(`[Images] analyze complete: ${description.length} chars`);
          return { result: description };
        } catch (err: any) {
          log.error(`[Images] analyze error: ${err.message}`);
          return { result: `Image analysis failed: ${err.message}`, error: true };
        }
      },
    };

    const handler = sub[action];
    if (!handler) return { result: `Unknown images action: ${action}. Available: generate, edit, analyze`, error: true };
    return handler(args);
  },

  async captures(args: Record<string, any>): Promise<ToolHandlerResult> {
    const { db } = await import("./db");
    const { captures } = await import("@shared/schema");
    const { desc, gte, eq, and, sql } = await import("drizzle-orm");

    const action = args.action;
    if (!action) return { result: "Missing action. Available: list, reclassify, digest", error: true };

    try {
      if (action === "list") {
        const status = args.status;
        const limit = Math.min(args.limit || 50, 200);
        const conditions: any[] = [];
        if (status) conditions.push(eq(captures.status, status));
        if (args.since) {
          const sinceDate = new Date(args.since);
          if (!isNaN(sinceDate.getTime())) conditions.push(gte(captures.createdAt, sinceDate));
        }
        const where = conditions.length > 0
          ? conditions.length === 1 ? conditions[0] : and(...conditions)
          : undefined;
        const rows = await db.select().from(captures).where(where).orderBy(desc(captures.createdAt)).limit(limit);
        if (rows.length === 0) return { result: "No captures found." };
        const lines = rows.map(c =>
          `- [${c.status}] "${c.rawText.slice(0, 80)}" → ${c.classifiedType || "unclassified"} (confidence: ${c.classificationConfidence ?? "n/a"}, routed: ${c.routedTo || "n/a"})`
        );
        return { result: `${rows.length} capture(s):\n${lines.join("\n")}` };
      }

      if (action === "reclassify") {
        const id = args.id;
        const type = args.type;
        if (!id || !type) return { result: "Provide id and type for reclassify.", error: true };
        const [existing] = await db.select().from(captures).where(eq(captures.id, id));
        if (!existing) return { result: `Capture ${id} not found.`, error: true };
        await db.update(captures).set({ classifiedType: type, status: "pending", errorMessage: null, processedAt: null }).where(eq(captures.id, id));
        const { eventBus: eb } = await import("./event-bus");
        eb.publish({ category: "system", event: "capture.created", payload: { captureId: id, reclassify: true, overrideType: type, context: args.context } });
        return { result: `Capture ${id} set to reclassify as "${type}".` };
      }

      if (action === "digest") {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const rows = await db.select().from(captures).where(gte(captures.createdAt, since)).orderBy(desc(captures.createdAt));
        if (rows.length === 0) return { result: "No captures in the last 24 hours." };
        const routed = rows.filter(c => c.status === "routed");
        const manual = rows.filter(c => c.status === "manual");
        const failed = rows.filter(c => c.status === "failed");
        const pending = rows.filter(c => c.status === "pending" || c.status === "processing");
        const parts = [`## Quick Captures (last 24h)\n`, `**Routed:** ${routed.length} | **Manual:** ${manual.length} | **Failed:** ${failed.length} | **Pending:** ${pending.length}\n`];
        if (routed.length > 0) {
          parts.push("### Auto-routed");
          routed.forEach(c => parts.push(`- ✅ "${c.rawText.slice(0, 80)}" → ${c.routedTo} (${c.classifiedType})`));
        }
        if (manual.length > 0) {
          parts.push("\n### Needs your input");
          manual.forEach(c => parts.push(`- ❓ "${c.rawText.slice(0, 80)}" — ${c.classifiedType || "unclassified"} (${c.classificationConfidence?.toFixed(2) ?? "n/a"} confidence)`));
        }
        if (failed.length > 0) {
          parts.push("\n### Failed");
          failed.forEach(c => parts.push(`- ❌ "${c.rawText.slice(0, 80)}" — ${c.errorMessage || "unknown error"}`));
        }
        return { result: parts.join("\n") };
      }

      return { result: `Unknown captures action: ${action}. Available: list, reclassify, digest`, error: true };
    } catch (err: any) {
      return { result: `Captures tool error: ${err.message}`, error: true };
    }
  },

  async hooks(args) {
    const action = args.action;
    if (!action) return { result: "Missing 'action' parameter. Available: list, get, create, update, delete, test", error: true };

    try {
      const hookStorage = await import("./hook-storage");
      const { hookExecutor } = await import("./hook-executor");

      if (action === "list") {
        const hooks = await hookStorage.listHooks();
        return { result: safeStringify({ total: hooks.length, hooks: hooks.map(h => ({ id: h.id, name: h.name, eventPattern: h.eventPattern, actionType: h.actionType, enabled: h.enabled, cooldownSeconds: h.cooldownSeconds, maxFirings: h.maxFirings })) }, { label: "bridge.hooks.list" }) };
      }

      if (action === "get") {
        const id = args.id as number | undefined;
        const name = args.name as string | undefined;
        let hook;
        if (id) {
          hook = await hookStorage.getHook(id);
        } else if (name) {
          hook = await hookStorage.getHookByName(name);
        } else {
          return { result: "Missing 'id' or 'name' parameter", error: true };
        }
        if (!hook) return { result: "Hook not found", error: true };
        const executions = await hookStorage.getExecutions(hook.id, 5);
        return { result: safeStringify({ hook, recentExecutions: executions }, { label: "bridge.hooks.detail" }) };
      }

      if (action === "create") {
        if (!args.name || !args.eventPattern || !args.actionType || !args.actionConfig) {
          return { result: "Missing required fields: name, eventPattern, actionType, actionConfig", error: true };
        }
        if (!["run_skill", "initiate_conversation", "tool_call"].includes(args.actionType)) {
          return { result: "actionType must be one of: run_skill, initiate_conversation, tool_call", error: true };
        }
        const hook = await hookStorage.createHook({
          name: args.name as string,
          description: args.description as string | undefined,
          eventPattern: args.eventPattern as string,
          condition: args.condition,
          actionType: args.actionType as string,
          actionConfig: typeof args.actionConfig === "string" ? JSON.parse(args.actionConfig) : args.actionConfig,
          cooldownSeconds: args.cooldownSeconds as number | undefined,
          enabled: args.enabled !== false,
          maxFirings: args.maxFirings as number | undefined ?? null,
          createdBy: args.createdBy as string || getInstanceName(),
        });
        hookExecutor.invalidateCache();
        return { result: JSON.stringify({ created: true, hook: { id: hook.id, name: hook.name, eventPattern: hook.eventPattern, actionType: hook.actionType } }) };
      }

      if (action === "update") {
        const id = args.id as number;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const updateData: any = {};
        if (args.name !== undefined) updateData.name = args.name;
        if (args.description !== undefined) updateData.description = args.description;
        if (args.eventPattern !== undefined) updateData.eventPattern = args.eventPattern;
        if (args.condition !== undefined) updateData.condition = args.condition;
        if (args.actionType !== undefined) updateData.actionType = args.actionType;
        if (args.actionConfig !== undefined) updateData.actionConfig = typeof args.actionConfig === "string" ? JSON.parse(args.actionConfig) : args.actionConfig;
        if (args.cooldownSeconds !== undefined) updateData.cooldownSeconds = args.cooldownSeconds;
        if (args.enabled !== undefined) updateData.enabled = args.enabled;
        if (args.maxFirings !== undefined) updateData.maxFirings = args.maxFirings;
        const hook = await hookStorage.updateHook(id, updateData);
        if (!hook) return { result: "Hook not found", error: true };
        hookExecutor.invalidateCache();
        return { result: JSON.stringify({ updated: true, hook: { id: hook.id, name: hook.name, enabled: hook.enabled } }) };
      }

      if (action === "delete") {
        const id = args.id as number;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const existing = await hookStorage.getHook(id);
        if (!existing) return { result: "Hook not found", error: true };
        await hookStorage.deleteHook(id);
        hookExecutor.invalidateCache();
        return { result: JSON.stringify({ deleted: true, name: existing.name }) };
      }

      if (action === "test") {
        const hookId = args.id as number | undefined;
        const eventId = args.eventId as string | undefined;
        if (!hookId) return { result: "Missing 'id' parameter (hook ID)", error: true };
        const hook = await hookStorage.getHook(hookId);
        if (!hook) return { result: "Hook not found", error: true };

        let testEvent: any;
        if (eventId) {
          const { getCurrentPrincipalOrSystem } = await import("./principal-context");
          const eventPrincipal = getCurrentPrincipalOrSystem();
          const recentEvents = eventBus.getRecentEvents(500, undefined, eventPrincipal);
          testEvent = recentEvents.find(e => e.id === eventId);
          if (!testEvent) return { result: "Event not found in current process buffer", error: true };
        } else {
          testEvent = {
            id: "test-event",
            timestamp: Date.now(),
            category: "test",
            event: args.testEvent || "test.event",
            payload: args.testPayload || {},
            bootId: eventBus.bootId,
          };
        }

        const result = hookExecutor.testHook(
          { eventPattern: hook.eventPattern, condition: hook.condition, actionConfig: hook.actionConfig },
          testEvent
        );
        return { result: JSON.stringify({ hook: { id: hook.id, name: hook.name }, event: { id: testEvent.id, event: testEvent.event }, ...result }) };
      }

      return { result: `Unknown hooks action: ${action}. Available: list, get, create, update, delete, test`, error: true };
    } catch (err: any) {
      return { result: `Hooks tool error: ${err.message}`, error: true };
    }
  },

};

export function isBridgeTool(toolName: string): boolean {
  return bridgeHandlers.hasOwnProperty(toolName);
}

export async function executeBridgeTool(
  toolName: string,
  toolCallId: string,
  args: Record<string, any>,
  context?: BridgeToolContext,
): Promise<{ result: string; error?: boolean; data?: Record<string, unknown> }> {
  const result = await executeTool(toolName, toolCallId, args, context);
  // Propagate the optional structured `data` payload (e.g. park_idea
  // returns { parked: true, id }) so consumers of executeBridgeTool can
  // do machine-readable handling instead of parsing the result string.
  return { result: result.result, error: result.error, data: result.data };
}

const workspaceTools: Record<string, ToolHandler> = {
  async read_scratch(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const resolved = resolveWorkspacePath(filePath);
    if (!resolved) return { result: `Path escapes workspace: ${filePath}`, error: true };
    if (!await pathExists(resolved)) return { result: `File not found: ${filePath}`, error: true };

    try {
      const s = await stat(resolved);
      if (s.isDirectory()) return { result: `Path is a directory, not a file: ${filePath}`, error: true };

      const content = await readFile(resolved, "utf-8");
      const lines = content.split("\n");
      const offset = Math.max(0, (args.offset || 1) - 1);
      const limit = args.limit || 1000;
      const sliced = lines.slice(offset, offset + limit);
      const totalLines = lines.length;

      let result = sliced.join("\n");
      if (offset > 0 || offset + limit < totalLines) {
        result = `[Showing lines ${offset + 1}-${Math.min(offset + limit, totalLines)} of ${totalLines}]\n${result}`;
      }
      return { result };
    } catch (err: any) {
      return { result: `Error reading file: ${err.message}`, error: true };
    }
  },

  async write_scratch(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const content = args.content;
    if (content === undefined || content === null) return { result: "Missing file content", error: true };

    const resolved = resolveWorkspacePath(filePath);
    if (!resolved) return { result: `Path escapes workspace: ${filePath}`, error: true };

    try {
      const dir = join(resolved, "..");
      await mkdir(dir, { recursive: true });
      await writeFile(resolved, content, "utf-8");
      return { result: `File written: ${filePath} (${content.length} bytes)` };
    } catch (err: any) {
      return { result: `Error writing file: ${err.message}`, error: true };
    }
  },

  async edit_scratch(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const oldString = args.old_string;
    const newString = args.new_string;
    if (oldString === undefined) return { result: "Missing old_string", error: true };
    if (newString === undefined) return { result: "Missing new_string", error: true };

    const resolved = resolveWorkspacePath(filePath);
    if (!resolved) return { result: `Path escapes workspace: ${filePath}`, error: true };
    if (!await pathExists(resolved)) return { result: `File not found: ${filePath}`, error: true };

    try {
      const content = await readFile(resolved, "utf-8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        return { result: `old_string not found in ${filePath}`, error: true };
      }

      const replaceAll = args.replace_all === true;
      if (occurrences > 1 && !replaceAll) {
        return { result: `old_string found ${occurrences} times in ${filePath}. Use replace_all: true to replace all, or provide more context to make it unique.`, error: true };
      }

      const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
      await writeFile(resolved, updated, "utf-8");
      const replacements = replaceAll ? occurrences : 1;
      return { result: `File edited: ${filePath} (${replacements} replacement${replacements > 1 ? "s" : ""})` };
    } catch (err: any) {
      return { result: `Error editing file: ${err.message}`, error: true };
    }
  },

  async list_scratch(args) {
    const dirPath = args.path || ".";

    const resolved = resolveWorkspacePath(dirPath);
    if (!resolved) return { result: `Path escapes workspace: ${dirPath}`, error: true };
    if (!await pathExists(resolved)) return { result: `Directory not found: ${dirPath}`, error: true };

    try {
      const s = await stat(resolved);
      if (!s.isDirectory()) return { result: `Not a directory: ${dirPath}`, error: true };

      const entries = await readdir(resolved);
      const items = await Promise.all(entries.map(async name => {
        try {
          const s = await stat(join(resolved, name));
          const type = s.isDirectory() ? "dir" : "file";
          const size = s.isDirectory() ? "" : ` (${formatSize(s.size)})`;
          return `${type === "dir" ? "📁" : "📄"} ${name}${size}`;
        } catch {
          return `? ${name}`;
        }
      }));

      return { result: `${dirPath}/\n${items.join("\n")}` };
    } catch (err: any) {
      return { result: `Error listing directory: ${err.message}`, error: true };
    }
  },

  async read_docx(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const resolved = resolveWorkspacePath(filePath);
    if (!resolved) return { result: `Path escapes workspace: ${filePath}`, error: true };
    if (!await pathExists(resolved)) return { result: `File not found: ${filePath}`, error: true };

    try {
      const s = await stat(resolved);
      if (s.isDirectory()) return { result: `Path is a directory, not a file: ${filePath}`, error: true };

      const mode = args.mode || "text";

      if (mode === "rich" || mode === "annotated") {
        const { readDocxRich, formatRichContent } = await import("./docx-utils");
        const content = await readDocxRich(resolved);
        const formatted = formatRichContent(content, mode === "annotated" ? "annotated" : "structured");

        const summary: string[] = [];
        summary.push(`Document: ${filePath}`);
        if (content.comments.length > 0) summary.push(`Comments: ${content.comments.length}`);
        if (content.trackedChanges.length > 0) {
          const ins = content.trackedChanges.filter(c => c.type === "insertion").length;
          const del = content.trackedChanges.filter(c => c.type === "deletion").length;
          summary.push(`Tracked changes: ${ins} insertions, ${del} deletions`);
        }
        summary.push(`Paragraphs: ${content.paragraphs.length}`);

        return { result: `${summary.join(" | ")}\n\n${formatted}` };
      }

      const { readDocxRich } = await import("./docx-utils");
      const content = await readDocxRich(resolved);
      const text = content.paragraphs
        .map(p => p.runs.map(r => r.text).join(""))
        .join("\n");
      if (!text || text.trim().length === 0) {
        return { result: `Document is empty or contains no extractable text: ${filePath}` };
      }
      return { result: text };
    } catch (err: any) {
      if (err.message?.includes("Unrecognised") || err.message?.includes("not a zip") || err.message?.includes("Invalid") || err.message?.includes("not a valid zip")) {
        return { result: `File does not appear to be a valid .docx file: ${filePath}`, error: true };
      }
      return { result: `Error reading docx: ${err.message}`, error: true };
    }
  },

  async write_docx(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const content = args.content;
    if (content === undefined || content === null) return { result: "Missing content", error: true };

    const resolved = resolveWorkspacePath(filePath);
    if (!resolved) return { result: `Path escapes workspace: ${filePath}`, error: true };

    try {
      const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");

      const lines = content.split("\n");
      const children: (typeof Paragraph.prototype)[] = [];

      for (const line of lines) {
        if (line.startsWith("#### ")) {
          children.push(new Paragraph({ text: line.slice(5).trim(), heading: HeadingLevel.HEADING_4 }));
        } else if (line.startsWith("### ")) {
          children.push(new Paragraph({ text: line.slice(4).trim(), heading: HeadingLevel.HEADING_3 }));
        } else if (line.startsWith("## ")) {
          children.push(new Paragraph({ text: line.slice(3).trim(), heading: HeadingLevel.HEADING_2 }));
        } else if (line.startsWith("# ")) {
          children.push(new Paragraph({ text: line.slice(2).trim(), heading: HeadingLevel.HEADING_1 }));
        } else {
          children.push(new Paragraph({ children: [new TextRun(line)] }));
        }
      }

      const doc = new Document({ sections: [{ children }] });
      const buffer = await Packer.toBuffer(doc);

      const dir = join(resolved, "..");
      await mkdir(dir, { recursive: true });
      await writeFile(resolved, buffer);

      return { result: `Word document written: ${filePath} (${buffer.length} bytes, ${children.length} paragraphs)` };
    } catch (err: any) {
      return { result: `Error writing docx: ${err.message}`, error: true };
    }
  },

  async edit_docx(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const replacements = args.replacements;
    if (!replacements || !Array.isArray(replacements) || replacements.length === 0) {
      return { result: "Missing or empty replacements array", error: true };
    }

    const resolved = resolveWorkspacePath(filePath);
    if (!resolved) return { result: `Path escapes workspace: ${filePath}`, error: true };
    if (!await pathExists(resolved)) return { result: `Source file not found: ${filePath}`, error: true };

    const outputPath = args.output_path || filePath;
    const resolvedOutput = resolveWorkspacePath(outputPath);
    if (!resolvedOutput) return { result: `Output path escapes workspace: ${outputPath}`, error: true };

    try {
      const { editDocxInPlace } = await import("./docx-utils");
      const result = await editDocxInPlace(resolved, resolvedOutput, replacements);
      return {
        result: `Document edited: ${outputPath} (${result.replacementsMade} replacement${result.replacementsMade !== 1 ? "s" : ""} made, ${result.bytesWritten} bytes). All original formatting preserved.`,
      };
    } catch (err: any) {
      if (err.message?.includes("not a valid zip") || err.message?.includes("Corrupted")) {
        return { result: `File does not appear to be a valid .docx file: ${filePath}`, error: true };
      }
      return { result: `Error editing docx: ${err.message}`, error: true };
    }
  },

  async clone_docx(args) {
    const sourcePath = args.source_path;
    if (!sourcePath) return { result: "Missing source_path", error: true };

    const outputPath = args.output_path;
    if (!outputPath) return { result: "Missing output_path", error: true };

    const content = args.content;
    if (content === undefined || content === null) return { result: "Missing content", error: true };

    const resolvedSource = resolveWorkspacePath(sourcePath);
    if (!resolvedSource) return { result: `Source path escapes workspace: ${sourcePath}`, error: true };
    if (!await pathExists(resolvedSource)) return { result: `Source file not found: ${sourcePath}`, error: true };

    const resolvedOutput = resolveWorkspacePath(outputPath);
    if (!resolvedOutput) return { result: `Output path escapes workspace: ${outputPath}`, error: true };

    try {
      const { cloneDocxWithContent } = await import("./docx-utils");
      const result = await cloneDocxWithContent(resolvedSource, resolvedOutput, content);
      return {
        result: `Document created from template: ${outputPath} (${result.bytesWritten} bytes, ${result.paragraphsWritten} paragraphs). Styles, fonts, page layout, and theme from ${sourcePath} preserved.`,
      };
    } catch (err: any) {
      if (err.message?.includes("not a valid zip") || err.message?.includes("Corrupted")) {
        return { result: `Source file does not appear to be a valid .docx: ${sourcePath}`, error: true };
      }
      return { result: `Error cloning docx: ${err.message}`, error: true };
    }
  },

  async search_scratch(args) {
    const pattern = args.pattern;
    if (!pattern) return { result: "Missing search pattern", error: true };

    try {
      const results: string[] = [];
      const maxResults = args.limit || 50;

      const walkDir = async (dir: string, relBase: string) => {
        if (results.length >= maxResults) return;
        try {
          const entries = await readdir(dir);
          for (const entry of entries) {
            if (results.length >= maxResults) return;
            if (entry.startsWith(".") && entry !== ".") continue;
            const fullPath = join(dir, entry);
            const relPath = relBase ? `${relBase}/${entry}` : entry;
            try {
              const s = await stat(fullPath);
              if (s.isDirectory()) {
                if (entry === "node_modules" || entry === ".git") continue;
                await walkDir(fullPath, relPath);
              } else if (matchesGlob(entry, pattern) || matchesGlob(relPath, pattern)) {
                results.push(relPath);
              }
            } catch (err) { toolExec.warn("glob entry stat failed", err); }
          }
        } catch (err) { toolExec.warn("glob readdir failed", err); }
      }

      await walkDir(WORKSPACE_DIR, "");

      if (results.length === 0) return { result: `No files matching "${pattern}"` };
      return { result: `Found ${results.length} file${results.length > 1 ? "s" : ""}:\n${results.join("\n")}` };
    } catch (err: any) {
      return { result: `Error searching files: ${err.message}`, error: true };
    }
  },
};

const persistentFileTools: Record<string, ToolHandler> = {
  async write_file(args) {
    const fileName = args.fileName;
    if (!fileName) return { result: "Missing fileName", error: true };
    const content = args.content;
    if (content === undefined || content === null) return { result: "Missing file content", error: true };

    try {
      const { extname } = await import("path");

      const ext = extname(fileName).toLowerCase();
      const contentType = args.contentType || MIME_MAP[ext] || "application/octet-stream";

      const buffer = Buffer.from(content, "utf-8");
      const { objectPath } = await objectStorageService.uploadObjectEntity(buffer, {
        extension: ext || ".bin",
        contentType,
        acl: { owner: "system", visibility: "public" },
      });

      const encodedName = encodeURIComponent(fileName);
      const downloadLink = `${objectPath}?name=${encodedName}`;
      return { result: `File saved permanently: ${fileName} (${buffer.length} bytes)\nDownload: [${fileName}](${downloadLink})` };
    } catch (err: any) {
      return { result: `Error saving file: ${err.message}`, error: true };
    }
  },

  async read_file(args) {
    const filePath = args.filePath;
    if (!filePath) return { result: "Missing filePath (the /objects/... path from write_file)", error: true };

    try {
      const storageService = objectStorageService;

      const objectPath = filePath.startsWith("/objects/") ? filePath : `/objects/${filePath}`;
      const cleanPath = objectPath.split("?")[0];
      const objectFile = await storageService.getObjectEntityFile(cleanPath);
      const [buffer] = await objectFile.download();
      const content = buffer.toString("utf-8");

      const offset = typeof args?.offset === "number" && args.offset >= 0 ? args.offset : 0;
      const limit = typeof args?.limit === "number" && args.limit > 0 ? args.limit : undefined;
      if (offset > 0 || limit !== undefined) {
        const slice = limit !== undefined ? content.slice(offset, offset + limit) : content.slice(offset);
        return { result: `File content (offset=${offset}, showing ${slice.length} of ${content.length} chars):\n\n${slice}` };
      }
      if (content.length > 50000) {
        const { indexAndArchiveWithFallback } = await import("./content-indexer");
        const refBlock = await indexAndArchiveWithFallback({
          content,
          sourceType: "file",
          sourceLabel: filePath,
        });
        return { result: refBlock };
      }
      return { result: content };
    } catch (err: any) {
      return { result: `Error reading persistent file: ${err.message}`, error: true };
    }
  },

  async list_files(args) {
    try {
      const { storageBackend, PRIVATE_PREFIX } = await import("./object_storage");

      const { VAULT_PREFIX } = await import("./object_storage/vault-keys");
      const { getCurrentPrincipalOrSystem } = await import("./principal-context");

      const subPrefix = args.prefix || "uploads/";
      const legacyPrefix = `${PRIVATE_PREFIX}${subPrefix}`;
      const vaultId = getCurrentPrincipalOrSystem()?.activeVaultId;
      const vaultPrefix = vaultId ? `${VAULT_PREFIX}${vaultId}/${subPrefix}` : null;

      // Dual-read parity with getObjectEntityFile: vault-partitioned keys
      // first, then legacy private/ keys.
      const [vaultFiles, legacyFiles] = await Promise.all([
        vaultPrefix ? storageBackend.listObjects(vaultPrefix) : Promise.resolve([]),
        storageBackend.listObjects(legacyPrefix),
      ]);
      const entries = [
        ...vaultFiles.map(f => ({ f, prefix: vaultPrefix! })),
        ...legacyFiles.map(f => ({ f, prefix: legacyPrefix })),
      ];

      if (entries.length === 0) return { result: "No persistent files found." };

      const items = entries.map(({ f, prefix }) => {
        const name = f.key;
        const size = f.size ? `${Math.round(f.size / 1024)}KB` : "?";
        const relativeName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
        const downloadPath = `/objects/${subPrefix}${relativeName}`;
        const displayName = relativeName || name;
        const encodedName = encodeURIComponent(displayName);
        return `- ${displayName} (${size}) → [${displayName}](${downloadPath}?name=${encodedName})`;
      });

      return { result: `Persistent files (${entries.length}):\n${items.join("\n")}` };
    } catch (err: any) {
      return { result: `Error listing files: ${err.message}`, error: true };
    }
  },
};

const SHELL_DENYLIST = [
  /\brm\s+-[^\s]*r[^\s]*f\b/i,
  /\brm\s+-[^\s]*f[^\s]*r\b/i,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bformat\s+(c:|\/dev\/)/i,
  /\bmkfs\b/i,
  /\bdd\s+.*\bof=\/dev\//i,
  />\s*\/dev\/(sda|hda|nvme|vda)/i,
  /\bshred\b/i,
  /\bfdisk\b/i,
];

// Task #1007 step 6: shell stdout/stderr stream to per-call temp files
// under WORKSPACE_DIR/.tmp/shell so the main heap never holds the full
// output. Threshold for triggering off-thread indexing matches the prior
// behaviour (>30 KB triggers the indexer; smaller is returned inline).
const SHELL_TMP_DIR = join(WORKSPACE_DIR, ".tmp", "shell");
const SHELL_INDEX_THRESHOLD_BYTES = 30_000;
const SHELL_INDEX_CHUNK_SIZE = 80_000;
let _shellTmpDirEnsured = false;
async function ensureShellTmpDir(): Promise<void> {
  if (_shellTmpDirEnsured) return;
  await mkdir(SHELL_TMP_DIR, { recursive: true });
  _shellTmpDirEnsured = true;
}

function newShellCallId(): string {
  return `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shellCmdPreview(cmd: string, max = 200): string {
  // Strict ≤max output — slice to max-1 before appending the single-char
  // ellipsis so a "max=120" preview never produces a 121-char string.
  const trimmed = cmd.length > max ? cmd.slice(0, max - 1) + "…" : cmd;
  return JSON.stringify(trimmed);
}

// Task #1007 step 7: run the indexer's CPU/string-heavy prep work in a
// worker thread, then do the network/DB I/O on main with a small payload.
// The worker resolves the temp file's path itself and never sends the
// full content back to main.
async function runShellIndexWorker(filePath: string): Promise<{ ok: true; byteCount: number; headChunk: string; totalChars: number } | { ok: false; error: string }> {
  const path = await import("path");
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const { Worker } = await import("worker_threads");
  // Resolve worker artifact relative to *this* module's dir, the same
  // way heartbeat-worker is resolved in server/index.ts. In dev (tsx)
  // the .ts source is loaded directly; in prod the bundle ships
  // dist/shell-index-worker.mjs (see script/build.ts). Use
  // fileURLToPath rather than URL.pathname so encoded characters and
  // non-Linux path conventions decode correctly.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tsPath = path.join(here, "shell-index-worker.ts");
  const mjsPath = path.join(here, "shell-index-worker.mjs");
  const jsPath = path.join(here, "shell-index-worker.js");
  let workerPath: string | null = null;
  if (fs.existsSync(tsPath)) workerPath = tsPath;
  else if (fs.existsSync(mjsPath)) workerPath = mjsPath;
  else if (fs.existsSync(jsPath)) workerPath = jsPath;
  if (!workerPath) {
    return { ok: false, error: `shell-index-worker artifact not found in ${here}` };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (r: { ok: true; byteCount: number; headChunk: string; totalChars: number } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const worker = new Worker(workerPath!, {
        workerData: { filePath, indexChunkSize: SHELL_INDEX_CHUNK_SIZE },
      });
      worker.once("message", (msg: any) => {
        if (msg && msg.ok === true && typeof msg.headChunk === "string") {
          settle({ ok: true, byteCount: Number(msg.byteCount) || 0, headChunk: msg.headChunk, totalChars: Number(msg.totalChars) || 0 });
        } else {
          settle({ ok: false, error: String(msg?.error || "unknown worker error") });
        }
      });
      worker.once("error", (err) => {
        settle({ ok: false, error: `worker_error:${err?.message || String(err)}` });
      });
      worker.once("exit", (code) => {
        if (code !== 0) settle({ ok: false, error: `worker_exit:${code}` });
      });
    } catch (err: any) {
      settle({ ok: false, error: `worker_spawn_failed:${err?.message || String(err)}` });
    }
  });
}


function formatContextHealthNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatContextHealthLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function formatContextHealthSummary(summary: import("@shared/context-health").ContextHealthSummary): string {
  return JSON.stringify({
    generatedAt: summary.generatedAt,
    windowHours: summary.windowHours,
    rowLimit: summary.rowLimit,
    scope: summary.measurementContract.scope,
    source: summary.measurementContract.source,
    comparablePopulation: summary.measurementContract.comparablePopulation,
    contextTokenDefinition: summary.measurementContract.contextTokenDefinition,
    budgetContract: summary.measurementContract.budgets,
    rows: {
      total: summary.callCount,
      comparable: summary.comparableCallCount,
      excluded: summary.excludedCallCount,
      callsPerHour: summary.callsPerHour,
    },
    contextTokensComparableOnly: {
      average: summary.avgContextTokens,
      median: summary.medianContextTokens,
      p95: summary.p95ContextTokens,
      max: summary.maxContextTokens,
      display: `${formatContextHealthNumber(summary.medianContextTokens)} median / ${formatContextHealthNumber(summary.p95ContextTokens)} p95 / ${formatContextHealthNumber(summary.maxContextTokens)} max`,
      note: "Only per-call rows with known context windows and in-window context tokens are included. Non-comparable CLI cumulative counters are excluded and never reported as prompt/context size.",
      contextWindowSource: summary.measurementContract.contextWindowSource,
      distribution: summary.contextTokenDistribution,
    },
    exclusions: {
      contract: summary.measurementContract.exclusions,
      observed: summary.exclusionReasons.map((reason) => ({
        reason: formatContextHealthLabel(reason.reason),
        count: reason.count,
      })),
    },
    providerTtft: {
      sampleCount: summary.ttftSampleCount,
      averageMs: summary.avgTtftMs,
      p95Ms: summary.p95TtftMs,
      p95BudgetMs: summary.budgets.providerTtftP95Ms,
    },
    outcomes: {
      success: summary.successCount,
      error: summary.errorCount,
      aborted: summary.abortedCount,
      partial: summary.partialCount,
      errorRate: summary.errorRate,
    },
    providerCoverage: summary.byProvider.map((row) => ({
      provider: row.provider,
      rows: row.callCount,
      comparableRows: row.comparableCallCount,
      excludedRows: row.excludedCallCount,
      exclusions: row.exclusionReasons.map((reason) => ({ reason: formatContextHealthLabel(reason.reason), count: reason.count })),
    })),
    modelRows: summary.byModel.map((row) => ({
      provider: row.provider,
      model: row.model,
      tier: row.tier,
      usageSemantics: row.usageSemantics,
      contextWindow: row.contextWindow,
      contextWindowStatus: row.contextWindowStatus,
      exclusionReasons: row.exclusionReasons.map((reason) => ({ reason: formatContextHealthLabel(reason.reason), count: reason.count })),
      rows: row.callCount,
      comparableRows: row.comparableCallCount,
      excludedRows: row.excludedCallCount,
      contextTokensComparableOnly: {
        average: row.avgContextTokens,
        median: row.medianContextTokens,
        p95: row.p95ContextTokens,
        max: row.maxContextTokens,
      },
      avgTtftMs: row.avgTtftMs,
    })),
    raw: summary,
  });
}

const systemTools: Record<string, ToolHandler> = {
  async shell(args) {
    const command = args.command;
    if (!command) return { result: "Missing command", error: true };

    const timeoutMs = Math.min(args.timeout || 30000, 120000);

    const deniedPattern = SHELL_DENYLIST.find(pat => pat.test(command));
    if (deniedPattern) {
      eventBus.publish({
        category: "agent",
        event: "tool:shell_denied",
        payload: { command, reason: "destructive_pattern", pattern: deniedPattern.toString() },
      });
      return { result: `Shell command blocked: matches destructive-command denylist. Command requires explicit human confirmation before execution.`, error: true };
    }

    // Block shell-based git WRITE commands — read-only git via shell is allowed.
    const GIT_SHELL_PATTERN = /(?:^|&&|\|\||;|\n)\s*git\s/;
    const GIT_WRITE_SUBCOMMANDS = /\bgit\s+(push|commit|merge|rebase|reset|checkout\s+-b|checkout\s+--orphan|switch\s+-c|tag|stash|cherry-pick|pull|am|format-patch|init|clone|add|rm|mv|restore\s+--staged|bisect|clean|submodule|remote\s+(add|remove|rename|set-url))\b/;
    if (GIT_SHELL_PATTERN.test(command) && GIT_WRITE_SUBCOMMANDS.test(command)) {
      eventBus.publish({
        category: "agent",
        event: "tool:shell_denied",
        payload: { command, reason: "git_write_blocked" },
      });
      return { result: "Shell git write commands are blocked. Use the git MCP tool for write operations (clone, add, commit, push, create_pr, merge_pr) — it handles authentication and directory isolation. Shell git is allowed for read operations: status, log, diff, show, branch.", error: true };
    }

    eventBus.publish({
      category: "agent",
      event: "tool:shell_exec",
      payload: { command, timeoutMs },
    });

    // Task #1007 steps 3 + 6: every shell call emits three structured log
    // lines (dispatch, spawned, exit) and streams stdout/stderr to per-
    // call temp files instead of buffering 1 MB on the main heap. A
    // wedged shell tool now produces dispatch + spawned without an exit
    // line, so operators can identify the wedged command + pid from
    // logs alone (the gap that hid the bootId=molg5r37-3wwh wedge).
    const callId = newShellCallId();
    const startedAt = Date.now();
    await ensureShellTmpDir();
    const stdoutPath = join(SHELL_TMP_DIR, `${callId}.out`);
    const stderrPath = join(SHELL_TMP_DIR, `${callId}.err`);

    const fs = await import("fs");
    const fsp = await import("fs/promises");
    const { spawn } = await import("child_process");

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutStream = fs.createWriteStream(stdoutPath);
    const stderrStream = fs.createWriteStream(stderrPath);
    // Late writes after .end() are theoretically prevented by the
    // child.on("close") finalize trigger below, but in case any
    // straggling chunk does land we swallow the EPIPE / "write after
    // end" rather than letting it propagate as an uncaughtException.
    stdoutStream.on("error", (err: any) => toolExec.log(`[Shell] stdout write error callId=${callId} ${err?.message || err}`));
    stderrStream.on("error", (err: any) => toolExec.log(`[Shell] stderr write error callId=${callId} ${err?.message || err}`));

    toolExec.log(`[Shell] dispatch callId=${callId} cmd=${shellCmdPreview(command, 200)} cwd=${WORKSPACE_DIR} timeoutMs=${timeoutMs}`);

    return await new Promise<{ result: string; error?: boolean }>((resolveResult) => {
      let settled = false;
      let timedOut = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let child: import("child_process").ChildProcessWithoutNullStreams;
      try {
        child = spawn("/bin/sh", ["-c", command], {
          cwd: WORKSPACE_DIR,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        toolExec.log(`[Shell] exit callId=${callId} pid=- exitCode=- signal=- stdoutBytes=0 stderrBytes=0 elapsedMs=${Date.now() - startedAt} spawnError=${err?.message || String(err)}`);
        try { stdoutStream.end(); } catch {}
        try { stderrStream.end(); } catch {}
        fsp.unlink(stdoutPath).catch(() => {});
        fsp.unlink(stderrPath).catch(() => {});
        resolveResult({ result: `Shell spawn failed: ${err?.message || String(err)}`, error: true });
        return;
      }

      const pid = child.pid;
      toolExec.log(`[Shell] spawned callId=${callId} pid=${pid} cmd=${shellCmdPreview(command, 120)}`);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        stdoutStream.write(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderrStream.write(chunk);
      });

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch {}
      }, timeoutMs);

      const finalize = async (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }

        // Wait for both write streams to finish flushing so byte counts
        // and disk content are coherent before we read them back.
        await Promise.all([
          new Promise<void>((r) => stdoutStream.end(() => r())),
          new Promise<void>((r) => stderrStream.end(() => r())),
        ]);

        const elapsedMs = Date.now() - startedAt;
        toolExec.log(`[Shell] exit callId=${callId} pid=${pid} exitCode=${exitCode} signal=${signal ?? "null"} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes} elapsedMs=${elapsedMs}${timedOut ? " timedOut=true" : ""}`);

        try {
          // Failure path: timeout or non-zero exit. Mirror the previous
          // contract — return a concatenated stdout+stderr with a
          // header. For these we read both files (failure paths are
          // typically small) and unlink at the end.
          if (timedOut) {
            const [stdoutText, stderrText] = await Promise.all([
              fsp.readFile(stdoutPath, "utf-8").catch(() => ""),
              fsp.readFile(stderrPath, "utf-8").catch(() => ""),
            ]);
            const output = [stdoutText.trim(), stderrText.trim()].filter(Boolean).join("\n");
            resolveResult({ result: `Command timed out after ${timeoutMs}ms\n${output}`.trim(), error: true });
            return;
          }
          if (exitCode !== 0) {
            const [stdoutText, stderrText] = await Promise.all([
              fsp.readFile(stdoutPath, "utf-8").catch(() => ""),
              fsp.readFile(stderrPath, "utf-8").catch(() => ""),
            ]);
            const output = [stdoutText.trim(), stderrText.trim()].filter(Boolean).join("\n");
            resolveResult({ result: `Command failed (exit ${exitCode ?? "?"})\n${output || ""}`.trim() || `Command failed (exit ${exitCode ?? "?"})`, error: true });
            return;
          }

          // Success path. Stay off the main heap whenever the output
          // is large: route to the worker for read+trim+slice, then
          // archive via the streaming indexer. Below threshold, read
          // back inline (small payload — a few tens of KB at most).
          if (stdoutBytes > SHELL_INDEX_THRESHOLD_BYTES) {
            const workerResult = await runShellIndexWorker(stdoutPath);
            if (workerResult.ok) {
              const { indexAndArchiveFromFileWithFallback } = await import("./content-indexer");
              const refBlock = await indexAndArchiveFromFileWithFallback({
                filePath: stdoutPath,
                sourceType: "shell",
                sourceLabel: command.slice(0, 200),
                byteCount: workerResult.byteCount,
                headChunk: workerResult.headChunk,
                totalChars: workerResult.totalChars,
              });
              resolveResult({ result: refBlock });
              return;
            }
            // Worker failed — degrade gracefully by reading on main
            // (still better than wedging the call). This path is
            // exceptional; the warn surfaces it for diagnosis.
            toolExec.log(`[Shell] index worker failed callId=${callId} error=${workerResult.error} — falling back to main-thread indexing`);
            const stdoutText = await fsp.readFile(stdoutPath, "utf-8");
            const trimmed = stdoutText.trim();
            const { indexAndArchiveWithFallback } = await import("./content-indexer");
            const refBlock = await indexAndArchiveWithFallback({
              content: trimmed,
              sourceType: "shell",
              sourceLabel: command.slice(0, 200),
            });
            resolveResult({ result: refBlock });
            return;
          }

          const stdoutText = await fsp.readFile(stdoutPath, "utf-8");
          const trimmed = stdoutText.trim();
          resolveResult({ result: trimmed || "(no output)" });
        } catch (err: any) {
          resolveResult({ result: `Shell post-processing error: ${err?.message || String(err)}`, error: true });
        } finally {
          // Always unlink the temp files. Object storage upload (when
          // it happens) streams from disk inside indexAndArchiveFrom
          // FileWithFallback and completes before we get here, so it's
          // safe to delete now.
          fsp.unlink(stdoutPath).catch(() => {});
          fsp.unlink(stderrPath).catch(() => {});
        }
      };

      child.on("error", (err: any) => {
        toolExec.log(`[Shell] child error callId=${callId} pid=${pid} err=${err?.message || String(err)}`);
        // child.on("error") fires before "close" for spawn failures and
        // does not necessarily produce a close event afterwards.
        // Synthesize a finalize so we always emit one [Shell] exit line
        // and always release the temp files.
        void finalize(null, null);
      });
      // Use "close" rather than "exit" — Node fires "exit" the moment
      // the child process terminates, BEFORE the stdio "data" events
      // for any final chunks have been delivered. Finalizing on "exit"
      // races trailing output (truncated stdoutBytes / indexed
      // content) and risks "write after end" on the temp file streams.
      // "close" fires only after the process has ended AND its stdio
      // streams have been fully drained and closed, so byte counts
      // and on-disk content are coherent by the time finalize runs.
      child.on("close", (code, signal) => {
        void finalize(code, signal);
      });
    });
  },

  async indexed_content(args) {
    const action = args.action;
    if (!action) return { result: "Missing action. Available: list, get, read_section", error: true };

    try {
      const { db } = await import("./db");
      const { indexedContent } = await import("@shared/schema");
      const { desc, eq } = await import("drizzle-orm");
      const { getCurrentPrincipalOrSystem } = await import("./principal-context");
      const { combineWithSensitiveVisible } = await import("./sensitive-scope");
      const ownerColumns = {
        ownerUserId: indexedContent.ownerUserId,
        principalAccountId: indexedContent.principalAccountId,
        vaultId: indexedContent.vaultId,
      };
      const visible = (predicate?: SQL) =>
        combineWithSensitiveVisible(ownerColumns, predicate, getCurrentPrincipalOrSystem());

      switch (action) {
        case "list": {
          const limit = Math.min(args.limit || 20, 100);
          const predicate = args.sourceType
            ? eq(indexedContent.sourceType, args.sourceType)
            : undefined;
          const rows = await db.select({
            id: indexedContent.id,
            sourceType: indexedContent.sourceType,
            sourceLabel: indexedContent.sourceLabel,
            byteCount: indexedContent.byteCount,
            createdAt: indexedContent.createdAt,
          }).from(indexedContent)
            .where(visible(predicate))
            .orderBy(desc(indexedContent.createdAt))
            .limit(limit);
          if (rows.length === 0) return { result: "No indexed content found." };
          const lines = rows.map(r => `- [${r.id}] ${r.sourceType}: ${r.sourceLabel} (${r.byteCount.toLocaleString()} bytes, ${r.createdAt?.toISOString() || "unknown"})`);
          return { result: `${rows.length} indexed items:
${lines.join("\n")}` };
        }
        case "get": {
          const id = args.id;
          if (!id) return { result: "Missing id parameter", error: true };
          const rows = await db.select().from(indexedContent)
            .where(visible(eq(indexedContent.id, id)))
            .limit(1);
          if (rows.length === 0) return { result: `Indexed content "${id}" not found`, error: true };
          const row = rows[0];
          const idx = row.index as any;
          const parts: string[] = [];
          parts.push(`**${row.sourceType}: ${row.sourceLabel}**`);
          parts.push(`ID: ${row.id} | Size: ${row.byteCount.toLocaleString()} bytes | Created: ${row.createdAt?.toISOString() || "unknown"}`);
          if (idx?.keyFacts?.length > 0) {
            parts.push(`
**Key Facts:**`);
            for (const f of idx.keyFacts) parts.push(`- ${f}`);
          }
          if (idx?.sections?.length > 0) {
            parts.push(`
**Sections:**`);
            idx.sections.forEach((section: any, index: number) => {
              parts.push(`  ${index}. ${section.title} (offset: ${section.byteOffset}, length: ${section.byteLength})`);
              for (const fact of section.keyFacts || []) parts.push(`     - ${fact}`);
            });
          }
          if (idx?.identifiers?.length > 0) parts.push(`
**Identifiers:** ${idx.identifiers.join(", ")}`);
          return { result: parts.join("\n") };
        }
        case "read_section": {
          const id = args.id;
          if (!id) return { result: "Missing id parameter", error: true };
          const rows = await db.select().from(indexedContent)
            .where(visible(eq(indexedContent.id, id)))
            .limit(1);
          if (rows.length === 0) return { result: `Indexed content "${id}" not found`, error: true };
          const row = rows[0];
          let charOffset = args.charOffset as number | undefined;
          let charLength = args.charLength as number | undefined;
          if (args.sectionIndex !== undefined) {
            const idx = row.index as any;
            const section = idx?.sections?.[args.sectionIndex];
            if (!section) return { result: `Section index ${args.sectionIndex} not found (${idx?.sections?.length || 0} sections available)`, error: true };
            charOffset = section.byteOffset;
            charLength = section.byteLength;
          }
          const { readVisibleIndexedContent } = await import("./content-indexer");
          const archived = await readVisibleIndexedContent({ id, charOffset, charLength });
          if (!archived) return { result: `Failed to read indexed content "${id}"`, error: true };
          const content = archived.content;
          const maxDisplay = 50000;
          if (content.length > maxDisplay) {
            return { result: `Section content (${content.length} chars, showing first ${maxDisplay}):

${content.slice(0, maxDisplay)}

[Use charOffset/charLength for pagination — total section: ${content.length} chars]` };
          }
          return { result: content };
        }
        default:
          return { result: `Unknown action: ${action}. Available: list, get, read_section`, error: true };
      }
    } catch (err: any) {
      return { result: `indexed_content error: ${err.message}`, error: true };
    }
  },
};

const webTools: Record<string, ToolHandler> = {
  async web_search(args) {
    const query = args.query;
    if (!query) return { result: "Missing search query", error: true };

    const apiKey = getSecretSync("BRAVE_API_KEY") || getSecretSync("BRAVE_SEARCH_API_KEY");
    if (!apiKey) return { result: "Brave Search API key not configured (BRAVE_API_KEY)", error: true };

    try {
      const count = args.count || 10;
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
      const searchController = new AbortController();
      const searchTimeout = setTimeout(() => searchController.abort(), 15000);
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: searchController.signal,
      });
      clearTimeout(searchTimeout);

      if (!response.ok) {
        return { result: `Brave Search error: ${response.status} ${response.statusText}`, error: true };
      }

      const data = await response.json() as any;
      const results = (data.web?.results || []).slice(0, count);

      if (results.length === 0) return { result: `No results for "${query}"` };

      const lines = results.map((r: any, i: number) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || ""}`
      );
      return { result: `Search results for "${query}":\n\n${lines.join("\n\n")}` };
    } catch (err: any) {
      return { result: `Web search error: ${err.message}`, error: true };
    }
  },

  async web_fetch(args) {
    const url = args.url;
    if (!url) return { result: "Missing URL", error: true };

    try {
      // --- Smart URL Router: try domain-specific extraction first ---
      const { routeUrl } = await import("./url-routers");
      const routed = await routeUrl(url);
      if (routed) {
        const note = `[Fetched via ${routed.source}]\n\n`;
        const WEB_FETCH_SUMMARIZE_THRESHOLD = 10_000;
        if (routed.content.length <= WEB_FETCH_SUMMARIZE_THRESHOLD) {
          return { result: `${note}${routed.content}` };
        }
        const { indexAndArchiveWithFallback } = await import("./content-indexer");
        try {
          const refBlock = await indexAndArchiveWithFallback({
            content: routed.content,
            sourceType: "web_fetch",
            sourceLabel: url,
          });
          toolExec.log(`web_fetch: indexed ${routed.content.length} chars from ${routed.source} for ${url}`);
          return { result: `${note}${refBlock}` };
        } catch (indexErr: any) {
          toolExec.warn(`web_fetch: indexing routed content failed: ${indexErr.message}`);
          const { heuristicFallbackWithArchive } = await import("./content-indexer");
          const fallback = heuristicFallbackWithArchive(routed.content, indexErr.message);
          return { result: `${note}${fallback}` };
        }
      }
      // --- End Smart URL Router ---

      const REALISTIC_HEADERS: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      };

      const controller = new AbortController();
      const fetchTimer = setTimeout(() => controller.abort(), args.timeout || 15000);

      let response: Response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          headers: REALISTIC_HEADERS,
        });
      } finally {
        clearTimeout(fetchTimer);
      }

      const isBlockDetected = (status: number, body: string): boolean => {
        if (status === 403 || status === 429) return true;
        if (status === 503 && /cloudflare|challenge/i.test(body)) return true;
        const trimmed = body.trim();
        if (trimmed.length === 0 && status >= 400) return true;
        if (trimmed.length < 500 && /access denied|blocked|forbidden/i.test(trimmed)) return true;
        if (/cf-browser-verification|cf-challenge|akamai.*bot/i.test(body)) return true;
        return false;
      };

      const isBlockPage = (body: string): boolean => {
        const trimmed = body.trim();
        if (trimmed.length === 0) return true;
        if (trimmed.length < 500 && /access denied|blocked|forbidden/i.test(trimmed)) return true;
        if (/cf-browser-verification|cf-challenge|akamai.*bot/i.test(body)) return true;
        return false;
      };

      const MAX_BROWSER_TIMEOUT_MS = 30_000;

      let rawText: string;
      let usedBrowser = false;
      let browserWarmUp = false;

      const retryWithBrowser = async (reason: string): Promise<string> => {
        toolExec.log(`web_fetch: ${reason} for ${url}, retrying with headless browser`);
        const browserMgr = await import("./browser-manager");
        const needsLaunch = !browserMgr.isBrowserReady();
        if (needsLaunch) {
          toolExec.log("web_fetch: browser is being launched for this fetch, this may take a moment...");
          browserWarmUp = true;
        }
        const browserTimeout = Math.min(args.timeout || MAX_BROWSER_TIMEOUT_MS, MAX_BROWSER_TIMEOUT_MS);
        const html = await browserMgr.fetchWithBrowser(url, browserTimeout);
        usedBrowser = true;
        return stripHtml(html);
      };

      if (!response.ok) {
        const bodySnippet = await response.text().catch(() => "");
        if (isBlockDetected(response.status, bodySnippet)) {
          rawText = await retryWithBrowser(`blocked by ${response.status}`);
        } else {
          return { result: `Fetch error: ${response.status} ${response.statusText}`, error: true };
        }
      } else {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const json = await response.json();
          rawText = JSON.stringify(json, null, 2);
        } else {
          const bodyText = await response.text();
          if (isBlockPage(bodyText)) {
            rawText = await retryWithBrowser("block page detected in body");
          } else {
            const stripped = stripHtml(bodyText);
            // JS-wall detection: try Jina Reader before browser fallback
            const { isJsWallPage } = await import("./url-routers");
            if (isJsWallPage(bodyText) || (stripped.trim().length < 200 && isJsWallPage(bodyText + stripped))) {
              toolExec.log(`web_fetch: JS-wall detected for ${url}, trying Jina Reader`);
              const { fetchViaJinaReader } = await import("./url-routers");
              const jinaResult = await fetchViaJinaReader(url);
              if (jinaResult) {
                const note = `[Fetched via ${jinaResult.source}]\n\n`;
                const WEB_FETCH_SUMMARIZE_THRESHOLD = 10_000;
                if (jinaResult.content.length <= WEB_FETCH_SUMMARIZE_THRESHOLD) {
                  return { result: `${note}${jinaResult.content}` };
                }
                const { indexAndArchiveWithFallback } = await import("./content-indexer");
                const refBlock = await indexAndArchiveWithFallback({
                  content: jinaResult.content,
                  sourceType: "web_fetch",
                  sourceLabel: url,
                });
                return { result: `${note}${refBlock}` };
              }
              // Jina failed — fall through to browser
              rawText = await retryWithBrowser("JS-wall and Jina failed");
            } else {
              rawText = stripped;
            }
          }
        }
      }

      if (usedBrowser) {
        toolExec.log(`web_fetch: successfully fetched ${url} via headless browser (${rawText.length} chars)`);
      }

      const browserNote = browserWarmUp
        ? "[Note: headless browser was launched for this fetch — initial launch added a brief delay.]\n\n"
        : usedBrowser
          ? "[Note: content was fetched via headless browser due to bot protection on this site.]\n\n"
          : "";

      const WEB_FETCH_SUMMARIZE_THRESHOLD = 10_000;

      if (rawText.length <= WEB_FETCH_SUMMARIZE_THRESHOLD) {
        return { result: `${browserNote}${rawText}` };
      }

      const { indexAndArchiveWithFallback } = await import("./content-indexer");

      try {
        const refBlock = await indexAndArchiveWithFallback({
          content: rawText,
          sourceType: "web_fetch",
          sourceLabel: url,
        });

        toolExec.log(`web_fetch: indexed ${rawText.length} chars for ${url}`);
        return { result: `${browserNote}${refBlock}` };
      } catch (indexErr: any) {
        toolExec.warn(`web_fetch: indexing failed, using fallback: ${indexErr.message}`);
        const { heuristicFallbackWithArchive } = await import("./content-indexer");
        const fallback = heuristicFallbackWithArchive(rawText, indexErr.message);
        return { result: `${browserNote}${fallback}` };
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { result: `Fetch timed out for ${url}`, error: true };
      }
      return { result: `Fetch error: ${err.message}`, error: true };
    }
  },

  async web_test(args) {
    const route = args.route as string | undefined;
    const url = args.url as string | undefined;
    const viewport = args.viewport as string | undefined;
    const fullPage = args.fullPage as boolean | undefined;
    const delay = args.delay as number | undefined;

    if (!route && !url) {
      return { result: "Either 'route' or 'url' is required for screenshot action", error: true };
    }

    let targetUrl: string;
    if (route) {
      const port = process.env.PORT || "5000";
      targetUrl = `http://localhost:${port}${route.startsWith("/") ? route : "/" + route}`;
    } else {
      targetUrl = url!;
    }

    try {
      const { screenshotPage } = await import("./browser-manager");
      const result = await screenshotPage(targetUrl, { viewport, fullPage, delay });

      // Persist to object storage through the canonical verified-write path.
      // Fail loudly if persistence cannot be verified so chat never embeds a
      // dead /objects/ path.
      const buffer = await readFile(result.path);
      const fileName = `screenshot-${Date.now()}.png`;
      let objectPath: string;
      try {
        ({ objectPath } = await objectStorageService.uploadObjectEntity(buffer, {
          extension: ".png",
          contentType: "image/png",
          acl: { owner: "system", visibility: "public" },
        }));
      } catch (persistErr: unknown) {
        const persistMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
        return {
          result: `Screenshot captured (${result.width}×${result.height}) but persisting to object storage failed: ${persistMsg}. Scratch copy at ${result.path}. Do not embed an /objects/ path for this capture.`,
          error: true,
        };
      }
      const downloadLink = `${objectPath}?name=${encodeURIComponent(fileName)}`;

      const truncNote = result.truncated ? " (truncated at 4000px height)" : "";
      return {
        result: `![screenshot ${result.width}×${result.height}](${downloadLink})\n[Download](${downloadLink})${truncNote}`,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Screenshot failed: ${msg}`, error: true };
    }
  },
};
// Deprecated alias — backward compat
webTools.web_screenshot = webTools.web_test;

const memoryTools: Record<string, ToolHandler> = {
  async memory_read(args) {
    const file = args.file;
    if (!file) return { result: "Missing file name. Available: PRINCIPLES.md, or any workspace file. Identity and user context are in your context spine.", error: true };

    try {
      const { documentStorage } = await import("./memory/document-storage");

      const baseName = file.replace(/^\/+/, "");
      const isIdentity = /^(SOUL|USER|PRINCIPLES|TOOLS|SKILL|AGENTS)\.md$/i.test(baseName);

      if (isIdentity) {
        const docId = baseName.replace(/\.md$/i, "").toLowerCase();
        const doc = await documentStorage.getDocument("identity", docId);
        if (doc) return { result: doc.content };
      }

      const docByPath = await documentStorage.getDocumentByPath(baseName);
      if (docByPath) return { result: docByPath.content };

      const parts = baseName.split("/");
      if (parts.length >= 2) {
        const docType = parts[0].replace(/s$/, "");
        const docId = parts.slice(1).join("/").replace(/\.(md|json|yaml)$/, "");
        const doc = await documentStorage.getDocument(docType, docId);
        if (doc) return { result: doc.content };
      }

      return { result: `File not found in workspace: ${file}`, error: true };
    } catch (err: any) {
      return { result: `Error reading ${file}: ${err.message}`, error: true };
    }
  },

  async memory_write(args) {
    const file = args.file;
    if (!file) return { result: "Missing file name", error: true };

    const content = args.content;
    if (content === undefined || content === null) return { result: "Missing content", error: true };

    try {
      const { documentStorage } = await import("./memory/document-storage");

      const baseName = file.replace(/^\/+/, "");
      const isIdentity = /^(SOUL|USER|PRINCIPLES|TOOLS|SKILL|AGENTS)\.md$/i.test(baseName);
      const docType = isIdentity ? "identity" : "file";
      const docId = baseName;

      if (args.append) {
        const existing = await documentStorage.getDocumentByPath(baseName);
        if (existing) {
          const merged = existing.content + "\n" + content;
          await documentStorage.upsertDocument(docType, docId, baseName, baseName, merged, {});
          return { result: `Appended to ${file}` };
        }
      }

      await documentStorage.upsertDocument(docType, docId, baseName, baseName, content, {});
      return { result: `Written to ${file} (${content.length} bytes)` };
    } catch (err: any) {
      return { result: `Error writing ${file}: ${err.message}`, error: true };
    }
  },

  async memory_read_entry(args) {
    const id = typeof args.id === "number" ? args.id : parseInt(args.id, 10);
    if (isNaN(id)) return { result: "Missing or invalid vNEXT claim ID. Provide a numeric ID from memory.search results.", error: true };

    try {
      const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
      const detail = await memoryVnextClaimStorage.getClaimDetail(id);
      if (!detail) return { result: `vNEXT claim #${id} not found`, error: true };
      await memoryVnextClaimStorage.reinforceClaim(id);
      const claim = detail.claim;
      const metadata = [
        `ID: ${claim.id}`,
        `Storage: memory_vnext_claims`,
        `Lifecycle: ${claim.lifecycleStage}`,
        `Claim type: ${claim.claimType}`,
        `Confidence: ${claim.confidence.toFixed(2)}`,
        `Source: ${claim.source}`,
        claim.sourceId ? `Source ID: ${claim.sourceId}` : "",
        claim.title ? `Title: ${claim.title}` : "",
        `Created: ${claim.createdAt.toISOString().slice(0, 16)}`,
        claim.topics?.length ? `Topics: ${claim.topics.join(", ")}` : "",
      ].filter(Boolean).join("\n");
      const sources = detail.sources.length > 0
        ? `\n\nSources:\n${detail.sources.map((source) => `- ${source.sourceType}/${source.sourceId} (${source.relationship}, strength ${source.strength.toFixed(2)})${source.quote ? `: ${source.quote}` : ""}`).join("\n")}`
        : "";
      const links = detail.claimLinks.length > 0
        ? `\n\nClaim links:\n${detail.claimLinks.map((link) => `- #${link.fromClaimId === id ? link.toClaimId : link.fromClaimId} (${link.relationship}, strength ${link.strength.toFixed(2)})`).join("\n")}`
        : "";
      return { result: `${metadata}\n\n--- Claim ---\n${claim.content}${sources}${links}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `Error reading vNEXT claim #${id}: ${message}`, error: true };
    }
  },

  async memory_search(args) {
    const query = args.query;
    if (!query || typeof query !== "string") return { result: "Missing query string", error: true };

    try {
      const unsupported = [
        ["layer", args.layer],
        ["integrationStage", args.integrationStage],
        ["hasSummary", args.hasSummary],
        ["hasDeletionScheduled", args.hasDeletionScheduled],
        ["deletionExpired", args.deletionExpired],
      ].filter(([, value]) => value !== undefined).map(([name]) => name);
      if (unsupported.length > 0) {
        return { result: `Legacy-only memory.search filters are retired: ${unsupported.join(", ")}. Search vNEXT claims with source, dates, links, recall count, title, lifecycle, and content length filters.`, error: true };
      }
      const options: VnextSearchOptions = {
        query,
        limit: typeof args.limit === "number" ? Math.min(args.limit, 100) : 20,
        offset: typeof args.offset === "number" ? Math.max(args.offset, 0) : 0,
        source: typeof args.source === "string" ? args.source : undefined,
        claimType: typeof args.claimType === "string" ? args.claimType : undefined,
        lifecycleStage: typeof args.lifecycleStage === "string" ? args.lifecycleStage : undefined,
        startDate: typeof args.startDate === "string" ? args.startDate : undefined,
        endDate: typeof args.endDate === "string" ? args.endDate : undefined,
        timezone: typeof args.timezone === "string" ? args.timezone : undefined,
        minLinks: args.minLinks !== undefined ? Number(args.minLinks) : undefined,
        maxLinks: args.maxLinks !== undefined ? Number(args.maxLinks) : undefined,
        minContentLength: args.minContentLength !== undefined ? Number(args.minContentLength) : undefined,
        maxContentLength: args.maxContentLength !== undefined ? Number(args.maxContentLength) : undefined,
        recalledBefore: typeof args.recalledBefore === "string" ? args.recalledBefore : undefined,
        recalledAfter: typeof args.recalledAfter === "string" ? args.recalledAfter : undefined,
        minRecallCount: args.minRecallCount !== undefined ? Number(args.minRecallCount) : undefined,
        maxRecallCount: args.maxRecallCount !== undefined ? Number(args.maxRecallCount) : undefined,
        hasTitle: args.hasTitle !== undefined ? Boolean(args.hasTitle) : undefined,
        createdBefore: typeof args.createdBefore === "string" ? args.createdBefore : undefined,
        createdAfter: typeof args.createdAfter === "string" ? args.createdAfter : undefined,
        updatedBefore: typeof args.updatedBefore === "string" ? args.updatedBefore : undefined,
        updatedAfter: typeof args.updatedAfter === "string" ? args.updatedAfter : undefined,
        sortBy: ["createdAt", "contentLength", "linkCount", "recallCount"].includes(String(args.sortBy))
          ? args.sortBy as VnextSearchOptions["sortBy"]
          : undefined,
        sortOrder: args.sortOrder === "asc" || args.sortOrder === "desc" ? args.sortOrder : undefined,
      };
      const response = await searchVnextMemory(options);
      if (response.results.length === 0) return { result: `No vNEXT claims found for "${query}"` };

      const formatted = response.results.map((result, index) => {
        const claim = result.claim;
        const meta = [
          `id=${claim.id}`,
          `storage=vnext`,
          `stage=${claim.lifecycleStage}`,
          `type=${claim.claimType}`,
          `source=${claim.source}`,
          `score=${result.score.toFixed(3)}`,
          `emb=${result.embeddingSimilarity.toFixed(3)}`,
          `links=${result.linkCount}`,
          `recalls=${claim.recallCount}`,
        ];
        const date = claim.createdAt ? new Date(claim.createdAt).toISOString().slice(0, 16) : "";
        const title = claim.title ? `"${claim.title}"` : "";
        const preview = claim.content.length > 500 ? `${claim.content.slice(0, 500)}...` : claim.content;
        return `[${index + 1}] (${meta.join(", ")}) ${date} ${title}\n${preview}`;
      }).join("\n\n");
      return { result: `Found ${response.results.length} vNEXT claims for "${query}". Use memory.vnext_claim_detail(id) for full provenance and graph details.\n\n${formatted}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `vNEXT search error: ${message}`, error: true };
    }
  },
};


function retiredLegacyMemoryAction(action: string, replacement: string): ToolHandlerResult {
  return {
    result: JSON.stringify({
      status: "retired",
      action,
      storage: "memory_entries",
      message: `Legacy memory action "${action}" has been retired because memory_entries is archived and no longer a runtime read/write surface.`,
      migration: replacement,
    }),
    error: true,
  };
}

async function getMondayOfCurrentWeek(): Promise<string> {
  const { getDateInTimezone, getTimezone } = await import("./timezone");
  const today = getDateInTimezone(getTimezone());
  const d = new Date(today + "T12:00:00");
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
  const mm = String(monday.getMonth() + 1).padStart(2, "0");
  const dd = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${mm}-${dd}`;
}

async function getFirstOfCurrentMonth(): Promise<string> {
  const { getDateInTimezone, getTimezone } = await import("./timezone");
  const today = getDateInTimezone(getTimezone());
  const d = new Date(today + "T12:00:00");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-01`;
}

async function getTodayDate(): Promise<string> {
  const { getDateInTimezone, getTimezone } = await import("./timezone");
  return getDateInTimezone(getTimezone());
}

async function getTomorrowDate(): Promise<string> {
  const { getDateInTimezone, getTimezone } = await import("./timezone");
  const today = getDateInTimezone(getTimezone());
  const d = new Date(today + "T12:00:00");
  d.setDate(d.getDate() + 1);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function getMondayOfNextWeek(): Promise<string> {
  const { getDateInTimezone, getTimezone } = await import("./timezone");
  const today = getDateInTimezone(getTimezone());
  const d = new Date(today + "T12:00:00");
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff + 7);
  const mm = String(monday.getMonth() + 1).padStart(2, "0");
  const dd = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${mm}-${dd}`;
}

async function getFirstOfNextMonth(): Promise<string> {
  const { getDateInTimezone, getTimezone } = await import("./timezone");
  const today = getDateInTimezone(getTimezone());
  const d = new Date(today + "T12:00:00");
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  return `${next.getFullYear()}-${mm}-01`;
}

async function gitnexusBridgeCall<T>(fn: () => Promise<T>): Promise<{ ok: boolean; result?: T; error?: string }> {
  try {
    const { isGitNexusReady, getStatus } = await import("./gitnexus-bridge");
    const status = await getStatus();
    if (status.phase === "disabled") {
      return { ok: false, error: "GitNexus indexing is disabled for the current Platform environments. Use normal repo/file inspection instead, or enable code indexing on the relevant environment source binding." };
    }
    if (!isGitNexusReady()) {
      return { ok: false, error: status.message || "Index not ready — GitNexus is still indexing the codebase. Try again in a moment." };
    }
    const result = await fn();
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: err.message || "GitNexus call failed" };
  }
}

const codeIntelTools: Record<string, ToolHandler> = {
  async code_query(args) {
    const query = args.query;
    if (!query) return { result: "Missing query", error: true };

    const { searchCodebase } = await import("./gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => searchCodebase(query));
    if (!res.ok) return { result: res.error || "GitNexus query failed", error: true };

    const parsed = res.result;
    if (!parsed) return { result: "No results." };

    const lines: string[] = [];
    const procs: any[] = Array.isArray(parsed.processes) ? parsed.processes : [];
    const symbols: any[] = Array.isArray(parsed.process_symbols) ? parsed.process_symbols : [];
    const defs: any[] = Array.isArray(parsed.definitions) ? parsed.definitions : [];

    if (procs.length > 0) {
      lines.push(`**Processes (${procs.length}):**`);
      for (const p of procs) {
        lines.push(`- ${p.summary || p.label || p.id}${p.process_type ? ` [${p.process_type}]` : ""}${p.step_count != null ? `, ${p.step_count} steps` : ""}`);
      }
    }
    if (symbols.length > 0) {
      lines.push(`\n**Symbols (${symbols.length}):**`);
      for (const s of symbols) {
        let lineRange = "";
        if (s.startLine != null) {
          lineRange = s.endLine != null && s.endLine !== s.startLine
            ? ` line ${s.startLine}–${s.endLine}`
            : ` line ${s.startLine}`;
        }
        const loc = s.filePath ? ` — ${s.filePath}${lineRange}` : "";
        lines.push(`- [${s.type || "?"}] **${s.name}**${loc}`);
      }
    }
    if (defs.length > 0) {
      lines.push(`\n**Files & Definitions (${defs.length}):**`);
      for (const d of defs) {
        const loc = d.filePath ? ` — ${d.filePath}` : "";
        lines.push(`- [${d.type || "File"}] **${d.name || d.filePath}**${loc}`);
      }
    }
    if (lines.length === 0) {
      lines.push("No results found.");
    }
    return { result: lines.join("\n") };
  },

  async code_context(args) {
    const name = args.name;
    const uid = args.uid;
    if (!name && !uid) return { result: "Missing symbol name or uid", error: true };

    const params: Record<string, any> = {};
    if (name) params.name = name;
    if (uid) params.uid = uid;
    if (args.file) params.file_path = args.file;
    if (args.include_content != null) params.include_content = args.include_content;

    const { callTool } = await import("./gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => callTool("context", params));
    if (!res.ok) return { result: res.error || "GitNexus context lookup failed", error: true };
    return { result: typeof res.result === "string" ? res.result : "Symbol not found." };
  },

  async code_impact(args) {
    const target = args.target;
    if (!target) return { result: "Missing target symbol name", error: true };

    const params: Record<string, any> = { target, direction: args.direction || "upstream" };
    if (args.maxDepth != null) params.maxDepth = args.maxDepth;
    if (args.includeTests != null) params.includeTests = args.includeTests;
    if (args.minConfidence != null) params.minConfidence = args.minConfidence;

    const { callTool } = await import("./gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => callTool("impact", params));
    if (!res.ok) return { result: res.error || "GitNexus impact analysis failed", error: true };
    return { result: typeof res.result === "string" ? res.result : "No impact data." };
  },

  async code_changes(_args) {
    const { callTool } = await import("./gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => callTool("detect_changes", {}));
    if (!res.ok) return { result: res.error || "GitNexus change detection failed", error: true };
    return { result: typeof res.result === "string" ? res.result : "No changes detected." };
  },

  async code_architecture(_args) {
    const { getArchitectureOverview } = await import("./gitnexus-graph");
    const res = await gitnexusBridgeCall(() => getArchitectureOverview());
    if (!res.ok) return { result: res.error || "Architecture overview failed", error: true };
    return { result: JSON.stringify(res.result, null, 2) };
  },

  async code_modules(args) {
    const { getClusters, getClusterDetail } = await import("./gitnexus-graph");
    if (args.name) {
      const res = await gitnexusBridgeCall(() => getClusterDetail(args.name));
      if (!res.ok) return { result: res.error || "Module query failed", error: true };
      return { result: typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2) };
    }
    const res = await gitnexusBridgeCall(() => getClusters());
    if (!res.ok) return { result: res.error || "Module query failed", error: true };
    return { result: typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2) };
  },

  async code_flows(args) {
    const { getProcesses, getProcessDetail } = await import("./gitnexus-graph");
    if (args.name) {
      const res = await gitnexusBridgeCall(() => getProcessDetail(args.name));
      if (!res.ok) return { result: res.error || "Flow query failed", error: true };
      return { result: typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2) };
    }
    const res = await gitnexusBridgeCall(() => getProcesses());
    if (!res.ok) return { result: res.error || "Flow query failed", error: true };
    return { result: typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2) };
  },

  async code_rename(args) {
    const newName = args.new_name;
    if (!newName) return { result: "Missing new_name parameter", error: true };
    const params: Record<string, any> = { new_name: newName };
    if (args.symbol_name) params.symbol_name = args.symbol_name;
    if (args.symbol_uid) params.symbol_uid = args.symbol_uid;
    if (args.file_path) params.file_path = args.file_path;
    params.dry_run = args.dry_run !== false;
    const { callTool } = await import("./gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => callTool("rename", params));
    if (!res.ok) return { result: res.error || "Rename failed", error: true };
    return { result: typeof res.result === "string" ? res.result : "No rename results." };
  },

  async code_schema(_args) {
    const { getGraphSchema } = await import("./gitnexus-graph");
    const res = await gitnexusBridgeCall(() => getGraphSchema());
    if (!res.ok) return { result: res.error || "Schema retrieval failed", error: true };
    return { result: typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2) };
  },

  async code_cypher(args) {
    const query = args.query;
    if (!query) return { result: "Missing Cypher query", error: true };
    const { callTool } = await import("./gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => callTool("cypher", { query }));
    if (!res.ok) return { result: res.error || "Cypher query failed", error: true };
    return { result: typeof res.result === "string" ? res.result : "No results." };
  },
};

const phoneCallHandler: ToolHandler = async (args) => {
  try {
    const { prepareOutboundCall, confirmOutboundCall } = await import("./phone/outbound");
    if (args.action === "prepare") {
      if (!args.query) return { result: "Missing person name or ID", error: true };
      const pending = await prepareOutboundCall(String(args.query));
      return { result: JSON.stringify({ kind: "phone_call_confirmation", status: "awaiting_confirmation", confirmationToken: pending.token, personId: pending.personId, personName: pending.personName, phoneNumber: pending.phoneNumber, expiresAt: new Date(pending.expiresAt).toISOString() }) };
    }
    if (args.action === "confirm") {
      if (!args.confirmationToken) return { result: "Missing confirmation token", error: true };
      const call = await confirmOutboundCall(String(args.confirmationToken));
      return { result: JSON.stringify({ kind: "phone_call_status", status: call.status, callSid: call.callSid, sessionId: call.sessionId }) };
    }
    return { result: "Unknown phone_call action. Available: prepare, confirm", error: true };
  } catch (error) {
    return { result: `Phone call error: ${error instanceof Error ? error.message : String(error)}`, error: true };
  }
};

const umbrellaHandlers: Record<string, ToolHandler> = {
  async scratch(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, ToolHandler> = {
      read: workspaceTools.read_scratch,
      write: workspaceTools.write_scratch,
      edit: workspaceTools.edit_scratch,
      list: workspaceTools.list_scratch,
      search: workspaceTools.search_scratch,
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown scratch action: ${action}`, error: true };
    return handler(args);
  },
  async files(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, ToolHandler> = {
      write: persistentFileTools.write_file,
      read: persistentFileTools.read_file,
      list: persistentFileTools.list_files,
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown files action: ${action}`, error: true };
    const result = await handler(args);
    // Record session artifact link for writes
    if (action === "write" && !result.error && result.result) {
      const { recordSessionArtifact } = await import("./session-artifacts");
      // Extract the object path from the result text
      const pathMatch = result.result.match(/\(([/]objects\/[^\s)]+)/);
      const objectPath = pathMatch?.[1] || args.fileName;
      recordSessionArtifact(args._sessionId, "file", objectPath, { fileName: args.fileName, contentType: args.contentType });
    }
    return result;
  },
  async weather(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    try {
      const weatherMod = await import("./weather");
      const handlers: Record<string, (a: Record<string, any>) => Promise<string>> = {
        current: weatherMod.getCurrentWeather,
        forecast: weatherMod.getDailyForecast,
        hourly: weatherMod.getHourlyForecast,
        alerts: weatherMod.getAlerts,
        historical: weatherMod.getHistoricalWeather,
      };
      const handler = handlers[action];
      if (!handler) return { result: `Unknown weather action: ${action}`, error: true };
      const result = await handler(args);
      return { result };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Weather error: ${msg}`, error: true };
    }
  },
  async web(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, ToolHandler> = {
      search: webTools.web_search,
      fetch: webTools.web_fetch,
      test: webTools.web_test,
      screenshot: webTools.web_test, // deprecated alias
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown web action: ${action}`, error: true };
    return handler(args);
  },
  async memory(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, ToolHandler> = {
      read: memoryTools.memory_read,
      write: memoryTools.memory_write,
      read_entry: memoryTools.memory_read_entry,
      search: memoryTools.memory_search,
    };
    const handler = sub[action];
    if (handler) {
      const result = await handler(args);
      // Record session artifact link for memory file writes
      if (action === "write" && !result.error && args.file) {
        const { recordSessionArtifact } = await import("./session-artifacts");
        recordSessionArtifact(args._sessionId, "memory_entry", args.file, {});
      }
      return result;
    }
    if (action === "get") {
      args.action = "vnext_claim_detail";
      return bridgeHandlers.memory(args);
    }
    const retiredLegacyCrudActions: Record<string, string> = {
      create_link: "No faithful generic vNext equivalent exists for arbitrary memory_links writes. Use run_vnext_lifecycle to create source/entity/claim links, or use vnext_claim_detail to inspect existing graph provenance.",
      update_entry: "memory_entries updates are retired. vNext claims are extracted, sourced, linked, canonicalized, or retired through run_vnext_lifecycle; inspect them with vnext_claim_detail.",
      delete_entry: "memory_entries deletion is retired. Archived rows are preserved. For vNext, use lifecycle retirement through vNext maintenance rather than deleting source-backed claims.",
    };
    if (Object.prototype.hasOwnProperty.call(retiredLegacyCrudActions, action)) {
      return retiredLegacyMemoryAction(action, retiredLegacyCrudActions[action]);
    }
    const retiredLegacyMaintenanceActions = new Set([
      "consolidate_short",
      "integrate_mid_to_long",
      "run_myelination",
      "run_memory_decay",
      "run_memory_reinforcement",
      "run_nrem",
    ]);
    if (retiredLegacyMaintenanceActions.has(action)) {
      return {
        result: `Memory action "${action}" is retired. Legacy memory propagation and maintenance are disabled; use run_vnext_lifecycle, run_full_sleep_cycle, compute_gsi, or run_rem.`,
        error: true,
      };
    }

    const opsActions = new Set(["run_full_sleep_cycle", "compute_gsi", "run_rem"]);
    if (opsActions.has(action)) {
      const bridge = bridgeHandlers.memory_ops;
      if (bridge) return bridge(args);
      return { result: `memory_ops bridge handler not found`, error: true };
    }
    if (action === "link_entity") {
      const claimId = typeof args.id === "number" ? args.id : typeof args.claimId === "number" ? args.claimId : null;
      const entityType = args.entityType as string;
      const entityId = args.entityId as string;
      if (claimId === null) return { result: "Missing 'id' parameter (vNext claim ID)", error: true };
      if (!entityType) return { result: "Missing 'entityType' parameter", error: true };
      if (!entityId) return { result: "Missing 'entityId' parameter", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        await memoryVnextClaimStorage.linkClaimToEntity(claimId, entityType, entityId);
        return { result: JSON.stringify({ linked: true, storage: "memory_vnext_claims", claimId, entityType, entityId }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to link vNext claim entity: ${msg}`, error: true };
      }
    }
    if (action === "get_entity_links") {
      const claimId = typeof args.id === "number" ? args.id : typeof args.claimId === "number" ? args.claimId : null;
      if (claimId === null) return { result: "Missing 'id' parameter (vNext claim ID)", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const links = await memoryVnextClaimStorage.listEntityLinks(claimId);
        return { result: JSON.stringify({ storage: "memory_vnext_claims", claimId, total: links.length, links }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get vNext claim entity links: ${msg}`, error: true };
      }
    }
    if (action === "get_many") {
      const ids = args.ids;
      if (!ids || !Array.isArray(ids) || ids.length === 0) return { result: "Missing or empty 'ids' array", error: true };
      if (ids.length > 100) return { result: "Too many IDs — max 100 per call", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const numericIds = ids.map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id) && Number.isInteger(id));
        if (numericIds.length === 0) return { result: "No valid numeric vNext claim IDs provided", error: true };
        const details = await Promise.all(numericIds.map((id: number) => memoryVnextClaimStorage.getClaimDetail(id)));
        const claims = details.filter(Boolean).map((detail: any) => ({
          id: detail.claim.id,
          storage: "memory_vnext_claims",
          title: detail.claim.title || detail.claim.content,
          content: detail.claim.content,
          claimType: detail.claim.claimType,
          confidence: detail.claim.confidence,
          lifecycleStage: detail.claim.lifecycleStage,
          source: detail.claim.source,
          sourceId: detail.claim.sourceId,
          topics: detail.claim.topics || [],
          createdAt: detail.claim.createdAt?.toISOString?.() ?? null,
          sourceCount: detail.sources.length,
          entityLinkCount: detail.entityLinks.length,
          claimLinkCount: detail.claimLinks.length,
        }));
        return { result: JSON.stringify({ storage: "memory_vnext_claims", total: claims.length, requested: numericIds.length, claims }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get vNext claims: ${msg}`, error: true };
      }
    }
    if (action === "count") {
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const counts = await memoryVnextClaimStorage.getCounts();
        return { result: JSON.stringify({ storage: "memory_vnext_claims", ...counts }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to count vNext claims: ${msg}`, error: true };
      }
    }
    const retiredNoFaithfulEquivalent: Record<string, string> = {
      bulk_delete: "Legacy bulk deletion is retired and archived memory_entries are preserved. vNext claims should be retired by lifecycle policy rather than bulk-deleted through this tool.",
      find_duplicates: "Legacy duplicate cluster inspection is retired. vNext claim deduplication runs inside extraction and lifecycle maintenance; use search_claims/search plus vnext_claim_detail for inspection.",
    };
    if (Object.prototype.hasOwnProperty.call(retiredNoFaithfulEquivalent, action)) {
      return retiredLegacyMemoryAction(action, retiredNoFaithfulEquivalent[action]);
    }
    if (action === "list_sources") {
      const claimId = typeof args.memoryId === "number" ? args.memoryId : typeof args.id === "number" ? args.id : null;
      if (claimId === null) return { result: "Missing 'memoryId' or 'id' parameter (vNext claim ID)", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const sources = await memoryVnextClaimStorage.listSourceRefs(claimId);
        return { result: JSON.stringify({ storage: "memory_vnext_claims", claimId, total: sources.length, sources }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to list vNext claim sources: ${msg}`, error: true };
      }
    }
    if (action === "add_source") {
      const claimId = typeof args.memoryId === "number" ? args.memoryId : typeof args.id === "number" ? args.id : null;
      if (claimId === null) return { result: "Missing 'memoryId' or 'id' parameter (vNext claim ID)", error: true };
      if (typeof args.sourceType !== "string") return { result: "Missing 'sourceType' parameter (e.g. 'library', 'session', 'chat_journal')", error: true };
      if (typeof args.sourceId !== "string") return { result: "Missing 'sourceId' parameter", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const ref = await memoryVnextClaimStorage.addSourceRef(claimId, {
          sourceType: args.sourceType as string,
          sourceId: args.sourceId as string,
          relationship: (args.relationship as string) ?? "extracted_from",
          context: (args.context as string) ?? "",
          quote: (args.quote as string | null) ?? null,
          strength: typeof args.strength === "number" ? args.strength : 1,
        });
        return { result: JSON.stringify({ created: Boolean(ref), storage: "memory_vnext_claims", claimId, source: ref }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to add vNext claim source: ${msg}`, error: true };
      }
    }
    if (action === "delete_source") {
      const sourceRefId = typeof args.sourceRefId === "number" ? args.sourceRefId : (typeof args.id === "number" ? args.id : null);
      if (sourceRefId === null) return { result: "Missing 'sourceRefId' (or 'id') parameter", error: true };
      try {
        const { db } = await import("./db");
        const { memoryVnextSourceRefs } = await import("../shared/models/memory");
        const { eq } = await import("drizzle-orm");
        const { combineWithWritableScope } = await import("./scoped-storage");
        const { getCurrentPrincipalOrSystem } = await import("./principal-context");
        const deleted = await db.delete(memoryVnextSourceRefs).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), {
          scope: memoryVnextSourceRefs.scope,
          ownerUserId: memoryVnextSourceRefs.ownerUserId,
          accountId: memoryVnextSourceRefs.accountId,
        }, eq(memoryVnextSourceRefs.id, sourceRefId))).returning();
        if (deleted.length === 0) return { result: JSON.stringify({ deleted: false, storage: "memory_vnext_claims", reason: "not_found" }) };
        return { result: JSON.stringify({ deleted: true, storage: "memory_vnext_claims", id: sourceRefId }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to delete vNext claim source: ${msg}`, error: true };
      }
    }
    if (action === "run_vnext_lifecycle") {
      try {
        const { runVnextLifecycle } = await import("./memory/vnext-lifecycle");
        const { eventBus } = await import("./event-bus");
        const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 200) : undefined;
        const result = await runVnextLifecycle({ limit, trigger: "manual_tool" });
        eventBus.publish({
          category: "memory",
          event: "entries_changed",
          payload: { action: "vnext_lifecycle", storage: "memory_vnext_claims", ...result, level: result.errors > 0 ? "warn" : "info" },
        });
        toolExec.info(`[memory.vnext] lifecycle_run runId=${result.runId} scanned=${result.scanned} sourced=${result.sourced} linked=${result.linked} canonicalized=${result.canonicalized} retired=${result.retired} skipped=${result.skipped} errors=${result.errors}`);
        return { result: JSON.stringify({ triggered: true, storage: "memory_vnext_claims", ...result }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to run vNext lifecycle: ${msg}`, error: true };
      }
    }
    if (action === "vnext_claim_counts") {
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const counts = await memoryVnextClaimStorage.getCounts();
        toolExec.debug(`[memory.vnext] claim_counts total=${counts.total} sourceRefs=${counts.sourceRefs} entityLinks=${counts.entityLinks} claimLinks=${counts.claimLinks}`);
        return { result: JSON.stringify({ storage: "memory_vnext_claims", ...counts }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to count vNext claims: ${msg}`, error: true };
      }
    }
    if (action === "vnext_claim_detail") {
      const claimId = typeof args.id === "number" ? args.id : typeof args.claimId === "number" ? args.claimId : null;
      if (claimId === null) return { result: "Missing vNext claim id", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const detail = await memoryVnextClaimStorage.getClaimDetail(claimId);
        if (!detail) return { result: JSON.stringify({ found: false, storage: "memory_vnext_claims", id: claimId }) };
        const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
        return { result: JSON.stringify({
          found: true,
          storage: "memory_vnext_claims",
          claim: {
            ...detail.claim,
            lifecycleStageUpdatedAt: iso(detail.claim.lifecycleStageUpdatedAt),
            lastRecalledAt: iso(detail.claim.lastRecalledAt),
            createdAt: iso(detail.claim.createdAt),
            updatedAt: iso(detail.claim.updatedAt),
          },
          sources: detail.sources.map(r => ({ ...r, createdAt: iso(r.createdAt) })),
          entityLinks: detail.entityLinks.map(r => ({ ...r, createdAt: iso(r.createdAt) })),
          claimLinks: detail.claimLinks.map(r => ({ ...r, createdAt: iso(r.createdAt) })),
          lifecycle: {
            ...detail.lifecycle,
            stageUpdatedAt: iso(detail.lifecycle.stageUpdatedAt),
            lastRecalledAt: iso(detail.lifecycle.lastRecalledAt),
            createdAt: iso(detail.lifecycle.createdAt),
            updatedAt: iso(detail.lifecycle.updatedAt),
          },
        }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get vNext claim detail: ${msg}`, error: true };
      }
    }
    if (action === "search_claims") {
      try {
        if (args.storage === "legacy" || typeof args.integrationStage === "string") {
          return { result: "Legacy claim search has been retired. search_claims reads memory_vnext_claims only; use lifecycleStage instead of integrationStage.", error: true };
        }
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const limit = typeof args.limit === "number" ? Math.min(args.limit, 100) : 20;
        const offset = typeof args.offset === "number" ? Math.max(args.offset, 0) : 0;
        const rows = await memoryVnextClaimStorage.searchClaims({
          claimType: typeof args.claimType === "string" ? args.claimType : undefined,
          hasEntityLinks: typeof args.hasEntityLinks === "boolean" ? args.hasEntityLinks : undefined,
          entityId: typeof args.entityId === "string" ? args.entityId : undefined,
          createdAfter: typeof args.createdAfter === "string" ? args.createdAfter : undefined,
          createdBefore: typeof args.createdBefore === "string" ? args.createdBefore : undefined,
          lifecycleStage: typeof args.lifecycleStage === "string" ? args.lifecycleStage : undefined,
          limit,
          offset,
        });
        toolExec.debug(`[memory.vnext] search_claims count=${rows.length} offset=${offset} limit=${limit}`);
        return { result: JSON.stringify({
          total: rows.length,
          storage: "memory_vnext_claims",
          includeVnext: true,
          includeLegacy: false,
          claims: rows.map((claim) => ({
            id: claim.id,
            storage: "memory_vnext_claims",
            title: claim.title || claim.content,
            content: claim.content.slice(0, 500),
            claimType: claim.claimType,
            confidence: claim.confidence,
            extractedFrom: claim.sourceMemoryId ?? null,
            source: claim.source,
            sourceId: claim.sourceId,
            entityMentions: claim.entityMentions || [],
            lifecycleStage: claim.lifecycleStage,
            lifecycleStageUpdatedAt: claim.lifecycleStageUpdatedAt?.toISOString() ?? null,
            tags: claim.topics || [],
            createdAt: claim.createdAt?.toISOString() ?? null,
          })),
        }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to search vNEXT claims: ${msg}`, error: true };
      }
    }

    return { result: `Unknown memory action: ${action}`, error: true };
  },
  async settings(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };

    const ALLOWED_PREFIXES = ["memory.", "system.", "skill.", "hygiene."];

    try {
      const { getSetting, setSetting, deleteSetting } = await import("./system-settings");

      if (action === "get") {
        const key = args.key;
        if (!key) return { result: "Missing 'key' parameter", error: true };
        if (!ALLOWED_PREFIXES.some(p => key.startsWith(p))) {
          return { result: `Key "${key}" not allowed. Keys must start with one of: ${ALLOWED_PREFIXES.join(", ")}`, error: true };
        }
        const value = await getSetting(key);
        return { result: JSON.stringify({ key, value: value ?? null }) };
      }

      if (action === "set") {
        const key = args.key;
        if (!key) return { result: "Missing 'key' parameter", error: true };
        if (!ALLOWED_PREFIXES.some(p => key.startsWith(p))) {
          return { result: `Key "${key}" not allowed. Keys must start with one of: ${ALLOWED_PREFIXES.join(", ")}`, error: true };
        }
        if (args.value === undefined) return { result: "Missing 'value' parameter", error: true };
        await setSetting(key, args.value);
        return { result: JSON.stringify({ key, value: args.value, status: "saved" }) };
      }

      if (action === "delete") {
        const key = args.key;
        if (!key) return { result: "Missing 'key' parameter", error: true };
        if (!ALLOWED_PREFIXES.some(p => key.startsWith(p))) {
          return { result: `Key "${key}" not allowed. Keys must start with one of: ${ALLOWED_PREFIXES.join(", ")}`, error: true };
        }
        const deleted = await deleteSetting(key);
        return { result: JSON.stringify({ key, deleted }) };
      }

      return { result: `Unknown settings action: ${action}. Available: get, set, delete`, error: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Settings error: ${msg}`, error: true };
    }
  },
  async code(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, ToolHandler> = {
      query: codeIntelTools.code_query,
      context: codeIntelTools.code_context,
      impact: codeIntelTools.code_impact,
      changes: codeIntelTools.code_changes,
      architecture: codeIntelTools.code_architecture,
      modules: codeIntelTools.code_modules,
      flows: codeIntelTools.code_flows,
      rename: codeIntelTools.code_rename,
      schema: codeIntelTools.code_schema,
      cypher: codeIntelTools.code_cypher,
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown code action: ${action}`, error: true };
    return handler(args);
  },
  async docx(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, ToolHandler> = {
      read: workspaceTools.read_docx,
      write: workspaceTools.write_docx,
      edit: workspaceTools.edit_docx,
      clone: workspaceTools.clone_docx,
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown docx action: ${action}`, error: true };
    const result = await handler(args);
    // Record session artifact link for write/clone
    if ((action === "write" || action === "clone") && !result.error) {
      const { recordSessionArtifact } = await import("./session-artifacts");
      const docxPath = action === "write" ? args.path : (args.output_path || args.source_path);
      recordSessionArtifact(args._sessionId, "docx", docxPath, {});
    }
    return result;
  },
  async priorities(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };

    const migratedArtifactActions = new Set([
      "set_review",
      "set_daily_plan",
      "get_daily_artifacts",
      "set_weekly_reflection",
      "set_weekly_plan",
      "set_monthly_plan",
      "set_monthly_reflection",
      "set_quarterly_plan",
      "set_quarterly_reflection",
    ]);
    if (migratedArtifactActions.has(action)) {
      return bridgeHandlers.goals(args);
    }

    return {
      result: `priorities.${action} has been removed. Use goals for goal and priority operations; check-in artifact actions still redirect through this deprecated compatibility shim.`,
      error: true,
    };
  },
  async observe(args) {
    const type = args.type as string;
    if (!type || !["pattern", "gap", "change", "connection", "opportunity"].includes(type)) {
      return { result: "Invalid type — must be one of: pattern, gap, change, connection, opportunity", error: true };
    }
    const content = args.content as string;
    if (!content || content.trim().length === 0) {
      return { result: "Content is required and cannot be empty", error: true };
    }
    try {
      const { saveThought, makeThoughtHeader } = await import("./thoughts");
      const header = makeThoughtHeader(type);
      const thoughtText = `${header}\n${content}`;
      const thought = await saveThought(thoughtText, undefined, type);
      toolExec.log(`observe tool: saved observation id=${thought.id} type=${type}`);
      return { result: `Observation recorded (${type}): ${thought.id}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toolExec.error(`observe tool failed: ${msg}`);
      return { result: `Failed to save observation: ${msg}`, error: true };
    }
  },
  async system(args) {
    const action = args.action as string;
    if (!action) return { result: "Missing action parameter", error: true };
    if (action === "state") {
      const bridge = bridgeHandlers.get_system_state;
      if (bridge) return bridge(args);
      return { result: "get_system_state handler not found", error: true };
    }
    if (action === "create_issue") {
      const bridge = bridgeHandlers.create_issue;
      if (bridge) return bridge(args);
      return { result: "create_issue handler not found", error: true };
    }
    if (action === "get_issue") {
      const rawId = args.id;
      if (rawId === undefined || rawId === null || rawId === "") {
        return { result: "Missing issue id", error: true };
      }
      const idNum = typeof rawId === "number" ? rawId : Number(String(rawId).trim());
      if (!Number.isFinite(idNum) || !Number.isInteger(idNum) || idNum <= 0) {
        return { result: `Invalid issue id '${rawId}'; expected a positive integer`, error: true };
      }
      try {
        const { storage } = await import("./storage");
        const issue = await storage.getIssue(idNum);
        if (!issue) return { result: `Issue ${idNum} not found`, error: true };
        return { result: JSON.stringify(issue) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get issue ${idNum}: ${msg}`, error: true };
      }
    }
    if (action === "log_files") {
      try {
        const { listLogFiles } = await import("./log");
        const files = await listLogFiles();
        if (files.length === 0) {
          return { result: "No log files found." };
        }
        const lines = files.map(f => {
          const sizeKB = (f.size / 1024).toFixed(1);
          return `${f.filename}  (${sizeKB} KB, ${f.createdAt})`;
        });
        return { result: `${files.length} log file(s) available:\n${lines.join("\n")}\n\nUse the logs action with file parameter to read a specific file.` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to list log files: ${msg}`, error: true };
      }
    }
    if (action === "logs") {
      try {
        const { readLogFile, getCurrentLogFile, listLogFiles, resolveLogFilename } = await import("./log");
        const file = args.file ? resolveLogFilename(args.file as string) : getCurrentLogFile();
        const entries = await readLogFile(file, {
          limit: args.limit as number | undefined,
          level: args.level as string | undefined,
          source: args.source as string | undefined,
        });
        if (entries.length === 0) {
          const files = await listLogFiles();
          const fileList = files.slice(0, 5).map(f => f.filename).join(", ");
          return { result: `No log entries found matching the filters. Available log files: ${fileList || "none"}. Use log_files action to see all files, or logs action with file parameter to read a specific file.` };
        }
        const lines = entries.map(e => {
          const ts = e.ts.slice(11, 23);
          return `[${ts}] [${e.level.toUpperCase().padEnd(5)}] [${e.source}] ${e.message}`;
        });
        return { result: `${entries.length} log entries:\n${lines.join("\n")}` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to retrieve logs: ${msg}`, error: true };
      }
    }
    if (action === "budget") {
      return { result: JSON.stringify({ mode: "unlimited", budgetEnforced: false, message: "Skill budgets are disabled; usage is tracked for observability only." }) };
    }

    if (action === "frontend_performance") {
      try {
        const { requireCurrentUserPrincipal } = await import("./principal-context");
        const { getBrowserTelemetrySummary } = await import("./browser-telemetry-storage");
        const hoursRaw = args.hours === undefined ? 24 : Number(args.hours);
        const summary = await getBrowserTelemetrySummary(requireCurrentUserPrincipal(), Number.isFinite(hoursRaw) ? hoursRaw : 24);
        return { result: JSON.stringify(summary) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get frontend performance summary: ${msg}`, error: true };
      }
    }

    if (action === "context_health") {
      try {
        const { getCurrentPrincipalOrSystem } = await import("./principal-context");
        const { principalHasPermission } = await import("./permissions");
        const principal = getCurrentPrincipalOrSystem();
        if (!principalHasPermission(principal, "system:read")) {
          return { result: "Permission required: system:read", error: true };
        }
        const { getContextHealthSummary } = await import("./context-health-storage");
        const hoursRaw = args.hours === undefined ? 24 : Number(args.hours);
        const summary = await getContextHealthSummary(Number.isFinite(hoursRaw) ? hoursRaw : 24);
        return { result: formatContextHealthSummary(summary) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get context health summary: ${msg}`, error: true };
      }
    }
    if (action === "events") {
      try {
        const { getCurrentPrincipalOrSystem } = await import("./principal-context");
        const principal = getCurrentPrincipalOrSystem();
        const limit = (args.limit as number) || 100;
        let payloadQuery: Record<string, unknown> | undefined;
        if (args.payloadQuery) {
          payloadQuery = typeof args.payloadQuery === "string" ? JSON.parse(args.payloadQuery) : args.payloadQuery;
        }
        const result = eventBus.queryRecentEvents({
          limit,
          offset: (args.offset as number) || 0,
          principal,
          filter: {
            category: args.category as string | undefined,
            event: args.event as string | undefined,
            runId: args.runId as string | undefined,
            sessionKey: args.sessionKey as string | undefined,
            startTimestamp: args.startDate ? new Date(args.startDate as string).getTime() : undefined,
            endTimestamp: args.endDate ? new Date(args.endDate as string).getTime() : undefined,
            payloadQuery,
          },
        });
        return { result: JSON.stringify({ total: result.total, source: "in-memory", events: result.events.map(e => ({ id: e.id, timestamp: new Date(e.timestamp).toISOString(), category: e.category, event: e.event, runId: e.runId || null })) }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const { getCurrentPrincipalOrSystem } = await import("./principal-context");
        const fallbackEvents = eventBus.getRecentEvents((args.limit as number) || 100, {
          category: args.category as string | undefined,
          runId: args.runId as string | undefined,
          event: args.event as string | undefined,
        }, getCurrentPrincipalOrSystem());
        return { result: JSON.stringify({ total: fallbackEvents.length, source: "in-memory", events: fallbackEvents.map(e => ({ id: e.id, timestamp: new Date(e.timestamp).toISOString(), category: e.category, event: e.event, runId: e.runId || null })) }) };
      }
    }
    if (action === "active_runs") {
      try {
        const { getCurrentPrincipalOrSystem } = await import("./principal-context");
        const runs = eventBus.getActiveRuns(getCurrentPrincipalOrSystem());
        return { result: JSON.stringify({ total: runs.length, runs: runs.map(r => ({ runId: r.runId, startedAt: new Date(r.startedAt).toISOString(), events: r.events, lastEvent: r.lastEvent })) }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get active runs: ${msg}`, error: true };
      }
    }
    if (action === "clear_active_run") {
      try {
        const runId = String(args.runId || args.id || "").trim();
        if (!runId) return { result: "Missing runId parameter", error: true };
        const reason = String(args.reason || "manual_cleanup").trim() || "manual_cleanup";
        const { getCurrentPrincipalOrSystem } = await import("./principal-context");
        const result = eventBus.clearActiveRun(runId, reason, getCurrentPrincipalOrSystem());
        return { result: JSON.stringify(result), error: !result.cleared };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to clear active run: ${msg}`, error: true };
      }
    }
    if (action === "accounts") {
      try {
        const { listAccounts } = await import("./connected-accounts");
        const provider = args.provider as string | undefined;
        const accounts = await listAccounts(provider);
        return { result: JSON.stringify({ total: accounts.length, filters: { provider: provider || null }, accounts: accounts.map(a => ({ accountId: a.accountId, provider: a.provider, email: a.email || null, label: a.label || null, healthy: a.healthy ?? null })) }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to list accounts: ${msg}`, error: true };
      }
    }
    if (action === "tool_stats") {
      try {
        const { getToolStats } = await import("./file-storage/tool-stats");
        const stats = getToolStats();
        return { result: JSON.stringify({ total: stats.length, tools: stats }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get tool stats: ${msg}`, error: true };
      }
    }
    return { result: `Unknown system action: ${action}. Available: state, create_issue, get_issue, logs, log_files, budget, frontend_performance, context_health, events, active_runs, clear_active_run, accounts, tool_stats`, error: true };
  },
  async timers(args) {
    const action = args.action as string;
    if (!action) return { result: "Missing action parameter", error: true };
    try {
      const { timerStorage } = await import("./file-storage/timers");
      const { timerTypes } = await import("@shared/models/timers");
      type TimerType = typeof timerTypes[number];
      type Schedule = import("@shared/models/timers").Schedule;
      if (action === "list") {
        const name = (args.name as string | undefined)?.trim();
        const limit = Math.min((args.limit as number) || 100, 100);
        const timers = name ? await timerStorage.searchByName(name, limit) : await timerStorage.getAll();
        const items = name ? timers : timers.slice(0, limit);
        return { result: JSON.stringify({ total: timers.length, items }) };
      }
      if (action === "get") {
        const id = args.id as string;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const timer = await timerStorage.getByIdOrName(id);
        if (!timer) return { result: `Timer "${id}" not found.`, error: true };
        return { result: JSON.stringify(timer) };
      }
      if (action === "runs") {
        const id = args.id as string;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const limit = (args.limit as number) || 20;
        const runs = await timerStorage.getRuns(id, limit);
        return { result: JSON.stringify({ timerId: id, total: runs.length, items: runs }) };
      }
      if (action === "create") {
        const name = args.name as string;
        if (!name) return { result: "Missing 'name' parameter", error: true };
        const typeStr = args.type as string;
        if (!typeStr) return { result: "Missing 'type' parameter", error: true };
        if (!timerTypes.includes(typeStr as TimerType)) {
          return { result: `Invalid type "${typeStr}". Must be one of: ${timerTypes.join(", ")}`, error: true };
        }
        const timer = await timerStorage.create({
          name,
          description: (args.description as string) || "",
          type: typeStr as TimerType,
          prompt: (args.prompt as string) || "",
          skillId: args.skillId as string | undefined,
          schedules: (args.schedules as Schedule[]) || [],
          enabled: args.enabled !== undefined ? Boolean(args.enabled) : true,
          timezone: (args.timezone as string) || "America/New_York",
        });
        return { result: JSON.stringify(timer) };
      }
      if (action === "update") {
        const id = args.id as string;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const updates: Partial<Omit<import("@shared/models/timers").Timer, "id" | "createdAt">> = {};
        if (args.name !== undefined) updates.name = args.name as string;
        if (args.description !== undefined) updates.description = args.description as string;
        if (args.prompt !== undefined) updates.prompt = args.prompt as string;
        if (args.skillId !== undefined) updates.skillId = args.skillId as string;
        if (args.schedules !== undefined) updates.schedules = args.schedules as Schedule[];
        if (args.enabled !== undefined) updates.enabled = Boolean(args.enabled);
        if (args.timezone !== undefined) updates.timezone = args.timezone as string;
        const updated = await timerStorage.update(id, updates);
        if (!updated) return { result: `Timer "${id}" not found.`, error: true };
        return { result: JSON.stringify(updated) };
      }
      if (action === "delete") {
        const id = args.id as string;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const deleted = await timerStorage.delete(id);
        if (!deleted) return { result: `Timer "${id}" not found or already deleted.`, error: true };
        return { result: JSON.stringify({ deleted: true, id }) };
      }
      if (action === "trigger") {
        const id = args.id as string;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const timer = await timerStorage.get(id);
        if (!timer) return { result: `Timer "${id}" not found.`, error: true };
        const scheduleId = (args.scheduleId as string) || timer.schedules[0]?.id || "manual";
        const { timerScheduler } = await import("./timer-scheduler");
        const run = await timerScheduler.executeTimer(id, scheduleId, "manual");
        if (!run) return { result: JSON.stringify({ triggered: false, id, reason: "Timer disabled or not found" }) };
        return { result: JSON.stringify({ triggered: true, id, runId: run.id, status: run.status }) };
      }
      return { result: `Unknown timers action: ${action}. Available: list, get, runs, create, update, delete, trigger`, error: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Timers error: ${msg}`, error: true };
    }
  },
  async health(args) {
    const action = args.action as string;
    if (!action) return { result: "Missing action parameter", error: true };
    try {
      const { queryHealthSummary, queryHealthMetrics, queryActivityStatus, logWellnessActivity, queryWellnessActivities, createWellnessActivity, updateWellnessActivity, archiveWellnessActivity, queryActivityLogs, deleteWellnessLog } = await import("./routes/wellness");
      if (action === "summary") {
        const summary = await queryHealthSummary();
        return { result: JSON.stringify(summary) };
      }
      if (action === "metrics") {
        const rows = await queryHealthMetrics({
          type: args.type as string | undefined,
          days: (args.days as number) || 30,
        });
        return { result: JSON.stringify({ total: rows.length, items: rows }) };
      }
      if (action === "list_activities") {
        const activities = await queryWellnessActivities();
        return { result: JSON.stringify({ total: activities.length, items: activities }) };
      }
      if (action === "log_activity") {
        const activityId = args.activityId as number | undefined;
        const name = args.name as string | undefined;
        const notes = args.notes as string | undefined;
        const dateStr = args.date as string | undefined;
        if (!activityId && !name) {
          return { result: "Either activityId or name is required for log_activity", error: true };
        }
        let resolvedId = activityId;
        if (!resolvedId && name) {
          const activities = await queryWellnessActivities();
          const lower = name.toLowerCase();
          const match = activities.find(a => a.name.toLowerCase() === lower)
            || activities.find(a => a.name.toLowerCase().includes(lower));
          if (!match) {
            return { result: `No activity found matching "${name}"`, error: true };
          }
          resolvedId = match.id;
        }
        let completedAt: Date | undefined;
        if (dateStr) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
          }
          completedAt = new Date(dateStr + "T12:00:00.000Z");
          if (isNaN(completedAt.getTime())) {
            return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
          }
          const { userDateStr } = await import("./utils/user-time");
          const todayStr = userDateStr();
          if (dateStr > todayStr) {
            return { result: "Future dates are not allowed", error: true };
          }
        }
        const result = await logWellnessActivity(resolvedId!, { notes, completedAt });
        if ("duplicate" in result) {
          const msg = dateStr ? "Activity was already logged for that date" : "Activity was already logged within the last 60 seconds";
          return { result: msg, error: true };
        }
        return { result: JSON.stringify({ logged: true, entry: result }) };
      }
      if (action === "delete_log") {
        const logId = args.logId as number | undefined;
        if (!logId) {
          return { result: "logId is required for delete_log", error: true };
        }
        const deleted = await deleteWellnessLog(logId);
        if (!deleted) {
          return { result: `Log ${logId} not found`, error: true };
        }
        return { result: JSON.stringify({ deleted: true, logId }) };
      }
      if (action === "activity_status") {
        const statuses = await queryActivityStatus();
        const grouped: Record<string, typeof statuses> = { overdue: [], due_soon: [], on_track: [], never_done: [] };
        for (const s of statuses) {
          grouped[s.status].push(s);
        }
        const counts = {
          overdue: grouped.overdue.length,
          due_soon: grouped.due_soon.length,
          on_track: grouped.on_track.length,
          never_done: grouped.never_done.length,
          total: statuses.length,
        };
        return { result: JSON.stringify({ counts, grouped }) };
      }
      if (action === "create_activity") {
        const name = args.name as string | undefined;
        const intervalDays = args.intervalDays as number | undefined;
        const category = args.category as string | undefined;
        if (!name || !intervalDays) {
          return { result: "name and intervalDays are required for create_activity (category auto-derived from interval if omitted)", error: true };
        }
        const activity = await createWellnessActivity({
          name,
          intervalDays,
          category,
          benefit: (args.benefit as string) || null,
          risk: (args.risk as string) || null,
          estimatedMinutes: (args.estimatedMinutes as number) || null,
          estimatedCost: (args.estimatedCost as number) || null,
          requirements: (args.requirements as string) || null,
          linkedMetricType: (args.linkedMetricType as string) || null,
          greatThreshold: (args.greatThreshold as number) ?? null,
          goodThreshold: (args.goodThreshold as number) ?? null,
          windowStart: (args.windowStart as number) ?? null,
          windowEnd: (args.windowEnd as number) ?? null,
        });
        return { result: JSON.stringify({ created: true, activity }) };
      }
      if (action === "update_activity") {
        const activityId = args.activityId as number | undefined;
        const name = args.name as string | undefined;
        if (!activityId && !name) {
          return { result: "Either activityId or name is required for update_activity", error: true };
        }
        let resolvedId = activityId;
        if (!resolvedId && name) {
          const activities = await queryWellnessActivities();
          const lower = name.toLowerCase();
          const match = activities.find(a => a.name.toLowerCase() === lower)
            || activities.find(a => a.name.toLowerCase().includes(lower));
          if (!match) return { result: `No activity found matching "${name}"`, error: true };
          resolvedId = match.id;
        }
        const updates: Record<string, any> = {};
        if (args.newName !== undefined) updates.name = args.newName as string;
        if (args.benefit !== undefined) updates.benefit = args.benefit as string;
        if (args.risk !== undefined) updates.risk = args.risk as string;
        if (args.intervalDays !== undefined) updates.intervalDays = args.intervalDays as number;
        if (args.estimatedMinutes !== undefined) updates.estimatedMinutes = args.estimatedMinutes as number;
        if (args.estimatedCost !== undefined) updates.estimatedCost = args.estimatedCost as number;
        if (args.requirements !== undefined) updates.requirements = args.requirements as string;
        if (args.category !== undefined) updates.category = args.category as string;
        if (args.linkedMetricType !== undefined) updates.linkedMetricType = args.linkedMetricType as string | null;
        if (args.greatThreshold !== undefined) updates.greatThreshold = args.greatThreshold as number | null;
        if (args.goodThreshold !== undefined) updates.goodThreshold = args.goodThreshold as number | null;
        if (args.windowStart !== undefined) updates.windowStart = args.windowStart as number | null;
        if (args.windowEnd !== undefined) updates.windowEnd = args.windowEnd as number | null;
        if (Object.keys(updates).length === 0) {
          return { result: "No fields to update. Provide at least one of: newName, benefit, risk, intervalDays, estimatedMinutes, estimatedCost, requirements, category, linkedMetricType, greatThreshold, goodThreshold, windowStart, windowEnd", error: true };
        }
        const result = await updateWellnessActivity(resolvedId!, updates);
        if (!result) return { result: `Activity ${resolvedId} not found`, error: true };
        const response: Record<string, any> = { updated: true, activity: result.activity };
        if (result.warning) response.warning = result.warning;
        return { result: JSON.stringify(response) };
      }
      if (action === "delete_activity") {
        const activityId = args.activityId as number | undefined;
        const name = args.name as string | undefined;
        if (!activityId && !name) {
          return { result: "Either activityId or name is required for delete_activity", error: true };
        }
        let resolvedId = activityId;
        if (!resolvedId && name) {
          const activities = await queryWellnessActivities();
          const lower = name.toLowerCase();
          const match = activities.find(a => a.name.toLowerCase() === lower)
            || activities.find(a => a.name.toLowerCase().includes(lower));
          if (!match) return { result: `No activity found matching "${name}"`, error: true };
          resolvedId = match.id;
        }
        const activity = await archiveWellnessActivity(resolvedId!);
        if (!activity) return { result: `Activity ${resolvedId} not found`, error: true };
        return { result: JSON.stringify({ deleted: true, activity }) };
      }
      if (action === "activity_logs") {
        const activityId = args.activityId as number | undefined;
        const limit = (args.days as number) || 50;
        const logs = await queryActivityLogs(activityId, limit);
        return { result: JSON.stringify({ total: logs.length, items: logs }) };
      }
      if (action === "save_gratitude") {
        const content = args.content as string | undefined;
        const dateStr = args.date as string | undefined;
        if (!content) {
          return { result: "content is required for save_gratitude", error: true };
        }
        if (content.length > 5000) {
          return { result: "content must be 5000 characters or fewer", error: true };
        }
        if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
        }
        const { upsertGratitudeEntry } = await import("./routes/wellness");
        const entry = await upsertGratitudeEntry(content, dateStr);
        return { result: JSON.stringify({ saved: true, entry }) };
      }
      if (action === "get_gratitude") {
        const { userDateStr } = await import("./utils/user-time");
        const dateStr = (args.date as string) || userDateStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
        }
        const { getGratitudeEntry } = await import("./routes/wellness");
        const entry = await getGratitudeEntry(dateStr);
        if (!entry) return { result: `No gratitude entry found for ${dateStr}` };
        return { result: JSON.stringify(entry) };
      }
      if (action === "list_gratitudes") {
        const limit = (args.limit as number) || 30;
        const { listGratitudeEntries } = await import("./routes/wellness");
        const entries = await listGratitudeEntries(limit);
        return { result: JSON.stringify({ total: entries.length, items: entries }) };
      }
      if (action === "save_learning") {
        const content = args.content as string | undefined;
        const dateStr = args.date as string | undefined;
        if (!content) {
          return { result: "content is required for save_learning", error: true };
        }
        if (content.length > 5000) {
          return { result: "content must be 5000 characters or fewer", error: true };
        }
        if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
        }
        const { upsertLearningEntry } = await import("./routes/wellness");
        const entry = await upsertLearningEntry(content, dateStr);
        return { result: JSON.stringify({ saved: true, entry }) };
      }
      if (action === "get_learning") {
        const { userDateStr } = await import("./utils/user-time");
        const dateStr = (args.date as string) || userDateStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
        }
        const { getLearningEntry } = await import("./routes/wellness");
        const entry = await getLearningEntry(dateStr);
        if (!entry) return { result: `No learning entry found for ${dateStr}` };
        return { result: JSON.stringify(entry) };
      }
      if (action === "list_learnings") {
        const limit = (args.limit as number) || 30;
        const { listLearningEntries } = await import("./routes/wellness");
        const entries = await listLearningEntries(limit);
        return { result: JSON.stringify({ total: entries.length, items: entries }) };
      }
      return { result: `Unknown health action: ${action}. Available: summary, metrics, list_activities, log_activity, activity_status, create_activity, update_activity, delete_activity, activity_logs, delete_log, save_gratitude, get_gratitude, list_gratitudes, save_learning, get_learning, list_learnings`, error: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Health error: ${msg}`, error: true };
    }
  },

  async exec(args) {
    const { execSkillStorage, execExperienceStorage, execPassionStorage, execMetricsStorage, execEducationStorage } = await import("./exec-storage");
    const { opportunityStorage } = await import("./opportunity-storage");
    const { eventBus } = await import("./event-bus");
    const { insertExecSkillSchema, insertExecExperienceSchema, insertOpportunitySchema, insertExecPassionSchema, createOpportunityInteractionSchema, updateOpportunityInteractionSchema } = await import("@shared/schema");

    const action = (args.action as string | undefined) || "list_skills";
    const { getCurrentPrincipal } = await import("./principal-context");
    const principal = getCurrentPrincipal();
    if (!principal?.userId) return { result: "No authenticated user context for exec tool", error: true };
    const userId = principal.userId;

    const publish = (source: string): void => {
      eventBus.publish({ category: "system", event: "data:exec_changed", payload: { source: `bridge_tool:${source}` } });
    };

    type ExecArgs = {
      action?: string; id?: number; name?: string; category?: string;
      skillType?: string; proficiency?: string; energyLevel?: string;
      domain?: string; narrative?: string; years?: number;
      keyOutcomes?: string[]; transferableAssets?: string[];
      title?: string; description?: string; type?: string; status?: string;
      probability?: number; isFullTime?: boolean; hoursPerWeek?: number;
      timeCommitmentPeriod?: string; timeHorizonMonths?: number;
      evInputs?: Record<string, any>; contactPersonId?: string; championPersonId?: string; followUpBy?: string; followUpNote?: string;
      sourceType?: string; sourceSignalId?: string; requiredSkills?: string[];
      statusFilter?: string; typeFilter?: string;
      opportunityId?: number; skillId?: number; experienceId?: number; associationId?: number;
      personId?: string; interactionId?: string; date?: string; summary?: string; direction?: string; meaningfulness?: string; responseOwed?: boolean; responseDueBy?: string | null; capitalImpact?: string; tags?: string[];
      content?: string; tier?: string; position?: number; sourceRef?: string;
      jdText?: string; format?: string; jobUrl?: string;
      startDate?: string; endDate?: string; company?: string;
      location?: string; nextSteps?: string; priority?: string;
      teamSizePeak?: number; directReports?: number;
      pnlOwned?: string; budgetManaged?: string; fundingRaised?: string; companyContext?: string;
      metric?: string; value?: string; context?: string; verifiedAt?: Date | string | null;
      institution?: string; degree?: string | null; field?: string | null; year?: string | null; notes?: string | null;
      kind?: string; fileName?: string;
    };
    const a = args as ExecArgs;

    try {
      switch (action) {
        // ── Skills ──────────────────────────────────────────────
        case "list_skills": {
          const list = await execSkillStorage.list(userId);
          if (list.length === 0) return { result: "No skills found." };
          const lines = list.map(s => {
            const typePart = s.skillType ? ` type=${s.skillType}` : "";
            return `[${s.id}] ${s.name} — ${s.category || "uncategorized"}, ${s.proficiency || "?"}, energy=${s.energyLevel || "?"}${typePart}`;
          });
          return { result: `${list.length} skill(s):\n${lines.join("\n")}` };
        }
        case "get_skill": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const s = await execSkillStorage.get(a.id);
          if (!s) return { result: `Skill ${a.id} not found`, error: true };
          const skillExps = await execExperienceStorage.getExperienceForSkill(a.id);
          const expPart = skillExps.length
            ? `\n  experience: ${skillExps.map(e => `${e.company || ""} — ${e.domain}`).join("; ")}`
            : "";
          return { result: `[${s.id}] ${s.name}\n  category=${s.category || "?"} type=${s.skillType || "applied"}\n  proficiency=${s.proficiency || "?"} energy=${s.energyLevel || "?"}${expPart}` };
        }
        case "create_skill": {
          if (typeof a.name !== "string" || !a.name) return { result: "Missing required: name", error: true };
          const fields: Record<string, unknown> = { name: a.name };
          if (a.category !== undefined) fields.category = a.category;
          if (a.skillType !== undefined) fields.skillType = a.skillType;
          if (a.proficiency !== undefined) fields.proficiency = a.proficiency;
          if (a.energyLevel !== undefined) fields.energyLevel = a.energyLevel;
          const parsed = insertExecSkillSchema.parse(fields);
          const row = await execSkillStorage.create(userId, parsed);
          publish("create_skill");
          return { result: `Created skill ${row.id} "${row.name}".` };
        }
        case "update_skill": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const updates: Record<string, unknown> = {};
          if (a.name !== undefined) updates.name = a.name;
          if (a.category !== undefined) updates.category = a.category;
          if (a.skillType !== undefined) updates.skillType = a.skillType;
          if (a.proficiency !== undefined) updates.proficiency = a.proficiency;
          if (a.energyLevel !== undefined) updates.energyLevel = a.energyLevel;
          if (Object.keys(updates).length === 0) return { result: "No fields to update", error: true };
          const parsed = insertExecSkillSchema.partial().parse(updates);
          const row = await execSkillStorage.update(a.id, parsed);
          if (!row) return { result: `Skill ${a.id} not found`, error: true };
          publish("update_skill");
          return { result: `Updated skill ${row.id} "${row.name}".` };
        }
        case "delete_skill": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const deleted = await execSkillStorage.delete(a.id);
          if (!deleted) return { result: `Skill ${a.id} not found`, error: true };
          publish("delete_skill");
          return { result: `Deleted skill ${a.id}.` };
        }

        // ── Experience ─────────────────────────────────────────
        case "list_experience": {
          const list = await execExperienceStorage.listWithSkills(userId);
          if (list.length === 0) return { result: "No experience entries found." };
          const lines = list.map(e => {
            const dateRange = e.startDate ? `${e.startDate} – ${e.endDate || "Present"}` : "";
            const company = e.company ? `${e.company} — ` : "";
            const skillNames = (e.linkedSkills || []).map(s => s.name).join(", ");
            const skillPart = skillNames ? ` skills=[${skillNames}]` : "";
            return `[${e.id}] ${company}${e.domain} — ${e.years ?? "?"} years${dateRange ? ` (${dateRange})` : ""}${skillPart}${e.narrative ? `: ${e.narrative.slice(0, 80)}${e.narrative.length > 80 ? "…" : ""}` : ""}`;
          });
          return { result: `${list.length} experience(s):\n${lines.join("\n")}` };
        }
        case "get_experience": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const e = await execExperienceStorage.getWithSkills(a.id);
          if (!e) return { result: `Experience ${a.id} not found`, error: true };
          const dateRange = e.startDate ? ` (${e.startDate} – ${e.endDate || "Present"})` : "";
          const company = e.company ? `${e.company} — ` : "";
          const titlePart = e.title ? ` | ${e.title}` : "";
          const scopeParts: string[] = [];
          if (e.location) scopeParts.push(`location=${e.location}`);
          if (e.teamSizePeak) scopeParts.push(`team=${e.teamSizePeak}`);
          if (e.directReports) scopeParts.push(`reports=${e.directReports}`);
          if (e.pnlOwned) scopeParts.push(`P&L=${e.pnlOwned}`);
          if (e.budgetManaged) scopeParts.push(`budget=${e.budgetManaged}`);
          if (e.fundingRaised) scopeParts.push(`raised=${e.fundingRaised}`);
          const parts = [
            `[${e.id}] ${company}${e.domain}${titlePart} — ${e.years ?? "?"} years${dateRange}`,
            scopeParts.length ? `  scope: ${scopeParts.join(", ")}` : null,
            e.companyContext ? `  context: ${e.companyContext}` : null,
            e.narrative ? `  ${e.narrative}` : null,
            (e.keyOutcomes || []).length ? `  outcomes: ${e.keyOutcomes.join("; ")}` : null,
            (e.linkedSkills || []).length ? `  skills: ${e.linkedSkills.map(s => `${s.name} (${s.proficiency || "?"})`).join(", ")}` : null,
            (e.transferableAssets || []).length ? `  legacyAssets: ${e.transferableAssets.join("; ")}` : null,
          ].filter((l): l is string => Boolean(l));
          return { result: parts.join("\n") };
        }
        case "create_experience": {
          if (typeof a.domain !== "string" || !a.domain) return { result: "Missing required: domain", error: true };
          const fields: Record<string, unknown> = { domain: a.domain };
          if (a.narrative !== undefined) fields.narrative = a.narrative;
          if (a.years !== undefined) fields.years = a.years;
          if (a.keyOutcomes !== undefined) fields.keyOutcomes = a.keyOutcomes;
          if (a.transferableAssets !== undefined) fields.transferableAssets = a.transferableAssets;
          if (a.startDate !== undefined) fields.startDate = a.startDate;
          if (a.endDate !== undefined) fields.endDate = a.endDate;
          if (a.company !== undefined) fields.company = a.company;
          if (a.title !== undefined) fields.title = a.title;
          if (a.location !== undefined) fields.location = a.location;
          if (a.teamSizePeak !== undefined) fields.teamSizePeak = a.teamSizePeak;
          if (a.directReports !== undefined) fields.directReports = a.directReports;
          if (a.pnlOwned !== undefined) fields.pnlOwned = a.pnlOwned;
          if (a.budgetManaged !== undefined) fields.budgetManaged = a.budgetManaged;
          if (a.fundingRaised !== undefined) fields.fundingRaised = a.fundingRaised;
          if (a.companyContext !== undefined) fields.companyContext = a.companyContext;
          const parsed = insertExecExperienceSchema.parse(fields);
          const row = await execExperienceStorage.create(userId, parsed);
          publish("create_experience");
          return { result: `Created experience ${row.id} "${row.domain}".` };
        }
        case "update_experience": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const updates: Record<string, unknown> = {};
          if (a.domain !== undefined) updates.domain = a.domain;
          if (a.narrative !== undefined) updates.narrative = a.narrative;
          if (a.years !== undefined) updates.years = a.years;
          if (a.keyOutcomes !== undefined) updates.keyOutcomes = a.keyOutcomes;
          if (a.transferableAssets !== undefined) updates.transferableAssets = a.transferableAssets;
          if (a.startDate !== undefined) updates.startDate = a.startDate;
          if (a.endDate !== undefined) updates.endDate = a.endDate;
          if (a.company !== undefined) updates.company = a.company;
          if (a.title !== undefined) updates.title = a.title;
          if (a.location !== undefined) updates.location = a.location;
          if (a.teamSizePeak !== undefined) updates.teamSizePeak = a.teamSizePeak;
          if (a.directReports !== undefined) updates.directReports = a.directReports;
          if (a.pnlOwned !== undefined) updates.pnlOwned = a.pnlOwned;
          if (a.budgetManaged !== undefined) updates.budgetManaged = a.budgetManaged;
          if (a.fundingRaised !== undefined) updates.fundingRaised = a.fundingRaised;
          if (a.companyContext !== undefined) updates.companyContext = a.companyContext;
          if (Object.keys(updates).length === 0) return { result: "No fields to update", error: true };
          const parsed = insertExecExperienceSchema.partial().parse(updates);
          const row = await execExperienceStorage.update(a.id, parsed);
          if (!row) return { result: `Experience ${a.id} not found`, error: true };
          publish("update_experience");
          return { result: `Updated experience ${row.id} "${row.domain}".` };
        }
        case "delete_experience": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const deleted = await execExperienceStorage.delete(a.id);
          if (!deleted) return { result: `Experience ${a.id} not found`, error: true };
          publish("delete_experience");
          return { result: `Deleted experience ${a.id}.` };
        }

        // ── Experience ↔ Skill Linking ──────────────────────────
        case "link_skill_to_experience": {
          const expId = a.experienceId ?? a.id;
          const skId = a.skillId;
          if (typeof expId !== "number") return { result: "Missing required: experienceId (or id)", error: true };
          if (typeof skId !== "number") return { result: "Missing required: skillId", error: true };
          await execExperienceStorage.linkSkill(expId, skId);
          publish("link_skill_to_experience");
          return { result: `Linked skill ${skId} to experience ${expId}.` };
        }
        case "unlink_skill_from_experience": {
          const expId = a.experienceId ?? a.id;
          const skId = a.skillId;
          if (typeof expId !== "number") return { result: "Missing required: experienceId (or id)", error: true };
          if (typeof skId !== "number") return { result: "Missing required: skillId", error: true };
          const removed = await execExperienceStorage.unlinkSkill(expId, skId);
          if (!removed) return { result: `Link not found for skill ${skId} on experience ${expId}`, error: true };
          publish("unlink_skill_from_experience");
          return { result: `Unlinked skill ${skId} from experience ${expId}.` };
        }

        // ── Opportunities ──────────────────────────────────────
        case "list_opportunities": {
          const filters: { status?: string; type?: string } = {};
          if (a.statusFilter) filters.status = a.statusFilter;
          if (a.typeFilter) filters.type = a.typeFilter;
          const list = await opportunityStorage.listWithSkills(principal, filters);
          if (list.length === 0) return { result: "No opportunities found." };
          const lines = list.map(o => {
            const ev = o.computedEv != null ? `${Math.round(o.computedEv).toLocaleString()}` : "—";
            const skillNames = (o.linkedSkills || []).map(s => s.name).join(", ");
            const skillPart = skillNames ? ` skills=[${skillNames}]` : "";
            return `[${o.id}] ${o.title} — ${o.type}, ${o.status}, EV=${ev}, prob=${Math.round((o.probability ?? 0) * 100)}%${skillPart}`;
          });
          return { result: `${list.length} opportunity(ies):\n${lines.join("\n")}` };
        }
        case "get_opportunity": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const o = await opportunityStorage.getWithSkills(a.id, principal);
          if (!o) return { result: `Opportunity ${a.id} not found`, error: true };
          const artifacts = await opportunityStorage.getArtifacts(a.id);
          const ev = o.computedEv != null ? `${Math.round(o.computedEv).toLocaleString()}` : "—";
          const parts = [
            `[${o.id}] ${o.title}`,
            `  type=${o.type} status=${o.status} probability=${Math.round((o.probability ?? 0) * 100)}%`,
            `  EV=${ev}`,
            o.companyId ? `  company: @company:${o.companyId}` : o.company ? `  company: ${o.company}` : null,
            o.location ? `  location: ${o.location}` : null,
            o.priority ? `  priority: ${o.priority}` : null,
            o.description ? `  description: ${o.description.slice(0, 200)}${o.description.length > 200 ? "…" : ""}` : null,
            o.nextSteps ? `  nextSteps: ${o.nextSteps.slice(0, 200)}${o.nextSteps.length > 200 ? "…" : ""}` : null,
            o.isFullTime ? `  Full time` : o.hoursPerWeek ? `  ${o.hoursPerWeek} hrs/${o.timeCommitmentPeriod || "week"}` : null,
            o.timeHorizonMonths ? `  Income starts in ${o.timeHorizonMonths} months` : null,
            o.contactPersonId ? `  contact: ${o.contactPersonId}` : null,
            o.championPersonId ? `  champion: ${o.championPersonId}` : null,
            o.followUpBy ? `  followUpBy: ${o.followUpBy}` : null,
            o.followUpNote ? `  followUpNote: ${o.followUpNote}` : null,
            o.sourceType !== "manual" ? `  source: ${o.sourceType}${o.sourceSignalId ? ` signal=${o.sourceSignalId}` : ""}` : null,
            (o.linkedSkills || []).length ? `  linkedSkills: ${o.linkedSkills!.map(s => `${s.name} (${s.proficiency || "?"}/${s.energyLevel || "?"})`).join(", ")}` : null,
            (o.requiredSkills || []).length ? `  requiredSkills(legacy): ${o.requiredSkills.join(", ")}` : null,
            artifacts.length ? `  artifacts: ${artifacts.map(x => `${x.kind}:${x.libraryPageId}${x.sessionId ? ` session=${x.sessionId}` : ""}`).join(", ")}` : null,
            `  evInputs: ${JSON.stringify(o.evInputs)}`,
          ].filter((l): l is string => Boolean(l));
          return { result: parts.join("\n") };
        }
        case "create_opportunity": {
          if (typeof a.title !== "string" || !a.title) return { result: "Missing required: title", error: true };
          if (typeof a.type !== "string" || !a.type) return { result: "Missing required: type", error: true };
          const fields: Record<string, unknown> = { title: a.title, type: a.type };
          if (a.description !== undefined) fields.description = a.description;
          if (a.status !== undefined) fields.status = a.status;
          if (a.probability !== undefined) fields.probability = a.probability;
          if (a.isFullTime !== undefined) fields.isFullTime = a.isFullTime;
          if (a.hoursPerWeek !== undefined) fields.hoursPerWeek = a.hoursPerWeek;
          if (a.timeCommitmentPeriod !== undefined) fields.timeCommitmentPeriod = a.timeCommitmentPeriod;
          if (a.timeHorizonMonths !== undefined) fields.timeHorizonMonths = a.timeHorizonMonths;
          if (a.evInputs !== undefined) fields.evInputs = a.evInputs;
          if (a.company !== undefined) fields.company = a.company;
          if (a.companyId !== undefined) fields.companyId = a.companyId;
          if (a.location !== undefined) fields.location = a.location;
          if (a.nextSteps !== undefined) fields.nextSteps = a.nextSteps;
          if (a.priority !== undefined) fields.priority = a.priority;
          if (a.contactPersonId !== undefined) fields.contactPersonId = a.contactPersonId;
          if (a.sourceType !== undefined) fields.sourceType = a.sourceType;
          if (a.sourceSignalId !== undefined) fields.sourceSignalId = a.sourceSignalId;
          if (a.requiredSkills !== undefined) fields.requiredSkills = a.requiredSkills;
          if (a.jdText !== undefined) fields.jdText = a.jdText;
          if (a.jobUrl !== undefined) fields.jobUrl = a.jobUrl;
          if (a.championPersonId !== undefined) fields.championPersonId = a.championPersonId;
          if (a.followUpBy !== undefined) fields.followUpBy = a.followUpBy;
          if (a.followUpNote !== undefined) fields.followUpNote = a.followUpNote;
          const parsed = insertOpportunitySchema.parse(fields);
          const row = await opportunityStorage.create(principal, parsed);
          publish("create_opportunity");
          return { result: `Created opportunity ${row.id} "${row.title}" (EV=${Math.round(row.computedEv ?? 0).toLocaleString()}).` };
        }
        case "update_opportunity": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const updates: Record<string, unknown> = {};
          if (a.title !== undefined) updates.title = a.title;
          if (a.description !== undefined) updates.description = a.description;
          if (a.type !== undefined) updates.type = a.type;
          if (a.status !== undefined) updates.status = a.status;
          if (a.probability !== undefined) updates.probability = a.probability;
          if (a.isFullTime !== undefined) updates.isFullTime = a.isFullTime;
          if (a.hoursPerWeek !== undefined) updates.hoursPerWeek = a.hoursPerWeek;
          if (a.timeCommitmentPeriod !== undefined) updates.timeCommitmentPeriod = a.timeCommitmentPeriod;
          if (a.timeHorizonMonths !== undefined) updates.timeHorizonMonths = a.timeHorizonMonths;
          if (a.evInputs !== undefined) updates.evInputs = a.evInputs;
          if (a.company !== undefined) updates.company = a.company;
          if (a.companyId !== undefined) updates.companyId = a.companyId;
          if (a.location !== undefined) updates.location = a.location;
          if (a.nextSteps !== undefined) updates.nextSteps = a.nextSteps;
          if (a.priority !== undefined) updates.priority = a.priority;
          if (a.contactPersonId !== undefined) updates.contactPersonId = a.contactPersonId;
          if (a.sourceType !== undefined) updates.sourceType = a.sourceType;
          if (a.sourceSignalId !== undefined) updates.sourceSignalId = a.sourceSignalId;
          if (a.requiredSkills !== undefined) updates.requiredSkills = a.requiredSkills;
          if (a.jdText !== undefined) updates.jdText = a.jdText;
          if (a.jobUrl !== undefined) updates.jobUrl = a.jobUrl;
          if (a.championPersonId !== undefined) updates.championPersonId = a.championPersonId;
          if (a.followUpBy !== undefined) updates.followUpBy = a.followUpBy;
          if (a.followUpNote !== undefined) updates.followUpNote = a.followUpNote;
          if (Object.keys(updates).length === 0) return { result: "No fields to update", error: true };
          const parsed = insertOpportunitySchema.partial().parse(updates);
          const row = await opportunityStorage.update(a.id, parsed, principal);
          if (!row) return { result: `Opportunity ${a.id} not found`, error: true };
          publish("update_opportunity");
          return { result: `Updated opportunity ${row.id} "${row.title}" (EV=${Math.round(row.computedEv ?? 0).toLocaleString()}).` };
        }
        case "delete_opportunity": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const deleted = await opportunityStorage.delete(a.id, principal);
          if (!deleted) return { result: `Opportunity ${a.id} not found`, error: true };
          publish("delete_opportunity");
          return { result: `Deleted opportunity ${a.id}.` };
        }

        // ── Opportunity ↔ Person interaction activities ───────
        case "list_opportunity_activities": {
          const opportunityId = a.opportunityId ?? a.id;
          if (typeof opportunityId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          const activities = await opportunityStorage.listActivities(opportunityId, principal);
          if (activities.length === 0) return { result: "No linked activities." };
          return { result: activities.map(activity => `[${activity.associationId}] ${activity.interaction.date} ${activity.personName}: ${activity.interaction.summary} ${activity.reference}`).join("\n") };
        }
        case "create_or_link_opportunity_activity": {
          const opportunityId = a.opportunityId ?? a.id;
          if (typeof opportunityId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          const input = createOpportunityInteractionSchema.parse({
            personId: a.personId, interactionId: a.interactionId, date: a.date, type: a.type,
            summary: a.summary, context: a.context, direction: a.direction, meaningfulness: a.meaningfulness,
            responseOwed: a.responseOwed, responseDueBy: a.responseDueBy, capitalImpact: a.capitalImpact, tags: a.tags,
          });
          const activity = await opportunityStorage.createOrLinkActivity(opportunityId, input, principal);
          publish("create_or_link_opportunity_activity");
          return { result: `Linked activity ${activity.associationId} to opportunity ${opportunityId}: ${activity.reference}` };
        }
        case "update_opportunity_activity": {
          const opportunityId = a.opportunityId ?? a.id;
          if (typeof opportunityId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          if (typeof a.associationId !== "number") return { result: "Missing required: associationId", error: true };
          const updates = updateOpportunityInteractionSchema.parse({
            date: a.date, type: a.type, summary: a.summary, context: a.context, direction: a.direction,
            meaningfulness: a.meaningfulness, responseOwed: a.responseOwed, responseDueBy: a.responseDueBy,
            capitalImpact: a.capitalImpact, tags: a.tags,
          });
          const activity = await opportunityStorage.updateActivity(opportunityId, a.associationId, updates, principal);
          if (!activity) return { result: "Activity association not found", error: true };
          publish("update_opportunity_activity");
          return { result: `Updated ${activity.reference}.` };
        }
        case "unlink_opportunity_activity": {
          const opportunityId = a.opportunityId ?? a.id;
          if (typeof opportunityId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          if (typeof a.associationId !== "number") return { result: "Missing required: associationId", error: true };
          const removed = await opportunityStorage.unlinkActivity(opportunityId, a.associationId, principal);
          if (!removed) return { result: "Activity association not found", error: true };
          publish("unlink_opportunity_activity");
          return { result: `Unlinked activity ${a.associationId} from opportunity ${opportunityId}. The Person interaction was preserved.` };
        }

        // ── Opportunity ↔ Skill Linking ────────────────────────
        case "link_skill": {
          const oppId = a.opportunityId ?? a.id;
          const skId = a.skillId;
          if (typeof oppId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          if (typeof skId !== "number") return { result: "Missing required: skillId", error: true };
          await opportunityStorage.linkSkill(oppId, skId);
          publish("link_skill");
          return { result: `Linked skill ${skId} to opportunity ${oppId}.` };
        }
        case "unlink_skill": {
          const oppId = a.opportunityId ?? a.id;
          const skId = a.skillId;
          if (typeof oppId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          if (typeof skId !== "number") return { result: "Missing required: skillId", error: true };
          const removed = await opportunityStorage.unlinkSkill(oppId, skId);
          if (!removed) return { result: `Link not found for skill ${skId} on opportunity ${oppId}`, error: true };
          publish("unlink_skill");
          return { result: `Unlinked skill ${skId} from opportunity ${oppId}.` };
        }

        // ── Mission (canonical) / Passions (legacy) ─────────
        case "list_mission":
        case "list_passions": {
          const list = await execPassionStorage.list(userId);
          if (list.length === 0) return { result: "No passions found." };
          const grouped: Record<string, typeof list> = {};
          for (const p of list) {
            const t = p.tier || "unknown";
            (grouped[t] ??= []).push(p);
          }
          const sections = Object.entries(grouped).map(([tier, items]) => {
            const lines = items.map(p => `  [${p.id}] ${p.title ?? "(untitled)"} — ${(p.content ?? "").slice(0, 80)}${(p.content ?? "").length > 80 ? "…" : ""}`);
            return `${tier} (${items.length}):\n${lines.join("\n")}`;
          });
          return { result: `${list.length} passion(s):\n${sections.join("\n\n")}` };
        }
        case "get_mission_item":
        case "get_passion": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const p = await execPassionStorage.get(a.id);
          if (!p) return { result: `Passion ${a.id} not found`, error: true };
          const parts = [
            `[${p.id}] ${p.title ?? "(untitled)"}`,
            `  tier=${p.tier} position=${p.position ?? "?"}`,
            p.content ? `  ${p.content}` : null,
            p.sourceRef ? `  source: ${p.sourceRef}` : null,
          ].filter((l): l is string => Boolean(l));
          return { result: parts.join("\n") };
        }
        case "create_mission_item":
        case "create_passion": {
          if (typeof a.tier !== "string" || !a.tier) return { result: "Missing required: tier", error: true };
          if (typeof a.content !== "string" || !a.content) return { result: "Missing required: content", error: true };
          const fields: Record<string, unknown> = { tier: a.tier, content: a.content };
          if (a.title !== undefined) fields.title = a.title;
          if (a.position !== undefined) fields.position = a.position;
          if (a.sourceRef !== undefined) fields.sourceRef = a.sourceRef;
          const parsed = insertExecPassionSchema.parse(fields);
          const row = await execPassionStorage.create(userId, parsed);
          publish("create_passion");
          return { result: `Created passion ${row.id} "${row.title ?? row.tier}".` };
        }
        case "update_mission_item":
        case "update_passion": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const updates: Record<string, unknown> = {};
          if (a.tier !== undefined) updates.tier = a.tier;
          if (a.content !== undefined) updates.content = a.content;
          if (a.title !== undefined) updates.title = a.title;
          if (a.position !== undefined) updates.position = a.position;
          if (a.sourceRef !== undefined) updates.sourceRef = a.sourceRef;
          if (Object.keys(updates).length === 0) return { result: "No fields to update", error: true };
          const parsed = insertExecPassionSchema.partial().parse(updates);
          const row = await execPassionStorage.update(a.id, parsed);
          if (!row) return { result: `Passion ${a.id} not found`, error: true };
          publish("update_passion");
          return { result: `Updated passion ${row.id} "${row.title ?? row.tier}".` };
        }
        case "delete_mission_item":
        case "delete_passion": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const deleted = await execPassionStorage.delete(a.id);
          if (!deleted) return { result: `Passion ${a.id} not found`, error: true };
          publish("delete_passion");
          return { result: `Deleted passion ${a.id}.` };
        }

        // ── Metrics / Education / Artifacts ───────────────────
        case "list_metrics": {
          const rows = await execMetricsStorage.list(userId, a.experienceId);
          return { result: JSON.stringify(rows, null, 2) };
        }
        case "create_metric": {
          if (!a.metric || !a.value) return { result: "Missing required: metric, value", error: true };
          const row = await execMetricsStorage.create(userId, { experienceId: a.experienceId ?? null, metric: a.metric, value: a.value, context: a.context ?? null, verifiedAt: a.verifiedAt ? new Date(a.verifiedAt) : null });
          publish("create_metric");
          return { result: `Created metric ${row.id}.` };
        }
        case "update_metric": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const row = await execMetricsStorage.update(a.id, { experienceId: a.experienceId, metric: a.metric, value: a.value, context: a.context, verifiedAt: a.verifiedAt ? new Date(a.verifiedAt) : undefined });
          if (!row) return { result: `Metric ${a.id} not found`, error: true };
          publish("update_metric");
          return { result: `Updated metric ${a.id}.` };
        }
        case "delete_metric": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const ok = await execMetricsStorage.delete(a.id);
          if (!ok) return { result: `Metric ${a.id} not found`, error: true };
          publish("delete_metric");
          return { result: `Deleted metric ${a.id}.` };
        }
        case "list_education": {
          const rows = await execEducationStorage.list(userId);
          return { result: JSON.stringify(rows, null, 2) };
        }
        case "create_education": {
          if (!a.institution) return { result: "Missing required: institution", error: true };
          const row = await execEducationStorage.create(userId, { institution: a.institution, degree: a.degree, field: a.field, year: a.year, notes: a.notes });
          publish("create_education");
          return { result: `Created education ${row.id}.` };
        }
        case "update_education": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const row = await execEducationStorage.update(a.id, { institution: a.institution, degree: a.degree, field: a.field, year: a.year, notes: a.notes });
          if (!row) return { result: `Education ${a.id} not found`, error: true };
          publish("update_education");
          return { result: `Updated education ${a.id}.` };
        }
        case "delete_education": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const ok = await execEducationStorage.delete(a.id);
          if (!ok) return { result: `Education ${a.id} not found`, error: true };
          publish("delete_education");
          return { result: `Deleted education ${a.id}.` };
        }
        case "set_artifact": {
          const id = a.opportunityId ?? a.id;
          if (typeof id !== "number" || typeof a.kind !== "string") return { result: "Missing required: opportunityId, kind", error: true };
          if (a.libraryPageId === null || a.libraryPageId === undefined) {
            const deleted = await opportunityStorage.deleteArtifact(id, a.kind as any);
            if (!deleted) return { result: `No ${a.kind} artifact found on opportunity ${id}`, error: true };
            publish("set_artifact");
            return { result: `Cleared ${a.kind} artifact from opportunity ${id}.` };
          }
          const row = await opportunityStorage.upsertArtifact(id, a.kind as any, {
            libraryPageId: a.libraryPageId,
            sessionId: a._sessionId ?? null,
          });
          publish("set_artifact");
          return { result: `Set ${a.kind} artifact on opportunity ${id} → library page ${a.libraryPageId} (artifact #${row.id}).` };
        }
        case "get_opportunity_artifacts": {
          const id = a.opportunityId ?? a.id;
          if (typeof id !== "number") return { result: "Missing required: opportunityId", error: true };
          const rows = await opportunityStorage.getArtifacts(id);
          return { result: JSON.stringify(rows, null, 2) };
        }
        case "render_artifact_docx": {
          const id = a.opportunityId ?? a.id;
          if (typeof id !== "number" || typeof a.kind !== "string" || !a.content) return { result: "Missing required: opportunityId, kind, content", error: true };
          const { renderArtifactDocx } = await import("./artifact-docx");
          const fileName = await renderArtifactDocx(a.kind as "resume" | "cover_letter", a.content, a.fileName);
          if (a.kind === "resume" || a.kind === "cover_letter") await opportunityStorage.setArtifactDocx(id, a.kind, fileName);
          // Record session artifact link
          const { recordSessionArtifact: recordDocxArtifact } = await import("./session-artifacts");
          recordDocxArtifact(args._sessionId, "docx", fileName, { opportunityId: id, kind: a.kind });
          return { result: `Artifact DOCX generated: ${fileName}` };
        }

        default:
          return {
            result: `Unknown exec action: ${action}. Available: list_skills, get_skill, create_skill, update_skill, delete_skill, list_experience, get_experience, create_experience, update_experience, delete_experience, link_skill_to_experience, unlink_skill_from_experience, list_opportunities, get_opportunity, create_opportunity, update_opportunity, delete_opportunity, list_opportunity_activities, create_or_link_opportunity_activity, update_opportunity_activity, unlink_opportunity_activity, link_skill, unlink_skill, list_passions/list_mission, get_passion/get_mission_item, create_passion/create_mission_item, update_passion/update_mission_item, delete_passion/delete_mission_item, list_metrics, create_metric, update_metric, delete_metric, list_education, create_education, update_education, delete_education, set_artifact, get_opportunity_artifacts, render_artifact_docx`,
            error: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `exec error: ${msg}`, error: true };
    }
  },

  async theses(args) {
    const { thesisStorage } = await import("./thesis-storage");
    const { eventBus } = await import("./event-bus");
    const { thesisStatuses, thesisConvictions, predictionOutcomes } = await import("@shared/schema");

    const action = (args.action as string | undefined) || "list";

    const publish = (source: string): void => {
      eventBus.publish({ category: "system", event: "data:theses_changed", payload: { source: `bridge_tool:${source}` } });
    };

    const requireString = (v: unknown, name: string): string => {
      if (typeof v !== "string" || !v) throw new Error(`Missing required: ${name}`);
      return v;
    };

    type ThesesArgs = {
      action?: string; id?: string; title?: string; statement?: string;
      tags?: string[]; status?: string; conviction?: string; successorId?: string;
      content?: string; sourceUrl?: string; position?: number;
      claim?: string; deadline?: string; outcome?: string;
      evidenceId?: string; predictionId?: string;
    };
    const a = args as ThesesArgs;

    try {
      switch (action) {
        case "list": {
          const statusRaw = a.status;
          let status: undefined | string;
          if (statusRaw && statusRaw !== "all") {
            if (!(thesisStatuses as readonly string[]).includes(statusRaw)) {
              return { result: `Invalid status: ${statusRaw}. Use draft, active, superseded, invalidated, or all.`, error: true };
            }
            status = statusRaw;
          }
          const list = await thesisStorage.list(status ? { status: status as any } : undefined);
          if (list.length === 0) return { result: status ? `No ${status} theses.` : "No theses found." };
          const lines = list.map(t => {
            const tags = (t.tags || []).join(", ");
            return `[${t.id}] ${t.title} (${t.status}, ${t.conviction})${tags ? ` [${tags}]` : ""}`;
          });
          return { result: `${list.length} thesis/theses:\n${lines.join("\n")}` };
        }
        case "get": {
          const id = requireString(a.id, "id");
          const t = await thesisStorage.get(id);
          if (!t) return { result: `Thesis ${id} not found`, error: true };
          const evidence = await thesisStorage.listEvidence(id);
          const predictions = await thesisStorage.listPredictions(id);
          const sections = [
            `[${t.id}] ${t.title}`,
            `  status=${t.status} conviction=${t.conviction}`,
            t.statement ? `  statement: ${t.statement}` : null,
            (t.tags || []).length ? `  tags: ${t.tags!.join(", ")}` : null,
            t.successorId ? `  successor: ${t.successorId}` : null,
            evidence.length ? `\nEvidence (${evidence.length}):\n${evidence.map(e => `  - [${e.id}] ${e.content}${e.sourceUrl ? ` (${e.sourceUrl})` : ""}`).join("\n")}` : null,
            predictions.length ? `\nPredictions (${predictions.length}):\n${predictions.map(p => `  - [${p.id}] ${p.outcome} — ${p.claim}${p.deadline ? ` (due ${p.deadline})` : ""}`).join("\n")}` : null,
          ].filter((l): l is string => Boolean(l));
          return { result: sections.join("\n") };
        }
        case "create": {
          const title = requireString(a.title, "title");
          const fields: Record<string, unknown> = { title };
          if (typeof a.statement === "string") fields.statement = a.statement;
          if (Array.isArray(a.tags)) fields.tags = a.tags;
          if (typeof a.conviction === "string") {
            if (!(thesisConvictions as readonly string[]).includes(a.conviction)) {
              return { result: `Invalid conviction: ${a.conviction}. Use low or high.`, error: true };
            }
            fields.conviction = a.conviction;
          }
          if (typeof a.status === "string") fields.status = a.status;
          const row = await thesisStorage.create(fields as any);
          publish("create");
          return { result: `Created thesis ${row.id} "${row.title}" (${row.status}, ${row.conviction}).` };
        }
        case "update": {
          const id = requireString(a.id, "id");
          const updates: Record<string, unknown> = {};
          if (a.title !== undefined) updates.title = String(a.title);
          if (a.statement !== undefined) updates.statement = String(a.statement);
          if (Array.isArray(a.tags)) updates.tags = a.tags;
          if (a.conviction !== undefined) {
            if (!(thesisConvictions as readonly string[]).includes(a.conviction)) {
              return { result: `Invalid conviction: ${a.conviction}. Use low or high.`, error: true };
            }
            updates.conviction = a.conviction;
          }
          if (a.status !== undefined) {
            if (!(thesisStatuses as readonly string[]).includes(a.status)) {
              return { result: `Invalid status: ${a.status}. Use draft, active, superseded, invalidated.`, error: true };
            }
            updates.status = a.status;
          }
          if (a.successorId !== undefined) updates.successorId = a.successorId;
          if (a.status === "superseded" && a.successorId === id) {
            return { result: "Cannot supersede to self.", error: true };
          }
          const row = await thesisStorage.update(id, updates);
          if (!row) return { result: `Thesis ${id} not found`, error: true };
          publish("update");
          return { result: `Updated thesis ${row.id}.` };
        }
        case "delete": {
          const id = requireString(a.id, "id");
          const ok = await thesisStorage.delete(id);
          if (!ok) return { result: `Thesis ${id} not found`, error: true };
          publish("delete");
          return { result: `Deleted thesis ${id}.` };
        }
        case "add_evidence": {
          const id = requireString(a.id, "id");
          const content = requireString(a.content, "content");
          const t = await thesisStorage.get(id);
          if (!t) return { result: `Thesis ${id} not found`, error: true };
          const row = await thesisStorage.addEvidence({
            thesisId: id,
            content,
            sourceUrl: typeof a.sourceUrl === "string" ? a.sourceUrl : undefined,
            position: typeof a.position === "number" ? a.position : undefined,
          });
          publish("add_evidence");
          return { result: `Added evidence ${row.id} to thesis ${id}.` };
        }
        case "update_evidence": {
          const eid = requireString(a.evidenceId, "evidenceId");
          const updates: Record<string, unknown> = {};
          if (typeof a.content === "string") updates.content = a.content;
          if (typeof a.sourceUrl === "string") updates.sourceUrl = a.sourceUrl;
          if (typeof a.position === "number") updates.position = a.position;
          const row = await thesisStorage.updateEvidence(eid, updates);
          if (!row) return { result: `Evidence ${eid} not found`, error: true };
          publish("update_evidence");
          return { result: `Updated evidence ${eid}.` };
        }
        case "remove_evidence": {
          const eid = requireString(a.evidenceId, "evidenceId");
          const ok = await thesisStorage.removeEvidence(eid);
          if (!ok) return { result: `Evidence ${eid} not found`, error: true };
          publish("remove_evidence");
          return { result: `Removed evidence ${eid}.` };
        }
        case "add_prediction": {
          const id = requireString(a.id, "id");
          const claim = requireString(a.claim, "claim");
          const t = await thesisStorage.get(id);
          if (!t) return { result: `Thesis ${id} not found`, error: true };
          const row = await thesisStorage.addPrediction({
            thesisId: id,
            claim,
            deadline: typeof a.deadline === "string" ? a.deadline : undefined,
            conviction: typeof a.conviction === "string" ? a.conviction as any : undefined,
          });
          publish("add_prediction");
          return { result: `Added prediction ${row.id} to thesis ${id} (conviction: ${row.conviction ?? "low"}).` };
        }
        case "resolve_prediction": {
          const pid = requireString(a.predictionId, "predictionId");
          const outcome = requireString(a.outcome, "outcome");
          if (!(predictionOutcomes as readonly string[]).includes(outcome)) {
            return { result: `Invalid outcome: ${outcome}. Use pending, correct, incorrect, expired.`, error: true };
          }
          const resolutionNotes = typeof a.resolutionNotes === "string" ? a.resolutionNotes : undefined;
          const row = await thesisStorage.resolvePrediction(pid, outcome as any, resolutionNotes);
          if (!row) return { result: `Prediction ${pid} not found`, error: true };
          publish("resolve_prediction");
          return { result: `Resolved prediction ${pid} as ${outcome}.` };
        }
        case "remove_prediction": {
          const pid = requireString(a.predictionId, "predictionId");
          const ok = await thesisStorage.removePrediction(pid);
          if (!ok) return { result: `Prediction ${pid} not found`, error: true };
          publish("remove_prediction");
          return { result: `Removed prediction ${pid}.` };
        }
        default:
          return {
            result: `Unknown theses action: ${action}. Available: list, get, create, update, delete, add_evidence, update_evidence, remove_evidence, add_prediction, resolve_prediction, remove_prediction`,
            error: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Theses error: ${msg}`, error: true };
    }
  },
  async news(args) {
    const action = args.action as string;
    if (!action) return { result: "Missing action parameter", error: true };
    try {
      const { signalStorage } = await import("./news-storage");
      const adapters = await import("./news-adapters");

      switch (action) {
        case "summary": {
          const summary = await signalStorage.getNewsSummary();
          return { result: JSON.stringify(summary) };
        }
        case "scan": {
          const { runLandscapeScan } = await import("./news-scan-service");
          const result = await runLandscapeScan();
          return {
            result: JSON.stringify(result),
            error: result.outcome === "failed",
          };
        }

        case "list_signals": {
          const opts: any = {};
          if (args.status) opts.status = args.status;
          if (args.source_type) opts.sourceType = args.source_type;
          if (args.limit) opts.limit = Number(args.limit);
          if (args.offset) opts.offset = Number(args.offset);
          if (args.min_relevance) opts.minRelevance = Number(args.min_relevance);
          if (args.curation_status) opts.curationStatus = args.curation_status;
          if (args.has_curation !== undefined) opts.hasCuration = args.has_curation === true || args.has_curation === "true";
          if (args.matched_topic) opts.matchedTopic = args.matched_topic;
          if (args.query) opts.query = args.query;
          if (args.created_after) opts.createdAfter = new Date(args.created_after);
          if (args.created_before) opts.createdBefore = new Date(args.created_before);
          const { items, total } = await signalStorage.listSignals(opts);
          return { result: JSON.stringify({ total, count: items.length, items }) };
        }

        case "get_signal": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const signal = await signalStorage.getSignal(id);
          if (!signal) return { result: `Signal "${id}" not found`, error: true };
          return { result: JSON.stringify(signal) };
        }

        case "dismiss_signal": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const updated = await signalStorage.updateSignalStatus(id, "dismissed");
          if (!updated) return { result: `Signal "${id}" not found`, error: true };
          return { result: `Signal ${id} dismissed.` };
        }

        case "save_signal": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const updated = await signalStorage.updateSignalStatus(id, "saved");
          if (!updated) return { result: `Signal "${id}" not found`, error: true };
          return { result: `Signal ${id} saved.` };
        }

        case "surface_signal": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const updated = await signalStorage.surfaceSignal(id);
          if (!updated) return { result: `Signal "${id}" not found`, error: true };
          return { result: `Signal ${id} surfaced.` };
        }

        case "add_source": {
          const sourceType = args.source_type as string;
          const value = args.value as string;
          if (!sourceType) return { result: "Missing 'source_type' parameter. Options: x_account, subreddit, rss_feed, pinned_topic, hackernews, github_repo, polymarket, stocktwits, arxiv, youtube_channel", error: true };
          if (!value) return { result: "Missing 'value' parameter", error: true };
          const source = await signalStorage.addSource({ sourceType, value });
          return { result: `Added source: ${sourceType} = "${value}" (id: ${source.id})` };
        }

        case "add_topic": {
          const value = args.value as string;
          if (!value) return { result: "Missing 'value' parameter — the topic to add", error: true };
          // Dedup check
          const existing = await signalStorage.listSources({ sourceType: "pinned_topic" });
          if (existing.some(s => s.value.toLowerCase() === value.toLowerCase())) {
            return { result: `Topic "${value}" already exists.` };
          }
          const source = await signalStorage.addSource({ sourceType: "pinned_topic", value });
          return { result: `Added topic: "${value}" (id: ${source.id})` };
        }

        case "list_sources": {
          const sourceType = args.source_type as string | undefined;
          const sources = await signalStorage.listSources(sourceType ? { sourceType } : undefined);
          return { result: JSON.stringify({ total: sources.length, sources }) };
        }

        case "update_source": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const updates: any = {};
          if (args.value !== undefined) updates.value = args.value;
          if (args.enabled !== undefined) updates.enabled = args.enabled;
          if (args.source_type !== undefined) updates.sourceType = args.source_type;
          const source = await signalStorage.updateSource(id, updates);
          if (!source) return { result: `Source "${id}" not found`, error: true };
          return { result: `Source ${id} updated.` };
        }

        case "delete_source": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const deleted = await signalStorage.deleteSource(id);
          if (!deleted) return { result: `Source "${id}" not found`, error: true };
          return { result: `Source ${id} deleted.` };
        }

        case "list_scan_runs": {
          const limit = args.limit ? Number(args.limit) : 10;
          const runs = await signalStorage.listScanRuns(limit);
          return { result: JSON.stringify({ total: runs.length, runs }) };
        }

        case "interest_graph": {
          const graph = await adapters.buildInterestGraph();
          const queries = adapters.generateSearchQueries(graph);
          return { result: JSON.stringify({ topics: graph, searchQueries: queries }) };
        }

        case "batch_curate": {
          const decisions = args.decisions as Array<{
            fingerprint: string;
            isRelevant: boolean;
            score: number;
            title: string;
            reason: string;
            matchedTopics: string[];
            summary?: string;
          }>;
          if (!decisions || !Array.isArray(decisions)) {
            return { result: "Missing 'decisions' array parameter", error: true };
          }
          const { setSetting } = await import("./system-settings");
          const { getCurrentPrincipalOrSystem: _getPrincipal } = await import("./principal-context");
          const _principal = _getPrincipal();
          // User-scoped key: prevents cross-user mailbox bleed in multi-user deployments
          const _curationKey = `skill.news-curation.lastResults.${_principal.userId}`;
          await setSetting(_curationKey, decisions);
          return { result: `Stored ${decisions.length} curation decisions.` };
        }

        default:
          return {
            result: `Unknown news action: ${action}. Available: summary, scan, list_signals, get_signal, dismiss_signal, save_signal, surface_signal, add_source, add_topic, list_sources, update_source, delete_source, list_scan_runs, interest_graph, batch_curate`,
            error: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `News error: ${msg}`, error: true };
    }
  },
  async landscape(args) {
    return umbrellaHandlers.news(args);
  },
};

const cognitionTools: Record<string, ToolHandler> = {
  async cognition(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };

    const sub: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      set_emotion: async (a) => {
        const { fileEmotionalStateStorage } = await import("./file-storage/emotional-state");
        const stateName = a.state_name || a.stateName;
        if (!stateName) return { result: "Missing state_name", error: true };
        const entry = await fileEmotionalStateStorage.record({
          stateName,
          valence: a.valence ?? 0,
          arousal: a.arousal ?? 0.5,
          triggers: a.triggers || [],
          context: a.context || "",
          narrative: a.narrative || "",
          source: "explicit",
        });
        eventBus.publish({
          category: "agent",
          event: "cognition.emotion.changed",
          payload: { stateId: entry.id, stateName: entry.stateName, valence: entry.valence, arousal: entry.arousal },
        });
        return { result: `Emotional state set: ${entry.stateName} (v=${entry.valence}, a=${entry.arousal}, id=${entry.id})` };
      },

      get_emotion: async () => {
        const { fileEmotionalStateStorage } = await import("./file-storage/emotional-state");
        const current = await fileEmotionalStateStorage.getCurrent();
        if (!current) return { result: "No emotional state currently set." };
        const parts = [
          `**${current.stateName}**`,
          `Valence: ${current.valence} | Arousal: ${current.arousal}`,
          current.stale ? "⚠️ Stale (>4h old)" : `Set: ${current.createdAt}`,
        ];
        if (current.narrative) parts.push(`Narrative: ${current.narrative}`);
        if (current.triggers.length > 0) parts.push(`Triggers: ${current.triggers.join(", ")}`);
        if (current.context) parts.push(`Context: ${current.context}`);
        return { result: parts.join("\n") };
      },

      emotion_history: async (a) => {
        const { fileEmotionalStateStorage } = await import("./file-storage/emotional-state");
        const limit = a.limit || 10;
        const entries = await fileEmotionalStateStorage.getRecent(limit);
        if (entries.length === 0) return { result: "No emotional state history." };
        const lines = entries.map(e =>
          `- [${e.createdAt}] ${e.stateName} (v=${e.valence}, a=${e.arousal})${e.stale ? " ⚠️stale" : ""}${e.triggers.length ? ` — ${e.triggers.join(", ")}` : ""}`
        );
        return { result: `${entries.length} emotional states:\n${lines.join("\n")}` };
      },

      get_persona: async () => {
        const { resolveSessionPersona } = await import("./session-persona");
        const active = await resolveSessionPersona(args._sessionId);
        if (!active) return { result: "No persona available.", error: true };
        const parts = [
          `**${active.name}** (id=${active.id})`,
          active.description,
        ];
        if (active.expressionTags.length > 0) parts.push(`Expression tags: ${active.expressionTags.join(", ")}`);
        if (Object.keys(active.cognitiveOverrides).length > 0) {
          parts.push(`Cognitive overrides: ${JSON.stringify(active.cognitiveOverrides)}`);
        }
        if (active.promptOverlay) parts.push(`Overlay: ${active.promptOverlay.slice(0, 200)}${active.promptOverlay.length > 200 ? "..." : ""}`);
        return { result: parts.join("\n") };
      },

      list_personas: async () => {
        const { personaStorage } = await import("./file-storage/persona-storage");
        const all = (await personaStorage.list()).filter(p => !p.isSystem);
        if (all.length === 0) return { result: "No personas found." };
        const { resolveSessionPersona } = await import("./session-persona");
        const active = await resolveSessionPersona(args._sessionId);
        const lines = all.map(p =>
          `- ${p.id === active?.id ? "▶ " : ""}**${p.name}** (id=${p.id}, ${p.source})${p.isDefault ? " [default]" : ""} — ${p.description}`
        );
        return { result: `${all.length} personas:\n${lines.join("\n")}` };
      },

      create_persona: async (a) => {
        if (!a.name) return { result: "Missing persona name", error: true };
        const { personaStorage } = await import("./file-storage/persona-storage");
        const persona = await personaStorage.create({
          name: a.name,
          description: a.description,
          promptOverlay: a.prompt_overlay || a.promptOverlay,
          expressionTags: a.expression_tags || a.expressionTags,
          cognitiveOverrides: a.cognitive_overrides || a.cognitiveOverrides,
        });
        return { result: `Persona created: ${persona.name} (id=${persona.id})` };
      },

      update_persona: async (a) => {
        if (!a.id) return { result: "Missing persona id", error: true };
        const { personaStorage } = await import("./file-storage/persona-storage");
        const updated = await personaStorage.update(Number(a.id), {
          name: a.name,
          description: a.description,
          promptOverlay: a.prompt_overlay || a.promptOverlay,
          expressionTags: a.expression_tags || a.expressionTags,
          cognitiveOverrides: a.cognitive_overrides || a.cognitiveOverrides,
        });
        if (!updated) return { result: `Persona ${a.id} not found`, error: true };
        return { result: `Persona updated: ${updated.name} (id=${updated.id})` };
      },
    };

    const handler = sub[action];
    if (!handler) return { result: `Unknown cognition action: ${action}. Available: ${Object.keys(sub).join(", ")}`, error: true };
    try {
      return await handler(args);
    } catch (err: any) {
      return { result: `cognition.${action} error: ${err.message}`, error: true };
    }
  },

  async backup(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };

    const { createBackup, listBackups, getBackup, deleteBackup } = await import("./backup-storage");

    try {
      switch (action) {
        case "create": {
          const job = await createBackup("manual");
          return { result: `Backup started. Job ID: ${job.id}\nStatus: ${job.status}\nThe backup is running in the background. Use \`backup list\` to check progress.` };
        }
        case "list": {
          const limit = Number(args.limit) || 20;
          const backups = await listBackups(limit);
          if (backups.length === 0) return { result: "No backups found." };
          const lines = backups.map((b: any) => {
            const date = new Date(b.created_at).toLocaleString();
            const size = b.compressed_size ? `${(b.compressed_size / 1024 / 1024).toFixed(1)} MB` : "—";
            return `${b.id} | ${date} | ${b.trigger_type} | ${b.status} | ${size} | ${b.table_count ?? "—"} tables | ${b.total_rows ?? "—"} rows | ${b.duration_ms ? `${(b.duration_ms / 1000).toFixed(1)}s` : "—"}`;
          });
          return { result: `Backups (${backups.length}):\n${lines.join("\n")}` };
        }
        case "get": {
          if (!args.id) return { result: "Missing id parameter", error: true };
          const backup = await getBackup(args.id);
          if (!backup) return { result: `Backup ${args.id} not found`, error: true };
          let detail = `Backup: ${backup.id}\nStatus: ${backup.status}\nTrigger: ${backup.trigger_type}\nCreated: ${backup.created_at}\nSize: ${backup.compressed_size ? `${(backup.compressed_size / 1024 / 1024).toFixed(1)} MB` : "—"}\nTables: ${backup.table_count ?? "—"}\nRows: ${backup.total_rows ?? "—"}\nDuration: ${backup.duration_ms ? `${(backup.duration_ms / 1000).toFixed(1)}s` : "—"}`;
          if (backup.error) detail += `\nError: ${backup.error}`;
          if (backup.table_manifest && typeof backup.table_manifest === "object") {
            const entries = Object.entries(backup.table_manifest);
            if (entries.length > 0 && entries.length <= 120) {
              detail += "\n\nTable manifest:";
              for (const [table, info] of entries) {
                detail += `\n  ${table}: ${(info as any).rows ?? "?"} rows`;
              }
            }
          }
          return { result: detail };
        }
        case "restore": {
          return {
            result: "backup.restore is not available to agents, including dry-run restore. Use the human Dev Database restore flow for any restore operation.",
            error: true,
          };
        }
        case "delete": {
          if (!args.id) return { result: "Missing id parameter", error: true };
          await deleteBackup(args.id);
          return { result: `Backup ${args.id} deleted.` };
        }
        default:
          return { result: `Unknown backup action: ${action}. Available: create, list, get, delete`, error: true };
      }
    } catch (err: any) {
      return { result: `backup.${action} error: ${err.message}`, error: true };
    }
  },
};

const localHandlers: Record<string, ToolHandler> = {
  phone_call: phoneCallHandler,
  ...workspaceTools,
  ...persistentFileTools,
  ...systemTools,
  ...webTools,
  ...memoryTools,
  ...codeIntelTools,
  ...umbrellaHandlers,
  ...cognitionTools,
};

const DISPATCH_MAP: Record<string, ToolHandler> = {
  ...localHandlers,
  ...bridgeHandlers,
};


function isEmptyToolArgumentValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const values = Object.values(value as Record<string, unknown>);
    return values.length === 0 || values.every(isEmptyToolArgumentValue);
  }
  return false;
}

function normalizeToolArgs(toolName: string, args: Record<string, any>): Record<string, any> {
  const schemas = getToolSchemas();
  const schema = schemas.find(s => s.name === toolName);
  const required = new Set(schema?.parameters?.required ?? []);

  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (required.has(key)) {
      normalized[key] = value;
      continue;
    }
    if (isEmptyToolArgumentValue(value)) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function validateToolArgs(
  toolName: string,
  args: Record<string, any>,
): { valid: boolean; error?: string } {
  const schemas = getToolSchemas();
  const schema = schemas.find(s => s.name === toolName);
  if (!schema?.parameters) return { valid: true };

  const { required, properties } = schema.parameters;
  if (required) {
    const missing = required.filter(p => args[p] === undefined || args[p] === null);
    if (missing.length > 0) {
      return { valid: false, error: `Missing required parameter(s): ${missing.join(", ")}` };
    }
  }

  if (properties) {
    const knownKeys = new Set(Object.keys(properties));
    const unknownKeys = Object.keys(args).filter(k => !knownKeys.has(k));
    if (unknownKeys.length > 0) {
      return { valid: false, error: `Unknown parameter(s) for ${toolName}: ${unknownKeys.join(", ")}. Allowed: ${[...knownKeys].join(", ")}` };
    }
  }

  return { valid: true };
}

const SIDE_EFFECT_ONLY_ACTIONS: Record<string, Set<string>> = {
  session: new Set(["set_status", "end", "send_message"]),
  companies: new Set(["create", "update", "delete", "add_person", "remove_person", "add_opportunity", "remove_opportunity"]),
  people: new Set(["create", "update", "merge", "add_note", "update_note", "delete_note", "log_interaction", "update_interaction", "delete_interaction", "set_daily_contact"]),
  calendar: new Set(["create", "update", "delete"]),
  memory: new Set(["write"]),
  priorities: new Set([]),
  settings: new Set(["set", "delete"]),
  observe: new Set(["pattern", "gap", "change", "connection", "opportunity"]),
  cognition: new Set(["set_emotion", "create_persona", "update_persona"]),
  pronunciation: new Set(["add", "update", "remove"]),
  decisions: new Set(["create", "update", "delete", "lock", "reopen", "add_update", "edit_update", "delete_update", "add_link", "remove_link"]),
  plan: new Set(["update_step", "add_steps", "pause", "unlink_session"]),
};

const SIDE_EFFECT_ONLY_TOOLS = new Set([
  "write_scratch", "edit_scratch", "write_file", "write_docx", "edit_docx", "clone_docx",
  "memory_write",
  "orient",
]);

function isSideEffectOnly(toolName: string, args: Record<string, any>): boolean {
  if (SIDE_EFFECT_ONLY_TOOLS.has(toolName)) return true;

  const actionSet = SIDE_EFFECT_ONLY_ACTIONS[toolName];
  if (actionSet) {
    const action = args.action as string;
    if (action && actionSet.has(action)) return true;
    if (toolName === "observe") return true;
  }

  return false;
}


type CodingSubdir = "client" | "server" | "mobile";
type CodingReferenceId = "root_agents" | "design_md" | `subdir_agents:${CodingSubdir}`;

type EngineeringContextRoot = {
  root: string;
  reason: string;
};

const ENGINEERING_TOOL_NAMES = new Set(["code", "shell", "git", "system", "railway", "sentry"]);
const ENGINEERING_REF_CACHE = new Map<string, Set<string>>();
const ENGINEERING_ROOT_REPO_HINTS = ["repos/", "AGENTS.md", "DESIGN.md", "npm run build", "git ", "server/", "client/", "mobile/", "shared/"];
const CODING_SUBDIRS: CodingSubdir[] = ["client", "server", "mobile"];

function shouldEnsureCodingContext(toolName: string, args: Record<string, any>): boolean {
  if (toolName === "code" || toolName === "git" || toolName === "railway") return true;
  if (toolName === "system") {
    const action = String(args.action || "");
    return ["logs", "log_files", "state", "events", "active_runs", "clear_active_run", "tool_stats"].includes(action);
  }
  if (toolName === "shell") {
    const command = String(args.command || "");
    return ENGINEERING_ROOT_REPO_HINTS.some(hint => command.includes(hint));
  }
  return ENGINEERING_TOOL_NAMES.has(toolName);
}

function collectPathHints(value: unknown, paths: Set<string>): void {
  if (typeof value === "string") {
    if (/(^|[\s'"`])(client|server|mobile|shared)\//.test(value) || value.includes("repos/")) {
      paths.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathHints(item, paths);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectPathHints(item, paths);
  }
}

function resolveUnderWorkspace(pathValue: string): string | null {
  const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  const resolved = resolve(WORKSPACE_DIR, trimmed);
  if (resolved === WORKSPACE_DIR || resolved.startsWith(`${WORKSPACE_DIR}/`)) return resolved;
  return null;
}

function repoRootFromResolvedPath(resolvedPath: string | null): string | null {
  if (!resolvedPath?.startsWith(`${WORKSPACE_DIR}/repos/`)) return null;
  const relativeRepoPath = relative(resolve(WORKSPACE_DIR, "repos"), resolvedPath);
  const [repoDir] = relativeRepoPath.split("/");
  if (!repoDir || repoDir === ".." || repoDir.includes("..")) return null;
  return resolve(WORKSPACE_DIR, "repos", repoDir);
}

function firstRepoPathFromCommand(command: string): string | null {
  const cdMatch = command.match(/(?:^|[;&|]\s*)cd\s+(['"]?)([^'"`\s;&|]+)\1/);
  if (cdMatch?.[2]) {
    const repoRoot = repoRootFromResolvedPath(resolveUnderWorkspace(cdMatch[2]));
    if (repoRoot) return repoRoot;
  }

  const absoluteRepoMatch = command.match(/\/app\/repos\/[^\s'"`;&|)]+/);
  if (absoluteRepoMatch?.[0]) {
    const repoRoot = repoRootFromResolvedPath(resolveUnderWorkspace(absoluteRepoMatch[0]));
    if (repoRoot) return repoRoot;
  }

  const relativeRepoMatch = command.match(/(?:^|[\s'"`])(repos\/[^\s'"`;&|)]+)/);
  if (relativeRepoMatch?.[1]) {
    const repoRoot = repoRootFromResolvedPath(resolveUnderWorkspace(relativeRepoMatch[1]));
    if (repoRoot) return repoRoot;
  }

  return null;
}

function resolveEngineeringContextRoot(toolName: string, args: Record<string, any>): EngineeringContextRoot {
  if (toolName === "shell") {
    const commandRoot = firstRepoPathFromCommand(String(args.command || ""));
    if (commandRoot) return { root: commandRoot, reason: "shell command targets repos clone" };
  }

  if (toolName === "git") {
    const action = String(args.action || "").trim();
    if (action === "clone") {
      return { root: WORKSPACE_DIR, reason: "git clone runs before target repo instructions exist" };
    }

    const directory = String(args.directory || "").trim();
    if (directory && directory !== "." && directory !== "self") {
      const repoRoot = directory.startsWith("repos/")
        ? resolveUnderWorkspace(directory)
        : resolveUnderWorkspace(`repos/${directory}`);
      if (repoRoot?.startsWith(`${WORKSPACE_DIR}/repos/`)) return { root: repoRoot, reason: "git directory targets repos clone" };
    }
  }

  return { root: WORKSPACE_DIR, reason: "workspace root default" };
}

function touchedCodingSubdirs(args: Record<string, any>): CodingSubdir[] {
  const pathHints = new Set<string>();
  collectPathHints(args, pathHints);
  const combined = [...pathHints, String(args.command || "")].join("\n");
  return CODING_SUBDIRS.filter(dir => combined.includes(`${dir}/`));
}

function requiredCodingReferences(toolName: string, args: Record<string, any>): CodingReferenceId[] {
  const refs = new Set<CodingReferenceId>(["root_agents"]);
  for (const dir of touchedCodingSubdirs(args)) refs.add(`subdir_agents:${dir}`);

  const pathHints = new Set<string>();
  collectPathHints(args, pathHints);
  const combined = [...pathHints, String(args.command || "")].join("\n");
  if (/(^|[\s'"`])(client|mobile)\//.test(combined) || /context-page|session-details|component|tsx|css|DESIGN\.md/.test(combined)) refs.add("design_md");
  return [...refs];
}

function cacheKeyForContext(root: string, context?: BridgeToolContext): string {
  return `${context?.sessionId || context?.sessionKey || "global"}:${root}`;
}

async function readInstructionFile(root: string, relativePath: string): Promise<string> {
  const absolutePath = resolve(root, relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
    throw new Error(`Instruction path escapes context root: ${relativePath}`);
  }
  return readFile(absolutePath, "utf-8");
}

async function loadSubdirAgent(root: string, dir: CodingSubdir): Promise<string> {
  const relativePath = `${dir}/AGENTS.md`;
  const absolutePath = resolve(root, relativePath);
  if (!(await pathExists(absolutePath))) {
    return `\n## ${relativePath}\n\n_Not found under effective root ${root}. Continuing because subtree AGENTS files are optional unless repository policy declares them required._`;
  }
  return `\n## ${relativePath}\n\n${await readInstructionFile(root, relativePath)}`;
}

async function ensureCodingContextLoaded(
  toolName: string,
  args: Record<string, any>,
  context?: BridgeToolContext,
): Promise<string | null> {
  if (!shouldEnsureCodingContext(toolName, args)) return null;

  const contextRoot = resolveEngineeringContextRoot(toolName, args);
  const requiredRefs = requiredCodingReferences(toolName, args);
  const cacheKey = cacheKeyForContext(contextRoot.root, context);
  const loadedRefs = ENGINEERING_REF_CACHE.get(cacheKey) || new Set<string>();
  const missing = requiredRefs.filter(ref => !loadedRefs.has(ref));
  if (missing.length === 0) return null;

  const parts: string[] = [
    "# Engineering Context Preflight",
    `The runtime loaded the required coding context before executing this engineering tool.`,
    `Effective root: ${contextRoot.root} (${contextRoot.reason}).`,
  ];

  // AGENTS.md is advisory: load if present, note if absent, never block
  if (missing.includes("root_agents")) {
    try {
      parts.push(`\n## AGENTS.md\n\n${await readInstructionFile(contextRoot.root, "AGENTS.md")}`);
      loadedRefs.add("root_agents");
    } catch {
      parts.push(`\n## AGENTS.md\n\n_AGENTS.md not found under ${contextRoot.root}; proceeding without repo-specific architecture context. Universal coding process is loaded from Library._`);
      loadedRefs.add("root_agents");
    }
  }

  const subdirRefs = missing.filter((ref): ref is `subdir_agents:${CodingSubdir}` => ref.startsWith("subdir_agents:"));
  for (const ref of subdirRefs) {
    const dir = ref.slice("subdir_agents:".length) as CodingSubdir;
    parts.push(await loadSubdirAgent(contextRoot.root, dir));
    loadedRefs.add(ref);
  }

  if (missing.includes("design_md")) {
    let designLoaded = false;

    // Strategy 1: Load from environment context artifact (kind = 'design_system')
    try {
      const { db } = await import("./db");
      const { eq } = await import("drizzle-orm");
      const { environmentContextArtifacts } = await import("@shared/models/platforms");
      const { libraryPages } = await import("@shared/models/info");

      const artifactRows = await db
        .select({ libraryPageId: environmentContextArtifacts.libraryPageId })
        .from(environmentContextArtifacts)
        .where(eq(environmentContextArtifacts.kind, "design_system"));

      if (artifactRows.length > 0) {
        const { inArray } = await import("drizzle-orm");
        const pageIds = artifactRows.map(r => r.libraryPageId);
        const pages = await db
          .select({ id: libraryPages.id, content: libraryPages.plainTextContent })
          .from(libraryPages)
          .where(inArray(libraryPages.id, pageIds));

        const contents = pages.filter(p => p.content).map(p => p.content!.trim());
        if (contents.length > 0) {
          parts.push(`\n## DESIGN.md\n\n${contents.join("\n\n---\n\n")}`);
          designLoaded = true;
        }
      }
    } catch {
      // Fall through to filesystem
    }

    // Strategy 2: Filesystem fallback
    if (!designLoaded) {
      try {
        parts.push(`\n## DESIGN.md\n\n${await readInstructionFile(contextRoot.root, "DESIGN.md")}`);
        designLoaded = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Required coding context missing: DESIGN.md under ${contextRoot.root} (${message})`);
      }
    }

    if (designLoaded) loadedRefs.add("design_md");
  }

  ENGINEERING_REF_CACHE.set(cacheKey, loadedRefs);
  eventBus.publish({
    category: "agent",
    event: "tool:coding_context_loaded",
    payload: {
      toolName,
      refs: [...loadedRefs],
      effectiveRoot: contextRoot.root,
      effectiveRootReason: contextRoot.reason,
      sessionId: context?.sessionId,
      sessionKey: context?.sessionKey,
    },
  });
  return parts.join("\n\n");
}

export async function executeTool(
  toolName: string,
  toolCallId: string,
  args: Record<string, any>,
  context?: BridgeToolContext,
): Promise<ToolResult> {
  const startTime = Date.now();

  // Resolve tool name aliases (canonical → legacy handler)
  const { TOOL_ALIASES } = require("./tool-registry");
  const resolvedName = TOOL_ALIASES[toolName] || toolName;
  const handler = DISPATCH_MAP[resolvedName];
  if (!handler) {
    const durationMs = Date.now() - startTime;
    toolExec.log(`rejected tool=${toolName} callId=${toolCallId} reason=unknown_tool`);
    return { result: `Unknown tool: ${toolName}`, error: true, sideEffectOnly: true, durationMs };
  }
  const normalizedArgs = normalizeToolArgs(resolvedName, args);
  const droppedEmptyKeys = Object.keys(args ?? {}).filter((key) => !(key in normalizedArgs));
  if (droppedEmptyKeys.length > 0) {
    toolExec.verbose(() => `normalized tool=${toolName} callId=${toolCallId} droppedEmptyKeys=${droppedEmptyKeys.join(",")}`);
  }

  const validation = validateToolArgs(resolvedName, normalizedArgs);
  if (!validation.valid) {
    const durationMs = Date.now() - startTime;
    toolExec.log(`rejected tool=${toolName} callId=${toolCallId} reason=${validation.error}`);
    return { result: validation.error!, error: true, durationMs };
  }

  toolExec.verbose(() => `dispatch tool=${toolName} callId=${toolCallId} argKeys=${Object.keys(normalizedArgs).join(",")}`);

  const enrichedArgs = { ...normalizedArgs };
  // Universal _sessionId/_sessionKey injection — all tools get session context
  if (context?.sessionId) enrichedArgs._sessionId = context.sessionId;
  if (context?.sessionKey) enrichedArgs._sessionKey = context.sessionKey;
  if (resolvedName === "orient" && context?.orientationPersonaPolicy) {
    enrichedArgs._orientationPersonaPolicy = context.orientationPersonaPolicy;
  }
  if (toolName === "converse" && enrichedArgs.action === "set_attention" && !enrichedArgs.sessionId && context?.sessionId) {
    enrichedArgs.sessionId = context.sessionId;
  }

  let codingContextPrelude: string | null = null;
  try {
    codingContextPrelude = await ensureCodingContextLoaded(resolvedName, enrichedArgs, context);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    toolExec.warn(`rejected tool=${toolName} callId=${toolCallId} reason=coding_context_missing error=${err.message}`);
    return { result: `Engineering preflight blocked tool execution: ${err.message}`, error: true, durationMs };
  }

  recordToolCallStart(toolCallId, toolName);
  let _wwTrackEnd: ((id: string) => void) | null = null;
  try {
    const ww = require("./wedge-watchdog");
    ww.trackToolDispatchStart(toolCallId, toolName, context?.sessionId);
    _wwTrackEnd = ww.trackToolDispatchEnd;
  } catch { /* watchdog not available */ }

  try {
    const outcome = await handler(enrichedArgs);
    const durationMs = Date.now() - startTime;
    recordToolCallEnd(toolCallId, !!outcome.error);
    _wwTrackEnd?.(toolCallId);
    const sideEffectOnly = !outcome.error && isSideEffectOnly(resolvedName, normalizedArgs);
    const resultWithPrelude = codingContextPrelude
      ? `${codingContextPrelude}

---

# Tool Result

${outcome.result}`
      : outcome.result;
    // Fast non-error completions are verbose; slow (>=5s) or errored are info
    if (!outcome.error && durationMs < 5000) {
      toolExec.verbose(() => `complete tool=${toolName} callId=${toolCallId} duration=${durationMs}ms sideEffectOnly=${sideEffectOnly} resultLen=${resultWithPrelude?.length}`);
    } else {
      toolExec.log(`complete tool=${toolName} callId=${toolCallId} duration=${durationMs}ms error=${!!outcome.error} sideEffectOnly=${sideEffectOnly} resultLen=${resultWithPrelude?.length}`);
    }
    return { ...outcome, result: resultWithPrelude, sideEffectOnly, durationMs };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    recordToolCallEnd(toolCallId, true);
    _wwTrackEnd?.(toolCallId);
    toolExec.error(`complete tool=${toolName} callId=${toolCallId} duration=${durationMs}ms error=true exception=${err.message}`);
    return { result: `Tool execution error: ${err.message}`, error: true, durationMs };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function matchesGlob(str: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(str);
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]*(?:display\s*:\s*none|pointer-events-none|opacity-0|aria-hidden\s*=\s*"true")[^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    .replace(/<[^>]*\bclass\s*=\s*"[^"]*\bhidden\b[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|blockquote|details|summary|figcaption|figure|pre|dd|dt)>/gi, "\n")
    .replace(/<(?:p|div|h[1-6]|ul|ol|section|article|blockquote|details|table|pre)[\s>]/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#\d+;/g, "");

  text = text
    .replace(/<\/?(?:strong|em|b|i|u|span|a|mark|small|sub|sup|code|abbr|cite|q|s|del|ins|kbd|var|samp|bdi|bdo|wbr|ruby|rt|rp|data|time|dfn)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ");

  text = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/^ +| +$/gm, "");

  const lines = text.split("\n");
  const cleaned = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^(?:class|style|id|data-|aria-|role|tabindex|onclick|href)\s*=/.test(trimmed)) return false;
    if (/^[a-z-]+\s*:\s*[^;]+;\s*$/i.test(trimmed) && trimmed.length < 80) return false;
    if (/^[{}()\[\]<>]+$/.test(trimmed)) return false;
    if (/^(?:var|const|let|function|return|if|else|for|while)\s/.test(trimmed)) return false;
    return true;
  });

  return cleaned.join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
