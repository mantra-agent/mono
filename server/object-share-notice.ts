import { eq } from "drizzle-orm";
import { invitedSubjects, memberships, users, type ObjectGrantRow } from "@shared/schema";
import { createLogger } from "./log";
import { db } from "./db";
import { eventBus } from "./event-bus";
import { sendNotification } from "./notifications";
import { APP_NOTIFICATIONS_FROM_EMAIL } from "./password-reset";
import { getRuntimePublicBaseUrl } from "./runtime-identity";
import { invalidateSimpleFeedCache } from "./simple/generate-feed";
import {
  objectShareHref,
  objectShareSentence,
  resolveObjectShareTitle,
  resolveSharerLabel,
} from "./object-share-home";
import type { GrantableObjectType } from "./object-grant-service";

const log = createLogger("ObjectShareNotice");

/**
 * Best-effort recipient notice after a **new** manual person grant insert.
 * Never throws into the grant path. Toast + Home invalidation for users;
 * email when the subject has an address. Claim rebind must not call this.
 */
export async function notifyObjectShareRecipients(grant: ObjectGrantRow): Promise<void> {
  try {
    if (grant.originType !== "manual") return;
    if (grant.subjectType !== "user" && grant.subjectType !== "invited_subject") return;
    if (grant.revokedAt) return;

    const objectType = grant.objectType as GrantableObjectType;
    const [sharerLabel, objectTitle] = await Promise.all([
      resolveSharerLabel(grant.grantedByUserId),
      resolveObjectShareTitle(objectType, grant.objectId),
    ]);
    const sentence = objectShareSentence(sharerLabel, objectTitle);
    const href = objectShareHref(objectType, grant.objectId);

    if (grant.subjectType === "user") {
      await notifyUserRecipient({
        grant,
        sentence,
        href,
        sharerLabel,
        objectTitle,
        objectType,
      });
    }

    await sendShareEmail({
      grant,
      sentence,
      href,
    });
  } catch (error) {
    log.warn("object share notice failed", {
      grantId: grant.id,
      subjectType: grant.subjectType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function notifyUserRecipient(input: {
  grant: ObjectGrantRow;
  sentence: string;
  href: string | null;
  sharerLabel: string;
  objectTitle: string;
  objectType: GrantableObjectType;
}): Promise<void> {
  const recipientUserId = input.grant.subjectId;
  const accounts = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, recipientUserId))
    .limit(20);

  if (accounts.length === 0) {
    log.warn("object share toast skipped: recipient has no account membership", {
      grantId: input.grant.id,
      recipientUserId,
    });
    return;
  }

  // Publish once per account membership so multi-account users still catch the toast
  // while isEventVisibleToPrincipal matches ownerUserId + accountId.
  for (const row of accounts) {
    if (!row.accountId) continue;
    eventBus.publish({
      category: "system",
      event: "data:object_share",
      audience: {
        scope: "user",
        ownerUserId: recipientUserId,
        accountId: row.accountId,
      },
      payload: {
        kind: "object_share",
        grantId: input.grant.id,
        sentence: input.sentence,
        sharerLabel: input.sharerLabel,
        objectTitle: input.objectTitle,
        objectType: input.objectType,
        objectId: input.grant.objectId,
        href: input.href,
      },
    });
    invalidateSimpleFeedCache(row.accountId);
  }
}

async function resolveRecipientEmail(grant: ObjectGrantRow): Promise<string | null> {
  if (grant.subjectType === "user") {
    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, grant.subjectId))
      .limit(1);
    return row?.email?.trim() || null;
  }
  const [row] = await db
    .select({ email: invitedSubjects.normalizedEmail })
    .from(invitedSubjects)
    .where(eq(invitedSubjects.id, grant.subjectId))
    .limit(1);
  return row?.email?.trim() || null;
}

async function sendShareEmail(input: {
  grant: ObjectGrantRow;
  sentence: string;
  href: string | null;
}): Promise<void> {
  const to = await resolveRecipientEmail(input.grant);
  if (!to) {
    log.warn("object share email skipped: no recipient email", {
      grantId: input.grant.id,
      subjectType: input.grant.subjectType,
    });
    return;
  }

  const publicUrl = (await getRuntimePublicBaseUrl()) || "https://app.trymantra.ai";
  const path = input.href || "/";
  const openUrl = path.startsWith("http")
    ? path
    : `${publicUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

  const body = [
    `${input.sentence}.`,
    "",
    `Open in Mantra: ${openUrl}`,
    "",
    "This email does not include the shared content — only that access was granted.",
  ].join("\n");

  const result = await sendNotification({
    channel: "email",
    to,
    from: APP_NOTIFICATIONS_FROM_EMAIL,
    subject: input.sentence,
    body,
    metadata: {
      source: "object-share",
      grantId: input.grant.id,
      objectType: input.grant.objectType,
      objectId: input.grant.objectId,
    },
  });

  if (!result.ok) {
    log.warn("object share email was not accepted", {
      grantId: input.grant.id,
      status: result.status,
      error: result.error,
    });
  }
}
