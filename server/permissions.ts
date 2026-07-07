import { eq, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db } from "./db";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { recordPrincipalDiagnosticEvent } from "./principal-diagnostics";
import { userPermissions, users } from "@shared/schema";

const log = createLogger("permissions");

export const PERMISSIONS = [
  "build:read",
  "build:write",
  "system:read",
  "system:write",
  "users:read",
  "users:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const USER_BASE_PERMISSIONS: Permission[] = [];
const ADMIN_BASE_PERMISSIONS: Permission[] = [...PERMISSIONS];

function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function basePermissionsForRole(role: string | null | undefined): Permission[] {
  return role === "admin" ? ADMIN_BASE_PERMISSIONS : USER_BASE_PERMISSIONS;
}

export async function listUserPermissionOverrides(userId: string): Promise<Permission[]> {
  const rows = await db
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId));
  return rows.map((row) => row.permission).filter(isPermission);
}

export async function getUserEffectivePermissions(userId: string): Promise<Permission[]> {
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  const permissions = new Set<Permission>(basePermissionsForRole(user?.role));
  for (const permission of await listUserPermissionOverrides(userId)) permissions.add(permission);
  return Array.from(permissions).sort();
}

export async function setUserPermissionOverrides(userId: string, permissions: string[]): Promise<Permission[]> {
  const normalized = Array.from(new Set(permissions.filter(isPermission)));
  await db.transaction(async (tx) => {
    await tx.delete(userPermissions).where(eq(userPermissions.userId, userId));
    if (normalized.length > 0) {
      await tx.insert(userPermissions).values(normalized.map((permission) => ({ userId, permission })));
    }
  });
  return normalized;
}

export function principalHasPermission(principal: Principal, permission: Permission): boolean {
  if (principal.actorType === "system") return true;
  return principal.permissions?.includes(permission) === true;
}

export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const principal = req.principal ?? null;
    if (!principal) return res.status(401).json({ error: "Authentication required" });
    if (!principalHasPermission(principal, permission)) {
      recordPrincipalDiagnosticEvent({
        type: "permission_denied",
        path: req.path,
        method: req.method,
        requiredScope: permission,
        principalActorType: principal.actorType,
        principalUserId: principal.userId,
        principalAccountId: principal.accountId,
        isAdmin: principal.isAdmin,
      });
      return res.status(403).json({ error: "Permission required", permission });
    }
    next();
  };
}

export async function ensurePermissionSchema(): Promise<void> {
  try {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `));
    await db.execute(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_permissions_user_permission_unique ON user_permissions(user_id, permission)`));
    await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id)`));
  } catch (error) {
    log.warn("permission schema ensure failed", { error: error instanceof Error ? error.message : String(error) });
  }
}
