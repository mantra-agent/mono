// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";

const log = createLogger("ChatBeacon");

export function chatBeacon(event: string, details: Record<string, unknown> = {}) {
  try {
    const payload = JSON.stringify({ event, ts: Date.now(), ...details });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/chat/diagnostic", new Blob([payload], { type: "application/json" }));
    }
  } catch (err) { log.warn("beacon failed:", err); }
}
