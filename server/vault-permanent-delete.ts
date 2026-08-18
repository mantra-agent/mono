import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  businessPlans,
  emailMessages,
  objectAcls,
  personVaultMemberships,
  platforms,
  products,
  projectVaultMemberships,
  users,
  vaults,
} from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import { ADVISORY_LOCK_NS, acquireAdvisoryTransactionLock, db } from "./db";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { ensureUserIdentityFoundation } from "./principal";
import { runWithPrincipal } from "./principal-context";
import { hardDeleteLibraryPages, softDeleteLibrarySubtree } from "./library-domain";
import { chatFileStorage } from "./chat-file-storage";
import { deleteMeetingSession } from "./meeting/delete";
import { fileProjectStorage } from "./file-storage/projects";
import { fileTaskStorage } from "./file-storage/tasks";
import { peopleStorage } from "./people-storage";
import { goalStorage } from "./goal-storage";
import { businessPlanStorage } from "./business-plan-storage";
import { productStorage } from "./product-storage";
import { deleteHistoricalContinuityForVault } from "./historical-continuity";
import { deleteObjectAclPolicy } from "./object_storage/objectAcl";
import { storageBackend } from "./object_storage/s3-backend";
import { plaidTransactions } from "@shared/models/finance";

const log = createLogger("VaultPermanentDelete");

export const VAULT_PERMANENT_DELETE_CONFIRMATION = "DELETE";

export class VaultPermanentDeleteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "VaultPermanentDeleteError";
    this.status = status;
    this.code = code;
  }
}

export interface PermanentlyDeleteVaultInput {
  vaultId: string;
  confirmation: string;
  idempotencyKey: string;
}

export interface PermanentlyDeleteVaultResult {
  erased: true;
  vaultId: string;
  reminted: boolean;
  replayed: boolean;
}

interface VaultEraseReceipt {
  id: string;
  reminted: boolean;
}

const OBJECT_DELETE_BATCH = 25;

function requireHolderPrincipal(principal: Principal | null): Principal & {
  actorType: "user";
  userId: string;
  accountId: string;
  source: "session";
} {
  if (
    !principal
    || principal.actorType !== "user"
    || !principal.userId
    || !principal.accountId
    || principal.source !== "session"
    || principal.impersonation
  ) {
    throw new VaultPermanentDeleteError(
      403,
      "holder_required",
      "Only the signed-in account holder can permanently delete a vault",
    );
  }
  return principal as Principal & {
    actorType: "user";
    userId: string;
    accountId: string;
    source: "session";
  };
}

async function loadReceipt(
  accountId: string,
  vaultId: string,
  idempotencyKey: string,
): Promise<VaultEraseReceipt | null> {
  const result = await db.execute(sql`
    SELECT id, reminted
    FROM vault_erase_receipts
    WHERE account_id = ${accountId}
      AND vault_id = ${vaultId}
      AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);
  const row = result.rows[0] as { id?: string; reminted?: boolean } | undefined;
  if (!row?.id) return null;
  return { id: row.id, reminted: Boolean(row.reminted) };
}

async function insertReceipt(
  accountId: string,
  vaultId: string,
  idempotencyKey: string,
  reminted: boolean,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO vault_erase_receipts (id, account_id, vault_id, idempotency_key, reminted)
    VALUES (${randomUUID()}, ${accountId}, ${vaultId}, ${idempotencyKey}, ${reminted})
    ON CONFLICT (account_id, vault_id, idempotency_key) DO NOTHING
  `);
}

async function destroyLibraryPages(principal: Principal, vaultId: string): Promise<void> {
  const pages = await db
    .select({ id: libraryPages.id, parentId: libraryPages.parentId })
    .from(libraryPages)
    .where(and(
      eq(libraryPages.vaultId, vaultId),
      eq(libraryPages.accountId, principal.accountId!),
      eq(libraryPages.ownerUserId, principal.userId!),
    ));
  const pageIds = pages.map((page) => page.id);
  const childIds = new Set(pages.map((page) => page.parentId).filter(Boolean));
  const roots = pages.filter((page) => !page.parentId || !pageIds.includes(page.parentId));
  for (const root of roots) {
    await softDeleteLibrarySubtree(principal, root.id);
  }
  for (const page of pages) {
    if (childIds.has(page.id)) continue;
    await softDeleteLibrarySubtree(principal, page.id);
  }
  if (pageIds.length > 0) {
    await hardDeleteLibraryPages(principal, pageIds);
  }
}

