import {
  acquireAdvisoryTransactionLock,
  ADVISORY_LOCK_NS,
  db,
  runWithDatabaseTransaction,
} from "./db";
import { eq, and, sql, inArray, desc, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  emailDrafts,
  meetingRecapDistributions,
  personEmails,
  persons,
  users,
  type EmailDraft,
} from "@shared/schema";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
  assertWritable,
} from "./scoped-storage";
import { visiblePersonPredicate } from "./person-vault-access";
import { normalizeEmailAddress } from "./email-normalization";
import { resolveOrCreateInvitedSubjectInTransaction } from "./invited-subject-service";
import {
  createRecipientEntryCapability,
  onboardingEntryUrl,
  recapCapabilityHashesFromBody,
} from "./meeting/recap-capability";
import {
  buildRecapEmailContent,
  replaceRecapEntryUrl,
} from "./meeting/recap-email-content";
import { resolveMeetingTransportSession } from "./meeting/owner-principal";
import { eventBus } from "./event-bus";
import type { SessionReviewKind } from "@shared/models/chat";
import { isValidReferenceIdentifier } from "@shared/references";

const log = createLogger("EmailDraftStorage");
const EMAIL_REVIEW_QUERY_BATCH_SIZE = 500;

function isValidEmailDraftId(id: string): boolean {
  return isValidReferenceIdentifier("email_draft", id);
}

function assertValidEmailDraftId(id: string): void {
  if (isValidEmailDraftId(id)) return;
  throw Object.assign(new Error("Invalid email draft ID"), { status: 400 });
}

function publishSessionReviewChanged(sessionId: string | null): void {
  if (!sessionId) return;
  eventBus.publish({
    category: "system",
    event: "data:sessions_changed",
    payload: { source: "email_draft", sessionId },
  });
}

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
  purpose?: "ordinary" | "meeting_recap";
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

export interface RecapDraftRecipientProjection {
  personId: string;
  name: string;
  email: string;
}

export type EmailDraftRecipientMode =
  | { mode: "freeform" }
  | { mode: "recap_person"; selected: RecapDraftRecipientProjection | null };

export type RecapRecipientMutationResult = {
  draft: EmailDraft;
  recipientMode: Extract<EmailDraftRecipientMode, { mode: "recap_person" }>;
};

function hashDraftBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function firstName(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.split(/\s+/)[0] || null : null;
}

