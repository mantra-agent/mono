/**
 * Canonical meeting speaker resolution.
 *
 * Stable keys, not display labels, own identity inside a meeting. Manual owner
 * mapping outranks exact calendar email, normalized calendar name, host role,
 * and transport evidence. Diarized clusters remain unknown until explicit mapping.
 */

import { peopleStorage } from "../people-storage";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import type {
  MeetingParticipant,
  MeetingSpeakerSource,
  MessageSpeakerMeta,
} from "@shared/models/chat";

const log = createLogger("MeetingSpeakers");

export interface SpeakerEvidence {
  speakerKey?: string;
  label?: string;
  email?: string;
  isHost?: boolean;
  transportParticipantId?: string;
  providerSpeakerId?: string;
  source?: MeetingSpeakerSource;
}

export interface SpeakerResolution {
  speaker: MessageSpeakerMeta;
  participants: MeetingParticipant[];
  added: boolean;
}

function normalizeEmail(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.includes("@") ? normalized : undefined;
}

function labelsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined) => value
    ?.toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return !!normalizedLeft && normalizedLeft === normalizedRight;
}

function calendarParticipantForEvidence(
  participants: MeetingParticipant[],
  evidence: SpeakerEvidence,
): MeetingParticipant | null {
  if (evidence.source === "machine_diarization") return null;
  const transportEmail = normalizeEmail(evidence.email);
  if (transportEmail) {
    const exactEmail = participants.find((participant) =>
      participant.identitySource === "calendar" &&
      normalizeEmail(participant.calendarEmail) === transportEmail,
    );
    if (exactEmail) return exactEmail;
  }
  const exactLabelMatches = participants.filter((participant) =>
    participant.identitySource === "calendar" && labelsMatch(participant.label, evidence.label),
  );
  if (exactLabelMatches.length === 1) return exactLabelMatches[0]!;
  if (evidence.isHost) {
    const organizers = participants.filter((participant) => participant.calendarRole === "organizer");
    if (organizers.length === 1) return organizers[0]!;
  }
  const boundCalendarIdentity = new Set(participants
    .filter((participant) => participant.transportParticipantId)
    .flatMap((participant) => [
      ...(participant.personId ? [`person:${participant.personId}`] : []),
      ...(normalizeEmail(participant.calendarEmail) ? [`email:${normalizeEmail(participant.calendarEmail)}`] : []),
    ]));
  const unbound = participants.filter((participant) =>
    participant.identitySource === "calendar" &&
    !boundCalendarIdentity.has(participant.personId
      ? `person:${participant.personId}`
      : `email:${normalizeEmail(participant.calendarEmail)}`),
  );
  return unbound.length === 1 ? unbound[0]! : null;
}

async function resolvePerson(evidence: SpeakerEvidence): Promise<{ id: string; name: string } | null> {
  if (evidence.source === "machine_diarization") return null;
  const normalizedEmail = normalizeEmail(evidence.email);
  if (normalizedEmail) {
    try {
      const index = await peopleStorage.listPeople();
      const people = await peopleStorage.getPeopleByIds(index.map((person) => person.id));
      const exact = people.find((person) =>
        person.contactInfo.some((item) => item.type === "email" && normalizeEmail(item.value) === normalizedEmail),
      );
      if (exact) return { id: exact.id, name: exact.name };
    } catch (error) {
      log.warn(`person email lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const label = evidence.label?.trim();
  if (!label) return null;
  try {
    const matches = await peopleStorage.searchPeople(label);
    const exact = matches.find(
      (person) =>
        labelsMatch(person.name, label) ||
        (person.nicknames || []).some((nickname) => labelsMatch(nickname, label)),
    );
    const person = exact || (matches.length === 1 ? matches[0] : undefined);
    return person ? { id: person.id, name: person.name } : null;
  } catch (error) {
    log.warn(`person lookup failed for speaker label="${label}": ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function resolveSpeaker(
  sessionId: string,
  evidence: SpeakerEvidence,
): Promise<SpeakerResolution> {
  const session = await chatStorage.getSession(sessionId);
  if (!session?.meeting) throw new Error(`Meeting session ${sessionId} not found during speaker resolution`);
  const calendarParticipant = calendarParticipantForEvidence(session.meeting.participants, evidence);
  const person = calendarParticipant?.personId
    ? { id: calendarParticipant.personId, name: calendarParticipant.label }
    : await resolvePerson(evidence);
  const providerLabel = evidence.label?.trim();
  const candidate: MeetingParticipant = {
    ...(evidence.speakerKey?.trim() ? { key: evidence.speakerKey.trim() } : {}),
    label: evidence.source === "machine_diarization"
      ? ""
      : calendarParticipant?.label || person?.name || providerLabel || "",
    ...(person ? { personId: person.id } : {}),
    ...(evidence.source ? { source: evidence.source } : {}),
    identitySource: calendarParticipant ? "calendar" : "transport",
    ...(evidence.transportParticipantId ? { transportParticipantId: evidence.transportParticipantId } : {}),
    ...(evidence.email ? { transportEmail: evidence.email } : {}),
    ...(evidence.providerSpeakerId ? { providerSpeakerId: evidence.providerSpeakerId } : {}),
    ...(providerLabel ? { providerLabel } : {}),
    ...(calendarParticipant?.calendarEmail ? { calendarEmail: calendarParticipant.calendarEmail } : {}),
    ...(calendarParticipant?.calendarRole ? { calendarRole: calendarParticipant.calendarRole } : {}),
  };
  const registered = await chatStorage.registerMeetingParticipant(sessionId, candidate);
  if (!registered) throw new Error(`Meeting session ${sessionId} not found during speaker registration`);
  return {
    speaker: {
      key: registered.participant.key,
      label: registered.participant.label,
      personId: registered.participant.personId,
    },
    participants: registered.participants,
    added: registered.added,
  };
}
