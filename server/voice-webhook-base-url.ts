/**
 * Voice Webhook Base URL Override
 *
 * Lets the user pin the public base URL used for ElevenLabs callbacks
 * (custom-LLM URL for v2/v2.5, tool webhooks for v3). Useful for testing
 * voice in development against a known-reachable URL — or for forcing
 * production URLs during dev iteration.
 *
 * When set, the dev-mode "skip PATCH" guard in setupAgentCallbackUrl
 * (v2/v2.5) and provisionV3Agent (v3) is bypassed: the override signals
 * the user has explicitly chosen this URL and we trust it.
 *
 * Sync getter is required because getPublicBaseUrl() is called from
 * synchronous code paths. The override is loaded from DB at boot and
 * refreshed on every PUT.
 *
 * NOTE (single-process assumption): `cachedOverride` is process-local.
 * In a multi-replica deployment the cache may diverge between replicas
 * until the next `loadVoiceWebhookBaseUrlOverride()` runs. Callers that
 * must see the freshest value (e.g. provisionV3Agent before issuing the
 * PATCH) should call `revalidateVoiceWebhookBaseUrl()` first.
 */
import { createLogger } from "./log";
import { getSetting, setSetting } from "./system-settings";

const log = createLogger("voice-webhook-base-url");

export const VOICE_WEBHOOK_BASE_URL_KEY = "voice_webhook_base_url_override";

let cachedOverride: string | null = null;
let loaded = false;

function normalize(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  // Build the final URL without a trailing slash to match the previous
  // behaviour callers depend on (they concatenate `${base}/api/...`).
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  return base.replace(/\/+$/, "");
}

export async function loadVoiceWebhookBaseUrlOverride(): Promise<string | null> {
  try {
    const stored = await getSetting<{ url?: string } | string | null>(
      VOICE_WEBHOOK_BASE_URL_KEY,
    );
    const raw = typeof stored === "string" ? stored : stored?.url;
    cachedOverride = normalize(raw);
    loaded = true;
    if (cachedOverride) log.debug(`override loaded from DB: ${cachedOverride}`);
    else log.debug("no override configured (DB)");
    return cachedOverride;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`failed to load override (treating as none): ${msg}`);
    cachedOverride = null;
    loaded = true;
    return null;
  }
}

export function getVoiceWebhookBaseUrlOverrideSync(): string | null {
  return cachedOverride;
}

export function hasVoiceWebhookBaseUrlOverride(): boolean {
  return cachedOverride !== null;
}

export function isVoiceWebhookBaseUrlOverrideLoaded(): boolean {
  return loaded;
}

/**
 * Re-read the override from the DB. Called from hot paths that must not
 * make a decision based on a stale process-local cache.
 */
export async function revalidateVoiceWebhookBaseUrl(): Promise<string | null> {
  return loadVoiceWebhookBaseUrlOverride();
}

export async function setVoiceWebhookBaseUrlOverride(
  url: string | null,
): Promise<string | null> {
  const value = url === null ? null : normalize(url);
  if (url !== null && url.trim().length > 0 && value === null) {
    throw new Error("Invalid URL — must be an absolute http(s):// URL");
  }
  await setSetting(VOICE_WEBHOOK_BASE_URL_KEY, { url: value });
  cachedOverride = value;
  loaded = true;
  log.debug(`override updated: ${value ?? "(cleared)"}`);
  return value;
}