function updateRecapRecipientBody(
  body: string,
  priorRecipientName: string | null,
  recipientName: string,
  recapEntryUrl: string,
): string {
  const priorGreeting = firstName(priorRecipientName);
  const nextGreeting = firstName(recipientName);
  const rotated = replaceRecapEntryUrl(body, recapEntryUrl);
  if (!nextGreeting) return rotated;
  if (priorGreeting && rotated.startsWith(`Hi ${priorGreeting},`)) {
    return `Hi ${nextGreeting},${rotated.slice(`Hi ${priorGreeting},`.length)}`;
  }
  if (rotated.startsWith("Hi,")) {
    return `Hi ${nextGreeting},${rotated.slice(3)}`;
  }
  return rotated;
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
        purpose: input.purpose ?? "ordinary",
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
    publishSessionReviewChanged(draft.sessionId);
    return draft;
  }

  /**
   * Get a single draft visible to the principal.
   */
  async getById(principal: Principal, id: string): Promise<EmailDraft | null> {
    if (!isValidEmailDraftId(id)) return null;
    const [row] = await db
      .select()
      .from(emailDrafts)
      .where(combineWithVisibleScope(principal, scopeColumns, eq(emailDrafts.id, id)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Derive unresolved email-review categories for a bounded set of visible
   * Sessions. `email_drafts` remains authoritative; the Session index only
   * projects the pending human review state.
   */
  /**
   * Draft IDs still awaiting human review for one Session. Used by Home clear
   * so check-circle completion can discard unsent draft attention.
   */
  async listDraftIdsBySession(
    principal: Principal,
    sessionId: string,
  ): Promise<string[]> {
    if (!sessionId) return [];
    const rows = await db
      .select({ id: emailDrafts.id })
      .from(emailDrafts)
      .where(
        combineWithVisibleScope(
          principal,
          scopeColumns,
          and(
            eq(emailDrafts.sessionId, sessionId),
            eq(emailDrafts.status, "draft"),
          ),
        ),
      );
    return rows.map((row) => row.id);
  }

  async getPendingReviewKindsBySession(
    principal: Principal,
    sessionIds: string[],
  ): Promise<Map<string, SessionReviewKind[]>> {
    const uniqueIds = Array.from(new Set(sessionIds.filter(Boolean)));
    const kindsBySession = new Map<string, Set<SessionReviewKind>>();
    for (let index = 0; index < uniqueIds.length; index += EMAIL_REVIEW_QUERY_BATCH_SIZE) {
      const batch = uniqueIds.slice(index, index + EMAIL_REVIEW_QUERY_BATCH_SIZE);
      const rows = await db
        .select({
          sessionId: emailDrafts.sessionId,
          purpose: emailDrafts.purpose,
          inReplyTo: emailDrafts.inReplyTo,
          threadId: emailDrafts.threadId,
        })
        .from(emailDrafts)
        .where(combineWithVisibleScope(
          principal,
          scopeColumns,
          and(
            inArray(emailDrafts.sessionId, batch),
            eq(emailDrafts.status, "draft"),
          ),
        ));
      for (const row of rows) {
        if (!row.sessionId) continue;
        const kinds = kindsBySession.get(row.sessionId) ?? new Set<SessionReviewKind>();
        kinds.add(
          row.purpose === "meeting_recap"
            ? "meeting_recap"
            : row.inReplyTo || row.threadId
              ? "email_reply"
              : "email_draft",
        );
        kindsBySession.set(row.sessionId, kinds);
      }
    }
    return new Map(
      Array.from(kindsBySession, ([sessionId, kinds]) => [sessionId, Array.from(kinds)]),
    );
  }

  async getRecipientMode(
    principal: Principal,
    draft: EmailDraft,
  ): Promise<EmailDraftRecipientMode> {
    if (draft.purpose !== "meeting_recap") return { mode: "freeform" };
    const [distribution] = await db
      .select({
        personId: meetingRecapDistributions.recipientPersonId,
        name: meetingRecapDistributions.attendeeName,
        email: meetingRecapDistributions.attendeeEmail,
      })
      .from(meetingRecapDistributions)
      .where(combineWithVisibleScope(
        principal,
        recapDistributionScopeColumns,
        and(
          eq(meetingRecapDistributions.draftId, draft.id),
          isNull(meetingRecapDistributions.accessRevokedAt),
        ),
      ))
      .limit(1);
    if (!distribution?.personId) return { mode: "recap_person", selected: null };
    return {
      mode: "recap_person",
      selected: {
        personId: distribution.personId,
        name: distribution.name?.trim() || distribution.email,
        email: distribution.email,
      },
    };
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
    const current = await this.getById(principal, id);
    if (!current) return { status: "not_found" };
    return db.transaction(async (tx) => {
      const writable = combineWithWritableScope(
        principal,
        scopeColumns,
        eq(emailDrafts.id, id),
      );
      const [existing] = await tx
        .select()
        .from(emailDrafts)
        .where(writable)
        .limit(1)
        .for("update");
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
    const initial = await this.getById(principal, id);
    if (!initial) return null;
    if (
      initial.purpose === "meeting_recap"
      && (patch.to !== undefined || patch.cc !== undefined || patch.bcc !== undefined)
    ) {
      throw Object.assign(
        new Error("Recap recipients must be changed through the Person-linked recipient selector"),
        { status: 400 },
      );
    }
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

    const existing = initial;
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

  async setRecapRecipient(
    principal: Principal,
    draftId: string,
    personId: string,
    email: string,
  ): Promise<RecapRecipientMutationResult> {
    assertValidEmailDraftId(draftId);
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw Object.assign(new Error("Recap recipient changes require an authenticated user"), { status: 403 });
    }
    const normalizedPersonId = personId.trim();
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmailAddress(email);
    } catch {
      throw Object.assign(new Error("A valid Person-linked email is required"), { status: 400 });
    }
    if (!normalizedPersonId || !normalizedEmail) {
      throw Object.assign(new Error("A Person and linked email are required"), { status: 400 });
    }

    return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
      await acquireAdvisoryTransactionLock(
        tx,
        ADVISORY_LOCK_NS.RECAP_DRAFT_RECIPIENT,
        `${principal.accountId}:${draftId}`,
      );
      const [draft] = await tx
        .select()
        .from(emailDrafts)
        .where(combineWithWritableScope(principal, scopeColumns, eq(emailDrafts.id, draftId)))
        .limit(1)
        .for("update");
      if (!draft) throw Object.assign(new Error("Draft not found"), { status: 404 });
      if (draft.status !== "draft") {
        throw Object.assign(new Error(`Cannot edit draft in '${draft.status}' status`), { status: 400 });
      }
      if (draft.purpose !== "meeting_recap" || !draft.sessionId) {
        throw Object.assign(new Error("Draft is not a meeting recap"), { status: 400 });
      }

      const [person] = await tx
        .select({ id: persons.id, name: persons.name })
        .from(personEmails)
        .innerJoin(persons, eq(persons.id, personEmails.personId))
        .where(and(
          eq(personEmails.email, normalizedEmail),
          eq(personEmails.personId, normalizedPersonId),
          visiblePersonPredicate(principal),
        ))
        .limit(1);
      if (!person) {
        throw Object.assign(
          new Error("Selected email is not linked to that visible Person"),
          { status: 400 },
        );
      }

      // unique_mrd_session_attendee is (account_id, session_id, attendee_email):
      // one durable distribution identity per attendee per meeting. Always claim
      // that attendee row (or insert it) rather than rewriting a different
      // draft's row onto the same email, which 500s on the unique constraint.
      await acquireAdvisoryTransactionLock(
        tx,
        ADVISORY_LOCK_NS.RECAP_DRAFT_RECIPIENT,
        `${principal.accountId}:${draft.sessionId}:${normalizedEmail}`,
      );

      const [draftOwned] = await tx
        .select()
        .from(meetingRecapDistributions)
        .where(combineWithWritableScope(
          principal,
          recapDistributionScopeColumns,
          eq(meetingRecapDistributions.draftId, draftId),
        ))
        .limit(1)
        .for("update");

      const [emailOwned] = await tx
        .select()
        .from(meetingRecapDistributions)
        .where(combineWithWritableScope(
          principal,
          recapDistributionScopeColumns,
          and(
            eq(meetingRecapDistributions.sessionId, draft.sessionId),
            sql`LOWER(BTRIM(${meetingRecapDistributions.attendeeEmail})) = ${normalizedEmail}`,
          ),
        ))
        .limit(1)
        .for("update");

      if (
        emailOwned
        && (!draftOwned || emailOwned.id !== draftOwned.id)
      ) {
        const emailRowIsLive = (
          emailOwned.status === "draft_created"
          || emailOwned.status === "sent"
        ) && !emailOwned.accessRevokedAt
          && !emailOwned.discardedAt;
        // Another live draft or an already-sent recap owns this attendee.
        if (emailRowIsLive && emailOwned.draftId && emailOwned.draftId !== draftId) {
          throw Object.assign(
            new Error(
              emailOwned.status === "sent"
                ? "That recipient already has a sent recap for this meeting"
                : "That recipient already has another recap draft for this meeting",
            ),
            { status: 409 },
          );
        }
        if (emailRowIsLive && emailOwned.status === "sent") {
          throw Object.assign(
            new Error("That recipient already has a sent recap for this meeting"),
            { status: 409 },
          );
        }
      }

      // Prefer the unique attendee row. If this draft previously pointed at a
      // different attendee row, retire that prior row so one draft cannot keep
      // two live distributions.
      let existing = emailOwned ?? draftOwned ?? null;
      if (
        draftOwned
        && emailOwned
        && draftOwned.id !== emailOwned.id
      ) {
        await tx
          .update(meetingRecapDistributions)
          .set({
            status: "failed",
            error: "Superseded by recipient reassignment",
            discardedAt: sql`COALESCE(${meetingRecapDistributions.discardedAt}, CURRENT_TIMESTAMP)`,
            accessRevokedAt: sql`COALESCE(${meetingRecapDistributions.accessRevokedAt}, CURRENT_TIMESTAMP)`,
            accessTokenHash: null,
            onboardingTokenHash: null,
            draftId: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(combineWithWritableScope(
            principal,
            recapDistributionScopeColumns,
            eq(meetingRecapDistributions.id, draftOwned.id),
          ));
        existing = emailOwned;
      } else if (emailOwned && emailOwned.draftId !== draftId) {
        await tx
          .update(meetingRecapDistributions)
          .set({ draftId })
          .where(combineWithWritableScope(
            principal,
            recapDistributionScopeColumns,
            eq(meetingRecapDistributions.id, emailOwned.id),
          ));
        existing = { ...emailOwned, draftId };
      }

      const existingBodyHashes = recapCapabilityHashesFromBody(draft.body);
      if (
        existing
        && existing.recipientPersonId === person.id
        && normalizeEmailAddress(existing.attendeeEmail) === normalizedEmail
        && existing.status === "draft_created"
        && !existing.accessRevokedAt
        && draft.to.length === 1
        && normalizeEmailAddress(draft.to[0]) === normalizedEmail
        && draft.cc.length === 0
        && draft.bcc.length === 0
        && !!existing.onboardingTokenHash
        && existingBodyHashes.length === 1
        && existingBodyHashes[0] === existing.onboardingTokenHash
      ) {
        return {
          draft,
          recipientMode: {
            mode: "recap_person",
            selected: { personId: person.id, name: person.name, email: normalizedEmail },
          },
        };
      }

      const meetingSession = await resolveMeetingTransportSession(draft.sessionId);
      const meeting = meetingSession?.meeting;
      const recap = meeting?.recap;
      if (!meeting || !recap || recap.status !== "ready") {
        throw Object.assign(new Error("Canonical meeting recap is not ready"), { status: 409 });
      }
      if (meeting.ownerUserId !== principal.userId || meeting.principalAccountId !== principal.accountId) {
        throw Object.assign(new Error("Meeting recap is not owned by the current principal"), { status: 403 });
      }

      const capability = createRecipientEntryCapability();
      const body = existingBodyHashes.length > 0
        ? updateRecapRecipientBody(
            draft.body,
            existing?.attendeeName ?? null,
            person.name,
            onboardingEntryUrl(capability.token),
          )
        : await buildRecapEmailContent(
            recap,
            meeting,
            { personId: person.id, name: person.name, email: normalizedEmail },
            null,
            principal,
            onboardingEntryUrl(capability.token),
          );
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.INVITED_SUBJECT, normalizedEmail);
      const [existingUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`LOWER(BTRIM(${users.email})) = ${normalizedEmail}`)
        .limit(1);
      if (!existingUser) {
        await resolveOrCreateInvitedSubjectInTransaction(tx, normalizedEmail, person.name);
      }

      let distributionId = existing?.id;
      if (existing) {
        await tx
          .update(meetingRecapDistributions)
          .set({
            attendeeEmail: normalizedEmail,
            attendeeName: person.name,
            recipientPersonId: person.id,
            isMantraUser: !!existingUser,
            accessTokenHash: null,
            onboardingTokenHash: capability.tokenHash,
            accessExpiresAt: capability.expiresAt,
            accessRevokedAt: null,
            sendMethod: "gmail_draft",
            status: "draft_created",
            error: null,
            discardedAt: null,
            draftId,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(combineWithWritableScope(
            principal,
            recapDistributionScopeColumns,
            eq(meetingRecapDistributions.id, existing.id),
          ));
      } else {
        const [created] = await tx
          .insert(meetingRecapDistributions)
          .values({
            ...ownedInsertValues(principal, recapDistributionScopeColumns),
            sessionId: draft.sessionId,
            attendeeEmail: normalizedEmail,
            attendeeName: person.name,
            recipientPersonId: person.id,
            isMantraUser: !!existingUser,
            onboardingTokenHash: capability.tokenHash,
            accessExpiresAt: capability.expiresAt,
            draftId,
            sendMethod: "gmail_draft",
            status: "draft_created",
          })
          .returning({ id: meetingRecapDistributions.id });
        distributionId = created?.id;
      }
      if (!distributionId) throw new Error("Recap distribution was not persisted");

      const [updatedDraft] = await tx
        .update(emailDrafts)
        .set({
          to: [normalizedEmail],
          cc: [],
          bcc: [],
          body,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(combineWithWritableScope(
          principal,
          scopeColumns,
          and(eq(emailDrafts.id, draftId), eq(emailDrafts.status, "draft")),
        ))
        .returning();
      if (!updatedDraft) throw Object.assign(new Error("Draft became immutable during recipient change"), { status: 409 });
      log.info(`rotated recap recipient capability draft=${draftId} distribution=${distributionId}`);
      return {
        draft: updatedDraft,
        recipientMode: {
          mode: "recap_person",
          selected: { personId: person.id, name: person.name, email: normalizedEmail },
        },
      };
    }));
  }

  private async assertRecapSendConsistency(
    principal: Principal,
    draft: EmailDraft,
  ): Promise<void> {
    if (draft.purpose !== "meeting_recap") return;
    if (draft.to.length !== 1 || draft.cc.length !== 0 || draft.bcc.length !== 0) {
      throw Object.assign(
        new Error("Repair this recap recipient before sending: recap drafts require exactly one To recipient and no CC/BCC"),
        { status: 409 },
      );
    }
    const [distribution] = await db
      .select()
      .from(meetingRecapDistributions)
      .where(combineWithVisibleScope(
        principal,
        recapDistributionScopeColumns,
        and(
          eq(meetingRecapDistributions.draftId, draft.id),
          eq(meetingRecapDistributions.status, "draft_created"),
          isNull(meetingRecapDistributions.accessRevokedAt),
        ),
      ))
      .limit(1);
    if (!distribution?.recipientPersonId || !distribution.onboardingTokenHash) {
      throw Object.assign(
        new Error("Select a Person-linked recap recipient before sending"),
        { status: 409 },
      );
    }
    const normalizedTo = normalizeEmailAddress(draft.to[0]);
    if (normalizedTo !== normalizeEmailAddress(distribution.attendeeEmail)) {
      throw Object.assign(new Error("Repair this recap recipient before sending: envelope and recipient identity differ"), { status: 409 });
    }
    const person = await db
      .select({ id: persons.id })
      .from(personEmails)
      .innerJoin(persons, eq(persons.id, personEmails.personId))
      .where(and(
        eq(personEmails.email, normalizedTo),
        eq(personEmails.personId, distribution.recipientPersonId),
        visiblePersonPredicate(principal),
      ))
      .limit(1);
    const bodyHashes = recapCapabilityHashesFromBody(draft.body);
    if (!person[0] || bodyHashes.length !== 1 || bodyHashes[0] !== distribution.onboardingTokenHash) {
      throw Object.assign(
        new Error("Repair this recap recipient before sending: the identity-bound recap link is stale"),
        { status: 409 },
      );
    }
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

  private async claimForProviderSend(
    principal: Principal,
    id: string,
  ): Promise<EmailDraft> {
    assertValidEmailDraftId(id);
    if (!principal.accountId) {
      throw Object.assign(new Error("Email sending requires an account-bound principal"), { status: 403 });
    }
    return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
      await acquireAdvisoryTransactionLock(
        tx,
        ADVISORY_LOCK_NS.RECAP_DRAFT_RECIPIENT,
        `${principal.accountId}:${id}`,
      );
      const [existing] = await tx
        .select()
        .from(emailDrafts)
        .where(combineWithWritableScope(principal, scopeColumns, eq(emailDrafts.id, id)))
        .limit(1)
        .for("update");
      if (!existing) throw Object.assign(new Error("Draft not found"), { status: 404 });
      if (existing.status === "sent") return existing;
      if (existing.status === "sending") {
        throw Object.assign(new Error("Email delivery is already in progress"), { status: 409 });
      }
      if (existing.status !== "draft") {
        throw Object.assign(
          new Error(`Cannot send draft in '${existing.status}' status`),
          { status: 400 },
        );
      }

      await this.assertRecapSendConsistency(principal, existing);
      const [claimed] = await tx
        .update(emailDrafts)
        .set({ status: "sending", updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(combineWithWritableScope(
          principal,
          scopeColumns,
          and(eq(emailDrafts.id, id), eq(emailDrafts.status, "draft")),
        ))
        .returning();
      if (!claimed) {
        throw Object.assign(new Error("Email delivery state changed before send admission"), { status: 409 });
      }
      return claimed;
    }));
  }

  /**
   * Send a draft. ONLY callable by user principals (actorType === 'user').
   * Idempotent after provider identity is persisted; concurrent sends fail closed.
   */
  async send(
    principal: Principal,
    id: string,
    sendFn: (draft: EmailDraft) => Promise<{ messageId: string; gmailAccountId: string }>,
  ): Promise<EmailDraft> {
    const claimed = await this.claimForProviderSend(principal, id);

    // Idempotent: already sent. The route may replay downstream projection,
    // but provider delivery must never execute twice.
    if (claimed.status === "sent") {
      await this.markRecapDistributionSent(principal, id);
      return claimed;
    }
    publishSessionReviewChanged(claimed.sessionId);

    // Execute Gmail only after the exact envelope/body/capability aggregate is
    // durably frozen. An ambiguous provider failure intentionally leaves the
    // draft in `sending`; replay must not risk duplicate delivery.
    const result = await sendFn(claimed);

    const [sent] = await db
      .update(emailDrafts)
      .set({
        status: "sent",
        gmailAccountId: result.gmailAccountId,
        sentMessageId: result.messageId,
        sentAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        combineWithWritableScope(
          principal,
          scopeColumns,
          and(eq(emailDrafts.id, id), eq(emailDrafts.status, "sending")),
        ),
      )
      .returning();
    if (!sent) {
      throw Object.assign(
        new Error("Gmail sent the message, but the frozen draft could not be finalized"),
        { status: 500 },
      );
    }
    await this.markRecapDistributionSent(principal, id);
    publishSessionReviewChanged(sent.sessionId);
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
    publishSessionReviewChanged(discarded?.sessionId ?? existing.sessionId);
    log.info(`discarded draft ${id}`);
    return discarded ?? null;
  }
}

export const emailDraftStorage = new EmailDraftStorage();
