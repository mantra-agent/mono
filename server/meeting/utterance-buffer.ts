import { createLogger } from "../log";

const log = createLogger("MeetingUtteranceBuffer");

const DEFAULT_SILENCE_MS = 1_800;
const MIN_SILENCE_MS = 250;
const MAX_SILENCE_MS = 10_000;
const MAX_BUFFER_CHARS = 20_000;
const MAX_ACTIVE_BUFFERS = 1_000;
const FINALIZED_EVENT_TTL_MS = 5 * 60_000;

export interface MeetingUtteranceChunk {
  sessionId: string;
  speakerKey: string;
  speakerLabel?: string;
  text: string;
  final: boolean;
  eventId?: string;
}

export interface FinalizedMeetingUtterance {
  sessionId: string;
  speakerLabel?: string;
  text: string;
  reason: "provider_final" | "silence";
}

export type FinalizedMeetingUtteranceHandler = (
  utterance: FinalizedMeetingUtterance,
) => Promise<void>;

interface BufferedUtterance {
  sessionId: string;
  speakerLabel?: string;
  text: string;
  timer: NodeJS.Timeout | null;
  generation: number;
  updatedAt: number;
}

function configuredSilenceMs(): number {
  const parsed = Number.parseInt(process.env.MEETING_UTTERANCE_SILENCE_MS || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SILENCE_MS;
  return Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, parsed));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Partial transcript providers usually send cumulative revisions ("hel" →
 * "hello there"), but some send deltas. Preserve either shape without
 * duplicating cumulative prefixes.
 */
function mergeTranscriptText(current: string, incoming: string): string {
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming === current) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;

  const maxOverlap = Math.min(current.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.slice(-overlap) === incoming.slice(0, overlap)) {
      return `${current}${incoming.slice(overlap)}`;
    }
  }
  return `${current} ${incoming}`;
}

/**
 * Per-speaker utterance assembler. It is intentionally upstream of meeting
 * persistence: only finalized utterances cross the canonical ingest boundary.
 */
export class MeetingUtteranceBuffer {
  private readonly buffers = new Map<string, BufferedUtterance>();
  private readonly updateChains = new Map<string, Promise<void>>();
  private readonly finalizedEventIds = new Map<string, number>();
  private readonly silenceMs: number;

  constructor(
    private readonly onFinalized: FinalizedMeetingUtteranceHandler,
    opts: { silenceMs?: number } = {},
  ) {
    this.silenceMs = opts.silenceMs ?? configuredSilenceMs();
  }

  push(chunk: MeetingUtteranceChunk): Promise<void> {
    const key = `${chunk.sessionId}:${chunk.speakerKey}`;
    const prior = this.updateChains.get(key) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.applyChunk(key, chunk))
      .finally(() => {
        if (this.updateChains.get(key) === next) this.updateChains.delete(key);
      });
    this.updateChains.set(key, next);
    return next;
  }

  private async applyChunk(key: string, chunk: MeetingUtteranceChunk): Promise<void> {
    this.pruneFinalizedEventIds();
    if (chunk.final && chunk.eventId && this.finalizedEventIds.has(chunk.eventId)) {
      log.debug(`duplicate Recall transcript event ignored eventId=${chunk.eventId}`);
      return;
    }

    const incoming = normalizeText(chunk.text);
    if (!incoming) return;

    const current = this.buffers.get(key);
    if (current?.timer) clearTimeout(current.timer);
    const merged = chunk.final && current
      ? incoming
      : mergeTranscriptText(current?.text ?? "", incoming);
    const state: BufferedUtterance = {
      sessionId: chunk.sessionId,
      speakerLabel: chunk.speakerLabel ?? current?.speakerLabel,
      text: merged.slice(0, MAX_BUFFER_CHARS),
      timer: null,
      generation: (current?.generation ?? 0) + 1,
      updatedAt: Date.now(),
    };
    this.buffers.set(key, state);
    this.enforceBufferLimit();

    if (chunk.final) {
      if (chunk.eventId) {
        this.finalizedEventIds.set(chunk.eventId, Date.now() + FINALIZED_EVENT_TTL_MS);
      }
      await this.flush(key, state.generation, "provider_final");
      return;
    }

    const generation = state.generation;
    state.timer = setTimeout(() => {
      void this.enqueueFlush(key, generation);
    }, this.silenceMs);
    state.timer.unref?.();
    log.debug(
      `partial utterance buffered sessionId=${chunk.sessionId} speakerKey=${chunk.speakerKey} chars=${state.text.length}`,
    );
  }

  private async enqueueFlush(key: string, generation: number): Promise<void> {
    const prior = this.updateChains.get(key) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.flush(key, generation, "silence"))
      .finally(() => {
        if (this.updateChains.get(key) === next) this.updateChains.delete(key);
      });
    this.updateChains.set(key, next);
    await next;
  }

  private async flush(
    key: string,
    generation: number,
    reason: FinalizedMeetingUtterance["reason"],
  ): Promise<void> {
    const state = this.buffers.get(key);
    if (!state || state.generation !== generation) return;
    if (state.timer) clearTimeout(state.timer);
    this.buffers.delete(key);

    log.info(
      `utterance finalized sessionId=${state.sessionId} reason=${reason} chars=${state.text.length}`,
    );
    try {
      await this.onFinalized({
        sessionId: state.sessionId,
        speakerLabel: state.speakerLabel,
        text: state.text,
        reason,
      });
    } catch (err) {
      log.error(
        `utterance finalization failed sessionId=${state.sessionId} reason=${reason}`,
        err,
      );
    }
  }

  private enforceBufferLimit(): void {
    if (this.buffers.size <= MAX_ACTIVE_BUFFERS) return;
    const oldest = [...this.buffers.entries()].sort(
      ([, a], [, b]) => a.updatedAt - b.updatedAt,
    )[0];
    if (!oldest) return;
    if (oldest[1].timer) clearTimeout(oldest[1].timer);
    this.buffers.delete(oldest[0]);
    log.warn(
      `active utterance buffer limit exceeded; dropped oldest partial sessionId=${oldest[1].sessionId}`,
    );
  }

  private pruneFinalizedEventIds(): void {
    const now = Date.now();
    for (const [eventId, expiresAt] of this.finalizedEventIds) {
      if (expiresAt <= now) this.finalizedEventIds.delete(eventId);
    }
  }
}
