
import { createLogger } from './log';
import { storage } from './storage';
import { google } from 'googleapis';
import { getSecretSync } from './secrets-store';
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountTokens,
  setAccountTokens,
  type GoogleTokens,
} from './connected-accounts';

const log = createLogger("Gmail");
let oauthRedirectUriLogged = false;

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
];

export interface GmailAccount {
  id: string;
  email: string;
  label: string;
  addedAt: string;
}

export async function listGmailAccounts(): Promise<GmailAccount[]> {
  const accounts = await listAccounts("google");
  return accounts.map(a => ({
    id: a.accountId,
    email: a.email || '',
    label: a.label,
    addedAt: a.addedAt.toISOString(),
  }));
}

export async function loadAccountTokens(accountId: string): Promise<GoogleTokens | null> {
  return getAccountTokens(accountId);
}

export async function saveAccountTokens(accountId: string, tokens: GoogleTokens): Promise<void> {
  await setAccountTokens(accountId, tokens);
}

export async function getAuthUrlForAccount(label: string, originHost?: string): Promise<string> {
  const oauth2Client = await getOAuth2Client(originHost);
  const state = Buffer.from(JSON.stringify({ label, multiAccount: true })).toString('base64url');
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    prompt: 'consent',
    state,
  });
}

export function parseOAuthState(stateRaw: string | undefined): { label?: string; multiAccount?: boolean } {
  if (!stateRaw) return {};
  try {
    return JSON.parse(Buffer.from(stateRaw, 'base64url').toString());
  } catch {
    return {};
  }
}

export async function handleAccountOAuthCallback(code: string, label: string, originHost?: string): Promise<GmailAccount> {
  const oauth2Client = await getOAuth2Client(originHost);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  let email = '';
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    email = userInfo.data.email || '';
  } catch (err: unknown) {
    log.warn("userinfo lookup failed", err instanceof Error ? err.message : err);
  }

  const accounts = await listAccounts("google");
  const existing = accounts.find(a => (a.email || '').toLowerCase() === email.toLowerCase());

  if (existing) {
    await setAccountTokens(existing.accountId, { ...tokens, email } as GoogleTokens);
    clearHealthCache(existing.accountId);
    return { id: existing.accountId, email: existing.email || '', label: existing.label, addedAt: existing.addedAt.toISOString() };
  }

  const id = email.split('@')[0].replace(/[^a-z0-9]/gi, '_').toLowerCase() || `account_${Date.now()}`;
  const account = await createAccount({
    accountId: id,
    provider: 'google',
    email,
    label: label || 'Personal',
    tokens: { ...tokens, email } as unknown,
  });
  clearHealthCache(id);
  log.debug(`handleAccountOAuthCallback new account id=${id} email=${email}`);
  return { id: account.accountId, email: account.email || '', label: account.label, addedAt: account.addedAt.toISOString() };
}

export async function removeGmailAccount(accountId: string): Promise<void> {
  const cleanup = await storage.cleanupEmailAccountState(accountId);
  await deleteAccount(accountId);
  clearHealthCache(accountId);
  log.log(`removeGmailAccount id=${accountId} cleanup=${JSON.stringify(cleanup.deleted)}`);
}

export async function updateAccountLabel(accountId: string, label: string): Promise<GmailAccount | null> {
  const updated = await updateAccount(accountId, { label });
  if (!updated) return null;
  return { id: updated.accountId, email: updated.email || '', label: updated.label, addedAt: updated.addedAt.toISOString() };
}

