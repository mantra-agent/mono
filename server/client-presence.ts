import type { IncomingMessage } from "http";
import crypto from "crypto";
import { WebSocket } from "ws";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { ensureUserIdentityFoundation } from "./principal";
import { createLogger } from "./log";
import type { ClientPresenceEntry, ClientPresenceKind, ClientPresenceSnapshot } from "@shared/client-presence";

const log = createLogger("ClientPresence");

type PresenceConnection = {
  id: string;
  accountId: string;
  kind: ClientPresenceKind;
  connectedAt: Date;
  lastSeenAt: Date;
  wsRefCount: number;
  httpLastSeenAt?: Date;
  external: boolean;
};

type AccountPresence = {
  clients: Map<string, PresenceConnection>;
  subscribers: Set<WebSocket>;
  externalRefCounts: Map<string, number>;
};

const accounts = new Map<string, AccountPresence>();
const wsPresenceIds = new WeakMap<WebSocket, { accountId: string; presenceId: string }>();
const wsSubscriberAccounts = new WeakMap<WebSocket, string>();
let connectionCounter = 0;
const HTTP_CLIENT_TTL_MS = 45_000;

function getAccount(accountId: string): AccountPresence {
  let account = accounts.get(accountId);
  if (!account) {
    account = { clients: new Map(), subscribers: new Set(), externalRefCounts: new Map() };
    accounts.set(accountId, account);
  }
  return account;
}

function normalizePresenceId(clientId: string | undefined): string | null {
  if (!clientId) return null;
  const safeClientId = clientId.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 120);
  return safeClientId ? `browser:${safeClientId}` : null;
}

function pruneHttpClients(accountId: string): void {
  const account = accounts.get(accountId);
  if (!account) return;
  const cutoff = Date.now() - HTTP_CLIENT_TTL_MS;
  let changed = false;
  for (const [id, client] of account.clients) {
    if (!client.httpLastSeenAt || client.httpLastSeenAt.getTime() >= cutoff) continue;
    client.httpLastSeenAt = undefined;
    if (client.wsRefCount === 0 && !client.external) account.clients.delete(id);
    changed = true;
  }
  if (changed) broadcast(accountId);
}

function maybeDeleteAccount(accountId: string): void {
  const account = accounts.get(accountId);
  if (!account) return;
  if (account.clients.size === 0 && account.subscribers.size === 0) {
    accounts.delete(accountId);
  }
}

function toSnapshot(accountId: string): ClientPresenceSnapshot {
  pruneHttpClients(accountId);
  const account = accounts.get(accountId);
  const clients = Array.from(account?.clients.values() ?? [])
    .sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime())
    .map<ClientPresenceEntry>((client) => ({
      id: client.id,
      kind: client.kind,
      connectedAt: client.connectedAt.toISOString(),
      lastSeenAt: client.lastSeenAt.toISOString(),
    }));
  return { clients };
}

function sendSnapshot(ws: WebSocket, accountId: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "client_presence.snapshot", ...toSnapshot(accountId) }));
  } catch (err) {
    log.warn("snapshot send failed", { accountId, error: err instanceof Error ? err.message : String(err) });
  }
}

