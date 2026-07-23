import { db } from "./db";
import { eq, and, sql, inArray, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import { emailDrafts, meetingRecapDistributions, type EmailDraft } from "@shared/schema";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
  assertWritable,
} from "./scoped-storage";

const log = createLogger("EmailDraftStorage");

const scopeColumns = {
  scope: emailDrafts.scope,
  ownerUserId: emailDrafts.ownerUserId,
  accountId: emailDrafts.accountId,
};

const recapDistributionScopeColumns = {
  scope: meetingRecapDistributions.scope,
  ownerUserId: meetingRecapDistributions.ownerUserId,
  accountId: meetingRecapDistributions.accountId,
};

export interface CreateEmailDraftInput {
  sessionId?: string;
  gmailAccountId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyFormat?: "text" | "markdown";
  threadId?: string;
  inReplyTo?: string;
}


export type EmailDraftBodyMutation =
  | { type: "find_replace"; find: string; replace: string; replaceAll?: boolean }
  | { type: "range_patch"; start: number; end: number; replacement: string; expectedBodyHash: string }
  | { type: "replace_body"; body: string };

export type EmailDraftBodyMutationStatus =
  | "updated"
  | "not_found"
  | "missing_match"
  | "ambiguous_match"
  | "stale_body"
  | "invalid_range"
  | "immutable_draft";

export type EmailDraftBodyMutationResult =
  | { status: "updated"; draft: EmailDraft; bodyHash: string }
  | { status: Exclude<EmailDraftBodyMutationStatus, "updated">; bodyHash?: string };

function hashDraftBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function countExactMatches(body: string, find: string): number {
  if (find.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = body.indexOf(find, offset)) !== -1) {
    count += 1;
    offset += find.length;
  }
  return count;
}

function applyBodyMutation(
  body: string,
  mutation: EmailDraftBodyMutation,
): { status: "ready"; body: string } | { status: Exclude<EmailDraftBodyMutationStatus, "updated" | "not_found" | "immutable_draft">; bodyHash?: string } {
  if (mutation.type === "replace_body") {
    return { status: "ready", body: mutation.body };
  }

  if (mutation.type === "range_patch") {
    const bodyHash = hashDraftBody(body);
    if (bodyHash !== mutation.expectedBodyHash) return { status: "stale_body", bodyHash };
    if (
      !Number.isInteger(mutation.start)
      || !Number.isInteger(mutation.end)
      || mutation.start < 0
      || mutation.end < mutation.start
      || mutation.end > body.length
    ) {
      return { status: "invalid_range", bodyHash };
    }
    return {
      status: "ready",
      body: body.slice(0, mutation.start) + mutation.replacement + body.slice(mutation.end),
    };
  }

  const matchCount = countExactMatches(body, mutation.find);
  if (matchCount === 0) return { status: "missing_match" };
  if (!mutation.replaceAll && matchCount > 1) return { status: "ambiguous_match" };
  return {
    status: "ready",
    body: mutation.replaceAll
      ? body.split(mutation.find).join(mutation.replace)
      : body.replace(mutation.find, mutation.replace),
  };
}

export interface UpdateEmailDraftInput {
  gmailAccountId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
}

/**
 * Canonical mutation path for email drafts.
 * All draft CRUD goes through this module. Routes and tools must not
 * write to the email_drafts table directly.
 */
export class EmailDraftStorage {
  /**
   * Create a new draft. The caller (tool or route) provides the content;
   * ownership is stamped from the principal.
   */
  async create(
    principal: Principal,
    input: CreateEmailDraftInput,
  ): Promise<EmailDraft> {
    const owned = ownedInsertValues(principal, scopeColumns);
    const [draft] = await db
      .insert(emailDrafts)
      .values({
        ...owned,
        createdByUserId: principal.userId ?? null,
        sessionId: input.sessionId ?? null,
        gmailAccountId: input.gmailAccountId ?? null,
        to: input.to,
        cc: input.cc ?? [],
        bcc: input.bcc ?? [],
        subject: input.subject,
        body: input.body,
        bodyFormat: input.bodyFormat ?? "text",
        threadId: input.threadId ?? null,
        inReplyTo: input.inReplyTo ?? null,
        status: "draft",
      })
      .returning();
    log.info(`created draft ${draft.id} for session=${input.sessionId}`);
    return draft;
  }

