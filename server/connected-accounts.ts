import { db } from "./db";
import { connectedAccounts, vaults, type ConnectedAccount } from "@shared/schema";
import { eq, and, inArray, or, sql } from "drizzle-orm";
import { requireCurrentPrincipal } from "./principal-context";
import { combineWithSensitiveVisible, combineWithSensitiveWritable, sensitiveOwnershipValues } from "./sensitive-scope";
import { createLogger } from "./log";
import { encryptTokens, decryptTokens } from "./encryption";

const log = createLogger("ConnectedAccounts");

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expiry_date?: number;
  scope?: string;
  email?: string;
}

export interface GoogleAccountPermissions {
  gmailRead: boolean;
  gmailSend: boolean;
  gmailDraft: boolean;
  gmailDownloadAttachments: boolean;
  calendarView: boolean;
  calendarCreate: boolean;
  calendarEdit: boolean;
  calendarDelete: boolean;
}

export const DEFAULT_GOOGLE_PERMISSIONS: GoogleAccountPermissions = {
  gmailRead: true,
  gmailSend: true,
  gmailDraft: true,
  gmailDownloadAttachments: true,
  calendarView: true,
  calendarCreate: true,
  calendarEdit: true,
  calendarDelete: true,
};


export async function listVisibleConnectedAccounts(provider?: string): Promise<ConnectedAccount[]> {
  const principal = requireCurrentPrincipal();
  const predicates = [provider ? eq(connectedAccounts.provider, provider) : undefined];
  if (principal.actorType !== "system") {
    if (principal.visibleVaultIds.length === 0) {
      // Still surface owner-scoped connectors with no Vault so auth-dead orphans
      // remain visible and destroyable instead of only thrashing timers.
      predicates.push(sql`${connectedAccounts.vaultId} IS NULL`);
    } else {
      // Bound Vaults plus unassigned owner rows (null vault_id).
      predicates.push(
        or(
          inArray(connectedAccounts.vaultId, principal.visibleVaultIds),
          sql`${connectedAccounts.vaultId} IS NULL`,
        ),
      );
    }
  }
  const domain = predicates.filter(Boolean) as any[];
  const rows = await db.select().from(connectedAccounts).where(combineWithSensitiveVisible({ ownerUserId: connectedAccounts.ownerUserId, principalAccountId: connectedAccounts.principalAccountId }, domain.length ? and(...domain) : undefined, principal));
  return rows.filter((row) => !isSystemSubscriptionAccount(row.accountId));
}

export async function getVisibleConnectedAccount(accountId: string): Promise<ConnectedAccount | null> {
  const accounts = await listVisibleConnectedAccounts();
  return accounts.find(account => account.accountId === accountId) || null;
}

export async function createConnectedAccountInVault(data: Parameters<typeof createAccount>[0], vaultId: string): Promise<ConnectedAccount> {
  const principal = requireCurrentPrincipal();
  if (!principal.accountId) throw new Error("Account principal required");
  const [vault] = await db.select({ id: vaults.id }).from(vaults).where(and(eq(vaults.id, vaultId), eq(vaults.accountId, principal.accountId), eq(vaults.isArchived, false))).limit(1);
  if (!vault) throw new Error("Selected Vault is unavailable");
  const existing = data.email ? (await listAccounts(data.provider)).find(account => account.email?.toLowerCase() === data.email?.toLowerCase()) : null;
  if (existing) {
    if (!existing.vaultId || existing.vaultId !== vaultId) throw new Error("Connected account is already bound to another Vault or requires explicit Vault assignment");
    const updated = await updateAccount(existing.accountId, { tokens: data.tokens, permissions: data.permissions });
    if (!updated) throw new Error("Connected account reconnect failed");
    return updated;
  }
  return createAccount({ ...data, vaultId });
}

/** System-owned subscription connectors — not user-facing connected accounts. */
const SYSTEM_SUBSCRIPTION_ACCOUNT_IDS = new Set([
  "openai-subscription-primary",
  "grok-subscription-primary",
]);

export function isSystemSubscriptionAccount(accountId: string): boolean {
  return SYSTEM_SUBSCRIPTION_ACCOUNT_IDS.has(accountId);
}

export async function listAccounts(provider?: string): Promise<ConnectedAccount[]> {
  const principal = requireCurrentPrincipal();
  const predicate = combineWithSensitiveVisible({ ownerUserId: connectedAccounts.ownerUserId, principalAccountId: connectedAccounts.principalAccountId }, provider ? eq(connectedAccounts.provider, provider) : undefined, principal);
  const rows = await db.select().from(connectedAccounts).where(predicate);
  // Hide system subscription principals from user-facing account lists.
  // Routing still reaches them via getAccount(accountId) under a named system principal.
  return rows.filter((row) => !isSystemSubscriptionAccount(row.accountId));
}

