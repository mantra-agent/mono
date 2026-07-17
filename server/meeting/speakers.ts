/**
 * Canonical meeting speaker resolution.
 *
 * Stable keys, not display labels, own identity inside a meeting. Exact
 * transport email outranks names. Diarized clusters remain unknown until a
 * later explicit identity mapping supplies stronger evidence.
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
  transportParticipantId?: string;
  providerSpeakerId?: string;
  source?: MeetingSpeakerSource;
}

export interface SpeakerResolution {
  speaker: MessageSpeakerMeta;
  participants: MeetingParticipant[];
  added: boolean;
}

async function resolvePerson(evidence: SpeakerEvidence): Promise<{ id: string; name: string } | null> {
  if (evidence.source === "machine_diarization") return null;
  const normalizedEmail = evidence.email?.trim().toLowerCase();
  if (normalizedEmail) {
    try {
      const index = await peopleStorage.listPeople();
      const people = await peopleStorage.getPeopleByIds(index.map((person) => person.id));
      const exact = people.find((person) =>
        person.contactInfo.some((item) => item.type === "email" && item.value.trim().toLowerCase() === normalizedEmail),
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
        person.name.toLowerCase() === label.toLowerCase() ||
        (person.nicknames || []).some((nickname) => nickname.toLowerCase() === label.toLowerCase()),
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
  const person = await resolvePerson(evidence);
  const candidate: MeetingParticipant = {
    ...(evidence.speakerKey?.trim() ? { key: evidence.speakerKey.trim() } : {}),
    label: evidence.source === "machine_diarization" ? "" : evidence.label?.trim() || person?.name || "",
    ...(person ? { personId: person.id } : {}),
    ...(evidence.source ? { source: evidence.source } : {}),
    ...(evidence.transportParticipantId ? { transportParticipantId: evidence.transportParticipantId } : {}),
    ...(evidence.email ? { transportEmail: evidence.email } : {}),
    ...(evidence.providerSpeakerId ? { providerSpeakerId: evidence.providerSpeakerId } : {}),
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
