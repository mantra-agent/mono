import type { ToolHandlerResult } from "../contracts";
import {
  checkGmailPermission,
  gmailInput,
  rejectUnresolvedEmailMessageId,
  resolveCachedEmailMessageId,
  resolveGmailAccountId,
} from "./gmail-boundary";
import { createLogger } from "../../log";
import { internalFailure } from "../../tool-failure";

const toolExec = createLogger("ToolExec");

function optionalDraftText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().length > 0 ? value : undefined;
}

function optionalDraftRecipients(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const recipients = value.filter(
    (recipient): recipient is string => typeof recipient === "string" && recipient.trim().length > 0,
  );
  return recipients.length > 0 ? recipients : undefined;
}

function extractReplyAddress(fromAddress: string | null): string | undefined {
  if (!fromAddress) return undefined;
  const angleMatch = fromAddress.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angleMatch) return angleMatch[1];
  const plainMatch = fromAddress.match(/[^\s<>]+@[^\s<>]+/);
  return plainMatch?.[0];
}

function extractReplyAddresses(addresses: string | null): string[] {
  if (!addresses) return [];
  return Array.from(addresses.matchAll(/[^\s,;<>]+@[^\s,;<>]+/g), (match) => match[0]);
}

function deriveReplyAllRecipients(
  latest: { fromAddress: string | null; toAddresses: string | null; ccAddresses: string | null },
  senderEmail: string | null | undefined,
): { to: string[]; cc: string[] } {
  const excluded = senderEmail?.trim().toLowerCase();
  const seen = new Set<string>();
  const uniqueExternal = (addresses: Array<string | undefined>): string[] => {
    const recipients: string[] = [];
    for (const address of addresses) {
      const normalized = address?.trim().toLowerCase();
      if (!normalized || normalized === excluded || seen.has(normalized)) continue;
      seen.add(normalized);
      recipients.push(address!.trim());
    }
    return recipients;
  };

  return {
    to: uniqueExternal([
      extractReplyAddress(latest.fromAddress),
      ...extractReplyAddresses(latest.toAddresses),
    ]),
    cc: uniqueExternal(extractReplyAddresses(latest.ccAddresses)),
  };
}

export async function handleGmailReply(args: Record<string, any>): Promise<ToolHandlerResult> {
  const ref = optionalDraftText(args.ref);
  const body = optionalDraftText(args.body);
  if (!ref || !body) return gmailInput("Missing ref or body", "missing_ref_or_body");

  const withoutAt = ref.startsWith("@") ? ref.slice(1) : ref;
  const firstColon = withoutAt.indexOf(":");
  const refType = firstColon > 0 ? withoutAt.slice(0, firstColon) : "email_thread";
  const refId = firstColon > 0 ? withoutAt.slice(firstColon + 1) : withoutAt;

  const { db } = await import("../../db");
  const { emailMessages } = await import("@shared/schema");
  const { requireCurrentPrincipal } = await import("../../principal-context");
  const { combineWithVisibleScope } = await import("../../scoped-storage");
  const { and: andOp, desc: descOp, eq: eqOp } = await import("drizzle-orm");
  const principal = requireCurrentPrincipal();
  const emailScope = { ownerUserId: emailMessages.ownerUserId, accountId: emailMessages.principalAccountId };

  let accountId: string | undefined;
  let providerThreadId: string | null = null;
  if (refType === "email_message") {
    const resolution = await resolveCachedEmailMessageId(refId);
    if (resolution.outcome !== "resolved") return rejectUnresolvedEmailMessageId(refId, resolution.outcome);
    const messageId = resolution.id;
    const [message] = await db.select({ accountId: emailMessages.accountId, providerThreadId: emailMessages.providerThreadId, providerMessageId: emailMessages.providerMessageId })
      .from(emailMessages)
      .where(combineWithVisibleScope(principal, emailScope, eqOp(emailMessages.id, messageId)))
      .limit(1);
    if (!message) return gmailInput(`Email message ${messageId} not found.`, "message_not_found");
    accountId = message.accountId;
    providerThreadId = message.providerThreadId || message.providerMessageId;
  } else if (refType === "email_thread") {
    const idColon = refId.indexOf(":");
    if (idColon > 0) {
      accountId = refId.slice(0, idColon);
      providerThreadId = refId.slice(idColon + 1);
    } else {
      providerThreadId = refId;
    }
  } else {
    return gmailInput(`Unsupported reply ref: ${ref}`, "unsupported_reply_ref");
  }
  if (!providerThreadId) return gmailInput(`Invalid email thread ref: ${ref}`, "invalid_thread_ref");

  const conditions = [eqOp(emailMessages.providerThreadId, providerThreadId)];
  if (accountId) conditions.push(eqOp(emailMessages.accountId, accountId));
  const [latest] = await db.select({
    accountId: emailMessages.accountId,
    subject: emailMessages.subject,
    fromAddress: emailMessages.fromAddress,
    toAddresses: emailMessages.toAddresses,
    ccAddresses: emailMessages.ccAddresses,
  }).from(emailMessages)
    .where(combineWithVisibleScope(principal, emailScope, andOp(...conditions)))
    .orderBy(descOp(emailMessages.date))
    .limit(1);
  if (!latest) return gmailInput(`Email thread ${providerThreadId} not found.`, "thread_not_found");

  const { assertAvailableGmailSenderAccount } = await import("../../gmail");
  let senderAccount: Awaited<ReturnType<typeof assertAvailableGmailSenderAccount>>;
  try {
    senderAccount = await assertAvailableGmailSenderAccount(accountId || latest.accountId);
  } catch (error: any) {
    return gmailInput(error?.message || "Selected Gmail sender account is unavailable.", "sender_unavailable");
  }

  const recipients = deriveReplyAllRecipients(latest, senderAccount.email);
  if (recipients.to.length === 0) {
    return gmailInput("Could not derive an external reply recipient from the latest message", "no_reply_recipient");
  }
  const subject = latest.subject?.toLowerCase().startsWith("re:") ? latest.subject : `Re: ${latest.subject || ""}`;
  return handleGmailDraft({
    ...args,
    account: senderAccount.id,
    to: recipients.to,
    cc: recipients.cc,
    subject,
    body,
    thread_id: providerThreadId,
  });
}

