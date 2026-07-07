/**
 * V2.5 Keepalive — re-exports the shared cascade keepalive logic that v2
 * already calibrates correctly (see voice-keepalive-buffer.ts). v2.5 uses
 * the same agent timing config, so its first-fire threshold is identical.
 */
export { computeSoftTimeoutBufferMs } from "../voice-keepalive-buffer";
