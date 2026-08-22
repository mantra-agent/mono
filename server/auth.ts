import { createLogger } from "./log";
const log = createLogger("auth");

type AuthErrorCode =
  | "AUTH_SESSION_SAVE_FAILED"
  | "AUTH_SESSION_TABLE_ENSURE_FAILED"
  | "AUTH_SESSION_STORE_ERROR"
  | "AUTH_LOGIN_FAILED"
  | "AUTH_REGISTER_FAILED"
  | "AUTH_CLAIM_RESOLVE_FAILED"
  | "AUTH_CLAIM_FAILED"
  | "AUTH_PROFILE_PICTURE_UPLOAD_FAILED"
  | "AUTH_MEETING_JOIN_POLICY_READ_FAILED"
  | "AUTH_MEETING_JOIN_POLICY_UPDATE_FAILED"
  | "AUTH_ADMIN_USERS_LIST_FAILED"
  | "AUTH_ADMIN_IDENTITY_GRAPH_FAILED"
  | "AUTH_ACCOUNT_RENAME_FAILED"
  | "AUTH_ACCOUNT_STATUS_UPDATE_FAILED"
  | "AUTH_ACCOUNT_DELETE_FAILED"
  | "AUTH_IDENTITY_FOUNDATION_REPAIR_FAILED"
  | "AUTH_USER_SESSIONS_LIST_FAILED"
  | "AUTH_SESSION_DESTROY_AFTER_REVOKE_FAILED"
  | "AUTH_USER_SESSION_REVOKE_FAILED"
  | "AUTH_RESET_REQUEST_FAILED"
  | "AUTH_RESET_FAILED"
  | "AUTH_UNCLASSIFIED";

/** Upper-snake machine code for error aggregates (mirrors shared/error-callsite). */
function toAuthErrorCode(raw: unknown, fallback: AuthErrorCode): string {
  if (typeof raw !== "string" && typeof raw !== "number") return fallback;
  const code = String(raw).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const compact = code.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return /^[A-Z][A-Z0-9_]{1,47}$/.test(compact) ? compact.slice(0, 48) : fallback;
}

/**
 * Normalize auth failures into real Error instances with stable product codes.
 * Auth log.error sites historically stringified `error:` into the message object,
 * so deriveSafeErrorClassifier never saw a coded Error and SECRET_LIKE whole-
 * message rejection collapsed every AuthSession/AuthLogin line to UNCLASSIFIED.
 */
function attributableAuthError(
  error: unknown,
  code: AuthErrorCode,
): Error & { code: string } {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const coded = normalized as Error & { code: string };
  const stable = toAuthErrorCode(code, "AUTH_UNCLASSIFIED");
  if (!/^[A-Z][A-Z0-9_]{1,48}$/.test(coded.code ?? "")) coded.code = stable;
  return coded;
}

import {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { Pool } from "pg";
import { createManagedDatabasePool } from "./database-adapters";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { storage } from "./storage";
import { getSetting, setSetting } from "./system-settings";
import { getAutomationAuthBoundUserId, getAutomationAuthToken } from "./automation-auth-token";
import { isLiveRuntimeName } from "./runtime-identity";
import { createScreenshotSession } from "./screenshot-session";
import {
  accounts,
  agentInstanceMemberships,
  agentInstances,
  loginSchema,
  memberships,
  registerSchema,
  routers,
  userProfiles,
  users,
  type User,
} from "@shared/schema";
import multer from "multer";
import { getAvatarObjectPath, replaceProfileAvatar } from "./profile-avatar";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import {
  AccountLifecycleError,
  attachUserPrincipal,
  createServicePrincipal,
  createUserPrincipalFromUser,
  deleteAccountPermanently,
  ensureUserIdentityFoundation,
  resolveUserIdentityFoundation,
  getPrincipal,
  recordPrivilegedAccess,
  requirePrincipal,
  renameAccount,
  setAccountLifecycleStatus,
  setServiceSessionPrincipal,
  type Principal,
} from "./principal";
import { ACCOUNT_STATUSES, accounts, derivedInstanceStatus } from "@shared/schema";
import { PERMISSIONS, getUserEffectivePermissions, listUserPermissionOverrides, requirePermission, setUserPermissionOverrides } from "./permissions";
import { runWithPrincipal } from "./principal-context";
import { MEETING_JOIN_POLICIES, getMeetingJoinPolicy, setMeetingJoinPolicy } from "./meeting/join-policy";
import { recordPrincipalDiagnosticEvent } from "./principal-diagnostics";
import { getClientPresenceSnapshot } from "./client-presence";
import { normalizeEmailAddress } from "./email-normalization";
import { db, acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, runWithDatabaseTransaction } from "./db";
import { getPostgresErrorCode } from "./postgres-errors";
import { claimInvitedSubjectInTransaction } from "./invited-subject-service";
import { issuePasswordResetEmail } from "./password-reset";

const setupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120),
});

// Invite-authorized account claim. The onboarding token is the sole
// authorization and the sole source of the bound email — the request body
// never carries an email, so a claimant cannot bind the token to a different
// identity.
const claimSchema = z.object({
  token: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  password: z.string().min(8),
  termsAccepted: z.literal(true),
});

const deleteUserSchema = z.object({
  confirmation: z.string(),
});

const accountStatusSchema = z.object({
  status: z.enum(ACCOUNT_STATUSES),
});

const accountNameSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const deleteAccountSchema = z.object({
  confirmation: z.string(),
});

interface WaitlistApplicationRow {
  id: string;
  email: string;
  position: number;
  status: string;
  role: string;
  needs: string[];
  readiness: string;
  source: string | null;
  attribution: Record<string, unknown>;
  confirmationEmailStatus: string;
  createdAt: string;
  updatedAt: string;
}

async function getAdminUserActivity(): Promise<Map<string, string>> {
  const { db } = await import("./db");
  const result = await db.execute<{ user_id: string; last_active_at: Date | string }>(sql`
    SELECT user_id, MAX(activity_at) AS last_active_at
    FROM (
      SELECT sess->>'userId' AS user_id,
             LEAST(expire, NOW() + ${SESSION_TTL_MS} * INTERVAL '1 millisecond') - ${SESSION_TTL_MS} * INTERVAL '1 millisecond' AS activity_at
      FROM "session"
      WHERE sess->>'userId' IS NOT NULL
        AND expire > NOW()
      UNION ALL
      SELECT conversation.owner_user_id AS user_id,
             conversation.updated_at AS activity_at
      FROM conversation_messages conversation
      INNER JOIN document_store_documents chat
        ON chat.document_type = 'chat'
       AND chat.document_id = conversation.session_id
      WHERE conversation.owner_user_id IS NOT NULL
        AND conversation.payload->>'role' = 'user'
        AND COALESCE(chat.metadata->>'sessionType', 'user') = 'user'
    ) user_activity
    GROUP BY user_id
  `);
  return new Map(result.rows.map((row) => [row.user_id, new Date(row.last_active_at).toISOString()]));
}

async function getAdminUserLastLogin(): Promise<Map<string, string>> {
  const { db } = await import("./db");
  const result = await db.execute<{ user_id: string; last_login_at: Date | string }>(sql`
    SELECT sess->>'userId' AS user_id,
           MAX((sess->>'createdAt')::timestamptz) AS last_login_at
    FROM "session"
    WHERE sess->>'userId' IS NOT NULL
      AND NULLIF(BTRIM(sess->>'createdAt'), '') IS NOT NULL
    GROUP BY sess->>'userId'
  `);
  return new Map(
    result.rows
      .filter((row) => row.user_id && row.last_login_at)
      .map((row) => [row.user_id, new Date(row.last_login_at).toISOString()]),
  );
}

type IdentityInstanceMetrics = {
  managedTimerCount: number;
  claimCount: number;
  inputTokens7d: number;
};

function rowsToCountMap(
  rows: Array<{ instance_id: string | null; count: number | string | null }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (!row.instance_id) continue;
    map.set(row.instance_id, Number(row.count ?? 0));
  }
  return map;
}

/**
 * Optional admin-tree metrics. Each leg is independently fail-soft: statement
 * timeout / transient SQL must not fail the identity-graph contract (500 /
 * AUTH_ADMIN_IDENTITY_GRAPH_FAILED). Missing legs project as zero.
 */
