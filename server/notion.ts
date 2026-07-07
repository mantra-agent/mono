import { Client } from '@notionhq/client';

import { createLogger } from './log';
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
} from './connected-accounts';

const log = createLogger("Notion");

export interface NotionAccount {
  id: string;
  workspaceName: string;
  label: string;
  addedAt: string;
}

export async function listNotionAccounts(): Promise<NotionAccount[]> {
  const accounts = await listAccounts("notion");
  return accounts.map(a => ({
    id: a.accountId,
    workspaceName: a.workspaceName || '',
    label: a.label,
    addedAt: a.addedAt.toISOString(),
  }));
}

async function getNotionToken(accountId: string): Promise<string | null> {
  const { getAccountTokens } = await import("./connected-accounts");
  const tokens = await getAccountTokens(accountId);
  if (!tokens) return null;
  const obj = tokens as unknown as { token?: string };
  return obj.token || null;
}

export async function addNotionAccount(token: string, label: string): Promise<NotionAccount> {
  const client = new Client({ auth: token });

  let workspaceName = 'Unknown Workspace';
  try {
    const me = await client.users.me({});
    if (me.type === 'bot' && me.bot?.workspace_name) {
      workspaceName = me.bot.workspace_name;
    }
  } catch {
    throw new Error("Invalid Notion token — could not authenticate with the provided credentials");
  }

  const accounts = await listAccounts("notion");
  const existing = accounts.find(a => a.workspaceName === workspaceName);
  if (existing) {
    await updateAccount(existing.accountId, {
      tokens: { token, workspaceName },
      label,
    });
    log.log(`addNotionAccount updated existing id=${existing.accountId} workspace=${workspaceName}`);
    return { id: existing.accountId, workspaceName, label, addedAt: existing.addedAt.toISOString() };
  }

  const id = workspaceName.replace(/[^a-z0-9]/gi, '_').toLowerCase() || `workspace_${Date.now()}`;
  const account = await createAccount({
    accountId: id,
    provider: 'notion',
    label: label || 'Personal',
    workspaceName,
    tokens: { token, workspaceName },
  });
  log.log(`addNotionAccount created id=${id} workspace=${workspaceName}`);
  return { id: account.accountId, workspaceName: account.workspaceName || '', label: account.label, addedAt: account.addedAt.toISOString() };
}

export async function removeNotionAccount(accountId: string): Promise<void> {
  await deleteAccount(accountId);
  log.log(`removeNotionAccount id=${accountId}`);
}

export async function updateAccountLabel(accountId: string, label: string): Promise<NotionAccount | null> {
  const updated = await updateAccount(accountId, { label });
  if (!updated) return null;
  return { id: updated.accountId, workspaceName: updated.workspaceName || '', label: updated.label, addedAt: updated.addedAt.toISOString() };
}

export async function getClientForAccount(accountId: string): Promise<Client> {
  const token = await getNotionToken(accountId);
  if (!token) {
    throw new Error(`No token for Notion account ${accountId}`);
  }
  return new Client({ auth: token });
}

export async function verifyAccount(accountId: string): Promise<{ valid: boolean; workspaceName?: string }> {
  try {
    const client = await getClientForAccount(accountId);
    const me = await client.users.me({});
    const workspaceName = me.type === 'bot' ? me.bot?.workspace_name : undefined;
    return { valid: true, workspaceName: workspaceName || undefined };
  } catch (err: unknown) {
    log.warn(`verifyAccount failed for ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false };
  }
}

export async function searchPages(accountId: string, query?: string, pageSize = 20): Promise<Record<string, unknown>[]> {
  const client = await getClientForAccount(accountId);
  const response = await client.search({
    query: query || undefined,
    filter: { property: 'object', value: 'page' },
    page_size: pageSize,
  });
  return response.results as Record<string, unknown>[];
}

export async function searchDatabases(accountId: string, query?: string, pageSize = 20): Promise<Record<string, unknown>[]> {
  const client = await getClientForAccount(accountId);
  const response = await client.search({
    query: query || undefined,
    page_size: pageSize,
  });
  return (response.results as Record<string, unknown>[]).filter((r) => r.object === 'database');
}

export async function getPage(accountId: string, pageId: string): Promise<Record<string, unknown>> {
  const client = await getClientForAccount(accountId);
  return client.pages.retrieve({ page_id: pageId }) as Promise<Record<string, unknown>>;
}

export async function getPageContent(accountId: string, pageId: string): Promise<Record<string, unknown>[]> {
  const client = await getClientForAccount(accountId);
  const blocks: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...(response.results as Record<string, unknown>[]));
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);
  return blocks;
}

export async function getDatabase(accountId: string, databaseId: string): Promise<Record<string, unknown>> {
  const client = await getClientForAccount(accountId);
  return client.databases.retrieve({ database_id: databaseId }) as Promise<Record<string, unknown>>;
}

export async function queryDatabase(accountId: string, databaseId: string, opts?: { pageSize?: number; startCursor?: string }): Promise<{ results: Record<string, unknown>[]; hasMore: boolean; nextCursor?: string }> {
  const client = await getClientForAccount(accountId);
  const response = await (client as unknown as { databases: { query: (args: Record<string, unknown>) => Promise<{ results: Record<string, unknown>[]; has_more: boolean; next_cursor: string | null }> } }).databases.query({
    database_id: databaseId,
    page_size: opts?.pageSize || 50,
    start_cursor: opts?.startCursor,
  });
  return {
    results: response.results,
    hasMore: response.has_more,
    nextCursor: response.next_cursor ?? undefined,
  };
}

export async function listUsers(accountId: string): Promise<Record<string, unknown>[]> {
  const client = await getClientForAccount(accountId);
  const response = await client.users.list({});
  return response.results as Record<string, unknown>[];
}


