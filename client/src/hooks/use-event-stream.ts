import { useState, useEffect, useRef, useCallback } from "react";

export interface BusEvent {
  id: string;
  timestamp: number;
  category: "agent" | "system" | "session" | "channel" | "chat" | "gateway" | "tool" | "responsibility" | "memory";
  event: string;
  payload: any;
  runId?: string;
  sessionKey?: string;
  bootId?: string;
}

export function useEventStream(maxEvents = 500) {
  const [events, setEvents] = useState<BusEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/events`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "event" && msg.event) {
          setEvents((prev) => {
            const next = [...prev, msg.event];
            return next.length > maxEvents ? next.slice(-maxEvents) : next;
          });
        } else if (msg.type === "history" && Array.isArray(msg.events)) {
          setEvents((prev) => {
            const merged = [...prev, ...msg.events];
            const unique = Array.from(new Map(merged.map(e => [e.id, e])).values());
            return unique.slice(-maxEvents);
          });
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectTimerRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [maxEvents]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, connected, clearEvents };
}
