import type { ToolHandlerResult } from "../contracts";
import { checkGmailPermission, gmailInput, resolveGmailAccountId } from "./gmail-boundary";
import { createLogger } from "../../log";
import { WORKSPACE_DIR } from "../../paths";
import { TRIAGE_MAX_RESULTS } from "../../skill-defaults";

const toolExec = createLogger("ToolExec");
const BATCH_READ_MAX_RESULTS = TRIAGE_MAX_RESULTS;

interface GmailAccountTarget { id: string; label: string }
interface MessageStub { id: string; acctId: string; acctLabel: string }

interface GmailProviderDependencies {
  resolveTargetAccounts: (resolvedAccountId: string | undefined, accounts: GmailAccountTarget[]) => GmailAccountTarget[];
  listMessagesMultiAccount: (
    query: string | undefined,
    maxResults: number,
    targetAccounts: GmailAccountTarget[],
    caller: string,
    options?: { paginate?: boolean; paginationCap?: number },
  ) => Promise<{ stubs: MessageStub[]; errors: string[] }>;
  formatListErrors: (errors: string[], fallbackMessage: string, expectData?: boolean) => ToolHandlerResult;
  extractHeaders: (message: Record<string, any>) => { from: string; subject: string; date: string; headers: Array<{ name: string; value: string }> };
  findTextBody: (payload: Record<string, any> | undefined) => string;
}

