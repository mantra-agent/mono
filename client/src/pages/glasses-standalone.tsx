/**
 * /glasses — Meta Ray-Ban Display renderer
 *
 * Auto-pairing flow:
 * 1. Check localStorage for a device token
 * 2. If no token → connect SSE without auth → server auto-pairs and pushes token
 * 3. Store token in localStorage
 * 4. Connect authenticated SSE for surface updates
 */

import { useState, useEffect, useRef } from "react";
import { AppToastDisplay } from "@/components/toast-display";
import { toast } from "@/hooks/use-toast";
import { SurfaceRenderer } from "./zero/surface-renderer";
import type { SurfaceDescriptor } from "@shared/models/glasses";
import "./zero/glasses.css";

const TOKEN_KEY = "glasses_device_token";
const DISPLAY_NAME_KEY = "glasses_display_name";
const SSE_RECONNECT_BASE = 2000;
const SSE_RECONNECT_MAX = 30000;

type ConnectionState = "connecting" | "pairing" | "paired" | "error";

interface GlassesConnectionPayload {
  token?: string;
  displayName?: string;
}

interface GlassesToastPayload {
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
}

export default function GlassesStandalone() {
  const [descriptor, setDescriptor] = useState<SurfaceDescriptor | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(() =>
    localStorage.getItem(DISPLAY_NAME_KEY),
  );
  const tokenRef = useRef<string | null>(localStorage.getItem(TOKEN_KEY));
  const surfaceRef = useRef<HTMLDivElement>(null);
  const showSurface = new URLSearchParams(window.location.search).get("surface") === "full";

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = SSE_RECONNECT_BASE;
    let cancelled = false;

    function scheduleReconnect() {
      if (cancelled || reconnectTimer) return;
      setState("connecting");
      es?.close();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        backoff = Math.min(backoff * 2, SSE_RECONNECT_MAX);
        connect();
      }, backoff);
    }

    function rememberDisplayName(nextDisplayName?: string) {
      if (!nextDisplayName) return;
      localStorage.setItem(DISPLAY_NAME_KEY, nextDisplayName);
      setDisplayName(nextDisplayName);
    }

    function connect() {
      if (cancelled) return;

      const token = tokenRef.current;
      const params = new URLSearchParams();
      params.set("surface", showSurface ? "full" : "none");
      if (token) params.set("dt", token);
      const url = `/api/glasses/events?${params.toString()}`;

      setState(token ? "connecting" : "pairing");
      es = new EventSource(url);

      es.addEventListener("paired", (e) => {
        try {
          const data = JSON.parse(e.data) as GlassesConnectionPayload;
          if (data.token) {
            localStorage.setItem(TOKEN_KEY, data.token);
            tokenRef.current = data.token;
            rememberDisplayName(data.displayName);
            setState("paired");
          }
        } catch {
          // ignore
        }
      });

      es.addEventListener("connected", (e) => {
        try {
          const data = JSON.parse(e.data) as GlassesConnectionPayload;
          rememberDisplayName(data.displayName);
        } catch {
          // ignore
        }
        setState("paired");
        backoff = SSE_RECONNECT_BASE;
      });

      es.addEventListener("surface-update", (e) => {
        try {
          const data = JSON.parse(e.data) as SurfaceDescriptor;
          setDescriptor(data);
        } catch {
          // ignore
        }
      });

      es.addEventListener("glasses-toast", (e) => {
        try {
          const data = JSON.parse(e.data) as GlassesToastPayload;
          if (!data.title) return;
          toast({
            title: data.title,
            description: data.description,
            variant: data.variant === "destructive" ? "destructive" : undefined,
            relayToGlasses: false,
          });
        } catch {
          // ignore
        }
      });

      es.addEventListener("error", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          if (data.error) {
            setError(data.error);
            setState("error");
            return;
          }
        } catch {
          // Not a data error
        }

        scheduleReconnect();
      });
    }

    connect();

    return () => {
      cancelled = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [showSurface]);

  const statusLabel = state === "paired"
    ? `Connected${displayName ? ` · ${displayName}` : ""}`
    : state === "pairing"
      ? "Pairing"
      : state === "connecting"
        ? "Connecting"
        : error || "Connection error";

  const isConnected = state === "paired";
  const isConnecting = state === "connecting" || state === "pairing";
  const statusColor = isConnected ? "hsl(var(--success))" : state === "error" ? "hsl(var(--error))" : "hsl(var(--warning))";
  const statusShadow = isConnected ? "hsl(var(--success) / 0.72)" : state === "error" ? "hsl(var(--error) / 0.72)" : "hsl(var(--warning) / 0.72)";

  return (
    <div
      ref={surfaceRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: "100vw",
        height: "100vh",
        margin: 0,
        padding: 0,
        background: "#000",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div
        aria-label={statusLabel}
        title={statusLabel}
        style={{
          position: "fixed",
          top: "14px",
          right: "14px",
          zIndex: 20,
          width: "28px",
          height: "28px",
          borderRadius: "999px",
          background: "rgba(0, 0, 0, 0.42)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          animation: isConnected ? "glasses-status-connected-fade 3s ease-out forwards" : undefined,
        }}
      >
        <span style={{
          width: isConnecting ? "14px" : "12px",
          height: isConnecting ? "14px" : "12px",
          borderRadius: "50%",
          background: statusColor,
          boxShadow: `0 0 10px ${statusShadow}`,
          opacity: isConnecting ? 0.86 : 1,
          animation: isConnecting ? "glasses-status-pulse 1.2s ease-in-out infinite" : undefined,
          flex: "0 0 auto",
        }} />
      </div>

      {state === "error" && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#ff4444",
          fontFamily: "system-ui",
          fontSize: "64px",
          fontWeight: 600,
          padding: "40px",
          textAlign: "center",
        }}>
          {error || "Connection error"}
        </div>
      )}


      {showSurface && descriptor && descriptor.components.length > 0 && (
        <SurfaceRenderer descriptor={descriptor} />
      )}

      <style>{`
        @keyframes glasses-status-pulse {
          0%, 100% { transform: scale(0.82); opacity: 0.62; }
          50% { transform: scale(1); opacity: 1; }
        }
        @keyframes glasses-status-connected-fade {
          0%, 72% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>

      <AppToastDisplay
        className="fixed inset-x-0 bottom-6 z-30"
        toastClassName="min-h-[4.6875rem] max-w-[min(59.375rem,calc(100vw-2rem))] gap-[1.171875rem] rounded-[1.171875rem] px-[1.953125rem] py-[1.171875rem] shadow-[0_25px_75px_rgba(0,0,0,0.55),0_0_0_1px_rgba(255,255,255,0.08)] [&>button]:p-2 [&>button>svg]:h-6 [&>button>svg]:w-6 [&>span]:text-xl [&>svg]:h-[1.953125rem] [&>svg]:w-[1.953125rem]"
      />
    </div>
  );
}
