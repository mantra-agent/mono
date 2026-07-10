/**
 * Speaker resolution for meeting sessions.
 *
 * Known speakers resolve to a person (renders as @person downstream);
 * unknown speakers receive a stable per-session "Speaker N" identity.
 * The session's meeting.participants list is the single source of truth
 * for identities already assigned in a meeting.
 */

import { peopleStorage } from "../people-storage";
import { createLogger } from "../log";
import type {
  MeetingParticipant,
  MessageSpeakerMeta,
} from "@shared/models/chat";

const log = createLogger("MeetingSpeakers");

export interface SpeakerResolution {
  speaker: MessageSpeakerMeta;
  /** Participants list including this speaker (unchanged if already present). */
  participants: MeetingParticipant[];
  /** True when the speaker was added to the participants list. */
  added: boolean;
}

/**
 * Resolve a transport-reported speaker label against existing participants
 * and the people directory. Anonymous utterances get "Speaker N" where N is
 * stable for the session (next unused ordinal).
 */
export async function resolveSpeaker(
  label: string | undefined,
  participants: MeetingParticipant[],
): Promise<SpeakerResolution> {
  const trimmed = label?.trim();

  if (!trimmed) {
    const nextOrdinal =
      participants.filter((p) => /^Speaker \d+$/.test(p.label)).length + 1;
    const anon: MeetingParticipant = { label: `Speaker ${nextOrdinal}` };
    return {
      speaker: anon,
      participants: [...participants, anon],
      added: true,
    };
  }

  const existing = participants.find(
    (p) => p.label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) {
    return { speaker: existing, participants, added: false };
  }

  let personId: string | undefined;
  try {
    const matches = await peopleStorage.searchPeople(trimmed);
    const exact = matches.find(
      (p) =>
        p.name.toLowerCase() === trimmed.toLowerCase() ||
        (p.nicknames || []).some(
          (n) => n.toLowerCase() === trimmed.toLowerCase(),
        ),
    );
    personId = (exact || (matches.length === 1 ? matches[0] : undefined))?.id;
  } catch (err) {
    log.warn(
      `person lookup failed for speaker label="${trimmed}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const participant: MeetingParticipant = personId
    ? { label: trimmed, personId }
    : { label: trimmed };
  return {
    speaker: participant,
    participants: [...participants, participant],
    added: true,
  };
}
