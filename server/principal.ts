import { sql, eq, and, isNotNull, asc } from "drizzle-orm";
import {
  ACCOUNT_STATUSES,
  derivedInstanceStatus,
  type AccountStatus,
} from "@shared/schema";
import { type Request, type Response, type NextFunction } from "express";
import { ADVISORY_LOCK_NS, acquireAdvisoryTransactionLock, db, type DrizzleTx } from "./db";
import { createLogger } from "./log";
import { recordPrincipalDiagnosticEvent } from "./principal-diagnostics";
import {
  accounts,
  memberships,
  users,
  userProfiles,
  agentProfiles,
  agentInstances,
  agentInstanceMemberships,
  privilegedAccessAudit,
  routers,
  type User,
} from "@shared/schema";
import { getUserEffectivePermissions, type Permission } from "./permissions";
import { DEFAULT_AGENT_NAME } from "@shared/instance-config";
import { deriveUserFirstName } from "@shared/identity-name";
import { PERSONAL_VAULT_COLOR, vaults } from "@shared/models/vaults";

const log = createLogger("principal");

export class AccountLifecycleError extends Error {
  readonly code: "account_suspended" | "account_archived";

  constructor(code: "account_suspended" | "account_archived", message: string) {
    super(message);
    this.name = "AccountLifecycleError";
    this.code = code;
  }
}

export type ActorType = "user" | "service" | "system";
export type PrincipalRole = "owner" | "admin" | "member" | "viewer" | "service" | "system";

export interface PrincipalImpersonation {
  impersonatedByActorType: ActorType;
  impersonatedByUserId?: string | null;
  impersonatedByAccountId?: string | null;
  reason?: string | null;
}

export interface Principal {
  actorType: ActorType;
  userId: string | null;
  accountId: string | null;
  role: PrincipalRole;
  scopes: string[];
  permissions: Permission[];
  isAdmin: boolean;
  impersonation?: PrincipalImpersonation | null;
  source: "session" | "bearer" | "system";
  /** Vault IDs the user has toggled visible (read filter). Empty = see all (system principals). */
  visibleVaultIds: string[];
  /** The single vault new data lands in. Null for system/service principals. */
  activeVaultId: string | null;
  /**
   * Pinned Agent Instance for this Account (mind / continuity boundary).
   * Null for system/service principals or when the pin is unresolved.
   * Memory, personas, Timers, and Skills dual-write/read via ScopeColumns.instanceId.
   */
  instanceId: string | null;
  /** Named system job for vault allowlist enforcement. Only set on system principals. */
  jobName?: string;
}

interface ServiceSessionPrincipal {
  actorType: "service";
  scopes: string[];
  permissions?: Permission[];
  createdAt: string;
  reason?: string;
}

declare module "express-session" {
  interface SessionData {
    servicePrincipal?: ServiceSessionPrincipal;
  }
}

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

const USER_DEFAULT_SCOPES = ["user:read", "user:write"];
const ADMIN_DEFAULT_SCOPES = ["user:read", "user:write", "admin:read", "admin:write"];
const SERVICE_DEFAULT_SCOPES = ["service:automation", "service:read", "service:write"];

export function createServicePrincipal(
  scopes: string[] = SERVICE_DEFAULT_SCOPES,
  permissions: Permission[] = [],
): Principal {
  return {
    actorType: "service",
    userId: null,
    accountId: null,
    role: "service",
    scopes: [...new Set(scopes)],
    permissions: [...new Set(permissions)],
    isAdmin: false,
    impersonation: null,
    source: "bearer",
    visibleVaultIds: [],
    activeVaultId: null,
    instanceId: null,
  };
}

export function createSystemPrincipal(scopes: string[] = ["system:read", "system:write"]): Principal {
  return {
    actorType: "system",
    userId: null,
    accountId: null,
    role: "system",
    scopes: [...new Set(scopes)],
    permissions: ["build:read", "build:write", "system:read", "system:write", "users:read", "users:write", "mods:read", "mods:manage"],
    isAdmin: true,
    impersonation: null,
    source: "system",
    visibleVaultIds: [],
    activeVaultId: null,
    instanceId: null,
  };
}

