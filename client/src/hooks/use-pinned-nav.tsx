import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "xyz_pinned_nav_items";
const EVENT_NAME = "xyz-pinned-nav-change";

const DEFAULT_PINNED = ["Sessions"];

function read(): string[] {
  if (typeof window === "undefined") return DEFAULT_PINNED;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_PINNED;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_PINNED;
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return DEFAULT_PINNED;
  }
}

let cached: string[] = read();
let cachedKey = cached.join("|");

function getSnapshot(): string[] {
  return cached;
}

function refresh() {
  const next = read();
  const key = next.join("|");
  if (key !== cachedKey) {
    cached = next;
    cachedKey = key;
  }
}

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => {
    refresh();
    cb();
  };
  window.addEventListener(EVENT_NAME, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(EVENT_NAME, handler);
    window.removeEventListener("storage", handler);
  };
}

function write(next: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  cached = next;
  cachedKey = next.join("|");
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function usePinnedNav(): {
  pinned: Set<string>;
  isPinned: (title: string) => boolean;
  pin: (title: string) => void;
  unpin: (title: string) => void;
  toggle: (title: string) => void;
} {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const pinned = new Set(list);
  const isPinned = useCallback((title: string) => pinned.has(title), [list]);
  const pin = useCallback((title: string) => {
    if (cached.includes(title)) return;
    write([...cached, title]);
  }, []);
  const unpin = useCallback((title: string) => {
    if (!cached.includes(title)) return;
    write(cached.filter(t => t !== title));
  }, []);
  const toggle = useCallback((title: string) => {
    if (cached.includes(title)) write(cached.filter(t => t !== title));
    else write([...cached, title]);
  }, []);
  return { pinned, isPinned, pin, unpin, toggle };
}
