import type { Express, Request } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { createLogger } from "./log";
import { requireAuth } from "./auth";
import { ensureUserIdentityFoundation, getPrincipal, type Principal } from "./principal";
import { ownedInsertValues } from "./scoped-storage";
import { runWithPrincipal } from "./principal-context";
import { peopleStorage } from "./people-storage";
import { seedFtuePrioritiesForUser } from "./ftue-goals";
import {
  createRecapFtueAgenda,
  RECAP_FTUE_TRIGGER_NAME,
} from "./ftue-session";
import { DEFAULT_AGENT_NAME } from "@shared/instance-config";
import { normalizeEmailAddress } from "./email-normalization";
import { eventBus } from "./event-bus";
import {
  agentProfiles,
  libraryPages,
  magicDemoSessions,
  userProfiles,
  users,
  type User,
} from "@shared/schema";

const log = createLogger("Onboarding");
export const FTUE_AGENT_NAME = DEFAULT_AGENT_NAME;

const ROOTS = [
  { key: "notes", title: "Notes", slug: "notes", emoji: "📝", sortOrder: 0 },
  { key: "user", title: "", slug: "library", emoji: "👤", sortOrder: 1 },
] as const;

type RootKey = (typeof ROOTS)[number]["key"] | "agent";

type WorkspaceMetadata = {
  libraryRootIds?: Partial<Record<RootKey, string>>;
  templateLinks?: string[];
  onboardingStartedAt?: string;
  onboardingCompletedAt?: string;
  enteredDemoAt?: string;
  [key: string]: unknown;
};

export interface CreateUserWorkspaceInput {
  name?: string;
  preferredName?: string;
  contextSeed?: string;
  memoryConsent?: boolean;
  markStarted?: boolean;
  markCompleted?: boolean;
  enterDemo?: boolean;
  /** Private source Meeting used only to derive the recipient-safe recap projection. */
  recapMeetingSessionId?: string;
  /** Recipient-owned materialized Meeting surfaced and guided on Home/Simple. */
  ftueRecapMeetingSessionId?: string;
}

function requireUserPrincipal(req: Request): Principal & { userId: string; accountId: string } {
  const principal = getPrincipal(req);
  if (!principal?.userId || !principal.accountId || principal.actorType !== "user") {
    throw Object.assign(new Error("User principal required"), { status: 401 });
  }
  return principal as Principal & { userId: string; accountId: string };
}

async function getUserOrThrow(userId: string): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  return user;
}

function cleanText(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function displayNameFor(user: User, input: CreateUserWorkspaceInput): string {
  return cleanText(input.name, 120) ?? user.email;
}

function preferredNameFor(user: User, input: CreateUserWorkspaceInput): string {
  return cleanText(input.preferredName, 80) ?? cleanText(input.name, 120) ?? user.email;
}

function mergeMetadata(existing: unknown, patch: WorkspaceMetadata): WorkspaceMetadata {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as WorkspaceMetadata)
    : {};
  return { ...base, ...patch };
}

async function deleteEmptyLegacyMagicDemoRoot(principal: Principal & { userId: string; accountId: string }): Promise<void> {
  const legacyRows = await db
    .select({ id: libraryPages.id, plainTextContent: libraryPages.plainTextContent, tags: libraryPages.tags })
    .from(libraryPages)
    .where(
      and(
        eq(libraryPages.slug, "magic-demo"),
        eq(libraryPages.ownerUserId, principal.userId),
        eq(libraryPages.accountId, principal.accountId),
        eq(libraryPages.scope, "user"),
      ),
    );

  for (const row of legacyRows) {
    const [child] = await db
      .select({ id: libraryPages.id })
      .from(libraryPages)
      .where(eq(libraryPages.parentId, row.id))
      .limit(1);
    const isEmptyOnboardingRoot = (row.tags || []).includes("private-root")
      && (row.tags || []).includes("onboarding")
      && !row.plainTextContent?.trim()
      && !child;
    if (!isEmptyOnboardingRoot) continue;
    await db.delete(libraryPages).where(eq(libraryPages.id, row.id));
    log.log("Removed empty legacy Magic Demo onboarding root", { userId: principal.userId, pageId: row.id });
  }
}

