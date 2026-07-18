import type { MeetingSessionMeta } from "@shared/models/chat";
import { createUserPrincipalFromUser } from "../principal";
import { getCurrentPrincipal, runWithPrincipal } from "../principal-context";
import { storage } from "../storage";

/**
 * Run webhook/background meeting work as the user who owns the session.
 * Meeting ownership is captured durably at session creation, so transports
 * never have to infer identity from an unauthenticated provider callback.
 */
export interface MeetingOwnerIdentity {
  ownerUserId: string;
  accountId: string;
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
    return operation();
  }

  const user = await storage.getUser(identity.ownerUserId);
  if (!user) throw new Error(`Meeting owner ${identity.ownerUserId} not found`);
  return runWithPrincipal(
    createUserPrincipalFromUser(user, identity.accountId),
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
  return runWithMeetingOwnerIdentity({ ownerUserId, accountId }, operation);
}
