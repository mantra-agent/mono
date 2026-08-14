import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import { conversationMessages, conversationRevisions, documentStoreDocuments } from "@shared/schema";
import type { Principal } from "./principal";
import { db } from "./db";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const MESSAGE_PAGE_SIZE = 500;

const messageScopeColumns = {
  scope: conversationMessages.scope,
  ownerUserId: conversationMessages.ownerUserId,
  accountId: conversationMessages.accountId,
  vaultId: conversationMessages.vaultId,
};

const revisionScopeColumns = {
  scope: conversationRevisions.scope,
  ownerUserId: conversationRevisions.ownerUserId,
  accountId: conversationRevisions.accountId,
  vaultId: conversationRevisions.vaultId,
};

export interface ConversationMessagePayload {
  id: string;
  sessionId: string;
  role: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface ConversationWriteResult {
  adoptedLegacy: boolean;
  deletedCount: number;
  insertedCount: number;
  updatedCount: number;
}

/**
 * PostgreSQL text/json reject U+0000 (SQLSTATE 22P05 untranslatable_character).
 * Tool results, model text, and nested diagnostics can smuggle null bytes into
 * conversation payloads; strip them at the canonical write boundary so one
 * bad string cannot fail the whole session persist.
 */
export function sanitizeConversationPayloadForPostgres<T>(value: T): T {
  return sanitizeJsonValue(value) as T;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const sanitized = sanitizeJsonValue(entry);
      if (sanitized !== entry) changed = true;
      return sanitized;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    // Preserve Date and other non-plain objects as-is; conversation payloads are
    // plain JSON-serializable records.
    if (Object.getPrototypeOf(value) !== Object.prototype && !(value instanceof Object && value.constructor === Object)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      const sanitizedKey = key.includes("\u0000") ? key.replaceAll("\u0000", "") : key;
      const sanitized = sanitizeJsonValue(entry);
      if (sanitizedKey !== key || sanitized !== entry) changed = true;
      next[sanitizedKey] = sanitized;
    }
    return changed ? next : value;
  }
  return value;
}

export async function readConversationMessages(
  principal: Principal,
  sessionId: string,
): Promise<ConversationMessagePayload[]> {
  const messages: ConversationMessagePayload[] = [];
  let afterOrdinal = -1;
  while (true) {
    const rows = await db
      .select({ ordinal: conversationMessages.ordinal, payload: conversationMessages.payload })
      .from(conversationMessages)
      .where(combineWithVisibleScope(
        principal,
        messageScopeColumns,
        and(
          eq(conversationMessages.sessionId, sessionId),
          gt(conversationMessages.ordinal, afterOrdinal),
        ),
      ))
      .orderBy(asc(conversationMessages.ordinal))
      .limit(MESSAGE_PAGE_SIZE);
    for (const row of rows) messages.push(row.payload as ConversationMessagePayload);
    if (rows.length < MESSAGE_PAGE_SIZE) return messages;
    afterOrdinal = rows[rows.length - 1].ordinal;
  }
}

export async function hasCanonicalConversation(
  principal: Principal,
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .select({ revision: documentStoreDocuments.metadata })
    .from(documentStoreDocuments)
    .where(combineWithVisibleScope(
      principal,
      {
        scope: documentStoreDocuments.scope,
        ownerUserId: documentStoreDocuments.ownerUserId,
        accountId: documentStoreDocuments.accountId,
        vaultId: documentStoreDocuments.vaultId,
      },
      and(
        eq(documentStoreDocuments.documentType, "chat"),
        eq(documentStoreDocuments.documentId, sessionId),
      ),
    ))
    .limit(1);
  return rows.some((row) => {
    const metadata = row.revision as Record<string, unknown>;
    return metadata.conversationStorageVersion === 1;
  });
}

export async function deleteConversations(
  principal: Principal,
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return;
  await db.delete(conversationMessages).where(combineWithWritableScope(
    principal,
    messageScopeColumns,
    inArray(conversationMessages.sessionId, sessionIds),
  ));
  await db.delete(conversationRevisions).where(combineWithWritableScope(
    principal,
    revisionScopeColumns,
    inArray(conversationRevisions.sessionId, sessionIds),
  ));
}

