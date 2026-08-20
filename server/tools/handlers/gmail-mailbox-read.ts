import type { ToolHandlerResult } from "../contracts";
import { createLogger } from "../../log";
import { safeStringify } from "../../utils/safe-stringify";
import { gmailInput, parseCachedEmailMessageId, rejectInvalidCachedEmailMessageId } from "./gmail-boundary";

const log = createLogger("EmailCache");

export async function handleGmailMailboxRead(args: Record<string, any>): Promise<ToolHandlerResult | null> {
  const subAction = args.cache_action || "get_untriaged";
  if (!["get_untriaged", "search", "get_unenriched", "resolve", "get_thread", "get_message"].includes(subAction)) return null;
  const { storage } = await import("../../storage");

  if (subAction === "get_untriaged") {
    const limit = Math.min(args.limit || 5000, 5000);
    const emails = await storage.getUntriagedCachedEmails(limit);
    log.debug(`get_untriaged returned ${emails.length} emails`);
    const { triageJob } = await import("../../triage-job-state");
    if (triageJob.status === "running") triageJob.total = emails.length;
    if (emails.length === 0) return { result: "No untriaged emails in the cache." };
    const lines = emails.map((email) => {
      const from = email.fromAddress || "unknown";
      const date = email.date ? new Date(email.date).toISOString().slice(0, 16) : "unknown";
      const snippet = email.snippet ? ` — ${email.snippet.slice(0, 120)}` : "";
      return `### [${email.accountId}] ${email.subject || "(no subject)"}\n- **Cache ID:** ${email.id}\n- **Provider ID:** ${email.providerMessageId}\n- **From:** ${from}\n- **Date:** ${date}\n- **Account:** ${email.accountId}${snippet}${email.bodyText ? `\n\n**Body:**\n${email.bodyText.slice(0, 2000)}` : ""}`;
    });
    return { result: `${emails.length} untriaged cached emails:\n\n${lines.join("\n\n---\n\n")}` };
  }

  if (subAction === "search") {
    const query = args.query;
    if (!query || typeof query !== "string") return gmailInput("Missing 'query' string parameter for search action.", "missing_search_query");
    const days = Math.max(1, Math.min(args.days || 7, 90));
    const searchLimit = Math.max(1, Math.min(args.limit || 20, 100));
    const { db } = await import("../../db");
    const { emailMessages } = await import("@shared/schema");
    const { and: andOp, or: orOp, desc: descOp, gte: gteOp, ilike: ilikeOp } = await import("drizzle-orm");
    const { combineWithSensitiveVisible } = await import("../../sensitive-scope");
    const emailScope = { ownerUserId: emailMessages.ownerUserId, principalAccountId: emailMessages.principalAccountId, vaultId: emailMessages.vaultId };
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const pattern = `%${query}%`;
    const results = await db.select().from(emailMessages)
      .where(combineWithSensitiveVisible(emailScope, andOp(
        gteOp(emailMessages.date, since),
        orOp(
          ilikeOp(emailMessages.subject, pattern),
          ilikeOp(emailMessages.fromAddress, pattern),
          ilikeOp(emailMessages.toAddresses, pattern),
          ilikeOp(emailMessages.ccAddresses, pattern),
        ),
      )))
      .orderBy(descOp(emailMessages.date))
      .limit(searchLimit);
    if (results.length === 0) return { result: `No emails matching "${query}" in the last ${days} days.` };
    const lines = results.map((email) => {
      const direction = email.direction === "outbound" ? "Sent to" : "Received from";
      const participant = email.direction === "outbound" ? (email.toAddresses || email.ccAddresses || "unknown") : (email.fromAddress || "unknown");
      const date = email.date ? new Date(email.date).toISOString().slice(0, 16) : "unknown";
      const tier = email.triageTier ? ` [${email.triageTier}]` : "";
      return `- **${email.subject || "(no subject)"}** ${direction} ${participant} (${date})${tier} — ID: ${email.id}`;
    });
    return { result: `${results.length} email(s) matching "${query}" (last ${days} days):\n${lines.join("\n")}` };
  }

  if (subAction === "get_unenriched") {
    const unenriched = await storage.getUnenrichedTriagedEmails(30);
    if (unenriched.length === 0) return { result: "No unenriched triaged emails found." };
    const threadMap = new Map<string, typeof unenriched>();
    for (const email of unenriched) {
      const threadId = email.providerThreadId || email.providerMessageId;
      if (!threadMap.has(threadId)) threadMap.set(threadId, []);
      threadMap.get(threadId)!.push(email);
    }
    const threads = Array.from(threadMap.entries()).map(([threadId, messages]) => {
      const latest = messages[messages.length - 1];
      return {
        threadId,
        accountId: latest.accountId,
        messageCount: messages.length,
        latestMessageId: latest.id,
        subject: latest.subject || "(no subject)",
        sender: latest.fromAddress || "unknown",
        tier: latest.triageTier || "unknown",
        reason: latest.triageReason || "",
        date: latest.date ? new Date(latest.date).toISOString() : "unknown",
        snippet: latest.snippet || "",
        body: latest.bodyText ? latest.bodyText.slice(0, 800) : "",
      };
    });
    return { result: safeStringify({ threads, count: threads.length }, { label: "bridge.gmail.threads" }) };
  }

  if (subAction === "resolve" || subAction === "get_thread") return resolveThread(args);
  return getMessage(args);
}