async function destroySessions(principal: Principal, vaultId: string): Promise<void> {
  const sessions = await chatFileStorage.getAllSessions();
  const vaultSessions = sessions.filter((session) => session.vaultId === vaultId);
  for (const session of vaultSessions) {
    if (session.meeting) {
      await deleteMeetingSession(session.id, principal);
      continue;
    }
    await chatFileStorage.deleteSession(session.id);
  }
}

async function destroyWork(vaultId: string): Promise<void> {
  const tasks = await fileTaskStorage.getTasks({});
  for (const task of tasks.filter((task) => task.vaultId === vaultId)) {
    await fileTaskStorage.deleteTask(task.id);
  }

  const projects = await fileProjectStorage.getProjects();
  for (const project of projects) {
    const memberships = project.vaultIds ?? [];
    const inVault = memberships.includes(vaultId) || project.vaultId === vaultId;
    if (!inVault) continue;
    const remaining = memberships.filter((id) => id !== vaultId);
    if (remaining.length === 0) {
      await fileProjectStorage.deleteProject(project.id);
    } else {
      await db.delete(projectVaultMemberships).where(and(
        eq(projectVaultMemberships.projectId, project.id),
        eq(projectVaultMemberships.vaultId, vaultId),
      ));
    }
  }
}

async function destroyPeople(vaultId: string): Promise<void> {
  const memberships = await db
    .select({ personId: personVaultMemberships.personId })
    .from(personVaultMemberships)
    .where(eq(personVaultMemberships.vaultId, vaultId));
  for (const membership of memberships) {
    const remaining = await db
      .select({ vaultId: personVaultMemberships.vaultId })
      .from(personVaultMemberships)
      .where(eq(personVaultMemberships.personId, membership.personId));
    if (remaining.length <= 1) {
      await peopleStorage.deletePerson(membership.personId);
    } else {
      await db.delete(personVaultMemberships).where(and(
        eq(personVaultMemberships.personId, membership.personId),
        eq(personVaultMemberships.vaultId, vaultId),
      ));
    }
  }
}

async function destroyGoals(vaultId: string): Promise<void> {
  const goals = await goalStorage.listGoalsInVault(vaultId);
  for (const goal of goals) {
    await goalStorage.deleteGoal(goal.id);
  }
}

