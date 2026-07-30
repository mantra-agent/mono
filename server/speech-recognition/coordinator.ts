import type {
  SpeechRecognitionAdapterKind,
  SpeechRecognitionUseCase,
} from "@shared/models/platforms";
import { createLogger } from "../log";
import {
  mintRecognitionAttemptId,
  resolveLegacySpeechRecognitionBinding,
  resolveSpeechRecognitionCandidateBindings,
} from "./bindings";
import type {
  ResolvedSpeechRecognitionBinding,
  STTAudioStream,
  STTFinishOutcome,
  STTProviderSession,
  STTUtterance,
  STTWriteOutcome,
} from "./contracts";
import { getSpeechRecognitionAdapter } from "./registry";
import { createSerializedRecognitionSink } from "./sink";

const log = createLogger("SpeechRecognitionCoordinator");

const MAX_PENDING_AUDIO_BYTES = 512 * 1024;
const MAX_PENDING_AUDIO_AGE_MS = 5_000;
const AUDIO_FLUSH_INTERVAL_MS = 20;
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8_000;
const FINISH_TIMEOUT_MS = 4_000;

export type SpeechRecognitionFailureKind =
  | "configuration"
  | "startup"
  | "provider"
  | "backpressure"
  | "consumer"
  | "finish_timeout";

export interface SpeechRecognitionFailure {
  kind: SpeechRecognitionFailureKind;
  detail: string;
  retryable: boolean;
}

export interface SpeechRecognitionCoordinatorState {
  status: "connecting" | "active" | "reconnecting" | "failed" | "closed";
  attemptId?: string;
  binding?: ResolvedSpeechRecognitionBinding;
  detail?: string;
}

export interface SpeechRecognitionStreamRequest {
  useCase: SpeechRecognitionUseCase;
  stream: STTAudioStream;
  /** Temporary migration constraint. Omit when environment priority may choose any implemented adapter. */
  adapterKinds?: SpeechRecognitionAdapterKind[];
}

export interface SpeechRecognitionStreamCallbacks {
  onUtterance(utterance: STTUtterance): void | Promise<void>;
  onState?(state: SpeechRecognitionCoordinatorState): void;
  onFailure?(failure: SpeechRecognitionFailure): void;
}

export interface CoordinatedSpeechRecognitionStream extends STTProviderSession {
  readonly ready: Promise<void>;
  getState(): SpeechRecognitionCoordinatorState;
}

interface PendingAudioChunk {
  bytes: Buffer;
  enqueuedAt: number;
}

function safeErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function boundedDetail(value: string): string {
  return value.slice(0, 500);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      timer.unref?.();
    }),
  ]);
}

class CoordinatedStream implements CoordinatedSpeechRecognitionStream {
  readonly ready: Promise<void>;

  private state: SpeechRecognitionCoordinatorState = { status: "connecting" };
  private candidates: ResolvedSpeechRecognitionBinding[] = [];
  private candidateIndex = -1;
  private candidateResolutionFailures = 0;
  private currentSession: STTProviderSession | null = null;
  private currentAttemptToken: symbol | null = null;
  private committedBinding: ResolvedSpeechRecognitionBinding | null = null;
  private committed = false;
  private pendingAudio: PendingAudioChunk[] = [];
  private pendingAudioBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private finishing = false;
  private terminal = false;
  private finishPromise: Promise<STTFinishOutcome> | null = null;

  constructor(
    private readonly request: SpeechRecognitionStreamRequest,
    private readonly callbacks: SpeechRecognitionStreamCallbacks,
  ) {
    this.ready = this.start();
  }

  getState(): SpeechRecognitionCoordinatorState {
    return this.state;
  }

  tryWriteAudio(bytes: Buffer): STTWriteOutcome {
    if (this.terminal || this.finishing) return "closed";
    if (bytes.length === 0) return "accepted";
    if (this.pendingAudio.length > 0 || !this.currentSession) {
      return this.enqueueAudio(bytes) ? "accepted" : "closed";
    }
    const outcome = this.currentSession.tryWriteAudio(bytes);
    if (outcome === "accepted") {
      this.commitCurrentBinding();
      return "accepted";
    }
    if (outcome === "blocked") {
      return this.enqueueAudio(bytes) ? "accepted" : "closed";
    }
    if (!this.enqueueAudio(bytes)) return "closed";
    this.scheduleProviderRecovery("Recognition session closed while audio was active");
    return this.terminal ? "closed" : "accepted";
  }

