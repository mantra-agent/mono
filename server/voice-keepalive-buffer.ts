// Pure helper for the presence-hold cascade-safe window
// (first Mantra hold after EL soft-timeout, before cascade).
//
// See server/voice/turn-io.ts (sendPresenceHold / startKeepaliveTimer) and
// server/elevenlabs.ts (soft_timeout_config) for the division of labor:
// Spoken fillers are off. This window is now comment-only liveness before cascade retry.
// When soft-timeout is disabled (0), the hold lands in the cascade-safety window only.

export const KEEPALIVE_SAFETY_MARGIN_MS = 3_000;

export function computeSoftTimeoutBufferMs(
  softTimeoutSeconds: number,
  cascadeTimeoutSeconds: number,
  safetyMarginMs: number = KEEPALIVE_SAFETY_MARGIN_MS,
  warn?: (msg: string) => void,
): number {
  const softMs = softTimeoutSeconds * 1000;
  const cascadeMs = cascadeTimeoutSeconds * 1000;
  const lower = softMs + safetyMarginMs;
  const upper = cascadeMs - safetyMarginMs;
  if (lower >= upper) {
    if (warn) {
      warn(`KEEPALIVE_BUFFER_NO_ROOM softTimeoutMs=${softMs} cascadeMs=${cascadeMs} safetyMarginMs=${safetyMarginMs} — no room for comment-only liveness before cascade. Increase cascade_timeout_seconds.`);
    }
    return Math.min(Math.max(lower, softMs + 1), Math.max(softMs + 1, cascadeMs - 1));
  }
  return Math.round((lower + upper) / 2);
}
