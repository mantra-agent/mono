import { and, inArray } from "drizzle-orm";
import { libraryPages } from "@shared/models/info";
import type { MeetingSessionMeta } from "@shared/models/chat";
import { db } from "../db";
import { createLogger } from "../log";
import { getCurrentPrincipal } from "../principal-context";
import { visibleScopePredicate } from "../scoped-storage";
import { getEvent, type CalendarEvent } from "../google-calendar";
import {
  getLinkedArtifacts,
  getLinkedPeople,
  getMetadata,
} from "../calendar-metadata";
import { PeopleStorage, type Interaction } from "../people-storage";

const log = createLogger("MeetingContextPacket");
const MAX_ATTENDEES = 20;
const MAX_ARTIFACTS = 12;
const MAX_INTERACTIONS_PER_PERSON = 3;
const MAX_DESCRIPTION_CHARS = 1_200;
const MAX_SUMMARY_CHARS = 500;

interface MeetingContextArtifact {
  id: string;
  title: string;
  kind: string;
  summary?: string;
}

interface MeetingContextAttendee {
  label: string;
  email?: string;
  personId?: string;
  recentInteractions: Interaction[];
}

export interface MeetingContextPacket {
  version: 1;
  identity: {
    accountId: string;
    calendarId: string;
    providerEventId: string;
  };
  event: {
    title: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
    conferencingUrl?: string;
  };
  notes?: string;
  agenda?: string;
  attendees: MeetingContextAttendee[];
  artifacts: MeetingContextArtifact[];
  unresolvedAttendees: string[];
  unresolvedArtifacts: string[];
}

function bounded(value: string | null | undefined, max: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function meetingIdentity(meeting: MeetingSessionMeta) {
  if (!meeting.calendarAccountId || !meeting.calendarId || !meeting.providerEventId) return null;
  return {
    accountId: meeting.calendarAccountId,
    calendarId: meeting.calendarId,
    providerEventId: meeting.providerEventId,
  };
}

async function resolveArtifacts(metadataId: number): Promise<{ artifacts: MeetingContextArtifact[]; unresolved: string[] }> {
  const links = (await getLinkedArtifacts(metadataId)).slice(0, MAX_ARTIFACTS);
  if (links.length === 0) return { artifacts: [], unresolved: [] };
  const principal = getCurrentPrincipal();
  if (!principal) throw new Error("Meeting context requires an explicit principal");
  const ids = [...new Set(links.map(link => link.libraryPageId))];
  const pages = await db
    .select({
      id: libraryPages.id,
      title: libraryPages.title,
      oneLiner: libraryPages.oneLiner,
      summary: libraryPages.summary,
      plainTextContent: libraryPages.plainTextContent,
    })
    .from(libraryPages)
    .where(and(
      inArray(libraryPages.id, ids),
      visibleScopePredicate(principal, {
        scope: libraryPages.scope,
        ownerUserId: libraryPages.ownerUserId,
        accountId: libraryPages.accountId,
      }),
    ));
  const byId = new Map(pages.map(page => [page.id, page]));
  const artifacts: MeetingContextArtifact[] = [];
  const unresolved: string[] = [];
  for (const link of links) {
    const page = byId.get(link.libraryPageId);
    if (!page) {
      unresolved.push(`${link.title || link.libraryPageId} (${link.libraryPageId})`);
      continue;
    }
    artifacts.push({
      id: page.id,
      title: link.title || page.title || "Meeting artifact",
      kind: link.artifactKind,
      summary: bounded(page.oneLiner || page.summary || page.plainTextContent, MAX_SUMMARY_CHARS),
    });
  }
  return { artifacts, unresolved };
}

async function resolveAttendees(event: CalendarEvent, metadataId: number): Promise<{ attendees: MeetingContextAttendee[]; unresolved: string[] }> {
  const linkedPeople = await getLinkedPeople(metadataId);
  const personStorage = new PeopleStorage();
  const people = await personStorage.getPeopleByIds(linkedPeople.map(link => link.personId));
  const peopleById = new Map(people.map(person => [person.id, person]));
  const linksByEmail = new Map(linkedPeople.filter(link => link.attendeeEmail).map(link => [link.attendeeEmail!.toLowerCase(), link]));
  const eventAttendees = event.attendees.filter(attendee => !attendee.self).slice(0, MAX_ATTENDEES);
  const attendees: MeetingContextAttendee[] = [];
  const unresolved: string[] = [];
  const seenPeople = new Set<string>();

  for (const attendee of eventAttendees) {
    const link = linksByEmail.get(attendee.email.toLowerCase());
    const person = link ? peopleById.get(link.personId) : undefined;
    const label = attendee.displayName || person?.name || attendee.email;
    if (!person || !link) {
      attendees.push({ label, email: attendee.email, recentInteractions: [] });
      unresolved.push(`${label} <${attendee.email}>`);
      continue;
    }
    seenPeople.add(person.id);
    attendees.push({
      label: person.name,
      email: attendee.email,
      personId: person.id,
      recentInteractions: [...person.interactions]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, MAX_INTERACTIONS_PER_PERSON),
    });
  }

  for (const link of linkedPeople) {
    if (seenPeople.has(link.personId) || attendees.length >= MAX_ATTENDEES) continue;
    const person = peopleById.get(link.personId);
    if (!person) continue;
    attendees.push({
      label: person.name,
      email: link.attendeeEmail ?? undefined,
      personId: person.id,
      recentInteractions: [...person.interactions]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, MAX_INTERACTIONS_PER_PERSON),
    });
  }

  return { attendees, unresolved: [...new Set(unresolved)] };
}