/**
 * Create a named system principal for vault allowlist enforcement.
 * Named system principals that touch vault-scoped data are checked against
 * the allowlist in server/vault-allowlist.ts. Use this instead of
 * createSystemPrincipal() when the job name should be tracked for audit.
 */
export function createNamedSystemPrincipal(
  jobName: string,
  scopes: string[] = ["system:read", "system:write"],
): Principal {
  return {
    ...createSystemPrincipal(scopes),
    jobName,
  };
}

export function setServiceSessionPrincipal(
  req: Request,
  reason: string,
  scopes: string[] = SERVICE_DEFAULT_SCOPES,
  permissions: Permission[] = [],
): Principal {
  req.session.servicePrincipal = {
    actorType: "service",
    scopes: [...new Set(scopes)],
    permissions: [...new Set(permissions)],
    createdAt: new Date().toISOString(),
    reason,
  };
  delete req.session.userId;
  const principal = createServicePrincipal(scopes, permissions);
  req.principal = principal;
  return principal;
}

/**
 * Create a user principal for autonomous/background use (timers, skills, hooks).
 * Populates vault fields from the user record so vault-scoped operations work correctly.
 * Pass the Account-pinned Instance when known so memory dual-write can stamp it.
 */
export function createUserPrincipalFromUser(
  user: User,
  accountId: string,
  instanceId: string | null = null,
): Principal {
  const isAdmin = user.role === "admin";
  return {
    actorType: "user",
    userId: user.id,
    accountId,
    role: isAdmin ? "admin" : "member",
    scopes: isAdmin ? ADMIN_DEFAULT_SCOPES : USER_DEFAULT_SCOPES,
    permissions: [],
    isAdmin,
    impersonation: null,
    source: "system",
    visibleVaultIds: user.visibleVaultIds ?? [],
    activeVaultId: user.activeVaultId ?? null,
    instanceId,
  };
}

export interface UserIdentityFoundation {
  accountId: string;
  role: PrincipalRole;
  activeVaultId: string;
  visibleVaultIds: string[];
  /** Personal Agent Instance for this Account (mind boundary). */
  instanceId: string;
}

export interface EnsureUserIdentityFoundationOptions {
  identityName?: string | null;
}

export async function createUserSessionPrincipal(user: User): Promise<Principal> {
  const foundation = await resolveUserIdentityFoundation(user.id);
  const isAdmin = user.role === "admin";
  return {
    actorType: "user",
    userId: user.id,
    accountId: foundation.accountId,
    role: foundation.role === "owner" && isAdmin ? "admin" : foundation.role,
    scopes: isAdmin ? ADMIN_DEFAULT_SCOPES : USER_DEFAULT_SCOPES,
    permissions: await getUserEffectivePermissions(user.id),
    isAdmin,
    impersonation: null,
    source: "session",
    visibleVaultIds: foundation.visibleVaultIds,
    activeVaultId: foundation.activeVaultId,
    instanceId: foundation.instanceId,
  };
}

export async function resolveUserIdentityFoundation(userId: string): Promise<UserIdentityFoundation> {
  const [row] = await db
    .select({
      accountId: accounts.id,
      accountStatus: accounts.status,
      role: memberships.role,
      activeVaultId: users.activeVaultId,
      visibleVaultIds: users.visibleVaultIds,
      instanceId: agentInstanceMemberships.instanceId,
    })
    .from(accounts)
    .innerJoin(memberships, eq(memberships.accountId, accounts.id))
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(
      agentInstanceMemberships,
      and(
        eq(agentInstanceMemberships.accountId, accounts.id),
        eq(agentInstanceMemberships.userId, userId),
      ),
    )
    .where(and(eq(accounts.kind, "personal"), eq(accounts.ownerUserId, userId), eq(memberships.userId, userId)))
    .limit(1);
  if (!row?.accountId || !row.activeVaultId || !row.instanceId) {
    throw new Error(`Identity foundation missing for user ${userId}`);
  }
  if (row.accountStatus === "suspended") {
    throw new AccountLifecycleError("account_suspended", "This account is suspended.");
  }
  if (row.accountStatus === "archived") {
    throw new AccountLifecycleError("account_archived", "This account is archived.");
  }
  return {
    accountId: row.accountId,
    role: normalizeRole(row.role),
    activeVaultId: row.activeVaultId,
    visibleVaultIds: row.visibleVaultIds ?? [],
    instanceId: row.instanceId,
  };
}

