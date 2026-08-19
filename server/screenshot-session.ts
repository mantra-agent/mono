/**
 * Short-lived browser `connect.sid` mint used by acceptance screenshots
 * and Stage automation-auth exchange. Inserts a 120s `session` row and
 * signs the cookie with the target runtime's SESSION_SECRET.
 */
export interface ScreenshotSession {
  sid: string;
  signedCookie: string;
  cleanup: () => Promise<void>;
}

export async function createScreenshotSession(
  userId: string,
  sessionSecret?: string,
): Promise<ScreenshotSession> {
  const uidSafe = (await import("uid-safe")) as unknown as {
    default?: { sync: (len: number) => string };
    sync?: (len: number) => string;
  };
  const uidSync = (uidSafe.default?.sync ?? uidSafe.sync) as (len: number) => string;

  const cookieSig = (await import("cookie-signature")) as unknown as {
    default?: { sign: (val: string, secret: string) => string };
    sign?: (val: string, secret: string) => string;
  };
  const cookieSign = (cookieSig.default?.sign ?? cookieSig.sign) as (
    val: string,
    secret: string,
  ) => string;

  const sid = uidSync(24);
  const secret = sessionSecret || process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "Platform-binding auth invariant failed: SESSION_SECRET is unavailable to sign the acceptance session cookie",
    );
  }
  if (!userId.trim()) {
    throw new Error("Platform-binding auth invariant failed: workflow owner user ID is missing");
  }

  const { pool } = await import("./db");
  const usersResult = await pool.query('SELECT id FROM "users" WHERE id = $1 LIMIT 1', [userId]);
  const sessionUserId: string | undefined = usersResult.rows[0]?.id;
  if (!sessionUserId) {
    throw new Error(
      `Platform-binding auth invariant failed: workflow owner ${userId} does not exist in the shared user store`,
    );
  }

  // connect-pg-simple reads expire with to_timestamp(epoch_seconds).
  const expireEpochSeconds = Math.ceil((Date.now() + 120_000) / 1000);
  const sess = JSON.stringify({
    cookie: { maxAge: 120000 },
    userId: sessionUserId,
    createdAt: new Date().toISOString(),
    userAgent: "mantra-screenshot-session",
  });
  await pool.query('INSERT INTO "session" (sid, sess, expire) VALUES ($1, $2, to_timestamp($3))', [
    sid,
    sess,
    expireEpochSeconds,
  ]);

  const signedCookie = "s:" + cookieSign(sid, secret);

  const cleanup = async () => {
    try {
      await pool.query('DELETE FROM "session" WHERE sid = $1', [sid]);
    } catch {
      // best-effort cleanup
    }
  };

  return { sid, signedCookie, cleanup };
}