export async function getAccountScopes(accountId: string): Promise<{
  hasGmailRead: boolean;
  hasSend: boolean;
  hasDraft: boolean;
  hasModify: boolean;
  hasCalendar: boolean;
  hasCalendarReadonly: boolean;
  missingScopes: string[];
}> {
  const tokens = await getAccountTokens(accountId);
  if (!tokens) return {
    hasGmailRead: false, hasSend: false, hasDraft: false, hasModify: false,
    hasCalendar: false, hasCalendarReadonly: false,
    missingScopes: GOOGLE_SCOPES.filter(s => s !== 'https://www.googleapis.com/auth/userinfo.email'),
  };
  const scope = tokens.scope || '';
  const hasFullAccess = scope.includes('mail.google.com');
  const result = {
    hasGmailRead: hasFullAccess || scope.includes('gmail.readonly'),
    hasSend: hasFullAccess || scope.includes('gmail.send'),
    hasDraft: hasFullAccess || scope.includes('gmail.compose'),
    hasModify: hasFullAccess || scope.includes('gmail.modify'),
    hasCalendar: scope.split(' ').includes('https://www.googleapis.com/auth/calendar'),
    hasCalendarReadonly: scope.includes('calendar.readonly') || scope.split(' ').includes('https://www.googleapis.com/auth/calendar'),
    missingScopes: [] as string[],
  };
  const scopeChecks: Record<string, boolean> = {
    'https://www.googleapis.com/auth/gmail.readonly': result.hasGmailRead,
    'https://www.googleapis.com/auth/gmail.send': result.hasSend,
    'https://www.googleapis.com/auth/gmail.compose': result.hasDraft,
    'https://www.googleapis.com/auth/gmail.modify': result.hasModify,
    'https://www.googleapis.com/auth/calendar': result.hasCalendar,
    'https://www.googleapis.com/auth/calendar.readonly': result.hasCalendarReadonly,
  };
  result.missingScopes = GOOGLE_SCOPES.filter(s => {
    if (s === 'https://www.googleapis.com/auth/userinfo.email') return false;
    return !scopeChecks[s];
  });
  return result;
}

export function isInvalidGrantError(err: unknown): boolean {
  const errObj = err as Record<string, unknown> | null;
  const msg = String((errObj as { message?: string })?.message || '').toLowerCase();
  const response = errObj as { response?: { data?: { error?: string; error_description?: string; errors?: Array<{ reason?: string }> } } };
  const dataError = String(response?.response?.data?.error || '').toLowerCase();
  const dataDesc = String(response?.response?.data?.error_description || '').toLowerCase();
  const reason = response?.response?.data?.errors?.[0]?.reason?.toLowerCase() || '';
  return msg.includes('invalid_grant') || dataError === 'invalid_grant'
    || dataDesc.includes('token has been expired or revoked')
    || reason === 'autherror'
    || msg.includes('token has been expired or revoked');
}

const healthCache = new Map<string, { healthy: boolean; error?: string; checkedAt: number }>();
const HEALTH_CACHE_TTL = 60_000;

export async function verifyAccountTokenHealth(accountId: string): Promise<{ healthy: boolean; error?: string; missingScopes?: string[] }> {
  const cached = healthCache.get(accountId);
  if (cached && Date.now() - cached.checkedAt < HEALTH_CACHE_TTL) {
    return { healthy: cached.healthy, error: cached.error };
  }
  try {
    const gmail = await getReadClientForAccount(accountId);
    await gmail.users.getProfile({ userId: 'me' });

    const scopes = await getAccountScopes(accountId);
    const missing = scopes.missingScopes;
    if (missing.length > 0) {
      const account = await getAccount(accountId);
      log.warn(`Account ${account?.email || accountId} healthy but missing scopes`, {
        accountId,
        accountEmail: account?.email,
        missingScopes: missing,
      });
    }

    healthCache.set(accountId, { healthy: true, checkedAt: Date.now() });
    await updateAccount(accountId, {
      healthy: true,
      healthError: null,
      healthCheckedAt: new Date(),
      missingScopes: missing.length > 0 ? missing : null,
    });
    return { healthy: true, missingScopes: missing.length > 0 ? missing : undefined };
  } catch (err: unknown) {
    let error: string;
    const isInitError =
      err instanceof TypeError ||
      (err instanceof Error && err.message.includes('Google OAuth client failed to initialize'));
    if (isInitError) {
      error = 'Google OAuth client failed to initialize — check GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET';
      log.error('verifyAccountTokenHealth init failure:', err instanceof Error ? err.message : String(err));
    } else if (isInvalidGrantError(err)) {
      error = 'Token expired or revoked — re-authorization required';
    } else {
      error = err instanceof Error ? err.message : 'Unknown error';
    }
    healthCache.set(accountId, { healthy: false, error, checkedAt: Date.now() });
    await updateAccount(accountId, { healthy: false, healthError: error, healthCheckedAt: new Date() });
    return { healthy: false, error };
  }
}