  sendAudio(bytes: Buffer): void {
    this.tryWriteAudio(bytes);
  }

  close(): void {
    void this.finish();
  }

  finish(): Promise<STTFinishOutcome> {
    if (this.finishPromise) return this.finishPromise;
    if (this.terminal) {
      return Promise.resolve({ outcome: this.state.status === "failed" ? "timed_out" : "finished" });
    }
    this.finishing = true;
    this.clearFlushTimer();
    this.finishPromise = this.finishInternal();
    return this.finishPromise;
  }

  abort(reason: string): void {
    if (this.terminal) return;
    this.finishing = true;
    this.terminal = true;
    this.clearFlushTimer();
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.currentAttemptToken = null;
    this.currentSession?.abort(reason);
    this.currentSession = null;
    this.setState({ status: "closed", detail: "Recognition aborted" });
  }

  private async start(): Promise<void> {
    this.setState({ status: "connecting", detail: "Resolving speech recognition candidates" });
    const allowedKinds = this.request.adapterKinds
      ? new Set(this.request.adapterKinds)
      : null;
    const resolution = await resolveSpeechRecognitionCandidateBindings({
      useCase: this.request.useCase,
      adapterKinds: this.request.adapterKinds,
    });
    this.candidateResolutionFailures = resolution.failureCount;
    this.candidates = resolution.bindings.filter(
      (binding) => !allowedKinds || allowedKinds.has(binding.adapterKind),
    );
    const configuredKinds = new Set(this.candidates.map((binding) => binding.adapterKind));

    const legacyKinds = this.request.adapterKinds || [];
    for (const adapterKind of legacyKinds) {
      if (adapterKind === "speechmatics-realtime" || configuredKinds.has(adapterKind)) continue;
      const legacy = await resolveLegacySpeechRecognitionBinding(adapterKind);
      if (!legacy) continue;
      this.candidates.push(legacy);
    }

    if (this.candidates.length === 0) {
      const detail = "No configured speech recognition candidate is available";
      this.fail({ kind: "configuration", detail, retryable: false });
      throw new Error(detail);
    }
    const connected = await this.connectNextStartupCandidate();
    if (!connected) {
      const detail = "Speech recognition candidates did not reach protocol readiness";
      this.fail({ kind: "startup", detail, retryable: true });
      throw new Error(detail);
    }
  }

  private async connectNextStartupCandidate(): Promise<boolean> {
    while (!this.terminal && !this.finishing && this.candidateIndex + 1 < this.candidates.length) {
      this.candidateIndex += 1;
      const binding = this.candidates[this.candidateIndex];
      try {
        await this.connectAttempt(binding, false);
        return true;
      } catch (error) {
        log.warn("Speech recognition candidate startup failed", {
          streamId: this.request.stream.streamId,
          adapterKind: binding.adapterKind,
          bindingId: binding.bindingId,
          candidateIndex: this.candidateIndex,
          errorType: safeErrorType(error),
        });
      }
    }
    return false;
  }

