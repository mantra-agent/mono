import type { MeetingSessionMeta } from "@shared/models/chat";
import { documentStoreDocuments } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  createUserPrincipalFromUser,
  type Principal,
} from "../principal";
import { getCurrentPrincipal, runWithPrincipal } from "../principal-context";
import { chatStorage, type Session } from "../integrations/chat/storage";
import { storage } from "../storage";

/**
 * Run webhook/background meeting work as the user who owns the session.
 * Meeting ownership is captured durably at session creation, so transports
 * never have to infer identity from an unauthenticated provider callback.
 */
export interface MeetingOwnerIdentity {
  ownerUserId: string;
  accountId: string;
  vaultId?: string;
}

/**
 * Resolve a provider-authenticated or signed transport's opaque session ID.
 * This principal exists only for the ownership lookup. Callers must immediately
 * transition to runWithMeetingOwnerPrincipal before any user-owned work.
 */
export async function resolveMeetingTransportSession(
  sessionId: string,
): Promise<Session | null> {
  const [identity] = await db
    .select({
      ownerUserId: documentStoreDocuments.ownerUserId,
      accountId: documentStoreDocuments.accountId,
      vaultId: documentStoreDocuments.vaultId,
    })
    .from(documentStoreDocuments)
    .where(and(
      eq(documentStoreDocuments.documentType, "chat"),
      eq(documentStoreDocuments.documentId, sessionId),
      eq(documentStoreDocuments.scope, "user"),
      sql`${documentStoreDocuments.metadata}->>'type' = 'meeting'`,
    ))
    .limit(1);
  if (!identity?.ownerUserId || !identity.accountId) return null;

  return runWithMeetingOwnerIdentity(
    {
      ownerUserId: identity.ownerUserId,
      accountId: identity.accountId,
      vaultId: identity.vaultId ?? undefined,
    },
    async () => {
      const session = await chatStorage.getSession(sessionId);
      if (
        session?.type !== "meeting"
        || !session.meeting
        || session.meeting.ownerUserId !== identity.ownerUserId
        || session.meeting.principalAccountId !== identity.accountId
      ) return null;
      return session;
    },
  );
}

export async function runWithMeetingOwnerIdentity<T>(
  identity: MeetingOwnerIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  const current = getCurrentPrincipal();
  if (current?.actorType === "user") {
    if (current.userId !== identity.ownerUserId || current.accountId !== identity.accountId) {
      throw new Error("Meeting session is not owned by the current principal");
    }
    if (identity.vaultId && !current.visibleVaultIds.includes(identity.vaultId)) {
      throw new Error("Meeting Vault is not visible to the current principal");
    }
    return identity.vaultId
      ? runWithPrincipal({ ...current, activeVaultId: identity.vaultId, visibleVaultIds: [identity.vaultId] }, operation)
      : operation();
  }

  const user = await storage.getUser(identity.ownerUserId);
  if (!user) throw new Error(`Meeting owner ${identity.ownerUserId} not found`);
  const ownerPrincipal = createUserPrincipalFromUser(user, identity.accountId);
  if (identity.vaultId && !ownerPrincipal.visibleVaultIds.includes(identity.vaultId)) {
    throw new Error("Meeting Vault is not visible to its owner");
  }
  return runWithPrincipal(
    identity.vaultId
      ? { ...ownerPrincipal, activeVaultId: identity.vaultId, visibleVaultIds: [identity.vaultId] }
      : ownerPrincipal,
    operation,
  );
}

export async function runWithMeetingOwnerPrincipal<T>(
  meeting: MeetingSessionMeta,
  operation: () => Promise<T>,
): Promise<T> {
  const ownerUserId = meeting.ownerUserId;
  const accountId = meeting.principalAccountId;
  if (!ownerUserId || !accountId) {
    throw new Error(
      `Meeting owner context is incomplete: ownerUserId=${ownerUserId ?? "none"} accountId=${accountId ?? "none"}`,
    );
  }
  return runWithMeetingOwnerIdentity({ ownerUserId, accountId, vaultId: meeting.vaultId }, operation);
}

/** True when the authenticated user principal owns this meeting session. */
export function principalOwnsMeeting(
  principal: Principal,
  session: { type?: string; meeting?: MeetingSessionMeta } | null | undefined,
): boolean {
  const meeting = session?.meeting;
  return !!meeting
    && session?.type === "meeting"
    && principal.actorType === "user"
    && !!principal.userId
    && !!principal.accountId
    && meeting.ownerUserId === principal.userId
    && meeting.principalAccountId === principal.accountId;
}
