// Use createLogger for logging ONLY
import {
  BROWSER_TELEMETRY_ENDPOINT,
  BROWSER_TELEMETRY_LIMITS,
  type BrowserTelemetryEventInput,
} from "@shared/browser-telemetry";
import { createLogger } from "@/lib/logger";

const log = createLogger("BrowserTelemetry");

const FLUSH_INTERVAL_MS = 5_000;
const MAX_PENDING_EVENTS = 250;
const LONG_TASK_THRESHOLD_MS = 75;
const EVENT_LOOP_LAG_THRESHOLD_MS = 120;
const FRAME_CONTENTION_THRESHOLD_MS = 32;
const FRAME_CONTENTION_MIN_INTERVAL_MS = 5_000;
const NAVIGATION_SAMPLE_RATE = 0.25;
const RESPONSIVENESS_SAMPLE_RATE = 0.25;

let pendingEvents: BrowserTelemetryEventInput[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let lastFrameContentionAt = 0;
let lastEventLoopProbeAt = 0;
const chatTurns = new Map<string, { sessionId: string | null; submittedAt: number; ackAt?: number; firstTokenAt?: number }>();
const completedChatTurns = new Set<string>();

function safeNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function routeKey(): string {
  if (typeof window === "undefined") return "unknown";
  return `${window.location.pathname || "/"}`.slice(0, BROWSER_TELEMETRY_LIMITS.maxStringLength);
}

/** Returns the current page visibility state, or undefined if the API is unavailable. */
function captureVisibility(): "visible" | "hidden" | undefined {
  if (typeof document === "undefined" || typeof document.visibilityState === "undefined") return undefined;
  return document.visibilityState === "visible" ? "visible" : "hidden";
}

function scheduleFlush(): void {
  if (flushTimer || typeof window === "undefined") return;
  flushTimer = setTimeout(() => void flushBrowserTelemetry(), FLUSH_INTERVAL_MS);
}

export function recordBrowserTelemetry(event: BrowserTelemetryEventInput): void {
  if (typeof window === "undefined") return;
  if (!Number.isFinite(event.value) || event.value < 0) return;
  if (pendingEvents.length >= MAX_PENDING_EVENTS) pendingEvents.shift();
  pendingEvents.push({
    ...event,
    routeKey: event.routeKey ?? routeKey(),
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    // Tag visibility at capture time so the server can filter background-tab noise.
    // Caller may override by providing visibility explicitly (e.g. chat_latency always keeps all).
    visibility: event.visibility ?? captureVisibility(),
  });
  scheduleFlush();
}

export async function flushBrowserTelemetry(useBeacon = false): Promise<void> {
  flushTimer = null;
  if (pendingEvents.length === 0) return;
  const batch = pendingEvents.splice(0, BROWSER_TELEMETRY_LIMITS.maxBatchSize);
  if (pendingEvents.length > 0) scheduleFlush();
  const body = JSON.stringify({ events: batch });
  try {
    if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(BROWSER_TELEMETRY_ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    await fetch(BROWSER_TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body,
    });
  } catch (error) {
    log.warn("flush failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

function bucketDuration(ms: number): string {
  if (ms < 250) return "under_250ms";
  if (ms < 1_000) return "250ms_1s";
  if (ms < 3_000) return "1s_3s";
  if (ms < 10_000) return "3s_10s";
  return "over_10s";
}

export function markChatSubmitted(clientTurnId: string, sessionId: string | null, submittedAt = safeNow()): void {
  chatTurns.set(clientTurnId, { sessionId, submittedAt });
}

export function markChatAck(clientTurnId: string, sessionId: string | null): void {
  const turn = chatTurns.get(clientTurnId);
  if (!turn || turn.ackAt) return;
  turn.sessionId = sessionId ?? turn.sessionId;
  turn.ackAt = safeNow();
  const value = turn.ackAt - turn.submittedAt;
  recordBrowserTelemetry({
    kind: "chat_latency",
    name: "submit_to_ack",
    value,
    unit: "ms",
    sessionId: turn.sessionId ?? undefined,
    clientTurnId,
    bucket: bucketDuration(value),
  });
}

export function markChatStreamProgress(sessionId: string, hasAssistantContent: boolean, status?: string): void {
  for (const [clientTurnId, turn] of chatTurns) {
    if (turn.sessionId !== sessionId || completedChatTurns.has(clientTurnId)) continue;
    const now = safeNow();
    if (hasAssistantContent && !turn.firstTokenAt) {
      turn.firstTokenAt = now;
      const value = now - turn.submittedAt;
      recordBrowserTelemetry({ kind: "chat_latency", name: "submit_to_first_token", value, unit: "ms", sessionId, clientTurnId, bucket: bucketDuration(value) });
    }
    if (status && status !== "streaming") {
      completedChatTurns.add(clientTurnId);
      const value = now - turn.submittedAt;
      recordBrowserTelemetry({ kind: "chat_latency", name: "submit_to_complete", value, unit: "ms", sessionId, clientTurnId, bucket: bucketDuration(value), metadata: { status } });
      chatTurns.delete(clientTurnId);
    }
  }
}

export function recordTransportGap(name: string, value: number, metadata: Record<string, unknown> = {}): void {
  recordBrowserTelemetry({ kind: "transport_gap", name, value, unit: "ms", bucket: bucketDuration(value), metadata });
}

function hasContentSegment(content: unknown): boolean {
  const segments = (content as { segments?: unknown[] } | null)?.segments;
  if (!Array.isArray(segments)) return false;
  return segments.some((segment) => {
    const s = segment as { type?: unknown; content?: unknown };
    return s.type === "content" && typeof s.content === "string" && s.content.length > 0;
  });
}

export function streamingContentHasText(content: unknown): boolean {
  return hasContentSegment(content);
}

function observeNavigation(): void {
  if (Math.random() > NAVIGATION_SAMPLE_RATE) return;
  window.addEventListener("load", () => {
    window.setTimeout(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (!nav) return;
      const metrics: Array<[string, number]> = [
        ["duration", nav.duration],
        ["dom_content_loaded", nav.domContentLoadedEventEnd],
        ["response", nav.responseEnd - nav.requestStart],
        ["transfer", nav.responseEnd - nav.fetchStart],
      ];
      for (const [name, value] of metrics) {
        if (Number.isFinite(value) && value > 0) recordBrowserTelemetry({ kind: "navigation", name, value, unit: "ms", bucket: bucketDuration(value) });
      }
    }, 0);
  }, { once: true });
}

function observeWebVitals(): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "largest-contentful-paint") {
          recordBrowserTelemetry({ kind: "web_vital", name: "lcp", value: entry.startTime, unit: "ms", bucket: bucketDuration(entry.startTime) });
        } else if (entry.entryType === "layout-shift") {
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (!shift.hadRecentInput && typeof shift.value === "number") {
            recordBrowserTelemetry({ kind: "web_vital", name: "cls", value: shift.value, unit: "score" });
          }
        } else if (entry.entryType === "first-input") {
          const firstInput = entry as PerformanceEntry & { processingStart?: number };
          if (typeof firstInput.processingStart === "number") {
            const value = firstInput.processingStart - entry.startTime;
            recordBrowserTelemetry({ kind: "web_vital", name: "fid", value, unit: "ms", bucket: bucketDuration(value) });
          }
        }
      }
    });
    observer.observe({ type: "largest-contentful-paint", buffered: true });
    observer.observe({ type: "layout-shift", buffered: true });
    observer.observe({ type: "first-input", buffered: true });
  } catch {
    // Unsupported metric APIs are expected in some browsers.
  }
}