async function destroyPlansPlatformsProducts(principal: Principal, vaultId: string): Promise<void> {
  const plans = await db
    .select({ id: businessPlans.id })
    .from(businessPlans)
    .where(and(
      eq(businessPlans.vaultId, vaultId),
      eq(businessPlans.accountId, principal.accountId!),
    ));
  for (const plan of plans) {
    await businessPlanStorage.remove(plan.id);
  }

  const platformRows = await db
    .select({ id: platforms.id })
    .from(platforms)
    .where(and(
      eq(platforms.vaultId, vaultId),
      eq(platforms.accountId, principal.accountId!),
      eq(platforms.ownerUserId, principal.userId!),
    ));
  for (const platform of platformRows) {
    await db.delete(platforms).where(eq(platforms.id, platform.id));
  }

  const productRows = await db
    .select({ id: products.id })
    .from(products)
    .where(and(
      eq(products.vaultId, vaultId),
      eq(products.accountId, principal.accountId!),
    ));
  for (const product of productRows) {
    try {
      await productStorage.remove(product.id);
    } catch {
      await db.update(products).set({ vaultId: null, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(products.id, product.id));
    }
  }
}

async function destroyCachesAndObjects(principal: Principal, vaultId: string): Promise<void> {
  await deleteHistoricalContinuityForVault(vaultId);
  await db.delete(emailMessages).where(and(
    eq(emailMessages.vaultId, vaultId),
    eq(emailMessages.principalAccountId, principal.accountId!),
    eq(emailMessages.ownerUserId, principal.userId!),
  ));
  await db.delete(plaidTransactions).where(and(
    eq(plaidTransactions.vaultId, vaultId),
    eq(plaidTransactions.principalAccountId, principal.accountId!),
    eq(plaidTransactions.ownerUserId, principal.userId!),
  ));

  const prefix = `vaults/${vaultId}/`;
  const objects = await storageBackend.listObjects(prefix);
  for (let i = 0; i < objects.length; i += OBJECT_DELETE_BATCH) {
    const batch = objects.slice(i, i + OBJECT_DELETE_BATCH);
    await Promise.all(batch.map(async (object) => {
      await deleteObjectAclPolicy(object.key);
      await storageBackend.deleteObject(object.key);
    }));
  }
  await db.delete(objectAcls).where(eq(objectAcls.vaultId, vaultId));
}

/**
 * Permanently erase one holder-owned vault. Separate verb from archive and
 * from admin identity close. Replay of the same idempotency key returns the
 * first receipt without running the cascade again.
 */
export async function permanentlyDeleteVault(
  principal: Principal | null,
  input: PermanentlyDeleteVaultInput,
): Promise<PermanentlyDeleteVaultResult> {
  const holder = requireHolderPrincipal(principal);
  const vaultId = input.vaultId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!vaultId) {
    throw new VaultPermanentDeleteError(400, "vault_required", "Vault is required");
  }
  if (!idempotencyKey) {
    throw new VaultPermanentDeleteError(400, "idempotency_required", "Idempotency key is required");
  }
  if (input.confirmation !== VAULT_PERMANENT_DELETE_CONFIRMATION) {
    throw new VaultPermanentDeleteError(400, "confirmation_required", "Type DELETE to permanently erase this vault");
  }

  const existing = await loadReceipt(holder.accountId, vaultId, idempotencyKey);
  if (existing) {
    log.info("vault erase replayed", { vaultId, reminted: existing.reminted });
    return { erased: true, vaultId, reminted: existing.reminted, replayed: true };
  }

  const erasePrincipal = {
    ...holder,
    visibleVaultIds: Array.from(new Set([...(holder.visibleVaultIds ?? []), vaultId])),
    activeVaultId: holder.activeVaultId ?? vaultId,
  };

  return runWithPrincipal(erasePrincipal, async () => {
    const [vault] = await db
      .select()
      .from(vaults)
      .where(and(eq(vaults.id, vaultId), eq(vaults.accountId, holder.accountId)))
      .limit(1);
    if (!vault) {
      throw new VaultPermanentDeleteError(404, "vault_not_found", "Vault not found");
    }
    if (vault.accountId !== holder.accountId) {
      throw new VaultPermanentDeleteError(403, "vault_forbidden", "Vault is not writable");
    }

    await destroyLibraryPages(erasePrincipal, vaultId);
    await destroySessions(erasePrincipal, vaultId);
    await destroyWork(vaultId);
    await destroyPeople(vaultId);
    await destroyGoals(vaultId);
    await destroyPlansPlatformsProducts(erasePrincipal, vaultId);
    await destroyCachesAndObjects(erasePrincipal, vaultId);

    await db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, `vault:${vaultId}`);
      await tx.delete(vaults).where(and(eq(vaults.id, vaultId), eq(vaults.accountId, holder.accountId)));
    });

    const remaining = await db
      .select({ id: vaults.id })
      .from(vaults)
      .where(eq(vaults.accountId, holder.accountId));
    let reminted = false;
    if (remaining.length === 0) {
      const [user] = await db.select().from(users).where(eq(users.id, holder.userId)).limit(1);
      if (user) {
        await ensureUserIdentityFoundation(user);
        reminted = true;
      }
    } else {
      const remainingIds = remaining.map((row) => row.id);
      const nextActive = remainingIds.includes(holder.activeVaultId ?? "")
        ? holder.activeVaultId
        : remainingIds[0];
      const nextVisible = (holder.visibleVaultIds ?? []).filter((id) => remainingIds.includes(id));
      if (nextActive && !nextVisible.includes(nextActive)) nextVisible.push(nextActive);
      await db.update(users).set({
        activeVaultId: nextActive,
        visibleVaultIds: nextVisible,
      }).where(eq(users.id, holder.userId));
    }

    await insertReceipt(holder.accountId, vaultId, idempotencyKey, reminted);
    log.info("vault permanently erased", { vaultId, reminted });
    return { erased: true, vaultId, reminted, replayed: false };
  });
}