/** Soft resolve for background loops that must skip orphan users without ERROR thrash. */
export async function tryResolveUserIdentityFoundation(
  userId: string,
): Promise<UserIdentityFoundation | null> {
  const [existing] = await db
    .select({
      accountId: accounts.id,
      role: memberships.role,
      activeVaultId: users.activeVaultId,
      visibleVaultIds: users.visibleVaultIds,
      instanceId: agentInstanceMemberships.instanceId,
    })
    .from(accounts)
    .innerJoin(memberships, eq(memberships.accountId, accounts.id))
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(
      agentInstanceMemberships,
      and(
        eq(agentInstanceMemberships.accountId, accounts.id),
        eq(agentInstanceMemberships.userId, userId),
      ),
    )
    .where(and(
      eq(accounts.kind, "personal"),
      eq(accounts.ownerUserId, userId),
      eq(memberships.userId, userId),
      eq(accounts.status, "active"),
    ))
    .limit(1);
  if (!existing?.accountId || !existing.activeVaultId || !existing.instanceId) {
    return null;
  }
  return {
    accountId: existing.accountId,
    role: normalizeRole(existing.role),
    activeVaultId: existing.activeVaultId,
    visibleVaultIds: existing.visibleVaultIds ?? [],
    instanceId: existing.instanceId,
  };
}

/**
 * Producer-side filter for identity-scoped background work.
 * Only users with personal account ownership, membership, and an active vault.
 * Orphan invite/synthetic users never enter the iteration set.
 */
export async function listUsersWithIdentityFoundation(): Promise<
  Array<{ user: User; foundation: UserIdentityFoundation }>
