/**
 * V2.5 SSE Stream wrapper — fixes audit bug #2 (TTS delivery verification).
 *
 * The custom-LLM endpoint streams OpenAI-style SSE chunks back to ElevenLabs.
 * v2 wrote chunks to res.write without verifying the socket actually flushed
 * them, leaving silent gaps undiagnosable.
 *
 * This wrapper instruments any Express Response: every flushed chunk fires a
 * `voice_tts_delivery` diagnostic with bytes + cumulative count, and a final
 * "done" event reports the total. Failures (writeable=false, EPIPE, etc.)
 * surface as "error" diagnostics immediately.
 */
import type { Response } from "express";
import { emitDiagnostic } from "./diagnostics";
import { createLogger } from "../log";
const log = createLogger("voice-sse");

export interface InstrumentOpts {
  sessionId: string;
  chatSessionId?: string | null;
  turnId?: string;
}

export interface InstrumentedStream {
  /** Underlying response (already monkey-patched). */
  res: Response;
  /** How many SSE chunks have been written so far. */
  chunkCount: () => number;
  /** Total bytes written to the socket (excluding terminal "data: [DONE]"). */
  byteCount: () => number;
  /** Manually mark stream complete. */
  finalize: () => void;
}

/**
 * Patch a Response so every res.write call emits a delivery diagnostic.
 * Safe to call once per response; subsequent calls are no-ops (marker).
 */
export function instrumentSseResponse(res: Response, opts: InstrumentOpts): InstrumentedStream {
  const marker = res as unknown as Record<string, unknown>;
  if (marker.__v25Instrumented) {
    return marker.__v25Instrumented as InstrumentedStream;
  }

  let chunks = 0;
  let bytes = 0;
  let finalized = false;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res) as Response["end"];

  res.write = ((chunk: any, encoding?: any, cb?: any): boolean => {
    const buf = chunkToBuffer(chunk, encoding);
    const ok = originalWrite(chunk, encoding, cb);
    chunks += 1;
    bytes += buf.length;

    emitDiagnostic({
      sessionId: opts.sessionId,
      chatSessionId: opts.chatSessionId || null,
      step: "voice_tts_delivery",
      status: ok ? "started" : "error",
      detail: ok
        ? `chunk #${chunks} (${buf.length}B, total ${bytes}B)`
        : `socket back-pressure or closed (chunk #${chunks}, ${buf.length}B)`,
      turnId: opts.turnId,
      extra: { chunk: chunks, bytes },
    });

    return ok;
  }) as Response["write"];

  res.end = ((chunk?: any, encoding?: any, cb?: any) => {
    if (chunk !== undefined) {
      const buf = chunkToBuffer(chunk, encoding);
      bytes += buf.length;
    }
    if (!finalized) {
      finalized = true;
      emitDiagnostic({
        sessionId: opts.sessionId,
        chatSessionId: opts.chatSessionId || null,
        step: "voice_tts_delivery",
        status: "done",
        detail: `stream closed: ${chunks} chunk(s), ${bytes}B`,
        turnId: opts.turnId,
        extra: { totalChunks: chunks, totalBytes: bytes },
      });
    }
    return originalEnd(chunk, encoding, cb);
  }) as Response["end"];

  const handle: InstrumentedStream = {
    res,
    chunkCount: () => chunks,
    byteCount: () => bytes,
    finalize: () => {
      if (finalized) return;
      finalized = true;
      emitDiagnostic({
        sessionId: opts.sessionId,
        chatSessionId: opts.chatSessionId || null,
        step: "voice_tts_delivery",
        status: "done",
        detail: `manual finalize: ${chunks} chunk(s), ${bytes}B`,
        turnId: opts.turnId,
        extra: { totalChunks: chunks, totalBytes: bytes },
      });
    },
  };
  marker.__v25Instrumented = handle;
  return handle;
}

function chunkToBuffer(chunk: unknown, encoding?: BufferEncoding | string): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, (encoding as BufferEncoding) || "utf-8");
  if (chunk == null) return Buffer.alloc(0);
  try {
    return Buffer.from(String(chunk));
  } catch (err) {
    // Fail Loudly: returning a silent zero-byte buffer here would corrupt
    // every downstream chunk/byte counter and hide a real bug.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[voice-sse] chunkToBuffer: unable to serialize chunk type=${typeof chunk}: ${msg}`);
    return Buffer.alloc(0);
  }
}