export async function getAccount(accountId: string): Promise<ConnectedAccount | null> {
  const principal = requireCurrentPrincipal();
  // System/boot health probes address accounts by stable accountId across all owners.
  const where =
    principal.actorType === "system"
      ? eq(connectedAccounts.accountId, accountId)
      : combineWithSensitiveVisible(
          {
            ownerUserId: connectedAccounts.ownerUserId,
            principalAccountId: connectedAccounts.principalAccountId,
          },
          eq(connectedAccounts.accountId, accountId),
          principal,
        );
  const rows = await db.select().from(connectedAccounts).where(where).limit(1);
  return rows[0] || null;
}

export async function createAccount(data: {
  accountId: string;
  provider: string;
  email?: string;
  label?: string;
  workspaceName?: string;
  tokens?: unknown;
  permissions?: unknown;
  addedAt?: Date;
  vaultId?: string;
  providerAccountId?: string;
}): Promise<ConnectedAccount> {
  const encryptedTokens = data.tokens ? await encryptTokens(data.tokens) : null;
  const rows = await db
    .insert(connectedAccounts)
    .values({
      accountId: data.accountId,
      ...sensitiveOwnershipValues(requireCurrentPrincipal()),
      provider: data.provider,
      vaultId: data.vaultId || null,
      providerAccountId: data.providerAccountId || null,
      email: data.email || null,
      label: data.label || "Personal",
      workspaceName: data.workspaceName || null,
      tokens: encryptedTokens,
      permissions: data.permissions || null,
      addedAt: data.addedAt || new Date(),
    })
    .onConflictDoUpdate({
      target: connectedAccounts.accountId,
      set: {
        email: data.email || undefined,
        label: data.label || undefined,
        workspaceName: data.workspaceName || undefined,
        tokens: encryptedTokens || undefined,
        permissions: data.permissions || undefined,
        ...sensitiveOwnershipValues(requireCurrentPrincipal()),
        updatedAt: new Date(),
      },
    })
    .returning();
  log.log(`createAccount accountId=${data.accountId} provider=${data.provider}`);
  return rows[0];
}

export async function updateAccount(
  accountId: string,
  fields: Partial<{
    email: string;
    label: string;
    workspaceName: string;
    tokens: unknown;
    permissions: unknown;
    healthy: boolean;
    healthError: string | null;
    healthCheckedAt: Date;
    missingScopes: string[] | null;
    vaultId: string;
  }>
): Promise<ConnectedAccount | null> {
  const updateFields = { ...fields, updatedAt: new Date() };
  if (updateFields.tokens !== undefined) {
    updateFields.tokens = updateFields.tokens ? await encryptTokens(updateFields.tokens) : updateFields.tokens;
  }
  const principal = requireCurrentPrincipal();
  // System/boot health probes must mutate by accountId without user-scope false negatives.
  const where =
    principal.actorType === "system"
      ? eq(connectedAccounts.accountId, accountId)
      : combineWithSensitiveWritable(
          {
            ownerUserId: connectedAccounts.ownerUserId,
            principalAccountId: connectedAccounts.principalAccountId,
          },
          eq(connectedAccounts.accountId, accountId),
          principal,
        );
  const rows = await db
    .update(connectedAccounts)
    .set(updateFields)
    .where(where)
    .returning();
  if (rows.length === 0) return null;
  log.debug(`updateAccount accountId=${accountId} fields=${Object.keys(fields).join(",")}`);
  return rows[0];
}

export async function assignConnectedAccountVault(accountId: string, vaultId: string): Promise<ConnectedAccount> {
  const principal = requireCurrentPrincipal();
  if (!principal.accountId) throw new Error("Account principal required");
  const [vault] = await db.select({ id: vaults.id }).from(vaults).where(and(eq(vaults.id, vaultId), eq(vaults.accountId, principal.accountId), eq(vaults.isArchived, false))).limit(1);
  if (!vault) throw new Error("Selected Vault is unavailable");
  const account = await getAccount(accountId);
  if (!account || account.provider !== "google") throw new Error("Google account not found");
  if (account.vaultId === vaultId) return account;
  if (account.vaultId) throw new Error("Vault moves are blocked until resumable derived-data migration ships");
  const updated = await updateAccount(accountId, { vaultId });
  if (!updated) throw new Error("Google account Vault assignment failed");
  return updated;
}

