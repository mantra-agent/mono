import { createLogger } from './log';
import { db } from './db';
import { pool } from './db';
import { accounts, connectedAccounts, emailMessages, emailSyncCursors, emailDismissals, emailSyncLog, emailEnrichments, emailDrafts, users } from '@shared/schema';
import { eq, and, sql, inArray, or, isNull } from 'drizzle-orm';
import { listGmailAccounts, listMessages, getMessage, getHistoryList, normalizeGmailMessage, getAccountLabelMap } from './gmail';
import type { NormalizedMessage } from './gmail';
import { storage } from './storage';
import { runWithPrincipal } from './principal-context';
import { sensitiveOwnershipValues } from './sensitive-scope';
import type { Principal } from './principal';

const log = createLogger("EmailSync");

const FULL_SYNC_CAP = 500;
const EMAIL_SYNC_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

type EmailPipelineAccountStatus = "healthy" | "stale" | "degraded" | "failed";
type EmailPipelineStage = "sync";

interface EmailAccountOwner {
  accountId: string;
  ownerUserId: string;
  principalAccountId: string;
  principal: Principal;
}

async function repairConnectedAccountOwnership(accountId: string): Promise<{ ownerUserId: string; principalAccountId: string } | null> {
  const [row] = await db.select({
    ownerUserId: users.id,
    principalAccountId: accounts.id,
  })
    .from(connectedAccounts)
    .innerJoin(users, eq(users.email, connectedAccounts.email))
    .innerJoin(accounts, and(eq(accounts.ownerUserId, users.id), eq(accounts.kind, 'personal')))
    .where(and(eq(connectedAccounts.accountId, accountId), eq(connectedAccounts.provider, 'google')))
    .limit(1);

  if (!row?.ownerUserId || !row?.principalAccountId) return null;

  await db.update(connectedAccounts)
    .set({
      ownerUserId: row.ownerUserId,
      principalAccountId: row.principalAccountId,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(eq(connectedAccounts.accountId, accountId), eq(connectedAccounts.provider, 'google')));

  log.warn(`[connectedAccountOwnershipBackfill] account=${accountId} ownerUserId=${row.ownerUserId} principalAccountId=${row.principalAccountId}`);
  return row;
}

async function resolveEmailAccountOwner(accountId: string): Promise<EmailAccountOwner> {
  let [account] = await db.select({
    accountId: connectedAccounts.accountId,
    ownerUserId: connectedAccounts.ownerUserId,
    principalAccountId: connectedAccounts.principalAccountId,
    provider: connectedAccounts.provider,
    vaultId: connectedAccounts.vaultId,
  })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.accountId, accountId), eq(connectedAccounts.provider, 'google')))
    .limit(1);

  if (!account) {
    throw new Error(`No connected Google account found for accountId=${accountId}`);
  }
  if (!account.vaultId) {
    throw new Error(`Connected Google account accountId=${accountId} requires a Vault assignment`);
  }
  if (!account.ownerUserId || !account.principalAccountId) {
    const repaired = await repairConnectedAccountOwnership(accountId);
    if (!repaired) {
      throw new Error(`Connected Google account accountId=${accountId} is missing sensitive ownership and could not be repaired`);
    }
    account = { ...account, ...repaired };
  }

  return {
    accountId,
    ownerUserId: account.ownerUserId,
    principalAccountId: account.principalAccountId,
    principal: {
      actorType: 'user',
      userId: account.ownerUserId,
      accountId: account.principalAccountId,
      role: 'owner',
      scopes: ['user:read', 'user:write'],
      permissions: [],
      visibleVaultIds: [account.vaultId],
      activeVaultId: account.vaultId,
      isAdmin: false,
      impersonation: {
        impersonatedByActorType: 'system',
        reason: 'email-sync connected account ownership',
      },
      source: 'system',
    },
  };
}

