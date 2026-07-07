import { useState, useEffect, useRef, useCallback } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { SurfaceRenderer } from "./zero/surface-renderer";
import { DevPanel } from "./zero/dev-panel";
import { useFocusManager } from "./zero/use-focus-manager";
import type { SurfaceDescriptor } from "@shared/models/glasses";
import { Wrench } from "lucide-react";
import "./zero/glasses.css";

export default function ZeroPage() {
  usePageHeader({ title: "Zero" });

  const [descriptor, setDescriptor] = useState<SurfaceDescriptor | null>(null);
  const [debugDescriptor, setDebugDescriptor] = useState<SurfaceDescriptor | null>(null);
  const [showDev, setShowDev] = useState(false);
  const [connected, setConnected] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);

  useFocusManager(surfaceRef);

  // Fetch initial surface
  useEffect(() => {
    fetch("/api/glasses/surface", { credentials: "include" })
      .then((r) => r.json())
      .then(setDescriptor)
      .catch(() => {});
  }, []);

  // SSE connection for real-time updates
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let backoff = 1000;

    function connect() {
      es = new EventSource("/api/glasses/events");

      es.addEventListener("connected", () => {
        setConnected(true);
        backoff = 1000;
      });

      es.addEventListener("surface-update", (e) => {
        try {
          const data = JSON.parse(e.data) as SurfaceDescriptor;
          setDescriptor(data);
        } catch {
          // ignore parse errors
        }
      });

      es.onerror = () => {
        setConnected(false);
        es?.close();
        reconnectTimer = setTimeout(() => {
          backoff = Math.min(backoff * 2, 30000);
          connect();
        }, backoff);
      };
    }

    connect();

    return () => {
      es?.close();
      clearTimeout(reconnectTimer);
    };
  }, []);

  // Fetch debug descriptor when dev panel opens
  useEffect(() => {
    if (!showDev) return;
    fetch("/api/glasses/surface?debug=true", { credentials: "include" })
      .then((r) => r.json())
      .then(setDebugDescriptor)
      .catch(() => {});
  }, [showDev]);

  const handleToggleDev = useCallback(() => {
    setShowDev((prev) => !prev);
  }, []);

  // Close dev panel on Escape
  useEffect(() => {
    if (!showDev) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowDev(false);
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [showDev]);

  return (
    <div className="glasses-page">
      <div className="glasses-viewport">
        <div className="glasses-chrome" ref={surfaceRef}>
          <SurfaceRenderer descriptor={descriptor} />
        </div>
        <div
          className={`glasses-connection-dot ${connected ? "connected" : "disconnected"}`}
          title={connected ? "Connected" : "Disconnected"}
        />
      </div>

      <button
        className="glasses-dev-toggle"
        onClick={handleToggleDev}
        title="Toggle dev inspector"
        type="button"
      >
        <Wrench size={16} />
      </button>

      {showDev && (
        <DevPanel
          descriptor={descriptor}
          debugDescriptor={debugDescriptor}
          onClose={() => setShowDev(false)}
        />
      )}
    </div>
  );
}
