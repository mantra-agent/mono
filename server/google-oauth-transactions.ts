import crypto from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "./db";
import { googleOAuthTransactions, vaults } from "@shared/schema";
import type { Principal } from "./principal";

const TTL_MS = 10 * 60 * 1000;
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function createGoogleOAuthTransaction(principal: Principal, input: { vaultId: string; label?: string; redirectOrigin?: string }): Promise<string> {
  if (!principal.userId || !principal.accountId) throw new Error("Authenticated user principal required");
  const [vault] = await db.select({ id: vaults.id }).from(vaults).where(and(eq(vaults.id, input.vaultId), eq(vaults.accountId, principal.accountId), eq(vaults.isArchived, false))).limit(1);
  if (!vault) throw new Error("Selected Vault is unavailable");
  const token = crypto.randomBytes(32).toString("base64url");
  await db.insert(googleOAuthTransactions).values({ tokenHash: hash(token), ownerUserId: principal.userId, principalAccountId: principal.accountId, vaultId: vault.id, label: input.label || null, redirectOrigin: input.redirectOrigin || null, expiresAt: new Date(Date.now() + TTL_MS) });
  return token;
}

export async function consumeGoogleOAuthTransaction(token: string, principal: Principal) {
  if (!principal.userId || !principal.accountId) throw new Error("Authenticated user principal required");
  return db.transaction(async (tx) => {
    const [row] = await tx.update(googleOAuthTransactions).set({ consumedAt: new Date() }).where(and(eq(googleOAuthTransactions.tokenHash, hash(token)), eq(googleOAuthTransactions.ownerUserId, principal.userId), eq(googleOAuthTransactions.principalAccountId, principal.accountId), eq(googleOAuthTransactions.provider, "google"), isNull(googleOAuthTransactions.consumedAt), gt(googleOAuthTransactions.expiresAt, new Date()))).returning();
    if (!row) throw new Error("OAuth transaction is invalid, expired, consumed, or belongs to another account");
    const [vault] = await tx.select({ id: vaults.id }).from(vaults).where(and(eq(vaults.id, row.vaultId), eq(vaults.accountId, row.principalAccountId), eq(vaults.isArchived, false))).limit(1);
    if (!vault) throw new Error("OAuth transaction Vault is unavailable");
    return row;
  });
}
