// Use createLogger for logging ONLY
import { chatBeacon } from "@/lib/chat-beacon";
import { createLogger } from "@/lib/logger";

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
  setStreamActive(active: boolean): void;
}

let instance: SharedWebSocket | null = null;
let refCount = 0;
let hasEverConnected = false;
let lastOpenWasReconnect = false;
let closeDelayTimer: ReturnType<typeof setTimeout> | null = null;

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
  let streamActive = false;
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
      lastMessageTime = Date.now();
      log.debug(`open wasReconnect=${wasReconnect} refCount=${refCount}`);
      hasEverConnected = true;
      startLivenessTimer();
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
        streamActive,
      });
      ws = null;
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
    chatBeacon("ws_force_reconnect", { elapsedSinceLastMsg: elapsed, streamActive });
    ws.close(4000, "liveness-timeout");
  }

  function startLivenessTimer() {
    if (livenessTimer) return;
    livenessTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && streamActive) {
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
    },
    removeMessageHandler(id) {
      messageHandlers.delete(id);
    },
    addReconnectHandler(id, handler) {
      reconnectHandlers.set(id, handler);
    },
    removeReconnectHandler(id) {
      reconnectHandlers.delete(id);
    },
    addOpenHandler(id, handler) {
      openHandlers.set(id, handler);
    },
    removeOpenHandler(id) {
      openHandlers.delete(id);
    },
    addCloseHandler(id, handler) {
      closeHandlers.set(id, handler);
    },
    removeCloseHandler(id) {
      closeHandlers.delete(id);
    },
    addErrorHandler(id, handler) {
      errorHandlers.set(id, handler);
    },
    removeErrorHandler(id) {
      errorHandlers.delete(id);
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
    setStreamActive(active: boolean) {
      streamActive = active;
    },
  };
}

export function acquireSharedWS(caller?: string): SharedWebSocket {
  const tag = caller ? ` caller=${caller}` : "";
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
  return instance;
}

export function releaseSharedWS(caller?: string) {
  refCount--;
  const tag = caller ? ` caller=${caller}` : "";
  log.debug(`release refCount=${refCount}${tag}`);
  if (refCount < 0) {
    log.warn(`release refCount went negative (${refCount}), resetting to 0${tag}`);
    refCount = 0;
  }
  if (refCount <= 0) {
    closeDelayTimer = setTimeout(() => {
      closeDelayTimer = null;
      if (refCount <= 0 && instance) {
        log.debug("delayed close executing — no re-acquire happened");
        instance.close();
        instance = null;
      }
    }, CLOSE_DELAY_MS);
  }
}
