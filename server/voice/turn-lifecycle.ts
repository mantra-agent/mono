/**
 * V2.5 Turn Lifecycle — orchestrates the end-to-end request flow for a
 * single ElevenLabs custom-LLM callback:
 *
 *   1. Instrument the SSE response (sse-stream → bug #2).
 *   2. Resolve / create the voice session (session-state).
 *   3. Hand the request to the executor (LLM call + tool exec).
 *   4. On error, surface a diagnostic and ensure the response closes.
 *
 * This module is the only entry point the route layer should call when the
 * active engine is v2.5.
 */
import type { Request, Response } from "express";
import { createLogger } from "../log";
import { instrumentSseResponse } from "./sse-stream";
// executor.ts shim deleted — import handleCustomLLM directly
import { handleCustomLLM } from "../voice-llm";
import { emitDiagnostic } from "./diagnostics";

const log = createLogger("voice-lifecycle");

function pickSessionId(req: Request): string {
  const params = (req.params || {}) as Record<string, string>;
  const body = (req.body || {}) as Record<string, unknown>;
  return (
    (typeof params.sessionId === "string" && params.sessionId) ||
    (typeof body.sessionId === "string" ? (body.sessionId as string) : "") ||
    "unknown"
  );
}

function pickChatSessionId(req: Request): string | null {
  const params = (req.params || {}) as Record<string, string>;
  const body = (req.body || {}) as Record<string, unknown>;
  const v =
    (typeof params.chatSessionId === "string" && params.chatSessionId) ||
    (typeof body.chatSessionId === "string" ? (body.chatSessionId as string) : "");
  return v && v !== "_" ? v : null;
}

export async function handleV25CustomLLM(req: Request, res: Response): Promise<void> {
  const sessionId = pickSessionId(req);
  const chatSessionId = pickChatSessionId(req);
  const turnId = `t-${Date.now().toString(36)}`;

  // Bug #2: every chunk written from here on emits a delivery diagnostic.
  instrumentSseResponse(res, { sessionId, chatSessionId, turnId });

  emitDiagnostic({
    sessionId,
    chatSessionId,
    step: "v25_turn_start",
    status: "started",
    detail: `path=${req.path}`,
    turnId,
  });

  const startedAt = Date.now();
  try {
    await handleCustomLLM(req, res);
    emitDiagnostic({
      sessionId,
      chatSessionId,
      step: "v25_turn_complete",
      status: "done",
      elapsedMs: Date.now() - startedAt,
      turnId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`handleV25CustomLLM crashed sessionId=${sessionId}: ${msg}`);
    emitDiagnostic({
      sessionId,
      chatSessionId,
      step: "v25_turn_error",
      status: "error",
      detail: msg,
      elapsedMs: Date.now() - startedAt,
      turnId,
    });
    if (!res.headersSent) {
      res.status(500).json({ error: msg });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}
