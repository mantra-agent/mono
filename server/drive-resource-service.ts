import { and, eq, or } from "drizzle-orm";
import { db } from "./db";
import { driveResources, type DriveResourceRow } from "@shared/schema";
import { vaults } from "@shared/models/vaults";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";
import { liveVaultGatePredicate, type ObjectRole } from "./authorize";

const log = createLogger("DriveResourceService");

export interface BindDriveResourceInput {
  vaultId: string;
  connectedAccountId: string;
  googleFileId: string;
  name: string;
  mimeType?: string | null;
  resourceType?: "file" | "folder";
  iconUrl?: string | null;
  webViewLink?: string | null;
}

/**
 * Binds Google Drive files/folders into a vault's Files branch. Every read and write is bounded to
 * the caller's authorized vault access; a binding is a pointer to a Google file (via drive.file),
 * never a copy. Unbinding deletes only the pointer row — it never touches the underlying Google file.
 */
export class DriveResourceService {
  /** Vault owner account OR live vault grant at the required role. */
  private async assertVaultAccess(vaultId: string, required: ObjectRole): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    const [vault] = await db
      .select({ id: vaults.id })
      .from(vaults)
      .where(
        and(
          eq(vaults.id, vaultId),
          or(
            eq(vaults.accountId, principal.accountId),
            liveVaultGatePredicate(principal, vaults.id, required),
          ),
        ),
      )
      .limit(1);
    if (!vault) throw Object.assign(new Error("Vault not found"), { status: 404 });
  }

  /** Mutations that create/destroy binds stay owner-account only (not vault grantees). */
  private async assertOwnedVault(vaultId: string): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    const [vault] = await db
      .select({ id: vaults.id })
      .from(vaults)
      .where(and(eq(vaults.id, vaultId), eq(vaults.accountId, principal.accountId)))
      .limit(1);
    if (!vault) throw Object.assign(new Error("Vault not found"), { status: 404 });
  }

  /**
   * Vault-scoped read: any principal who can see the vault sees every bind in it.
   * Do not filter binds by principal.accountId — that hid shared-vault grantees
   * (Step 11 under-permissive gap).
   */
  async list(vaultId: string): Promise<DriveResourceRow[]> {
    await this.assertVaultAccess(vaultId, "read");
    return db
      .select()
      .from(driveResources)
      .where(eq(driveResources.vaultId, vaultId))
      .orderBy(driveResources.name);
  }

  async bind(input: BindDriveResourceInput): Promise<DriveResourceRow> {
    const principal = requireCurrentUserPrincipal();
    await this.assertOwnedVault(input.vaultId);
    const googleFileId = input.googleFileId.trim();
    const name = input.name.trim();
    if (!googleFileId) throw Object.assign(new Error("googleFileId is required"), { status: 400 });
    if (!name) throw Object.assign(new Error("name is required"), { status: 400 });
    // Idempotent: re-binding the same file into the same vault refreshes its metadata rather than
    // erroring, so a re-pick is safe to replay.
    const [resource] = await db
      .insert(driveResources)
      .values({
        accountId: principal.accountId,
        vaultId: input.vaultId,
        connectedAccountId: input.connectedAccountId,
        googleFileId,
        name,
        mimeType: input.mimeType ?? null,
        resourceType: input.resourceType ?? "file",
        iconUrl: input.iconUrl ?? null,
        webViewLink: input.webViewLink ?? null,
        addedByUserId: principal.userId,
      })
      .onConflictDoUpdate({
        target: [driveResources.vaultId, driveResources.googleFileId],
        set: {
          name,
          mimeType: input.mimeType ?? null,
          iconUrl: input.iconUrl ?? null,
          webViewLink: input.webViewLink ?? null,
        },
      })
      .returning();
    log.info("drive resource bound", { id: resource.id, vaultId: input.vaultId, googleFileId });
    return resource;
  }

  /** Remove the binding. Deletes only the pointer row — never touches the underlying Google file. */
  async unbind(id: string): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    const rows = await db
      .delete(driveResources)
      .where(and(eq(driveResources.id, id), eq(driveResources.accountId, principal.accountId)))
      .returning({ id: driveResources.id });
    if (rows.length === 0) throw Object.assign(new Error("Drive resource not found"), { status: 404 });
    log.info("drive resource unbound (Google file untouched)", { id });
  }
}

export const driveResourceService = new DriveResourceService();
