import { apiRequest } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";

const log = createLogger("VoiceSession");

export interface VoiceStartResponse {
  signedUrl: string;
  chatSessionKey?: string;
  sessionId?: string;
  chatSessionId?: string;
  voiceId?: string;
  agentId?: string;
  timings?: Record<string, number>;
  type?: string;
  serverTranscript?: Array<{
    role: string;
    content: string;
    timestamp?: string;
    persona?: { id: number; name: string; icon: string };
  }>;
  persona?: { id: number; name: string; icon: string };
  firstMessage?: string;
}

export interface VoiceStartPhaseEvent {
  phase: string;
  status: "started" | "done" | "error";
  elapsedMs: number;
  source: "phase" | "error";
  error?: string;
}

export interface VoiceStartTransportCallbacks {
  onPhase: (event: VoiceStartPhaseEvent) => void;
  onPhasePersisted: (persisted: boolean) => void;
}

export interface VoiceStartRequest {
  chatSessionId: string | null;
  isReconnect: boolean;
  requestId: string;
}

function toBoundedLogError(error: unknown): { name?: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name || undefined, message: error.message || "Unknown error" };
  }
  if (typeof error === "string") return { message: error.slice(0, 300) };
  return { message: "Unknown error" };
}

export function createVoiceStartRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function fetchVoiceStartStream(
  request: VoiceStartRequest,
  signal: AbortSignal,
  callbacks: VoiceStartTransportCallbacks,
): Promise<VoiceStartResponse> {
  const response = await fetch("/api/voice/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify({
      chatSessionId: request.chatSessionId || undefined,
      isReconnect: request.isReconnect || undefined,
      requestId: request.requestId,
    }),
    signal,
  });

  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data as VoiceStartResponse;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let serverError: string | null = null;
  let startData: VoiceStartResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === "phase") {
          const phaseEvent: VoiceStartPhaseEvent = {
            phase: String(event.phase || "unknown"),
            status: event.status === "started" || event.status === "error" ? event.status : "done",
            elapsedMs: Number(event.elapsedMs || 0),
            source: "phase",
            error: event.error ? String(event.error) : undefined,
          };
          log.debug("VOICE:START_SSE:PHASE", phaseEvent);
          callbacks.onPhase(phaseEvent);
        } else if (event.type === "phase_persisted") {
          const persisted = Boolean(event.persisted);
          log.debug("VOICE:START_SSE:PHASE_PERSISTED", { persisted });
          callbacks.onPhasePersisted(persisted);
        } else if (event.type === "complete") {
          log.debug("VOICE:START_SSE:COMPLETE");
          startData = event as VoiceStartResponse;
        } else if (event.type === "error") {
          const error = String(event.error || "Voice start failed");
          const phase = event.phase ? String(event.phase) : undefined;
          const elapsedMs = Number(event.elapsedMs || 0);
          log.warn("VOICE:START_SSE:ERROR", { phase: phase || "unknown", error: error.slice(0, 300), elapsedMs });
          serverError = error;
          if (phase) callbacks.onPhase({ phase, status: "error", elapsedMs, source: "error", error });
        }
      } catch (error) {
        log.warn("VOICE:START_SSE:PARSE_FAILED", toBoundedLogError(error));
      }
    }
  }

  if (serverError && !startData) throw new Error(serverError);
  if (!startData) throw new Error("SSE stream ended without complete event");
  return startData;
}

export async function fetchVoiceStartFallback(request: VoiceStartRequest): Promise<VoiceStartResponse> {
  log.warn("VOICE:START_SSE:FALLBACK", { fallback: "non_streaming" });
  const response = await apiRequest("POST", "/api/voice/start", {
    chatSessionId: request.chatSessionId || undefined,
    isReconnect: request.isReconnect || undefined,
    requestId: request.requestId,
  });
  return await response.json() as VoiceStartResponse;
}
