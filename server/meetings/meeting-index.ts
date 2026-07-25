import { and, inArray } from "drizzle-orm";
import type { MeetingParticipant } from "@shared/models/chat";
import type { SimpleFeedItem, SimpleSection, SimpleSourceRef } from "@shared/models/simple";
import { createMeetingArtifactChild, dedupeMeetingInvitees } from "@shared/meeting-feed-items";
import { sourceRefsToReferenceRefs } from "@shared/simple-references";
import { libraryPages } from "@shared/models/info";
import { chatFileStorage, type FileSession } from "../chat-file-storage";
import { getLinkedArtifactsByMetadataIds, listMetadataByEvents, makeMetaKey } from "../calendar-metadata";
import { db } from "../db";
import { buildEmailPersonContextMap, meetingInteractionContext, meetingPersonSummary, resolveMeetingArtifactContext } from "../meeting-context";
import { peopleStorage, type Person } from "../people-storage";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { visibleScopePredicate } from "../scoped-storage";
import { createLogger } from "../log";

const log = createLogger("MeetingIndex");

export type MeetingNotesFilter = "any" | "with_notes" | "without_notes";

export interface MeetingIndexFilter {
  query?: string;
  notesFilter?: MeetingNotesFilter;
  startAfter?: string;
  startBefore?: string;
  limit?: number;
  offset?: number;
}

export interface MeetingIndexParticipant {
  key: string | null;
  name: string;
  email: string | null;
  personId: string | null;
  profileSummary: string | null;
  lastInteractionContext: string | null;
}

export interface MeetingIndexArtifact {
  pageId: string;
  title: string;
  slug: string;
  artifactKind: string;
  source: string | null;
  summary: string | null;
  oneLiner: string | null;
}

export interface MeetingIndexRecord {
  id: string;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  platform: string | null;
  botStatus: string;
  transcriptCount: number;
  hasNotes: boolean;
  recapStatus: string | null;
  summary: string | null;
  participants: MeetingIndexParticipant[];
  artifacts: MeetingIndexArtifact[];
}

export interface MeetingIndexCounts {
  completedMeetingCount: number;
  completedMeetingsWithNotesCount: number;
  transcriptFragmentCount: number;
  recapReadyCount: number;
}

interface MeetingSessionSnapshot {
  session: FileSession;
  transcriptCount: number;
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(value!)));
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function meetingStart(session: FileSession): string | null {
  return session.meeting?.eventStart ?? session.meeting?.startedAt ?? session.createdAt ?? null;
}

function meetingTitle(session: FileSession): string {
  return session.meeting?.title?.trim() || session.title;
}

function matchesNotesFilter(transcriptCount: number, notesFilter: MeetingNotesFilter | undefined): boolean {
  if (!notesFilter || notesFilter === "any") return true;
  return notesFilter === "with_notes" ? transcriptCount > 0 : transcriptCount === 0;
}

function resolvedMeetingIdentity(session: FileSession): string | null {
  const meeting = session.meeting;
  const accountId = meeting?.calendarAccountId?.trim();
  const calendarId = meeting?.calendarId?.trim();
  const providerEventId = meeting?.providerEventId?.trim();
  if (!accountId || !calendarId || !providerEventId) return null;
  return `${accountId}\u0000${calendarId}\u0000${providerEventId}`;
}

function populated(value: unknown): number {
  return value === undefined || value === null || value === "" ? 0 : 1;
}

function meetingRichness(snapshot: MeetingSessionSnapshot): number {
  const meeting = snapshot.session.meeting!;
  const recap = meeting.recap;
  const participantCount = new Set(meeting.participants.map(participantIdentity)).size;
  const recapStatusScore = recap?.status === "ready" ? 2 : recap?.status === "generating" ? 1 : 0;
  const distributionScore = recap?.distributionStatus === "ready"
    ? 2
    : recap?.distributionStatus === "drafting" || recap?.distributionStatus === "pending" ? 1 : 0;

  return snapshot.transcriptCount
    + participantCount
    + (recap?.draftIds?.length ?? 0) * 2
    + (recap?.interactionsLogged ?? 0)
    + populated(recap?.pageId) * 3
    + recapStatusScore
    + distributionScore
    + populated(meeting.agendaPage?.id)
    + populated(meeting.recognition)
    + populated(meeting.botId);
}