export function clearHealthCache(accountId?: string): void {
  if (accountId) {
    healthCache.delete(accountId);
  } else {
    healthCache.clear();
  }
}

export async function getReadClientForAccount(accountId: string) {
  const tokens = await getAccountTokens(accountId);
  if (!tokens) {
    throw new Error(`No tokens for account ${accountId}`);
  }
  const scope = tokens.scope || '';
  if (!scope.includes('gmail.readonly') && !scope.includes('mail.google.com')) {
    throw new Error(`Account "${accountId}" needs re-authorization — Gmail read permission was not granted. Please remove and re-add this account.`);
  }
  const oauth2Client = await getOAuth2Client();
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens } as GoogleTokens;
    await setAccountTokens(accountId, merged);
  });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ─── Unified Google OAuth client ───

export async function isConnectorConnected(): Promise<boolean> {
  return false;
}

export async function getOAuth2Client(originHost?: string) {
  const clientId = getSecretSync('GOOGLE_CLIENT_ID');
  const clientSecret = getSecretSync('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required for Gmail read access');
  }

  let redirectUri: string;
  if (originHost) {
    const protocol = originHost.includes('localhost') ? 'http' : 'https';
    redirectUri = `${protocol}://${originHost}/api/gmail/oauth/callback`;
  } else {
    const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
    redirectUri = publicUrl
      ? `${publicUrl}/api/gmail/oauth/callback`
      : 'http://localhost:5000/api/gmail/oauth/callback';
  }

  if (!oauthRedirectUriLogged) {
    log.debug(`OAuth redirect_uri=${redirectUri} originHost=${originHost || '(none)'}`);
    oauthRedirectUriLogged = true;
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}


// ─── Unified Gmail operations ───

export async function getReadClientAuto(accountId?: string) {
  if (accountId) {
    return await getReadClientForAccount(accountId);
  }
  const accounts = await listGmailAccounts();
  for (const acct of accounts) {
    try {
      return await getReadClientForAccount(acct.id);
    } catch (err: unknown) { log.debug("account client fallback", acct.id, err instanceof Error ? err.message : err); }
  }
  throw new Error('No Gmail accounts connected. Add an account in Settings → Connections.');
}

export async function getGmailClient() {
  return await getReadClientAuto();
}

export async function isGmailConnected(): Promise<boolean> {
  const accounts = await listGmailAccounts();
  for (const a of accounts) {
    const scopes = await getAccountScopes(a.id);
    if (scopes.hasGmailRead) return true;
  }
  return false;
}

export async function listLabels() {
  const gmail = await getGmailClient();
  const res = await gmail.users.labels.list({ userId: 'me' });
  return res.data.labels || [];
}

const labelMapCache = new Map<string, { map: Map<string, string>; cachedAt: number }>();
const LABEL_MAP_TTL = 5 * 60 * 1000;

export async function getAccountLabelMap(accountId: string): Promise<Map<string, string>> {
  const cached = labelMapCache.get(accountId);
  if (cached && Date.now() - cached.cachedAt < LABEL_MAP_TTL) {
    return cached.map;
  }
  try {
    const gmail = await getReadClientForAccount(accountId);
    const res = await gmail.users.labels.list({ userId: 'me' });
    const map = new Map<string, string>();
    for (const l of res.data.labels || []) {
      if (l.id && l.name) map.set(l.id, l.name);
    }
    labelMapCache.set(accountId, { map, cachedAt: Date.now() });
    return map;
  } catch {
    return new Map();
  }
}

