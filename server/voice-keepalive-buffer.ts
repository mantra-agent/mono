// Pure helper for computing the cascade-keepalive's first-fire threshold
// (extracted from voice-llm.ts so it can be unit-tested without dragging in
// the full voice-llm module graph and its top-level intervals).
//
// See server/voice-llm.ts (sendCascadeKeepalive / startKeepaliveTimer) and
// server/elevenlabs.ts (soft_timeout_config) for the division of labor:
//   - EL native soft_timeout_config = UX FILLER ("One second.")
//   - Custom keepalive               = CASCADE LIVENESS only
// The keepalive sends a delta.content chunk which would suppress EL's
// soft-timeout filler if it fires inside the soft window, so the threshold
// must land strictly between soft_timeout_config.timeout_seconds and
// cascade_timeout_seconds.

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
