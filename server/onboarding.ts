import type { Express, Request } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { createLogger } from "./log";
import { requireAuth } from "./auth";
import { getPrincipal, type Principal } from "./principal";
import { ownedInsertValues } from "./scoped-storage";
import { peopleStorage } from "./people-storage";
import { seedFtuePrioritiesForUser } from "./ftue-goals";
import {
  accounts,
  agentProfiles,
  libraryPages,
  memberships,
  magicDemoSessions,
  memoryEntries,
  userProfiles,
  users,
  type User,
} from "@shared/schema";

const log = createLogger("Onboarding");

const ROOTS = [
  { key: "notes", title: "Notes", slug: "notes", emoji: "📝", sortOrder: 0 },
  { key: "user", title: "", slug: "library", emoji: "👤", sortOrder: 1 },
] as const;

type RootKey = (typeof ROOTS)[number]["key"] | "agent";

type WorkspaceMetadata = {
  libraryRootIds?: Partial<Record<RootKey, string>>;
  templateLinks?: string[];
  contextSeededAt?: string;
  onboardingStartedAt?: string;
  onboardingCompletedAt?: string;
  enteredDemoAt?: string;
  [key: string]: unknown;
};

export interface CreateUserWorkspaceInput {
  name?: string;
  preferredName?: string;
  agentName?: string;
  contextSeed?: string;
  memoryConsent?: boolean;
  markStarted?: boolean;
  markCompleted?: boolean;
  enterDemo?: boolean;
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

function agentNameFor(input: CreateUserWorkspaceInput): string {
  return cleanText(input.agentName, 80) ?? "Agent";
}

function mergeMetadata(existing: unknown, patch: WorkspaceMetadata): WorkspaceMetadata {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as WorkspaceMetadata)
    : {};
  return { ...base, ...patch };
}

