import { eq } from "drizzle-orm";
import { agentProfiles, userProfiles } from "@shared/schema";
import { DEFAULT_AGENT_NAME } from "@shared/instance-config";
import { db, withQueryAttributionAsync } from "./db";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";

const log = createLogger("ProfileIdentity");

export interface ProfileIdentity {
  agentName: string;
  userName: string | null;
}

function cleanName(value: string | null | undefined): string | null {
  const name = value?.trim();
  return name || null;
}

/** Resolve names from the current user's canonical profile rows. */
export async function resolveCurrentProfileIdentity(): Promise<ProfileIdentity> {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId) {
    return { agentName: DEFAULT_AGENT_NAME, userName: null };
  }

  try {
    const [profile] = await withQueryAttributionAsync(
      "context-build",
      () => db
        .select({
          agentName: agentProfiles.agentName,
          preferredName: userProfiles.preferredName,
          displayName: userProfiles.displayName,
        })
        .from(userProfiles)
        .leftJoin(agentProfiles, eq(agentProfiles.userId, userProfiles.userId))
        .where(eq(userProfiles.userId, principal.userId))
        .limit(1),
      "profile-identity",
    );

    return {
      agentName: cleanName(profile?.agentName) ?? DEFAULT_AGENT_NAME,
      userName: cleanName(profile?.preferredName) ?? cleanName(profile?.displayName),
    };
  } catch (error) {
    log.warn("Profile identity lookup failed; using safe defaults", error);
    return { agentName: DEFAULT_AGENT_NAME, userName: null };
  }
}