async function backfillEmailOwnership(accountId: string, owner: EmailAccountOwner): Promise<void> {
  const ownership = sensitiveOwnershipValues(owner.principal);
  const missingOwnership = or(isNull(emailMessages.ownerUserId), isNull(emailMessages.principalAccountId));
  const [messageRows, cursorRows, syncLogRows, enrichmentRows, dismissalRows, draftRows] = await Promise.all([
    db.update(emailMessages)
      .set({ ...ownership, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(emailMessages.accountId, accountId), missingOwnership!))
      .returning({ id: emailMessages.id }),
    db.update(emailSyncCursors)
      .set({ ...ownership, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(emailSyncCursors.accountId, accountId), or(isNull(emailSyncCursors.ownerUserId), isNull(emailSyncCursors.principalAccountId))!))
      .returning({ id: emailSyncCursors.id }),
    db.update(emailSyncLog)
      .set(ownership)
      .where(and(eq(emailSyncLog.accountId, accountId), or(isNull(emailSyncLog.ownerUserId), isNull(emailSyncLog.principalAccountId))!))
      .returning({ id: emailSyncLog.id }),
    db.update(emailEnrichments)
      .set({ ...ownership, updatedAt: new Date() })
      .where(and(eq(emailEnrichments.accountId, accountId), or(isNull(emailEnrichments.ownerUserId), isNull(emailEnrichments.principalAccountId))!))
      .returning({ id: emailEnrichments.id }),
    db.update(emailDismissals)
      .set(ownership)
      .where(and(eq(emailDismissals.accountId, accountId), or(isNull(emailDismissals.ownerUserId), isNull(emailDismissals.principalAccountId))!))
      .returning({ id: emailDismissals.id }),
    db.update(emailDrafts)
      .set({ ownerUserId: ownership.ownerUserId, accountId: ownership.accountId, updatedAt: new Date() })
      .where(and(eq(emailDrafts.accountId, accountId), isNull(emailDrafts.ownerUserId)))
      .returning({ id: emailDrafts.id }),
  ]);

  const total = messageRows.length + cursorRows.length + syncLogRows.length + enrichmentRows.length + dismissalRows.length + draftRows.length;
  if (total > 0) {
    log.warn(`[ownershipBackfill] account=${accountId} messages=${messageRows.length} cursors=${cursorRows.length} syncLogs=${syncLogRows.length} enrichments=${enrichmentRows.length} dismissals=${dismissalRows.length} drafts=${draftRows.length}`);
  }
}

export interface EmailPipelineAccountHealth {
  accountId: string;
  status: EmailPipelineAccountStatus;
  stage: EmailPipelineStage;
  healthy: boolean;
  stale: boolean;
  orphaned: boolean;
  lastGoodAt: string | null;
  lastAttemptAt: string | null;
  lastSyncAt: string | null;
  messagesCached: number;
  totalSynced: number;
  totalReconciled: number;
  currentError: string | null;
  error: string | null;
  staleDurationMinutes: number | null;
}

export interface EmailPipelineHealth {
  status: EmailPipelineAccountStatus;
  stage: EmailPipelineStage;
  lastGoodAt: string | null;
  lastAttemptAt: string | null;
  currentError: string | null;
  accounts: EmailPipelineAccountHealth[];
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function maxIso(values: Array<string | null>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!latest || new Date(value).getTime() > new Date(latest).getTime()) latest = value;
  }
  return latest;
}

function reducePipelineStatus(accounts: EmailPipelineAccountHealth[]): EmailPipelineAccountStatus {
  if (accounts.some(account => account.status === "failed")) return "failed";
  if (accounts.some(account => account.status === "degraded")) return "degraded";
  if (accounts.some(account => account.status === "stale")) return "stale";
  return "healthy";
}