> {
  const rows = await db
    .select({
      user: users,
      accountId: accounts.id,
      role: memberships.role,
      activeVaultId: users.activeVaultId,
      visibleVaultIds: users.visibleVaultIds,
      instanceId: agentInstanceMemberships.instanceId,
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(
      accounts,
      and(
        eq(accounts.id, memberships.accountId),
        eq(accounts.kind, "personal"),
        eq(accounts.ownerUserId, users.id),
        eq(accounts.status, "active"),
      ),
    )
    .innerJoin(
      agentInstanceMemberships,
      and(
        eq(agentInstanceMemberships.accountId, accounts.id),
        eq(agentInstanceMemberships.userId, users.id),
      ),
    )
    .where(isNotNull(users.activeVaultId));

  const out: Array<{ user: User; foundation: UserIdentityFoundation }> = [];
  for (const row of rows) {
    if (!row.accountId || !row.activeVaultId || !row.instanceId) continue;
    out.push({
      user: row.user,
      foundation: {
        accountId: row.accountId,
        role: normalizeRole(row.role),
        activeVaultId: row.activeVaultId,
        visibleVaultIds: row.visibleVaultIds ?? [],
        instanceId: row.instanceId,
      },
    });
  }
  return out;
}

export async function ensureUserIdentityFoundation(
  user: User,
  options: EnsureUserIdentityFoundationOptions = {},
): Promise<UserIdentityFoundation> {
  return db.transaction(async (tx) => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.USER_IDENTITY, user.id);

    const identityName = options.identityName?.replace(/\s+/g, " ").trim().slice(0, 120) || null;

    const [existingProfile] = await tx
      .select({ preferredName: userProfiles.preferredName, displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(eq(userProfiles.userId, user.id))
      .limit(1);
    const firstName = deriveUserFirstName({
      preferredName: identityName ?? existingProfile?.preferredName,
      displayName: identityName ?? existingProfile?.displayName,
      email: user.email,
    }, "Personal");

    const [existingAccount] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.kind, "personal"), eq(accounts.ownerUserId, user.id)))
      .limit(1);

    let accountId = existingAccount?.id ?? null;
    if (!accountId) {
      // New Accounts receive Default Router when one exists (parallel cutover: existing stay NULL).
      const [defaultRouter] = await tx
        .select({ id: routers.id })
        .from(routers)
        .where(eq(routers.isDefault, true))
        .limit(1);
      accountId = (await tx
        .insert(accounts)
        .values({
          kind: "personal",
          name: firstName,
          ownerUserId: user.id,
          routerId: defaultRouter?.id ?? null,
        })
        .onConflictDoUpdate({
          target: [accounts.kind, accounts.ownerUserId],
          set: { updatedAt: sql`CURRENT_TIMESTAMP` },
        })
        .returning({ id: accounts.id }))[0]?.id ?? null;
    }
    if (!accountId) throw new Error(`Failed to resolve personal account for user ${user.id}`);

    const membershipRole = "owner";
    await tx
      .insert(memberships)
      .values({ accountId, userId: user.id, role: membershipRole })
      .onConflictDoUpdate({
        target: [memberships.accountId, memberships.userId],
        set: { role: membershipRole, updatedAt: sql`CURRENT_TIMESTAMP` },
      });

    const instanceId = await ensurePersonalAgentInstance(tx, {
      userId: user.id,
      accountId,
      name: firstName,
    });
    await ensureProfileRows(tx, user, accountId, instanceId, identityName);

    const [existingDefaultVault] = await tx
      .select({ id: vaults.id })
      .from(vaults)
      .where(and(eq(vaults.accountId, accountId), eq(vaults.isDefault, true)))
      .orderBy(vaults.createdAt, vaults.id)
      .limit(1);

    const createdDefaultVault = !existingDefaultVault;
    const defaultVaultId = existingDefaultVault?.id ?? (await tx
      .insert(vaults)
      .values({
        accountId,
        name: firstName,
        icon: firstName.slice(0, 1).toUpperCase(),
        color: PERSONAL_VAULT_COLOR,
        position: 0,
        isDefault: true,
        isArchived: false,
      })
      .returning({ id: vaults.id }))[0]?.id;
    if (!defaultVaultId) throw new Error(`Failed to resolve default Vault for user ${user.id}`);

    const [currentUser] = await tx
      .select({ activeVaultId: users.activeVaultId, visibleVaultIds: users.visibleVaultIds })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (!currentUser) throw new Error(`User not found while provisioning identity foundation ${user.id}`);

    const activeVaultId = currentUser.activeVaultId ?? defaultVaultId;
    const visibleVaultIds = Array.from(new Set([
      ...(currentUser.visibleVaultIds ?? []),
      ...(createdDefaultVault || !currentUser.activeVaultId ? [defaultVaultId] : []),
      activeVaultId,
    ]));

    await tx
      .update(users)
      .set({ activeVaultId, visibleVaultIds })
      .where(eq(users.id, user.id));

    return {
      accountId,
      role: normalizeRole(membershipRole),
      activeVaultId,
      visibleVaultIds,
      instanceId,
    };
  });
}

/**
 * Get-or-create the personal Agent Instance and Manager membership for (user, account).
 * Encodes one User → one Instance pin per Account via membership uniqueness.
 */