  private async connectAttempt(
    binding: ResolvedSpeechRecognitionBinding,
    reconnecting: boolean,
  ): Promise<void> {
    const attemptId = mintRecognitionAttemptId();
    const attemptToken = Symbol(attemptId);
    this.currentAttemptToken = attemptToken;
    this.currentSession = null;
    this.setState({
      status: reconnecting ? "reconnecting" : "connecting",
      attemptId,
      binding,
      detail: reconnecting
        ? `Reconnecting speech recognition (${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`
        : "Connecting speech recognition",
    });

    let protocolReady = false;
    const sink = createSerializedRecognitionSink(
      async (utterance) => {
        if (this.currentAttemptToken !== attemptToken || !utterance.isFinal) return;
        await this.callbacks.onUtterance(utterance);
      },
      () => undefined,
      {
        onProviderFailure: (error) => {
          if (protocolReady && this.currentAttemptToken === attemptToken) {
            this.scheduleProviderRecovery(error.message || "Speech recognition provider failed");
          }
        },
        onConsumerFailure: (error) => {
          if (this.currentAttemptToken === attemptToken) {
            this.fail({
              kind: "consumer",
              detail: "Meeting transcript persistence failed",
              retryable: false,
            });
            log.error("Speech recognition consumer failed", {
              streamId: this.request.stream.streamId,
              attemptId,
              errorType: safeErrorType(error),
            });
          }
        },
      },
    );

    const adapter = getSpeechRecognitionAdapter(binding.adapterKind);
    const session = await adapter.connect(binding, this.request.stream, sink, attemptId);
    if (this.terminal || this.finishing || this.currentAttemptToken !== attemptToken) {
      session.abort("Recognition attempt superseded during startup");
      throw new Error("Speech recognition attempt was superseded");
    }
    protocolReady = true;
    this.currentSession = session;
    if (!reconnecting) this.reconnectAttempts = 0;
    const startupDetail = this.candidateIndex > 0 || this.candidateResolutionFailures > 0
      ? "Recognition active after bounded startup fallback"
      : undefined;
    this.setState({ status: "active", attemptId, binding, detail: startupDetail });
    this.scheduleFlush();
  }

  private scheduleProviderRecovery(detail: string): void {
    if (this.terminal || this.finishing || this.recoveryPromise) return;
    this.recoveryPromise = this.recoverProvider(detail)
      .finally(() => {
        this.recoveryPromise = null;
      });
  }