async function ensurePersonalAccount(user: User, principal: Principal & { accountId: string }): Promise<string> {
  await db
    .insert(accounts)
    .values({
      id: principal.accountId,
      kind: "personal",
      name: `Personal Account`,
      ownerUserId: user.id,
    })
    .onConflictDoUpdate({
      target: accounts.id,
      set: { updatedAt: sql`CURRENT_TIMESTAMP` },
    });

  await db
    .insert(memberships)
    .values({ accountId: principal.accountId, userId: user.id, role: "owner" })
    .onConflictDoUpdate({
      target: [memberships.accountId, memberships.userId],
      set: { role: "owner", updatedAt: sql`CURRENT_TIMESTAMP` },
    });

  return principal.accountId;
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

async function seedContextMemory(
  principal: Principal & { userId: string; accountId: string },
  contextSeed: string,
): Promise<void> {
  const sourceId = `onboarding:${principal.userId}`;
  await db
    .insert(memoryEntries)
    .values({
      layer: "short",
      source: "identity",
      sourceId,
      title: "Onboarding context seed",
      oneLiner: "Initial context provided during onboarding.",
      content: contextSeed,
      summary: contextSeed,
      metadata: { source: "onboarding", consented: true },
      tags: ["onboarding", "context-seed"],
      ...ownedInsertValues(principal, {
        scope: memoryEntries.scope,
        ownerUserId: memoryEntries.ownerUserId,
        accountId: memoryEntries.accountId,
      }),
      createdByUserId: principal.userId,
      updatedByUserId: principal.userId,
    })
    .onConflictDoUpdate({
      target: [memoryEntries.layer, memoryEntries.source, memoryEntries.sourceId],
      set: {
        content: contextSeed,
        summary: contextSeed,
        metadata: { source: "onboarding", consented: true },
        updatedByUserId: principal.userId,
        processedAt: sql`CURRENT_TIMESTAMP`,
      },
    });
}

/**
 * Generate a short, warm agent name via LLM and update agent_profiles.
 * Called fire-and-forget (void, not awaited) during onboarding completion.
 * Always writes a name: LLM-generated if available, deterministic fallback otherwise.
 */
const AGENT_NAME_FALLBACKS = [
  "Sage", "Nova", "Echo", "Lyra", "Kai", "Sol", "Iris", "Milo", "Juno", "Aria",
  "Orion", "Luna", "Zeph", "Clio", "Rune", "Vega", "Nyx", "Aero", "Pax", "Lux",
];

const AGENT_NAME_TIMEOUT_MS = 10_000;

function pickFallbackName(userName: string): string {
  let hash = 0;
  for (let i = 0; i < userName.length; i++) {
    hash = ((hash << 5) - hash + userName.charCodeAt(i)) | 0;
  }
  return AGENT_NAME_FALLBACKS[Math.abs(hash) % AGENT_NAME_FALLBACKS.length];
}

async function generateAgentName(principal: Principal & { userId: string; accountId: string }, userName: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_NAME_TIMEOUT_MS);

  let name: string;
  try {
    const { chatCompletion } = await import("./model-client");
    const { ACTIVITY_FRAMING } = await import("./job-profiles");

    const result = await chatCompletion({
      activity: ACTIVITY_FRAMING,
      signal: controller.signal,
      messages: [
        {
          role: "system",
          content: "You are a naming assistant. Generate exactly one name for an AI companion. The name should be short (1-2 syllables), warm, memorable, and distinctive. Not a common human name, but not robotic either. Think: Sage, Nova, Echo, Lyra, Kai, Sol, Iris, Zara, Milo, Juno. Respond with ONLY the name, nothing else.",
        },
        {
          role: "user",
          content: `Generate a name for the AI companion of a user named ${userName}. Just the name, no explanation.`,
        },
      ],
      maxTokens: 20,
      temperature: 1.0,
      metadata: { source: "onboarding", activity: ACTIVITY_FRAMING },
    });

    const parsed = result.content.trim().replace(/[^a-zA-Z]/g, "").slice(0, 20);
    name = (parsed && parsed.length >= 2) ? parsed : pickFallbackName(userName);
  } catch (err) {
    log.warn("Agent name LLM failed, using fallback:", err instanceof Error ? err.message : String(err));
    name = pickFallbackName(userName);
  } finally {
    clearTimeout(timer);
  }

  await db
    .update(agentProfiles)
    .set({ agentName: name, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(agentProfiles.userId, principal.userId));

  await ensureAgentLibraryRoot(principal, name);

  log.log("Agent name generated", { userId: principal.userId, agentName: name });
}

export async function createUserWorkspace(
  principal: Principal & { userId: string; accountId: string },
  input: CreateUserWorkspaceInput = {},
) {
  const user = await getUserOrThrow(principal.userId);
  const accountId = await ensurePersonalAccount(user, principal);
  const displayName = displayNameFor(user, input);
  const preferredName = preferredNameFor(user, input);
  const agentName = agentNameFor(input);
  const roots = await ensurePrivateRoots(principal, preferredName);
  if (agentName !== "Agent") {
    roots.agent = await ensureAgentLibraryRoot(principal, agentName);
  }
  const magicDemoSessionId = input.enterDemo ? await ensureMagicDemoSession(principal) : null;

  if (input.markStarted || input.markCompleted || input.enterDemo) {
    await seedFtuePrioritiesForUser(principal);
  }

  const [existingProfile] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, principal.userId))
    .limit(1);
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
    ...(input.contextSeed && memoryConsent ? { contextSeededAt: now } : {}),
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

  await db
    .insert(agentProfiles)
    .values({
      userId: principal.userId,
      accountId,
      agentName,
      relationshipState: {
        preferredName,
        memoryConsent,
        onboardingCompleted: onboardingStatus === "completed",
      },
      metadata: { templateLinks: ["global-personas"], source: "onboarding" },
    })
    .onConflictDoUpdate({
      target: agentProfiles.userId,
      set: {
        accountId,
        agentName,
        relationshipState: {
          preferredName,
          memoryConsent,
          onboardingCompleted: onboardingStatus === "completed",
        },
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });

  // Fire-and-forget: these are non-critical for the onboarding response.
  // Structurally non-blocking so the user navigates immediately.
  const contextSeed = cleanText(input.contextSeed, 4000);
  if (contextSeed && memoryConsent) {
    void seedContextMemory(principal, contextSeed).catch((err) =>
      log.warn("Context seed failed (non-fatal):", err instanceof Error ? err.message : String(err)),
    );
  }

  void ensureUserPerson(principal, displayName, preferredName).catch((err) =>
    log.warn("ensureUserPerson failed (non-fatal):", err instanceof Error ? err.message : String(err)),
  );

  if (input.markCompleted && agentName === "Agent") {
    void generateAgentName(principal, preferredName).catch((err) =>
      log.warn("Agent name generation failed (non-fatal):", err instanceof Error ? err.message : String(err)),
    );
  }

  // Create FTUE welcome session if onboarding just completed
  let ftueSessionId: string | undefined;
  if (input.markCompleted) {
    try {
      const { chatFileStorage } = await import("./chat-file-storage");
      const { DEFAULT_ACTIVITY_ROUTING } = await import("./job-profiles");
      const defaultTier = DEFAULT_ACTIVITY_ROUTING.chat || "high";
      const session = await chatFileStorage.createSession(
        "Welcome",
        `ftue:${principal.userId}`,
        defaultTier,
        {
          sessionType: "user",
          ftueWelcome: true,
          provenance: { triggerType: "system", triggerName: "ftue_welcome" },
        },
      );
      ftueSessionId = session.id;
      log.log("FTUE welcome session created", { userId: principal.userId, sessionId: ftueSessionId });
    } catch (err) {
      log.warn("Failed to create FTUE welcome session:", err instanceof Error ? err.message : String(err));
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
  const [agent] = await db
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
  agentName: z.string().min(1).max(80).default("Agent"),
  contextSeed: z.string().max(4000).optional().default(""),
  memoryConsent: z.boolean().default(false),
  enterDemo: z.boolean().default(true),
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
      const status = await createUserWorkspace(principal, { ...parsed.data, markStarted: true, markCompleted: true });
      log.log("onboarding completed", { userId: principal.userId, accountId: principal.accountId, memoryConsent: parsed.data.memoryConsent });
      res.json(status);
    } catch (error) {
      routeError(res, error);
    }
  });
}
