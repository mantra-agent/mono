import type { AudioAlignmentEvent } from "@elevenlabs/client";

export interface VoiceCaptionCue {
  text: string;
  atMs: number;
}

export interface VoiceCaptionChunk {
  cues: VoiceCaptionCue[];
  durationMs: number;
}

const MAX_VISIBLE_WORDS = 14;
const MIN_WORD_INTERVAL_MS = 45;

function visibleTail(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(-MAX_VISIBLE_WORDS).join(" ");
}

/** Converts provider character timing into bounded, progressively revealed caption cues. */
export function createVoiceCaptionChunk(alignment: AudioAlignmentEvent): VoiceCaptionChunk {
  const { chars, char_start_times_ms: starts, char_durations_ms: durations } = alignment;
  const length = Math.min(chars.length, starts.length, durations.length);
  if (length === 0) return { cues: [], durationMs: 0 };

  const cues: VoiceCaptionCue[] = [];
  let text = "";
  let lastCueAt = -Infinity;

  for (let index = 0; index < length; index += 1) {
    text += chars[index] ?? "";
    const nextCharacter = chars[index + 1];
    const wordComplete = index === length - 1 || /\s/.test(nextCharacter ?? "");
    if (!wordComplete) continue;

    const atMs = Math.max(0, starts[index] ?? 0);
    if (atMs - lastCueAt < MIN_WORD_INTERVAL_MS && index !== length - 1) continue;
    const visibleText = visibleTail(text);
    if (!visibleText) continue;
    cues.push({ text: visibleText, atMs });
    lastCueAt = atMs;
  }

  const finalIndex = length - 1;
  const durationMs = Math.max(0, (starts[finalIndex] ?? 0) + (durations[finalIndex] ?? 0));
  return { cues, durationMs };
}
