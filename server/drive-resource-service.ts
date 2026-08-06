import { and, eq, or } from "drizzle-orm";
import { db } from "./db";
import { driveResources, type DriveResourceRow } from "@shared/schema";
import { vaults } from "@shared/models/vaults";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";
import { liveVaultGatePredicate, type ObjectRole } from "./authorize";
import type { FilesProvider } from "./files-api";

const log = createLogger("DriveResourceService");

const PROVIDERS: ReadonlySet<string> = new Set(["google", "box", "mantra"]);

export interface BindDriveResourceInput {
  vaultId: string;
  connectedAccountId: string;
  /** Provider identity — defaults to google for the existing Picker path. */
  provider?: FilesProvider;
  providerFileId: string;
  name: string;
  mimeType?: string | null;
  resourceType?: "file" | "folder";
  iconUrl?: string | null;
  webViewLink?: string | null;
}

/**
 * Binds provider files/folders into a vault's Files branch. Every read and write is bounded to
 * the caller's authorized vault access; a binding is a pointer (via drive.file today), never a copy.
 * Unbinding deletes only the pointer row — it never touches the underlying provider file.
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
  async list(vaultId: string, connectedAccountId?: string): Promise<DriveResourceRow[]> {
    await this.assertVaultAccess(vaultId, "read");
    return db
      .select()
      .from(driveResources)
      .where(
        connectedAccountId
          ? and(eq(driveResources.vaultId, vaultId), eq(driveResources.connectedAccountId, connectedAccountId))
          : eq(driveResources.vaultId, vaultId),
      )
      .orderBy(driveResources.name);
  }

  async bind(input: BindDriveResourceInput): Promise<DriveResourceRow> {
    const principal = requireCurrentUserPrincipal();
    await this.assertOwnedVault(input.vaultId);
    const provider = (input.provider ?? "google") as FilesProvider;
    if (!PROVIDERS.has(provider)) {
      throw Object.assign(new Error("provider must be google, box, or mantra"), { status: 400 });
    }
    const providerFileId = input.providerFileId.trim();
    const name = input.name.trim();
    if (!providerFileId) throw Object.assign(new Error("providerFileId is required"), { status: 400 });
    if (!name) throw Object.assign(new Error("name is required"), { status: 400 });
    // Idempotent: re-binding the same provider file into the same vault refreshes its metadata
    // rather than erroring, so a re-pick is safe to replay.
    const [resource] = await db
      .insert(driveResources)
      .values({
        accountId: principal.accountId,
        vaultId: input.vaultId,
        connectedAccountId: input.connectedAccountId,
        provider,
        providerFileId,
        name,
        mimeType: input.mimeType ?? null,
        resourceType: input.resourceType ?? "file",
        iconUrl: input.iconUrl ?? null,
        webViewLink: input.webViewLink ?? null,
        addedByUserId: principal.userId,
      })
      .onConflictDoUpdate({
        target: [driveResources.vaultId, driveResources.provider, driveResources.providerFileId],
        set: {
          connectedAccountId: input.connectedAccountId,
          name,
          mimeType: input.mimeType ?? null,
          iconUrl: input.iconUrl ?? null,
          webViewLink: input.webViewLink ?? null,
        },
      })
      .returning();
    log.info("drive resource bound", {
      id: resource.id,
      vaultId: input.vaultId,
      provider,
      providerFileId,
    });
    return resource;
  }

  /** Remove the binding. Deletes only the pointer row — never touches the underlying provider file. */
  async unbind(id: string): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    const rows = await db
      .delete(driveResources)
      .where(and(eq(driveResources.id, id), eq(driveResources.accountId, principal.accountId)))
      .returning({ id: driveResources.id });
    if (rows.length === 0) throw Object.assign(new Error("Drive resource not found"), { status: 404 });
    log.info("drive resource unbound (provider file untouched)", { id });
  }
}

export const driveResourceService = new DriveResourceService();
