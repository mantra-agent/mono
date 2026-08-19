import { and, asc, eq, sql } from "drizzle-orm";
import { deriveUserFirstName } from "@shared/identity-name";
import { libraryPages } from "@shared/models/info";
import { vaults } from "@shared/models/vaults";
import { accounts, agentInstanceMemberships, memberships, userProfiles, users } from "@shared/schema";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, runWithDatabaseTransaction } from "./db";
import { libraryPageIsLive } from "./library-trash";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { requireCurrentUserPrincipal } from "./principal-context";
import { combineWithVisibleScope, ownedInsertValues } from "./scoped-storage";

const log = createLogger("UserPortrait");

export const USER_PORTRAIT_SLUG = "portrait";
export const USER_PORTRAIT_TITLE = "Portrait";
export const USER_PORTRAIT_TAG = "portrait";
export const LOAD_IDENTITY_NOT_STARTED = "Portrait not started";
const PORTRAIT_DIGEST_CHAR_CAP = 1800;
const PORTRAIT_DIGEST_SENTENCE_CAP = 8;

export type LoadIdentityStatus = "complete" | "blocked";

export interface UserPortraitPage {
  id: string;
  title: string;
  slug: string;
  vaultId: string | null;
  ownerUserId: string | null;
  accountId: string | null;
  plainTextContent: string | null;
  createdAt: Date | null;
}

export interface LoadIdentityEvidence {
  status: LoadIdentityStatus;
  residual: string | null;
  pageId: string | null;
}

const portraitScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

function requireAccountUser(
  principal: Principal,
): Principal & { userId: string; accountId: string } {
  if (!principal.userId || !principal.accountId || principal.actorType !== "user") {
    throw Object.assign(new Error("User principal required"), { status: 401 });
  }
  return principal as Principal & { userId: string; accountId: string };
}

export async function requirePinnedInstanceManager(
  principal: Principal,
): Promise<Principal & { userId: string; accountId: string; instanceId: string }> {
  const user = requireAccountUser(principal);
  if (!user.instanceId) {
    throw Object.assign(new Error("Pinned Instance required"), { status: 403, code: "INSTANCE_REQUIRED" });
  }
  const [row] = await db
    .select({ role: agentInstanceMemberships.role })
    .from(agentInstanceMemberships)
    .where(
      and(
        eq(agentInstanceMemberships.instanceId, user.instanceId),
        eq(agentInstanceMemberships.userId, user.userId),
        eq(agentInstanceMemberships.accountId, user.accountId),
      ),
    )
    .limit(1);
  if (row?.role !== "manager") {
    throw Object.assign(new Error("Instance Manager required"), {
      status: 403,
      code: "INSTANCE_MANAGER_REQUIRED",
    });
  }
  return user as Principal & { userId: string; accountId: string; instanceId: string };
}

function portraitSlotPredicate(ownerUserId: string, accountId: string) {
  return and(
    eq(libraryPages.slug, USER_PORTRAIT_SLUG),
    eq(libraryPages.ownerUserId, ownerUserId),
    eq(libraryPages.accountId, accountId),
    eq(libraryPages.scope, "user"),
    libraryPageIsLive(),
  );
}

export async function findUserPortraitPage(input: {
  ownerUserId: string;
  accountId: string;
}): Promise<UserPortraitPage | null> {
  const rows = await db
    .select({
      id: libraryPages.id,
      title: libraryPages.title,
      slug: libraryPages.slug,
      vaultId: libraryPages.vaultId,
      ownerUserId: libraryPages.ownerUserId,
      accountId: libraryPages.accountId,
      plainTextContent: libraryPages.plainTextContent,
      createdAt: libraryPages.createdAt,
    })
    .from(libraryPages)
    .where(portraitSlotPredicate(input.ownerUserId, input.accountId))
    .orderBy(asc(libraryPages.createdAt), asc(libraryPages.id))
    .limit(2);
  if (rows.length > 1) {
    log.warn("Duplicate live Portrait slot; adopting earliest", {
      ownerUserId: input.ownerUserId,
      accountId: input.accountId,
      pageId: rows[0].id,
      extraPageId: rows[1].id,
    });
  }
  return rows[0] ?? null;
}