function compareMeetingRichness(left: MeetingSessionSnapshot, right: MeetingSessionSnapshot): number {
  const scoreDifference = meetingRichness(left) - meetingRichness(right);
  if (scoreDifference !== 0) return scoreDifference;
  const updatedDifference = (parseDate(left.session.updatedAt) ?? 0) - (parseDate(right.session.updatedAt) ?? 0);
  if (updatedDifference !== 0) return updatedDifference;
  return left.session.id.localeCompare(right.session.id);
}

const DUPLICATE_START_TOLERANCE_MS = 10 * 60 * 1000;

function normalizedMeetingTitle(session: FileSession): string | null {
  const title = session.meeting?.title?.trim().toLowerCase().replace(/\s+/g, " ");
  return title || null;
}

function meetingTimeRange(session: FileSession): { start: number; end: number } | null {
  const meeting = session.meeting;
  const start = parseDate(meeting?.eventStart)
    ?? parseDate(meeting?.startedAt)
    ?? parseDate(session.createdAt);
  if (start === null) return null;
  const end = parseDate(meeting?.endedAt) ?? start + DUPLICATE_START_TOLERANCE_MS;
  return { start, end: Math.max(start, end) };
}

function isTerminalMeeting(session: FileSession): boolean {
  const status = session.meeting?.botStatus;
  return status === "ended" || status === "failed";
}

function representsSameMeeting(left: MeetingSessionSnapshot, right: MeetingSessionSnapshot): boolean {
  const leftIdentity = resolvedMeetingIdentity(left.session);
  const rightIdentity = resolvedMeetingIdentity(right.session);
  if (leftIdentity && rightIdentity && leftIdentity === rightIdentity) return true;
  const hasFailedAttempt = left.session.meeting?.botStatus === "failed"
    || right.session.meeting?.botStatus === "failed";
  if (leftIdentity && rightIdentity && !hasFailedAttempt) return false;

  const leftTitle = normalizedMeetingTitle(left.session);
  const rightTitle = normalizedMeetingTitle(right.session);
  if (!leftTitle || leftTitle !== rightTitle) return false;

  const leftRange = meetingTimeRange(left.session);
  const rightRange = meetingTimeRange(right.session);
  if (!leftRange || !rightRange) return false;
  if (Math.abs(leftRange.start - rightRange.start) > DUPLICATE_START_TOLERANCE_MS) return false;
  return leftRange.start <= rightRange.end && rightRange.start <= leftRange.end;
}

function canonicalCompletedMeetingSnapshots(snapshots: MeetingSessionSnapshot[]): MeetingSessionSnapshot[] {
  const candidates = snapshots
    .filter(snapshot => isTerminalMeeting(snapshot.session))
    .sort((left, right) => compareMeetingRichness(right, left));
  const passthrough = snapshots.filter(snapshot => !isTerminalMeeting(snapshot.session));
  const canonical: MeetingSessionSnapshot[] = [];
  const canonicalIdentities = new Set<string>();
  const canonicalByTitleBucket = new Map<string, MeetingSessionSnapshot[]>();

  for (const candidate of candidates) {
    const identity = resolvedMeetingIdentity(candidate.session);
    if (identity && canonicalIdentities.has(identity)) continue;

    const title = normalizedMeetingTitle(candidate.session);
    const range = meetingTimeRange(candidate.session);
    const startBucket = range ? Math.floor(range.start / DUPLICATE_START_TOLERANCE_MS) : null;
    const nearby = title && startBucket !== null
      ? [-1, 0, 1].flatMap(offset => canonicalByTitleBucket.get(`${title}\u0000${startBucket + offset}`) ?? [])
      : [];
    if (nearby.some(current => representsSameMeeting(candidate, current))) continue;

    canonical.push(candidate);
    if (identity) canonicalIdentities.add(identity);
    if (title && startBucket !== null) {
      const key = `${title}\u0000${startBucket}`;
      const bucket = canonicalByTitleBucket.get(key) ?? [];
      bucket.push(candidate);
      canonicalByTitleBucket.set(key, bucket);
    }
  }

  const collapsedCount = candidates.length - canonical.length;
  if (collapsedCount > 0) {
    log.debug("Collapsed duplicate terminal meeting sessions", {
      candidateCount: snapshots.length,
      canonicalCount: canonical.length + passthrough.length,
      collapsedCount,
    });
  }
  return [...canonical, ...passthrough];
}