export async function getEmailPipelineHealth(): Promise<EmailPipelineHealth> {
  const [cursors, health] = await Promise.all([
    db.select().from(emailSyncCursors),
    storage.getSyncHealth(),
  ]);
  const cursorByAccount = new Map(cursors.map(cursor => [cursor.accountId, cursor]));
  const accountIds = new Set<string>([
    ...cursors.map(cursor => cursor.accountId),
    ...health.map(account => account.accountId),
  ]);
  const now = Date.now();
  const accounts: EmailPipelineAccountHealth[] = Array.from(accountIds).sort().map(accountId => {
    const cursor = cursorByAccount.get(accountId);
    const rawHealth = health.find(account => account.accountId === accountId);
    const lastGoodAt = isoOrNull(rawHealth?.lastSuccess || cursor?.lastIncrementalSyncAt || cursor?.lastFullSyncAt || null);
    const lastAttemptAt = isoOrNull(cursor?.updatedAt || rawHealth?.lastSuccess || null);
    const lastGoodAge = lastGoodAt ? now - new Date(lastGoodAt).getTime() : null;
    const stale = lastGoodAge === null || lastGoodAge > EMAIL_SYNC_STALE_THRESHOLD_MS;
    const currentError = rawHealth?.lastError || (cursor?.lastSyncStatus === "error" ? cursor.lastSyncError || "Email sync failed" : null);
    const orphaned = rawHealth?.orphaned ?? false;
    const status: EmailPipelineAccountStatus = orphaned || currentError
      ? "failed"
      : stale
        ? "stale"
        : "healthy";
    return {
      accountId,
      status,
      stage: "sync",
      healthy: status === "healthy",
      stale,
      orphaned,
      lastGoodAt,
      lastAttemptAt,
      lastSyncAt: lastGoodAt,
      messagesCached: cursor?.messagesCached ?? rawHealth?.totalSynced ?? 0,
      totalSynced: rawHealth?.totalSynced ?? cursor?.messagesCached ?? 0,
      totalReconciled: rawHealth?.totalReconciled ?? 0,
      currentError,
      error: currentError,
      staleDurationMinutes: lastGoodAge === null ? null : Math.round(lastGoodAge / 60000),
    };
  });
  return {
    status: reducePipelineStatus(accounts),
    stage: "sync",
    lastGoodAt: maxIso(accounts.map(account => account.lastGoodAt)),
    lastAttemptAt: maxIso(accounts.map(account => account.lastAttemptAt)),
    currentError: accounts.find(account => account.currentError)?.currentError || null,
    accounts,
  };
}

