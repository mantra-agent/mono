import type { ToolHandlerResult } from "../contracts";
import { createLogger } from "../../log";
import { gmailInput, parseCachedEmailMessageId, rejectInvalidCachedEmailMessageId } from "./gmail-boundary";

const log = createLogger("EmailCache");
const VALID_TIERS = new Set(["🔴", "🟡", "🟢", "📋", "🗑️", "respond_now", "respond_today", "acknowledge", "fyi", "noise"]);
const TIER_NORMALIZE: Record<string, string> = { respond_now: "🔴", respond_today: "🟡", acknowledge: "🟢", fyi: "📋", noise: "🗑️" };

export async function handleGmailMailboxWrite(args: Record<string, any>): Promise<ToolHandlerResult | null> {
  const subAction = args.cache_action || "get_untriaged";
  if (!["mark_triaged", "store_enrichment"].includes(subAction)) return null;
  if (subAction === "mark_triaged") return markTriaged(args);
  return storeEnrichment(args);
}

async function markTriaged(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { storage } = await import("../../storage");
  const entries: Array<{ cacheId: number; tier: string; reason: string }> = args.entries;
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return gmailInput("Missing or empty 'entries' array. Each entry needs: cacheId, tier, reason.", "missing_entries");
  }
  for (const entry of entries) {
    if (!entry.cacheId || !entry.tier) return gmailInput(`Invalid entry — each needs cacheId and tier. Got: ${JSON.stringify(entry)}`, "invalid_entry");
    if (!VALID_TIERS.has(entry.tier)) return gmailInput(`Invalid tier "${entry.tier}". Valid: 🔴, 🟡, 🟢, 📋, 🗑️ (or respond_now, respond_today, acknowledge, fyi, noise)`, "invalid_tier");
    entry.tier = TIER_NORMALIZE[entry.tier] || entry.tier;
  }
  const dismissed = await storage.batchUpdateEmailTriageState(entries.map((entry) => ({ id: entry.cacheId, tier: entry.tier, reason: entry.reason || "" })));
  if (dismissed.length > 0) {
    const { archiveEmail } = await import("../../gmail");
    for (const email of dismissed) await archiveEmail(email.accountId, email.providerMessageId).catch(() => {});
  }
  const triageLogEntries = [];
  for (const entry of entries) {
    const cached = await storage.getCachedEmailById(entry.cacheId);
    if (cached) triageLogEntries.push({
      gmailMessageId: cached.providerMessageId,
      accountId: cached.accountId,
      cachedMessageId: cached.id,
      tier: entry.tier,
      senderEmail: cached.fromAddress || null,
      subject: cached.subject || null,
    });
  }
  if (triageLogEntries.length > 0) await storage.recordTriagedEmails(triageLogEntries);
  let importQueued = 0;
  let interactionsLogged = 0;
  try {
    const { processEmailPeopleSignals, fromCachedEmail } = await import("../../email-people-signals");
    const cachedRows = [];
    const tierByMessageId = new Map<number, { tier: string; reason?: string }>();
    for (const entry of entries) {
      const cached = await storage.getCachedEmailById(entry.cacheId);
      if (!cached) continue;
      cachedRows.push(fromCachedEmail(cached as any));
      tierByMessageId.set(cached.id, { tier: entry.tier, reason: entry.reason || "" });
    }
    const peopleResult = await processEmailPeopleSignals(cachedRows, { source: "email_triage", tierByMessageId });
    importQueued = peopleResult.importQueued;
    interactionsLogged = peopleResult.interactionsLogged;
  } catch (error: any) {
    log.debug(`mark_triaged: people signal error (non-fatal): ${error.message}`);
  }
  const { triageJob } = await import("../../triage-job-state");
  if (triageJob.status === "running") {
    triageJob.processed += entries.length;
    triageJob.triaged += entries.length;
  }
  log.debug(`mark_triaged: updated ${entries.length} emails, recorded ${triageLogEntries.length} audit log entries, queued ${importQueued} imports, logged ${interactionsLogged} interactions`);
  return { result: `Marked ${entries.length} email(s) as triaged and recorded audit log entries.${importQueued > 0 ? ` Queued ${importQueued} unknown sender(s) for import review.` : ""}${interactionsLogged > 0 ? ` Logged ${interactionsLogged} interaction(s) on matched people.` : ""}` };
}