export async function evaluateLoadIdentity(accountId: string): Promise<LoadIdentityEvidence> {
  const [account] = await db
    .select({ ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account?.ownerUserId) {
    return { status: "blocked", residual: LOAD_IDENTITY_NOT_STARTED, pageId: null };
  }
  const page = await findUserPortraitPage({
    ownerUserId: account.ownerUserId,
    accountId,
  });
  if (!page) {
    return { status: "blocked", residual: LOAD_IDENTITY_NOT_STARTED, pageId: null };
  }
  return { status: "complete", residual: null, pageId: page.id };
}

async function listLiveAccountMembers(accountId: string): Promise<Array<{
  userId: string;
  visibleVaultIds: string[] | null;
}>> {
  return db
    .select({
      userId: users.id,
      visibleVaultIds: users.visibleVaultIds,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.accountId, accountId));
}

function isExclusiveToUser(
  vaultId: string,
  ownerUserId: string,
  members: Array<{ userId: string; visibleVaultIds: string[] | null }>,
): boolean {
  const owner = members.find((member) => member.userId === ownerUserId);
  if (!owner?.visibleVaultIds?.includes(vaultId)) return false;
  return members.every((member) => {
    if (member.userId === ownerUserId) return true;
    return !(member.visibleVaultIds ?? []).includes(vaultId);
  });
}

async function findExclusiveVaultId(
  accountId: string,
  ownerUserId: string,
): Promise<string | null> {
  const [vaultRows, members] = await Promise.all([
    db
      .select({ id: vaults.id })
      .from(vaults)
      .where(and(eq(vaults.accountId, accountId), eq(vaults.isArchived, false)))
      .orderBy(asc(vaults.createdAt), asc(vaults.id)),
    listLiveAccountMembers(accountId),
  ]);
  for (const vault of vaultRows) {
    if (isExclusiveToUser(vault.id, ownerUserId, members)) return vault.id;
  }
  return null;
}

async function unusedVaultName(
  accountId: string,
  preferred: string,
  userId: string,
): Promise<string> {
  const first = preferred.trim() || USER_PORTRAIT_TITLE;
  const fallback = `${USER_PORTRAIT_TITLE} ${userId.slice(0, 8)}`;
  for (const candidate of [first, USER_PORTRAIT_TITLE, fallback]) {
    const [taken] = await db
      .select({ id: vaults.id })
      .from(vaults)
      .where(and(eq(vaults.accountId, accountId), eq(vaults.name, candidate)))
      .limit(1);
    if (!taken) return candidate;
  }
  return fallback;
}

async function mintExclusiveVault(
  principal: Principal & { userId: string; accountId: string },
): Promise<string> {
  const [profile] = await db
    .select({
      preferredName: userProfiles.preferredName,
      displayName: userProfiles.displayName,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, principal.userId))
    .limit(1);
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);
  const firstName = deriveUserFirstName({
    preferredName: profile?.preferredName,
    displayName: profile?.displayName,
    email: user?.email,
  });
  const name = await unusedVaultName(principal.accountId, firstName, principal.userId);
  const [maxPos] = await db
    .select({ maxPosition: sql<number>`COALESCE(MAX(${vaults.position}), -1)` })
    .from(vaults)
    .where(eq(vaults.accountId, principal.accountId));
  const nextPosition = (maxPos?.maxPosition ?? -1) + 1;
  const created = await db.transaction(async (tx) =>
    runWithDatabaseTransaction(tx, async () => {
      const [vault] = await tx
        .insert(vaults)
        .values({
          accountId: principal.accountId,
          name,
          icon: name.slice(0, 2).toUpperCase(),
          purpose: "Exclusive Portrait vault",
          position: nextPosition,
          isDefault: false,
          isArchived: false,
        })
        .returning({ id: vaults.id });
      const [holder] = await tx
        .select({ visibleVaultIds: users.visibleVaultIds })
        .from(users)
        .where(eq(users.id, principal.userId))
        .limit(1);
      const updatedVisibleIds = Array.from(new Set([...(holder?.visibleVaultIds ?? []), vault.id]));
      await tx
        .update(users)
        .set({ visibleVaultIds: updatedVisibleIds })
        .where(eq(users.id, principal.userId));
      return { vaultId: vault.id, updatedVisibleIds };
    }),
  );
  const { ensureMeetingsRoot } = await import("./meeting/vault-ownership");
  await ensureMeetingsRoot(created.vaultId, {
    ...principal,
    activeVaultId: created.vaultId,
    visibleVaultIds: created.updatedVisibleIds,
  });
  principal.visibleVaultIds = created.updatedVisibleIds;
  log.info("Minted exclusive Portrait vault", {
    userId: principal.userId,
    accountId: principal.accountId,
    vaultId: created.vaultId,
  });
  return created.vaultId;
}

