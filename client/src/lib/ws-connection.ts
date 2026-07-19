// Use createLogger for logging ONLY
import { chatBeacon } from "@/lib/chat-beacon";
import { createLogger } from "@/lib/logger";
import { recordTransportGap } from "@/lib/browser-telemetry";

const log = createLogger("SharedWS");

type MessageHandler = (msg: unknown) => void;
type LifecycleHandler = () => void;
type CloseHandler = (code: number, reason: string) => void;

interface SharedWebSocket {
  addMessageHandler(id: string, handler: MessageHandler): void;
  removeMessageHandler(id: string): void;
  addReconnectHandler(id: string, handler: LifecycleHandler): void;
  removeReconnectHandler(id: string): void;
  addOpenHandler(id: string, handler: LifecycleHandler): void;
  removeOpenHandler(id: string): void;
  addCloseHandler(id: string, handler: CloseHandler): void;
  removeCloseHandler(id: string): void;
  addErrorHandler(id: string, handler: LifecycleHandler): void;
  removeErrorHandler(id: string): void;
  connect(): void;
  close(): void;
  send(payload: Record<string, unknown>): boolean;
  forceReconnect(): void;
  getReadyState(): number;
  wasReconnectOpen(): boolean;
  isAlive(): boolean;
  setStreamActive(ownerId: string, active: boolean): void;
  getDiagnostics(): Omit<SharedWSDiagnostics, "refCount" | "peakRefCount" | "ownerCount" | "peakOwnerCount" | "ownerRefs" | "duplicateOwnerRefs">;
}

export interface SharedWSDiagnostics {
  readyState: number;
  physicalSockets: number;
  refCount: number;
  peakRefCount: number;
  ownerCount: number;
  peakOwnerCount: number;
  ownerRefs: Record<string, number>;
  duplicateOwnerRefs: number;
  messageHandlers: number;
  lifecycleHandlers: number;
  streamOwners: number;
  reconnects: number;
  forcedReconnects: number;
  connectedAt: number | null;
  lastMessageAt: number | null;
}

let instance: SharedWebSocket | null = null;
let refCount = 0;
let hasEverConnected = false;
let lastOpenWasReconnect = false;
let closeDelayTimer: ReturnType<typeof setTimeout> | null = null;
let peakRefCount = 0;
let peakOwnerCount = 0;
const ownerRefs = new Map<string, number>();
const diagnosticListeners = new Set<() => void>();

const EMPTY_DIAGNOSTICS: SharedWSDiagnostics = {
  readyState: WebSocket.CLOSED,
  physicalSockets: 0,
  refCount: 0,
  peakRefCount: 0,
  ownerCount: 0,
  peakOwnerCount: 0,
  ownerRefs: {},
  duplicateOwnerRefs: 0,
  messageHandlers: 0,
  lifecycleHandlers: 0,
  streamOwners: 0,
  reconnects: 0,
  forcedReconnects: 0,
  connectedAt: null,
  lastMessageAt: null,
};
let diagnosticSnapshot: SharedWSDiagnostics = EMPTY_DIAGNOSTICS;

function emitDiagnostics(): void {
  const instanceDiagnostics = instance?.getDiagnostics() ?? EMPTY_DIAGNOSTICS;
  const ownerEntries = Array.from(ownerRefs.entries()).sort(([a], [b]) => a.localeCompare(b));
  diagnosticSnapshot = {
    ...instanceDiagnostics,
    refCount,
    peakRefCount,
    ownerCount: ownerRefs.size,
    peakOwnerCount,
    ownerRefs: Object.fromEntries(ownerEntries),
    duplicateOwnerRefs: ownerEntries.reduce((total, [, count]) => total + Math.max(0, count - 1), 0),
  };
  diagnosticListeners.forEach((listener) => listener());
}

export function subscribeSharedWSDiagnostics(listener: () => void): () => void {
  diagnosticListeners.add(listener);
  return () => diagnosticListeners.delete(listener);
}

export function getSharedWSDiagnostics(): SharedWSDiagnostics {
  return diagnosticSnapshot;
}

const LIVENESS_TIMEOUT_MS = 45_000;
const LIVENESS_CHECK_INTERVAL_MS = 30_000;
const CLOSE_DELAY_MS = 50;