  private async recoverProvider(detail: string): Promise<void> {
    if (this.terminal || this.finishing) return;
    const failedSession = this.currentSession;
    this.currentSession = null;
    this.currentAttemptToken = null;
    failedSession?.abort("Recognition provider recovery started");
    if (!this.committed) {
      const connected = await this.connectNextStartupCandidate();
      if (!connected && !this.terminal) {
        this.fail({
          kind: "provider",
          detail: "Speech recognition failed before audio commitment",
          retryable: true,
        });
      }
      return;
    }

    const binding = this.committedBinding;
    if (!binding) {
      this.fail({ kind: "provider", detail: "Committed recognition binding was lost", retryable: false });
      return;
    }
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      this.fail({
        kind: "provider",
        detail: `Speech recognition reconnect exhausted after ${RECONNECT_MAX_ATTEMPTS} attempts`,
        retryable: true,
      });
      return;
    }
    const reconnectAttempt = this.reconnectAttempts;
    this.setState({
      status: "reconnecting",
      binding,
      detail: boundedDetail(
        `Reconnecting the committed speech provider (${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS}): ${detail}`,
      ),
    });
    const delayMs = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempt - 1),
    );
    await delay(delayMs);
    if (this.terminal || this.finishing) return;
    try {
      await this.connectAttempt(binding, true);
      this.reconnectAttempts = 0;
    } catch (error) {
      log.warn("Speech recognition reconnect attempt failed", {
        streamId: this.request.stream.streamId,
        adapterKind: binding.adapterKind,
        bindingId: binding.bindingId,
        reconnectAttempt,
        errorType: safeErrorType(error),
      });
      this.reconnectAttempts = reconnectAttempt;
      const timer = setTimeout(() => {
        this.scheduleProviderRecovery("Speech recognition reconnect did not reach protocol readiness");
      }, 0);
      timer.unref?.();
    }
  }

  private commitCurrentBinding(): void {
    if (this.committed) return;
    const binding = this.state.binding;
    if (!binding) return;
    this.committed = true;
    this.committedBinding = binding;
  }

  private enqueueAudio(bytes: Buffer): boolean {
    if (this.terminal || this.finishing) return false;
    const oldestAt = this.pendingAudio[0]?.enqueuedAt ?? Date.now();
    if (
      this.pendingAudioBytes + bytes.length > MAX_PENDING_AUDIO_BYTES
      || Date.now() - oldestAt > MAX_PENDING_AUDIO_AGE_MS
    ) {
      this.fail({
        kind: "backpressure",
        detail: "Speech recognition could not keep up with live audio",
        retryable: true,
      });
      return false;
    }
    this.pendingAudio.push({ bytes: Buffer.from(bytes), enqueuedAt: Date.now() });
    this.pendingAudioBytes += bytes.length;
    this.scheduleFlush();
    return true;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.terminal || this.finishing || this.pendingAudio.length === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPendingAudio();
    }, AUDIO_FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  private flushPendingAudio(): void {
    if (this.terminal || !this.currentSession) return;
    while (this.pendingAudio.length > 0) {
      const chunk = this.pendingAudio[0];
      if (Date.now() - chunk.enqueuedAt > MAX_PENDING_AUDIO_AGE_MS) {
        this.fail({
          kind: "backpressure",
          detail: "Buffered speech recognition audio exceeded its time budget",
          retryable: true,
        });
        return;
      }
      const outcome = this.currentSession.tryWriteAudio(chunk.bytes);
      if (outcome === "blocked") {
        this.scheduleFlush();
        return;
      }
      if (outcome === "closed") {
        this.scheduleProviderRecovery("Recognition session closed while draining buffered audio");
        return;
      }
      this.commitCurrentBinding();
      this.pendingAudio.shift();
      this.pendingAudioBytes -= chunk.bytes.length;
    }
  }

  private async finishInternal(): Promise<STTFinishOutcome> {
    await this.recoveryPromise?.catch(() => undefined);
    const drainDeadline = Date.now() + FINISH_TIMEOUT_MS;
    while (!this.terminal && this.pendingAudio.length > 0 && Date.now() < drainDeadline) {
      this.flushPendingAudio();
      if (this.pendingAudio.length > 0) await delay(AUDIO_FLUSH_INTERVAL_MS);
    }
    if (this.pendingAudio.length > 0) {
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;
      this.currentSession?.abort("Recognition final audio drain timed out");
      this.currentSession = null;
      this.terminal = true;
      this.setState({ status: "failed", detail: "Speech recognition final audio drain timed out" });
      this.callbacks.onFailure?.({
        kind: "finish_timeout",
        detail: "Speech recognition final audio drain timed out",
        retryable: true,
      });
      return { outcome: "timed_out" };
    }
    const session = this.currentSession;
    this.currentSession = null;
    const outcome = session
      ? await timeout(session.finish(), FINISH_TIMEOUT_MS)
      : { outcome: "finished" as const };
    if (!outcome || outcome.outcome === "timed_out") {
      this.currentAttemptToken = null;
      session?.abort("Recognition provider finish timed out");
      this.terminal = true;
      this.setState({ status: "failed", detail: "Speech recognition final transcript drain timed out" });
      this.callbacks.onFailure?.({
        kind: "finish_timeout",
        detail: "Speech recognition final transcript drain timed out",
        retryable: true,
      });
      return { outcome: "timed_out" };
    }
    this.currentAttemptToken = null;
    this.terminal = true;
    this.setState({ status: "closed" });
    return { outcome: "finished" };
  }

  private fail(failure: SpeechRecognitionFailure): void {
    if (this.terminal) return;
    this.terminal = true;
    this.clearFlushTimer();
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.currentAttemptToken = null;
    this.currentSession?.abort(failure.detail);
    this.currentSession = null;
    this.setState({ status: "failed", detail: boundedDetail(failure.detail) });
    this.callbacks.onFailure?.({ ...failure, detail: boundedDetail(failure.detail) });
  }

  private setState(state: SpeechRecognitionCoordinatorState): void {
    this.state = state;
    this.callbacks.onState?.(state);
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

/** Shared bounded recognition lifecycle for Recall participant audio and native microphone capture. */
export class SpeechRecognitionStreamCoordinator {
  open(
    request: SpeechRecognitionStreamRequest,
    callbacks: SpeechRecognitionStreamCallbacks,
  ): CoordinatedSpeechRecognitionStream {
    return new CoordinatedStream(request, callbacks);
  }
}

export const speechRecognitionStreamCoordinator = new SpeechRecognitionStreamCoordinator();
