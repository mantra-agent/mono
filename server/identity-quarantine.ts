/**
 * Phase 2 identity quarantine — status mutation, not delete.
 *
 * Canonical path for super-admin quarantine/restore of Accounts and Agent Instances.
 * Quarantined Instances fail closed on spend (see spend-authority.ts).
 * Account quarantine sets entitlement=unentitled and quarantines owned Instances.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  agentInstances,
  memberships,
  userProfiles,
  users,
} from "@shared/schema";
import { documentStoreDocuments, memoryVnextClaims } from "@shared/models/memory";
import { db } from "./db";
import { createLogger } from "./log";
import { createNamedSystemPrincipal, recordPrivilegedAccess, type Principal } from "./principal";
import { getSetting, setSetting } from "./system-settings";

const log = createLogger("IdentityQuarantine");

export const PROTECTED_OWNER_EMAILS = ["raymond.kallmeyer@gmail.com"] as const;

const ACCOUNT_QUARANTINE_REASON = "account_quarantined";
const CULL_SETTING_KEY = "migration.identity-fake-account-cull.v1";

const EXPLICIT_TEST_EMAIL_RE =
  /(?:^|\+)(?:test|fake|dummy|sample|noreply|no-reply)(?:@|[.+_-])|@(?:example\.|test\.|localhost$)|(?:^|\.)test(?:er)?\d*@/i;

export type QuarantineTarget = "account" | "instance";
export type QuarantineAction = "quarantine" | "restore";

export type FakeAccountReason =
  | "explicit_test_email"
  | "never_onboarded_shell"
  | "orphan_unentitled"
  | "identity_incomplete_shell";

export interface IdentityInventoryRow {
  accountId: string;
  accountName: string;
  accountKind: string;
  entitlement: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
  onboardingStatus: string | null;
  instanceIds: string[];
  instanceStatuses: string[];
  memberEmails: string[];
  memoryClaimCount: number;
  chatDocumentCount: number;
  protected: boolean;
  protectedReason: string | null;
  cullCandidate: boolean;
  cullReason: FakeAccountReason | null;
  alreadyQuarantined: boolean;
}

export interface IdentityCullResult {
  inventoried: number;
  candidates: number;
  quarantinedAccounts: string[];
  quarantinedInstances: string[];
  skippedProtected: Array<{ accountId: string; reason: string }>;
  skippedAlready: string[];
  inventory: IdentityInventoryRow[];
  dryRun: boolean;
}

export class IdentityQuarantineError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "IdentityQuarantineError";
    this.status = status;
    this.code = code;
  }
}

function now() {
  return new Date();
}

function isProtectedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return PROTECTED_OWNER_EMAILS.some((protectedEmail) => protectedEmail === normalized);
}

function isExplicitTestEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return EXPLICIT_TEST_EMAIL_RE.test(email.trim().toLowerCase());
}

function hasRealActivity(row: Pick<IdentityInventoryRow, "memoryClaimCount" | "chatDocumentCount" | "onboardingStatus">): boolean {
  if (row.memoryClaimCount > 0) return true;
  if (row.chatDocumentCount > 0) return true;
  const status = (row.onboardingStatus ?? "").toLowerCase();
  if (status && status !== "not_started") return true;
  return false;
}

function classifyCull(row: Omit<IdentityInventoryRow, "cullCandidate" | "cullReason" | "alreadyQuarantined" | "protected" | "protectedReason"> & {
  protected: boolean;
  protectedReason: string | null;
}): { cullCandidate: boolean; cullReason: FakeAccountReason | null; alreadyQuarantined: boolean } {
  const instancesQuarantined =
    row.instanceIds.length > 0 && row.instanceStatuses.every((status) => status === "quarantined");
  const alreadyQuarantined = row.entitlement === "unentitled" && (row.instanceIds.length === 0 || instancesQuarantined);

  if (row.protected) {
    return { cullCandidate: false, cullReason: null, alreadyQuarantined };
  }
  if (hasRealActivity(row)) {
    return { cullCandidate: false, cullReason: null, alreadyQuarantined };
  }

  const emails = [row.ownerEmail, ...row.memberEmails].filter(Boolean) as string[];
  if (emails.some((email) => isExplicitTestEmail(email))) {
    return { cullCandidate: true, cullReason: "explicit_test_email", alreadyQuarantined };
  }

  if (!row.ownerUserId) {
    return { cullCandidate: true, cullReason: "orphan_unentitled", alreadyQuarantined };
  }

  const onboarding = (row.onboardingStatus ?? "not_started").toLowerCase();
  if (onboarding === "not_started" && row.memoryClaimCount === 0 && row.chatDocumentCount === 0) {
    // Never-onboarded personal shells with no mind and no chat.
    if (row.accountKind === "personal") {
      return { cullCandidate: true, cullReason: "never_onboarded_shell", alreadyQuarantined };
    }
    return { cullCandidate: true, cullReason: "identity_incomplete_shell", alreadyQuarantined };
  }

  return { cullCandidate: false, cullReason: null, alreadyQuarantined };
}

export async function inventoryIdentityGraph(): Promise<IdentityInventoryRow[]> {
  const [accountRows, membershipRows, instanceRows, userRows, profileRows] = await Promise.all([
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        kind: accounts.kind,
        entitlement: accounts.entitlement,
        ownerUserId: accounts.ownerUserId,
      })
      .from(accounts),
    db
      .select({
        accountId: memberships.accountId,
        userId: memberships.userId,
      })
      .from(memberships),
    db
      .select({
        id: agentInstances.id,
        accountId: agentInstances.accountId,
        status: agentInstances.status,
      })
      .from(agentInstances),
    db
      .select({
        id: users.id,
        email: users.email,
      })
      .from(users),
    db
      .select({
        userId: userProfiles.userId,
        onboardingStatus: userProfiles.onboardingStatus,
      })
      .from(userProfiles),
  ]);

  const usersById = new Map(userRows.map((row) => [row.id, row]));
  const profilesByUser = new Map(profileRows.map((row) => [row.userId, row]));
  const membersByAccount = new Map<string, string[]>();
  for (const membership of membershipRows) {
    const list = membersByAccount.get(membership.accountId) ?? [];
    list.push(membership.userId);
    membersByAccount.set(membership.accountId, list);
  }
  const instancesByAccount = new Map<string, Array<{ id: string; status: string }>>();
  for (const instance of instanceRows) {
    const list = instancesByAccount.get(instance.accountId) ?? [];
    list.push({ id: instance.id, status: instance.status });
    instancesByAccount.set(instance.accountId, list);
  }

  const allUserIds = Array.from(new Set(userRows.map((row) => row.id)));
  const memoryCounts = new Map<string, number>();
  const chatCounts = new Map<string, number>();

  if (allUserIds.length > 0) {
    try {
      const memoryRows = await db
        .select({
          ownerUserId: memoryVnextClaims.ownerUserId,
          count: sql<number>`count(*)::int`,
        })
        .from(memoryVnextClaims)
        .where(inArray(memoryVnextClaims.ownerUserId, allUserIds))
        .groupBy(memoryVnextClaims.ownerUserId);
      for (const row of memoryRows) {
        if (row.ownerUserId) memoryCounts.set(row.ownerUserId, Number(row.count) || 0);
      }
    } catch (error) {
      log.warn("memory claim inventory unavailable; treating counts as zero", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const chatRows = await db
        .select({
          ownerUserId: documentStoreDocuments.ownerUserId,
          count: sql<number>`count(*)::int`,
        })
        .from(documentStoreDocuments)
        .where(
          and(
            eq(documentStoreDocuments.documentType, "chat"),
            inArray(documentStoreDocuments.ownerUserId, allUserIds),
          ),
        )
        .groupBy(documentStoreDocuments.ownerUserId);
      for (const row of chatRows) {
        if (row.ownerUserId) chatCounts.set(row.ownerUserId, Number(row.count) || 0);
      }
    } catch (error) {
      log.warn("chat document inventory unavailable; treating counts as zero", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return accountRows
    .map((account) => {
      const memberIds = membersByAccount.get(account.id) ?? [];
      const memberEmails = memberIds
        .map((userId) => usersById.get(userId)?.email ?? null)
        .filter((email): email is string => Boolean(email));
      const owner = account.ownerUserId ? usersById.get(account.ownerUserId) ?? null : null;
      const ownerProfile = account.ownerUserId ? profilesByUser.get(account.ownerUserId) ?? null : null;
      const relatedUserIds = Array.from(new Set([account.ownerUserId, ...memberIds].filter(Boolean) as string[]));
      const memoryClaimCount = relatedUserIds.reduce((sum, userId) => sum + (memoryCounts.get(userId) ?? 0), 0);
      const chatDocumentCount = relatedUserIds.reduce((sum, userId) => sum + (chatCounts.get(userId) ?? 0), 0);
      const instances = instancesByAccount.get(account.id) ?? [];
      const protectedByEmail = isProtectedEmail(owner?.email) || memberEmails.some((email) => isProtectedEmail(email));
      const protectedReason = protectedByEmail
        ? "protected_owner_email"
        : hasRealActivity({
              memoryClaimCount,
              chatDocumentCount,
              onboardingStatus: ownerProfile?.onboardingStatus ?? null,
            })
          ? "real_activity"
          : null;

      const base = {
        accountId: account.id,
        accountName: account.name,
        accountKind: account.kind,
        entitlement: account.entitlement,
        ownerUserId: account.ownerUserId,
        ownerEmail: owner?.email ?? null,
        onboardingStatus: ownerProfile?.onboardingStatus ?? null,
        instanceIds: instances.map((instance) => instance.id),
        instanceStatuses: instances.map((instance) => instance.status),
        memberEmails,
        memoryClaimCount,
        chatDocumentCount,
        protected: Boolean(protectedReason) || protectedByEmail,
        protectedReason: protectedByEmail ? "protected_owner_email" : protectedReason,
      };

      const classification = classifyCull(base);
      return {
        ...base,
        ...classification,
      };
    })
    .sort((a, b) => a.accountName.localeCompare(b.accountName));
}

async function assertAccountMutable(accountId: string): Promise<{
  id: string;
  name: string;
  entitlement: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
}> {
  const [account] = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      entitlement: accounts.entitlement,
      ownerUserId: accounts.ownerUserId,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) {
    throw new IdentityQuarantineError(404, "account_not_found", "Account not found");
  }

  let ownerEmail: string | null = null;
  if (account.ownerUserId) {
    const [owner] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, account.ownerUserId))
      .limit(1);
    ownerEmail = owner?.email ?? null;
  }
  if (isProtectedEmail(ownerEmail)) {
    throw new IdentityQuarantineError(
      403,
      "protected_account",
      "Ray's personal Account cannot be quarantined",
    );
  }
  return { ...account, ownerEmail };
}

export async function setAccountQuarantine(args: {
  principal: Principal;
  accountId: string;
  action: QuarantineAction;
  reason?: string | null;
}): Promise<{
  accountId: string;
  entitlement: string;
  instanceIds: string[];
  action: QuarantineAction;
}> {
  const account = await assertAccountMutable(args.accountId);
  const reason =
    args.action === "quarantine"
      ? (args.reason?.trim() || ACCOUNT_QUARANTINE_REASON)
      : null;

  const result = await db.transaction(async (tx) => {
    const entitlement = args.action === "quarantine" ? "unentitled" : "entitled";
    await tx
      .update(accounts)
      .set({ entitlement, updatedAt: now() })
      .where(eq(accounts.id, account.id));

    const ownedInstances = await tx
      .select({ id: agentInstances.id, status: agentInstances.status, quarantineReason: agentInstances.quarantineReason })
      .from(agentInstances)
      .where(eq(agentInstances.accountId, account.id));

    const touchedIds: string[] = [];
    if (args.action === "quarantine") {
      for (const instance of ownedInstances) {
        if (instance.status === "quarantined") continue;
        await tx
          .update(agentInstances)
          .set({
            status: "quarantined",
            quarantineReason: reason,
            updatedAt: now(),
          })
          .where(eq(agentInstances.id, instance.id));
        touchedIds.push(instance.id);
      }
    } else {
      for (const instance of ownedInstances) {
        // Restore only instances quarantined as part of account quarantine (or empty reason).
        if (instance.status !== "quarantined") continue;
        const instanceReason = instance.quarantineReason ?? "";
        if (
          instanceReason &&
          instanceReason !== ACCOUNT_QUARANTINE_REASON &&
          !instanceReason.startsWith("account_") &&
          !instanceReason.startsWith("fake_") &&
          !instanceReason.startsWith("cull_")
        ) {
          continue;
        }
        await tx
          .update(agentInstances)
          .set({
            status: "active",
            quarantineReason: null,
            updatedAt: now(),
          })
          .where(eq(agentInstances.id, instance.id));
        touchedIds.push(instance.id);
      }
    }

    return { entitlement, instanceIds: touchedIds };
  });

  await recordPrivilegedAccess({
    principal: args.principal,
    action: args.action === "quarantine" ? "quarantine_account" : "restore_account",
    reason: reason ?? "restore",
    metadata: {
      accountId: account.id,
      accountName: account.name,
      instanceIds: result.instanceIds,
      previousEntitlement: account.entitlement,
      entitlement: result.entitlement,
    },
  });

  log.info("account quarantine mutation", {
    action: args.action,
    accountId: account.id,
    entitlement: result.entitlement,
    instanceCount: result.instanceIds.length,
  });

  return {
    accountId: account.id,
    entitlement: result.entitlement,
    instanceIds: result.instanceIds,
    action: args.action,
  };
}

export async function setInstanceQuarantine(args: {
  principal: Principal;
  instanceId: string;
  action: QuarantineAction;
  reason?: string | null;
}): Promise<{
  instanceId: string;
  accountId: string;
  status: string;
  quarantineReason: string | null;
  action: QuarantineAction;
}> {
  const [instance] = await db
    .select({
      id: agentInstances.id,
      accountId: agentInstances.accountId,
      name: agentInstances.name,
      status: agentInstances.status,
      quarantineReason: agentInstances.quarantineReason,
    })
    .from(agentInstances)
    .where(eq(agentInstances.id, args.instanceId))
    .limit(1);
  if (!instance) {
    throw new IdentityQuarantineError(404, "instance_not_found", "Agent Instance not found");
  }

  await assertAccountMutable(instance.accountId);

  const nextStatus = args.action === "quarantine" ? "quarantined" : "active";
  const nextReason =
    args.action === "quarantine"
      ? (args.reason?.trim() || "manual_quarantine")
      : null;

  await db
    .update(agentInstances)
    .set({
      status: nextStatus,
      quarantineReason: nextReason,
      updatedAt: now(),
    })
    .where(eq(agentInstances.id, instance.id));

  await recordPrivilegedAccess({
    principal: args.principal,
    action: args.action === "quarantine" ? "quarantine_instance" : "restore_instance",
    reason: nextReason ?? "restore",
    metadata: {
      instanceId: instance.id,
      instanceName: instance.name,
      accountId: instance.accountId,
      previousStatus: instance.status,
      status: nextStatus,
    },
  });

  log.info("instance quarantine mutation", {
    action: args.action,
    instanceId: instance.id,
    accountId: instance.accountId,
    status: nextStatus,
  });

  return {
    instanceId: instance.id,
    accountId: instance.accountId,
    status: nextStatus,
    quarantineReason: nextReason,
    action: args.action,
  };
}

/**
 * One-shot inventory + cull of obvious fake/test/incomplete Accounts.
 * Replay-safe via system_settings marker. Never touches protected owners or real activity.
 */
