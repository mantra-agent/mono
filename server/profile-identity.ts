import { eq, or, and, isNull } from "drizzle-orm";
import { agentProfiles, userProfiles, users } from "@shared/schema";
import { DEFAULT_AGENT_NAME } from "@shared/instance-config";
import { db, withQueryAttributionAsync } from "./db";
import { createLogger } from "./log";
import { getCurrentPrincipal } from "./principal-context";
import { deriveUserFirstName } from "@shared/identity-name";

const log = createLogger("ProfileIdentity");

export interface ProfileIdentity {
  agentName: string;
  userName: string | null;
  userFirstName: string;
}

function cleanName(value: string | null | undefined): string | null {
  const name = value?.trim();
  return name || null;
}

/**
 * Canonical default agent identity for pre-user (provisional) contexts.
 * Synchronous and DB-free: there is no user, so this resolves to the
 * default/canonical agent name only. Never crosses an ownership boundary
 * and never reads user data — safe for latency-bounded provisional prompts.
 */
export function defaultProfileIdentity(): ProfileIdentity {
  return { agentName: DEFAULT_AGENT_NAME, userName: null, userFirstName: "there" };
}

/** Resolve names from the current user's canonical profile rows. */
export async function resolveCurrentProfileIdentity(): Promise<ProfileIdentity> {
  const principal = getCurrentPrincipal();
  if (!principal?.userId) {
    return defaultProfileIdentity();
  }

  try {
    const agentJoin = principal.instanceId
      ? or(
          eq(agentProfiles.instanceId, principal.instanceId),
          and(eq(agentProfiles.userId, users.id), isNull(agentProfiles.instanceId)),
        )
      : eq(agentProfiles.userId, users.id);

    const [profile] = await withQueryAttributionAsync(
      "context-build",
      () => db
        .select({
          agentName: agentProfiles.agentName,
          preferredName: userProfiles.preferredName,
          displayName: userProfiles.displayName,
          email: users.email,
        })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .leftJoin(agentProfiles, agentJoin)
        .where(eq(users.id, principal.userId))
        .limit(1),
      "profile-identity",
    );

    const userName = cleanName(profile?.preferredName) ?? cleanName(profile?.displayName);
    return {
      agentName: cleanName(profile?.agentName) ?? DEFAULT_AGENT_NAME,
      userName,
      userFirstName: deriveUserFirstName({
        preferredName: profile?.preferredName,
        displayName: profile?.displayName,
        email: profile?.email,
      }),
    };
  } catch (error) {
    log.warn("Profile identity lookup failed; using safe defaults", error);
    return defaultProfileIdentity();
  }
}