export async function archiveEmail(accountId: string, providerMessageId: string): Promise<boolean> {
  const scopes = await getAccountScopes(accountId);
  if (!scopes.hasModify) {
    const account = await getAccount(accountId);
    log.error(`Archive failed: account ${account?.email || accountId} lacks gmail.modify scope`, {
      accountId,
      accountEmail: account?.email,
      operation: 'archive',
      missingScope: 'gmail.modify',
    });
    return false;
  }
  const gmail = await getReadClientForAccount(accountId);
  await gmail.users.messages.modify({
    userId: 'me',
    id: providerMessageId,
    requestBody: { removeLabelIds: ['INBOX'] },
  });
  return true;
}

export async function unarchiveEmail(accountId: string, providerMessageId: string): Promise<boolean> {
  const scopes = await getAccountScopes(accountId);
  if (!scopes.hasModify) {
    const account = await getAccount(accountId);
    log.error(`Unarchive failed: account ${account?.email || accountId} lacks gmail.modify scope`, {
      accountId,
      accountEmail: account?.email,
      operation: 'unarchive',
      missingScope: 'gmail.modify',
    });
    return false;
  }
  const gmail = await getReadClientForAccount(accountId);
  await gmail.users.messages.modify({
    userId: 'me',
    id: providerMessageId,
    requestBody: { addLabelIds: ['INBOX'] },
  });
  return true;
}

export async function getProfile(accountId?: string) {
  const gmail = await getReadClientAuto(accountId);
  const res = await gmail.users.getProfile({ userId: 'me' });
  return res.data;
}

export async function listMessages(
  query?: string,
  maxResults = 20,
  accountId?: string,
  options?: { paginate?: boolean; paginationCap?: number },
): Promise<Array<{ id?: string | null; threadId?: string | null }>> {
  const gmail = await getReadClientAuto(accountId);
  const paginate = options?.paginate ?? false;
  const rawCap = options?.paginationCap ?? 100;
  const paginationCap = paginate ? Math.min(maxResults, rawCap) : rawCap;

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query || undefined,
    maxResults: paginate ? Math.min(maxResults, 100) : maxResults,
  });

  const messages = res.data.messages || [];
  log.debug(`listMessages acct=${accountId ?? 'default'} q="${query ?? '(none)'}" page1=${messages.length} paginate=${paginate}`);

  if (!paginate || !res.data.nextPageToken || messages.length >= paginationCap) {
    return paginate ? messages.slice(0, paginationCap) : messages;
  }

  let nextPageToken: string | undefined | null = res.data.nextPageToken;
  while (nextPageToken && messages.length < paginationCap) {
    const page: any = await gmail.users.messages.list({
      userId: 'me',
      q: query || undefined,
      maxResults: Math.min(100, paginationCap - messages.length),
      pageToken: nextPageToken,
    });
    const pageMessages = page.data.messages || [];
    messages.push(...pageMessages);
    nextPageToken = page.data.nextPageToken;
    log.debug(`listMessages pagination acct=${accountId ?? 'default'} pageSize=${pageMessages.length} total=${messages.length} hasMore=${!!nextPageToken}`);
  }

  return messages.slice(0, paginationCap);
}

export async function getMessage(messageId: string, format: 'full' | 'metadata' | 'minimal' = 'metadata', accountId?: string) {
  const gmail = await getReadClientAuto(accountId);
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format,
  });
  return res.data;
}

export async function getAttachment(messageId: string, attachmentId: string, accountId?: string): Promise<{ data: string; size: number }> {
  const gmail = await getReadClientAuto(accountId);
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  return { data: res.data.data || '', size: res.data.size || 0 };
}

export async function listThreads(query?: string, maxResults = 50, accountId?: string) {
  const gmail = await getReadClientAuto(accountId);
  const res = await gmail.users.threads.list({
    userId: 'me',
    q: query || undefined,
    maxResults,
  });
  return res.data.threads || [];
}

export async function getThread(threadId: string, accountId?: string) {
  const gmail = await getReadClientAuto(accountId);
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Date'],
  });
  return res.data;
}

export async function sendEmail(to: string, subject: string, body: string, accountId?: string) {
  const gmail = await getReadClientAuto(accountId);

  const messageParts = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    body,
  ];
  const rawMessage = Buffer.from(messageParts.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: rawMessage },
  });
  return res.data;
}