async function storeEnrichment(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { storage } = await import("../../storage");
  const { thread_id, account_id, message_id, summary, decisions, actions, dismissed, dismiss_reason, model, tokens_used } = args;
  if (!thread_id || !account_id || message_id == null || message_id === "") {
    return gmailInput("Missing required thread_id, account_id, or message_id.", "missing_enrichment_ids");
  }
  const cachedMessageId = parseCachedEmailMessageId(message_id);
  if (cachedMessageId == null) return rejectInvalidCachedEmailMessageId(message_id);
  const sourceEmail = await storage.getCachedEmailById(cachedMessageId);
  if (!sourceEmail) return gmailInput(`Email message ${cachedMessageId} not found.`, "message_not_found");
  const sourceThreadId = sourceEmail.providerThreadId || sourceEmail.providerMessageId;
  if (sourceThreadId !== thread_id || sourceEmail.accountId !== account_id) {
    return gmailInput("Email enrichment identity does not match the visible source message.", "enrichment_identity_mismatch");
  }
  const neverDismissTiers = new Set(["🟡", "🔴"]);
  let shouldDismiss = !!dismissed;
  const { db } = await import("../../db");
  const { emailMessages } = await import("@shared/schema");
  const { and: andOp, eq: eqOp, gt: gtOp, inArray: inArrayOp } = await import("drizzle-orm");
  const { combineWithSensitiveVisible } = await import("../../sensitive-scope");
  const emailScope = { ownerUserId: emailMessages.ownerUserId, principalAccountId: emailMessages.principalAccountId, vaultId: emailMessages.vaultId };
  const importantThreadMessages = await db.select({ id: emailMessages.id, triageTier: emailMessages.triageTier })
    .from(emailMessages)
    .where(combineWithSensitiveVisible(emailScope, andOp(
      eqOp(emailMessages.providerThreadId, thread_id),
      eqOp(emailMessages.accountId, account_id),
      eqOp(emailMessages.direction, "inbound"),
      eqOp(emailMessages.triageStatus, "triaged"),
      inArrayOp(emailMessages.triageTier, Array.from(neverDismissTiers)),
    )))
    .limit(1);
  if (importantThreadMessages.length > 0) {
    shouldDismiss = false;
    if (dismissed) log.debug(`store_enrichment: SAFETY RAIL — blocked dismissal of important email thread=${thread_id} tier=${importantThreadMessages[0].triageTier}`);
  }
  let normalizedActions = Array.isArray(actions) ? actions : null;
  if (normalizedActions) {
    const email = await storage.getCachedEmailById(cachedMessageId);
    if (email?.providerThreadId && email.date) {
      const outbound = await db.select({ id: emailMessages.id })
        .from(emailMessages)
        .where(combineWithSensitiveVisible(emailScope, andOp(
          eqOp(emailMessages.providerThreadId, email.providerThreadId),
          eqOp(emailMessages.accountId, email.accountId),
          eqOp(emailMessages.direction, "outbound"),
          gtOp(emailMessages.date, email.date),
        )))
        .limit(1);
      if (outbound.length > 0) {
        const before = normalizedActions.length;
        normalizedActions = normalizedActions.filter((action: string) => !/\b(reply|respond|response|follow up|follow-up)\b/i.test(String(action)));
        if (normalizedActions.length !== before) log.debug(`store_enrichment: removed stale reply/follow-up action(s) for replied thread=${thread_id}`);
      }
    }
  }
  await storage.upsertEmailEnrichment({
    providerThreadId: thread_id,
    accountId: account_id,
    messageId: cachedMessageId,
    summary: summary || null,
    decisions: decisions || null,
    actions: normalizedActions,
    dismissed: shouldDismiss,
    dismissReason: dismiss_reason || null,
    model: model || null,
    tokensUsed: tokens_used || null,
  });
  if (shouldDismiss) {
    const email = await storage.getCachedEmailById(cachedMessageId);
    if (email) {
      await storage.markEmailDone(cachedMessageId, true);
      await storage.recordEmailDismissal({
        messageId: cachedMessageId,
        providerThreadId: thread_id,
        accountId: account_id,
        tier: email.triageTier || null,
        sender: email.fromAddress || null,
        subject: email.subject || null,
        reason: dismiss_reason || "LLM-dismissed via enrichment",
        dismissedBy: "auto_enrich",
      });
    }
  }
  return { result: `Enrichment stored for thread=${thread_id}${shouldDismiss ? " (dismissed)" : ""}.` };
}
