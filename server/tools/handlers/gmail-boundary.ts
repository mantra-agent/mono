import {
  checkAccountPermission,
  checkPermissionAnyAccount,
  type GoogleAccountPermissions,
} from "../../connected-accounts";
import { createLogger } from "../../log";
import type { ToolHandler, ToolHandlerResult } from "../contracts";

const toolExec = createLogger("ToolExec");

export type GmailSubHandler = (args: Record<string, any>) => Promise<ToolHandlerResult>;

export function createGmailHandler(handlers: Record<string, GmailSubHandler>): ToolHandler {
  return async (args) => {
    const action = (args.action as string | undefined) || "status";
    const handler = handlers[action];
    if (!handler) return { result: `Unknown gmail action: ${action}. Available: status, search, read, batch_read, draft, reply, update_draft, recent, download_attachment, triage_log, email_cache`, error: true };
    try {
      return await handler(args);
    } catch (err: any) {
      const { isInvalidGrantError } = await import("../../gmail");
      if (isInvalidGrantError(err)) {
        return {
          result: "Gmail authentication expired — the OAuth token has been revoked or expired. The user needs to re-authorize their Google account in Settings → Connections. Let them know their Gmail connection needs to be refreshed.",
          error: true,
          needsReauth: true,
        };
      }
      return { result: `Gmail tool error: ${err.message}`, error: true };
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
      },
    };
  }
  return { denied: false, resolvedAccountId: undefined };
}