async function upsertMessage(msg: NormalizedMessage): Promise<{ externallyArchived: boolean }> {
  let shouldProcessPeopleSignal = false;
  const existing = await db.select({
    id: emailMessages.id,
    isDone: emailMessages.isDone,
    triageTier: emailMessages.triageTier,
    providerThreadId: emailMessages.providerThreadId,
    direction: emailMessages.direction,
    fromAddress: emailMessages.fromAddress,
    subject: emailMessages.subject,
  }).from(emailMessages)
    .where(and(
      eq(emailMessages.provider, msg.provider),
      eq(emailMessages.accountId, msg.accountId),
      eq(emailMessages.providerMessageId, msg.providerMessageId),
    ))
    .limit(1);

  shouldProcessPeopleSignal = existing.length === 0 || existing[0]?.direction !== msg.direction;

  await db.insert(emailMessages).values({
    provider: msg.provider,
    accountId: msg.accountId,
    providerMessageId: msg.providerMessageId,
    providerThreadId: msg.providerThreadId,
    historyId: msg.historyId,
    subject: msg.subject,
    snippet: msg.snippet,
    fromAddress: msg.fromAddress,
    toAddresses: msg.toAddresses,
    ccAddresses: msg.ccAddresses,
    direction: msg.direction,
    date: msg.date,
    labelIds: msg.labelIds,
    bodyText: msg.bodyText,
    bodyHtml: msg.bodyHtml,
    isRead: msg.isRead,
    isStarred: msg.isStarred,
    ...sensitiveOwnershipValues(),
  }).onConflictDoUpdate({
    target: [emailMessages.provider, emailMessages.accountId, emailMessages.providerMessageId],
    set: {
      providerThreadId: msg.providerThreadId,
      historyId: msg.historyId,
      subject: msg.subject,
      snippet: msg.snippet,
      fromAddress: msg.fromAddress,
      toAddresses: msg.toAddresses,
      ccAddresses: msg.ccAddresses,
      direction: msg.direction,
      date: msg.date,
      labelIds: msg.labelIds,
      bodyText: msg.bodyText,
      bodyHtml: msg.bodyHtml,
      isRead: msg.isRead,
      isStarred: msg.isStarred,
      ...sensitiveOwnershipValues(),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    },
  });

  // Reflect external archive (Gmail / Superhuman "Done") in local triage state.
  // The universal signal is removal of the INBOX label (Superhuman's "Done"
  // calls Gmail's modify with removeLabelIds=['INBOX'], same as our own
  // archive path). Some Superhuman power-users additionally apply a
  // "superhuman/done" (or similar) user label — we honor that as well by
  // looking up the label names for this account and matching any label
  // whose name contains "done".
  const labels = msg.labelIds || [];
  const inInbox = labels.includes('INBOX');
  let hasExplicitDoneLabel = false;
  if (!inInbox && existing[0] && !existing[0].isDone) {
    try {
      const labelMap = await getAccountLabelMap(msg.accountId);
      for (const labelId of labels) {
        const name = labelMap.get(labelId);
        if (name && /(^|\/)done$|superhuman.*done/i.test(name)) {
          hasExplicitDoneLabel = true;
          break;
        }
      }
    } catch {
      // best-effort; INBOX-removal alone is enough to proceed
    }
  }
  if (!inInbox && existing[0] && !existing[0].isDone) {
    const row = existing[0];
    await db.update(emailMessages)
      .set({ isDone: true, doneReason: hasExplicitDoneLabel ? 'superhuman_done_in_gmail' : 'archived_in_gmail', doneAt: new Date(), updatedAt: new Date() })
      .where(eq(emailMessages.id, row.id));
    try {
      await db.insert(emailDismissals).values({
        messageId: row.id,
        providerThreadId: row.providerThreadId || msg.providerMessageId,
        accountId: msg.accountId,
        tier: row.triageTier || '',
        sender: row.fromAddress || msg.fromAddress || null,
        subject: row.subject || msg.subject || null,
        reason: hasExplicitDoneLabel
          ? 'Archived externally — Superhuman/Done label applied'
          : 'Archived externally (Gmail/Superhuman) — INBOX label removed',
        dismissedBy: 'external_archive',
        ...sensitiveOwnershipValues(),
      });
    } catch (err: any) {
      log.debug(`[upsertMessage] dismissal insert failed for msg=${row.id}: ${err.message}`);
    }
    return { externallyArchived: true };
  }

  if (shouldProcessPeopleSignal) {
    try {
      const { processEmailPeopleSignal } = await import('./email-people-signals');
      await processEmailPeopleSignal(msg, { source: 'email_sync' });
    } catch (err: any) {
      log.debug(`[upsertMessage] people signal processing failed for msg=${msg.providerMessageId}: ${err.message}`);
    }
  }

  return { externallyArchived: false };
}

async function getCursor(accountId: string) {
  const rows = await db.select().from(emailSyncCursors)
    .where(and(eq(emailSyncCursors.provider, 'gmail'), eq(emailSyncCursors.accountId, accountId)))
    .limit(1);
  return rows[0] || null;
}

