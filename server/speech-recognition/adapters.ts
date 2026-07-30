import WebSocket from "ws";
import {
  connectDeepgramStreaming,
  type DeepgramWord,
} from "../integrations/deepgram/streaming";
import { createLogger } from "../log";
import type {
  ResolvedSpeechRecognitionBinding,
  SerializedRecognitionSink,
  STTAudioStream,
  STTProvider,
  STTProviderSession,
} from "./contracts";

const log = createLogger("SpeechRecognitionAdapters");
const MAX_PROVIDER_BUFFERED_BYTES = 512 * 1024;
const FINISH_TIMEOUT_MS = 3_000;

export const HIGH_QUALITY_SCRIBE_POLICY = {
  provider: "scribe_realtime",
  model: "scribe_v2_realtime",
  audioFormat: "pcm_16000",
  sampleRateHz: 16000,
  commitStrategy: "vad",
  vadSilenceThresholdSecs: 1.0,
  vadThreshold: 0.4,
  minSpeechDurationMs: 100,
  minSilenceDurationMs: 100,
  languageCode: "en",
} as const;

export const DEEPGRAM_DIARIZATION_POLICY = {
  provider: "deepgram",
  model: "nova-3",
  diarizeModel: "latest",
  sampleRateHz: 16000,
  endpointingMs: 400,
  language: "en-US",
} as const;

interface ScribeMessage {
  message_type?: string;
  text?: string;
  session_id?: string;
  words?: Array<{
    start?: number;
    end?: number;
    start_timestamp?: number;
    end_timestamp?: number;
  }>;
  error?: string;
  error_message?: string;
}

function secondsToIso(baseMs: number, seconds: number | undefined): string | undefined {
  return Number.isFinite(seconds) ? new Date(baseMs + Number(seconds) * 1000).toISOString() : undefined;
}

function validatePcm(stream: STTAudioStream, provider: string): void {
  if (stream.encoding !== "pcm_s16le" || stream.sampleRateHz !== 16000 || stream.channels !== 1) {
    throw new Error(`${provider} meeting recognition requires mono PCM S16LE at 16 kHz`);
  }
}

function compatibilitySession(session: {
  tryWriteAudio(bytes: Buffer): "accepted" | "blocked" | "closed";
  finish(): Promise<{ outcome: "finished" | "timed_out" }>;
  abort(reason: string): void;
}): STTProviderSession {
  return {
    ...session,
    sendAudio(bytes) {
      session.tryWriteAudio(bytes);
    },
    close() {
      void session.finish();
    },
  };
}

export class ScribeRealtimeSTTProvider implements STTProvider {
  readonly adapterKind = "elevenlabs-scribe-realtime" as const;
  readonly provider = HIGH_QUALITY_SCRIBE_POLICY.provider;
  readonly model = HIGH_QUALITY_SCRIBE_POLICY.model;