async function hydrateMeetingSessions(): Promise<MeetingSessionSnapshot[]> {
  const indexed = (await chatFileStorage.getAllSessions()).filter(session => session.type === "meeting");
  const hydrated: MeetingSessionSnapshot[] = [];
  const concurrency = 8;

  for (let index = 0; index < indexed.length; index += concurrency) {
    const batch = indexed.slice(index, index + concurrency);
    const resolved = await Promise.all(batch.map(async session => {
      if (session.meeting && session.meetingTranscriptCount !== undefined) {
        return { session, transcriptCount: session.meetingTranscriptCount };
      }
      const exact = await chatFileStorage.getSession(session.id);
      if (!exact?.meeting) return null;
      return { session: exact, transcriptCount: exact.meetingTranscriptCount ?? 0 };
    }));
    for (const item of resolved) if (item) hydrated.push(item);
  }

  return canonicalCompletedMeetingSnapshots(hydrated);
}

function completedSnapshots(snapshots: MeetingSessionSnapshot[], filter: MeetingIndexFilter): MeetingSessionSnapshot[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const startAfter = parseDate(filter.startAfter);
  const startBefore = parseDate(filter.startBefore);

  return snapshots
    .filter(({ session, transcriptCount }) => {
      if (session.meeting?.botStatus !== "ended") return false;
      if (!matchesNotesFilter(transcriptCount, filter.notesFilter)) return false;
      const start = parseDate(meetingStart(session) ?? undefined);
      if (startAfter !== null && (start === null || start < startAfter)) return false;
      if (startBefore !== null && (start === null || start >= startBefore)) return false;
      if (!query) return true;
      const participantText = session.meeting.participants.flatMap(participant => [
        participant.label,
        participant.calendarEmail,
        participant.transportEmail,
      ]).filter(Boolean).join(" ");
      return `${meetingTitle(session)} ${participantText}`.toLowerCase().includes(query);
    })
    .sort((left, right) => {
      const leftTime = parseDate(meetingStart(left.session) ?? undefined) ?? 0;
      const rightTime = parseDate(meetingStart(right.session) ?? undefined) ?? 0;
      return rightTime - leftTime;
    });
}

function countsFor(snapshots: MeetingSessionSnapshot[]): MeetingIndexCounts {
  const completed = snapshots.filter(({ session }) => session.meeting?.botStatus === "ended");
  return {
    completedMeetingCount: completed.length,
    completedMeetingsWithNotesCount: completed.filter(item => item.transcriptCount > 0).length,
    transcriptFragmentCount: completed.reduce((sum, item) => sum + item.transcriptCount, 0),
    recapReadyCount: completed.filter(({ session }) => session.meeting?.recap?.status === "ready").length,
  };
}

function participantEmail(participant: MeetingParticipant): string | null {
  return participant.calendarEmail?.trim().toLowerCase()
    || participant.transportEmail?.trim().toLowerCase()
    || null;
}

function participantIdentity(participant: MeetingParticipant): string {
  return participant.personId?.trim()
    || participantEmail(participant)
    || participant.key?.trim()
    || participant.label.trim().toLowerCase();
}

function projectParticipants(
  session: FileSession,
  peopleById: Map<string, Person>,
  peopleByEmail: Awaited<ReturnType<typeof buildEmailPersonContextMap>>,
): MeetingIndexParticipant[] {
  const seen = new Set<string>();
  const projected: MeetingIndexParticipant[] = [];

  for (const participant of session.meeting?.participants ?? []) {
    const identity = participantIdentity(participant);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    const email = participantEmail(participant);
    const person = participant.personId ? peopleById.get(participant.personId) : undefined;
    const emailPerson = !person && email ? peopleByEmail.get(email) : undefined;
    projected.push({
      key: participant.key ?? null,
      name: person?.name ?? emailPerson?.name ?? participant.label,
      email,
      personId: person?.id ?? emailPerson?.id ?? null,
      profileSummary: person ? meetingPersonSummary(person) : emailPerson?.summary ?? null,
      lastInteractionContext: person ? meetingInteractionContext(person.interactions ?? []) : emailPerson?.lastInteractionContext ?? null,
    });
  }

  return projected;
}