export async function createDraft(to: string, subject: string, body: string, accountId?: string) {
  const gmail = await getReadClientAuto(accountId);

  const messageParts = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    body,
  ];
  const rawMessage = Buffer.from(messageParts.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw: rawMessage },
    },
  });
  log.debug(`createDraft to=${to} subject="${subject}" draftId=${res.data.id}`);
  return res.data;
}

// ─── History & message normalization helpers ───

export interface NormalizedMessage {
  provider: string;
  accountId: string;
  providerMessageId: string;
  providerThreadId: string | null;
  historyId: string | null;
  subject: string | null;
  snippet: string | null;
  fromAddress: string | null;
  toAddresses: string | null;
  ccAddresses: string | null;
  direction: "inbound" | "outbound" | "unknown";
  date: Date | null;
  labelIds: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  isRead: boolean;
  isStarred: boolean;
}

function getHeader(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string): string | null {
  if (!headers) return null;
  const h = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function extractBody(payload: any): { text: string | null; html: string | null } {
  let text: string | null = null;
  let html: string | null = null;

  if (!payload) return { text, html };

  const decode = (data: string | undefined | null) => {
    if (!data) return null;
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  };

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    text = decode(payload.body.data);
  } else if (payload.mimeType === 'text/html' && payload.body?.data) {
    html = decode(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const sub = extractBody(part);
      if (sub.text && !text) text = sub.text;
      if (sub.html && !html) html = sub.html;
    }
  }

  return { text, html };
}

export function normalizeGmailMessage(raw: any, accountId: string): NormalizedMessage {
  const headers = raw.payload?.headers || [];
  const labelIds: string[] = raw.labelIds || [];
  const direction: "inbound" | "outbound" | "unknown" = labelIds.includes("SENT") ? "outbound" : "inbound";
  const { text, html } = extractBody(raw.payload);

  let dateVal: Date | null = null;
  const dateHeader = getHeader(headers, 'Date');
  if (dateHeader) {
    const parsed = new Date(dateHeader);
    if (!isNaN(parsed.getTime())) dateVal = parsed;
  }
  if (!dateVal && raw.internalDate) {
    dateVal = new Date(parseInt(raw.internalDate));
  }

  return {
    provider: 'gmail',
    accountId,
    providerMessageId: raw.id || '',
    providerThreadId: raw.threadId || null,
    historyId: raw.historyId || null,
    subject: getHeader(headers, 'Subject'),
    snippet: raw.snippet || null,
    fromAddress: getHeader(headers, 'From'),
    toAddresses: getHeader(headers, 'To'),
    ccAddresses: getHeader(headers, 'Cc'),
    direction,
    date: dateVal,
    labelIds,
    bodyText: text,
    bodyHtml: html,
    isRead: !labelIds.includes('UNREAD'),
    isStarred: labelIds.includes('STARRED'),
  };
}

export async function getHistoryList(
  startHistoryId: string,
  accountId?: string,
): Promise<{ history: any[]; historyId: string | null }> {
  const gmail = await getReadClientAuto(accountId);
  const allHistory: any[] = [];
  let pageToken: string | undefined;
  let latestHistoryId: string | null = null;

  try {
    do {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
        pageToken,
      });

      latestHistoryId = res.data.historyId || null;
      const historyRecords = res.data.history || [];
      allHistory.push(...historyRecords);
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  } catch (err: any) {
    if (err?.code === 404 || err?.status === 404 || err?.message?.includes('notFound')) {
      throw Object.assign(new Error('History ID expired'), { code: 404 });
    }
    throw err;
  }

  log.debug(`getHistoryList acct=${accountId ?? 'default'} startHistoryId=${startHistoryId} records=${allHistory.length}`);
  return { history: allHistory, historyId: latestHistoryId };
}

// ─── Contact extraction from Gmail threads ───

interface EmailInteraction {
  date: string;
  subject: string;
  direction: 'sent' | 'received';
  snippet?: string;
}

