// Pure helper for the presence-hold cascade-safe window
// (first Mantra hold after EL soft-timeout, before cascade).
//
// See server/voice/turn-io.ts (sendPresenceHold / startKeepaliveTimer) and
// server/elevenlabs.ts (soft_timeout_config) for the division of labor:
//   - EL native soft_timeout_config = first spoken bridge ("One second.")
//   - Mantra presence hold          = flushed complete hold sentences on this window
// The hold must land strictly after soft_timeout_config.timeout_seconds and
// before cascade_timeout_seconds so it cannot suppress EL's first line.

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
      warn(`KEEPALIVE_BUFFER_NO_ROOM softTimeoutMs=${softMs} cascadeMs=${cascadeMs} safetyMarginMs=${safetyMarginMs} — soft+margin (${lower}ms) is not strictly less than cascade-margin (${upper}ms). Keepalive will either suppress EL's "One second." filler or fail to reset cascade in time. Increase cascade_timeout_seconds or reduce soft_timeout_config.timeout_seconds in server/elevenlabs.ts.`);
    }
    return Math.min(Math.max(lower, softMs + 1), Math.max(softMs + 1, cascadeMs - 1));
  }
  return Math.round((lower + upper) / 2);
}
