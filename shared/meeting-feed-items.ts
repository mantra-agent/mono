import type { SimpleFeedItem, SimpleSection, SimpleSourceRef } from "./models/simple";
import { createReferenceRef } from "./references";
import { sourceRefsToReferenceRefs } from "./simple-references";

export interface MeetingAttendeePromotion {
  eventId: string;
  accountId: string;
  calendarId: string;
}

export interface MeetingPersonChildInput {
  key: string;
  section: SimpleSection;
  parentSourceRef: SimpleSourceRef;
  name: string;
  email?: string | null;
  responseStatus?: string | null;
  personId?: string | null;
  profileSummary?: string | null;
  lastInteractionContext?: string | null;
  promotion?: MeetingAttendeePromotion | null;
}

export interface MeetingArtifactChildInput {
  key: string;
  section: SimpleSection;
  title: string;
  libraryPageId: string;
  slug: string;
  artifactKind: string;
  source?: string | null;
  summary?: string | null;
  oneLiner?: string | null;
}

export function formatMeetingInviteeName(displayName: string | null | undefined, email: string): string {
  const source = displayName?.trim() || email.split("@")[0]?.replace(/[._]+/g, " ") || email;
  return source
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(word => {
      if (!word || (!/^[a-z]+(?:[-'][a-z]+)*$/i.test(word))) return word;
      if (word !== word.toLowerCase() && word !== word.toUpperCase()) return word;
      return word
        .toLowerCase()
        .split(/([-'])/)
        .map(part => part === "-" || part === "'" ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join("");
    })
    .join(" ");
}

export function dedupeMeetingInvitees<T>(
  invitees: T[],
  identity: (invitee: T) => { personId?: string | null; email: string },
): T[] {
  const seenPersonIds = new Set<string>();
  const seenEmails = new Set<string>();
  return invitees.filter(invitee => {
    const resolved = identity(invitee);
    const personId = resolved.personId?.trim() || null;
    const email = resolved.email.trim().toLowerCase();
    if ((personId && seenPersonIds.has(personId)) || (email && seenEmails.has(email))) return false;
    if (personId) seenPersonIds.add(personId);
    if (email) seenEmails.add(email);
    return true;
  });
}

export function createMeetingPersonChild(input: MeetingPersonChildInput): SimpleFeedItem {
  const personSourceRef: SimpleSourceRef | null = input.personId
    ? { type: "person", id: input.personId, label: input.name, href: `/people/${input.personId}` }
    : null;

  return {
    id: input.key,
    section: input.section,
    widgetType: "generic",
    title: input.name,
    status: "active",
    sourceRefs: personSourceRef ? [personSourceRef] : [input.parentSourceRef],
    ...(personSourceRef ? { references: sourceRefsToReferenceRefs([personSourceRef]) } : {}),
    payload: {
      kind: "meeting_attendee",
      email: input.email ?? null,
      responseStatus: input.responseStatus ?? null,
      personId: input.personId ?? null,
      profileSummary: input.profileSummary ?? null,
      lastInteractionContext: input.lastInteractionContext ?? null,
      promotion: input.promotion ?? null,
    },
  };
}

export function createMeetingArtifactChild(input: MeetingArtifactChildInput): SimpleFeedItem {
  const href = `/info#library?page=${encodeURIComponent(input.slug)}`;
  const artifactSourceRef: SimpleSourceRef = {
    type: "artifact",
    id: input.libraryPageId,
    label: input.title,
    href,
  };

  return {
    id: input.key,
    section: input.section,
    widgetType: "generic",
    title: input.title,
    status: "active",
    sourceRefs: [artifactSourceRef],
    references: [createReferenceRef({
      type: "page",
      id: input.libraryPageId,
      metadata: { label: input.title, href },
    })],
    payload: {
      kind: "meeting_artifact",
      artifactKind: input.artifactKind,
      pageId: input.libraryPageId,
      slug: input.slug,
      source: input.source ?? null,
      artifactSummary: input.summary ?? null,
      artifactOneLiner: input.oneLiner ?? null,
    },
    actions: [{ id: "open-artifact", label: "Open", type: "navigate", href, sourceRef: artifactSourceRef }],
  };
}
