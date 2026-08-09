import { and, asc, desc, eq, lt, sql } from "drizzle-orm";

import { conversationMessages } from "@shared/models/chat";
import type { FileMessage } from "./chat-file-storage";
import { db, getAmbientDatabaseTransaction } from "./db";
import { requireCurrentUserPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

const messageScopeColumns = {
  scope: conversationMessages.scope,
  ownerUserId: conversationMessages.ownerUserId,
  accountId: conversationMessages.accountId,
  vaultId: conversationMessages.vaultId,
};

export interface ConversationMessagePage {
  messages: FileMessage[];
  nextBeforeOrdinal: number | null;
}

/**
 * Canonical durable message mutation. Call only inside the chat document
 * transaction after the session advisory lock is held.
 */
export async function replaceConversationMessages(
  documentStoreId: number,
  sessionId: string,
  vaultId: string,
  durableRevision: number,
  messages: FileMessage[],
): Promise<void> {
  const transaction = getAmbientDatabaseTransaction();
  if (!transaction) throw new Error("Conversation message writes require the canonical session transaction");
  const principal = requireCurrentUserPrincipal();
  const ownership = ownedInsertValues(principal, messageScopeColumns);
  if (!ownership.ownerUserId || !ownership.accountId) {
    throw new Error(`Conversation message ownership is incomplete: ${sessionId}`);
  }

  const existingRows = await transaction
    .select({
      messageId: conversationMessages.messageId,
      ordinal: conversationMessages.ordinal,
      payload: conversationMessages.payload,
      runId: conversationMessages.runId,
      turnId: conversationMessages.turnId,
      assistantAttemptId: conversationMessages.assistantAttemptId,
    })
    .from(conversationMessages)
    .where(combineWithWritableScope(
      principal,
      messageScopeColumns,
      eq(conversationMessages.sessionId, sessionId),
    ))
    .orderBy(asc(conversationMessages.ordinal));
  const existingById = new Map(existingRows.map((row) => [row.messageId, row]));
  const requiresReorder = existingRows.some((row, ordinal) => messages[ordinal]?.id !== row.messageId);
  if (requiresReorder) {
    await transaction
      .update(conversationMessages)
      .set({ ordinal: sql`${conversationMessages.ordinal} + 1000000000` })
      .where(combineWithWritableScope(
        principal,
        messageScopeColumns,
        eq(conversationMessages.sessionId, sessionId),
      ));
  }

  const changedMessages = messages.flatMap((message, ordinal) => {
    const existing = existingById.get(message.id);
    const runId = message.assistantRunId ?? null;
    const turnId = message.turnId ?? message.voice?.turnId ?? null;
    const assistantAttemptId = message.voice?.turnKey ?? message.assistantRunId ?? null;
    const changed = !existing || requiresReorder ||
      existing.ordinal !== ordinal ||
      existing.runId !== runId ||
      existing.turnId !== turnId ||
      existing.assistantAttemptId !== assistantAttemptId ||
      JSON.stringify(existing.payload) !== JSON.stringify(message);
    return changed ? [{ message, ordinal, runId, turnId, assistantAttemptId }] : [];
  });

  if (changedMessages.length > 0) {
    await transaction
      .insert(conversationMessages)
      .values(changedMessages.map(({ message, ordinal, runId, turnId, assistantAttemptId }) => ({
        documentStoreId,
        sessionId,
        messageId: message.id,
        runId,
        turnId,
        assistantAttemptId,
        ordinal,
        durableRevision,
        payload: message,
        ...ownership,
        vaultId,
        createdByUserId: principal.userId,
        updatedByUserId: principal.userId,
        createdAt: new Date(message.createdAt),
        updatedAt: new Date(),
      })))
      .onConflictDoUpdate({
        target: [
          conversationMessages.ownerUserId,
          conversationMessages.accountId,
          conversationMessages.sessionId,
          conversationMessages.messageId,
        ],
        set: {
          ordinal: sql`excluded.ordinal`,
          durableRevision: sql`excluded.durable_revision`,
          payload: sql`excluded.payload`,
          vaultId: sql`excluded.vault_id`,
          updatedByUserId: principal.userId,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  }

  const retainedIds = messages.map((message) => message.id);
  await transaction
    .delete(conversationMessages)
    .where(combineWithWritableScope(
      principal,
      messageScopeColumns,
      and(
        eq(conversationMessages.sessionId, sessionId),
        retainedIds.length > 0
          ? sql`${conversationMessages.messageId} NOT IN (${sql.join(retainedIds.map((id) => sql`${id}`), sql`, `)})`
          : sql`TRUE`,
      ),
    ));
}

export async function loadConversationMessages(sessionId: string): Promise<FileMessage[]> {
  const principal = requireCurrentUserPrincipal();
  const rows = await db
    .select({ payload: conversationMessages.payload })
    .from(conversationMessages)
    .where(combineWithVisibleScope(
      principal,
      messageScopeColumns,
      eq(conversationMessages.sessionId, sessionId),
    ))
    .orderBy(asc(conversationMessages.ordinal));
  return rows.map((row) => row.payload as FileMessage);
}

export async function pageConversationMessages(
  sessionId: string,
  options: { beforeOrdinal?: number; limit?: number } = {},
): Promise<ConversationMessagePage> {
  const principal = requireCurrentUserPrincipal();
  const limit = Math.min(Math.max(Math.floor(options.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const before = Number.isSafeInteger(options.beforeOrdinal) && (options.beforeOrdinal ?? 0) >= 0
    ? options.beforeOrdinal
    : undefined;
  const rows = await db
    .select({ ordinal: conversationMessages.ordinal, payload: conversationMessages.payload })
    .from(conversationMessages)
    .where(combineWithVisibleScope(
      principal,
      messageScopeColumns,
      and(
        eq(conversationMessages.sessionId, sessionId),
        before === undefined ? undefined : lt(conversationMessages.ordinal, before),
      ),
    ))
    .orderBy(desc(conversationMessages.ordinal))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return {
    messages: page.map((row) => row.payload as FileMessage),
    nextBeforeOrdinal: hasMore && page.length > 0 ? page[0].ordinal : null,
  };
}