async function artifactMapForSessions(sessions: FileSession[]): Promise<Map<string, MeetingIndexArtifact[]>> {
  const identities = sessions.flatMap(session => {
    const meeting = session.meeting;
    if (!meeting?.providerEventId || !meeting.calendarAccountId || !meeting.calendarId) return [];
    return [{
      sessionId: session.id,
      googleEventId: meeting.providerEventId,
      accountId: meeting.calendarAccountId,
      calendarId: meeting.calendarId,
    }];
  });
  const metadata = await listMetadataByEvents(identities);
  const metadataByKey = new Map(metadata.map(row => [makeMetaKey(row.googleEventId, row.accountId, row.calendarId), row]));
  const links = await getLinkedArtifactsByMetadataIds(metadata.map(row => row.id));
  const linkedArtifacts = await resolveMeetingArtifactContext(links);
  const linkedByMetadataId = new Map<number, MeetingIndexArtifact[]>();
  for (const artifact of linkedArtifacts) {
    const list = linkedByMetadataId.get(artifact.metadataId) ?? [];
    list.push({
      pageId: artifact.libraryPageId,
      title: artifact.title,
      slug: artifact.slug,
      artifactKind: artifact.artifactKind,
      source: artifact.source,
      summary: artifact.summary,
      oneLiner: artifact.oneLiner,
    });
    linkedByMetadataId.set(artifact.metadataId, list);
  }

  const directPageIds = Array.from(new Set(sessions.flatMap(session => [
    session.meeting?.agendaPage?.id,
    session.meeting?.recap?.pageId,
  ].filter((id): id is string => Boolean(id)))));
  const directPages = directPageIds.length === 0 ? [] : await db
    .select({
      id: libraryPages.id,
      title: libraryPages.title,
      slug: libraryPages.slug,
      summary: libraryPages.summary,
      oneLiner: libraryPages.oneLiner,
      plainTextContent: libraryPages.plainTextContent,
    })
    .from(libraryPages)
    .where(and(
      inArray(libraryPages.id, directPageIds),
      visibleScopePredicate(getCurrentPrincipalOrSystem(), {
        scope: libraryPages.scope,
        ownerUserId: libraryPages.ownerUserId,
        accountId: libraryPages.accountId,
        vaultId: libraryPages.vaultId,
      }),
    ));
  const directPagesById = new Map(directPages.map(page => [page.id, page]));

  const result = new Map<string, MeetingIndexArtifact[]>();
  for (const session of sessions) {
    const artifacts: MeetingIndexArtifact[] = [];
    const meeting = session.meeting!;
    if (meeting.providerEventId && meeting.calendarAccountId && meeting.calendarId) {
      const meta = metadataByKey.get(makeMetaKey(meeting.providerEventId, meeting.calendarAccountId, meeting.calendarId));
      if (meta) artifacts.push(...(linkedByMetadataId.get(meta.id) ?? []));
    }
    for (const direct of [
      meeting.agendaPage?.id ? { id: meeting.agendaPage.id, kind: "agenda", source: "meeting_session" } : null,
      meeting.recap?.pageId ? { id: meeting.recap.pageId, kind: "recap", source: "meeting_recap" } : null,
    ]) {
      if (!direct) continue;
      const page = directPagesById.get(direct.id);
      if (!page) continue;
      artifacts.push({
        pageId: page.id,
        title: page.title,
        slug: page.slug,
        artifactKind: direct.kind,
        source: direct.source,
        summary: page.summary?.trim() || page.plainTextContent?.trim() || null,
        oneLiner: page.oneLiner?.trim() || null,
      });
    }
    result.set(session.id, Array.from(new Map(artifacts.map(artifact => [artifact.pageId, artifact])).values()));
  }
  return result;
}

