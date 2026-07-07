import { useCallback, useSyncExternalStore } from "react";
import {
  getDefaultInterfaceMode,
  interfaceModes,
  isInterfaceMode,
  type InterfaceMode,
  type RuntimeSurface,
} from "@shared/models/interface-mode";

const STORAGE_KEY = "xyz_interface_mode";
const EVENT_NAME = "xyz-interface-mode-change";
const WEB_RUNTIME: RuntimeSurface = "desktop_web";

function read(): InterfaceMode {
  if (typeof window === "undefined") return getDefaultInterfaceMode(WEB_RUNTIME);
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isInterfaceMode(stored) ? stored : getDefaultInterfaceMode(WEB_RUNTIME);
  } catch {
    return getDefaultInterfaceMode(WEB_RUNTIME);
  }
}

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb();
  window.addEventListener(EVENT_NAME, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(EVENT_NAME, handler);
    window.removeEventListener("storage", handler);
  };
}

export function useInterfaceMode(): [InterfaceMode, (next: InterfaceMode) => void] {
  const value = useSyncExternalStore(subscribe, read, () => getDefaultInterfaceMode(WEB_RUNTIME));
  const set = useCallback((next: InterfaceMode) => {
    if (!interfaceModes.includes(next)) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    window.dispatchEvent(new Event(EVENT_NAME));
  }, []);
  return [value, set];
}

export function useCurrentInterfaceMode(): InterfaceMode {
  return useSyncExternalStore(subscribe, read, () => getDefaultInterfaceMode(WEB_RUNTIME));
}
