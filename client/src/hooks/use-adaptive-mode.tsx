import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "xyz_adaptive_nav_mode";
const EVENT_NAME = "xyz-adaptive-nav-mode-change";

function read(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
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

export function useAdaptiveMode(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {}
    window.dispatchEvent(new Event(EVENT_NAME));
  }, []);
  return [value, set];
}

export function useIsAdaptiveMode(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
