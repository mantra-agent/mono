import type { NextFunction, Request, Response } from "express";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { recordPrincipalDiagnosticEvent } from "./principal-diagnostics";
import { getPrincipal, hasScope, recordPrivilegedAccess, type Principal } from "./principal";

export interface SensitiveOwnerColumns {
  ownerUserId?: AnyColumn;
  principalAccountId?: AnyColumn;
}

function hasUser(principal: Principal): principal is Principal & { userId: string } {
  return typeof principal.userId === "string" && principal.userId.length > 0;
}

function hasAccount(principal: Principal): principal is Principal & { accountId: string } {
  return typeof principal.accountId === "string" && principal.accountId.length > 0;
}

export function sensitiveOwnershipValues(principal: Principal = getCurrentPrincipalOrSystem()): Record<string, string> {
  if (principal.actorType !== "user" && principal.actorType !== "system") {
    throw new Error("Service principals must choose an explicit owner before writing sensitive data");
  }
  const values: Record<string, string> = {};
  if (principal.userId) values.ownerUserId = principal.userId;
  if (principal.accountId) values.principalAccountId = principal.accountId;
  return values;
}

export function sensitiveVisiblePredicate(
  columns: SensitiveOwnerColumns,
  principal: Principal = getCurrentPrincipalOrSystem(),
): SQL {
  if (principal.actorType === "system") return sql`TRUE`;
  const predicates: SQL[] = [];
  if (hasUser(principal) && columns.ownerUserId) predicates.push(eq(columns.ownerUserId, principal.userId));
  if (hasAccount(principal) && columns.principalAccountId) predicates.push(eq(columns.principalAccountId, principal.accountId));
  if (predicates.length === 0) return sql`FALSE`;
  return or(...predicates)!;
}

export function sensitiveWritablePredicate(
  columns: SensitiveOwnerColumns,
  principal: Principal = getCurrentPrincipalOrSystem(),
): SQL {
  return sensitiveVisiblePredicate(columns, principal);
}

export function combineWithSensitiveVisible(
  columns: SensitiveOwnerColumns,
  predicate?: SQL,
  principal: Principal = getCurrentPrincipalOrSystem(),
): SQL {
  const scope = sensitiveVisiblePredicate(columns, principal);
  return predicate ? and(predicate, scope)! : scope;
}

export function combineWithSensitiveWritable(
  columns: SensitiveOwnerColumns,
  predicate?: SQL,
  principal: Principal = getCurrentPrincipalOrSystem(),
): SQL {
  const scope = sensitiveWritablePredicate(columns, principal);
  return predicate ? and(predicate, scope)! : scope;
}

export function requireAdminPrivilegedMode(scope: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const principal = getPrincipal(req);
    if (!principal || principal.actorType !== "user" || !principal.isAdmin) {
      recordPrincipalDiagnosticEvent({
        type: "privileged_mode_denied",
        path: req.path,
        method: req.method,
        reason: "not_admin_user",
        requiredScope: scope,
        principalActorType: principal?.actorType,
        principalUserId: principal?.userId,
        principalAccountId: principal?.accountId,
        isAdmin: principal?.isAdmin,
      });
      return res.status(403).json({ error: "Admin access required" });
    }
    const reason = String(req.get("x-privileged-reason") || req.body?.privilegedReason || "").trim();
    const requestedScope = String(req.get("x-privileged-scope") || req.body?.privilegedScope || "").trim();
    if (!reason || reason.length < 8) {
      recordPrincipalDiagnosticEvent({
        type: "privileged_mode_denied",
        path: req.path,
        method: req.method,
        reason: "missing_or_short_reason",
        requiredScope: scope,
        requestedScope,
        principalActorType: principal.actorType,
        principalUserId: principal.userId,
        principalAccountId: principal.accountId,
        isAdmin: principal.isAdmin,
      });
      return res.status(403).json({ error: "Privileged mode requires an explicit reason" });
    }
    if (requestedScope !== scope && requestedScope !== "*") {
      recordPrincipalDiagnosticEvent({
        type: "privileged_mode_denied",
        path: req.path,
        method: req.method,
        reason: "scope_mismatch",
        requiredScope: scope,
        requestedScope,
        principalActorType: principal.actorType,
        principalUserId: principal.userId,
        principalAccountId: principal.accountId,
        isAdmin: principal.isAdmin,
      });
      return res.status(403).json({ error: `Privileged mode requires scope ${scope}` });
    }
    if (!hasScope(principal, "admin:write") && !hasScope(principal, "admin:read")) {
      recordPrincipalDiagnosticEvent({
        type: "privileged_mode_denied",
        path: req.path,
        method: req.method,
        reason: "insufficient_admin_scope",
        requiredScope: scope,
        requestedScope,
        principalActorType: principal.actorType,
        principalUserId: principal.userId,
        principalAccountId: principal.accountId,
        isAdmin: principal.isAdmin,
      });
      return res.status(403).json({ error: "Insufficient admin scope" });
    }
    recordPrincipalDiagnosticEvent({
      type: "privileged_mode_granted",
      path: req.path,
      method: req.method,
      reason,
      requiredScope: scope,
      requestedScope,
      principalActorType: principal.actorType,
      principalUserId: principal.userId,
      principalAccountId: principal.accountId,
      isAdmin: principal.isAdmin,
    });
    await recordPrivilegedAccess({
      principal,
      action: `privileged:${scope}`,
      reason,
      metadata: { path: req.path, method: req.method, scope: requestedScope },
    });
    next();
  };
}
