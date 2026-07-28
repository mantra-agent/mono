const CLIENT_TAB_ID_STORAGE_KEY = "agent.clientPresenceTabId";

let fallbackClientTabId: string | null = null;

function createClientTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `client-${crypto.randomUUID()}`;
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getClientTabId(): string {
  if (typeof window === "undefined") {
    fallbackClientTabId ??= createClientTabId();
    return fallbackClientTabId;
  }

  try {
    const existing = window.sessionStorage.getItem(CLIENT_TAB_ID_STORAGE_KEY);
    if (existing) return existing;
    const next = createClientTabId();
    window.sessionStorage.setItem(CLIENT_TAB_ID_STORAGE_KEY, next);
    return next;
  } catch {
    fallbackClientTabId ??= createClientTabId();
    return fallbackClientTabId;
  }
}