async function upsertCursor(accountId: string, data: {
  historyId?: string | null;
  lastFullSyncAt?: Date;
  lastIncrementalSyncAt?: Date;
  lastSyncStatus: string;
  lastSyncError?: string | null;
  messagesCached?: number;
}): Promise<void> {
  await db.insert(emailSyncCursors).values({
    provider: 'gmail',
    accountId,
    ...sensitiveOwnershipValues(),
    historyId: data.historyId,
    lastFullSyncAt: data.lastFullSyncAt,
    lastIncrementalSyncAt: data.lastIncrementalSyncAt,
    lastSyncStatus: data.lastSyncStatus,
    lastSyncError: data.lastSyncError,
    messagesCached: data.messagesCached ?? 0,
  }).onConflictDoUpdate({
    target: [emailSyncCursors.provider, emailSyncCursors.accountId],
    set: {
      historyId: data.historyId !== undefined ? data.historyId : sql`email_sync_cursors.history_id`,
      lastFullSyncAt: data.lastFullSyncAt ?? sql`email_sync_cursors.last_full_sync_at`,
      lastIncrementalSyncAt: data.lastIncrementalSyncAt ?? sql`email_sync_cursors.last_incremental_sync_at`,
      lastSyncStatus: data.lastSyncStatus,
      lastSyncError: data.lastSyncError ?? null,
      messagesCached: data.messagesCached !== undefined ? data.messagesCached : sql`email_sync_cursors.messages_cached`,
      ...sensitiveOwnershipValues(),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    },
  });
}

async function fullSync(accountId: string): Promise<{ count: number; historyId: string | null }> {
  log.log(`[fullSync] Starting full sync for account=${accountId} cap=${FULL_SYNC_CAP}`);

  const stubs = await listMessages(undefined, FULL_SYNC_CAP, accountId, { paginate: true, paginationCap: FULL_SYNC_CAP });
  log.log(`[fullSync] account=${accountId} fetched ${stubs.length} message stubs`);

  let synced = 0;
  let failed = 0;
  let lastError = "";
  let latestHistoryId: string | null = null;

  for (const stub of stubs) {
    if (!stub.id) continue;
    try {
      const raw = await getMessage(stub.id, 'full', accountId);
      const normalized = normalizeGmailMessage(raw, accountId);
      await upsertMessage(normalized);
      if (raw.historyId && (!latestHistoryId || BigInt(raw.historyId) > BigInt(latestHistoryId))) {
        latestHistoryId = raw.historyId;
      }
      synced++;
    } catch (err: any) {
      failed++;
      lastError = err.message;
    }
  }

  if (failed > 0) {
    log.warn(`[fullSync] account=${accountId} failed=${failed}/${stubs.length} lastError=${lastError}`);
  }
  log.log(`[fullSync] account=${accountId} synced=${synced} latestHistoryId=${latestHistoryId}`);
  return { count: synced, historyId: latestHistoryId };
}

async function incrementalSync(accountId: string, startHistoryId: string): Promise<{ count: number; historyId: string | null }> {
  log.log(`[incrementalSync] account=${accountId} startHistoryId=${startHistoryId}`);

  const { history, historyId: newHistoryId } = await getHistoryList(startHistoryId, accountId);

  const messageIds = new Set<string>();
  for (const record of history) {
    const added = record.messagesAdded || [];
    const labelAdded = record.labelsAdded || [];
    const labelRemoved = record.labelsRemoved || [];
    for (const item of [...added, ...labelAdded, ...labelRemoved]) {
      if (item.message?.id) messageIds.add(item.message.id);
    }
  }

  log.log(`[incrementalSync] account=${accountId} history records=${history.length} unique messages=${messageIds.size}`);

  let synced = 0;
  let failed = 0;
  let skipped404 = 0;
  let externallyArchived = 0;
  let lastError = "";
  for (const msgId of messageIds) {
    try {
      const raw = await getMessage(msgId, 'full', accountId);
      const normalized = normalizeGmailMessage(raw, accountId);
      const result = await upsertMessage(normalized);
      if (result.externallyArchived) externallyArchived++;
      synced++;
    } catch (err: any) {
      if (err?.code === 404 || err?.status === 404) {
        skipped404++;
      } else {
        failed++;
        lastError = err.message;
      }
    }
  }

  if (failed > 0) {
    log.warn(`[incrementalSync] account=${accountId} failed=${failed}/${messageIds.size} lastError=${lastError}`);
  }
  if (skipped404 > 0) {
    log.debug(`[incrementalSync] account=${accountId} skipped ${skipped404} deleted/not-found messages`);
  }
  if (externallyArchived > 0) {
    log.log(`[incrementalSync] account=${accountId} marked ${externallyArchived} externally-archived messages as done`);
  }
  log.log(`[incrementalSync] account=${accountId} synced=${synced} newHistoryId=${newHistoryId}`);
  return { count: synced, historyId: newHistoryId };
}