async function projectRecords(snapshots: MeetingSessionSnapshot[]): Promise<MeetingIndexRecord[]> {
  if (snapshots.length === 0) return [];
  const personIds = Array.from(new Set(snapshots.flatMap(({ session }) =>
    (session.meeting?.participants ?? []).map(participant => participant.personId).filter((id): id is string => Boolean(id)),
  )));
  const [people, peopleByEmail, artifactsBySession] = await Promise.all([
    peopleStorage.getPeopleByIds(personIds),
    buildEmailPersonContextMap(),
    artifactMapForSessions(snapshots.map(item => item.session)),
  ]);
  const peopleById = new Map(people.map(person => [person.id, person]));

  return snapshots.map(({ session, transcriptCount }) => {
    const artifacts = artifactsBySession.get(session.id) ?? [];
    const recap = artifacts.find(artifact => artifact.artifactKind === "recap");
    return {
      id: session.id,
      title: meetingTitle(session),
      startedAt: meetingStart(session),
      endedAt: session.meeting?.endedAt ?? null,
      platform: session.meeting?.platform ?? null,
      botStatus: session.meeting?.botStatus ?? "unknown",
      transcriptCount,
      hasNotes: transcriptCount > 0,
      recapStatus: session.meeting?.recap?.status ?? null,
      summary: recap?.summary ?? recap?.oneLiner ?? null,
      participants: projectParticipants(session, peopleById, peopleByEmail),
      artifacts,
    };
  });
}

export async function listCompletedMeetings(filter: MeetingIndexFilter = {}): Promise<{
  meetings: MeetingIndexRecord[];
  total: number;
  counts: MeetingIndexCounts;
}> {
  const snapshots = await hydrateMeetingSessions();
  const filtered = completedSnapshots(snapshots, filter);
  const offset = boundedInteger(filter.offset, 0, 100_000);
  const limit = boundedInteger(filter.limit, 50, 100) || 50;
  return {
    meetings: await projectRecords(filtered.slice(offset, offset + limit)),
    total: filtered.length,
    counts: countsFor(snapshots),
  };
}

export async function getMeetingRecord(id: string): Promise<MeetingIndexRecord | null> {
  const session = await chatFileStorage.getSession(id);
  if (!session?.meeting || session.type !== "meeting") return null;
  const transcriptCount = session.meetingTranscriptCount ?? 0;
  return (await projectRecords([{ session, transcriptCount }]))[0] ?? null;
}

export async function getMeetingCounts(): Promise<MeetingIndexCounts> {
  return countsFor(await hydrateMeetingSessions());
}

export function meetingRecordToSimpleFeedItem(
  meeting: MeetingIndexRecord,
  section: SimpleSection = "earlier",
  index = 0,
): SimpleFeedItem {
  const sourceRef: SimpleSourceRef = {
    type: "meeting",
    id: meeting.id,
    label: meeting.title,
    href: `/session?c=${encodeURIComponent(meeting.id)}`,
    observedAt: meeting.startedAt ?? undefined,
  };
  const attendees = dedupeMeetingInvitees(meeting.participants, participant => ({
    personId: participant.personId,
    email: participant.email ?? participant.key ?? participant.name,
  }));
  const children = meeting.artifacts
    .filter(artifact => artifact.artifactKind !== "recap")
    .map(artifact => createMeetingArtifactChild({
      key: `meeting-${meeting.id}-artifact-${artifact.pageId}`,
      section,
      title: artifact.title,
      libraryPageId: artifact.pageId,
      slug: artifact.slug,
      artifactKind: artifact.artifactKind,
      source: artifact.source,
      summary: artifact.summary,
      oneLiner: artifact.oneLiner,
    }));

  return {
    id: `meeting-${meeting.id}`,
    section,
    widgetType: "meeting",
    title: meeting.title,
    status: "completed",
    priority: index,
    sourceRefs: [sourceRef],
    references: sourceRefsToReferenceRefs([sourceRef]),
    anchorTime: meeting.startedAt ?? undefined,
    actionTime: meeting.startedAt ?? undefined,
    completedAt: meeting.endedAt ?? undefined,
    time: meeting.startedAt
      ? new Date(meeting.startedAt).toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })
      : undefined,
    children: children.length > 0 ? children : undefined,
    payload: {
      kind: "meeting_record",
      meetingSummary: meeting.summary,
      attendees: attendees.slice(0, 3).map(participant => participant.name),
      attendeeCount: attendees.length,
      meetingId: meeting.id,
      transcriptCount: meeting.transcriptCount,
      recapStatus: meeting.recapStatus,
    },
    actions: [{
      id: `open-meeting-${meeting.id}`,
      label: "Open meeting",
      type: "navigate",
      href: `/session?c=${encodeURIComponent(meeting.id)}`,
      sourceRef,
    }],
  };
}