function broadcast(accountId: string): void {
  const account = accounts.get(accountId);
  if (!account) return;
  const payload = JSON.stringify({ type: "client_presence.snapshot", ...toSnapshot(accountId) });
  for (const ws of account.subscribers) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    try {
      ws.send(payload);
    } catch (err) {
      log.warn("broadcast send failed", { accountId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function unsignCookie(value: string, secret: string): string | null {
  if (!value.startsWith("s:")) return value;
  const signed = value.slice(2);
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return null;
  const raw = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64").replace(/=+$/, "");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return raw;
}

async function userIdFromRequest(request: IncomingMessage): Promise<string | null> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const cookies = parseCookies(request.headers.cookie);
  const cookieValue = cookies["connect.sid"];
  if (!cookieValue) return null;
  const sid = unsignCookie(cookieValue, secret);
  if (!sid) return null;

  const rows = await db.execute(sql`SELECT sess FROM "session" WHERE sid = ${sid} AND expire > NOW() LIMIT 1`);
  const row = Array.isArray(rows) ? rows[0] : (rows as unknown as { rows?: unknown[] }).rows?.[0];
  const sess = (row as { sess?: { userId?: string } } | undefined)?.sess;
  return typeof sess?.userId === "string" ? sess.userId : null;
}

export async function resolveAccountIdForRequest(request: IncomingMessage): Promise<string | null> {
  const userId = await userIdFromRequest(request);
  if (!userId) return null;
  const user = await storage.getUser(userId);
  if (!user) return null;
  const identity = await ensureUserIdentityFoundation(user);
  return identity.accountId;
}

export async function resolveAccountIdForUser(userId: string): Promise<string | null> {
  const user = await storage.getUser(userId);
  if (!user) return null;
  const identity = await ensureUserIdentityFoundation(user);
  return identity.accountId;
}

export function subscribeClientPresence(ws: WebSocket, accountId: string): void {
  const previous = wsSubscriberAccounts.get(ws);
  if (previous && previous !== accountId) {
    accounts.get(previous)?.subscribers.delete(ws);
    maybeDeleteAccount(previous);
  }
  wsSubscriberAccounts.set(ws, accountId);
  getAccount(accountId).subscribers.add(ws);
  sendSnapshot(ws, accountId);
}

export function registerClientPresence(
  ws: WebSocket,
  accountId: string,
  kind: ClientPresenceKind,
  clientId?: string,
): void {
  const existingSocketPresence = wsPresenceIds.get(ws);
  if (existingSocketPresence) {
    const existing = accounts.get(existingSocketPresence.accountId)?.clients.get(existingSocketPresence.presenceId);
    if (existing) {
      existing.kind = kind;
      existing.lastSeenAt = new Date();
      broadcast(existingSocketPresence.accountId);
      return;
    }
    wsPresenceIds.delete(ws);
  }

  const now = new Date();
  const id = normalizePresenceId(clientId) ?? `client-${++connectionCounter}`;
  const account = getAccount(accountId);
  const existing = account.clients.get(id);
  if (existing) {
    existing.kind = kind;
    existing.lastSeenAt = now;
    existing.wsRefCount += 1;
  } else {
    account.clients.set(id, {
      id,
      accountId,
      kind,
      connectedAt: now,
      lastSeenAt: now,
      wsRefCount: 1,
      external: false,
    });
  }
  wsPresenceIds.set(ws, { accountId, presenceId: id });
  broadcast(accountId);
}

export function unregisterSocketPresence(ws: WebSocket): void {
  const socketPresence = wsPresenceIds.get(ws);
  if (socketPresence) {
    wsPresenceIds.delete(ws);
    const account = accounts.get(socketPresence.accountId);
    const client = account?.clients.get(socketPresence.presenceId);
    if (account && client) {
      client.wsRefCount = Math.max(0, client.wsRefCount - 1);
      client.lastSeenAt = new Date();
      const httpAlive = !!client.httpLastSeenAt && client.httpLastSeenAt.getTime() >= Date.now() - HTTP_CLIENT_TTL_MS;
      if (client.wsRefCount === 0 && !httpAlive && !client.external) {
        account.clients.delete(socketPresence.presenceId);
      }
      broadcast(socketPresence.accountId);
      maybeDeleteAccount(socketPresence.accountId);
    }
  }

  const subscribedAccountId = wsSubscriberAccounts.get(ws);
  if (subscribedAccountId) {
    wsSubscriberAccounts.delete(ws);
    accounts.get(subscribedAccountId)?.subscribers.delete(ws);
    maybeDeleteAccount(subscribedAccountId);
  }
}

export function registerExternalPresence(accountId: string, kind: ClientPresenceKind): () => void {
  const account = getAccount(accountId);
  const externalKey = `external:${kind}`;
  const now = new Date();
  const existing = account.clients.get(externalKey);

  account.externalRefCounts.set(externalKey, (account.externalRefCounts.get(externalKey) ?? 0) + 1);

  if (existing) {
    existing.lastSeenAt = now;
  } else {
    account.clients.set(externalKey, {
      id: externalKey,
      accountId,
      kind,
      connectedAt: now,
      lastSeenAt: now,
      wsRefCount: 0,
      external: true,
    });
  }

  broadcast(accountId);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;

    const currentAccount = accounts.get(accountId);
    if (!currentAccount) return;

    const nextCount = (currentAccount.externalRefCounts.get(externalKey) ?? 1) - 1;
    if (nextCount > 0) {
      currentAccount.externalRefCounts.set(externalKey, nextCount);
      const current = currentAccount.clients.get(externalKey);
      if (current) current.lastSeenAt = new Date();
      broadcast(accountId);
      return;
    }

    currentAccount.externalRefCounts.delete(externalKey);
    if (currentAccount.clients.delete(externalKey)) broadcast(accountId);
    maybeDeleteAccount(accountId);
  };
}

export function getClientPresenceSnapshot(accountId: string): ClientPresenceSnapshot {
  return toSnapshot(accountId);
}

export function upsertHttpClientPresence(accountId: string, clientId: string, kind: ClientPresenceKind): ClientPresenceSnapshot {
  const account = getAccount(accountId);
  const id = normalizePresenceId(clientId);
  if (!id) return toSnapshot(accountId);
  const now = new Date();
  const existing = account.clients.get(id);
  if (existing) {
    existing.kind = kind;
    existing.lastSeenAt = now;
    existing.httpLastSeenAt = now;
  } else {
    account.clients.set(id, {
      id,
      accountId,
      kind,
      connectedAt: now,
      lastSeenAt: now,
      wsRefCount: 0,
      httpLastSeenAt: now,
      external: false,
    });
  }
  broadcast(accountId);
  return toSnapshot(accountId);
}