export async function deleteAccount(accountId: string): Promise<boolean> {
  const result = await db.delete(connectedAccounts).where(combineWithSensitiveWritable({ ownerUserId: connectedAccounts.ownerUserId, principalAccountId: connectedAccounts.principalAccountId }, eq(connectedAccounts.accountId, accountId)));
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) log.log(`deleteAccount accountId=${accountId}`);
  return deleted;
}

export async function getAccountTokens(accountId: string): Promise<GoogleTokens | null> {
  const account = await getAccount(accountId);
  if (!account || !account.tokens) return null;
  const { wasRotated, data } = await decryptTokens(account.tokens);
  if (!data) return null;
  if (wasRotated) {
    reEncryptTokens(accountId, data).catch((err: unknown) => {
      log.warn(`background re-encryption failed for accountId=${accountId}`, err instanceof Error ? err.message : err);
    });
  }
  return data as GoogleTokens;
}

async function reEncryptTokens(accountId: string, plainTokens: unknown): Promise<void> {
  try {
    const encrypted = await encryptTokens(plainTokens);
    await db
      .update(connectedAccounts)
      .set({ tokens: encrypted, updatedAt: new Date() })
      .where(combineWithSensitiveWritable({ ownerUserId: connectedAccounts.ownerUserId, principalAccountId: connectedAccounts.principalAccountId }, eq(connectedAccounts.accountId, accountId)));
    log.log(`re-encrypted tokens for accountId=${accountId} (key rotation)`);
  } catch (err: unknown) {
    log.warn(`re-encryption failed for accountId=${accountId}`, err instanceof Error ? err.message : err);
  }
}

export async function setAccountTokens(accountId: string, tokens: GoogleTokens): Promise<void> {
  await updateAccount(accountId, { tokens });
}

export function resolvePermissions(stored: unknown): GoogleAccountPermissions {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_GOOGLE_PERMISSIONS };
  const raw = stored as Record<string, unknown>;
  return {
    gmailRead: typeof raw.gmailRead === "boolean" ? raw.gmailRead : DEFAULT_GOOGLE_PERMISSIONS.gmailRead,
    gmailSend: typeof raw.gmailSend === "boolean" ? raw.gmailSend : DEFAULT_GOOGLE_PERMISSIONS.gmailSend,
    gmailDraft: typeof raw.gmailDraft === "boolean" ? raw.gmailDraft : DEFAULT_GOOGLE_PERMISSIONS.gmailDraft,
    gmailDownloadAttachments: typeof raw.gmailDownloadAttachments === "boolean" ? raw.gmailDownloadAttachments : DEFAULT_GOOGLE_PERMISSIONS.gmailDownloadAttachments,
    calendarView: typeof raw.calendarView === "boolean" ? raw.calendarView : DEFAULT_GOOGLE_PERMISSIONS.calendarView,
    calendarCreate: typeof raw.calendarCreate === "boolean" ? raw.calendarCreate : DEFAULT_GOOGLE_PERMISSIONS.calendarCreate,
    calendarEdit: typeof raw.calendarEdit === "boolean" ? raw.calendarEdit : DEFAULT_GOOGLE_PERMISSIONS.calendarEdit,
    calendarDelete: typeof raw.calendarDelete === "boolean" ? raw.calendarDelete : DEFAULT_GOOGLE_PERMISSIONS.calendarDelete,
  };
}

export async function getAccountPermissions(accountId: string): Promise<GoogleAccountPermissions> {
  const account = await getAccount(accountId);
  return resolvePermissions(account?.permissions);
}

export async function setAccountPermissions(accountId: string, perms: Partial<GoogleAccountPermissions>): Promise<GoogleAccountPermissions> {
  const current = await getAccountPermissions(accountId);
  const merged = { ...current, ...perms };
  await updateAccount(accountId, { permissions: merged });
  log.log(`setAccountPermissions accountId=${accountId} changed=${Object.keys(perms).join(",")}`);
  return merged;
}

export async function checkAccountPermission(accountId: string, key: keyof GoogleAccountPermissions): Promise<boolean> {
  const perms = await getAccountPermissions(accountId);
  return perms[key];
}

export async function checkPermissionAnyAccount(key: keyof GoogleAccountPermissions): Promise<{ allowed: boolean; allowedAccounts: ConnectedAccount[]; deniedAccounts: ConnectedAccount[] }> {
  const accounts = await listAccounts("google");
  const allowed: ConnectedAccount[] = [];
  const denied: ConnectedAccount[] = [];
  for (const account of accounts) {
    const perms = resolvePermissions(account.permissions);
    if (perms[key]) {
      allowed.push(account);
    } else {
      denied.push(account);
    }
  }
  return { allowed: allowed.length > 0, allowedAccounts: allowed, deniedAccounts: denied };
}