interface EmailContact {
  email: string;
  name: string;
  sentCount: number;
  receivedCount: number;
  threadCount: number;
  lastInteraction: string;
  firstInteraction: string;
  sampleSubjects: string[];
  interactions: EmailInteraction[];
}

export interface ScanProgress {
  status: 'idle' | 'scanning' | 'done' | 'error';
  threadsProcessed: number;
  threadsTotal: number;
  contactsFound: number;
  error?: string;
}

const scanProgressByUser = new Map<string, ScanProgress>();

function getOrCreateProgress(userId: string): ScanProgress {
  if (!scanProgressByUser.has(userId)) {
    scanProgressByUser.set(userId, { status: 'idle', threadsProcessed: 0, threadsTotal: 0, contactsFound: 0 });
  }
  return scanProgressByUser.get(userId)!;
}

export function getScanProgress(userId = 'default'): ScanProgress {
  return { ...getOrCreateProgress(userId) };
}

export function resetScanProgress(userId = 'default'): void {
  scanProgressByUser.delete(userId);
}

function parseEmailAddress(raw: string): { name: string; email: string } | null {
  const match = raw.match(/(?:"?([^"]*)"?\s)?<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/);
  if (!match) return null;
  return { name: (match[1] || '').trim(), email: match[2].toLowerCase() };
}

const SKIP_PATTERNS = [
  /noreply/i, /no-reply/i, /donotreply/i, /do-not-reply/i,
  /notifications?@/i, /alerts?@/i, /updates?@/i, /info@/i,
  /support@/i, /help@/i, /mailer-daemon/i, /postmaster/i,
  /newsletter/i, /marketing@/i, /promo/i, /unsubscribe/i,
  /bounce/i, /daemon/i, /automated/i, /system@/i,
  /@googlegroups\.com$/i, /@groups\./i, /@list\./i,
  /@calendar-notification/i, /@docs\.google\.com/i,
  /@noreply\.github\.com/i,
];

function isAutomatedAddress(email: string): boolean {
  return SKIP_PATTERNS.some(p => p.test(email));
}

