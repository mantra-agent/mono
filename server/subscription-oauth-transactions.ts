import crypto from "crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "./db";
import { subscriptionOAuthTransactions } from "@shared/schema";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type SubscriptionOAuthProvider = "openai-subscription" | "grok-subscription";

export interface SubscriptionPkceRecord {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  provider: SubscriptionOAuthProvider;
  connectorId?: number | null;
}

function hashState(state: string): string {
  return crypto.createHash("sha256").update(state).digest("hex");
}

/** Persist a PKCE verifier keyed by opaque OAuth state. Multi-instance safe. */
export async function storeSubscriptionPkce(input: {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  provider: SubscriptionOAuthProvider;
  connectorId?: number | null;
  ttlMs?: number;
}): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS));
  await db
    .insert(subscriptionOAuthTransactions)
    .values({
      stateHash: hashState(input.state),
      provider: input.provider,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
      connectorId: input.connectorId ?? null,
      expiresAt,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: subscriptionOAuthTransactions.stateHash,
      set: {
        provider: input.provider,
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
        connectorId: input.connectorId ?? null,
        expiresAt,
        consumedAt: null,
        createdAt: now,
      },
    });

  // Best-effort cleanup of expired rows; failures must not block OAuth start.
  void db
    .delete(subscriptionOAuthTransactions)
    .where(lt(subscriptionOAuthTransactions.expiresAt, now))
    .catch(() => undefined);
}

/**
 * Atomically consume a PKCE record. Returns null when missing, expired, or
 * already consumed — same contract as the former in-memory Map get+delete.
 */
export async function consumeSubscriptionPkce(
  state: string,
  provider?: SubscriptionOAuthProvider,
): Promise<SubscriptionPkceRecord | null> {
  const stateHash = hashState(state);
  const now = new Date();
  const predicates = [
    eq(subscriptionOAuthTransactions.stateHash, stateHash),
    isNull(subscriptionOAuthTransactions.consumedAt),
    gt(subscriptionOAuthTransactions.expiresAt, now),
  ];
  if (provider) {
    predicates.push(eq(subscriptionOAuthTransactions.provider, provider));
  }

  const rows = await db
    .update(subscriptionOAuthTransactions)
    .set({ consumedAt: now })
    .where(and(...predicates))
    .returning({
      codeVerifier: subscriptionOAuthTransactions.codeVerifier,
      redirectUri: subscriptionOAuthTransactions.redirectUri,
      provider: subscriptionOAuthTransactions.provider,
      connectorId: subscriptionOAuthTransactions.connectorId,
    });

  const row = rows[0];
  if (!row) return null;
  return {
    state,
    codeVerifier: row.codeVerifier,
    redirectUri: row.redirectUri,
    provider: row.provider as SubscriptionOAuthProvider,
    connectorId: row.connectorId ?? null,
  };
}