export async function moveConversationToVault(
  principal: Principal,
  sessionId: string,
  vaultId: string,
): Promise<void> {
  await db.update(conversationMessages).set({ vaultId, updatedAt: new Date() }).where(
    combineWithWritableScope(
      principal,
      messageScopeColumns,
      eq(conversationMessages.sessionId, sessionId),
    ),
  );
  await db.update(conversationRevisions).set({ vaultId }).where(
    combineWithWritableScope(
      principal,
      revisionScopeColumns,
      eq(conversationRevisions.sessionId, sessionId),
    ),
  );
}

export async function writeConversationRevision(
  principal: Principal,
  input: {
    sessionId: string;
    vaultId: string;
    revision: number;
    messages: ConversationMessagePayload[];
  },
): Promise<ConversationWriteResult> {
  const previousMessages = await readConversationMessages(principal, input.sessionId);
  const ownerValues = ownedInsertValues(
    principal.activeVaultId === input.vaultId ? principal : { ...principal, activeVaultId: input.vaultId },
    messageScopeColumns,
  );
  const previousById = new Map(previousMessages.map((message, ordinal) => [message.id, { message, ordinal }]));
  const currentIds = new Set(input.messages.map((message) => message.id));
  const deletedIds = previousMessages
    .filter((message) => !currentIds.has(message.id))
    .map((message) => message.id);
  let insertedCount = 0;
  let updatedCount = 0;

  if (deletedIds.length > 0) {
    await db.delete(conversationMessages).where(combineWithWritableScope(
      principal,
      messageScopeColumns,
      and(
        eq(conversationMessages.sessionId, input.sessionId),
        inArray(conversationMessages.messageId, deletedIds),
      ),
    ));
  }

  for (let ordinal = 0; ordinal < input.messages.length; ordinal += 1) {
    const message = sanitizeConversationPayloadForPostgres(input.messages[ordinal]);
    const previous = previousById.get(message.id);
    if (!previous) {
      insertedCount += 1;
      await db.insert(conversationMessages).values({
        sessionId: input.sessionId,
        messageId: message.id,
        ordinal,
        role: message.role,
        payload: message,
        messageRevision: 1,
        sessionRevision: input.revision,
        ...ownerValues,
        createdByUserId: principal.userId ?? undefined,
        updatedByUserId: principal.userId ?? undefined,
        createdAt: new Date(message.createdAt),
        updatedAt: new Date(),
      });
      continue;
    }
    if (previous.ordinal === ordinal && JSON.stringify(previous.message) === JSON.stringify(message)) continue;
    updatedCount += 1;
    await db.update(conversationMessages).set({
      ordinal,
      role: message.role,
      payload: message,
      messageRevision: sql`${conversationMessages.messageRevision} + 1`,
      sessionRevision: input.revision,
      updatedByUserId: principal.userId ?? undefined,
      updatedAt: new Date(),
    }).where(combineWithWritableScope(
      principal,
      messageScopeColumns,
      and(
        eq(conversationMessages.sessionId, input.sessionId),
        eq(conversationMessages.messageId, message.id),
      ),
    ));
  }

  const revisionOwnerValues = ownedInsertValues(
    principal.activeVaultId === input.vaultId ? principal : { ...principal, activeVaultId: input.vaultId },
    revisionScopeColumns,
  );
  await db.insert(conversationRevisions).values({
    sessionId: input.sessionId,
    revision: input.revision,
    messageCount: input.messages.length,
    reason: previousMessages.length === 0 && input.messages.length > 0 ? "legacy_adoption" : "canonical_write",
    ...revisionOwnerValues,
    createdByUserId: principal.userId ?? undefined,
  }).onConflictDoNothing();

  return {
    adoptedLegacy: previousMessages.length === 0 && input.messages.length > 0,
    deletedCount: deletedIds.length,
    insertedCount,
    updatedCount,
  };
}
