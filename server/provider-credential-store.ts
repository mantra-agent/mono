/**
 * Provider Credential Store
 *
 * Stores and retrieves encrypted credentials directly on provider_connections rows.
 * Uses the same encryption primitives as github-credentials.ts.
 * Does NOT use app_secrets (which prunes rows not in SECRET_CATALOG on boot).
 */
import { eq } from "drizzle-orm";
import { db } from "./db";
import { providerConnections } from "@shared/models/platforms";
import { encrypt, decrypt, getEncryptionKey, getPreviousEncryptionKey, type EncryptedEnvelope, isEncryptedEnvelope } from "./encryption";
import { createLogger } from "./log";

const log = createLogger("ProviderCredentialStore");

function computeLast4(value: string): string {
  return value.length >= 4 ? value.slice(-4) : "****";
}

export function credentialRefId(connectionId: number): string {
  return `provider_connection:${connectionId}`;
}

export async function storeProviderCredential(connectionId: number, value: string, updatedBy: string | null): Promise<string> {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Credential value cannot be empty");

  const envelope = await encrypt(trimmed, getEncryptionKey());
  const last4 = computeLast4(trimmed);
  const ref = credentialRefId(connectionId);
  const now = new Date();

  await db
    .update(providerConnections)
    .set({
      credentialEnvelope: envelope,
      credentialLast4: last4,
      credentialRef: ref,
      updatedAt: now,
    })
    .where(eq(providerConnections.id, connectionId));

  log.info(`Stored credential for connection ${connectionId}`);
  return ref;
}

export async function getProviderCredential(refOrId: string | number): Promise<string | null> {
  // Accept either a ref string ("provider_connection:5") or a connection ID (5)
  let connectionId: number;
  if (typeof refOrId === "number") {
    connectionId = refOrId;
  } else if (typeof refOrId === "string" && refOrId.startsWith("provider_connection:")) {
    connectionId = parseInt(refOrId.split(":")[1], 10);
    if (!Number.isFinite(connectionId)) {
      log.debug(`Invalid credential ref format: ${refOrId}`);
      return null;
    }
  } else {
    log.debug(`Unknown credential ref format: ${refOrId}`);
    return null;
  }

  const [row] = await db
    .select({ credentialEnvelope: providerConnections.credentialEnvelope })
    .from(providerConnections)
    .where(eq(providerConnections.id, connectionId))
    .limit(1);

  if (!row?.credentialEnvelope) {
    log.debug(`No credential envelope found for connection ${connectionId}`);
    return null;
  }

  const envelope = row.credentialEnvelope;
  if (!isEncryptedEnvelope(envelope)) {
    log.warn(`Credential envelope for connection ${connectionId} is not a valid encrypted envelope`);
    return null;
  }

  // Try current key first
  try {
    return await decrypt(envelope, getEncryptionKey());
  } catch {
    // Try previous key for rotation support
    const prevKey = getPreviousEncryptionKey();
    if (prevKey) {
      try {
        const value = await decrypt(envelope, prevKey);
        // Re-encrypt with current key for next time
        log.info(`Re-encrypting credential for connection ${connectionId} with current key`);
        const newEnvelope = await encrypt(value, getEncryptionKey());
        await db
          .update(providerConnections)
          .set({ credentialEnvelope: newEnvelope, updatedAt: new Date() })
          .where(eq(providerConnections.id, connectionId));
        return value;
      } catch {
        log.error(`Failed to decrypt credential for connection ${connectionId} with both current and previous keys`);
      }
    } else {
      log.error(`Failed to decrypt credential for connection ${connectionId} — no previous key available for fallback`);
    }
    return null;
  }
}

export async function deleteProviderCredential(refOrId: string | number): Promise<boolean> {
  let connectionId: number;
  if (typeof refOrId === "number") {
    connectionId = refOrId;
  } else if (typeof refOrId === "string" && refOrId.startsWith("provider_connection:")) {
    connectionId = parseInt(refOrId.split(":")[1], 10);
    if (!Number.isFinite(connectionId)) return false;
  } else {
    return false;
  }

  const result = await db
    .update(providerConnections)
    .set({ credentialEnvelope: null, credentialLast4: "", credentialRef: null, updatedAt: new Date() })
    .where(eq(providerConnections.id, connectionId));

  log.info(`Cleared credential for connection ${connectionId}`);
  return true;
}
