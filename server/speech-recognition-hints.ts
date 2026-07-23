import type { MeetingParticipant } from "@shared/models/chat";
import { createLogger } from "./log";
import { peopleStorage, type PersonIndexEntry } from "./people-storage";
import { resolveCurrentProfileIdentity } from "./profile-identity";

const log = createLogger("SpeechRecognitionHints");

/** ElevenLabs realtime is the narrowest active provider contract. */
export const MAX_SPEECH_RECOGNITION_KEYTERMS = 50;
export const MAX_SPEECH_RECOGNITION_KEYTERM_LENGTH = 20;

export interface SpeechRecognitionHints {
  keyterms: string[];
}

export function createSpeechRecognitionHints(terms: Array<string | null | undefined>): SpeechRecognitionHints {
  const keyterms: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) addPhraseTerms(keyterms, seen, term);
  return { keyterms };
}

function cleanKeyterm(value: string | null | undefined): string | null {
  const cleaned = value
    ?.replace(/[@<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > MAX_SPEECH_RECOGNITION_KEYTERM_LENGTH) return null;
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return null;
  return cleaned;
}

function addKeyterm(
  target: string[],
  seen: Set<string>,
  value: string | null | undefined,
): void {
  if (target.length >= MAX_SPEECH_RECOGNITION_KEYTERMS) return;
  const cleaned = cleanKeyterm(value);
  if (!cleaned) return;
  const key = cleaned.toLocaleLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push(cleaned);
}

function addPhraseTerms(
  target: string[],
  seen: Set<string>,
  value: string | null | undefined,
): void {
  addKeyterm(target, seen, value);
  for (const token of value?.split(/[^\p{L}\p{N}'-]+/u) || []) {
    if (token.length >= 2) addKeyterm(target, seen, token);
  }
}

function addPersonTerms(
  target: string[],
  seen: Set<string>,
  person: Pick<PersonIndexEntry, "name" | "nicknames" | "company">,
): void {
  addPhraseTerms(target, seen, person.name);
  for (const nickname of person.nicknames || []) addPhraseTerms(target, seen, nickname);
  addPhraseTerms(target, seen, person.company);
}

/**
 * Resolve one bounded, user-owned recognition vocabulary for every active STT
 * adapter. Priority is intentional: agent/user identity, current meeting
 * roster, explicit context, then the user's broader People vocabulary.
 */
export async function resolveSpeechRecognitionHints(options: {
  participants?: MeetingParticipant[];
  contextTerms?: string[];
  includePeople?: boolean;
} = {}): Promise<SpeechRecognitionHints> {
  const keyterms: string[] = [];
  const seen = new Set<string>();
  const identity = await resolveCurrentProfileIdentity();

  addPhraseTerms(keyterms, seen, identity.agentName);
  addKeyterm(keyterms, seen, "Mantra");
  addPhraseTerms(keyterms, seen, identity.userName);

  for (const participant of options.participants || []) {
    addPhraseTerms(keyterms, seen, participant.label);
    addPhraseTerms(keyterms, seen, participant.providerLabel);
  }
  for (const term of options.contextTerms || []) addPhraseTerms(keyterms, seen, term);

  if (options.includePeople === false || keyterms.length >= MAX_SPEECH_RECOGNITION_KEYTERMS) {
    return { keyterms };
  }

  try {
    const index = await peopleStorage.listPeople();
    const prioritizedIds = new Set(
      (options.participants || [])
        .map((participant) => participant.personId)
        .filter((id): id is string => Boolean(id)),
    );
    const ordered = [
      ...index.filter((person) => prioritizedIds.has(person.id)),
      ...index.filter((person) => !prioritizedIds.has(person.id)),
    ];
    for (const person of ordered) {
      if (keyterms.length >= MAX_SPEECH_RECOGNITION_KEYTERMS) break;
      addPersonTerms(keyterms, seen, person);
    }
  } catch (error) {
    log.warn("People vocabulary unavailable; continuing with identity and meeting hints", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { keyterms };
}
