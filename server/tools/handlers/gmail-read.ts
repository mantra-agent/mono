import type { ToolHandlerResult } from "../contracts";
import { checkGmailPermission, gmailInput, resolveGmailAccountId } from "./gmail-boundary";

interface GmailMessagePayload {
  mimeType?: string;
  body?: { data?: string };
}

interface GmailReadDependencies {
  resolveTargetAccounts: (resolvedAccountId: string | undefined, accounts: Array<{ id: string; label: string }>) => Array<{ id: string; label: string }>;
  listMessagesMultiAccount: (
    query: string | undefined,
    maxResults: number,
    targetAccounts: Array<{ id: string; label: string }>,
    caller: string,
  ) => Promise<{ stubs: Array<{ id: string; acctId: string; acctLabel: string }>; errors: string[] }>;
  formatListErrors: (errors: string[], fallbackMessage: string, expectData?: boolean) => ToolHandlerResult;
  formatMessageLine: (message: Record<string, unknown>, messageId: string, accountId: string, accountLabel?: string) => string;
  extractHeaders: (message: Record<string, any>) => { from: string; subject: string; date: string };
  findTextBody: (payload: GmailMessagePayload | undefined) => string;
  findAttachments: (payload: Record<string, any> | undefined) => Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
  logReadFallback: (accountId: string, error: unknown) => void;
}

export function createGmailReadHandlers(dependencies: GmailReadDependencies) {
  return {
    status: handleStatus,
    search: handleSearch,
    read: handleRead,
    recent: handleRecent,
  };

  async function handleStatus(): Promise<ToolHandlerResult> {
    const { listGmailAccounts, getAccountScopes, isConnectorConnected } = await import("../../gmail");
    const accounts = await listGmailAccounts();
    const connector = await isConnectorConnected();
    if (accounts.length === 0 && !connector) return { result: "Gmail: not connected — no accounts linked" };

    const parts: string[] = [];
    for (const account of accounts) {
      const scopes = await getAccountScopes(account.id);
      const capabilities = [scopes.hasGmailRead ? "read" : null, scopes.hasSend ? "send" : null, scopes.hasDraft ? "draft" : null]
        .filter(Boolean)
        .join("+");
      parts.push(`${account.email} (${account.label || account.id}${capabilities ? `, ${capabilities}` : ""})`);
    }
    let message = `Gmail: ${accounts.length} account${accounts.length !== 1 ? "s" : ""} connected — ${parts.join(", ")}`;
    if (connector) message += " | external connector also available";
    return { result: message };
  }

  async function handleSearch(args: Record<string, any>): Promise<ToolHandlerResult> {
    const permission = await checkGmailPermission(args.account, "gmailRead", "read emails");
    if (permission.denied) return permission.result;
    const { getMessage, listGmailAccounts } = await import("../../gmail");
    if (!args.query) return gmailInput("Missing search query", "missing_query");
    const maxResults = args.maxResults || 10;
    const accounts = await listGmailAccounts();
    if (accounts.length === 0) return gmailInput("No Gmail accounts connected. Add a Gmail account in Settings → Connections.", "no_accounts");
    const resolvedAccountId = permission.resolvedAccountId || await resolveGmailAccountId(args.account);
    const targets = dependencies.resolveTargetAccounts(resolvedAccountId, accounts);
    if (targets.length === 0) return gmailInput(`Gmail account "${args.account}" not found in connected accounts.`, "account_not_found");
    const { stubs, errors } = await dependencies.listMessagesMultiAccount(args.query, maxResults, targets, "search");
    if (stubs.length === 0) return dependencies.formatListErrors(errors, `No emails found for "${args.query}" across all accounts`);
    const lines: string[] = [];
    for (const stub of stubs) {
      try {
        const message = await getMessage(stub.id, "metadata", stub.acctId);
        lines.push(dependencies.formatMessageLine(message as any, stub.id, stub.acctId, targets.length > 1 ? stub.acctLabel : undefined));
      } catch (error) {
        lines.push(`- [ERROR] Message ${stub.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { result: `Found ${lines.length} emails:\n${lines.join("\n")}` };
  }

  async function handleRead(args: Record<string, any>): Promise<ToolHandlerResult> {
    const permission = await checkGmailPermission(args.account, "gmailRead", "read emails");
    if (permission.denied) return permission.result;
    const { getMessage, listGmailAccounts } = await import("../../gmail");
    if (!args.id) return gmailInput("Missing message id", "missing_message_id");
    const accountId = permission.resolvedAccountId || await resolveGmailAccountId(args.account);
    let message: any = null;
    if (accountId) {
      message = await getMessage(args.id, "full", accountId);
    } else {
      for (const account of await listGmailAccounts()) {
        try {
          message = await getMessage(args.id, "full", account.id);
          break;
        } catch (error) {
          dependencies.logReadFallback(account.id, error);
        }
      }
      if (!message) return gmailInput(`Message ${args.id} not found in any connected account`, "message_not_found");
    }
    const { from, subject, date } = dependencies.extractHeaders(message);
    let body = dependencies.findTextBody(message.payload);
    if (!body && message.payload?.body?.data) body = Buffer.from(message.payload.body.data, "base64").toString("utf-8");
    const attachments = dependencies.findAttachments(message.payload);
    let result = `**${subject}**\nFrom: ${from}\nDate: ${date}\n\n${body}`;
    if (attachments.length > 0) {
      result += `\n\n**Attachments (${attachments.length}):**`;
      for (const attachment of attachments) {
        result += `\n- ${attachment.filename} (${attachment.mimeType}, ${Math.round(attachment.size / 1024)}KB) [attachmentId:${attachment.attachmentId}]`;
      }
      result += `\n\nUse action "download_attachment" with the message id, attachmentId, and account to download.`;
    }
    return { result };
  }

  async function handleRecent(args: Record<string, any>): Promise<ToolHandlerResult> {
    const permission = await checkGmailPermission(args.account, "gmailRead", "read emails");
    if (permission.denied) return permission.result;
    const { getMessage, listGmailAccounts } = await import("../../gmail");
    const accounts = await listGmailAccounts();
    if (accounts.length === 0) return gmailInput("No Gmail accounts connected. Add a Gmail account in Settings → Connections.", "no_accounts");
    const resolvedAccountId = permission.resolvedAccountId || await resolveGmailAccountId(args.account);
    const targets = dependencies.resolveTargetAccounts(resolvedAccountId, accounts);
    if (targets.length === 0) return gmailInput(`Gmail account "${args.account}" not found in connected accounts.`, "account_not_found");
    const { stubs, errors } = await dependencies.listMessagesMultiAccount(undefined, args.maxResults || 5, targets, "recent");
    if (stubs.length === 0) return dependencies.formatListErrors(errors, "No recent emails found across any account");
    const lines: string[] = [];
    for (const stub of stubs) {
      try {
        const message = await getMessage(stub.id, "metadata", stub.acctId);
        lines.push(dependencies.formatMessageLine(message as any, stub.id, stub.acctId, targets.length > 1 ? stub.acctLabel : undefined));
      } catch (error) {
        lines.push(`- [ERROR] Message ${stub.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { result: `${lines.length} recent emails:\n${lines.join("\n")}` };
  }
}