async function ensurePersonalAgentInstance(
  tx: DrizzleTx,
  args: { userId: string; accountId: string; name: string },
): Promise<string> {
  const [existingMembership] = await tx
    .select({ instanceId: agentInstanceMemberships.instanceId })
    .from(agentInstanceMemberships)
    .where(
      and(
        eq(agentInstanceMemberships.accountId, args.accountId),
        eq(agentInstanceMemberships.userId, args.userId),
      ),
    )
    .limit(1);
  if (existingMembership?.instanceId) {
    await tx
      .insert(agentInstanceMemberships)
      .values({
        instanceId: existingMembership.instanceId,
        userId: args.userId,
        accountId: args.accountId,
        role: "manager",
      })
      .onConflictDoUpdate({
        target: [agentInstanceMemberships.accountId, agentInstanceMemberships.userId],
        set: {
          role: "manager",
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
    return existingMembership.instanceId;
  }

  const [linkedProfile] = await tx
    .select({ instanceId: agentProfiles.instanceId })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.userId, args.userId), isNotNull(agentProfiles.instanceId)))
    .limit(1);
  if (linkedProfile?.instanceId) {
    await tx
      .insert(agentInstanceMemberships)
      .values({
        instanceId: linkedProfile.instanceId,
        userId: args.userId,
        accountId: args.accountId,
        role: "manager",
      })
      .onConflictDoUpdate({
        target: [agentInstanceMemberships.accountId, agentInstanceMemberships.userId],
        set: {
          instanceId: linkedProfile.instanceId,
          role: "manager",
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
    return linkedProfile.instanceId;
  }

  const [accountInstance] = await tx
    .select({ id: agentInstances.id })
    .from(agentInstances)
    .where(eq(agentInstances.accountId, args.accountId))
    .orderBy(asc(agentInstances.createdAt), asc(agentInstances.id))
    .limit(1);

  const instanceId = accountInstance?.id ?? (await tx
    .insert(agentInstances)
    .values({
      accountId: args.accountId,
      name: args.name,
      createdByUserId: args.userId,
      status: "active",
    })
    .returning({ id: agentInstances.id }))[0]?.id;
  if (!instanceId) throw new Error(`Failed to resolve agent instance for user ${args.userId}`);

  await tx
    .insert(agentInstanceMemberships)
    .values({
      instanceId,
      userId: args.userId,
      accountId: args.accountId,
      role: "manager",
    })
    .onConflictDoUpdate({
      target: [agentInstanceMemberships.accountId, agentInstanceMemberships.userId],
      set: {
        instanceId,
        role: "manager",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });

  return instanceId;
}

export async function renameAccount(
  accountId: string,
  name: string,
): Promise<{ accountId: string; name: string }> {
  const next = name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!next) throw new Error("Account name is required");
  const [updated] = await db
    .update(accounts)
    .set({ name: next, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id, name: accounts.name });
  if (!updated) throw new Error("Account not found");
  return { accountId: updated.id, name: updated.name };
}

export async function setAccountLifecycleStatus(
  accountId: string,
  status: AccountStatus,
): Promise<{ accountId: string; status: AccountStatus; instanceStatus: ReturnType<typeof derivedInstanceStatus> }> {
  if (!ACCOUNT_STATUSES.includes(status)) {
    throw new Error(`Invalid account status ${status}`);
  }
  const instanceStatus = derivedInstanceStatus(status);
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!account) throw new Error("Account not found");

    await tx
      .update(accounts)
      .set({ status, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(accounts.id, accountId));

    await tx
      .update(agentInstances)
      .set({ status: instanceStatus, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(
        eq(agentInstances.accountId, accountId),
        sql`${agentInstances.status} IS DISTINCT FROM 'quarantined'`,
      ));

    if (account.ownerUserId) {
      await tx.execute(sql`DELETE FROM "session" WHERE sess->>'userId' = ${account.ownerUserId}`);
    }
    return { accountId, status, instanceStatus };
  });
}

export async function deleteAccountPermanently(accountId: string): Promise<{ accountId: string; userId: string | null }> {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!account) throw new Error("Account not found");

    const ownerUserId = account.ownerUserId;
    if (ownerUserId) {
      await tx.execute(sql`DELETE FROM "session" WHERE sess->>'userId' = ${ownerUserId}`);
    }
    await tx.delete(accounts).where(eq(accounts.id, accountId));
    if (ownerUserId) {
      const remaining = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.userId, ownerUserId))
        .limit(1);
      if (remaining.length === 0) {
        await tx.delete(users).where(eq(users.id, ownerUserId));
      }
    }
    return { accountId, userId: ownerUserId };
  });
}

