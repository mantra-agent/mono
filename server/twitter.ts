import { createHmac, randomBytes } from "crypto";
import { createLogger } from "./log";
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
} from "./connected-accounts";
import { decryptTokens } from "./encryption";

const log = createLogger("Twitter");

export interface TwitterTokens {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  bearerToken?: string;
}

export interface TwitterPermissions {
  post: boolean;
  reply: boolean;
  delete: boolean;
}

export const DEFAULT_TWITTER_PERMISSIONS: TwitterPermissions = {
  post: true,
  reply: true,
  delete: false,
};

export interface TwitterAccount {
  id: string;
  label: string;
  addedAt: string;
}

export async function listTwitterAccounts(): Promise<TwitterAccount[]> {
  const accounts = await listAccounts("twitter");
  return accounts.map((a) => ({
    id: a.accountId,
    label: a.label,
    addedAt: a.addedAt.toISOString(),
  }));
}

export async function getTwitterTokens(
  accountId: string
): Promise<TwitterTokens | null> {
  const account = await getAccount(accountId);
  if (!account || !account.tokens) return null;
  const { data } = await decryptTokens(account.tokens);
  if (!data) return null;
  return data as TwitterTokens;
}

export async function addTwitterAccount(
  tokens: TwitterTokens,
  label: string
): Promise<TwitterAccount> {
  const verified = await verifyCredentials(tokens);
  const accountId = `twitter_${verified.username || Date.now()}`;
  const account = await createAccount({
    accountId,
    provider: "twitter",
    email: verified.username ? `@${verified.username}` : undefined,
    label: label || "Personal",
    tokens: tokens as unknown,
    permissions: { ...DEFAULT_TWITTER_PERMISSIONS },
  });
  log.log(`addTwitterAccount id=${accountId} username=${verified.username}`);
  return {
    id: account.accountId,
    label: account.label,
    addedAt: account.addedAt.toISOString(),
  };
}

async function verifyTwitterProvider(accountId: string): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`Account "${accountId}" not found`);
  if (account.provider !== "twitter") throw new Error(`Account "${accountId}" is not a Twitter account`);
}

export async function removeTwitterAccount(accountId: string): Promise<void> {
  await verifyTwitterProvider(accountId);
  await deleteAccount(accountId);
  log.log(`removeTwitterAccount id=${accountId}`);
}

export function resolveTwitterPermissions(
  stored: unknown
): TwitterPermissions {
  if (!stored || typeof stored !== "object")
    return { ...DEFAULT_TWITTER_PERMISSIONS };
  const raw = stored as Record<string, unknown>;
  return {
    post:
      typeof raw.post === "boolean"
        ? raw.post
        : DEFAULT_TWITTER_PERMISSIONS.post,
    reply:
      typeof raw.reply === "boolean"
        ? raw.reply
        : DEFAULT_TWITTER_PERMISSIONS.reply,
    delete:
      typeof raw.delete === "boolean"
        ? raw.delete
        : DEFAULT_TWITTER_PERMISSIONS.delete,
  };
}

export async function getTwitterPermissions(
  accountId: string
): Promise<TwitterPermissions> {
  const account = await getAccount(accountId);
  return resolveTwitterPermissions(account?.permissions);
}

export async function setTwitterPermissions(
  accountId: string,
  perms: Partial<TwitterPermissions>
): Promise<TwitterPermissions> {
  await verifyTwitterProvider(accountId);
  const current = await getTwitterPermissions(accountId);
  const merged = { ...current, ...perms };
  await updateAccount(accountId, { permissions: merged });
  log.log(
    `setTwitterPermissions accountId=${accountId} changed=${Object.keys(perms).join(",")}`
  );
  return merged;
}

export async function updateBearerToken(
  accountId: string,
  bearerToken: string
): Promise<void> {
  await verifyTwitterProvider(accountId);
  const tokens = await getTwitterTokens(accountId);
  if (!tokens) throw new Error(`No tokens found for account "${accountId}"`);
  const merged = { ...tokens, bearerToken };
  await updateAccount(accountId, { tokens: merged as unknown });
  log.log(`updateBearerToken accountId=${accountId}`);
}