export async function buildMeetingContextPacket(meeting: MeetingSessionMeta): Promise<MeetingContextPacket | null> {
  const principal = getCurrentPrincipal();
  if (!principal?.userId) throw new Error("Meeting context requires a user principal");
  const identity = meetingIdentity(meeting);
  if (!identity) return null;

  const event = await getEvent(identity.accountId, identity.calendarId, identity.providerEventId);
  const metadata = await getMetadata(identity.providerEventId, identity.accountId, identity.calendarId);
  const [attendeeResolution, artifactResolution] = metadata
    ? await Promise.all([
        resolveAttendees(event, metadata.id),
        resolveArtifacts(metadata.id),
      ])
    : [
        {
          attendees: event.attendees.filter(attendee => !attendee.self).slice(0, MAX_ATTENDEES).map(attendee => ({
            label: attendee.displayName || attendee.email,
            email: attendee.email,
            recentInteractions: [],
          })),
          unresolved: event.attendees.filter(attendee => !attendee.self).slice(0, MAX_ATTENDEES).map(attendee =>
            `${attendee.displayName || attendee.email} <${attendee.email}>`,
          ),
        },
        { artifacts: [], unresolved: [] },
      ];

  const packet: MeetingContextPacket = {
    version: 1,
    identity,
    event: {
      title: event.summary || meeting.title || "Untitled meeting",
      start: event.start.dateTime || event.start.date || meeting.eventStart,
      end: event.end.dateTime || event.end.date || meeting.eventEnd,
      description: bounded(event.description, MAX_DESCRIPTION_CHARS),
      location: bounded(event.location, 300),
      conferencingUrl: event.hangoutLink || event.conferenceEntryPoints?.[0] || meeting.meetingUrl,
    },
    notes: bounded(metadata?.notes, 800),
    agenda: bounded(metadata?.agenda || meeting.agenda, 1_200),
    attendees: attendeeResolution.attendees,
    artifacts: artifactResolution.artifacts,
    unresolvedAttendees: attendeeResolution.unresolved,
    unresolvedArtifacts: artifactResolution.unresolved,
  };
  log.debug(`built version=${packet.version} event=${identity.providerEventId} attendees=${packet.attendees.length} artifacts=${packet.artifacts.length}`);
  return packet;
}

export function renderMeetingContextPacket(packet: MeetingContextPacket): string {
  const lines = [
    `Packet version: ${packet.version}`,
    `Calendar identity: ${packet.identity.accountId} / ${packet.identity.calendarId} / ${packet.identity.providerEventId}`,
    `Title: ${packet.event.title}`,
    `Time: ${packet.event.start || "unknown"} to ${packet.event.end || "unknown"}`,
  ];
  if (packet.event.location) lines.push(`Location: ${packet.event.location}`);
  if (packet.event.conferencingUrl) lines.push(`Conference: ${packet.event.conferencingUrl}`);
  if (packet.event.description) lines.push(`Description: ${packet.event.description}`);
  if (packet.notes) lines.push(`Calendar notes: ${packet.notes}`);
  if (packet.agenda) lines.push(`Private agenda: ${packet.agenda}`);

  lines.push("", "Expected attendees:");
  lines.push(...(packet.attendees.length ? packet.attendees.map(attendee => {
    const identity = attendee.personId ? ` @person:${attendee.personId}` : " [unresolved person]";
    const email = attendee.email ? ` <${attendee.email}>` : "";
    const interactions = attendee.recentInteractions.length
      ? ` Recent: ${attendee.recentInteractions.map(interaction => `${interaction.date}: ${bounded(interaction.summary, 180)}`).join(" | ")}`
      : "";
    return `- ${attendee.label}${email}${identity}.${interactions}`;
  }) : ["- None listed."]));

  lines.push("", "Linked Library artifacts:");
  lines.push(...(packet.artifacts.length ? packet.artifacts.map(artifact => `- @page:${artifact.id} [${artifact.kind}] ${artifact.title}${artifact.summary ? `: ${artifact.summary}` : ""}`) : ["- None linked."]));
  lines.push("", "Explicit unresolved links:");
  lines.push(`- Attendees: ${packet.unresolvedAttendees.length ? packet.unresolvedAttendees.join(", ") : "none"}`);
  lines.push(`- Artifacts: ${packet.unresolvedArtifacts.length ? packet.unresolvedArtifacts.join(", ") : "none"}`);
  return lines.join("\n");
}
