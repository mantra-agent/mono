import type { SpeechRecognitionAdapterKind, SpeechRecognitionBindingConfig } from "@shared/models/platforms";
import type { SpeechRecognitionHints } from "../speech-recognition-hints";

/** Canonical participant identity supplied by an upstream audio transport. */
export interface STTParticipant {
  transportId: string;
  label?: string;
  email?: string;
  isHost?: boolean;
}

/** Provider-neutral PCM stream accepted by the speech recognition boundary. */
export interface STTAudioStream {
  streamId: string;
  participant: STTParticipant;
  encoding: "pcm_s16le";
  sampleRateHz: 16000;
  channels: 1;
  hints?: SpeechRecognitionHints;
}

/** One exact environment binding and credential resolved before adapter connection. */
export interface ResolvedSpeechRecognitionBinding {
  bindingId?: number;
  environmentId: number | null;
  adapterKind: SpeechRecognitionAdapterKind;
  provider: string;
  model: string;
  config: SpeechRecognitionBindingConfig;
  configFingerprint: string;
  credential: string;
  source: "environment_binding" | "legacy_environment_secret";
}

/** Canonical recognition result. Consumers act only on final utterances. */
export interface STTUtterance {
  utteranceId: string;
  streamId: string;
  participant: STTParticipant;
  text: string;
  isFinal: boolean;
  startedAt?: string;
  endedAt?: string;
  confidence?: number;
  /** Provider-local acoustic speaker cluster, scoped by attemptId. */
  providerSpeakerId?: string;
  provider: string;
  model: string;
  fallback: boolean;
  attemptId: string;
  bindingId?: number;
  adapterKind: SpeechRecognitionAdapterKind;
  configFingerprint: string;
}

export type STTWriteOutcome = "accepted" | "blocked" | "closed";
export type STTFinishOutcome = { outcome: "finished" | "timed_out" };

export interface STTProviderSession {
  tryWriteAudio(bytes: Buffer): STTWriteOutcome;
  finish(): Promise<STTFinishOutcome>;
  abort(reason: string): void;
  /** @deprecated Compatibility alias while meeting transports migrate to the coordinator. */
  sendAudio(bytes: Buffer): void;
  /** @deprecated Compatibility alias while meeting transports migrate to the coordinator. */
  close(): void;
}

export interface SerializedRecognitionSink {
  onUtterance(utterance: STTUtterance): void;
  onError(error: Error): void;
  settle(): Promise<void>;
}

export interface STTProvider {
  readonly adapterKind: SpeechRecognitionAdapterKind;
  readonly provider: string;
  readonly model: string;
  connect(
    binding: ResolvedSpeechRecognitionBinding,
    stream: STTAudioStream,
    sink: SerializedRecognitionSink,
    attemptId: string,
  ): Promise<STTProviderSession>;
}
