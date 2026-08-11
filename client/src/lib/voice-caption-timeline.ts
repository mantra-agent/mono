import type { AudioAlignmentEvent } from "@elevenlabs/client";

export interface VoiceCaptionCue {
  text: string;
  atMs: number;
}

export interface VoiceCaptionChunk {
  cues: VoiceCaptionCue[];
  durationMs: number;
}

export interface VoiceCaptionWindow {
  text: string;
  pendingPhrase: string;
}

interface TimedWord {
  text: string;
  startsAtMs: number;
}

const MIN_PHRASE_WORDS = 4;
const TARGET_PHRASE_WORDS = 7;
const MAX_PHRASE_WORDS = 10;
const MAX_VISIBLE_WORDS = 18;
export const VOICE_CAPTION_FINAL_HOLD_MS = 900;
const NATURAL_BREAK = /[,.!?;:]$/;
const SENTENCE_BREAK = /[.!?]["')\]]?$/;

function extractTimedWords(chars: string[], starts: number[], length: number): TimedWord[] {
  const words: TimedWord[] = [];
  let text = "";
  let startsAtMs = 0;

  for (let index = 0; index < length; index += 1) {
    const character = chars[index] ?? "";
    if (!text && !/\s/.test(character)) startsAtMs = Math.max(0, starts[index] ?? 0);

    if (/\s/.test(character)) {
      if (text) words.push({ text, startsAtMs });
      text = "";
      continue;
    }

    text += character;
  }

  if (text) words.push({ text, startsAtMs });
  return words;
}

function shouldEndPhrase(words: TimedWord[]): boolean {
  if (words.length >= MAX_PHRASE_WORDS) return true;
  const lastWord = words[words.length - 1]?.text ?? "";
  return words.length >= MIN_PHRASE_WORDS && NATURAL_BREAK.test(lastWord);
}

function normalizedWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Keeps short provider audio events together until they form a readable phrase. */
export function appendVoiceCaptionPhrase(window: VoiceCaptionWindow, text: string): VoiceCaptionWindow {
  const incoming = normalizedWords(text);
  if (incoming.length === 0) return window;

  const pending = [...normalizedWords(window.pendingPhrase), ...incoming];
  const phraseComplete = pending.length >= MIN_PHRASE_WORDS
    && (NATURAL_BREAK.test(pending[pending.length - 1] ?? "") || pending.length >= TARGET_PHRASE_WORDS);
  if (!phraseComplete) {
    return { ...window, pendingPhrase: pending.join(" ") };
  }

  const sentenceComplete = SENTENCE_BREAK.test(pending[pending.length - 1] ?? "");
  const visible = sentenceComplete ? pending : [...normalizedWords(window.text), ...pending];
  return {
    text: visible.slice(-MAX_VISIBLE_WORDS).join(" "),
    pendingPhrase: "",
  };
}

/** Converts provider character timing into phrase-sized cues that can be read at a glance. */
export function createVoiceCaptionChunk(alignment: AudioAlignmentEvent): VoiceCaptionChunk {
  const { chars, char_start_times_ms: starts, char_durations_ms: durations } = alignment;
  const length = Math.min(chars.length, starts.length, durations.length);
  if (length === 0) return { cues: [], durationMs: 0 };

  const cues: VoiceCaptionCue[] = [];
  const words = extractTimedWords(chars, starts, length);
  let phrase: TimedWord[] = [];

  words.forEach((word, index) => {
    phrase.push(word);
    const punctuationIsNear = words
      .slice(index + 1, index + 3)
      .some((candidate) => NATURAL_BREAK.test(candidate.text));
    const reachedTarget = phrase.length >= TARGET_PHRASE_WORDS && !punctuationIsNear;
    if (!shouldEndPhrase(phrase) && !reachedTarget) return;

    cues.push({
      text: phrase.map((candidate) => candidate.text).join(" "),
      atMs: phrase[0]?.startsAtMs ?? 0,
    });
    phrase = [];
  });

  if (phrase.length > 0) {
    cues.push({
      text: phrase.map((candidate) => candidate.text).join(" "),
      atMs: phrase[0]?.startsAtMs ?? 0,
    });
  }

  const finalIndex = length - 1;
  const durationMs = Math.max(0, (starts[finalIndex] ?? 0) + (durations[finalIndex] ?? 0));
  return { cues, durationMs };
}
