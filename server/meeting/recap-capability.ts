import { createHash, randomBytes } from "node:crypto";

const RECIPIENT_ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const APP_BASE_URL = "https://app.trymantra.ai";

export interface RecipientEntryCapability {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function hashRecapCapabilityToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createRecipientEntryCapability(): RecipientEntryCapability {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashRecapCapabilityToken(token),
    expiresAt: new Date(Date.now() + RECIPIENT_ACCESS_TTL_MS),
  };
}

export function onboardingEntryUrl(token: string): string {
  return `${APP_BASE_URL}/r/${encodeURIComponent(token)}`;
}

export function recapCapabilityHashesFromBody(body: string): string[] {
  const hashes = new Set<string>();
  const pattern = /\/r\/([A-Za-z0-9_-]{20,200})/g;
  for (const match of body.matchAll(pattern)) {
    try {
      hashes.add(hashRecapCapabilityToken(decodeURIComponent(match[1])));
    } catch {
      continue;
    }
  }
  return [...hashes];
}