export async function diagnoseGmailBatchRead(query = "newer_than:3d"): Promise<void> {
  const { listMessages, listGmailAccounts } = await import("../../gmail");
  const accounts = await listGmailAccounts();
  if (accounts.length === 0) {
    toolExec.log("[GmailDiag] No Gmail accounts connected — skipping diagnostic");
    return;
  }
  toolExec.log(`[GmailDiag] Running batch_read diagnostic: query="${query}" accounts=${accounts.length}`);
  for (const account of accounts) {
    try {
      const results = await listMessages(query, 5, account.id);
      toolExec.log(`[GmailDiag] acct=${account.id} label="${account.email || account.id}" query="${query}" results=${results.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toolExec.error(`[GmailDiag] acct=${account.id} query="${query}" ERROR: ${message}`);
    }
  }
}

export function createGmailProviderHandlers(dependencies: GmailProviderDependencies) {
  return {
    download_attachment: handleDownloadAttachment,
    batch_read: handleBatchRead,
  };

  async function handleDownloadAttachment(args: Record<string, any>): Promise<ToolHandlerResult> {
    const permission = await checkGmailPermission(args.account, "gmailDownloadAttachments", "download attachments");
    if (permission.denied) return permission.result;

    const { getAttachment, listGmailAccounts } = await import("../../gmail");
    const messageId = args.id;
    const attachmentId = args.attachmentId;
    if (!messageId || !attachmentId) return gmailInput("Missing message id or attachmentId", "missing_attachment_ids");
    let accountId = permission.resolvedAccountId || await resolveGmailAccountId(args.account);

    let attachment: { data: string; size: number } | null = null;
    if (accountId) {
      attachment = await getAttachment(messageId, attachmentId, accountId);
    } else {
      for (const account of await listGmailAccounts()) {
        try {
          attachment = await getAttachment(messageId, attachmentId, account.id);
          accountId = account.id;
          break;
        } catch (error) {
          toolExec.debug("gmail attachment account fallback", account.id, error);
        }
      }
      if (!attachment) return gmailInput("Attachment not found in any connected account", "attachment_not_found");
    }

    const rawData = attachment.data.replace(/-/g, "+").replace(/_/g, "/");
    const buffer = Buffer.from(rawData, "base64");
    const fileName = args.fileName || `attachment-${Date.now()}`;
    const { promises: fs } = await import("fs");
    const { join, extname } = await import("path");
    const uploadsDir = join(WORKSPACE_DIR, "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = join(uploadsDir, `${Date.now()}-${safeName}`);
    await fs.writeFile(filePath, buffer);
    const workspacePath = filePath.replace(WORKSPACE_DIR + "/", "");

    const textExtensions = [".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".html", ".css", ".js", ".ts", ".py", ".sh", ".log", ".ini", ".cfg", ".toml", ".rst", ".tex", ".svg"];
    const isText = textExtensions.includes(extname(fileName).toLowerCase());
    if (isText && buffer.length <= 100000) {
      const content = buffer.toString("utf-8");
      if (content.length > 5000) {
        const { indexAndArchiveWithFallback } = await import("../../content-indexer");
        const reference = await indexAndArchiveWithFallback({ content, sourceType: "file", sourceLabel: fileName });
        return { result: `Downloaded "${fileName}" (${buffer.length} bytes, saved to ${workspacePath})\n\n${reference}` };
      }
      return { result: `Downloaded "${fileName}" (${buffer.length} bytes, saved to ${workspacePath})\n\n**Content:**\n${content}` };
    }
    return { result: `Downloaded "${fileName}" (${buffer.length} bytes) to workspace: ${workspacePath}\n\nTo attach this file to a project, use the work tool: { "action": "add_file", "id": PROJECT_ID, "workspacePath": "${workspacePath}" }` };
  }

  async function handleBatchRead(args: Record<string, any>): Promise<ToolHandlerResult> {
    const log = createLogger("BridgeTools:batch_read");
    log.debug(`called args.account=${args.account} args.query=${args.query} args.maxResults=${args.maxResults} excludeCount=${(args.excludeMessageIds || []).length} hasIds=${!!args.ids}`);
    const permission = await checkGmailPermission(args.account, "gmailRead", "read emails");
    if (permission.denied) return permission.result;

    const { getMessage, listGmailAccounts } = await import("../../gmail");
    const ids: string[] | undefined = args.ids;
    const query: string | undefined = args.query;
    log.debug(`effective query: "${query}"`);
    const excludeSet = new Set<string>(args.excludeMessageIds || []);
    const maxResults = Math.min(args.maxResults || BATCH_READ_MAX_RESULTS, BATCH_READ_MAX_RESULTS);
    if (!ids && !query) return gmailInput("Provide either 'ids' (array of message IDs) or 'query' (search string) for batch_read", "missing_ids_or_query");

    const accounts = await listGmailAccounts();
    if (accounts.length === 0) {
      log.error("failed: no Gmail accounts connected");
      return gmailInput("No Gmail accounts connected. Connect an account in Settings → Connections.", "no_accounts");
    }
    const resolvedAccountId = permission.resolvedAccountId || await resolveGmailAccountId(args.account);
    const targets = dependencies.resolveTargetAccounts(resolvedAccountId, accounts);
    if (targets.length === 0) {
      log.error(`failed: resolveTargetAccounts returned empty for resolvedAccountId=${resolvedAccountId}`);
      return gmailInput("Could not resolve target Gmail account. Check that the account is still connected in Settings → Connections.", "account_unresolved");
    }
    log.debug(`resolvedAccountId=${resolvedAccountId} targets=${targets.map((target) => `${target.id}(${target.label})`).join(", ")}`);

    let stubs: MessageStub[] = [];
    const listErrors: string[] = [];
    if (ids) {
      stubs = filterExcluded(ids.map((id) => ({ id, acctId: targets[0].id, acctLabel: targets[0].label })), excludeSet);
    } else if (query) {
      const listed = await dependencies.listMessagesMultiAccount(query, maxResults, targets, "batch_read", { paginate: true, paginationCap: BATCH_READ_MAX_RESULTS });
      listErrors.push(...listed.errors);
      log.debug(`listMulti stubs=${listed.stubs.length} errors=${listed.errors.length} query="${query}" targetAccounts=${targets.length}${listed.errors.length > 0 ? ` errDetails=${listed.errors.join("; ")}` : ""}`);
      stubs = filterExcluded(listed.stubs, excludeSet);
    }
    stubs = stubs.slice(0, maxResults);
    log.debug(`final stubs=${stubs.length} excludeSetSize=${excludeSet.size} listErrors=${listErrors.length}`);
    if (stubs.length === 0) {
      log.warn(`returning empty — query="${query}" targets=${targets.length} excludeSetSize=${excludeSet.size} listErrors=${listErrors.length}${listErrors.length > 0 ? ` errors: ${listErrors.join("; ")}` : ""}`);
      return dependencies.formatListErrors(listErrors, "No messages found (or all excluded)", true);
    }

    const results = await fetchFullMessages(stubs, getMessage, dependencies);
    const errorSuffix = listErrors.length > 0 ? `\n\n⚠️ Errors encountered for some accounts:\n${listErrors.join("\n")}` : "";
    return { result: `Batch read ${results.length} messages:\n\n${results.join("\n\n---\n\n")}${errorSuffix}` };
  }
}

function getProviderStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate.status ?? candidate.code ?? candidate.response?.status;
  return typeof status === "number" ? status : undefined;
}

function filterExcluded(stubs: MessageStub[], excludeSet: Set<string>): MessageStub[] {
  const filtered = stubs.filter((stub) => !excludeSet.has(stub.id));
  const excludedCount = stubs.length - filtered.length;
  if (excludedCount > 0) toolExec.log(`batch_read excluded ${excludedCount} already-triaged messages`);
  return filtered;
}

async function fetchFullMessages(
  stubs: MessageStub[],
  getMessage: (id: string, format: "full" | "metadata" | "minimal", accountId?: string) => Promise<any>,
  dependencies: GmailProviderDependencies,
): Promise<string[]> {
  const results: string[] = [];
  for (const stub of stubs) {
    try {
      const message = await getMessage(stub.id, "full", stub.acctId);
      const { subject, headers } = dependencies.extractHeaders(message);
      let body = dependencies.findTextBody(message.payload);
      if (!body && message.payload?.body?.data) body = Buffer.from(message.payload.body.data, "base64").toString("utf-8");
      if (body.length > 3000) {
        const { indexAndArchive, formatReferenceBlock } = await import("../../content-indexer");
        const reference = await indexAndArchive({ content: body, sourceType: "email", sourceLabel: `${message.payload?.headers?.find((header: any) => header.name === "Subject")?.value || "email"} (${stub.id})` });
        if (reference) body = formatReferenceBlock(reference);
      }
      const headerLines = headers.map((header) => `- **${header.name}:** ${header.value}`).join("\n");
      results.push(`### [${stub.acctLabel}] ${subject}\n- **Message ID:** ${stub.id}\n- **Account:** ${stub.acctId}\n\n**Headers:**\n${headerLines}\n\n**Body:**\n${body}`);
    } catch (error) {
      const status = getProviderStatus(error);
      if (status === 404) {
        toolExec.warn(`batch_read message unavailable id=${stub.id} acct=${stub.acctId} status=404`);
      } else {
        toolExec.error(`batch_read getMessage failed id=${stub.id} acct=${stub.acctId}`, error);
      }
      results.push(`### Message ${stub.id} — ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}
