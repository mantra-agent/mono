import { db } from "./db";
import { eq, and, sql } from "drizzle-orm";
import { emailDrafts, type EmailDraft } from "@shared/schema";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
  assertVisible,
  assertWritable,
} from "./scoped-storage";

const log = createLogger("EmailDraftStorage");

const scopeColumns = {
  scope: emailDrafts.scope,
  ownerUserId: emailDrafts.ownerUserId,
  accountId: emailDrafts.accountId,
};

export interface CreateEmailDraftInput {
  sessionId?: string;
  gmailAccountId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
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
   * Edit a draft's editable fields while status === 'draft'.
   * Returns the updated draft or null if not found / not writable.
   */
  async update(
    principal: Principal,
    id: string,
    patch: UpdateEmailDraftInput,
  ): Promise<EmailDraft | null> {
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
    if (patch.body !== undefined) setValues.body = patch.body;

    const [updated] = await db
      .update(emailDrafts)
      .set(setValues)
      .where(
        combineWithWritableScope(principal, scopeColumns, eq(emailDrafts.id, id)),
      )
      .returning();
    return updated ?? null;
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
      // Already terminal — return as-is
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
    log.info(`discarded draft ${id}`);
    return discarded ?? null;
  }
}

export const emailDraftStorage = new EmailDraftStorage();
