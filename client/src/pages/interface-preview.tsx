import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { XyzIconButton } from "@/components/app-sidebar";
import { SurfaceRenderer } from "./zero/surface-renderer";
import type { SurfaceDescriptor } from "@shared/models/glasses";
import "./zero/glasses.css";
import { useInterfaceMode } from "@/hooks/use-interface-mode";
import {
  isInterfaceMode,
  type InterfaceMode,
} from "@shared/models/interface-mode";

function modeFromSearch(search: string): InterfaceMode | null {
  const params = new URLSearchParams(search);
  const mode = params.get("mode");
  return isInterfaceMode(mode) ? mode : null;
}

function pathFromSearch(search: string, mode: InterfaceMode): string {
  const params = new URLSearchParams(search);
  const rawPath = params.get("path");
  const fallback = "/home";
  if (!rawPath || !rawPath.startsWith("/") || rawPath.startsWith("/interface-preview")) {
    return fallback;
  }
  return rawPath;
}

export default function InterfacePreviewPage() {
  const [location, setLocation] = useLocation();
  const [mode, setMode] = useInterfaceMode();
  const queryMode = useMemo(() => modeFromSearch(window.location.search), [location]);
  const activeMode = queryMode ?? mode;
  const previewPath = useMemo(() => pathFromSearch(window.location.search, activeMode), [activeMode, location]);

  useEffect(() => {
    if (queryMode && queryMode !== mode) setMode(queryMode);
    if (activeMode === "web_detail") setLocation(previewPath);
  }, [activeMode, mode, previewPath, queryMode, setLocation, setMode]);

  return (
    <div className="flex h-full min-w-0 items-start justify-center overflow-y-auto bg-background p-4 @sm:p-6">
      <PreviewCanvas mode={activeMode} path={previewPath} />
    </div>
  );
}

function PreviewCanvas({ mode, path }: { mode: InterfaceMode; path: string }) {
  if (mode === "glasses_simple") return <GlassesFrame />;
  return null;
}

function GlassesFrame() {
  const [descriptor, setDescriptor] = useState<SurfaceDescriptor | null>(null);

  useEffect(() => {
    fetch("/api/glasses/surface", { credentials: "include" })
      .then((response) => response.json())
      .then(setDescriptor)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const events = new EventSource("/api/glasses/events");

    events.addEventListener("surface-update", (event) => {
      try {
        setDescriptor(JSON.parse(event.data) as SurfaceDescriptor);
      } catch {
        // Keep the last known surface if an event is malformed.
      }
    });

    return () => events.close();
  }, []);

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[520px] overflow-hidden rounded-[2rem] border border-border bg-black shadow-[0_0_40px_rgba(255,255,255,0.03)]">
      <div className="absolute left-3 top-3 z-20">
        <XyzIconButton />
      </div>
      <SurfaceRenderer descriptor={descriptor} />
    </div>
  );
}