export async function handleGmailDraft(args: Record<string, any>): Promise<ToolHandlerResult> {
  const permission = await checkGmailPermission(args.account, "gmailDraft", "create drafts");
  if (permission.denied) return permission.result;

  const { to, cc, subject, body } = args;
  if (!to || !subject || !body) return gmailInput("Missing to, subject, or body", "missing_draft_fields");
  const draftAccountId = permission.resolvedAccountId || await resolveGmailAccountId(args.account);

  try {
    const { emailDraftStorage } = await import("../../email-draft-storage");
    const { requireCurrentPrincipal } = await import("../../principal-context");
    const draft = await emailDraftStorage.create(requireCurrentPrincipal(), {
      gmailAccountId: draftAccountId || undefined,
      to: Array.isArray(to) ? to : [to],
      cc: optionalDraftRecipients(cc),
      subject,
      body,
      threadId: args.thread_id || undefined,
      inReplyTo: args.in_reply_to || undefined,
      sessionId: args._sessionId || undefined,
    });
    return { result: `Email draft created. @email_draft:${draft.id}` };
  } catch (error: any) {
    toolExec.error(`handleGmailDraft: Failed to create draft: ${error.message}`);
    return {
      result: `Failed to create email draft: ${error.message}`,
      error: true,
      failure: internalFailure("gmail_internal", error.message?.slice?.(0, 160) || "draft_create_failed"),
    };
  }
}

type ParsedDraftBodyMutation =
  | { mutation?: import("../../email-draft-storage").EmailDraftBodyMutation }
  | { error: string };

function isSubstantiveDraftBodyOperation(key: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "object" || Array.isArray(value)) return true;
  const operation = value as Record<string, unknown>;
  if (key === "findReplace") return operation.find !== "" || operation.replace !== "" || operation.replaceAll === true;
  if (key === "rangePatch") {
    return operation.start !== 0 || operation.end !== 0 || operation.replacement !== "" || operation.expectedBodyHash !== "";
  }
  if (key === "replaceBody") return operation.body !== "" || operation.clear === true;
  return Object.keys(operation).length > 0;
}