  async connect(
    binding: ResolvedSpeechRecognitionBinding,
    stream: STTAudioStream,
    sink: SerializedRecognitionSink,
    attemptId: string,
  ): Promise<STTProviderSession> {
    if (binding.adapterKind !== this.adapterKind) throw new Error("Scribe adapter received the wrong binding kind");
    validatePcm(stream, "Scribe");
    const config = binding.config.adapterKind === this.adapterKind ? binding.config : null;
    if (!config) throw new Error("Scribe binding config is invalid");

    const params = new URLSearchParams({
      model_id: config.model,
      audio_format: HIGH_QUALITY_SCRIBE_POLICY.audioFormat,
      commit_strategy: HIGH_QUALITY_SCRIBE_POLICY.commitStrategy,
      vad_silence_threshold_secs: String(config.vadSilenceThresholdSecs),
      vad_threshold: String(config.vadThreshold),
      min_speech_duration_ms: String(config.minSpeechDurationMs),
      min_silence_duration_ms: String(config.minSilenceDurationMs),
      language_code: config.languageCode,
      include_timestamps: "true",
    });
    for (const keyterm of stream.hints?.keyterms || []) params.append("keyterms", keyterm);
    const socket = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`, {
      headers: { "xi-api-key": binding.credential },
    });
    socket.on("error", () => undefined);
    const connectedAtMs = Date.now();
    let sessionId = "pending";
    let sequence = 0;
    let terminal = false;
    let finishPromise: Promise<{ outcome: "finished" | "timed_out" }> | null = null;
    let lastProviderMessageAt = 0;
    let finalTranscriptCount = 0;
    let hasUncommittedPartial = false;
    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: Error) => void) | null = null;

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as ScribeMessage;
        if (message.message_type === "session_started") {
          sessionId = message.session_id || sessionId;
          readyResolve?.();
          readyResolve = null;
          readyReject = null;
          return;
        }
        lastProviderMessageAt = Date.now();
        const isFinal = message.message_type === "committed_transcript_with_timestamps";
        const isPartial = message.message_type === "partial_transcript";
        if (!isFinal && !isPartial) {
          if (message.message_type?.includes("error")) {
            sink.onError(new Error("Scribe recognition protocol failed"));
          }
          return;
        }
        const text = message.text?.trim() || "";
        if (!text) return;
        if (isFinal) {
          finalTranscriptCount += 1;
          hasUncommittedPartial = false;
        } else {
          hasUncommittedPartial = true;
        }
        const words = message.words || [];
        const first = words[0];
        const last = words.at(-1);
        sink.onUtterance({
          utteranceId: `scribe:${attemptId}:${sessionId}:${++sequence}`,
          streamId: stream.streamId,
          participant: stream.participant,
          text,
          isFinal,
          startedAt: secondsToIso(connectedAtMs, first?.start_timestamp ?? first?.start),
          endedAt: secondsToIso(connectedAtMs, last?.end_timestamp ?? last?.end),
          provider: this.provider,
          model: this.model,
          fallback: false,
          attemptId,
          bindingId: binding.bindingId,
          adapterKind: this.adapterKind,
          configFingerprint: binding.configFingerprint,
        });
      } catch {
        sink.onError(new Error("Scribe returned an invalid recognition message"));
      }
    });
    socket.on("error", () => {
      const error = new Error("Scribe recognition transport failed");
      readyReject?.(error);
      if (!terminal) sink.onError(error);
    });
    socket.on("close", (code) => {
      if (terminal) return;
      const error = new Error(`Scribe recognition closed unexpectedly (${code})`);
      readyReject?.(error);
      sink.onError(error);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
        const timer = setTimeout(() => reject(new Error("Scribe recognition readiness timed out")), 10_000);
        timer.unref?.();
        const settleResolve = readyResolve;
        const settleReject = readyReject;
        readyResolve = () => {
          clearTimeout(timer);
          settleResolve?.();
        };
        readyReject = (error) => {
          clearTimeout(timer);
          settleReject?.(error);
        };
      });
    } catch (error) {
      terminal = true;
      socket.terminate();
      throw error;
    }

    return compatibilitySession({
      tryWriteAudio(bytes) {
        if (terminal || socket.readyState !== WebSocket.OPEN) return "closed";
        if (socket.bufferedAmount >= MAX_PROVIDER_BUFFERED_BYTES) return "blocked";
        if (bytes.length === 0) return "accepted";
        socket.send(JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: bytes.toString("base64"),
          sample_rate: stream.sampleRateHz,
        }));
        return "accepted";
      },
      finish() {
        if (finishPromise) return finishPromise;
        terminal = true;
        finishPromise = (async () => {
          const finalCountAtCommit = finalTranscriptCount;
          const expectFinalTranscript = hasUncommittedPartial;
          const commitSentAt = Date.now();
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: "",
              sample_rate: stream.sampleRateHz,
              commit: true,
            }));
          }
          const providerSettled = await Promise.race([
            new Promise<true>((resolve) => {
              const inspect = (): void => {
                const finalArrived = finalTranscriptCount > finalCountAtCommit;
                const noTailExpected = !expectFinalTranscript
                  && Date.now() - Math.max(commitSentAt, lastProviderMessageAt) >= 300;
                if (finalArrived || noTailExpected || socket.readyState === WebSocket.CLOSED) resolve(true);
                else setTimeout(inspect, 20).unref?.();
              };
              inspect();
            }),
            new Promise<false>((resolve) => {
              const timer = setTimeout(() => resolve(false), FINISH_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
          const consumerSettled = await Promise.race([
            sink.settle().then(() => true),
            new Promise<false>((resolve) => {
              const timer = setTimeout(() => resolve(false), FINISH_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Audio stream ended");
          return { outcome: providerSettled && consumerSettled ? "finished" as const : "timed_out" as const };
        })();
        return finishPromise;
      },
      abort(reason) {
        if (terminal) return;
        terminal = true;
        log.debug("Scribe recognition aborted", { reason: reason.slice(0, 80), attemptId });
        socket.terminate();
      },
    });
  }
}

interface SpeakerWordGroup {
  speakerId: string;
  words: DeepgramWord[];
}

function groupWordsBySpeaker(words: DeepgramWord[]): SpeakerWordGroup[] {
  const groups: SpeakerWordGroup[] = [];
  for (const word of words) {
    const speakerId = Number.isInteger(word.speaker) ? String(word.speaker) : "unknown";
    const current = groups.at(-1);
    if (!current || current.speakerId !== speakerId) groups.push({ speakerId, words: [word] });
    else current.words.push(word);
  }
  return groups;
}

function wordGroupText(group: SpeakerWordGroup): string {
  return group.words
    .map((word) => word.punctuated_word || word.word || "")
    .join(" ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

export class DeepgramDiarizingSTTProvider implements STTProvider {
  readonly adapterKind = "deepgram-realtime" as const;
  readonly provider = DEEPGRAM_DIARIZATION_POLICY.provider;
  readonly model = DEEPGRAM_DIARIZATION_POLICY.model;

  async connect(
    binding: ResolvedSpeechRecognitionBinding,
    stream: STTAudioStream,
    sink: SerializedRecognitionSink,
    attemptId: string,
  ): Promise<STTProviderSession> {
    if (binding.adapterKind !== this.adapterKind) throw new Error("Deepgram adapter received the wrong binding kind");
    validatePcm(stream, "Deepgram");
    const config = binding.config.adapterKind === this.adapterKind ? binding.config : null;
    if (!config) throw new Error("Deepgram binding config is invalid");
    let sequence = 0;
    const connectedAtMs = Date.now();
    const session = await connectDeepgramStreaming(
      {
        model: config.model,
        language: config.language,
        encoding: "linear16",
        sampleRateHz: 16000,
        endpointingMs: config.endpointingMs,
        diarize: true,
        keyterms: stream.hints?.keyterms,
      },
      (event) => {
        if (!event.isFinal) return;
        const groups = groupWordsBySpeaker(event.words);
        if (groups.length === 0) groups.push({ speakerId: "unknown", words: [] });
        for (const group of groups) {
          const text = group.words.length > 0 ? wordGroupText(group) : event.text;
          if (!text) continue;
          const first = group.words[0];
          const last = group.words.at(-1);
          const confidences = group.words
            .map((word) => word.confidence)
            .filter((value): value is number => Number.isFinite(value));
          sink.onUtterance({
            utteranceId: `deepgram:${attemptId}:${group.speakerId}:${++sequence}`,
            streamId: stream.streamId,
            participant: stream.participant,
            text,
            isFinal: true,
            startedAt: secondsToIso(connectedAtMs, first?.start),
            endedAt: secondsToIso(connectedAtMs, last?.end),
            confidence: confidences.length > 0
              ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
              : undefined,
            providerSpeakerId: group.speakerId,
            provider: this.provider,
            model: this.model,
            fallback: false,
            attemptId,
            bindingId: binding.bindingId,
            adapterKind: this.adapterKind,
            configFingerprint: binding.configFingerprint,
          });
        }
      },
      sink.onError,
      { credential: binding.credential },
    );
    return compatibilitySession(session);
  }
}

export const SPEECHMATICS_DIARIZATION_POLICY = {
  provider: "speechmatics",
  model: "enhanced",
  sampleRateHz: 16000,
  language: "en",
} as const;

const SPEECHMATICS_REGION_ENDPOINT: Record<"us" | "eu" | "global", string> = {
  us: "wss://us.rt.speechmatics.com/v2/",
  eu: "wss://eu.rt.speechmatics.com/v2/",
  global: "wss://global.rt.speechmatics.com/v2/",
};

const SPEECHMATICS_UNKNOWN_SPEAKER = "UU";

interface SpeechmaticsAlternative {
  content?: string;
  confidence?: number;
  speaker?: string;
}

interface SpeechmaticsResult {
  type?: string;
  start_time?: number;
  end_time?: number;
  attaches_to?: string;
  alternatives?: SpeechmaticsAlternative[];
}

interface SpeechmaticsMessage {
  message?: string;
  seq_no?: number;
  last_seq_no?: number;
  results?: SpeechmaticsResult[];
  type?: string;
  reason?: string;
}

interface SpeechmaticsSpeakerGroup {
  speaker: string;
  parts: string[];
  confidences: number[];
  startTime?: number;
  endTime?: number;
}

function groupSpeechmaticsResults(results: SpeechmaticsResult[]): SpeechmaticsSpeakerGroup[] {
  const groups: SpeechmaticsSpeakerGroup[] = [];
  for (const result of results) {
    const alternative = result.alternatives?.[0];
    const content = alternative?.content?.trim();
    if (!content) continue;
    const speaker = alternative?.speaker || SPEECHMATICS_UNKNOWN_SPEAKER;
    const current = groups.at(-1);
    if (!current || current.speaker !== speaker) {
      groups.push({
        speaker,
        parts: [content],
        confidences: Number.isFinite(alternative?.confidence) ? [Number(alternative?.confidence)] : [],
        startTime: result.start_time,
        endTime: result.end_time,
      });
      continue;
    }
    current.parts.push(content);
    if (Number.isFinite(alternative?.confidence)) current.confidences.push(Number(alternative?.confidence));
    if (Number.isFinite(result.end_time)) current.endTime = result.end_time;
  }
  return groups;
}

function speechmaticsGroupText(group: SpeechmaticsSpeakerGroup): string {
  return group.parts
    .join(" ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

export class SpeechmaticsRealtimeSTTProvider implements STTProvider {
  readonly adapterKind = "speechmatics-realtime" as const;
  readonly provider = SPEECHMATICS_DIARIZATION_POLICY.provider;
  readonly model = SPEECHMATICS_DIARIZATION_POLICY.model;

  async connect(
    binding: ResolvedSpeechRecognitionBinding,
    stream: STTAudioStream,
    sink: SerializedRecognitionSink,
    attemptId: string,
  ): Promise<STTProviderSession> {
    if (binding.adapterKind !== this.adapterKind) throw new Error("Speechmatics adapter received the wrong binding kind");
    validatePcm(stream, "Speechmatics");
    const config = binding.config.adapterKind === this.adapterKind ? binding.config : null;
    if (!config) throw new Error("Speechmatics binding config is invalid");

    const endpoint = SPEECHMATICS_REGION_ENDPOINT[config.region];
    if (!endpoint) throw new Error("Speechmatics region is not allowlisted");

    const socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${binding.credential}` },
    });
    socket.on("error", () => undefined);

    const connectedAtMs = Date.now();
    let sequence = 0;
    let audioSeq = 0;
    let terminal = false;
    let recognitionStarted = false;
    let endOfTranscript = false;
    let finishPromise: Promise<{ outcome: "finished" | "timed_out" }> | null = null;
    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: Error) => void) | null = null;
    let endOfTranscriptResolve: (() => void) | null = null;

    socket.on("open", () => {
      socket.send(JSON.stringify({
        message: "StartRecognition",
        audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: stream.sampleRateHz },
        transcription_config: {
          language: config.language,
          model: config.model,
          diarization: "speaker",
          speaker_diarization_config: {
            speaker_sensitivity: config.speakerSensitivity,
            prefer_current_speaker: config.preferCurrentSpeaker,
            max_speakers: config.maxSpeakers,
          },
        },
      }));
    });

    socket.on("message", (data) => {
      let message: SpeechmaticsMessage;
      try {
        message = JSON.parse(data.toString()) as SpeechmaticsMessage;
      } catch {
        sink.onError(new Error("Speechmatics returned an invalid recognition message"));
        return;
      }
      switch (message.message) {
        case "RecognitionStarted":
          recognitionStarted = true;
          readyResolve?.();
          readyResolve = null;
          readyReject = null;
          return;
        case "AudioAdded":
          return;
        case "AddTranscript": {
          const groups = groupSpeechmaticsResults(message.results || []);
          for (const group of groups) {
            const text = speechmaticsGroupText(group);
            if (!text) continue;
            const confidence = group.confidences.length > 0
              ? group.confidences.reduce((sum, value) => sum + value, 0) / group.confidences.length
              : undefined;
            sink.onUtterance({
              utteranceId: `speechmatics:${attemptId}:${group.speaker}:${++sequence}`,
              streamId: stream.streamId,
              participant: stream.participant,
              text,
              isFinal: true,
              startedAt: secondsToIso(connectedAtMs, group.startTime),
              endedAt: secondsToIso(connectedAtMs, group.endTime),
              confidence,
              providerSpeakerId: group.speaker,
              provider: this.provider,
              model: this.model,
              fallback: false,
              attemptId,
              bindingId: binding.bindingId,
              adapterKind: this.adapterKind,
              configFingerprint: binding.configFingerprint,
            });
          }
          return;
        }
        case "EndOfTranscript":
          endOfTranscript = true;
          endOfTranscriptResolve?.();
          endOfTranscriptResolve = null;
          return;
        case "Warning":
          return;
        case "Error":
          if (!terminal) sink.onError(new Error("Speechmatics recognition protocol failed"));
          return;
        default:
          return;
      }
    });
    socket.on("error", () => {
      const error = new Error("Speechmatics recognition transport failed");
      readyReject?.(error);
      if (!terminal) sink.onError(error);
    });
    socket.on("close", (code) => {
      if (terminal || endOfTranscript) return;
      const error = new Error(`Speechmatics recognition closed unexpectedly (${code})`);
      readyReject?.(error);
      sink.onError(error);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Speechmatics recognition readiness timed out")), 10_000);
        timer.unref?.();
        readyResolve = () => {
          clearTimeout(timer);
          resolve();
        };
        readyReject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });
    } catch (error) {
      terminal = true;
      socket.terminate();
      throw error;
    }

    return compatibilitySession({
      tryWriteAudio(bytes) {
        if (terminal || !recognitionStarted || socket.readyState !== WebSocket.OPEN) return "closed";
        if (socket.bufferedAmount >= MAX_PROVIDER_BUFFERED_BYTES) return "blocked";
        if (bytes.length === 0) return "accepted";
        socket.send(bytes);
        audioSeq += 1;
        return "accepted";
      },
      finish() {
        if (finishPromise) return finishPromise;
        terminal = true;
        finishPromise = (async () => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ message: "EndOfStream", last_seq_no: audioSeq }));
          }
          const providerSettled = await Promise.race([
            new Promise<true>((resolve) => {
              if (endOfTranscript) resolve(true);
              else endOfTranscriptResolve = () => resolve(true);
            }),
            new Promise<false>((resolve) => {
              const timer = setTimeout(() => resolve(false), FINISH_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
          const consumerSettled = await Promise.race([
            sink.settle().then(() => true),
            new Promise<false>((resolve) => {
              const timer = setTimeout(() => resolve(false), FINISH_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Audio stream ended");
          return { outcome: providerSettled && consumerSettled ? "finished" as const : "timed_out" as const };
        })();
        return finishPromise;
      },
      abort(reason) {
        if (terminal) return;
        terminal = true;
        log.debug("Speechmatics recognition aborted", { reason: reason.slice(0, 80), attemptId });
        socket.terminate();
      },
    });
  }
}
