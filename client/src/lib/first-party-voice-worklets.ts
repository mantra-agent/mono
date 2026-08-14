/**
 * Force ElevenLabs AudioWorklet loads onto first-party `/voice/*` files.
 *
 * Upstream `@elevenlabs/client` accepts `libsampleratePath` on startSession and
 * forwards it to the INPUT AudioContext, but `VoiceSessionSetup.setupWebSocketIO`
 * still omits it from `MediaDeviceOutput.create` (verified through 1.17.0). On
 * iOS Safari (no sampleRate constraint) the OUTPUT context always loads
 * libsamplerate and falls back to a hardcoded jsDelivr URL. WebKit evaluates
 * AudioWorklet modules under script-src as well as worker/child-src, so a
 * worker-src CDN exception never fixed the failure.
 *
 * Intercepting `AudioWorklet.addModule` at the prototype is the structural
 * ownership boundary: every context — input, output, future SDK paths — can
 * only load our vendored module. Install once at boot, before any voice start.
 */

export const FIRST_PARTY_LIBSAMPLERATE_PATH = "/voice/libsamplerate.worklet.js";

/** Exact URL the SDK hardcodes when libsampleratePath is omitted. */
const ELEVENLABS_CDN_LIBSAMPLERATE =
  "https://cdn.jsdelivr.net/npm/@alexanderolsen/libsamplerate-js@2.1.2/dist/libsamplerate.worklet.js";

let installed = false;

function isRemoteLibsamplerateModule(moduleUrl: string): boolean {
  if (!moduleUrl) return false;
  if (moduleUrl === ELEVENLABS_CDN_LIBSAMPLERATE) return true;
  // Future SDK pin bumps should still be forced first-party rather than
  // reopening a CSP hole for a new immutable file URL.
  try {
    const parsed = new URL(moduleUrl, typeof window !== "undefined" ? window.location.origin : "https://localhost");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.hostname !== "cdn.jsdelivr.net") return false;
    return (
      parsed.pathname.includes("/@alexanderolsen/libsamplerate-js@") &&
      parsed.pathname.endsWith("/libsamplerate.worklet.js")
    );
  } catch {
    return /cdn\.jsdelivr\.net\/npm\/@alexanderolsen\/libsamplerate-js@[^/]+\/dist\/libsamplerate\.worklet\.js/.test(
      moduleUrl,
    );
  }
}

/**
 * Rewrite any ElevenLabs CDN libsamplerate addModule call to the first-party
 * worklet. Idempotent; safe when AudioWorklet is absent.
 */
export function installFirstPartyVoiceWorklets(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const workletCtor = typeof AudioWorklet !== "undefined" ? AudioWorklet : null;
  if (!workletCtor?.prototype?.addModule) return;

  const originalAddModule = workletCtor.prototype.addModule;

  workletCtor.prototype.addModule = function firstPartyVoiceAddModule(
    this: AudioWorklet,
    moduleURL: string | URL,
    options?: WorkletOptions,
  ): Promise<void> {
    const raw = typeof moduleURL === "string" ? moduleURL : String(moduleURL);
    const resolved = isRemoteLibsamplerateModule(raw) ? FIRST_PARTY_LIBSAMPLERATE_PATH : moduleURL;
    return originalAddModule.call(this, resolved, options);
  };
}