export async function runFakeAccountCull(args?: {
  dryRun?: boolean;
  force?: boolean;
}): Promise<IdentityCullResult> {
  const dryRun = Boolean(args?.dryRun);
  if (!args?.force && !dryRun) {
    const prior = await getSetting<{ completedAt?: string }>(CULL_SETTING_KEY);
    if (prior?.completedAt) {
      log.info("fake account cull already completed; skipping", { completedAt: prior.completedAt });
      const inventory = await inventoryIdentityGraph();
      return {
        inventoried: inventory.length,
        candidates: inventory.filter((row) => row.cullCandidate).length,
        quarantinedAccounts: [],
        quarantinedInstances: [],
        skippedProtected: inventory
          .filter((row) => row.protected)
          .map((row) => ({ accountId: row.accountId, reason: row.protectedReason ?? "protected" })),
        skippedAlready: inventory.filter((row) => row.alreadyQuarantined).map((row) => row.accountId),
        inventory,
        dryRun: false,
      };
    }
  }

  const inventory = await inventoryIdentityGraph();
  const quarantinedAccounts: string[] = [];
  const quarantinedInstances: string[] = [];
  const skippedProtected = inventory
    .filter((row) => row.protected)
    .map((row) => ({ accountId: row.accountId, reason: row.protectedReason ?? "protected" }));
  const skippedAlready = inventory.filter((row) => row.alreadyQuarantined).map((row) => row.accountId);

  const systemPrincipal = createNamedSystemPrincipal("identity-fake-account-cull");

  for (const row of inventory) {
    if (!row.cullCandidate || row.alreadyQuarantined) continue;
    if (dryRun) {
      quarantinedAccounts.push(row.accountId);
      quarantinedInstances.push(...row.instanceIds);
      continue;
    }

    const reason = `cull_${row.cullReason ?? "fake"}`;
    const result = await setAccountQuarantine({
      principal: systemPrincipal,
      accountId: row.accountId,
      action: "quarantine",
      reason,
    });
    quarantinedAccounts.push(result.accountId);
    quarantinedInstances.push(...result.instanceIds);
  }

  if (!dryRun) {
    await setSetting(CULL_SETTING_KEY, {
      completedAt: new Date().toISOString(),
      quarantinedAccounts,
      quarantinedInstances,
      candidateCount: inventory.filter((row) => row.cullCandidate).length,
      inventoried: inventory.length,
    });
  }

  log.info("fake account cull complete", {
    dryRun,
    inventoried: inventory.length,
    quarantinedAccounts: quarantinedAccounts.length,
    quarantinedInstances: quarantinedInstances.length,
  });

  return {
    inventoried: inventory.length,
    candidates: inventory.filter((row) => row.cullCandidate).length,
    quarantinedAccounts,
    quarantinedInstances,
    skippedProtected,
    skippedAlready,
    inventory,
    dryRun,
  };
}