async function resolveThread(args: Record<string, any>): Promise<ToolHandlerResult> {
  const rawRef = String(args.ref || args.query || args.thread_id || "").trim();
  const explicitAccountId = typeof args.account_id === "string" && args.account_id.trim() ? args.account_id.trim() : null;
  if (!rawRef) return gmailInput("Missing email ref. Provide ref, query, or thread_id.", "missing_email_ref");
  const withoutAt = rawRef.startsWith("@") ? rawRef.slice(1) : rawRef;
  const firstColon = withoutAt.indexOf(":");
  const refType = firstColon > 0 ? withoutAt.slice(0, firstColon) : "email_thread";
  const refId = firstColon > 0 ? withoutAt.slice(firstColon + 1) : withoutAt;
  const { db } = await import("../../db");
  const { emailMessages, emailEnrichments } = await import("@shared/schema");
  const { requireCurrentPrincipal } = await import("../../principal-context");
  const { combineWithVisibleScope } = await import("../../scoped-storage");
  const { and: andOp, asc: ascOp, desc: descOp, eq: eqOp } = await import("drizzle-orm");
  const principal = requireCurrentPrincipal();
  const emailScope = { ownerUserId: emailMessages.ownerUserId, accountId: emailMessages.principalAccountId, vaultId: emailMessages.vaultId };
  const enrichmentScope = { ownerUserId: emailEnrichments.ownerUserId, accountId: emailEnrichments.principalAccountId, vaultId: emailEnrichments.vaultId };
  let accountId = explicitAccountId;
  let providerThreadId: string | null = null;
  if (refType === "email_message") {
    const messageId = parseCachedEmailMessageId(refId);
    if (messageId == null) return rejectInvalidCachedEmailMessageId(refId);
    const [message] = await db.select({ accountId: emailMessages.accountId, providerThreadId: emailMessages.providerThreadId, providerMessageId: emailMessages.providerMessageId })
      .from(emailMessages)
      .where(combineWithVisibleScope(principal, emailScope, eqOp(emailMessages.id, messageId)))
      .limit(1);
    if (!message) return gmailInput(`Email message ${messageId} not found.`, "message_not_found");
    accountId = message.accountId;
    providerThreadId = message.providerThreadId || message.providerMessageId;
  } else {
    const idColon = refId.indexOf(":");
    if (idColon > 0) {
      accountId = refId.slice(0, idColon);
      providerThreadId = refId.slice(idColon + 1);
    } else providerThreadId = refId;
  }
  if (!providerThreadId) return gmailInput(`Invalid email thread ref: ${rawRef}`, "invalid_thread_ref");
  const threadConditions = [eqOp(emailMessages.providerThreadId, providerThreadId)];
  if (accountId) threadConditions.push(eqOp(emailMessages.accountId, accountId));
  const messages = await db.select({
    id: emailMessages.id,
    providerMessageId: emailMessages.providerMessageId,
    providerThreadId: emailMessages.providerThreadId,
    accountId: emailMessages.accountId,
    subject: emailMessages.subject,
    fromAddress: emailMessages.fromAddress,
    toAddresses: emailMessages.toAddresses,
    ccAddresses: emailMessages.ccAddresses,
    date: emailMessages.date,
    direction: emailMessages.direction,
    triageStatus: emailMessages.triageStatus,
    triageTier: emailMessages.triageTier,
    triageReason: emailMessages.triageReason,
    snippet: emailMessages.snippet,
    bodyText: emailMessages.bodyText,
    isDone: emailMessages.isDone,
  }).from(emailMessages)
    .where(combineWithVisibleScope(principal, emailScope, andOp(...threadConditions)))
    .orderBy(ascOp(emailMessages.date))
    .limit(50);
  if (messages.length === 0) return gmailInput(`Email thread ${providerThreadId} not found.`, "thread_not_found");
  const latest = messages[messages.length - 1];
  const [enrichment] = await db.select().from(emailEnrichments)
    .where(combineWithVisibleScope(principal, enrichmentScope, andOp(eqOp(emailEnrichments.providerThreadId, providerThreadId), eqOp(emailEnrichments.accountId, latest.accountId))))
    .orderBy(descOp(emailEnrichments.updatedAt))
    .limit(1);
  return { result: safeStringify({
    ref: rawRef,
    type: "email_thread",
    canonical: `@email_thread:${latest.accountId}:${providerThreadId}`,
    accountId: latest.accountId,
    providerThreadId,
    latestMessageId: latest.id,
    subject: latest.subject,
    messageCount: messages.length,
    messages,
    enrichment: enrichment ? { id: enrichment.id, summary: enrichment.summary, decisions: enrichment.decisions, actions: enrichment.actions, dismissed: enrichment.dismissed, updatedAt: enrichment.updatedAt } : null,
  }, { label: "bridge.gmail.email_ref" }) };
}

