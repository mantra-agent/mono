import { createHash } from "crypto";
import { createLogger } from "../log";

const log = createLogger("VoiceUtils");

// ── Text utilities ────────────────────────────────────────────────

export function toWordsVoice(s: string): string[] {
  return s.toLowerCase().replace(/[^\w\s']/g, "").split(/\s+/).filter(Boolean);
}

export function isWordLevelPrefixContinuation(prev: string, current: string): boolean {
  if (!prev || !current || current.length <= prev.length) return false;
  const prevWords = toWordsVoice(prev);
  const curWords = toWordsVoice(current);
  if (prevWords.length === 0 || curWords.length <= prevWords.length) return false;
  let matchCount = 0;
  for (let i = 0; i < prevWords.length; i++) {
    if (prevWords[i] === curWords[i]) {
      matchCount++;
    } else if (curWords[i].startsWith(prevWords[i]) || prevWords[i].startsWith(curWords[i])) {
      matchCount++;
    }
  }
  return matchCount / prevWords.length >= 0.8;
}

export function contentHash(content: string): string {
  return createHash("md5").update(content.trim()).digest("hex").slice(0, 12);
}

export function hasContentIssues(s: string): string | null {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0) return `null_byte at index ${i}`;
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xDC00 || next > 0xDFFF) return `lone_high_surrogate 0x${code.toString(16)} at index ${i}`;
      i++;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return `lone_low_surrogate 0x${code.toString(16)} at index ${i}`;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) {
      return `control_char 0x${code.toString(16)} at index ${i}`;
    }
  }
  return null;
}

// ── URL resolution ────────────────────────────────────────────────

function warnIfNonPublicUrl(url: string, source: string): void {
  if (url.includes("localhost") || url.includes("127.0.0.1")) {
    log.warn(`getPublicBaseUrl: ${source} resolved to "${url}" which may not be reachable by external services`);
  }
}

export function getPublicBaseUrl(): string {
  try {
    const { getVoiceWebhookBaseUrlOverrideSync } = require("../voice-webhook-base-url");
    const override = getVoiceWebhookBaseUrlOverrideSync();
    if (override) {
      log.log(`getPublicBaseUrl using settings override: ${override}`);
      return override;
    }
  } catch {
    // Module not yet loaded — fall through to env-based resolution.
  }
  if (process.env.VOICE_LLM_BASE_URL) {
    warnIfNonPublicUrl(process.env.VOICE_LLM_BASE_URL, "VOICE_LLM_BASE_URL");
    return process.env.VOICE_LLM_BASE_URL.replace(/\/+$/, "");
  }
  try {
    const { getRuntimePublicBaseUrlSync } = require("../runtime-identity");
    const runtimeUrl = getRuntimePublicBaseUrlSync();
    if (runtimeUrl) {
      warnIfNonPublicUrl(runtimeUrl, "runtime-identity");
      log.log(`getPublicBaseUrl resolved from runtime identity: ${runtimeUrl}`);
      return runtimeUrl;
    }
  } catch {
    // Module not yet loaded — fall through to localhost fallback.
  }
  const localhostUrl = `http://localhost:${process.env.PORT || 5000}`;
  log.warn(`getPublicBaseUrl falling back to localhost (${localhostUrl}) — no deployment env vars found`);
  return localhostUrl;
}