export async function ensureUserPortraitPage(
  principal: Principal,
): Promise<UserPortraitPage> {
  const author = await requirePinnedInstanceManager(principal);
  const existing = await findUserPortraitPage({
    ownerUserId: author.userId,
    accountId: author.accountId,
  });
  if (existing) return existing;

  const vaultId =
    (await findExclusiveVaultId(author.accountId, author.userId))
    ?? (await mintExclusiveVault(author));

  return db.transaction(async (tx) =>
    runWithDatabaseTransaction(tx, async () => {
      await acquireAdvisoryTransactionLock(
        tx,
        ADVISORY_LOCK_NS.USER_IDENTITY,
        `portrait:${author.accountId}:${author.userId}`,
      );
      const again = await findUserPortraitPage({
        ownerUserId: author.userId,
        accountId: author.accountId,
      });
      if (again) return again;
      const members = await listLiveAccountMembers(author.accountId);
      if (!isExclusiveToUser(vaultId, author.userId, members)) {
        throw Object.assign(new Error("Portrait vault is not exclusive to this User"), {
          status: 409,
          code: "PORTRAIT_VAULT_NOT_EXCLUSIVE",
        });
      }

      const [created] = await tx
        .insert(libraryPages)
        .values({
          title: USER_PORTRAIT_TITLE,
          slug: USER_PORTRAIT_SLUG,
          content: { type: "doc", content: [] },
          plainTextContent: "",
          parentId: null,
          tags: [USER_PORTRAIT_TAG],
          status: "active",
          ...ownedInsertValues(author, portraitScopeColumns),
          vaultId,
          createdByUserId: author.userId,
          updatedByUserId: author.userId,
        })
        .returning({
          id: libraryPages.id,
          title: libraryPages.title,
          slug: libraryPages.slug,
          vaultId: libraryPages.vaultId,
          ownerUserId: libraryPages.ownerUserId,
          accountId: libraryPages.accountId,
          plainTextContent: libraryPages.plainTextContent,
          createdAt: libraryPages.createdAt,
        });
      log.info("Minted User Portrait page", {
        userId: author.userId,
        accountId: author.accountId,
        pageId: created.id,
        vaultId,
      });
      return created;
    }),
  );
}

function newestDatedSentences(markdown: string): string[] {
  const dated = [...markdown.matchAll(/^.*\b(\d{4}-\d{2}-\d{2})\b.*$/gm)]
    .map((match) => ({ line: match[0].trim(), date: match[1] }))
    .filter((row) => row.line.length > 0)
    .sort((a, b) => b.date.localeCompare(a.date) || b.line.localeCompare(a.line));
  const unique: string[] = [];
  for (const row of dated) {
    if (!unique.includes(row.line)) unique.push(row.line);
    if (unique.length >= PORTRAIT_DIGEST_SENTENCE_CAP) break;
  }
  return unique;
}

export function renderPortraitDigest(page: UserPortraitPage | null): string {
  if (!page) return "";
  const body = page.plainTextContent?.trim() ?? "";
  const sentences = newestDatedSentences(body);
  const lines = [`# ${page.title || USER_PORTRAIT_TITLE}`, `@page:${page.id}`];
  if (sentences.length > 0) {
    lines.push("", ...sentences.map((sentence) => `- ${sentence}`));
  } else if (body) {
    lines.push("", body.slice(0, PORTRAIT_DIGEST_CHAR_CAP));
  } else {
    lines.push("", "_Empty. Existence is the proof; completeness is not._");
  }
  const digest = lines.join("\n");
  return digest.length > PORTRAIT_DIGEST_CHAR_CAP
    ? `${digest.slice(0, PORTRAIT_DIGEST_CHAR_CAP - 1)}…`
    : digest;
}

export async function resolveCurrentUserPortraitDigest(): Promise<string> {
  try {
    const principal = requireCurrentUserPrincipal();
    if (!principal.userId || !principal.accountId) return "";
    const page = await findUserPortraitPage({
      ownerUserId: principal.userId,
      accountId: principal.accountId,
    });
    if (!page) return "";
    const [visible] = await db
      .select({ id: libraryPages.id })
      .from(libraryPages)
      .where(
        combineWithVisibleScope(
          principal,
          portraitScopeColumns,
          and(eq(libraryPages.id, page.id), libraryPageIsLive()),
        ),
      )
      .limit(1);
    if (!visible) return "";
    return renderPortraitDigest(page);
  } catch (error) {
    log.warn("Portrait digest failed empty", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}