function createSharedWebSocket(): SharedWebSocket {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;
  let reconnectAttempt = 0;
  let lastMessageTime = Date.now();
  let connectTime = 0;
  const streamOwners = new Set<string>();
  let reconnects = 0;
  let forcedReconnects = 0;
  let connectedAt: number | null = null;
  let lastMessageAt: number | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  const messageHandlers = new Map<string, MessageHandler>();
  const reconnectHandlers = new Map<string, LifecycleHandler>();
  const openHandlers = new Map<string, LifecycleHandler>();
  const closeHandlers = new Map<string, CloseHandler>();
  const errorHandlers = new Map<string, LifecycleHandler>();

  function doConnect() {
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

    intentionalClose = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/events`;
    log.debug(`connecting url=${url} refCount=${refCount}`);
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      const wasReconnect = hasEverConnected;
      lastOpenWasReconnect = wasReconnect;
      reconnectAttempt = 0;
      connectTime = Date.now();
      connectedAt = connectTime;
      lastMessageTime = connectTime;
      lastMessageAt = connectTime;
      log.debug(`open wasReconnect=${wasReconnect} refCount=${refCount}`);
      hasEverConnected = true;
      if (wasReconnect) {
        reconnects++;
        recordTransportGap("reconnect", Math.max(0, connectTime - lastMessageTime), { reconnectAttempt, refCount, streamActive: streamOwners.size > 0 });
      }
      startLivenessTimer();
      emitDiagnostics();
      for (const [id, handler] of openHandlers) {
        try {
          handler();
        } catch (err) {
          log.warn(`open handler '${id}' error:`, err);
        }
      }
      if (wasReconnect) {
        for (const [id, handler] of reconnectHandlers) {
          try {
            handler();
          } catch (err) {
            log.warn(`reconnect handler '${id}' error:`, err);
          }
        }
      }
    };

    socket.onmessage = (e) => {
      lastMessageTime = Date.now();
      lastMessageAt = lastMessageTime;
      let msg: unknown;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        log.warn("message parse error:", err);
        return;
      }
      const m = msg as Record<string, unknown>;
      if (m.type === "ping") {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "pong" }));
        }
        return;
      }
      for (const handler of messageHandlers.values()) {
        try {
          handler(msg);
        } catch (err) {
          log.warn("handler error:", err);
        }
      }
    };

    socket.onclose = (ev) => {
      const duration = connectTime ? Date.now() - connectTime : 0;
      log.debug(`close code=${ev.code} reason=${ev.reason || "none"} intentional=${intentionalClose} duration=${duration}ms refCount=${refCount} reconnectAttempt=${reconnectAttempt}`);
      chatBeacon("ws_close", {
        code: ev.code,
        reason: ev.reason || "none",
        intentional: intentionalClose,
        durationMs: duration,
        refCount,
        streamActive: streamOwners.size > 0,
      });
      ws = null;
      connectedAt = null;
      emitDiagnostics();
      for (const handler of closeHandlers.values()) {
        try {
          handler(ev.code, ev.reason || "none");
        } catch (err) {
          log.warn("close handler error:", err);
        }
      }
      if (!intentionalClose) {
        const attempt = reconnectAttempt++;
        const delay = Math.min(500 * Math.pow(1.5, attempt), 5000);
        log.debug(`scheduling reconnect in ${Math.round(delay)}ms attempt=${attempt}`);
        reconnectTimer = setTimeout(doConnect, delay);
      }
    };

    socket.onerror = () => {
      log.warn(`error refCount=${refCount}`);
      emitDiagnostics();
      for (const handler of errorHandlers.values()) {
        try {
          handler();
        } catch (err) {
          log.warn("error handler error:", err);
        }
      }
      socket.close();
    };
  }

  function forceReconnect() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const elapsed = Date.now() - lastMessageTime;
    log.warn(`forceReconnect — socket OPEN but dead (no message in ${elapsed}ms), recycling`);
    forcedReconnects++;
    chatBeacon("ws_force_reconnect", { elapsedSinceLastMsg: elapsed, streamActive: streamOwners.size > 0 });
    recordTransportGap("liveness_timeout", elapsed, { streamActive: streamOwners.size > 0 });
    emitDiagnostics();
    ws.close(4000, "liveness-timeout");
  }

  function startLivenessTimer() {
    if (livenessTimer) return;
    livenessTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && streamOwners.size > 0) {
        if ((Date.now() - lastMessageTime) >= LIVENESS_TIMEOUT_MS) {
          forceReconnect();
        }
      }
    }, LIVENESS_CHECK_INTERVAL_MS);
  }

  function stopLivenessTimer() {
    if (livenessTimer) {
      clearInterval(livenessTimer);
      livenessTimer = null;
    }
  }

  function doClose() {
    log.debug(`doClose intentionalClose=true wsState=${ws?.readyState ?? "null"} refCount=${refCount}`);
    intentionalClose = true;
    stopLivenessTimer();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close(1000, "client-release");
    }
  }

  function doSend(payload: Record<string, unknown>): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      log.warn("send failed:", err);
      return false;
    }
  }

  return {
    addMessageHandler(id, handler) {
      messageHandlers.set(id, handler);
      emitDiagnostics();
    },
    removeMessageHandler(id) {
      messageHandlers.delete(id);
      emitDiagnostics();
    },
    addReconnectHandler(id, handler) {
      reconnectHandlers.set(id, handler);
      emitDiagnostics();
    },
    removeReconnectHandler(id) {
      reconnectHandlers.delete(id);
      emitDiagnostics();
    },
    addOpenHandler(id, handler) {
      openHandlers.set(id, handler);
      emitDiagnostics();
    },
    removeOpenHandler(id) {
      openHandlers.delete(id);
      emitDiagnostics();
    },
    addCloseHandler(id, handler) {
      closeHandlers.set(id, handler);
      emitDiagnostics();
    },
    removeCloseHandler(id) {
      closeHandlers.delete(id);
      emitDiagnostics();
    },
    addErrorHandler(id, handler) {
      errorHandlers.set(id, handler);
      emitDiagnostics();
    },
    removeErrorHandler(id) {
      errorHandlers.delete(id);
      emitDiagnostics();
    },
    connect: doConnect,
    close: doClose,
    send: doSend,
    forceReconnect,
    getReadyState() {
      return ws?.readyState ?? WebSocket.CLOSED;
    },
    wasReconnectOpen() {
      return lastOpenWasReconnect;
    },
    isAlive() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      return (Date.now() - lastMessageTime) < LIVENESS_TIMEOUT_MS;
    },
    setStreamActive(ownerId: string, active: boolean) {
      if (active) streamOwners.add(ownerId);
      else streamOwners.delete(ownerId);
      emitDiagnostics();
    },
    getDiagnostics() {
      return {
        readyState: ws?.readyState ?? WebSocket.CLOSED,
        physicalSockets: ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ? 1 : 0,
        messageHandlers: messageHandlers.size,
        lifecycleHandlers: reconnectHandlers.size + openHandlers.size + closeHandlers.size + errorHandlers.size,
        streamOwners: streamOwners.size,
        reconnects,
        forcedReconnects,
        connectedAt,
        lastMessageAt,
      };
    },
  };
}

export function acquireSharedWS(caller?: string): SharedWebSocket {
  const ownerId = caller ?? "anonymous";
  const tag = ` caller=${ownerId}`;
  if (closeDelayTimer) {
    clearTimeout(closeDelayTimer);
    closeDelayTimer = null;
    log.debug(`acquire cancelled pending close refCount=${refCount + 1}${tag}`);
  }
  if (!instance) {
    log.debug(`acquire creating new instance refCount=1 hasEverConnected=${hasEverConnected}${tag}`);
    instance = createSharedWebSocket();
    instance.connect();
  } else {
    log.debug(`acquire reusing instance refCount=${refCount + 1}${tag}`);
  }
  refCount++;
  ownerRefs.set(ownerId, (ownerRefs.get(ownerId) ?? 0) + 1);
  peakRefCount = Math.max(peakRefCount, refCount);
  peakOwnerCount = Math.max(peakOwnerCount, ownerRefs.size);
  emitDiagnostics();
  return instance;
}

export function releaseSharedWS(caller?: string) {
  const ownerId = caller ?? "anonymous";
  const ownerRefCount = ownerRefs.get(ownerId) ?? 0;
  const tag = ` caller=${ownerId}`;
  if (ownerRefCount === 0) {
    log.warn(`release ignored for unknown owner refCount=${refCount}${tag}`);
    return;
  }
  if (ownerRefCount === 1) ownerRefs.delete(ownerId);
  else ownerRefs.set(ownerId, ownerRefCount - 1);
  refCount--;
  log.debug(`release refCount=${refCount}${tag}`);
  if (refCount < 0) {
    log.warn(`release refCount went negative (${refCount}), resetting to 0${tag}`);
    refCount = 0;
  }
  emitDiagnostics();
  if (refCount <= 0) {
    closeDelayTimer = setTimeout(() => {
      closeDelayTimer = null;
      if (refCount <= 0 && instance) {
        log.debug("delayed close executing — no re-acquire happened");
        instance.close();
        instance = null;
        emitDiagnostics();
      }
    }, CLOSE_DELAY_MS);
  }
}
