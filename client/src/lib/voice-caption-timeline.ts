import type { AudioAlignmentEvent } from "@elevenlabs/client";

export interface VoiceCaptionCue {
  text: string;
  atMs: number;
}

export interface VoiceCaptionChunk {
  words: VoiceCaptionCue[];
  durationMs: number;
}

export interface VoiceCaptionBuffer {
  pendingWords: VoiceCaptionCue[];
}

export interface VoiceCaptionCards {
  buffer: VoiceCaptionBuffer;
  cards: VoiceCaptionCue[];
}

const MIN_CLAUSE_WORDS = 12;
const MAX_SENTENCE_WORDS = 24;
export const VOICE_CAPTION_FINAL_HOLD_MS = 900;
const CLAUSE_BREAK = /[,;:]$/;
const SENTENCE_BREAK = /[.!?]["')\]]?$/;

function extractTimedWords(chars: string[], starts: number[], length: number): VoiceCaptionCue[] {
  const words: VoiceCaptionCue[] = [];
  let text = "";
  let atMs = 0;

  for (let index = 0; index < length; index += 1) {
    const character = chars[index] ?? "";
    if (!text && !/\s/.test(character)) atMs = Math.max(0, starts[index] ?? 0);

    if (/\s/.test(character)) {
      if (text) words.push({ text, atMs });
      text = "";
      continue;
    }

    text += character;
  }

  if (text) words.push({ text, atMs });
  return words;
}

function shouldCompleteCard(words: VoiceCaptionCue[]): boolean {
  const lastWord = words[words.length - 1]?.text ?? "";
  if (SENTENCE_BREAK.test(lastWord)) return true;
  if (words.length >= MAX_SENTENCE_WORDS) return true;
  return words.length >= MIN_CLAUSE_WORDS && CLAUSE_BREAK.test(lastWord);
}

function createCard(words: VoiceCaptionCue[]): VoiceCaptionCue {
  const text = words
    .map((word) => word.text)
    .join(" ")
    .replace(/\s+([,.;:!?%…](?:["')\]]*)?)/g, "$1");

  return {
    text,
    atMs: words[0]?.atMs ?? 0,
  };
}

/**
 * Buffers provider words until a complete sentence-like unit exists. Completed
 * cards are immutable, so visible caption text never reflows while it is read.
 */
export function appendVoiceCaptionWords(
  buffer: VoiceCaptionBuffer,
  words: VoiceCaptionCue[],
): VoiceCaptionCards {
  const cards: VoiceCaptionCue[] = [];
  let pendingWords = [...buffer.pendingWords];

  for (const word of words) {
    if (!word.text.trim()) continue;
    pendingWords.push(word);
    if (!shouldCompleteCard(pendingWords)) continue;

    cards.push(createCard(pendingWords));
    pendingWords = [];
  }

  return { buffer: { pendingWords }, cards };
}

/** Emits the final incomplete sentence once the provider audio queue settles. */
export function flushVoiceCaptionBuffer(buffer: VoiceCaptionBuffer): VoiceCaptionCards {
  if (buffer.pendingWords.length === 0) return { buffer, cards: [] };
  return {
    buffer: { pendingWords: [] },
    cards: [createCard(buffer.pendingWords)],
  };
}

/** Splits untimed spoken text into the same immutable sentence cards. */
export function createVoiceCaptionCards(text: string): VoiceCaptionCue[] {
  const words = text.trim().split(/\s+/).filter(Boolean).map((word) => ({ text: word, atMs: 0 }));
  const appended = appendVoiceCaptionWords({ pendingWords: [] }, words);
  const flushed = flushVoiceCaptionBuffer(appended.buffer);
  return [...appended.cards, ...flushed.cards];
}

/** Converts provider character timing into word timing for sentence lookahead. */
export function createVoiceCaptionChunk(alignment: AudioAlignmentEvent): VoiceCaptionChunk {
  const { chars, char_start_times_ms: starts, char_durations_ms: durations } = alignment;
  const length = Math.min(chars.length, starts.length, durations.length);
  if (length === 0) return { words: [], durationMs: 0 };

  const finalIndex = length - 1;
  const durationMs = Math.max(0, (starts[finalIndex] ?? 0) + (durations[finalIndex] ?? 0));
  return {
    words: extractTimedWords(chars, starts, length),
    durationMs,
  };
}

/**
 * Decode the real caption cues delivered with a meeting audio clip
 * (the `X-Meeting-Caption-Cues` header: base64url JSON of `{ atMs, text }[]`,
 * where `atMs` is the true onset of each sentence from ElevenLabs character
 * alignment). Returns null when the header is absent or malformed so callers
 * can fall back to untimed text.
 */
export function decodeMeetingCaptionCues(encoded: string | null): VoiceCaptionCue[] | null {
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed)) return null;
    const cues = parsed
      .filter(
        (cue): cue is VoiceCaptionCue =>
          Boolean(cue) && typeof (cue as VoiceCaptionCue).text === "string" && typeof (cue as VoiceCaptionCue).atMs === "number",
      )
      .map((cue) => ({ text: cue.text, atMs: Math.max(0, cue.atMs) }));
    return cues.length > 0 ? cues : null;
  } catch {
    return null;
  }
}