const RECONCILE_PER_RUN_CAP = 500;
const RECONCILE_CONCURRENCY = 8;

type AttentionClearReason = 'archived_in_gmail' | 'deleted_in_gmail' | 'spam_in_gmail' | 'replied_in_gmail';

function classifyGmailClearReason(labels: string[]): AttentionClearReason | null {
  if (labels.includes('TRASH')) return 'deleted_in_gmail';
  if (labels.includes('SPAM')) return 'spam_in_gmail';
  if (!labels.includes('INBOX')) return 'archived_in_gmail';
  return null;
}

function reasonText(reason: AttentionClearReason): string {
  switch (reason) {
    case 'deleted_in_gmail': return 'Reconciled — deleted in Gmail';
    case 'spam_in_gmail': return 'Reconciled — marked spam in Gmail';
    case 'replied_in_gmail': return 'Reconciled — Ray replied in Gmail';
    case 'archived_in_gmail':
    default: return 'Reconciled — no longer in Gmail inbox';
  }
}

async function markMessagesDone(messageIds: number[], reason: AttentionClearReason): Promise<number> {
  if (messageIds.length === 0) return 0;
  await db.update(emailMessages)
    .set({ isDone: true, doneReason: reason, doneAt: new Date(), updatedAt: new Date() })
    .where(inArray(emailMessages.id, messageIds));

  const rows = await db.select({
    id: emailMessages.id,
    providerThreadId: emailMessages.providerThreadId,
    providerMessageId: emailMessages.providerMessageId,
    accountId: emailMessages.accountId,
    triageTier: emailMessages.triageTier,
    fromAddress: emailMessages.fromAddress,
    subject: emailMessages.subject,
  }).from(emailMessages).where(inArray(emailMessages.id, messageIds));

  await Promise.all(rows.map(row => db.insert(emailDismissals).values({
    messageId: row.id,
    providerThreadId: row.providerThreadId || row.providerMessageId,
    accountId: row.accountId,
    tier: row.triageTier || '',
    sender: row.fromAddress || null,
    subject: row.subject || null,
    reason: reasonText(reason),
    dismissedBy: reason,
    ...sensitiveOwnershipValues(),
  }).catch((err: any) => {
    log.debug(`[reconcile] dismissal insert failed for msg=${row.id}: ${err.message}`);
  })));
  return rows.length;
}