async function loadIdentityMetricMap(
  label: "timers" | "claims" | "tokens",
  run: () => Promise<{ rows?: Array<{ instance_id: string | null; count: number | string | null }> }>,
): Promise<Map<string, number>> {
  try {
    const result = await run();
    return rowsToCountMap(result.rows ?? []);
  } catch (error) {
    const code = getPostgresErrorCode(error);
    // 57014 = statement_timeout — expected under api_calls volume; degrade.
    log.warn("identity graph instance metric degraded", {
      metric: label,
      code,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

async function getIdentityInstanceMetrics(): Promise<Map<string, IdentityInstanceMetrics>> {
  // Run legs independently so one slow aggregate cannot abort the whole graph.
  const [timers, claims, tokens] = await Promise.all([
    loadIdentityMetricMap("timers", () =>
      db.execute<{ instance_id: string; count: number }>(sql`
        SELECT m.instance_id, count(*)::int AS count
        FROM timers t
        INNER JOIN agent_instance_memberships m
          ON m.user_id = t.owner_user_id
         AND m.account_id = t.account_id
        WHERE t.scope = 'user'
          AND t.enabled = true
          AND t.owner_user_id IS NOT NULL
          AND t.account_id IS NOT NULL
        GROUP BY m.instance_id
      `),
    ),
    loadIdentityMetricMap("claims", () =>
      db.execute<{ instance_id: string; count: number }>(sql`
        SELECT instance_id, count(*)::int AS count
        FROM memory_vnext_claims
        WHERE lifecycle_stage IN ('canonical', 'linked')
          AND instance_id IS NOT NULL
        GROUP BY instance_id
      `),
    ),
    // Pre-aggregate api_calls on (owner, account) so the 7d window rides
    // idx_api_calls_owner_timestamp, then join the small membership table.
    // Direct join of every 7d row × memberships was timing out (57014).
    loadIdentityMetricMap("tokens", () =>
      db.execute<{ instance_id: string; count: number }>(sql`
        SELECT m.instance_id, COALESCE(SUM(t.tokens), 0)::bigint AS count
        FROM (
          SELECT owner_user_id, account_id, SUM(input_tokens)::bigint AS tokens
          FROM api_calls
          WHERE timestamp >= NOW() - INTERVAL '7 days'
            AND owner_user_id IS NOT NULL
            AND account_id IS NOT NULL
          GROUP BY owner_user_id, account_id
        ) t
        INNER JOIN agent_instance_memberships m
          ON m.user_id = t.owner_user_id
         AND m.account_id = t.account_id
        GROUP BY m.instance_id
      `),
    ),
  ]);
  const instanceIds = new Set([...timers.keys(), ...claims.keys(), ...tokens.keys()]);
  const map = new Map<string, IdentityInstanceMetrics>();
  for (const instanceId of instanceIds) {
    map.set(instanceId, {
      managedTimerCount: timers.get(instanceId) ?? 0,
      claimCount: claims.get(instanceId) ?? 0,
      inputTokens7d: tokens.get(instanceId) ?? 0,
    });
  }
  return map;
}

async function getWaitlistApplications(): Promise<WaitlistApplicationRow[]> {
  const { db } = await import("./db");
  try {
    const result = await db.execute<{
      id: string;
      email: string;
      position: number;
      status: string;
      role: string;
      needs: string[];
      readiness: string;
      source: string | null;
      attribution: Record<string, unknown>;
      confirmation_email_status: string;
      created_at: Date | string;
      updated_at: Date | string;
    }>(sql`
      SELECT id, email, position, status, role, needs, readiness, source,
             attribution, confirmation_email_status, created_at, updated_at
      FROM waitlist_applications
      ORDER BY position ASC
      LIMIT 1000
    `);
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      position: row.position,
      status: row.status,
      role: row.role,
      needs: row.needs,
      readiness: row.readiness,
      source: row.source,
      attribution: row.attribution,
      confirmationEmailStatus: row.confirmation_email_status,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
    /** ISO timestamp when this auth session was established (inventory). */
    createdAt?: string;
    /** Request User-Agent captured at auth (inventory). */
    userAgent?: string;
    /** Best-effort client IP captured at auth (inventory). */
    clientIp?: string;
  }
}

const PgStore = connectPgSimple(session);
const SESSION_TABLE_NAME = "session";
const SESSION_COOKIE_NAME = "connect.sid";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface UserSessionInventoryRow {
  sid: string;
  createdAt: string | null;
  lastActiveAt: string | null;
  expiresAt: string;
  userAgent: string | null;
  clientIp: string | null;
  current: boolean;
}

function readClientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || null;
  }
  if (Array.isArray(forwarded) && forwarded[0]?.trim()) {
    return forwarded[0].split(",")[0]?.trim() || null;
  }
  return req.ip?.trim() || req.socket.remoteAddress?.trim() || null;
}

function stampSessionInventoryMetadata(req: Request): void {
  if (!req.session.createdAt) {
    req.session.createdAt = new Date().toISOString();
  }
  const userAgent = req.get("user-agent");
  if (userAgent && userAgent.trim()) {
    req.session.userAgent = userAgent.trim().slice(0, 512);
  }
  const clientIp = readClientIp(req);
  if (clientIp) {
    req.session.clientIp = clientIp.slice(0, 128);
  }
}

function sessionLastActiveAt(expire: Date): string | null {
  // Rolling sessions refresh `expire` on activity, so last activity ≈ expire − TTL.
  const lastActiveMs = expire.getTime() - SESSION_TTL_MS;
  if (!Number.isFinite(lastActiveMs)) return null;
  return new Date(Math.min(lastActiveMs, Date.now())).toISOString();
}

async function listUserSessions(
  pool: Pool,
  userId: string,
  currentSessionId?: string | null,
): Promise<UserSessionInventoryRow[]> {
  const result = await pool.query<{ sid: string; sess: unknown; expire: Date }>(
    `SELECT sid, sess, expire
     FROM "session"
     WHERE sess->>'userId' = $1
       AND expire > NOW()
     ORDER BY expire DESC`,
    [userId],
  );

  return result.rows.map((row) => {
    const sess =
      row.sess && typeof row.sess === "object"
        ? (row.sess as Record<string, unknown>)
        : typeof row.sess === "string"
          ? (JSON.parse(row.sess) as Record<string, unknown>)
          : {};
    const expire = row.expire instanceof Date ? row.expire : new Date(row.expire);
    const createdAt =
      typeof sess.createdAt === "string" && sess.createdAt.trim()
        ? sess.createdAt
        : null;
    const userAgent =
      typeof sess.userAgent === "string" && sess.userAgent.trim()
        ? sess.userAgent
        : null;
    const clientIp =
      typeof sess.clientIp === "string" && sess.clientIp.trim()
        ? sess.clientIp
        : null;

    return {
      sid: row.sid,
      createdAt,
      lastActiveAt: sessionLastActiveAt(expire),
      expiresAt: expire.toISOString(),
      userAgent,
      clientIp,
      current: Boolean(currentSessionId && row.sid === currentSessionId),
    };
  });
}

async function revokeUserSession(
  pool: Pool,
  userId: string,
  sid: string,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM "session"
     WHERE sid = $1
       AND sess->>'userId' = $2`,
    [sid, userId],
  );
  return (result.rowCount ?? 0) > 0;
}
const CAPABILITY_HASH_PREFIX = "h1:";
const AUTH_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_LIMIT_MAX_KEYS = 10_000;
const authBudgets = new Map<string, { count: number; resetAt: number }>();

function capabilityDigest(token: string): string {
  if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required for capability hashing");
  return `${CAPABILITY_HASH_PREFIX}${crypto.createHmac("sha256", process.env.SESSION_SECRET).update(token).digest("hex")}`;
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
}

function enforceAuthBudget(bucket: string, limit: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (authBudgets.size >= AUTH_LIMIT_MAX_KEYS) {
      for (const [key, value] of authBudgets) if (value.resetAt <= now) authBudgets.delete(key);
      if (authBudgets.size >= AUTH_LIMIT_MAX_KEYS) authBudgets.delete(authBudgets.keys().next().value as string);
    }
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const key = `${bucket}:${req.ip}:${shortHash(email) ?? "none"}`;
    const current = authBudgets.get(key);
    const budget = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + AUTH_LIMIT_WINDOW_MS }
      : { count: current.count + 1, resetAt: current.resetAt };
    authBudgets.set(key, budget);
    if (budget.count > limit) {
      res.setHeader("Retry-After", String(Math.ceil((budget.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    next();
  };
}

function requireSameOriginForSession(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.headers.authorization?.startsWith("Bearer ")) return next();
  const isAuthMutation = req.path.startsWith("/api/auth/");
  if (!isAuthMutation && !req.session?.userId && req.session?.servicePrincipal?.actorType !== "service") return next();
  const origin = req.get("origin");
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host");
  let sameOrigin = req.get("sec-fetch-site") !== "cross-site";
  if (origin && host) {
    try { sameOrigin = new URL(origin).host === host; } catch { sameOrigin = false; }
  }
  if (!sameOrigin) return res.status(403).json({ error: "Cross-site request rejected" });
  next();
}

function shortHash(value: string | undefined): string | null {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function summarizeCookieHeader(header: string | string[] | number | undefined) {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [String(header)];
  return values.map((value) => {
    const [nameValue, ...attrs] = value.split(";").map((part) => part.trim());
    const [name] = nameValue.split("=");
    return {
      name,
      hasValue: nameValue.includes("=") && nameValue.split("=").slice(1).join("=").length > 0,
      valueHash: shortHash(nameValue.split("=").slice(1).join("=")),
      sameSite: attrs.find((attr) => attr.toLowerCase().startsWith("samesite=")) ?? null,
      secure: attrs.some((attr) => attr.toLowerCase() === "secure"),
      httpOnly: attrs.some((attr) => attr.toLowerCase() === "httponly"),
      partitioned: attrs.some((attr) => attr.toLowerCase() === "partitioned"),
      path: attrs.find((attr) => attr.toLowerCase().startsWith("path=")) ?? null,
      expires: attrs.find((attr) => attr.toLowerCase().startsWith("expires=")) ?? null,
      maxAge: attrs.find((attr) => attr.toLowerCase().startsWith("max-age=")) ?? null,
    };
  });
}

function authTrace(req: Request, event: string, details: Record<string, unknown> = {}) {
  log.verbose(() => {
    const extra = Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
    return `[AuthTrace] ${event} ${req.method} ${req.path} session=${shortHash(req.sessionID)} principal=${req.principal?.actorType ?? "none"}${extra}`;
  });
}

async function ensureSessionTable(pool: Pool) {
  log.log("[AuthSession] Ensuring PostgreSQL session table", {
    storePackage: "connect-pg-simple",
    storeClass: PgStore.name || "PGStore",
    tableName: SESSION_TABLE_NAME,
    createTableIfMissing: false,
    tableSqlResolution:
      "disabled: inline schema bootstrap avoids runtime table.sql asset dependency",
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")
  `);

  log.log("[AuthSession] PostgreSQL session table ready", {
    tableName: SESSION_TABLE_NAME,
    createTableIfMissing: false,
  });
}

function saveSession(req: Request, context: string): Promise<void> {
  log.log("[AuthSession] Saving authenticated session", {
    context,
    hasSessionId: !!req.sessionID,
    hasUserId: !!req.session.userId,
    userId: req.session.userId,
  });

  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        log.error(
          "[AuthSession] Session save failed",
          attributableAuthError(err, "AUTH_SESSION_SAVE_FAILED"),
          {
            context,
            hasSessionId: !!req.sessionID,
            hasUserId: !!req.session.userId,
            userId: req.session.userId,
          },
        );
        reject(err);
        return;
      }

      log.log("[AuthSession] Session save succeeded", {
        context,
        hasSessionId: !!req.sessionID,
        hasUserId: !!req.session.userId,
        userId: req.session.userId,
      });
      resolve();
    });
  });
}