export async function ensureAgentLibraryRoot(
  principal: Principal & { userId: string; accountId: string },
  agentRootTitle: string,
): Promise<string> {
  const title = cleanText(agentRootTitle, 80) ?? "Agent";
  const [existing] = await db
    .select({ id: libraryPages.id })
    .from(libraryPages)
    .where(
      and(
        eq(libraryPages.slug, "agent"),
        eq(libraryPages.ownerUserId, principal.userId),
        eq(libraryPages.accountId, principal.accountId),
        eq(libraryPages.scope, "user"),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(libraryPages)
      .set({
        title,
        emoji: "✦",
        sortOrder: 2,
        updatedAt: sql`CURRENT_TIMESTAMP`,
        updatedByUserId: principal.userId,
      })
      .where(eq(libraryPages.id, existing.id));
    return existing.id;
  }

  const [created] = await db
    .insert(libraryPages)
    .values({
      title,
      slug: "agent",
      content: { type: "doc", content: [] },
      plainTextContent: "",
      parentId: null,
      tags: ["agent-root", "onboarding"],
      status: "active",
      emoji: "✦",
      sortOrder: 2,
      ...ownedInsertValues(principal, {
        scope: libraryPages.scope,
        ownerUserId: libraryPages.ownerUserId,
        accountId: libraryPages.accountId,
      }),
      createdByUserId: principal.userId,
      updatedByUserId: principal.userId,
    })
    .returning({ id: libraryPages.id });

  return created.id;
}

async function ensurePrivateRoots(
  principal: Principal & { userId: string; accountId: string },
  userRootTitle: string,
): Promise<Partial<Record<RootKey, string>>> {
  await deleteEmptyLegacyMagicDemoRoot(principal);
  const rootIds: Partial<Record<RootKey, string>> = {};

  const roots = ROOTS.map((root) => ({
    ...root,
    title: root.key === "user" ? userRootTitle : root.title,
  }));

  for (const root of roots) {
    const [existing] = await db
      .select({ id: libraryPages.id })
      .from(libraryPages)
      .where(
        and(
          eq(libraryPages.slug, root.slug),
          eq(libraryPages.ownerUserId, principal.userId),
          eq(libraryPages.accountId, principal.accountId),
          eq(libraryPages.scope, "user"),
        ),
      )
      .limit(1);

    if (existing) {
      rootIds[root.key] = existing.id;
      await db
        .update(libraryPages)
        .set({
          title: root.title,
          emoji: root.emoji,
          sortOrder: root.sortOrder,
          updatedAt: sql`CURRENT_TIMESTAMP`,
          updatedByUserId: principal.userId,
        })
        .where(eq(libraryPages.id, existing.id));
      continue;
    }

    const [created] = await db
      .insert(libraryPages)
      .values({
        title: root.title,
        slug: root.slug,
        content: { type: "doc", content: [] },
        plainTextContent: "",
        parentId: null,
        tags: ["private-root", "onboarding"],
        status: "active",
        emoji: root.emoji,
        sortOrder: root.sortOrder,
        ...ownedInsertValues(principal, {
          scope: libraryPages.scope,
          ownerUserId: libraryPages.ownerUserId,
          accountId: libraryPages.accountId,
        }),
        createdByUserId: principal.userId,
        updatedByUserId: principal.userId,
      })
      .returning({ id: libraryPages.id });

    rootIds[root.key] = created.id;
  }

  return rootIds;
}

async function ensureMagicDemoSession(principal: Principal & { userId: string }): Promise<string | null> {
  const [existing] = await db
    .select({ id: magicDemoSessions.id })
    .from(magicDemoSessions)
    .where(and(eq(magicDemoSessions.userId, principal.userId), inArray(magicDemoSessions.status, ["created", "active"])))
    .orderBy(desc(magicDemoSessions.createdAt))
    .limit(1);

  if (existing?.id) return existing.id;

  const [session] = await db
    .insert(magicDemoSessions)
    .values({
      userId: principal.userId,
      status: "created",
      telemetry: { source: "onboarding" },
    })
    .returning({ id: magicDemoSessions.id });
  return session?.id ?? null;
}


async function ensureUserPerson(
  principal: Principal & { userId: string; accountId: string },
  displayName: string,
  preferredName: string,
): Promise<void> {
  try {
    const existing = await peopleStorage.listPeople();
    const userPerson = existing.find(p => p.cabinetLevel === "user");
    if (userPerson) {
      log.debug("ensureUserPerson: user person already exists", { id: userPerson.id, name: userPerson.name });
      // Update name if it changed during re-onboarding
      if (userPerson.name !== displayName) {
        await peopleStorage.updatePerson(userPerson.id, {
          name: displayName,
          nicknames: preferredName !== displayName ? [preferredName] : [],
          identityContent: buildIdentityContent(displayName, preferredName),
        });
        log.log("ensureUserPerson: updated existing user person", { id: userPerson.id, name: displayName });
      }
      return;
    }

    const person = await peopleStorage.createPerson({
      name: displayName,
      nicknames: preferredName !== displayName ? [preferredName] : [],
      cabinetLevel: "user",
      familiarity: "deep",
      trust: "ally",
      relation: "self",
      socialProfiles: {},
      contactInfo: [],
      importantDates: [],
      notes: [],
      interactions: [],
      tags: ["onboarding"],
      private: false,
      identityContent: buildIdentityContent(displayName, preferredName),
    });
    log.log("ensureUserPerson: created user person", { id: person.id, name: person.name });
  } catch (err) {
    log.warn("ensureUserPerson failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

function buildIdentityContent(displayName: string, preferredName: string): string {
  const lines = [`${displayName}.`];
  if (preferredName !== displayName) {
    lines.push(`Goes by ${preferredName}.`);
  }
  return lines.join(" ");
}

export async function createUserWorkspace(
  principal: Principal & { userId: string; accountId: string },
  input: CreateUserWorkspaceInput = {},
) {
  const user = await getUserOrThrow(principal.userId);
  const requestedName = cleanText(input.name, 120);
  const foundation = await ensureUserIdentityFoundation(user, { identityName: requestedName });
  const workspacePrincipal = {
    ...principal,
    accountId: foundation.accountId,
    activeVaultId: foundation.activeVaultId,
    visibleVaultIds: foundation.visibleVaultIds,
  };
  const accountId = foundation.accountId;
  const [[existingProfile], [existingAgentProfile]] = await Promise.all([
    db.select().from(userProfiles).where(eq(userProfiles.userId, principal.userId)).limit(1),
    foundation.instanceId
      ? db.select().from(agentProfiles).where(eq(agentProfiles.instanceId, foundation.instanceId)).limit(1)
      : db.select().from(agentProfiles).where(eq(agentProfiles.userId, principal.userId)).limit(1),
  ]);
  const displayName = cleanText(input.name, 120) ?? existingProfile?.displayName ?? displayNameFor(user, input);
  const preferredName = cleanText(input.preferredName, 80) ?? existingProfile?.preferredName ?? preferredNameFor(user, input);
  const agentName = existingAgentProfile?.agentName ?? FTUE_AGENT_NAME;
  const { ensureMeetingsRoot } = await import("./meeting/vault-ownership");
  await ensureMeetingsRoot(workspacePrincipal.activeVaultId, workspacePrincipal);
  const roots = await ensurePrivateRoots(workspacePrincipal, preferredName);
  if (agentName !== "Agent") {
    roots.agent = await ensureAgentLibraryRoot(workspacePrincipal, agentName);
  }
  const magicDemoSessionId = input.enterDemo ? await ensureMagicDemoSession(principal) : null;

  if (!input.recapMeetingSessionId && (input.markStarted || input.markCompleted || input.enterDemo)) {
    await seedFtuePrioritiesForUser(principal);
  }

  const now = new Date().toISOString();
  const onboardingStatus = input.markCompleted
    ? "completed"
    : existingProfile?.onboardingStatus === "completed"
      ? "completed"
      : input.markStarted
        ? "in_progress"
        : existingProfile?.onboardingStatus ?? "not_started";
  const memoryConsent = input.memoryConsent ?? existingProfile?.memoryConsent ?? false;
  const metadata = mergeMetadata(existingProfile?.metadata, {
    libraryRootIds: roots,
    templateLinks: ["global-personas", "global-skills", "global-library"],
    ...(input.markStarted && !existingProfile?.metadata?.["onboardingStartedAt"] ? { onboardingStartedAt: now } : {}),
    ...(input.markCompleted ? { onboardingCompletedAt: now } : {}),
    ...(input.enterDemo ? { enteredDemoAt: now, magicDemoSessionId } : {}),
  });

  await db
    .insert(userProfiles)
    .values({
      userId: principal.userId,
      accountId,
      displayName,
      preferredName,
      onboardingStatus,
      memoryConsent,
      metadata,
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: {
        accountId,
        displayName,
        preferredName,
        onboardingStatus,
        memoryConsent,
        metadata,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });

  const relationshipState = {
    preferredName,
    memoryConsent,
    onboardingCompleted: onboardingStatus === "completed",
  };
  if (existingAgentProfile) {
    await db
      .update(agentProfiles)
      .set({
        userId: principal.userId,
        accountId,
        instanceId: foundation.instanceId,
        agentName,
        relationshipState,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(agentProfiles.id, existingAgentProfile.id));
  } else if (foundation.instanceId) {
    await db
      .insert(agentProfiles)
      .values({
        userId: principal.userId,
        accountId,
        instanceId: foundation.instanceId,
        agentName,
        relationshipState,
        metadata: { templateLinks: ["global-personas"], source: "onboarding" },
      })
      .onConflictDoUpdate({
        target: agentProfiles.instanceId,
        targetWhere: sql`${agentProfiles.instanceId} IS NOT NULL`,
        set: {
          userId: principal.userId,
          accountId,
          agentName,
          relationshipState,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  } else {
    await db.insert(agentProfiles).values({
      userId: principal.userId,
      accountId,
      agentName,
      relationshipState,
      metadata: { templateLinks: ["global-personas"], source: "onboarding" },
    });
  }

  eventBus.publish({
    category: "agent",
    event: "data:profiles_changed",
    payload: { source: "onboarding", userId: principal.userId },
  });

  // Fire-and-forget: this is non-critical for the onboarding response.
  // Structurally non-blocking so the user navigates immediately.
  void ensureUserPerson(workspacePrincipal, displayName, preferredName).catch((err) =>
    log.warn("ensureUserPerson failed (non-fatal):", err instanceof Error ? err.message : String(err)),
  );

  // Create FTUE welcome session if onboarding just completed
  let ftueSessionId: string | undefined;
  if (input.markCompleted) {
    try {
      const { chatFileStorage } = await import("./chat-file-storage");
      const { DEFAULT_ACTIVITY_ROUTING } = await import("./job-profiles");
      const defaultTier = DEFAULT_ACTIVITY_ROUTING.chat || "high";
      const recapMeetingSessionId = cleanText(input.recapMeetingSessionId, 128);
      let ftueAgenda = recapMeetingSessionId ? createRecapFtueAgenda() : undefined;
      try {
        const { agendaDefinitionStorage } = await import("./agenda-storage");
        ftueAgenda = await agendaDefinitionStorage.instantiateFtue(workspacePrincipal, {
          recapAware: Boolean(recapMeetingSessionId),
        });
      } catch (error) {
        log.warn("Canonical FTUE agenda unavailable; using bootstrap snapshot", {
          errorName: error instanceof Error ? error.name : typeof error,
          recapAware: Boolean(recapMeetingSessionId),
        });
      }
      const sessionOptions = {
        sessionType: "user" as const,
        ftueWelcome: true,
        ftueRecapMeetingSessionId: cleanText(input.ftueRecapMeetingSessionId, 128),
        provenance: recapMeetingSessionId
          ? {
              triggerType: "meeting" as const,
              triggerId: recapMeetingSessionId,
              triggerName: RECAP_FTUE_TRIGGER_NAME,
            }
          : { triggerType: "system" as const, triggerName: "ftue_welcome" },
      };
      let result: Awaited<ReturnType<typeof chatFileStorage.createSessionOnce>>;
      try {
        result = await runWithPrincipal(workspacePrincipal, () => chatFileStorage.createSessionOnce(
          "Welcome",
          `ftue:${principal.userId}`,
          defaultTier,
          { ...sessionOptions, agenda: ftueAgenda },
        ));
      } catch (error) {
        if (!ftueAgenda) throw error;
        // The Welcome session is the FTUE-critical deliverable; the agenda only
        // enriches it. Agenda validation must never strand a fresh signup on a
        // bare Home without its Welcome session and deep link.
        log.error("FTUE welcome session creation failed with agenda; retrying without agenda", {
          error: error instanceof Error ? error.message : String(error),
        });
        result = await runWithPrincipal(workspacePrincipal, () => chatFileStorage.createSessionOnce(
          "Welcome",
          `ftue:${principal.userId}`,
          defaultTier,
          sessionOptions,
        ));
      }
      ftueSessionId = result.session.id;
      log.info("FTUE welcome session resolved", {
        userId: principal.userId,
        sessionId: ftueSessionId,
        outcome: result.outcome,
        recapAware: Boolean(recapMeetingSessionId),
      });
    } catch (err) {
      log.error("Failed to create FTUE welcome session:", err instanceof Error ? err.message : String(err));
    }
  }

  const status = await getOnboardingStatus(principal);
  return { ...status, ftueSessionId };
}

export async function getOnboardingStatus(principal: Principal & { userId: string; accountId: string }) {
  const [profile] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, principal.userId))
    .limit(1);
  const [agent] = principal.instanceId
    ? await db
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.instanceId, principal.instanceId))
        .limit(1)
    : await db
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.userId, principal.userId))
        .limit(1);

  const user = await getUserOrThrow(principal.userId);
  const preferredName = cleanText(profile?.preferredName ?? undefined, 80)
    ?? cleanText(profile?.displayName ?? undefined, 120)
    ?? user.email;
  const rootIds = await ensurePrivateRoots(principal, preferredName);
  if (agent?.agentName && agent.agentName !== "Agent") {
    rootIds.agent = await ensureAgentLibraryRoot(principal, agent.agentName);
  }

  const roots = await db
    .select({ id: libraryPages.id, slug: libraryPages.slug, title: libraryPages.title })
    .from(libraryPages)
    .where(and(eq(libraryPages.ownerUserId, principal.userId), eq(libraryPages.accountId, principal.accountId), eq(libraryPages.scope, "user")));

  return {
    onboardingStatus: profile?.onboardingStatus ?? "not_started",
    completed: profile?.onboardingStatus === "completed",
    memoryConsent: profile?.memoryConsent ?? false,
    profile: profile
      ? {
          displayName: profile.displayName,
          preferredName: profile.preferredName,
          timezone: profile.timezone,
        }
      : null,
    agentProfile: agent
      ? {
          agentName: agent.agentName,
        }
      : null,
    workspace: {
      accountId: principal.accountId,
      privateRootCount: roots.filter((root) => ROOTS.some((r) => r.slug === root.slug) || root.slug === "agent").length,
      roots,
    },
  };
}

const startSchema = z.object({}).passthrough();
const completeSchema = z.object({
  name: z.string().min(1).max(120),
  preferredName: z.string().min(1).max(80).optional(),
  contextSeed: z.string().max(4000).optional().default(""),
  memoryConsent: z.boolean().default(false),
  enterDemo: z.boolean().default(true),
  recapToken: z.string().min(1).max(200).optional(),
});

function routeError(res: any, error: unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as any).status) : 500;
  const message = error instanceof Error ? error.message : String(error);
  res.status(Number.isFinite(status) ? status : 500).json({ error: message });
}

export function registerOnboardingRoutes(app: Express): void {
  app.get("/api/onboarding/status", requireAuth, async (req, res) => {
    try {
      const principal = requireUserPrincipal(req);
      await createUserWorkspace(principal);
      res.json(await getOnboardingStatus(principal));
    } catch (error) {
      routeError(res, error);
    }
  });

  app.post("/api/onboarding/start", requireAuth, async (req, res) => {
    try {
      const parsed = startSchema.safeParse(req.body || {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid onboarding start", details: parsed.error.flatten() });
      const principal = requireUserPrincipal(req);
      res.json(await createUserWorkspace(principal, { markStarted: true }));
    } catch (error) {
      routeError(res, error);
    }
  });

  app.post("/api/onboarding/complete", requireAuth, async (req, res) => {
    try {
      const parsed = completeSchema.safeParse(req.body || {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid onboarding data", details: parsed.error.flatten() });
      const principal = requireUserPrincipal(req);
      let recapMeetingSessionId: string | undefined;
      let ftueRecapMeetingSessionId: string | undefined;
      if (parsed.data.recapToken) {
        const user = await getUserOrThrow(principal.userId);
        const { resolveOnboardingToken } = await import("./meeting/distribution");
        const resolution = await resolveOnboardingToken(parsed.data.recapToken);
        if (
          resolution.status !== "resolved"
          || resolution.accountState !== "real"
          || resolution.email !== normalizeEmailAddress(user.email)
        ) {
          res.status(404).json({ error: "Recap onboarding unavailable" });
          return;
        }
        recapMeetingSessionId = resolution.meetingSessionId;
        const { materializeAuthenticatedRecipientRecap } = await import("./meeting/recipient-materialization");
        const materialized = await materializeAuthenticatedRecipientRecap(parsed.data.recapToken, user.email);
        if (!materialized) {
          res.status(404).json({ error: "Recap onboarding unavailable" });
          return;
        }
        ftueRecapMeetingSessionId = materialized.meetingSessionId;
      }
      const { recapToken: _recapToken, ...onboardingInput } = parsed.data;
      const status = await createUserWorkspace(principal, {
        ...onboardingInput,
        recapMeetingSessionId,
        ftueRecapMeetingSessionId,
        markStarted: true,
        markCompleted: true,
      });
      log.log("onboarding completed", { userId: principal.userId, accountId: principal.accountId, memoryConsent: parsed.data.memoryConsent, recapAware: Boolean(recapMeetingSessionId) });
      res.json(status);
    } catch (error) {
      routeError(res, error);
    }
  });
}
