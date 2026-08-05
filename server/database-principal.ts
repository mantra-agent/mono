import { AsyncLocalStorage } from "async_hooks";
import { sql } from "drizzle-orm";
import type { Principal } from "./principal";
import { db, type DrizzleTx } from "./db";

export interface DatabasePrincipalContext {
  userId: string | null;
  accountId: string | null;
  vaultIds: readonly string[];
  servicePrincipal: string | null;
  requestId: string;
}

const databasePrincipalStorage = new AsyncLocalStorage<DatabasePrincipalContext>();

function normalizePrincipal(principal: Principal, requestId: string): DatabasePrincipalContext {
  if (!requestId.trim()) throw new Error("Database principal requires a requestId");
  if (!principal.accountId) throw new Error("Database principal requires an accountId");
  if (principal.kind === "user" && !principal.userId) {
    throw new Error("User database principal requires a userId");
  }
  if (principal.kind === "service" && !principal.servicePrincipal) {
    throw new Error("Service database principal requires a servicePrincipal");
  }
  return {
    userId: principal.userId,
    accountId: principal.accountId,
    vaultIds: [...principal.vaultIds],
    servicePrincipal: principal.servicePrincipal,
    requestId,
  };
}

export function requireDatabasePrincipal(): DatabasePrincipalContext {
  const context = databasePrincipalStorage.getStore();
  if (!context) throw new Error("Database principal context is required");
  return context;
}

export function requireDatabaseAccountId(): string {
  const accountId = requireDatabasePrincipal().accountId;
  if (!accountId) throw new Error("Database account context is required");
  return accountId;
}

export function requireDatabaseUserId(): string {
  const userId = requireDatabasePrincipal().userId;
  if (!userId) throw new Error("Database user context is required");
  return userId;
}

export function requireDatabaseVaultId(vaultId: string): string {
  if (!vaultId || !requireDatabasePrincipal().vaultIds.includes(vaultId)) {
    throw new Error("Database Vault context is missing or unauthorized");
  }
  return vaultId;
}

/**
 * Binds identity to one transaction using PostgreSQL transaction-local settings.
 * No policy reads these settings until the separately gated RLS activation migration.
 */
export async function withDatabasePrincipal<T>(
  principal: Principal,
  requestId: string,
  operation: (tx: DrizzleTx) => Promise<T>,
): Promise<T> {
  const context = normalizePrincipal(principal, requestId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.user_id', ${context.userId ?? ""}, true),
      set_config('app.account_id', ${context.accountId ?? ""}, true),
      set_config('app.vault_ids', ${JSON.stringify(context.vaultIds)}, true),
      set_config('app.service_principal', ${context.servicePrincipal ?? ""}, true),
      set_config('app.request_id', ${context.requestId}, true)`);
    return databasePrincipalStorage.run(context, () => operation(tx));
  });
}