export interface ScanBatchResult {
  candidates: EmailContact[];
  nextPageToken?: string;
  threadsProcessed: number;
  estimatedTotal: number;
  hasMore: boolean;
  oldestDate?: string;
  newestDate?: string;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePayload {
  headers?: GmailHeader[];
}

interface GmailMessage {
  payload?: GmailMessagePayload;
  snippet?: string;
}

const scanStateByUser = new Map<string, { contactMap: Map<string, EmailContact>; threadsProcessed: number; myEmail: string; oldestDate?: string; newestDate?: string }>();

function buildScanQuery(afterDate?: string, beforeDate?: string): string {
  const queryParts = ['-category:promotions -category:social -category:updates -category:forums'];
  if (afterDate) queryParts.push(`after:${afterDate.replace(/-/g, '/')}`);
  if (beforeDate) queryParts.push(`before:${beforeDate.replace(/-/g, '/')}`);
  return queryParts.join(' ');
}

function parseContactsFromThread(
  messages: GmailMessage[],
  myEmail: string,
): { contacts: { name: string; email: string }[]; isRealConvo: boolean; messageDetails: Array<{ from: { name: string; email: string } | null; contacts: { name: string; email: string }[]; subject: string; dateStr: string; snippet: string }> } {
  const iSent = messages.some(m => {
    const from = m.payload?.headers?.find((h: GmailHeader) => h.name === 'From')?.value || '';
    const parsed = parseEmailAddress(from);
    return parsed && parsed.email === myEmail;
  });

  const iReceived = messages.some(m => {
    const from = m.payload?.headers?.find((h: GmailHeader) => h.name === 'From')?.value || '';
    const parsed = parseEmailAddress(from);
    return parsed && parsed.email !== myEmail;
  });

  const isRealConvo = iSent && iReceived;
  const messageDetails: Array<{ from: { name: string; email: string } | null; contacts: { name: string; email: string }[]; subject: string; dateStr: string; snippet: string }> = [];

  for (const msg of messages) {
    const headers = msg.payload?.headers || [];
    const fromRaw = headers.find((h: GmailHeader) => h.name === 'From')?.value || '';
    const toRaw = headers.find((h: GmailHeader) => h.name === 'To')?.value || '';
    const subject = headers.find((h: GmailHeader) => h.name === 'Subject')?.value || '';
    const dateStr = headers.find((h: GmailHeader) => h.name === 'Date')?.value || '';

    const from = parseEmailAddress(fromRaw);
    const toList = toRaw.split(',').map((t: string) => parseEmailAddress(t.trim())).filter(Boolean) as { name: string; email: string }[];

    const contacts = from && from.email !== myEmail ? [from] : [];
    contacts.push(...toList.filter(c => c.email !== myEmail));

    messageDetails.push({ from, contacts, subject, dateStr, snippet: msg.snippet || '' });
  }

  const allContacts = messageDetails.flatMap(d => d.contacts);
  return { contacts: allContacts, isRealConvo, messageDetails };
}

function updateContactMap(
  contactMap: Map<string, EmailContact>,
  messageDetails: Array<{ from: { name: string; email: string } | null; contacts: { name: string; email: string }[]; subject: string; dateStr: string; snippet: string }>,
  isRealConvo: boolean,
  state: { oldestDate?: string; newestDate?: string },
): void {
  for (const detail of messageDetails) {
    for (const contact of detail.contacts) {
      if (isAutomatedAddress(contact.email)) continue;

      const existing = contactMap.get(contact.email) || {
        email: contact.email,
        name: contact.name || '',
        sentCount: 0,
        receivedCount: 0,
        threadCount: 0,
        lastInteraction: '',
        firstInteraction: '',
        sampleSubjects: [],
        interactions: [],
      };

      if (contact.name && (!existing.name || existing.name.length < contact.name.length)) {
        existing.name = contact.name;
      }

      const direction: 'sent' | 'received' = (detail.from && detail.from.email === contact.email) ? 'received' : 'sent';
      if (direction === 'received') {
        existing.receivedCount++;
      } else {
        existing.sentCount++;
      }

      if (detail.dateStr) {
        const d = new Date(detail.dateStr).toISOString();
        if (!existing.firstInteraction || d < existing.firstInteraction) existing.firstInteraction = d;
        if (!existing.lastInteraction || d > existing.lastInteraction) existing.lastInteraction = d;
        existing.interactions.push({ date: d, subject: detail.subject || '(no subject)', direction, snippet: detail.snippet });
        if (!state.oldestDate || d < state.oldestDate) state.oldestDate = d;
        if (!state.newestDate || d > state.newestDate) state.newestDate = d;
      }

      if (detail.subject && !existing.sampleSubjects.includes(detail.subject)) {
        existing.sampleSubjects.push(detail.subject);
      }

      contactMap.set(contact.email, existing);
    }

    if (isRealConvo) {
      for (const contact of detail.contacts) {
        if (isAutomatedAddress(contact.email)) continue;
        const existing = contactMap.get(contact.email);
        if (existing) {
          existing.threadCount++;
        }
      }
    }
  }
}

function filterAndSortCandidates(
  contactMap: Map<string, EmailContact>,
  minThreadCount: number,
  excludeSet: Set<string>,
): EmailContact[] {
  return Array.from(contactMap.values())
    .filter(c => c.threadCount >= minThreadCount && c.sentCount > 0 && c.receivedCount > 0)
    .filter(c => !excludeSet.has(c.email.toLowerCase()))
    .sort((a, b) => b.threadCount - a.threadCount || b.sentCount + b.receivedCount - a.sentCount - a.receivedCount);
}

async function processThreadBatch(
  gmail: Awaited<ReturnType<typeof getReadClientAuto>>,
  state: { contactMap: Map<string, EmailContact>; threadsProcessed: number; myEmail: string; oldestDate?: string; newestDate?: string },
  scanProgress: ScanProgress,
  batchSize: number,
  q: string,
  initialPageToken: string | undefined,
  onProgress?: (processed: number, estimatedTotal: number) => void,
): Promise<{ pageToken: string | undefined; estimatedTotal: number }> {
  const myEmail = state.myEmail;
  const contactMap = state.contactMap;
  let pageToken = initialPageToken;
  let batchProcessed = 0;
  let estimatedTotal = scanProgress.threadsTotal;

  while (batchProcessed < batchSize) {
    const fetchCount = Math.min(50, batchSize - batchProcessed);
    const listRes = await gmail.users.threads.list({ userId: 'me', maxResults: fetchCount, pageToken, q });

    if (state.threadsProcessed === 0 && listRes.data.resultSizeEstimate) {
      estimatedTotal = listRes.data.resultSizeEstimate;
      scanProgress.threadsTotal = estimatedTotal;
    }

    const threads = listRes.data.threads || [];
    if (threads.length === 0) { pageToken = undefined; break; }

    for (const threadStub of threads) {
      if (!threadStub.id) continue;
      try {
        const threadRes = await gmail.users.threads.get({
          userId: 'me', id: threadStub.id, format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });
        const messages = (threadRes.data.messages || []) as GmailMessage[];
        const { isRealConvo, messageDetails } = parseContactsFromThread(messages, myEmail);
        updateContactMap(contactMap, messageDetails, isRealConvo, state);
      } catch (err: unknown) {
        log.error("Thread processing error:", err instanceof Error ? err.message : err);
      }
      batchProcessed++;
      state.threadsProcessed++;
      scanProgress.threadsProcessed = state.threadsProcessed;
      scanProgress.contactsFound = contactMap.size;
    }

    if (onProgress) onProgress(state.threadsProcessed, estimatedTotal);
    pageToken = listRes.data.nextPageToken || undefined;
    if (!pageToken) break;
  }

  return { pageToken, estimatedTotal };
}

export async function extractContactCandidatesBatch(opts: {
  batchSize?: number;
  minThreadCount?: number;
  afterDate?: string;
  beforeDate?: string;
  userId?: string;
  accountId?: string;
  gmailPageToken?: string;
  excludeEmails?: string[];
  onProgress?: (processed: number, estimatedTotal: number) => void;
} = {}): Promise<ScanBatchResult> {
  const { batchSize = 200, minThreadCount = 3, afterDate, beforeDate, userId = 'default', accountId, gmailPageToken, excludeEmails = [], onProgress } = opts;
  const excludeSet = new Set(excludeEmails.map(e => e.toLowerCase()));
  const scanProgress = getOrCreateProgress(userId);

  if (scanProgress.status === 'scanning') {
    throw new Error('A scan is already in progress');
  }

  scanProgress.status = 'scanning';
  scanProgress.error = undefined;

  const isResume = !!gmailPageToken;
  let state = scanStateByUser.get(userId);

  if (!isResume || !state) {
    state = { contactMap: new Map(), threadsProcessed: 0, myEmail: '', oldestDate: undefined, newestDate: undefined };
    scanStateByUser.set(userId, state);
    scanProgress.threadsProcessed = 0;
    scanProgress.threadsTotal = batchSize;
    scanProgress.contactsFound = 0;
  }

  try {
    const gmail = await getReadClientAuto(accountId);
    if (!state.myEmail) {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      state.myEmail = profile.data.emailAddress?.toLowerCase() || '';
    }

    const q = buildScanQuery(afterDate, beforeDate);
    const { pageToken, estimatedTotal } = await processThreadBatch(gmail, state, scanProgress, batchSize, q, gmailPageToken, onProgress);

    const hasMore = !!pageToken;
    const candidates = filterAndSortCandidates(state.contactMap, minThreadCount, excludeSet);
    scanProgress.status = 'done';
    scanProgress.contactsFound = candidates.length;

    if (!hasMore) scanStateByUser.delete(userId);

    return {
      candidates,
      nextPageToken: pageToken,
      threadsProcessed: state.threadsProcessed,
      estimatedTotal,
      hasMore,
      oldestDate: state.oldestDate,
      newestDate: state.newestDate,
    };
  } catch (err: unknown) {
    scanProgress.status = 'error';
    scanProgress.error = err instanceof Error ? err.message : String(err);
    scanStateByUser.delete(userId);
    throw err;
  }
}
