import crypto from "crypto";
import type { User } from "@shared/schema";
import { createLogger } from "./log";
import { sendNotification } from "./notifications";
import { getRuntimePublicBaseUrl } from "./runtime-identity";
import { storage } from "./storage";

const log = createLogger("PasswordReset");

/** App notifications identity — password-reset mail always sends from here. */
export const APP_NOTIFICATIONS_FROM_EMAIL = "agent@trymantra.ai";

const CAPABILITY_HASH_PREFIX = "h1:";
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Same HMAC digest as auth capability tokens (invite/reset). Kept here so the
 * issuer is the single mutation path without circular auth imports.
 */
function capabilityDigest(token: string): string {
  if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required for capability hashing");
  return `${CAPABILITY_HASH_PREFIX}${crypto.createHmac("sha256", process.env.SESSION_SECRET).update(token).digest("hex")}`;
}

export type IssuePasswordResetResult =
  | { ok: true; emailed: true; userId: string }
  | { ok: true; emailed: false; reason: "no_email" | "no_public_url" | "send_failed" }
  | { ok: false; error: unknown };

function buildResetBodies(resetUrl: string): { body: string; html: string } {
  return {
    body: [
      "Set a new password with this link:",
      resetUrl,
      "",
      "This link expires in one hour and can be used once.",
      "If you did not ask for this, you can ignore the email.",
    ].join("\n"),
    html: `<div style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#f5f5f5;padding:40px 24px"><div style="max-width:560px;margin:0 auto"><p style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#a3a3a3">Mantra</p><h1 style="font-size:32px;line-height:1.15;margin:28px 0 18px">Set a new password</h1><p style="font-size:17px;line-height:1.6;color:#d4d4d4">Use the link below. It expires in one hour and works once.</p><p style="margin:28px 0"><a href="${resetUrl}" style="color:#1A9BDB">Reset password</a></p><p style="font-size:15px;line-height:1.6;color:#a3a3a3">If you did not ask for this, ignore the email.</p></div></div>`,
  };
}

/**
 * Canonical password-reset issuer. Mint a one-hour single-use digest token,
 * email only the address on file from the app notifications identity, and
 * clear the token if delivery cannot complete. Public forgot-password callers
 * must stay enumeration-safe and treat every outcome as `{ ok: true }`.
 */
export async function issuePasswordResetEmail(user: User): Promise<IssuePasswordResetResult> {
  if (!user.email?.trim()) {
    return { ok: true, emailed: false, reason: "no_email" };
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + RESET_TTL_MS);
  await storage.updateUser(user.id, {
    resetToken: capabilityDigest(token),
    resetExpires: expires,
  });

  const publicUrl = await getRuntimePublicBaseUrl();
  if (!publicUrl) {
    await storage.updateUser(user.id, { resetToken: null, resetExpires: null });
    return { ok: true, emailed: false, reason: "no_public_url" };
  }

  const resetUrl = `${publicUrl}/reset/${token}`;
  const { body, html } = buildResetBodies(resetUrl);
  try {
    const result = await sendNotification({
      channel: "email",
      to: user.email,
      from: APP_NOTIFICATIONS_FROM_EMAIL,
      subject: "Reset your Mantra password",
      body,
      html,
      metadata: { source: "password-reset", userId: user.id },
    });

    if (!result.ok) {
      await storage.updateUser(user.id, { resetToken: null, resetExpires: null });
      log.error("Reset password email was not accepted", {
        userId: user.id,
        status: result.status,
        error: result.error,
      });
      return { ok: true, emailed: false, reason: "send_failed" };
    }

    log.info("Reset password email accepted", { userId: user.id });
    return { ok: true, emailed: true, userId: user.id };
  } catch (error) {
    await storage.updateUser(user.id, { resetToken: null, resetExpires: null }).catch(() => undefined);
    log.error("Reset password email send threw", { userId: user.id, error });
    return { ok: false, error };
  }
}