async function getMessage(args: Record<string, any>): Promise<ToolHandlerResult> {
  if (args.message_id == null || args.message_id === "") {
    return gmailInput("Missing 'message_id' parameter.", "missing_message_id");
  }
  const messageId = parseCachedEmailMessageId(args.message_id);
  if (messageId == null) return rejectInvalidCachedEmailMessageId(args.message_id);
  const { db } = await import("../../db");
  const { emailMessages, emailEnrichments } = await import("@shared/schema");
  const { and: andOp, eq: eqOp } = await import("drizzle-orm");
  const { requireCurrentPrincipal } = await import("../../principal-context");
  const { combineWithVisibleScope } = await import("../../scoped-storage");
  const principal = requireCurrentPrincipal();
  const messageScope = { ownerUserId: emailMessages.ownerUserId, accountId: emailMessages.principalAccountId, vaultId: emailMessages.vaultId };
  const enrichmentScope = { ownerUserId: emailEnrichments.ownerUserId, accountId: emailEnrichments.principalAccountId, vaultId: emailEnrichments.vaultId };
  const [message] = await db.select().from(emailMessages)
    .where(combineWithVisibleScope(principal, messageScope, eqOp(emailMessages.id, messageId)))
    .limit(1);
  if (!message) return gmailInput(`Email message ${messageId} not found.`, "message_not_found");
  let enrichment = null;
  if (message.providerThreadId) {
    const [row] = await db.select().from(emailEnrichments)
      .where(combineWithVisibleScope(principal, enrichmentScope, andOp(
        eqOp(emailEnrichments.providerThreadId, message.providerThreadId),
        eqOp(emailEnrichments.accountId, message.accountId),
      )))
      .limit(1);
    enrichment = row || null;
  }
  return { result: safeStringify({
    id: message.id,
    providerMessageId: message.providerMessageId,
    providerThreadId: message.providerThreadId,
    accountId: message.accountId,
    ownerUserId: message.ownerUserId,
    subject: message.subject,
    fromAddress: message.fromAddress,
    date: message.date,
    triageStatus: message.triageStatus,
    triageTier: message.triageTier,
    triageReason: message.triageReason,
    isDone: message.isDone,
    direction: message.direction,
    hasEnrichmentRow: !!enrichment,
    enrichment: enrichment ? { id: enrichment.id, summary: enrichment.summary, dismissed: enrichment.dismissed, createdAt: enrichment.createdAt } : null,
  }, { label: "bridge.gmail.message_detail" }) };
}
