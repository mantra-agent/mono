import {
  checkAccountPermission,
  checkPermissionAnyAccount,
  type GoogleAccountPermissions,
} from "../../connected-accounts";
import { createLogger } from "../../log";
import {
  internalFailure,
  permissionFailure,
} from "../../tool-failure";
import type { ToolHandler, ToolHandlerResult } from "../contracts";
import { contractReject } from "../shared/failures";

const toolExec = createLogger("ToolExec");

export type GmailSubHandler = (args: Record<string, any>) => Promise<ToolHandlerResult>;

/**
 * Caller-correctable gmail/email_cache contract reject.
 * Bare error:true left failureKind null → Executor TOOL_FAILED_GMAIL red ERRORS.
 */
export function gmailInput(result: string, detail?: string): ToolHandlerResult {
  return contractReject(result, "gmail_input_invalid", detail);
}

/**
 * email_messages.id is a positive integer PK. Hex Gmail provider ids and other
 * non-integers must fail closed at the tool boundary — never reach SQL as NaN
 * (22P02 / QUERY_CONTRACT_FAILED).
 */
export function parseCachedEmailMessageId(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export type CachedEmailMessageIdResolution =
  | { outcome: "resolved"; id: number }
  | { outcome: "missing" }
  | { outcome: "ambiguous" };

/** Resolve canonical cache IDs or Gmail provider locators within visible email scope. */
export async function resolveCachedEmailMessageId(
  value: unknown,
  accountId?: string,
): Promise<CachedEmailMessageIdResolution> {
  const cacheId = parseCachedEmailMessageId(value);
  if (cacheId != null) return { outcome: "resolved", id: cacheId };
  if (typeof value !== "string" || value.trim().length === 0) return { outcome: "missing" };

  const { db } = await import("../../db");
  const { emailMessages } = await import("@shared/schema");
  const { requireCurrentPrincipal } = await import("../../principal-context");
  const { combineWithVisibleScope } = await import("../../scoped-storage");
  const { and: andOp, eq: eqOp } = await import("drizzle-orm");
  const principal = requireCurrentPrincipal();
  const emailScope = { ownerUserId: emailMessages.ownerUserId, accountId: emailMessages.principalAccountId, vaultId: emailMessages.vaultId };
  const conditions = [eqOp(emailMessages.providerMessageId, value.trim())];
  if (accountId) conditions.push(eqOp(emailMessages.accountId, accountId));
  const rows = await db.select({ id: emailMessages.id }).from(emailMessages)
    .where(combineWithVisibleScope(principal, emailScope, andOp(...conditions)))
    .limit(2);
  if (rows.length === 0) return { outcome: "missing" };
  if (rows.length > 1) return { outcome: "ambiguous" };
  return { outcome: "resolved", id: rows[0].id };
}

export function rejectUnresolvedEmailMessageId(raw: unknown, outcome: "missing" | "ambiguous"): ToolHandlerResult {
  if (outcome === "ambiguous") {
    return gmailInput(
      `Email provider message id ${JSON.stringify(raw)} matches more than one visible Gmail account. Include account_id or use the canonical @email_message:<cache-id> reference.`,
      "message_id_ambiguous",
    );
  }
  return gmailInput(
    `Email message ${JSON.stringify(raw)} was not found by cache id or Gmail provider message id.`,
    "message_id_not_found",
  );
}

export function createGmailHandler(handlers: Record<string, GmailSubHandler>): ToolHandler {
  return async (args) => {
    const action = (args.action as string | undefined) || "status";
    const handler = handlers[action];
    if (!handler) {
      return gmailInput(
        `Unknown gmail action: ${action}. Available: status, search, read, batch_read, draft, reply, update_draft, recent, download_attachment, triage_log, email_cache`,
        String(action),
      );
    }
    try {
      return await handler(args);
    } catch (err: any) {
      const { isInvalidGrantError } = await import("../../gmail");
      if (isInvalidGrantError(err)) {
        return {
          result: "Gmail authentication expired — the OAuth token has been revoked or expired. The user needs to re-authorize their Google account in Settings → Connections. Let them know their Gmail connection needs to be refreshed.",
          error: true,
          needsReauth: true,
          failure: permissionFailure("integration_auth_failed", "gmail_invalid_grant"),
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        result: `Gmail tool error: ${message}`,
        error: true,
        failure: internalFailure("gmail_internal", message.slice(0, 160)),
      };
    }
  };
}

export async function resolveGmailAccountId(accountIdRaw: string | undefined): Promise<string | undefined> {
  if (!accountIdRaw) return undefined;
  const { listGmailAccounts } = await import("../../gmail");
  const accounts = await listGmailAccounts();
  const exactIdMatch = accounts.find((account) => account.id === accountIdRaw);
  if (exactIdMatch) return exactIdMatch.id;
  const labelOrEmailMatch = accounts.find((account) =>
    account.email.toLowerCase() === accountIdRaw.toLowerCase() ||
    account.label.toLowerCase() === accountIdRaw.toLowerCase() ||
    account.email.split("@")[0].toLowerCase() === accountIdRaw.toLowerCase() ||
    account.email.split("@")[1]?.split(".")[0]?.toLowerCase() === accountIdRaw.toLowerCase()
  );
  if (labelOrEmailMatch) {
    toolExec.log(`resolveGmailAccountId resolved "${accountIdRaw}" → ${labelOrEmailMatch.id} (${labelOrEmailMatch.email})`);
    return labelOrEmailMatch.id;
  }
  toolExec.warn(`resolveGmailAccountId could not resolve "${accountIdRaw}" — no matching account found among: ${accounts.map((account) => `${account.id} (${account.label}, ${account.email})`).join(", ")}`);
  return accountIdRaw;
}

export async function checkGmailPermission(
  accountIdRaw: string | undefined,
  permission: keyof GoogleAccountPermissions,
  actionLabel: string,
): Promise<{ denied: true; result: ToolHandlerResult } | { denied: false; resolvedAccountId: string | undefined }> {
  const resolvedId = await resolveGmailAccountId(accountIdRaw);
  if (resolvedId) {
    const allowed = await checkAccountPermission(resolvedId, permission);
    if (!allowed) {
      const { getAccount } = await import("../../connected-accounts");
      const account = await getAccount(resolvedId);
      const label = account?.label || resolvedId;
      const email = account?.email || "";
      return {
        denied: true,
        result: {
          result: `Permission denied: ${label}${email ? ` (${email})` : ""} is not allowed to ${actionLabel}. This can be changed in Settings → Connections.`,
          error: true,
          failure: permissionFailure("integration_auth_failed", `gmail_${String(permission)}_denied`),
        },
      };
    }
    return { denied: false, resolvedAccountId: resolvedId };
  }
  const check = await checkPermissionAnyAccount(permission);
  if (!check.allowed) {
    return {
      denied: true,
      result: {
        result: `Permission denied: No connected Google account is allowed to ${actionLabel}. This can be changed in Settings → Connections.`,
        error: true,
        failure: permissionFailure("integration_auth_failed", `gmail_${String(permission)}_none_allowed`),
      },
    };
  }
  return { denied: false, resolvedAccountId: undefined };
}
