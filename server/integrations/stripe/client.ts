import { createHmac, timingSafeEqual } from "node:crypto";
import { getSecret } from "../../secrets-store";
import { providerFetch, readBoundedProviderBody } from "../provider-http";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_TIMEOUT_MS = 20_000;

export class StripeCollectorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "StripeCollectorError";
  }
}

export async function requireStripeSecretKey(): Promise<string> {
  const key = (await getSecret("STRIPE_SECRET_KEY"))?.trim();
  if (!key) throw new StripeCollectorError("Stripe secret key is not set", "billing_secrets_missing", 503);
  if (!key.startsWith("sk_test_") && !key.startsWith("sk_live_")) {
    throw new StripeCollectorError("Stripe secret key prefix is invalid", "billing_secrets_invalid", 503);
  }
  return key;
}

export async function requireStripeWebhookSecret(): Promise<string> {
  const secret = (await getSecret("STRIPE_WEBHOOK_SECRET"))?.trim();
  if (!secret || !secret.startsWith("whsec_")) {
    throw new StripeCollectorError("Stripe webhook secret is not set", "billing_webhook_secret_missing", 503);
  }
  return secret;
}

function encodeForm(body: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export async function stripeRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, string | number | undefined>,
  idempotencyKey?: string,
): Promise<T> {
  const key = await requireStripeSecretKey();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const response = await providerFetch(`${STRIPE_API}${path}`, {
    method,
    headers,
    body: body ? encodeForm(body) : undefined,
    timeoutMs: STRIPE_TIMEOUT_MS,
  });
  const text = await readBoundedProviderBody(response, 16_384);
  if (!response.ok) {
    throw new StripeCollectorError(
      `Stripe ${method} ${path} failed`,
      "billing_stripe_request_failed",
      response.status >= 500 ? 502 : 400,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new StripeCollectorError("Stripe returned unreadable JSON", "billing_stripe_parse_failed", 502);
  }
}

export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const timestamp = header.split(",").find((piece) => piece.trim().startsWith("t="))?.trim().slice(2);
  const signatures = header.split(",").filter((piece) => piece.trim().startsWith("v1=")).map((piece) => piece.trim().slice(3));
  if (!timestamp || signatures.length === 0) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(Number(timestamp)) || ageSeconds > 300) return false;
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  const expected = createHmac("sha256", key).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return signatures.some((signature) => {
    const given = Buffer.from(signature, "utf8");
    return given.length === expectedBuf.length && timingSafeEqual(given, expectedBuf);
  });
}

export interface StripeCustomer { id: string; email?: string | null }
export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  customer: string | null;
  subscription: string | null;
  metadata?: Record<string, string>;
}
export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  cancel_at: number | null;
}
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}