  /**
   * Get a single draft visible to the principal.
   */
  async getById(principal: Principal, id: string): Promise<EmailDraft | null> {
    const [row] = await db
      .select()
      .from(emailDrafts)
      .where(combineWithVisibleScope(principal, scopeColumns, eq(emailDrafts.id, id)))
      .limit(1);
    return row ?? null;
  }

  /**
   * List drafts visible to the principal that are linked to any of the given
   * Gmail thread IDs. Used by the Comms Review tab to show linked drafts per thread.
   */
  async listByThreadIds(principal: Principal, threadIds: string[]): Promise<EmailDraft[]> {
    if (threadIds.length === 0) return [];
    return db
      .select()
      .from(emailDrafts)
      .where(combineWithVisibleScope(principal, scopeColumns, inArray(emailDrafts.threadId, threadIds)))
      .orderBy(desc(emailDrafts.createdAt));
  }

  /**
   * Atomically compare and mutate the exact current draft body.
   */
  async mutateBody(
    principal: Principal,
    id: string,
    mutation: EmailDraftBodyMutation,
  ): Promise<EmailDraftBodyMutationResult> {
    return db.transaction(async (tx) => {
      const writable = combineWithWritableScope(
        principal,
        scopeColumns,
        eq(emailDrafts.id, id),
      );
      const rows = await tx.execute(sql`
        SELECT *
        FROM ${emailDrafts}
        WHERE ${writable}
        LIMIT 1
        FOR UPDATE
      `);
      const existing = rows.rows[0] as EmailDraft | undefined;
      if (!existing) return { status: "not_found" };
      if (existing.status !== "draft") return { status: "immutable_draft" };

      const applied = applyBodyMutation(existing.body, mutation);
      if (applied.status !== "ready") return applied;

      const [updated] = await tx
        .update(emailDrafts)
        .set({ body: applied.body, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(writable, eq(emailDrafts.status, "draft")))
        .returning();
      if (!updated) return { status: "immutable_draft" };
      return { status: "updated", draft: updated, bodyHash: hashDraftBody(updated.body) };
    });
  }

  /**
   * Edit a draft's editable fields while status === 'draft'.
   * Returns the updated draft or null if not found / not writable.
   */
  async update(
    principal: Principal,
    id: string,
    patch: UpdateEmailDraftInput,
  ): Promise<EmailDraft | null> {
    if (patch.body !== undefined) {
      const bodyResult = await this.mutateBody(principal, id, {
        type: "replace_body",
        body: patch.body,
      });
      if (bodyResult.status === "not_found") return null;
      if (bodyResult.status === "immutable_draft") {
        throw new Error("Cannot edit immutable draft");
      }
      const { body: _body, ...remainingPatch } = patch;
      patch = remainingPatch;
      if (Object.values(patch).every((value) => value === undefined)) {
        return bodyResult.draft;
      }
    }

    const existing = await this.getById(principal, id);
    if (!existing) return null;
    assertWritable(principal, existing, "email_draft");

    if (existing.status !== "draft") {
      throw new Error(`Cannot edit draft in '${existing.status}' status`);
    }

    const setValues: Record<string, unknown> = {
      updatedAt: sql`CURRENT_TIMESTAMP`,
    };
    if (patch.gmailAccountId !== undefined) setValues.gmailAccountId = patch.gmailAccountId;
    if (patch.to !== undefined) setValues.to = patch.to;
    if (patch.cc !== undefined) setValues.cc = patch.cc;
    if (patch.bcc !== undefined) setValues.bcc = patch.bcc;
    if (patch.subject !== undefined) setValues.subject = patch.subject;

    const [updated] = await db
      .update(emailDrafts)
      .set(setValues)
      .where(
        combineWithWritableScope(
          principal,
          scopeColumns,
          and(eq(emailDrafts.id, id), eq(emailDrafts.status, "draft")),
        ),
      )
      .returning();

    if (!updated) {
      const current = await this.getById(principal, id);
      if (current && current.status !== "draft") {
        throw new Error(`Cannot edit draft in '${current.status}' status`);
      }
    }
    return updated ?? null;
  }

  private async markRecapDistributionSent(principal: Principal, draftId: string): Promise<void> {
    await db.update(meetingRecapDistributions).set({
      status: "sent",
      sentAt: sql`COALESCE(${meetingRecapDistributions.sentAt}, CURRENT_TIMESTAMP)`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(combineWithWritableScope(
      principal,
      recapDistributionScopeColumns,
      eq(meetingRecapDistributions.draftId, draftId),
    ));
  }

  private async revokeRecapDistribution(principal: Principal, draftId: string): Promise<void> {
    await db.update(meetingRecapDistributions).set({
      status: "failed",
      error: "Recap draft discarded",
      discardedAt: sql`COALESCE(${meetingRecapDistributions.discardedAt}, CURRENT_TIMESTAMP)`,
      accessRevokedAt: sql`COALESCE(${meetingRecapDistributions.accessRevokedAt}, CURRENT_TIMESTAMP)`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(combineWithWritableScope(
      principal,
      recapDistributionScopeColumns,
      eq(meetingRecapDistributions.draftId, draftId),
    ));
  }

  /**
   * Send a draft. ONLY callable by user principals (actorType === 'user').
   * Idempotent: if already sent, returns the existing sent record.
   */
  async send(
    principal: Principal,
    id: string,
    sendFn: (draft: EmailDraft) => Promise<{ messageId: string }>,
  ): Promise<EmailDraft> {
    const existing = await this.getById(principal, id);
    if (!existing) {
      throw Object.assign(new Error("Draft not found"), { status: 404 });
    }
    assertWritable(principal, existing, "email_draft");

    // Idempotent: already sent
    if (existing.status === "sent") {
      await this.markRecapDistributionSent(principal, id);
      return existing;
    }

    if (existing.status !== "draft") {
      throw Object.assign(
        new Error(`Cannot send draft in '${existing.status}' status`),
        { status: 400 },
      );
    }

    // Execute the actual Gmail send
    const result = await sendFn(existing);

    const [sent] = await db
      .update(emailDrafts)
      .set({
        status: "sent",
        sentMessageId: result.messageId,
        sentAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        combineWithWritableScope(principal, scopeColumns, eq(emailDrafts.id, id)),
      )
      .returning();
    await this.markRecapDistributionSent(principal, id);
    log.info(`sent draft ${id}, messageId=${result.messageId}`);
    return sent;
  }

  /**
   * Discard a draft.
   */
  async discard(principal: Principal, id: string): Promise<EmailDraft | null> {
    const existing = await this.getById(principal, id);
    if (!existing) return null;
    assertWritable(principal, existing, "email_draft");

    if (existing.status !== "draft") {
      if (existing.status === "discarded") await this.revokeRecapDistribution(principal, id);
      return existing;
    }

    const [discarded] = await db
      .update(emailDrafts)
      .set({
        status: "discarded",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        combineWithWritableScope(principal, scopeColumns, eq(emailDrafts.id, id)),
      )
      .returning();
    await this.revokeRecapDistribution(principal, id);
    log.info(`discarded draft ${id}`);
    return discarded ?? null;
  }
}

export const emailDraftStorage = new EmailDraftStorage();