export async function checkTwitterPermission(
  accountId: string,
  key: keyof TwitterPermissions
): Promise<boolean> {
  const perms = await getTwitterPermissions(accountId);
  return perms[key];
}

export function parseTweetId(input: string): string | null {
  const urlMatch = input.match(
    /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i
  );
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

export function parseArticleId(input: string): string | null {
  const urlMatch = input.match(
    /(?:twitter\.com|x\.com)\/i\/articles\/(\d+)/i
  );
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string
): string {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", signingKey).update(baseString).digest("base64");
}

function buildOAuthHeader(
  method: string,
  url: string,
  tokens: TwitterTokens,
  extraParams: Record<string, string> = {}
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: tokens.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: tokens.accessToken,
    oauth_version: "1.0",
  };

  const allParams = { ...oauthParams, ...extraParams };
  const signature = generateOAuthSignature(
    method,
    url,
    allParams,
    tokens.apiSecret,
    tokens.accessTokenSecret
  );
  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

function extractBaseUrlAndQueryParams(fullUrl: string): { baseUrl: string; queryParams: Record<string, string> } {
  const urlObj = new URL(fullUrl);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
  const queryParams: Record<string, string> = {};
  urlObj.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });
  return { baseUrl, queryParams };
}

async function twitterApiRequest(
  method: string,
  url: string,
  tokens: TwitterTokens,
  body?: unknown
): Promise<any> {
  const { baseUrl, queryParams } = extractBaseUrlAndQueryParams(url);
  const authHeader = buildOAuthHeader(method, baseUrl, tokens, queryParams);
  const headers: Record<string, string> = {
    Authorization: authHeader,
  };
  const options: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const errorMsg =
      data?.detail || data?.errors?.[0]?.message || data?.title || text;
    throw new Error(`Twitter API error (${res.status}): ${errorMsg}`);
  }
  return data;
}

export async function verifyCredentials(
  tokens: TwitterTokens
): Promise<{ id: string; username: string; name: string }> {
  const url = "https://api.x.com/2/users/me";
  const data = await twitterApiRequest("GET", url, tokens);
  return {
    id: data.data?.id || "",
    username: data.data?.username || "",
    name: data.data?.name || "",
  };
}

export async function postTweet(
  tokens: TwitterTokens,
  text: string
): Promise<{ id: string; url: string; text: string }> {
  const url = "https://api.x.com/2/tweets";
  const data = await twitterApiRequest("POST", url, tokens, { text });
  const tweetId = data.data?.id;
  const me = await verifyCredentials(tokens);
  return {
    id: tweetId,
    url: `https://x.com/${me.username}/status/${tweetId}`,
    text: data.data?.text || text,
  };
}

export async function replyToTweet(
  tokens: TwitterTokens,
  tweetId: string,
  text: string
): Promise<{ id: string; url: string; text: string }> {
  const url = "https://api.x.com/2/tweets";
  const data = await twitterApiRequest("POST", url, tokens, {
    text,
    reply: { in_reply_to_tweet_id: tweetId },
  });
  const replyId = data.data?.id;
  const me = await verifyCredentials(tokens);
  return {
    id: replyId,
    url: `https://x.com/${me.username}/status/${replyId}`,
    text: data.data?.text || text,
  };
}

export async function lookupTweet(
  tokens: TwitterTokens,
  tweetId: string
): Promise<{
  id: string;
  text: string;
  authorId: string;
  authorUsername: string;
  authorName: string;
  metrics: { likes: number; retweets: number; replies: number; impressions: number };
  createdAt: string;
  url: string;
}> {
  const url = `https://api.x.com/2/tweets/${tweetId}?tweet.fields=created_at,public_metrics,author_id,note_tweet&expansions=author_id&user.fields=username,name`;
  const data = await twitterApiRequest("GET", url, tokens);
  const tweet = data.data;
  const author = data.includes?.users?.[0] || {};
  const metrics = tweet?.public_metrics || {};
  return {
    id: tweet?.id || tweetId,
    text: tweet?.note_tweet?.text || tweet?.text || "",
    authorId: tweet?.author_id || "",
    authorUsername: author?.username || "",
    authorName: author?.name || "",
    metrics: {
      likes: metrics.like_count || 0,
      retweets: metrics.retweet_count || 0,
      replies: metrics.reply_count || 0,
      impressions: metrics.impression_count || 0,
    },
    createdAt: tweet?.created_at || "",
    url: `https://x.com/${author?.username || "i"}/status/${tweet?.id || tweetId}`,
  };
}

