export type VoiceEchoAdmissionOutcome =
  | "admitted"
  | "admitted_canary_disabled"
  | "rejected_playback_echo"
  | "rejected_speech_ended_with_playback";

export interface VoiceEchoAdmissionEvidence {
  outcome: VoiceEchoAdmissionOutcome;
  playbackActive: boolean;
  interruptedPlayback: boolean;
  postInterruptionSpeechMs: number;
  assistantSimilarity: number;
}

export interface VoiceEchoAdmissionCandidate {
  transcript: string;
  playbackActive: boolean;
  recentAssistantText: string;
  canaryEnabled: boolean;
  interruptPlayback: () => void;
  isInputActive: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
}

const POST_INTERRUPTION_WINDOW_MS = 280;
const INPUT_POLL_MS = 40;
const ECHO_SIMILARITY_THRESHOLD = 0.72;

export async function admitVoiceTranscript(
  candidate: VoiceEchoAdmissionCandidate,
): Promise<VoiceEchoAdmissionEvidence> {
  const assistantSimilarity = textSimilarity(
    candidate.transcript,
    candidate.recentAssistantText,
  );

  if (!candidate.canaryEnabled || !candidate.playbackActive) {
    return {
      outcome: candidate.canaryEnabled ? "admitted" : "admitted_canary_disabled",
      playbackActive: candidate.playbackActive,
      interruptedPlayback: false,
      postInterruptionSpeechMs: 0,
      assistantSimilarity,
    };
  }

  candidate.interruptPlayback();
  const wait = candidate.wait || delay;
  let postInterruptionSpeechMs = 0;

  for (
    let elapsed = 0;
    elapsed < POST_INTERRUPTION_WINDOW_MS;
    elapsed += INPUT_POLL_MS
  ) {
    await wait(INPUT_POLL_MS);
    if (candidate.isInputActive()) {
      postInterruptionSpeechMs += INPUT_POLL_MS;
    }
  }

  if (postInterruptionSpeechMs < INPUT_POLL_MS * 2) {
    return {
      outcome: assistantSimilarity >= ECHO_SIMILARITY_THRESHOLD
        ? "rejected_playback_echo"
        : "rejected_speech_ended_with_playback",
      playbackActive: true,
      interruptedPlayback: true,
      postInterruptionSpeechMs,
      assistantSimilarity,
    };
  }

  return {
    outcome: "admitted",
    playbackActive: true,
    interruptedPlayback: true,
    postInterruptionSpeechMs,
    assistantSimilarity,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function textSimilarity(left: string, right: string): number {
  const leftTokens = normalizeTokens(left);
  const rightTokens = normalizeTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function normalizeTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9' ]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1)
      .slice(-80),
  );
}