async function ensureProfileRows(
  tx: DrizzleTx,
  user: User,
  accountId: string,
  instanceId: string,
  identityName: string | null,
): Promise<void> {
  await tx
    .insert(userProfiles)
    .values({
      userId: user.id,
      accountId,
      displayName: identityName,
      preferredName: identityName,
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: {
        accountId,
        ...(identityName ? { displayName: identityName, preferredName: identityName } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });

  // Ownership key is instance_id; user_id stays created_by / dual-write.
  const [existingByInstance] = await tx
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(eq(agentProfiles.instanceId, instanceId))
    .limit(1);
  if (existingByInstance) {
    await tx
      .update(agentProfiles)
      .set({
        userId: user.id,
        accountId,
        instanceId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(agentProfiles.id, existingByInstance.id));
    return;
  }

  const [existingByUser] = await tx
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.userId, user.id), sql`${agentProfiles.instanceId} IS NULL`))
    .limit(1);
  if (existingByUser) {
    await tx
      .update(agentProfiles)
      .set({
        accountId,
        instanceId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(agentProfiles.id, existingByUser.id));
    return;
  }

  await tx.insert(agentProfiles).values({
    userId: user.id,
    accountId,
    instanceId,
    agentName: DEFAULT_AGENT_NAME,
  });
}

function normalizeRole(role: string | null | undefined): PrincipalRole {
  if (role === "owner" || role === "admin" || role === "member" || role === "viewer") return role;
  return "member";
}

export async function attachUserPrincipal(req: Request, user: User): Promise<Principal> {
  const principal = await createUserSessionPrincipal(user);
  req.principal = principal;
  recordPrincipalDiagnosticEvent({
    type: "attach_user",
    path: req.path,
    method: req.method,
    principalActorType: principal.actorType,
    principalUserId: principal.userId,
    principalAccountId: principal.accountId,
    isAdmin: principal.isAdmin,
  });
  return principal;
}

export function attachServicePrincipal(
  req: Request,
  scopes: string[] = SERVICE_DEFAULT_SCOPES,
  permissions: Permission[] = [],
): Principal {
  const principal = createServicePrincipal(scopes, permissions);
  req.principal = principal;
  recordPrincipalDiagnosticEvent({
    type: "attach_service",
    path: req.path,
    method: req.method,
    principalActorType: principal.actorType,
    principalUserId: principal.userId,
    principalAccountId: principal.accountId,
    isAdmin: principal.isAdmin,
  });
  return principal;
}

export function getPrincipal(req: Request): Principal | null {
  return req.principal ?? null;
}

export function hasScope(principal: Principal, requiredScope: string): boolean {
  return principal.scopes.includes(requiredScope) || principal.scopes.includes("*");
}

export function requirePrincipal(req: Request, res: Response, next: NextFunction) {
  if (!req.principal) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

export function requireScope(requiredScope: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const principal = getPrincipal(req);
    if (!principal) return res.status(401).json({ error: "Authentication required" });
    if (!hasScope(principal, requiredScope)) {
      recordPrincipalDiagnosticEvent({
        type: "scope_denied",
        path: req.path,
        method: req.method,
        requiredScope,
        principalActorType: principal.actorType,
        principalUserId: principal.userId,
        principalAccountId: principal.accountId,
        isAdmin: principal.isAdmin,
      });
      return res.status(403).json({ error: "Insufficient scope" });
    }
    next();
  };
}

export async function recordPrivilegedAccess(input: {
  principal: Principal;
  action: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(privilegedAccessAudit).values({
      actorType: input.principal.actorType,
      actorUserId: input.principal.userId,
      actorAccountId: input.principal.accountId,
      impersonatedUserId: null,
      impersonatedAccountId: null,
      action: input.action,
      reason: input.reason ?? null,
      scopes: input.principal.scopes,
      metadata: input.metadata ?? {},
    });
  } catch (error) {
    log.warn("privileged access audit write failed", {
      action: input.action,
      actorType: input.principal.actorType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