async function reconcileReplies(accountId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT inbound.id
    FROM email_messages inbound
    JOIN (
      SELECT provider_thread_id, MAX(date) AS latest_outbound_at
      FROM email_messages
      WHERE account_id = ${accountId}
        AND direction = 'outbound'
        AND provider_thread_id IS NOT NULL
        AND date IS NOT NULL
      GROUP BY provider_thread_id
    ) outbound ON outbound.provider_thread_id = inbound.provider_thread_id
    WHERE inbound.account_id = ${accountId}
      AND inbound.direction <> 'outbound'
      AND inbound.is_done = false
      AND inbound.triage_status != 'untriaged'
      AND inbound.date IS NOT NULL
      AND inbound.date < outbound.latest_outbound_at
  `);
  const ids = rows.rows.map((row: any) => Number(row.id)).filter(Number.isFinite);
  return markMessagesDone(ids, 'replied_in_gmail');
}

async function reconcileEmailAttentionState(accountId: string): Promise<number> {
  const candidates = await storage.getOpenCachedMessagesForReconcile(accountId, RECONCILE_PER_RUN_CAP);
  if (candidates.length === 0) {
    log.debug(`[reconcile] account=${accountId} no open messages to reconcile`);
    return reconcileReplies(accountId);
  }

  log.log(`[reconcile] account=${accountId} checking Gmail attention state for ${candidates.length} cached open messages`);

  let reconciled = 0;
  let checked = 0;
  let errors = 0;
  const stillOpenIds: number[] = [];
  const toClear = new Map<AttentionClearReason, number[]>();

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < candidates.length) {
      const idx = cursor++;
      const msg = candidates[idx];
      try {
        const meta = await getMessage(msg.providerMessageId, 'metadata', accountId);
        checked++;
        const labels = (meta?.labelIds || []) as string[];
        const reason = classifyGmailClearReason(labels);
        if (reason) {
          const list = toClear.get(reason) || [];
          list.push(msg.id);
          toClear.set(reason, list);
        } else {
          stillOpenIds.push(msg.id);
        }
      } catch (err: any) {
        if (err?.code === 404 || err?.status === 404) {
          const list = toClear.get('deleted_in_gmail') || [];
          list.push(msg.id);
          toClear.set('deleted_in_gmail', list);
        } else {
          errors++;
          log.debug(`[reconcile] account=${accountId} msg=${msg.id} err=${err?.message}`);
          stillOpenIds.push(msg.id);
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(RECONCILE_CONCURRENCY, candidates.length) }, () => worker());
  await Promise.all(workers);

  for (const [reason, ids] of toClear.entries()) {
    reconciled += await markMessagesDone(ids, reason);
  }
  reconciled += await reconcileReplies(accountId);

  if (stillOpenIds.length > 0) {
    await storage.touchOpenCachedMessages(stillOpenIds).catch(err => {
      log.debug(`[reconcile] account=${accountId} touch failed: ${err.message}`);
    });
  }

  log.log(`[reconcile] account=${accountId} checked=${checked} reconciled=${reconciled} errors=${errors} (cap=${RECONCILE_PER_RUN_CAP})`);
  return reconciled;
}

async function syncAccount(accountId: string): Promise<{ ok: boolean; error?: string }> {
  const owner = await resolveEmailAccountOwner(accountId);
  return runWithPrincipal(owner.principal, async () => syncAccountForOwner(accountId, owner));
}

async function syncAccountForOwner(accountId: string, owner: EmailAccountOwner): Promise<{ ok: boolean; error?: string }> {
  await backfillEmailOwnership(accountId, owner);
  const syncLog = await storage.recordSyncStart(accountId);
  const runLabel = `syncId=${syncLog.id} account=${accountId}`;
  const cursor = await getCursor(accountId);
  const isFullSync = !cursor?.historyId;
  const previousHistoryId = cursor?.historyId || null;

  log.log(`[syncAccount] ${runLabel} stage=started mode=${isFullSync ? "full" : "incremental"} previousHistoryId=${previousHistoryId || "none"}`);

  try {
    let result: { count: number; historyId: string | null };
    let mode: "full" | "incremental" | "full_resync" = isFullSync ? "full" : "incremental";

    if (isFullSync) {
      result = await fullSync(accountId);
      if (result.count === 0) {
        log.warn(`[syncAccount] ${runLabel} stage=messages_cached mode=full cached=0 warning=empty_full_sync`);
      }
    } else {
      try {
        result = await incrementalSync(accountId, cursor.historyId!);
      } catch (err: any) {
        if (err?.code !== 404) throw err;
        mode = "full_resync";
        log.warn(`[syncAccount] ${runLabel} stage=history_expired previousHistoryId=${previousHistoryId} fallback=full_resync`);
        result = await fullSync(accountId);
        if (result.count === 0) {
          log.warn(`[syncAccount] ${runLabel} stage=messages_cached mode=full_resync cached=0 warning=empty_resync`);
        }
      }
    }

    const countRes = await pool.query(
      `SELECT COUNT(*) as cnt FROM email_messages WHERE account_id = $1`,
      [accountId]
    );
    const totalCached = parseInt(countRes.rows[0]?.cnt || '0');
    log.log(`[syncAccount] ${runLabel} stage=messages_cached mode=${mode} discovered=${result.count} totalCached=${totalCached} newHistoryId=${result.historyId || previousHistoryId || "none"}`);

    const reconciled = await reconcileEmailAttentionState(accountId).catch(err => {
      log.warn(`[syncAccount] ${runLabel} stage=attention_reconcile warning=${err.message}`);
      return 0;
    });
    log.log(`[syncAccount] ${runLabel} stage=attention_reconciled reconciled=${reconciled}`);

    const nextHistoryId = result.historyId || previousHistoryId;
    await upsertCursor(accountId, {
      historyId: nextHistoryId,
      lastFullSyncAt: mode === "incremental" ? undefined : new Date(),
      lastIncrementalSyncAt: mode === "incremental" ? new Date() : undefined,
      lastSyncStatus: mode === "full_resync" ? "success_after_resync" : "success",
      messagesCached: totalCached,
    });
    await storage.recordSyncComplete(syncLog.id, result.count, nextHistoryId || undefined, reconciled);
    log.log(`[syncAccount] ${runLabel} stage=completed status=success mode=${mode} cursorAdvanced=${nextHistoryId ? "yes" : "no"} cursorState=${nextHistoryId || "none"} messagesSynced=${result.count} reconciled=${reconciled} totalCached=${totalCached}`);
    return { ok: true };
  } catch (err: any) {
    log.error(`[syncAccount] ${runLabel} stage=failed error=${err.message}`);
    await upsertCursor(accountId, {
      lastSyncStatus: 'error',
      lastSyncError: err.message,
    });
    await storage.recordSyncError(syncLog.id, err.message);
    return { ok: false, error: err.message };
  }
}

export async function runEmailSync(): Promise<{ accountsSynced: number; errors: string[] }> {
  log.log(`[runEmailSync] Starting email sync cycle`);
  const accounts = await listGmailAccounts();

  if (accounts.length === 0) {
    log.log(`[runEmailSync] No Gmail accounts connected, skipping sync`);
    return { accountsSynced: 0, errors: [] };
  }

  const errors: string[] = [];
  let synced = 0;

  for (const account of accounts) {
    try {
      const result = await syncAccount(account.id);
      if (result.ok) {
        synced++;
      } else {
        errors.push(`account=${account.id}: ${result.error || "Email sync failed"}`);
      }
    } catch (err: any) {
      const msg = `account=${account.id}: ${err.message}`;
      log.error(`[runEmailSync] ${msg}`);
      errors.push(msg);
    }
  }

  log.log(`[runEmailSync] Completed: ${synced}/${accounts.length} accounts synced, ${errors.length} errors`);
  return { accountsSynced: synced, errors };
}

export async function getSyncStatus() {
  const health = await getEmailPipelineHealth();
  const orphanedAccounts = health.accounts.filter(account => account.orphaned);
  return {
    status: health.status,
    stage: health.stage,
    lastGoodAt: health.lastGoodAt,
    lastAttemptAt: health.lastAttemptAt,
    currentError: health.currentError,
    accounts: health.accounts.map(account => ({
      accountId: account.accountId,
      lastSyncAt: account.lastSyncAt,
      messagesCached: account.messagesCached,
      healthy: account.healthy,
      status: account.status,
      stage: account.stage,
      error: account.error,
      currentError: account.currentError,
      stale: account.stale,
      orphaned: account.orphaned,
      lastGoodAt: account.lastGoodAt,
      lastAttemptAt: account.lastAttemptAt,
      totalSynced: account.totalSynced,
      totalReconciled: account.totalReconciled,
      staleDurationMinutes: account.staleDurationMinutes,
    })),
    orphanedAccounts,
  };
}