function parseDraftBodyMutation(args: Record<string, any>): ParsedDraftBodyMutation {
  const supplied = ["findReplace", "rangePatch", "replaceBody"].filter((key) => isSubstantiveDraftBodyOperation(key, args[key]));
  if (optionalDraftText(args.body)) return { error: "update_draft body changes require findReplace, rangePatch, or replaceBody; body is for draft creation only" };
  if (supplied.length > 1) return { error: "Provide only one body operation: findReplace, rangePatch, or replaceBody" };
  if (supplied.length === 0) return {};

  const operation = supplied[0];
  const value = args[operation];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${operation} must be an object` };
  if (operation === "findReplace") {
    if (typeof value.find !== "string" || value.find.length === 0 || typeof value.replace !== "string") {
      return { error: "findReplace requires a non-empty find string and a replace string" };
    }
    if (value.replaceAll !== undefined && typeof value.replaceAll !== "boolean") return { error: "findReplace.replaceAll must be a boolean" };
    return { mutation: { type: "find_replace", find: value.find, replace: value.replace, replaceAll: value.replaceAll } };
  }
  if (operation === "rangePatch") {
    if (!Number.isInteger(value.start) || !Number.isInteger(value.end) || typeof value.replacement !== "string" || typeof value.expectedBodyHash !== "string" || value.expectedBodyHash.trim().length === 0) {
      return { error: "rangePatch requires integer start/end, a replacement string, and non-empty expectedBodyHash" };
    }
    return { mutation: { type: "range_patch", start: value.start, end: value.end, replacement: value.replacement, expectedBodyHash: value.expectedBodyHash.trim() } };
  }
  if (value.clear !== undefined && typeof value.clear !== "boolean") return { error: "replaceBody.clear must be a boolean" };
  if (typeof value.body !== "string") return { error: "replaceBody requires a body string" };
  if (value.body.length === 0 && value.clear !== true) return { error: "Clearing a draft body requires replaceBody.clear=true" };
  return { mutation: { type: "replace_body", body: value.body } };
}

function describeDraftBodyMutationFailure(
  draftId: string,
  result: Exclude<import("../../email-draft-storage").EmailDraftBodyMutationResult, { status: "updated" }>,
): string {
  switch (result.status) {
    case "not_found": return `Email draft ${draftId} not found`;
    case "missing_match": return "Draft body edit failed: exact find text was not present";
    case "ambiguous_match": return "Draft body edit failed: exact find text matched more than once; provide more context or set replaceAll=true";
    case "stale_body": return `Draft body edit failed: body changed since the patch was prepared${result.bodyHash ? `. Current body hash: ${result.bodyHash}` : ""}`;
    case "invalid_range": return `Draft body edit failed: range is invalid for the current body${result.bodyHash ? `. Current body hash: ${result.bodyHash}` : ""}`;
    case "immutable_draft": return "Draft body edit failed: sent and discarded drafts are immutable";
  }
}

export async function handleGmailDraftUpdate(args: Record<string, any>): Promise<ToolHandlerResult> {
  const draftId = optionalDraftText(args.draft_id);
  if (!draftId) return gmailInput("Missing draft_id", "missing_draft_id");
  const parsedBodyMutation = parseDraftBodyMutation(args);
  if ("error" in parsedBodyMutation) return gmailInput(parsedBodyMutation.error, "body_mutation_invalid");

  try {
    const { emailDraftStorage } = await import("../../email-draft-storage");
    const { requireCurrentPrincipal } = await import("../../principal-context");
    const principal = requireCurrentPrincipal();
    const account = optionalDraftText(args.account);
    let gmailAccountId: string | undefined;
    if (account) {
      const permission = await checkGmailPermission(account, "gmailDraft", "update drafts");
      if (permission.denied) return permission.result;
      gmailAccountId = permission.resolvedAccountId;
    }
    const patch = {
      gmailAccountId,
      to: optionalDraftRecipients(args.update_to),
      cc: optionalDraftRecipients(args.update_cc),
      bcc: optionalDraftRecipients(args.update_bcc),
      subject: optionalDraftText(args.subject),
    };
    const hasNonBodyPatch = Object.values(patch).some((value) => value !== undefined);
    if (!hasNonBodyPatch && !parsedBodyMutation.mutation) {
      return gmailInput("No non-empty editable fields or body operation provided", "empty_update");
    }

    let draft = hasNonBodyPatch ? await emailDraftStorage.update(principal, draftId, patch) : null;
    if (hasNonBodyPatch && !draft) return gmailInput(`Email draft ${draftId} not found`, "draft_not_found");
    if (parsedBodyMutation.mutation) {
      const bodyResult = await emailDraftStorage.mutateBody(principal, draftId, parsedBodyMutation.mutation);
      if (bodyResult.status !== "updated") {
        return gmailInput(describeDraftBodyMutationFailure(draftId, bodyResult), bodyResult.status);
      }
      draft = bodyResult.draft;
    }
    return { result: `Email draft updated. @email_draft:${draft!.id}` };
  } catch (error: any) {
    toolExec.error(`handleGmailDraftUpdate: Failed to update draft: ${error.message}`);
    return {
      result: `Failed to update email draft: ${error.message}`,
      error: true,
      failure: internalFailure("gmail_internal", error.message?.slice?.(0, 160) || "draft_update_failed"),
    };
  }
}

export async function handleGmailDraftFromReview(args: {
  to: string;
  subject: string;
  sourceEmailId: number;
  accountId: string;
  context: string;
}): Promise<{ draft: any; toolResult: string }> {
  const result = await handleGmailDraft({
    action: "draft",
    to: args.to,
    subject: args.subject,
    body: args.context,
    account: args.accountId,
  });
  return { draft: null, toolResult: result.result };
}

export const gmailDraftHandlers = {
  draft: handleGmailDraft,
  reply: handleGmailReply,
  update_draft: handleGmailDraftUpdate,
};
