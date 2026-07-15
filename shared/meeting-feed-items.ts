import type { SimpleFeedItem, SimpleSection, SimpleSourceRef } from "./models/simple";
import { createReferenceRef } from "./references";
import { sourceRefsToReferenceRefs } from "./simple-references";

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