type UserResponseName = {
  preferredName?: string | null;
  displayName?: string | null;
};

function userResponse(
  user: User,
  principal?: Principal | null,
  avatarObjectPath: string | null = null,
  names: UserResponseName = {},
) {
  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      avatarObjectPath,
      preferredName: names.preferredName ?? null,
      displayName: names.displayName ?? null,
    },
    principal: principal ? {
      actorType: principal.actorType,
      userId: principal.userId,
      accountId: principal.accountId,
      role: principal.role,
      scopes: principal.scopes,
      permissions: principal.permissions,
      isAdmin: principal.isAdmin,
      source: principal.source,
    } : null,
  };
}

async function loadUserProfileNames(userId: string): Promise<UserResponseName> {
  const [profile] = await db
    .select({
      preferredName: userProfiles.preferredName,
      displayName: userProfiles.displayName,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return {
    preferredName: profile?.preferredName ?? null,
    displayName: profile?.displayName ?? null,
  };
}

async function completeUserAuth(
  req: Request,
  res: Response,
  user: User,
  context: string,
  identityName?: string,
) {
  await ensureUserIdentityFoundation(user, { identityName });
  await resolveUserIdentityFoundation(user.id);
  await regenerateSession(req);
  delete req.session.servicePrincipal;
  req.session.userId = user.id;
  stampSessionInventoryMetadata(req);
  const principal = await attachUserPrincipal(req, user);
  const { modLifecycleService } = await import("./mods/mod-lifecycle-service");
  await runWithPrincipal(principal, () => modLifecycleService.ensureWellnessInstalled(principal));
  const { systemTimerRegistry } = await import("./system-timer-registry");
  await runWithPrincipal(principal, () => systemTimerRegistry.reconcileUserTimers(principal));
  const { timerScheduler } = await import("./timer-scheduler");
  if (timerScheduler.isRunning()) await timerScheduler.rescheduleAll();
  authTrace(req, `${context}:user-session-established`, {
    userId: user.id,
    accountId: principal.accountId,
    role: principal.role,
    clearedServicePrincipal: true,
  });
  await saveSession(req, context);
  authTrace(req, `${context}:session-saved-before-response`, { userId: user.id });
  res.on("finish", () => {
    authTrace(req, `${context}:response-finished`, {
      statusCode: res.statusCode,
      setCookie: summarizeCookieHeader(res.getHeader("set-cookie")),
    });
  });
  return principal;
}


function isDevelopmentPreviewEnvironment(): boolean {
  const values = [
    process.env.NODE_ENV,
    process.env.RAILWAY_ENVIRONMENT,
    process.env.RAILWAY_ENVIRONMENT_NAME,
    process.env.RAILWAY_STATIC_URL,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  return values.some(
    (value) =>
      value === "development" ||
      value === "dev" ||
      value.includes("development") ||
      value.includes("-dev") ||
      value.includes("dev-"),
  );
}

/** @deprecated Headless browser auth now uses direct DB session injection via createScreenshotSession in browser-manager.ts. This function is only kept for the deprecated /api/auth/automation-login endpoint. */
async function establishSignedPreviewSession(_req: Request, _res: Response, _returnTo: string): Promise<void> {
  throw new Error("Deprecated: use createScreenshotSession for headless browser auth");
}

type PrincipalResolution =
  | { kind: "existing"; principal: Principal }
  | { kind: "user"; principal: Principal }
  | { kind: "service"; principal: Principal }
  | { kind: "missing"; reason: "missing_session" }
  | { kind: "invalid"; reason: "session_user_not_found" };

async function resolveRequestPrincipal(req: Request): Promise<PrincipalResolution> {
  if (req.principal) return { kind: "existing", principal: req.principal };

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7);
    if (bearerToken.length >= 32) {
      try {
        const storedToken = await getAutomationAuthToken();
        if (storedToken && bearerToken.length === storedToken.length) {
          const a = Buffer.from(bearerToken);
          const b = Buffer.from(storedToken);
          if (crypto.timingSafeEqual(a, b)) {
            setServiceSessionPrincipal(req, "automation bearer token", undefined, ["system:read"]);
            await recordPrivilegedAccess({
              principal: req.principal!,
              action: "automation_bearer_service_principal",
              reason: "automation bearer token",
              metadata: { path: req.path, method: req.method },
            });
            return { kind: "service", principal: req.principal! };
          }
        }
      } catch (error) {
        log.warn("Bearer automation principal resolution failed", {
          path: req.path,
          method: req.method,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (req.session.userId) {
    const user = await storage.getUser(req.session.userId);
    if (!user) return { kind: "invalid", reason: "session_user_not_found" };
    if (req.session.servicePrincipal) {
      authTrace(req, "resolve-principal:clearing-stale-service-principal", { userId: user.id });
      delete req.session.servicePrincipal;
    }
    try {
      const principal = await attachUserPrincipal(req, user);
      return { kind: "user", principal };
    } catch (error) {
      if (error instanceof AccountLifecycleError) {
        return { kind: "invalid", reason: error.code };
      }
      throw error;
    }
  }

  if (req.session.servicePrincipal?.actorType === "service") {
    const principal = createServicePrincipal(
      req.session.servicePrincipal.scopes,
      req.session.servicePrincipal.permissions ?? [],
    );
    req.principal = principal;
    return { kind: "service", principal };
  }

  return { kind: "missing", reason: "missing_session" };
}

export function setupAuth(app: Express) {
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  const pool = createManagedDatabasePool("auth-session", {
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    application_name: "mantra-auth-session",
  }).pool;

  const capabilityMigrationReady = (async () => {
    for (const user of await storage.getUsers()) {
      const updates: Partial<Omit<User, "id">> = {};
      if (user.inviteToken && !user.inviteToken.startsWith(CAPABILITY_HASH_PREFIX)) updates.inviteToken = capabilityDigest(user.inviteToken);
      if (user.resetToken && !user.resetToken.startsWith(CAPABILITY_HASH_PREFIX)) updates.resetToken = capabilityDigest(user.resetToken);
      if (Object.keys(updates).length) await storage.updateUser(user.id, updates);
    }
  })();

  const sessionTableReady = Promise.all([ensureSessionTable(pool), capabilityMigrationReady]).catch((error) => {
    log.error(
      "[AuthSession] Failed to ensure PostgreSQL session table",
      attributableAuthError(error, "AUTH_SESSION_TABLE_ENSURE_FAILED"),
      {
        tableName: SESSION_TABLE_NAME,
        createTableIfMissing: false,
      },
    );
    throw error;
  });

  const sessionStore = new PgStore({
    pool,
    tableName: SESSION_TABLE_NAME,
    createTableIfMissing: false,
    errorLog: (...args: unknown[]) => {
      const firstError = args.find((arg) => arg instanceof Error) ?? args[0];
      log.error(
        "[AuthSession] connect-pg-simple error",
        attributableAuthError(firstError, "AUTH_SESSION_STORE_ERROR"),
        ...args.filter((arg) => arg !== firstError),
      );
    },
  });

  log.log("[AuthSession] Configured PostgreSQL session store", {
    storePackage: "connect-pg-simple",
    storeClass: sessionStore.constructor?.name || PgStore.name || "PGStore",
    tableName: SESSION_TABLE_NAME,
    createTableIfMissing: false,
    tableSqlResolution: "not required; createTableIfMissing=false",
  });

  const sessionMiddleware = session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    // Idle window, not wall-clock from login. Inventory last-active is expire − TTL.
    rolling: true,
    cookie: {
      maxAge: SESSION_TTL_MS,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      // partitioned (CHIPS) is for third-party iframe cookies.
      // WKWebView loads the server as first-party, and silently
      // drops Partitioned cookies — breaking all auth on iOS.
      partitioned: false,
    },
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/voice/llm/")) {
      return next();
    }
    sessionTableReady
      .then(() => sessionMiddleware(req, res, next))
      .catch((error) => {
        next(error);
      });
  });

  app.use(requireSameOriginForSession);

  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api") || req.path.startsWith("/api/voice/llm/")) {
      return next();
    }

    resolveRequestPrincipal(req)
      .then((resolution) => {
        if ("principal" in resolution && resolution.principal) {
          // Wrap downstream handlers in principal context so
          // requireCurrentPrincipal() returns the real user principal
          // instead of falling back to system (which bypasses all scoping).
          runWithPrincipal(resolution.principal, () => next());
        } else {
          next();
        }
      })
      .catch((error) => {
        log.warn("Passive principal hydration failed", {
          path: req.path,
          method: req.method,
          error: error instanceof Error ? error.message : String(error),
        });
        next();
      });
  });

  app.post("/api/auth/login", enforceAuthBudget("login", 8), async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid email or password format" });
      }

      const email = normalizeEmailAddress(parsed.data.email);
      const { password } = parsed.data;
      authTrace(req, "login:start", { emailHash: shortHash(email) });
      const user = await storage.getUserByEmail(email);
      if (!user) {
        authTrace(req, "login:user-not-found", { emailHash: shortHash(email) });
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const valid = await bcrypt.compare(password, user.password);
      authTrace(req, "login:password-checked", {
        emailHash: shortHash(email),
        userId: user.id,
        valid,
      });
      if (!valid) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const principal = await completeUserAuth(req, res, user, "login");
      res.json(userResponse(user, principal));
    } catch (error: any) {
      if (error instanceof AccountLifecycleError) {
        return res.status(403).json({ error: error.message, code: error.code });
      }
      log.error(
        "[AuthLogin] Login failed",
        attributableAuthError(error, "AUTH_LOGIN_FAILED"),
        {
          emailHash:
            typeof req.body?.email === "string"
              ? shortHash(req.body.email.trim().toLowerCase())
              : undefined,
        },
      );
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: "Logout failed" });
      res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" });
      res.json({ ok: true });
    });
  });

  /** @deprecated Headless browser auth now uses direct DB session injection via createScreenshotSession. */
  app.get("/api/auth/automation-login", (_req: Request, res: Response) => {
    res.status(410).json({ deprecated: true, message: "Use createScreenshotSession for headless auth" });
  });

  /**
   * Stage-only: exchange the automation bearer for a 120s user `connect.sid`.
   * Live is 404. Bound user is admin-configured; the caller cannot name one.
   * Bearer stays a service principal on every other route.
   */
  app.post("/api/auth/automation-session", enforceAuthBudget("automation-session", 20), async (req: Request, res: Response) => {
    if (isLiveRuntimeName()) {
      return res.status(404).json({ error: "Not found" });
    }
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Automation bearer required" });
    }
    const bearerToken = authHeader.slice(7);
    try {
      const storedToken = await getAutomationAuthToken();
      if (!storedToken || bearerToken.length !== storedToken.length) {
        return res.status(401).json({ error: "Invalid automation bearer" });
      }
      const a = Buffer.from(bearerToken);
      const b = Buffer.from(storedToken);
      if (!crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: "Invalid automation bearer" });
      }
      const boundUserId = await getAutomationAuthBoundUserId();
      if (!boundUserId) {
        return res.status(503).json({ error: "Automation user is not bound" });
      }
      const user = await storage.getUser(boundUserId);
      if (!user) {
        return res.status(503).json({ error: "Automation bound user is missing" });
      }
      await resolveUserIdentityFoundation(user.id);
      const minted = await createScreenshotSession(user.id);
      await recordPrivilegedAccess({
        principal: createServicePrincipal(["service:automation"], ["system:read"]),
        action: "automation_session_exchange",
        reason: "stage smoke user cookie",
        metadata: { path: req.path, method: req.method, boundUserId: user.id },
      });
      res.cookie(SESSION_COOKIE_NAME, minted.signedCookie, {
        httpOnly: true,
        secure: req.secure || req.get("x-forwarded-proto") === "https",
        sameSite: "lax",
        maxAge: 120_000,
        path: "/",
      });
      return res.json({ ok: true });
    } catch (error) {
      if (error instanceof AccountLifecycleError) {
        return res.status(403).json({ error: error.message, code: error.code });
      }
      log.warn("Automation session exchange failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(500).json({ error: "Automation session exchange failed" });
    }
  });

  app.get("/api/auth/me", requireAuth, async (req: Request, res: Response) => {
    authTrace(req, "me:after-require-auth");
    const principal = getPrincipal(req);
    if (!principal?.userId) {
      authTrace(req, "me:missing-user-principal");
      return res.status(401).json({ error: "User session required" });
    }
    const user = await storage.getUser(principal.userId);
    if (!user) {
      authTrace(req, "me:user-not-found", { principalUserId: principal.userId });
      req.session.destroy(() => {});
      return res.status(401).json({ error: "User not found" });
    }
    const [avatarObjectPath, names] = await Promise.all([
      getAvatarObjectPath(principal),
      loadUserProfileNames(user.id),
    ]);
    authTrace(req, "me:success", { userId: user.id });
    res.json(userResponse(user, principal, avatarObjectPath, names));
  });

  app.post("/api/auth/setup", enforceAuthBudget("setup", 5), async (req: Request, res: Response) => {
    try {
      const count = await storage.getUserCount();
      if (count > 0) {
        return res.status(403).json({ error: "Setup already completed" });
      }

      const parsed = setupSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: "Invalid setup data",
            details: parsed.error.flatten(),
          });
      }
      const email = normalizeEmailAddress(parsed.data.email);
      const { password, name } = parsed.data;

      const hashed = await bcrypt.hash(password, 12);
      const authenticatedUser = await storage.createInitialAdmin({ email, password: hashed });
      if (!authenticatedUser) return res.status(403).json({ error: "Setup already completed" });
      const principal = await completeUserAuth(req, res, authenticatedUser, "setup", name);
      res.json(userResponse(authenticatedUser, principal));
    } catch (error: any) {
      if (error.message?.includes("unique")) {
        return res
          .status(400)
          .json({ error: "Email already exists" });
      }
      res.status(500).json({ error: "Setup failed" });
    }
  });

  app.post(
    "/api/auth/invite",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        if (typeof req.body?.email !== "string") {
          return res.status(400).json({ error: "Email is required" });
        }
        const email = normalizeEmailAddress(req.body.email);

        const existing = await storage.getUserByEmail(email);
        if (existing) {
          return res
            .status(400)
            .json({ error: "User with this email already exists" });
        }

        const token = crypto.randomBytes(32).toString("hex");
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        const hashedPlaceholder = await bcrypt.hash(token, 12);
        const user = await storage.createUser({
          email,
          password: hashedPlaceholder,
        });
        await setUserPermissionOverrides(user.id, []);
        await storage.updateUser(user.id, {
          inviteToken: capabilityDigest(token),
          inviteExpires: expires,
        });

        res.json({ token, email, expiresAt: expires.toISOString() });
      } catch (error: any) {
        res.status(500).json({ error: "Failed to create invite" });
      }
    },
  );

  app.get("/api/auth/invite/:token", enforceAuthBudget("invite-verify", 20), async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserByInviteToken(capabilityDigest(req.params.token as string));
      if (!user || !user.inviteExpires || user.inviteExpires < new Date()) {
        return res.status(404).json({ error: "Invalid or expired invite" });
      }
      res.json({ email: user.email });
    } catch {
      res.status(500).json({ error: "Failed to verify invite" });
    }
  });

  app.post("/api/auth/register", enforceAuthBudget("register", 8), async (req: Request, res: Response) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: "Invalid registration data",
            details: parsed.error.flatten(),
          });
      }

      const email = normalizeEmailAddress(parsed.data.email);
      const { password, inviteToken, name } = parsed.data;

      const hashed = await bcrypt.hash(password, 12);
      const passwordSignupAt = new Date();
      let user;

      if (inviteToken) {
        const invitedUser = await storage.getUserByInviteToken(capabilityDigest(inviteToken));
        if (!invitedUser || !invitedUser.inviteExpires || invitedUser.inviteExpires < new Date()) {
          return res.status(400).json({ error: "Invalid or expired invite" });
        }

        if (normalizeEmailAddress(invitedUser.email) !== email) {
          return res.status(400).json({ error: "Email does not match invite" });
        }

        user = await db.transaction(async tx => {
          const [registeredUser] = await tx.update(users).set({
            email,
            password: hashed,
            passwordSignupAt,
            inviteToken: null,
            inviteExpires: null,
          }).where(eq(users.id, invitedUser.id)).returning();
          if (!registeredUser) throw new Error("Registration user update produced no row");
          await claimInvitedSubjectInTransaction(tx, registeredUser);
          return registeredUser;
        });
      } else {
        if (process.env.PUBLIC_REGISTRATION_ENABLED !== "true") return res.status(403).json({ error: "An invitation is required" });
        user = await db.transaction(async tx => {
          const [registeredUser] = await tx.insert(users).values({ email, password: hashed, passwordSignupAt }).returning();
          if (!registeredUser) throw new Error("Registration user creation produced no row");
          return registeredUser;
        });
      }

      const principal = await completeUserAuth(req, res, user, "register", name);
      res.json(userResponse(user, principal));
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(
        "[AuthRegister] Registration failed",
        attributableAuthError(error, "AUTH_REGISTER_FAILED"),
        {
          emailHash:
            typeof req.body?.email === "string"
              ? shortHash(req.body.email.trim().toLowerCase())
              : undefined,
        },
      );
      if (message.includes("unique") || message.includes("duplicate key")) {
        return res.status(400).json({ error: "Email already exists" });
      }
      res.status(500).json({ error: "Registration failed" });
    }
  });

  /**
   * POST /api/auth/claim/resolve
   *
   * Pure-read prefill for the account-claim modal. Mirrors the claim route's
   * authorization guard (canonical resolveOnboardingToken; fail closed unless
   * status="resolved" + accountState="provisional") but performs NO identity
   * mutation. Returns the token-bound email — locked in the claim form so a
   * claimant cannot rebind the token to a different identity — plus the
   * attendee display name for prefill. A real account => 409 so the client
   * routes the recipient to login instead of the claim form.
   */
  app.post("/api/auth/claim/resolve", enforceAuthBudget("claim-resolve", 20), async (req: Request, res: Response) => {
    try {
      const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
      if (!token || token.length > 200) {
        return res.status(400).json({ error: "Invalid claim token" });
      }
      const { resolveOnboardingToken } = await import("./meeting/distribution");
      const resolution = await resolveOnboardingToken(token);
      if (resolution.status !== "resolved") {
        return res.status(404).json({ error: "This invitation is no longer valid" });
      }
      if (resolution.accountState !== "provisional") {
        return res.status(409).json({
          error: "An account already exists for this invitation. Please log in.",
          email: resolution.email,
        });
      }
      const email = normalizeEmailAddress(resolution.email);
      // resolveOnboardingToken falls back to the email when no attendee name is
      // known; only surface a real name so the form never seeds the name field
      // with an email address.
      const displayName = resolution.displayName && resolution.displayName !== email
        ? resolution.displayName
        : "";
      res.json({ email, displayName, meetingTitle: resolution.meetingTitle });
    } catch (error) {
      log.error(
        "[AuthClaim] Claim resolve failed",
        attributableAuthError(error, "AUTH_CLAIM_RESOLVE_FAILED"),
      );
      res.status(500).json({ error: "Could not resolve invitation" });
    }
  });

  /**
   * POST /api/auth/claim
   *
   * Invite-authorized account claim for a meeting-recap recipient. The
   * onboarding token is the authorization (NOT public registration): it is
   * re-resolved through the canonical read path and must resolve to a
   * provisional (unclaimed) recipient. On success the provisional identity is
   * promoted into a real authenticated User — recap access (preserved by email
   * identity), live object grants, and Action Item ownership all move to the
   * new User — and an authenticated session is returned. No email round-trip;
   * PUBLIC_REGISTRATION_ENABLED is irrelevant here.
   *
   * Security invariants:
   *  - Fail closed unless the token resolves to status="resolved" +
   *    accountState="provisional". A real account => 409 (log in instead).
   *  - Email is derived ONLY from the token, never the request body.
   *  - Explicit Terms acceptance is required by the strict request schema at
   *    this canonical account-creation boundary; client state alone is never
   *    authoritative.
   *  - The whole promotion is serialized on the recipient email via the
   *    INVITED_SUBJECT advisory lock and re-checks for an existing user inside
   *    the lock, so a double-submit can neither create two users nor
   *    double-rebind grants (replay-safe / idempotent: first claim wins, later
   *    submits get 409 without touching the existing account or its password).
   */
  app.post("/api/auth/claim", enforceAuthBudget("claim", 8), async (req: Request, res: Response) => {
    try {
      const parsed = claimSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid claim data", details: parsed.error.flatten() });
      }
      const { token, name, password } = parsed.data;
      const displayName = name.trim().replace(/\s+/g, " ").slice(0, 120);

      // 1. Re-resolve via the canonical pure-read path. Dynamic import avoids
      //    any module-load cycle between auth and the meeting subsystem.
      const { resolveOnboardingToken } = await import("./meeting/distribution");
      const resolution = await resolveOnboardingToken(token);
      if (resolution.status !== "resolved") {
        return res.status(404).json({ error: "This invitation is no longer valid" });
      }
      if (resolution.accountState !== "provisional") {
        // A real account already owns this email. The token cannot set its
        // password; the recipient must authenticate through login.
        return res.status(409).json({
          error: "An account already exists for this invitation. Please log in.",
          email: resolution.email,
        });
      }

      const email = normalizeEmailAddress(resolution.email);
      const hashed = await bcrypt.hash(password, 12);
      const passwordSignupAt = new Date();

      // 2-3. Atomically create the real user, establish its Personal identity
      //      foundation, rebind provisional grants, and materialize the recap
      //      Meeting/People projection. Serialized on recipient email plus the
      //      projection key so any failure rolls back the complete claim.
      const claimResult = await db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
        await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.INVITED_SUBJECT, email);

        const [existingUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(sql`LOWER(BTRIM(${users.email})) = ${email}`)
          .limit(1);
        if (existingUser) {
          return { alreadyClaimed: true as const };
        }

        const [createdUser] = await tx
          .insert(users)
          .values({ email, password: hashed, passwordSignupAt })
          .returning();
        if (!createdUser) throw new Error("Claim user creation produced no row");
        const rebind = await claimInvitedSubjectInTransaction(tx, createdUser);
        const foundation = await ensureUserIdentityFoundation(createdUser, { identityName: displayName });
        const recipientPrincipal = createUserPrincipalFromUser({
          ...createdUser,
          activeVaultId: foundation.activeVaultId,
          visibleVaultIds: foundation.visibleVaultIds,
        }, foundation.accountId, foundation.instanceId);
        const { materializeAuthenticatedRecipientRecap } = await import("./meeting/recipient-materialization");
        const materializedRecap = await runWithPrincipal(
          recipientPrincipal,
          () => materializeAuthenticatedRecipientRecap(token, email),
        );
        if (!materializedRecap) throw new Error("Claimed recipient recap could not be materialized");
        return { alreadyClaimed: false as const, user: createdUser, rebind, materializedRecap };
      }));

      if (claimResult.alreadyClaimed) {
        // A prior/concurrent claim already promoted this email. Never create a
        // second user or reset the existing account's password.
        return res.status(409).json({
          error: "An account already exists for this invitation. Please log in.",
          email,
        });
      }

      // 4. Establish the authenticated session for the new principal. This also
      //    ensures the identity foundation (account, membership, profile rows).
      const principal = await completeUserAuth(req, res, claimResult.user, "claim", displayName);

      log.info("[AuthClaim] Provisional recipient claimed account", {
        userId: claimResult.user.id,
        reboundGrantCount: claimResult.rebind.reboundGrantCount,
        reboundAssignmentCount: claimResult.rebind.reboundAssignmentCount,
      });

      res.json(userResponse(claimResult.user, principal));
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(
        "[AuthClaim] Claim failed",
        attributableAuthError(error, "AUTH_CLAIM_FAILED"),
      );
      if (message.includes("unique") || message.includes("duplicate key")) {
        return res.status(409).json({ error: "An account already exists for this invitation. Please log in." });
      }
      if (message.includes("already claimed by another user")) {
        return res.status(409).json({ error: "This invitation has already been claimed." });
      }
      res.status(500).json({ error: "Claim failed" });
    }
  });

  app.post(
    "/api/auth/reset-request",
    requireAuth,
    enforceAuthBudget("reset-request", 5),
    async (req: Request, res: Response) => {
      try {
        const principal = getPrincipal(req);
        if (!principal?.userId) {
          return res.status(401).json({ error: "User session required" });
        }
        const user = await storage.getUser(principal.userId);
        if (!user?.email) {
          return res.status(400).json({ error: "No email is on file for this account" });
        }

        const result = await issuePasswordResetEmail(user);
        if (!result.ok || !result.emailed) {
          return res.status(500).json({ error: "Reset email could not be sent" });
        }
        res.json({ ok: true });
      } catch (error) {
        log.error(
          "Reset password request failed",
          attributableAuthError(error, "AUTH_RESET_REQUEST_FAILED"),
        );
        res.status(500).json({ error: "Reset email could not be sent" });
      }
    },
  );

  // Public forgot-password: same issuer + consume path as authenticated reset.
  // Always returns { ok: true } so the response never reveals whether an account exists.
  app.post(
    "/api/auth/forgot-password",
    enforceAuthBudget("forgot-password", 5),
    async (req: Request, res: Response) => {
      try {
        const emailRaw = typeof req.body?.email === "string" ? req.body.email.trim() : "";
        if (emailRaw) {
          let email: string | null = null;
          try {
            email = normalizeEmailAddress(emailRaw);
          } catch {
            email = null;
          }
          if (email) {
            const user = await storage.getUserByEmail(email);
            if (user) {
              await issuePasswordResetEmail(user);
            }
          }
        }
        res.json({ ok: true });
      } catch (error) {
        log.error(
          "Forgot password request failed",
          attributableAuthError(error, "AUTH_FORGOT_PASSWORD_FAILED"),
        );
        // Enumeration-safe: still acknowledge.
        res.json({ ok: true });
      }
    },
  );

  app.get("/api/auth/reset/:token", enforceAuthBudget("reset-verify", 20), async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserByResetToken(capabilityDigest(req.params.token as string));
      if (!user || !user.resetExpires || user.resetExpires < new Date()) {
        return res.status(404).json({ error: "Invalid or expired reset link" });
      }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "Failed to verify reset token" });
    }
  });

  app.post("/api/auth/reset", enforceAuthBudget("reset", 8), async (req: Request, res: Response) => {
    try {
      const { token, password } = req.body;
      if (!token || !password)
        return res
          .status(400)
          .json({ error: "Token and password are required" });
      if (password.length < 8)
        return res
          .status(400)
          .json({ error: "Password must be at least 8 characters" });

      const user = await storage.getUserByResetToken(capabilityDigest(token));
      if (!user || !user.resetExpires || user.resetExpires < new Date()) {
        return res.status(400).json({ error: "Invalid or expired reset link" });
      }

      const hashed = await bcrypt.hash(password, 12);
      await storage.updateUser(user.id, {
        password: hashed,
        resetToken: null,
        resetExpires: null,
      });
      await pool.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [user.id]);

      res.json({ ok: true });
    } catch (error) {
      log.error(
        "Password reset failed",
        attributableAuthError(error, "AUTH_RESET_FAILED"),
      );
      res.status(500).json({ error: "Password reset failed" });
    }
  });

  app.patch(
    "/api/auth/profile",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { email } = req.body;
        const updates: Record<string, string> = {};
        if (email && typeof email === "string" && email.trim().length > 0) {
          updates.email = email.trim();
        }
        if (Object.keys(updates).length === 0) {
          return res.status(400).json({ error: "No valid fields to update" });
        }
        const principal = getPrincipal(req);
        if (!principal?.userId)
          return res.status(401).json({ error: "User session required" });
        const updated = await storage.updateUser(principal.userId, updates);
        if (!updated) return res.status(404).json({ error: "User not found" });
        res.json({
          id: updated.id,
          email: updated.email,
          role: updated.role,
        });
      } catch {
        res.status(500).json({ error: "Failed to update profile" });
      }
    },
  );

  const profilePictureUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  });

  app.post("/api/auth/profile-picture", requireAuth, (req: Request, res: Response) => {
    profilePictureUpload.single("file")(req, res, async (uploadError) => {
      if (uploadError) return res.status(400).json({ error: "Image must be 5 MB or smaller" });
      if (!req.file) return res.status(400).json({ error: "Choose an image to upload" });
      const principal = getPrincipal(req);
      if (!principal?.userId || !principal.accountId) return res.status(401).json({ error: "User session required" });
      try {
        const avatarObjectPath = await replaceProfileAvatar(principal, req.file.buffer, req.file.mimetype);
        res.json({ avatarObjectPath });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Profile picture upload failed";
        if (message.includes("image") || message.includes("Image")) return res.status(400).json({ error: message });
        log.error(
          "Profile picture upload failed",
          attributableAuthError(error, "AUTH_PROFILE_PICTURE_UPLOAD_FAILED"),
          { errorType: error instanceof Error ? error.name : typeof error },
        );
        res.status(500).json({ error: "Profile picture upload failed" });
      }
    });
  });

  app.post(
    "/api/auth/change-password",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
          return res
            .status(400)
            .json({ error: "Current and new passwords are required" });
        }
        if (newPassword.length < 8) {
          return res
            .status(400)
            .json({ error: "New password must be at least 8 characters" });
        }

        const principal = getPrincipal(req);
        if (!principal?.userId)
          return res.status(401).json({ error: "User session required" });
        const user = await storage.getUser(principal.userId);
        if (!user) return res.status(401).json({ error: "Not authenticated" });

        const valid = await bcrypt.compare(currentPassword, user.password);
        if (!valid)
          return res
            .status(401)
            .json({ error: "Current password is incorrect" });

        const hashed = await bcrypt.hash(newPassword, 12);
        await storage.updateUser(user.id, { password: hashed });
        await pool.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [user.id]);
        const refreshedPrincipal = await completeUserAuth(req, res, user, "change-password");
        res.json({ ok: true, principal: userResponse(user, refreshedPrincipal).principal });
      } catch {
        res.status(500).json({ error: "Failed to change password" });
      }
    },
  );

  // ---- UI Preferences (per-user, stored in system_settings) ----

  app.get(
    "/api/auth/ui-prefs",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const principal = getPrincipal(req);
        if (!principal?.userId)
          return res.status(401).json({ error: "User session required" });
        const [scale, voiceCaptions] = await Promise.all([
          getSetting<number>(`user:${principal.userId}:ui.scale`),
          getSetting<boolean>(`user:${principal.userId}:voice.captions`),
        ]);
        res.json({ scale: scale ?? 110, voiceCaptions: voiceCaptions ?? true });
      } catch {
        res.status(500).json({ error: "Failed to read UI preferences" });
      }
    },
  );

  app.patch(
    "/api/auth/ui-prefs",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const principal = getPrincipal(req);
        if (!principal?.userId)
          return res.status(401).json({ error: "User session required" });
        const { scale, voiceCaptions } = req.body;
        const updates: Array<Promise<void>> = [];
        if (typeof scale === "number" && scale >= 90 && scale <= 120) {
          updates.push(setSetting(`user:${principal.userId}:ui.scale`, scale));
        }
        if (typeof voiceCaptions === "boolean") {
          updates.push(setSetting(`user:${principal.userId}:voice.captions`, voiceCaptions));
        }
        await Promise.all(updates);
        const [savedScale, savedVoiceCaptions] = await Promise.all([
          getSetting<number>(`user:${principal.userId}:ui.scale`),
          getSetting<boolean>(`user:${principal.userId}:voice.captions`),
        ]);
        res.json({ scale: savedScale ?? 110, voiceCaptions: savedVoiceCaptions ?? true });
      } catch {
        res.status(500).json({ error: "Failed to update UI preferences" });
      }
    },
  );

  // ---- Meeting agent join policy (per-user) ----

  app.get(
    "/api/auth/meeting-join-policy",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const principal = getPrincipal(req);
        if (!principal?.userId) {
          return res.status(401).json({ error: "User session required" });
        }
        const policy = await getMeetingJoinPolicy(principal.userId);
        res.json({ policy, options: MEETING_JOIN_POLICIES });
      } catch (error) {
        log.error(
          "Failed to read meeting join policy",
          attributableAuthError(error, "AUTH_MEETING_JOIN_POLICY_READ_FAILED"),
        );
        res.status(500).json({ error: "Failed to read meeting join policy" });
      }
    },
  );

  app.put(
    "/api/auth/meeting-join-policy",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const principal = getPrincipal(req);
        if (!principal?.userId) {
          return res.status(401).json({ error: "User session required" });
        }
        const parsed = z.enum(MEETING_JOIN_POLICIES).safeParse(req.body?.policy);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid meeting join policy" });
        }
        await setMeetingJoinPolicy(principal.userId, parsed.data);
        res.json({ policy: parsed.data });
      } catch (error) {
        log.error(
          "Failed to update meeting join policy",
          attributableAuthError(error, "AUTH_MEETING_JOIN_POLICY_UPDATE_FAILED"),
        );
        res.status(500).json({ error: "Failed to update meeting join policy" });
      }
    },
  );

  app.get(
    "/api/auth/users",
    requireAuth,
    requirePermission("users:read"),
    async (_req: Request, res: Response) => {
      try {
        const allUsers = await storage.getUsers();
        const [lastActiveByUser, lastLoginByUser, waitlist] = await Promise.all([
          getAdminUserActivity(),
          getAdminUserLastLogin(),
          getWaitlistApplications(),
        ]);
        const rows = await Promise.all(allUsers.map(async (u) => {
          let identityAccountId: string | null = null;
          let identityIncomplete = false;
          try {
            identityAccountId = (await resolveUserIdentityFoundation(u.id)).accountId;
          } catch (err) {
            if (err instanceof AccountLifecycleError) {
              identityAccountId = null;
            } else {
              identityIncomplete = true;
              log.warn("admin users list: identity foundation missing, returning degraded row", {
                userId: u.id,
                email: u.email,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          return {
            id: u.id,
            email: u.email,
            role: u.role,
            createdAt: u.createdAt,
            lastActiveAt: lastActiveByUser.get(u.id) ?? null,
            lastLoginAt: lastLoginByUser.get(u.id) ?? null,
            hasPendingInvite: !!u.inviteToken,
            permissionOverrides: await listUserPermissionOverrides(u.id),
            permissions: await getUserEffectivePermissions(u.id),
            presence: identityAccountId ? getClientPresenceSnapshot(identityAccountId).clients : [],
            identityIncomplete,
          };
        }));
        res.json({ users: rows, waitlist, availablePermissions: PERMISSIONS });
      } catch (err) {
        log.error(
          "Failed to fetch users for admin list",
          attributableAuthError(err, "AUTH_ADMIN_USERS_LIST_FAILED"),
        );
        res.status(500).json({ error: "Failed to fetch users" });
      }
    },
  );

  /**
   * Super-admin identity graph for Accounts / Agents / Users Hierarchy Trees.
   * Same users:read gate as /api/auth/users. Returns the four-noun graph edges
   * needed to project each index without a second inspector.
   */
  app.get(
    "/api/auth/identity-graph",
    requireAuth,
    requirePermission("users:read"),
    async (_req: Request, res: Response) => {
      try {
        const [accountRows, membershipRows, instanceRows, instanceMembershipRows, userRows, instanceMetrics, lastActiveByUser, routerRows] = await Promise.all([
          db.select({
            id: accounts.id,
            name: accounts.name,
            kind: accounts.kind,
            status: accounts.status,
            ownerUserId: accounts.ownerUserId,
            routerId: accounts.routerId,
            includedTokens: accounts.includedTokens,
            grantedTokens: accounts.grantedTokens,
            usagePeriod: accounts.usagePeriod,
            periodTokens: accounts.periodTokens,
            emittedOverageTokens: accounts.emittedOverageTokens,
            usageStatus: accounts.usageStatus,
            usageProjectionState: accounts.usageProjectionState,
            usageProjectedAt: accounts.usageProjectedAt,
            createdAt: accounts.createdAt,
            updatedAt: accounts.updatedAt,
          }).from(accounts).orderBy(asc(accounts.name), asc(accounts.id)),
          db.select({
            accountId: memberships.accountId,
            userId: memberships.userId,
            role: memberships.role,
          }).from(memberships),
          db.select({
            id: agentInstances.id,
            accountId: agentInstances.accountId,
            name: agentInstances.name,
            status: agentInstances.status,
            createdByUserId: agentInstances.createdByUserId,
            quarantineReason: agentInstances.quarantineReason,
            createdAt: agentInstances.createdAt,
            updatedAt: agentInstances.updatedAt,
          }).from(agentInstances).orderBy(asc(agentInstances.name), asc(agentInstances.id)),
          db.select({
            instanceId: agentInstanceMemberships.instanceId,
            accountId: agentInstanceMemberships.accountId,
            userId: agentInstanceMemberships.userId,
            role: agentInstanceMemberships.role,
          }).from(agentInstanceMemberships),
          db.select({
            id: users.id,
            email: users.email,
            role: users.role,
            createdAt: users.createdAt,
            onboardingStatus: userProfiles.onboardingStatus,
          }).from(users)
            .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
            .orderBy(asc(users.email), asc(users.id)),
          getIdentityInstanceMetrics(),
          getAdminUserActivity(),
          db.select({
            id: routers.id,
            name: routers.name,
            isDefault: routers.isDefault,
          }).from(routers),
        ]);
        let billingByAccount = new Map<string, import("@shared/billing").AccountBillingSummary>();
        try {
          const { listAccountBillingSummaries } = await import("./billing-service");
          billingByAccount = await listAccountBillingSummaries(accountRows.map((account) => account.id));
        } catch (error) {
          log.warn("identity graph billing projection unavailable", {
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const routersById = new Map(routerRows.map((row) => [row.id, row]));
        const memberIdsByAccount = new Map<string, string[]>();
        for (const membership of membershipRows) {
          const list = memberIdsByAccount.get(membership.accountId) ?? [];
          list.push(membership.userId);
          memberIdsByAccount.set(membership.accountId, list);
        }

        res.json({
          accounts: accountRows.map((account) => {
            const memberIds = memberIdsByAccount.get(account.id) ?? [];
            if (account.ownerUserId && !memberIds.includes(account.ownerUserId)) {
              memberIds.push(account.ownerUserId);
            }
            let lastActiveAt: string | null = null;
            for (const userId of memberIds) {
              const at = lastActiveByUser.get(userId);
              if (at && (!lastActiveAt || at > lastActiveAt)) lastActiveAt = at;
            }
            const router = account.routerId ? routersById.get(account.routerId) ?? null : null;
            return {
              ...account,
              lastActiveAt,
              router: router
                ? { id: router.id, name: router.name, isDefault: router.isDefault === true }
                : null,
              billing: billingByAccount.get(account.id) ?? null,
            };
          }),
          memberships: membershipRows,
          instances: instanceRows.map((instance) => {
            const metrics = instanceMetrics.get(instance.id);
            const account = accountRows.find((row) => row.id === instance.accountId);
            const projected = instance.status === "quarantined"
              ? "quarantined"
              : derivedInstanceStatus(account?.status);
            return {
              ...instance,
              status: projected,
              managedTimerCount: metrics?.managedTimerCount ?? 0,
              claimCount: metrics?.claimCount ?? 0,
              inputTokens7d: metrics?.inputTokens7d ?? 0,
            };
          }),
          instanceMemberships: instanceMembershipRows,
          users: userRows.map((user) => ({
            ...user,
            onboardingStatus: user.onboardingStatus ?? "not_started",
          })),
        });
      } catch (err) {
        log.error(
          "Failed to fetch identity graph for admin trees",
          attributableAuthError(err, "AUTH_ADMIN_IDENTITY_GRAPH_FAILED"),
        );
        res.status(500).json({ error: "Failed to fetch identity graph" });
      }
    },
  );

  app.patch(
    "/api/auth/accounts/:id/name",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const accountId = req.params.id as string;
        const parsed = accountNameSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Name must be 1–120 characters" });
        }
        const result = await renameAccount(accountId, parsed.data.name);
        await recordPrivilegedAccess({
          principal: getPrincipal(req)!,
          action: "account_rename",
          reason: "admin account name",
          metadata: { accountId, name: result.name },
        });
        res.json(result);
      } catch (error) {
        log.error(
          "Failed to rename account",
          attributableAuthError(error, "AUTH_ACCOUNT_RENAME_FAILED"),
          { accountId: req.params.id },
        );
        const message = error instanceof Error ? error.message : "Failed to rename account";
        res.status(message === "Account not found" ? 404 : 500).json({ error: message });
      }
    },
  );

  app.patch(
    "/api/auth/accounts/:id/router",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const accountId = req.params.id as string;
        const parsed = z.object({
          routerId: z.string().uuid(),
        }).safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "routerId must be a UUID" });
        }
        const { setAccountRouter } = await import("./router-storage");
        const result = await setAccountRouter(accountId, parsed.data.routerId);
        await recordPrivilegedAccess({
          principal: getPrincipal(req)!,
          action: "account_router_assign",
          reason: "admin account router assignment",
          metadata: { accountId, routerId: result.routerId },
        });
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to assign router";
        const status = message === "Account not found" || message === "Router not found" ? 404 : 400;
        res.status(status).json({ error: message });
      }
    },
  );

  app.patch(
    "/api/auth/accounts/:id/include",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const accountId = req.params.id as string;
        const parsed = z.object({
          includedTokens: z.number().int().nonnegative().nullable(),
        }).safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "includedTokens must be a non-negative integer or null" });
        }
        const { setAccountIncludedTokens } = await import("./account-usage-envelope");
        const result = await setAccountIncludedTokens(accountId, parsed.data.includedTokens);
        await recordPrivilegedAccess({
          principal: getPrincipal(req)!,
          action: "account_include_set",
          reason: "admin account usage include",
          metadata: { accountId, includedTokens: result.includedTokens },
        });
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to set include";
        res.status(message === "Account not found" ? 404 : 400).json({ error: message });
      }
    },
  );

  app.post(
    "/api/auth/accounts/:id/usage-grant",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const accountId = req.params.id as string;
        const parsed = z.object({
          tokens: z.number().int().positive(),
        }).safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "tokens must be a positive integer" });
        }
        const { grantAccountUsageTokens } = await import("./account-usage-envelope");
        const result = await grantAccountUsageTokens(accountId, parsed.data.tokens);
        await recordPrivilegedAccess({
          principal: getPrincipal(req)!,
          action: "account_usage_grant",
          reason: "admin account usage grant",
          metadata: { accountId, tokens: parsed.data.tokens, grantedTokens: result.grantedTokens },
        });
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to grant usage";
        res.status(message === "Account not found" ? 404 : 400).json({ error: message });
      }
    },
  );

  app.patch(
    "/api/auth/accounts/:id/status",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const accountId = req.params.id as string;
        const parsed = accountStatusSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Status must be active, suspended, or archived" });
        }
        const [account] = await db
          .select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1);
        if (!account) return res.status(404).json({ error: "Account not found" });
        const principal = getPrincipal(req);
        if (account.ownerUserId && account.ownerUserId === principal?.userId) {
          return res.status(400).json({ error: "Cannot change the status of your own account" });
        }
        const result = await setAccountLifecycleStatus(accountId, parsed.data.status);
        await recordPrivilegedAccess({
          principal: principal!,
          action: `account_${parsed.data.status}`,
          reason: "admin account lifecycle",
          metadata: { accountId, status: result.status, instanceStatus: result.instanceStatus },
        });
        res.json(result);
      } catch (error) {
        log.error(
          "Failed to update account status",
          attributableAuthError(error, "AUTH_ACCOUNT_STATUS_UPDATE_FAILED"),
          { accountId: req.params.id },
        );
        res.status(500).json({ error: "Failed to update account status" });
      }
    },
  );

  app.delete(
    "/api/auth/accounts/:id",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const accountId = req.params.id as string;
        const [account] = await db
          .select({
            id: accounts.id,
            ownerUserId: accounts.ownerUserId,
          })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1);
        if (!account) return res.status(404).json({ error: "Account not found" });
        const principal = getPrincipal(req);
        if (account.ownerUserId && account.ownerUserId === principal?.userId) {
          return res.status(400).json({ error: "Cannot delete your own account" });
        }
        const owner = account.ownerUserId ? await storage.getUser(account.ownerUserId) : null;
        const ownerEmail = owner?.email ?? "unknown";
        const expectedConfirmation = `DELETE ${ownerEmail}'s account`;
        const parsed = deleteAccountSchema.safeParse(req.body);
        if (!parsed.success || parsed.data.confirmation !== expectedConfirmation) {
          return res.status(400).json({ error: `Type ${expectedConfirmation} to confirm deletion` });
        }
        const result = await deleteAccountPermanently(accountId);
        await recordPrivilegedAccess({
          principal: principal!,
          action: "account_delete",
          reason: "admin account wipe",
          metadata: { accountId, userId: result.userId, ownerEmail },
        });
        res.json({ ok: true, ...result });
      } catch (error) {
        log.error(
          "Failed to delete account",
          attributableAuthError(error, "AUTH_ACCOUNT_DELETE_FAILED"),
          { accountId: req.params.id },
        );
        res.status(500).json({ error: "Failed to delete account" });
      }
    },
  );


  app.patch(
    "/api/auth/users/:id/permissions",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const targetId = req.params.id as string;
        const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions.map(String) : [];
        const user = await storage.getUser(targetId);
        if (!user) return res.status(404).json({ error: "User not found" });
        const overrides = await setUserPermissionOverrides(targetId, permissions);
        await pool.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [targetId]);
        const effective = await getUserEffectivePermissions(targetId);
        res.json({ userId: targetId, permissionOverrides: overrides, permissions: effective, availablePermissions: PERMISSIONS });
      } catch {
        res.status(500).json({ error: "Failed to update user permissions" });
      }
    },
  );

  app.post(
    "/api/auth/users/:id/identity-foundation",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const targetId = req.params.id as string;
        const user = await storage.getUser(targetId);
        if (!user) return res.status(404).json({ error: "User not found" });

        const foundation = await ensureUserIdentityFoundation(user);
        await pool.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [targetId]);
        log.info("admin repaired user identity foundation", {
          actorUserId: req.principal?.userId,
          targetUserId: targetId,
          accountId: foundation.accountId,
          activeVaultId: foundation.activeVaultId,
        });
        res.json({
          userId: targetId,
          accountId: foundation.accountId,
          activeVaultId: foundation.activeVaultId,
          identityIncomplete: false,
          sessionsRevoked: true,
        });
      } catch (error) {
        log.error(
          "Failed to repair user identity foundation",
          attributableAuthError(error, "AUTH_IDENTITY_FOUNDATION_REPAIR_FAILED"),
          {
            actorUserId: req.principal?.userId,
            targetUserId: req.params.id,
          },
        );
        res.status(500).json({ error: "Failed to repair user setup" });
      }
    },
  );

  // Active HTTP session inventory for admin user detail (SEC-2026-015).
  app.get(
    "/api/auth/users/:id/sessions",
    requireAuth,
    requirePermission("users:read"),
    async (req: Request, res: Response) => {
      try {
        const targetId = req.params.id as string;
        const user = await storage.getUser(targetId);
        if (!user) return res.status(404).json({ error: "User not found" });
        const sessions = await listUserSessions(pool, targetId, req.sessionID);
        res.json({ userId: targetId, sessions });
      } catch (error) {
        log.error(
          "Failed to list user sessions",
          attributableAuthError(error, "AUTH_USER_SESSIONS_LIST_FAILED"),
          { targetId: req.params.id },
        );
        res.status(500).json({ error: "Failed to list user sessions" });
      }
    },
  );

  app.delete(
    "/api/auth/users/:id/sessions/:sid",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const targetId = req.params.id as string;
        const sid = req.params.sid as string;
        if (!sid || sid.length > 200) {
          return res.status(400).json({ error: "Invalid session id" });
        }
        const user = await storage.getUser(targetId);
        if (!user) return res.status(404).json({ error: "User not found" });

        const revoked = await revokeUserSession(pool, targetId, sid);
        if (!revoked) return res.status(404).json({ error: "Session not found" });

        const principal = getPrincipal(req);
        await recordPrivilegedAccess({
          principal: principal!,
          action: "revoke_user_session",
          reason: "admin session inventory revocation",
          metadata: {
            targetUserId: targetId,
            sessionSidHash: shortHash(sid),
            revokedCurrent: sid === req.sessionID,
          },
        });

        // Revoking the caller's own current session ends this request like logout.
        if (sid === req.sessionID) {
          return req.session.destroy((error) => {
            if (error) {
              log.error(
                "Failed to destroy current session after revoke",
                attributableAuthError(error, "AUTH_SESSION_DESTROY_AFTER_REVOKE_FAILED"),
              );
              return res.status(500).json({ error: "Session revoked but cleanup failed" });
            }
            res.clearCookie(SESSION_COOKIE_NAME);
            return res.json({ ok: true, revokedCurrent: true });
          });
        }

        res.json({ ok: true, revokedCurrent: false });
      } catch (error) {
        log.error(
          "Failed to revoke user session",
          attributableAuthError(error, "AUTH_USER_SESSION_REVOKE_FAILED"),
          { targetId: req.params.id },
        );
        res.status(500).json({ error: "Failed to revoke user session" });
      }
    },
  );

  app.delete(
    "/api/auth/users/:id",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const targetId = req.params.id as string;
        const principal = getPrincipal(req);
        if (targetId === principal?.userId) {
          return res
            .status(400)
            .json({ error: "Cannot delete your own account" });
        }
        const user = await storage.getUser(targetId);
        if (!user) return res.status(404).json({ error: "User not found" });
        const parsed = deleteUserSchema.safeParse(req.body);
        const expectedConfirmation = `DELETE ${user.email}`;
        if (!parsed.success || parsed.data.confirmation !== expectedConfirmation) {
          return res.status(400).json({ error: `Type ${expectedConfirmation} to confirm deletion` });
        }

        const { db } = await import("./db");
        const { users: usersTable } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
        await pool.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [targetId]);
        await db.delete(usersTable).where(eq(usersTable.id, targetId));
        res.json({ ok: true });
      } catch {
        res.status(500).json({ error: "Failed to delete user" });
      }
    },
  );

  app.get("/api/auth/status", async (_req: Request, res: Response) => {
    const count = await storage.getUserCount();
    res.json({ setupComplete: count > 0 });
  });

  if (process.env.NODE_ENV !== "production") {
    app.post("/api/auth/dev-login", async (req: Request, res: Response) => {
      try {
        const users = await storage.getUsers();
        const admin = users.find((u) => u.role === "admin");
        if (!admin) {
          return res.status(404).json({ error: "No admin user found" });
        }
        const principal = await completeUserAuth(req, res, admin, "dev-login");
        res.json(userResponse(admin, principal));
      } catch {
        res.status(500).json({ error: "Dev login failed" });
      }
    });
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  authTrace(req, "require-auth:start", {
    hasPrincipal: Boolean(req.principal),
    hasSessionUserId: Boolean(req.session.userId),
    hasServicePrincipal: req.session.servicePrincipal?.actorType === "service",
    hasAuthorizationHeader: Boolean(req.headers.authorization),
  });

  const resolution = await resolveRequestPrincipal(req);
  authTrace(req, "require-auth:resolved", {
    outcome: resolution.kind,
    reason: "reason" in resolution ? resolution.reason : null,
    principalActorType: "principal" in resolution ? resolution.principal.actorType : null,
    principalUserId: "principal" in resolution ? resolution.principal.userId : null,
    principalAccountId: "principal" in resolution ? resolution.principal.accountId : null,
  });

  if (resolution.kind === "invalid") {
    req.session.destroy(() => {});
    recordPrincipalDiagnosticEvent({ type: "auth_denied", path: req.path, method: req.method, reason: resolution.reason });
    return res.status(401).json({ error: "User not found" });
  }

  if (resolution.kind === "missing") {
    recordPrincipalDiagnosticEvent({ type: "auth_denied", path: req.path, method: req.method, reason: resolution.reason });
    return res.status(401).json({ error: "Authentication required" });
  }

  return runWithPrincipal(resolution.principal, () =>
    requirePrincipal(req, res, next),
  );
}

