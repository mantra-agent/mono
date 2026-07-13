import { createLogger } from "./log";
const log = createLogger("auth");
import {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { storage } from "./storage";
import { getSetting, setSetting } from "./system-settings";
import { loginSchema, registerSchema, type User } from "@shared/schema";
import { z } from "zod";
import {
  attachUserPrincipal,
  createServicePrincipal,
  ensureUserIdentityFoundation,
  getPrincipal,
  recordPrivilegedAccess,
  requirePrincipal,
  setServiceSessionPrincipal,
  type Principal,
} from "./principal";
import { PERMISSIONS, getUserEffectivePermissions, listUserPermissionOverrides, requirePermission, setUserPermissionOverrides } from "./permissions";
import { runWithPrincipal } from "./principal-context";
import { MEETING_JOIN_POLICIES, getMeetingJoinPolicy, setMeetingJoinPolicy } from "./meeting/join-policy";
import { recordPrincipalDiagnosticEvent } from "./principal-diagnostics";
import { getClientPresenceSnapshot } from "./client-presence";

const setupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

const PgStore = connectPgSimple(session);
const SESSION_TABLE_NAME = "session";

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
        log.error("[AuthSession] Session save failed", {
          context,
          hasSessionId: !!req.sessionID,
          hasUserId: !!req.session.userId,
          userId: req.session.userId,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
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

function userResponse(user: User, principal?: Principal | null) {
  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
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

async function completeUserAuth(req: Request, res: Response, user: User, context: string) {
  delete req.session.servicePrincipal;
  req.session.userId = user.id;
  const principal = await attachUserPrincipal(req, user);
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
    process.env.PUBLIC_URL,
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
        const { getSetting } = await import("./system-settings");
        const storedToken = await getSetting<string>("system.automation_auth_token");
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
    const principal = await attachUserPrincipal(req, user);
    return { kind: "user", principal };
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

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });

  const sessionTableReady = ensureSessionTable(pool).catch((error) => {
    log.error("[AuthSession] Failed to ensure PostgreSQL session table", {
      tableName: SESSION_TABLE_NAME,
      createTableIfMissing: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  });

  const sessionStore = new PgStore({
    pool,
    tableName: SESSION_TABLE_NAME,
    createTableIfMissing: false,
    errorLog: (...args: unknown[]) =>
      log.error("[AuthSession] connect-pg-simple error", ...args),
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
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
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

  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api") || req.path.startsWith("/api/voice/llm/")) {
      return next();
    }

    resolveRequestPrincipal(req)
      .then((resolution) => {
        if ("principal" in resolution && resolution.principal) {
          // Wrap downstream handlers in principal context so
          // getCurrentPrincipalOrSystem() returns the real user principal
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

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid email or password format" });
      }

      const { email, password } = parsed.data;
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
      log.error("[AuthLogin] Login failed", {
        email: typeof req.body?.email === "string" ? req.body.email : undefined,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: "Logout failed" });
      res.clearCookie("connect.sid");
      res.json({ ok: true });
    });
  });

  /** @deprecated Headless browser auth now uses direct DB session injection via createScreenshotSession in browser-manager.ts. */
  app.get("/api/auth/automation-login", (_req: Request, res: Response) => {
    res.status(410).json({ deprecated: true, message: "Use createScreenshotSession for headless auth" });
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
    authTrace(req, "me:success", { userId: user.id });
    res.json(userResponse(user, principal));
  });

  app.post("/api/auth/setup", async (req: Request, res: Response) => {
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
      const { email, password } = parsed.data;

      const hashed = await bcrypt.hash(password, 12);
      const user = await storage.createUser({
        email,
        password: hashed,
      });
      const adminUser = await storage.updateUser(user.id, { role: "admin" });

      const authenticatedUser = adminUser ?? { ...user, role: "admin" as const };
      const principal = await completeUserAuth(req, res, authenticatedUser, "setup");
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
        const { email } = req.body;
        if (!email) {
          return res.status(400).json({ error: "Email is required" });
        }

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
          inviteToken: token,
          inviteExpires: expires,
        });

        res.json({ token, email, expiresAt: expires.toISOString() });
      } catch (error: any) {
        res.status(500).json({ error: "Failed to create invite" });
      }
    },
  );

  app.get("/api/auth/invite/:token", async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserByInviteToken(
        req.params.token as string,
      );
      if (!user || !user.inviteExpires || user.inviteExpires < new Date()) {
        return res.status(404).json({ error: "Invalid or expired invite" });
      }
      res.json({ email: user.email });
    } catch {
      res.status(500).json({ error: "Failed to verify invite" });
    }
  });

  app.post("/api/auth/register", async (req: Request, res: Response) => {
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

      const { email, password, inviteToken } = parsed.data;

      const hashed = await bcrypt.hash(password, 12);
      let user;

      if (inviteToken) {
        const invitedUser = await storage.getUserByInviteToken(inviteToken);
        if (!invitedUser || !invitedUser.inviteExpires || invitedUser.inviteExpires < new Date()) {
          return res.status(400).json({ error: "Invalid or expired invite" });
        }

        if (invitedUser.email !== email) {
          return res.status(400).json({ error: "Email does not match invite" });
        }

        user = await storage.updateUser(invitedUser.id, {
          password: hashed,
          inviteToken: null,
          inviteExpires: null,
        });
      } else {
        user = await storage.createUser({
          email,
          password: hashed,
        });
      }

      if (!user) {
        return res.status(500).json({ error: "Registration failed" });
      }

      const principal = await completeUserAuth(req, res, user, "register");
      res.json(userResponse(user, principal));
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("[AuthRegister] Registration failed", {
        email: typeof req.body?.email === "string" ? req.body.email : undefined,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (message.includes("unique") || message.includes("duplicate key")) {
        return res.status(400).json({ error: "Email already exists" });
      }
      res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post(
    "/api/auth/reset-request",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email is required" });

        const user = await storage.getUserByEmail(email);
        if (!user) return res.status(404).json({ error: "User not found" });

        const token = crypto.randomBytes(32).toString("hex");
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await storage.updateUser(user.id, {
          resetToken: token,
          resetExpires: expires,
        });
        res.json({ token, email, expiresAt: expires.toISOString() });
      } catch {
        res.status(500).json({ error: "Failed to create reset link" });
      }
    },
  );

  app.get("/api/auth/reset/:token", async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserByResetToken(
        req.params.token as string,
      );
      if (!user || !user.resetExpires || user.resetExpires < new Date()) {
        return res.status(404).json({ error: "Invalid or expired reset link" });
      }
      res.json({ email: user.email });
    } catch {
      res.status(500).json({ error: "Failed to verify reset token" });
    }
  });

  app.post("/api/auth/reset", async (req: Request, res: Response) => {
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

      const user = await storage.getUserByResetToken(token);
      if (!user || !user.resetExpires || user.resetExpires < new Date()) {
        return res.status(400).json({ error: "Invalid or expired reset link" });
      }

      const hashed = await bcrypt.hash(password, 12);
      await storage.updateUser(user.id, {
        password: hashed,
        resetToken: null,
        resetExpires: null,
      });

      res.json({ ok: true });
    } catch {
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
        res.json({ ok: true });
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
        const scale = await getSetting<number>(`user:${principal.userId}:ui.scale`);
        res.json({ scale: scale ?? 110 });
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
        const { scale } = req.body;
        if (typeof scale === "number" && scale >= 90 && scale <= 120) {
          await setSetting(`user:${principal.userId}:ui.scale`, scale);
        }
        res.json({ ok: true });
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
        log.error("Failed to read meeting join policy", error);
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
        log.error("Failed to update meeting join policy", error);
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
        const rows = await Promise.all(allUsers.map(async (u) => {
          const identity = await ensureUserIdentityFoundation(u);
          return {
            id: u.id,
            email: u.email,
            role: u.role,
            createdAt: u.createdAt,
            hasPendingInvite: !!u.inviteToken,
            permissionOverrides: await listUserPermissionOverrides(u.id),
            permissions: await getUserEffectivePermissions(u.id),
            presence: getClientPresenceSnapshot(identity.accountId).clients,
          };
        }));
        res.json({ users: rows, availablePermissions: PERMISSIONS });
      } catch {
        res.status(500).json({ error: "Failed to fetch users" });
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
        const effective = await getUserEffectivePermissions(targetId);
        res.json({ userId: targetId, permissionOverrides: overrides, permissions: effective, availablePermissions: PERMISSIONS });
      } catch {
        res.status(500).json({ error: "Failed to update user permissions" });
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

        const { db } = await import("./db");
        const { users: usersTable } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
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
  if (req.path.startsWith("/api/auth/users") || req.path.startsWith("/api/auth/invite") || req.path.startsWith("/api/auth/reset-request")) {
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
