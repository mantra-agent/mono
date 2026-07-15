import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import type { ClientPresenceEntry, ClientPresenceKind } from "@shared/client-presence";
import { isClientPresenceKind } from "@shared/client-presence";

type PresenceMessage = {
  type?: string;
  clients?: ClientPresenceEntry[];
};

const HEARTBEAT_INTERVAL_MS = 15_000;
const CLIENT_ID_STORAGE_KEY = "agent.clientPresenceTabId";

function isPresenceEntry(value: unknown): value is ClientPresenceEntry {
  const entry = value as Partial<ClientPresenceEntry> | null;
  return Boolean(
    entry &&
    typeof entry.id === "string" &&
    isClientPresenceKind(entry.kind) &&
    typeof entry.connectedAt === "string" &&
    typeof entry.lastSeenAt === "string",
  );
}

function stableClientId(): string {
  if (typeof window === "undefined") return `client-${Math.random().toString(36).slice(2)}`;
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing) return existing;
    const next = `client-${crypto.randomUUID()}`;
    window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return `client-${Math.random().toString(36).slice(2)}`;
  }
}

function mergeClients(...groups: ClientPresenceEntry[][]): ClientPresenceEntry[] {
  const byId = new Map<string, ClientPresenceEntry>();
  for (const group of groups) {
    for (const client of group) byId.set(client.id, client);
  }
  return Array.from(byId.values());
}

function detectClientKind(): ClientPresenceKind {
  if (typeof window !== "undefined") {
    const nativeWindow = window as Window & {
      ReactNativeWebView?: { postMessage?: unknown };
      __AGENT_NATIVE_APP__?: { platform?: unknown };
    };

    if (nativeWindow.__AGENT_NATIVE_APP__?.platform === "ios") return "ios";
    if (typeof nativeWindow.ReactNativeWebView?.postMessage === "function") return "ios";
    if (window.navigator.userAgent.includes("AgentMobileIOS")) return "ios";
  }
  return "web";
}

function useClientPresenceState() {
  const [wsClients, setWsClients] = useState<ClientPresenceEntry[]>([]);
  const [httpClients, setHttpClients] = useState<ClientPresenceEntry[]>([]);
  const hookId = useId();
  const clientKind = useMemo(detectClientKind, []);
  const clientId = useMemo(stableClientId, []);
  const clients = useMemo(() => mergeClients(wsClients, httpClients), [wsClients, httpClients]);

  useEffect(() => {
    const ws = acquireSharedWS("useClientPresence");
    const handlerId = `client-presence-${hookId}`;

    const register = () => {
      const subscribed = ws.send({ type: "client_presence.subscribe" });
      const registered = ws.send({ type: "client_presence.register", clientId, kind: clientKind });
      if (!subscribed || !registered) ws.connect();
    };

    ws.addMessageHandler(handlerId, (raw) => {
      const msg = raw as PresenceMessage;
      if (msg?.type !== "client_presence.snapshot") return;
      setWsClients(Array.isArray(msg.clients) ? msg.clients.filter(isPresenceEntry) : []);
    });

    ws.addOpenHandler(handlerId, register);
    ws.addReconnectHandler(handlerId, register);
    ws.addCloseHandler(handlerId, () => setWsClients([]));

    if (ws.getReadyState() === WebSocket.OPEN) {
      register();
    } else {
      ws.connect();
    }

    return () => {
      ws.removeMessageHandler(handlerId);
      ws.removeOpenHandler(handlerId);
      ws.removeReconnectHandler(handlerId);
      ws.removeCloseHandler(handlerId);
      releaseSharedWS("useClientPresence");
    };
  }, [clientId, clientKind, hookId]);

  useEffect(() => {
    let cancelled = false;

    const heartbeat = async () => {
      try {
        const response = await fetch("/api/client-presence/heartbeat", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, kind: clientKind }),
        });
        if (!response.ok) return;
        const payload = await response.json() as { clients?: unknown };
        if (!cancelled) {
          setHttpClients(Array.isArray(payload.clients) ? payload.clients.filter(isPresenceEntry) : []);
        }
      } catch {
        // WebSocket remains the primary live path. HTTP heartbeat is a resilience fallback.
      }
    };

    void heartbeat();
    const timer = window.setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [clientId, clientKind]);

  return { clients, clientKind };
}


type ClientPresenceValue = ReturnType<typeof useClientPresenceState>;

const ClientPresenceContext = createContext<ClientPresenceValue | null>(null);

export function ClientPresenceProvider({ children }: { children: ReactNode }) {
  const value = useClientPresenceState();
  return <ClientPresenceContext.Provider value={value}>{children}</ClientPresenceContext.Provider>;
}

export function useClientPresence(): ClientPresenceValue {
  const value = useContext(ClientPresenceContext);
  if (!value) throw new Error("useClientPresence must be used within ClientPresenceProvider");
  return value;
}