function observeLongTasks(): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= LONG_TASK_THRESHOLD_MS) {
          recordBrowserTelemetry({ kind: "long_task", name: "main_thread_blocked", value: entry.duration, unit: "ms", bucket: bucketDuration(entry.duration) });
        }
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // longtask is not universal.
  }
}

function observeEventLoopResponsiveness(): void {
  if (Math.random() > RESPONSIVENESS_SAMPLE_RATE) return;
  const interval = 5_000;
  let expected = Date.now() + interval;
  window.setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + interval;
    if (lag >= EVENT_LOOP_LAG_THRESHOLD_MS && now - lastEventLoopProbeAt > interval) {
      lastEventLoopProbeAt = now;
      recordBrowserTelemetry({ kind: "event_loop_responsiveness", name: "timer_lag", value: lag, unit: "ms", bucket: bucketDuration(lag) });
    }
  }, interval);
}

function observeFrameContention(): void {
  let previous = safeNow();
  const tick = (now: number) => {
    const delta = now - previous;
    previous = now;
    if (delta >= FRAME_CONTENTION_THRESHOLD_MS && Date.now() - lastFrameContentionAt >= FRAME_CONTENTION_MIN_INTERVAL_MS) {
      lastFrameContentionAt = Date.now();
      recordBrowserTelemetry({ kind: "frame_contention", name: "slow_frame", value: delta, unit: "ms", bucket: bucketDuration(delta) });
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

export function initializeBrowserTelemetry(): void {
  if (initialized || typeof window === "undefined" || typeof performance === "undefined") return;
  initialized = true;
  observeNavigation();
  observeWebVitals();
  observeLongTasks();
  observeEventLoopResponsiveness();
  observeFrameContention();
  window.addEventListener("pagehide", () => void flushBrowserTelemetry(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushBrowserTelemetry(true);
  });
}
