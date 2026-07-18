import { sql, eq, and } from "drizzle-orm";
import { type Request, type Response, type NextFunction } from "express";
import { db } from "./db";
import { createLogger } from "./log";
import { recordPrincipalDiagnosticEvent } from "./principal-diagnostics";
import { accounts, memberships, userProfiles, agentProfiles, privilegedAccessAudit, type User } from "@shared/schema";
import { getUserEffectivePermissions, type Permission } from "./permissions";

const log = createLogger("principal");

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
  };
}

export function createSystemPrincipal(scopes: string[] = ["system:read", "system:write"]): Principal {
  return {
    actorType: "system",
    userId: null,
    accountId: null,
    role: "system",
    scopes: [...new Set(scopes)],
    permissions: ["build:read", "build:write", "system:read", "system:write", "users:read", "users:write"],
    isAdmin: true,
    impersonation: null,
    source: "system",
    visibleVaultIds: [],
    activeVaultId: null,
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
 */
export function createUserPrincipalFromUser(user: User, accountId: string): Principal {
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
  };
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
    visibleVaultIds: user.visibleVaultIds ?? [],
    activeVaultId: user.activeVaultId ?? null,
  };
}

export async function resolveUserIdentityFoundation(userId: string): Promise<{ accountId: string; role: PrincipalRole }> {
  const existing = await db
    .select({ accountId: accounts.id, role: memberships.role })
    .from(accounts)
    .innerJoin(memberships, eq(memberships.accountId, accounts.id))
    .where(and(eq(accounts.kind, "personal"), eq(accounts.ownerUserId, userId), eq(memberships.userId, userId)))
    .limit(1);
  if (!existing[0]?.accountId) {
    throw new Error(`Identity foundation missing for user ${userId}`);
  }
  return { accountId: existing[0].accountId, role: normalizeRole(existing[0].role) };
}

export async function ensureUserIdentityFoundation(user: User): Promise<{ accountId: string; role: PrincipalRole }> {
  const existing = await db
    .select({ accountId: accounts.id, role: memberships.role })
    .from(accounts)
    .innerJoin(memberships, eq(memberships.accountId, accounts.id))
    .where(and(eq(accounts.kind, "personal"), eq(accounts.ownerUserId, user.id), eq(memberships.userId, user.id)))
    .limit(1);

  if (existing[0]?.accountId) {
    return { accountId: existing[0].accountId, role: normalizeRole(existing[0].role) };
  }

  const accountName = "Personal Account";
  const [account] = await db
    .insert(accounts)
    .values({ kind: "personal", name: accountName, ownerUserId: user.id })
    .onConflictDoUpdate({
      target: [accounts.kind, accounts.ownerUserId],
      set: { updatedAt: sql`CURRENT_TIMESTAMP` },
    })
    .returning();

  const accountId = account?.id ?? (await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.kind, "personal"), eq(accounts.ownerUserId, user.id)))
    .limit(1))[0]?.id;

  if (!accountId) throw new Error(`Failed to resolve personal account for user ${user.id}`);

  const membershipRole = "owner";
  await db
    .insert(memberships)
    .values({ accountId, userId: user.id, role: membershipRole })
    .onConflictDoUpdate({
      target: [memberships.accountId, memberships.userId],
      set: { role: membershipRole, updatedAt: sql`CURRENT_TIMESTAMP` },
    });

  await ensureProfileRows(user, accountId);
  return { accountId, role: normalizeRole(membershipRole) };
}

async function ensureProfileRows(user: User, accountId: string): Promise<void> {
  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      accountId,
      displayName: null,
      preferredName: null,
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { accountId, updatedAt: sql`CURRENT_TIMESTAMP` },
    });

  await db
    .insert(agentProfiles)
    .values({ userId: user.id, accountId, agentName: "Agent" })
    .onConflictDoUpdate({
      target: agentProfiles.userId,
      set: { accountId, updatedAt: sql`CURRENT_TIMESTAMP` },
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