function adminPermissionForRequest(req: Request): string {
  const write = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  if (req.path.startsWith("/api/auth/users") || req.path.startsWith("/api/auth/invite")) {
    return write ? "users:write" : "users:read";
  }
  if (
    req.path.startsWith("/api/railway") ||
    req.path.startsWith("/api/integrations/expo") ||
    req.path.startsWith("/api/integrations/github") ||
    req.path.startsWith("/api/gitnexus") ||
    req.path.startsWith("/api/mobile")
  ) {
    return write ? "build:write" : "build:read";
  }
  return write ? "system:write" : "system:read";
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const principal = getPrincipal(req);
  const requiredPermission = adminPermissionForRequest(req);
  if (!principal) {
    recordPrincipalDiagnosticEvent({ type: "admin_denied", path: req.path, method: req.method, reason: "missing_principal", requiredScope: requiredPermission });
    return res.status(401).json({ error: "Authentication required" });
  }
  if (
    principal.actorType !== "user" ||
    !principal.userId ||
    !principal.permissions.includes(requiredPermission)
  ) {
    recordPrincipalDiagnosticEvent({
      type: "admin_denied",
      path: req.path,
      method: req.method,
      reason: "missing_permission",
      requiredScope: requiredPermission,
      principalActorType: principal.actorType,
      principalUserId: principal.userId,
      principalAccountId: principal.accountId,
      isAdmin: principal.isAdmin,
    });
    return res.status(403).json({ error: "Permission required", permission: requiredPermission });
  }
  await recordPrivilegedAccess({
    principal,
    action: "admin_route_access",
    reason: "requireAdmin",
    metadata: { path: req.path, method: req.method, permission: requiredPermission },
  });
  next();
}