export async function deleteTweet(
  tokens: TwitterTokens,
  tweetId: string
): Promise<{ deleted: boolean }> {
  const url = `https://api.x.com/2/tweets/${tweetId}`;
  const data = await twitterApiRequest("DELETE", url, tokens);
  return { deleted: data.data?.deleted ?? true };
}

async function twitterBearerApiRequest(
  url: string,
  bearerToken: string
): Promise<any> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const errorMsg =
      data?.detail || data?.errors?.[0]?.message || data?.title || text;
    throw new Error(`Twitter API error (${res.status}): ${errorMsg}`);
  }
  return data;
}

export async function searchNews(
  bearerToken: string,
  query: string,
  maxResults?: number
): Promise<any> {
  const params = new URLSearchParams({ query });
  if (maxResults) params.set("max_results", String(maxResults));
  const url = `https://api.x.com/2/news/search?${params.toString()}`;
  return twitterBearerApiRequest(url, bearerToken);
}

export async function lookupNews(
  bearerToken: string,
  articleId: string
): Promise<any> {
  const url = `https://api.x.com/2/news/${articleId}`;
  return twitterBearerApiRequest(url, bearerToken);
}

export async function isTwitterConnected(): Promise<boolean> {
  const accounts = await listTwitterAccounts();
  return accounts.length > 0;
}

export async function getFirstAccountTokens(): Promise<{
  tokens: TwitterTokens;
  accountId: string;
} | null> {
  const accounts = await listTwitterAccounts();
  if (accounts.length === 0) return null;
  const tokens = await getTwitterTokens(accounts[0].id);
  if (!tokens) return null;
  return { tokens, accountId: accounts[0].id };
}

export async function verifyStoredCredentials(
  accountId: string
): Promise<{ valid: boolean; username?: string; error?: string }> {
  const tokens = await getTwitterTokens(accountId);
  if (!tokens) return { valid: false, error: "No tokens stored" };
  try {
    const user = await verifyCredentials(tokens);
    await updateAccount(accountId, {
      healthy: true,
      healthError: null,
      healthCheckedAt: new Date(),
      email: `@${user.username}`,
    });
    return { valid: true, username: user.username };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : "Unknown error";
    await updateAccount(accountId, {
      healthy: false,
      healthError: error,
      healthCheckedAt: new Date(),
    });
    return { valid: false, error };
  }
}

// ── User Timeline Helpers (v2 Bearer) ─────────────────────────────

interface TwitterUser {
  id: string;
  name: string;
  username: string;
}

interface Tweet {
  id: string;
  text: string;
  created_at?: string;
}

export async function getUserByUsername(
  bearerToken: string,
  username: string
): Promise<TwitterUser | null> {
  const clean = username.replace(/^@/, "");
  const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(clean)}`;
  try {
    const data = await twitterBearerApiRequest(url, bearerToken);
    return data.data || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`getUserByUsername: failed for @${clean}: ${msg}`);
    return null;
  }
}

export async function getUserTweets(
  bearerToken: string,
  userId: string,
  opts?: { maxResults?: number; excludeReplies?: boolean; excludeRetweets?: boolean }
): Promise<Tweet[]> {
  const params = new URLSearchParams();
  params.set("max_results", String(opts?.maxResults ?? 50));
  params.set("tweet.fields", "created_at");
  const excludes: string[] = [];
  if (opts?.excludeReplies !== false) excludes.push("replies");
  if (opts?.excludeRetweets !== false) excludes.push("retweets");
  if (excludes.length > 0) params.set("exclude", excludes.join(","));

  const url = `https://api.x.com/2/users/${userId}/tweets?${params.toString()}`;
  try {
    const data = await twitterBearerApiRequest(url, bearerToken);
    return Array.isArray(data.data) ? data.data : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`getUserTweets: failed for user ${userId}: ${msg}`);
    return [];
  }
}
