import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { accounts, calendarEventArtifacts, calendarEventMetadata, calendarEventPeople, memberships } from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import { vaults } from "@shared/models/vaults";
import type { CalendarEvent } from "../google-calendar";
import {
  acquireAdvisoryTransactionLock,
  acquireLibraryParentLocks,
  ADVISORY_LOCK_NS,
  db,
  runWithDatabaseTransaction,
} from "../db";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { getCurrentPrincipalOrSystem, runWithPrincipal } from "../principal-context";
import { combineWithSensitiveWritable } from "../sensitive-scope";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import { syncContentFields } from "@shared/markdown-tiptap";
import { moveLibraryPage } from "../library-move";
import { chatStorage } from "../integrations/chat/storage";
import { calendarOccurrenceKey } from "./identity";

const log = createLogger("MeetingVaultOwnership");
const MEETINGS_ROOT_TAG = "meeting-root";
const MEETING_INSTANCE_TAG = "meeting-instance";

const pageScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};
const metadataOwnerColumns = {
  ownerUserId: calendarEventMetadata.ownerUserId,
  principalAccountId: calendarEventMetadata.principalAccountId,
  vaultId: calendarEventMetadata.vaultId,
};
const peopleOwnerColumns = {
  ownerUserId: calendarEventPeople.ownerUserId,
  principalAccountId: calendarEventPeople.principalAccountId,
  vaultId: calendarEventPeople.vaultId,
};
const artifactOwnerColumns = {
  ownerUserId: calendarEventArtifacts.ownerUserId,
  principalAccountId: calendarEventArtifacts.principalAccountId,
  vaultId: calendarEventArtifacts.vaultId,
};

function clientError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function organizationId(prefix: string, value: string): string {
  return `${prefix}-${createHash("md5").update(value).digest("hex")}`;
}

export function meetingsRootPageId(vaultId: string): string {
  return organizationId("meetings-root", vaultId);
}

export function meetingNodePageId(meetingKey: string): string {
  return organizationId("meeting-node", meetingKey);
}

export function calendarMeetingLibraryKey(input: {
  accountId: string;
  calendarId: string;
  googleEventId: string;
}): string {
  return `calendar:${input.accountId}:${input.calendarId}:${input.googleEventId}`;
}

function principalForVault(principal: Principal, vaultId: string): Principal {
  return {
    ...principal,
    activeVaultId: vaultId,
    visibleVaultIds: Array.from(new Set([...principal.visibleVaultIds, vaultId])),
  };
}

async function requireDestinationVault(principal: Principal, vaultId: string): Promise<void> {
  if (!principal.userId || !principal.accountId) {
    throw clientError(401, "An authenticated user account is required");
  }
  const [vault] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(eq(vaults.id, vaultId), eq(vaults.accountId, principal.accountId), eq(vaults.isArchived, false)))
    .limit(1);
  if (!vault) throw clientError(403, "Destination Vault is unavailable");
}

async function ensureOrganizationalPage(input: {
  id: string;
  title: string;
  slug: string;
  vaultId: string;
  parentId: string | null;
  tags: string[];
  principal: Principal;
}): Promise<typeof libraryPages.$inferSelect> {
  const principal = principalForVault(input.principal, input.vaultId);
  return runWithPrincipal(principal, async () => {
    await requireDestinationVault(principal, input.vaultId);
    const content = syncContentFields({ markdown: "" });
    return db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
      await acquireLibraryParentLocks(tx, [input.parentId]);
      await tx
        .insert(libraryPages)
        .values({
          id: input.id,
          title: input.title,
          slug: input.slug,
          content: content.content,
          plainTextContent: content.plainTextContent,
          parentId: input.parentId,
          tags: input.tags,
          structuralRole: "meta",
          ...ownedInsertValues(principal, pageScopeColumns),
          vaultId: input.vaultId,
          createdByUserId: principal.userId,
          updatedByUserId: principal.userId,
        })
        .onConflictDoNothing({ target: libraryPages.id });
      const [page] = await tx
        .select()
        .from(libraryPages)
        .where(combineWithVisibleScope(principal, pageScopeColumns, eq(libraryPages.id, input.id)))
        .limit(1);
      if (!page) throw clientError(409, `Meeting Library page ${input.id} is unavailable`);
      const expected = page.vaultId === input.vaultId
        && page.parentId === input.parentId
        && input.tags.every(tag => page.tags.includes(tag));
      if (!expected) throw clientError(409, `Meeting Library page ${input.id} conflicts with canonical organization`);
      if (page.title !== input.title) {
        const [updated] = await tx
          .update(libraryPages)
          .set({ title: input.title, updatedAt: new Date(), updatedByUserId: principal.userId })
          .where(combineWithWritableScope(principal, pageScopeColumns, eq(libraryPages.id, page.id)))
          .returning();
        if (!updated) throw clientError(409, "Meeting Library title projection changed concurrently");
        return updated;
      }
      return page;
    }));
  });
}

export async function ensureMeetingsRoot(vaultId: string, principal = getCurrentPrincipalOrSystem()) {
  return ensureOrganizationalPage({
    id: meetingsRootPageId(vaultId),
    title: "Meetings",
    slug: `meetings-${vaultId}`,
    vaultId,
    parentId: null,
    tags: ["system-folder", MEETINGS_ROOT_TAG],
    principal,
  });
}

export async function ensureMeetingLibraryNode(input: {
  vaultId: string;
  meetingKey: string;
  title: string;
  principal?: Principal;
}) {
  const principal = input.principal ?? getCurrentPrincipalOrSystem();
  const root = await ensureMeetingsRoot(input.vaultId, principal);
  const id = meetingNodePageId(input.meetingKey);
  return ensureOrganizationalPage({
    id,
    title: input.title.trim() || "Meeting",
    slug: id,
    vaultId: input.vaultId,
    parentId: root.id,
    tags: ["system-folder", MEETING_INSTANCE_TAG],
    principal,
  });
}

export async function organizeMeetingLibraryPage(input: {
  pageId: string;
  nodePageId: string;
  vaultId: string;
  principal?: Principal;
}): Promise<void> {
  if (input.pageId === input.nodePageId) return;
  const principal = principalForVault(input.principal ?? getCurrentPrincipalOrSystem(), input.vaultId);
  await runWithPrincipal(principal, async () => {
    const [page] = await db
      .select({ id: libraryPages.id, parentId: libraryPages.parentId, vaultId: libraryPages.vaultId })
      .from(libraryPages)
      .where(combineWithVisibleScope(principal, pageScopeColumns, eq(libraryPages.id, input.pageId)))
      .limit(1);
    if (!page) throw clientError(404, "Meeting artifact is not visible");
    if (page.parentId === input.nodePageId && page.vaultId === input.vaultId) return;
    await moveLibraryPage({
      pageId: page.id,
      destinationParentId: input.nodePageId,
      destinationVaultId: input.vaultId,
    }, principal);
  });
}

export async function ensureMeetingRootsForAllVaults(): Promise<void> {
  const result = await db.execute(sql`
    INSERT INTO library_pages (
      id, title, slug, content, plain_text_content, parent_id, tags,
      structural_role, scope, owner_user_id, account_id, vault_id,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    )
    SELECT
      'meetings-root-' || md5(v.id),
      'Meetings',
      'meetings-' || v.id,
      '{"type":"doc","content":[]}'::jsonb,
      '',
      NULL,
      ARRAY['system-folder', 'meeting-root']::text[],
      'meta',
      'user',
      COALESCE(a.owner_user_id, owner_membership.user_id),
      v.account_id,
      v.id,
      COALESCE(a.owner_user_id, owner_membership.user_id),
      COALESCE(a.owner_user_id, owner_membership.user_id),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM vaults v
    JOIN accounts a ON a.id = v.account_id
    LEFT JOIN LATERAL (
      SELECT m.user_id
      FROM memberships m
      WHERE m.account_id = v.account_id
      ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.id
      LIMIT 1
    ) owner_membership ON TRUE
    WHERE v.is_archived = FALSE
      AND COALESCE(a.owner_user_id, owner_membership.user_id) IS NOT NULL
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
  const created = (result.rows ?? []).length;
  if (created > 0) log.info("reserved Meetings roots converged", { created });
}


export async function moveCalendarMeetingAggregate(input: {
  metadataId: number;
  event: CalendarEvent;
  destinationVaultId: string;
}): Promise<{ metadata: typeof calendarEventMetadata.$inferSelect; nodePageId: string; sessionId: string | null }> {
  const outer = getCurrentPrincipalOrSystem();
  if (outer.actorType !== "user" || !outer.userId || !outer.accountId) {
    throw clientError(401, "A user principal is required to move a meeting");
  }
  if (!outer.visibleVaultIds.includes(input.destinationVaultId)) {
    throw clientError(403, "Destination Vault is not visible");
  }
  const destinationPrincipal = principalForVault(outer, input.destinationVaultId);
  await requireDestinationVault(destinationPrincipal, input.destinationVaultId);
  const result = await db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.MEETING_VAULT, String(input.metadataId));
      const [metadata] = await tx
        .select()
        .from(calendarEventMetadata)
        .where(combineWithSensitiveWritable(metadataOwnerColumns, eq(calendarEventMetadata.id, input.metadataId), outer))
        .limit(1);
      if (!metadata?.vaultId) throw clientError(409, "Meeting ownership is incomplete");
      const sourceVaultId = metadata.vaultId;
      const scopedPrincipal: Principal = {
        ...destinationPrincipal,
        visibleVaultIds: Array.from(new Set([...outer.visibleVaultIds, sourceVaultId, input.destinationVaultId])),
      };
      return runWithPrincipal(scopedPrincipal, async () => {
        const meetingKey = calendarMeetingLibraryKey({
          accountId: input.event.accountId,
          calendarId: input.event.calendarId,
          googleEventId: input.event.id,
        });
        const node = await ensureMeetingLibraryNode({
          vaultId: sourceVaultId,
          meetingKey,
          title: input.event.summary || "Meeting",
          principal: scopedPrincipal,
        });
        const artifacts = await tx
          .select({ pageId: calendarEventArtifacts.libraryPageId })
          .from(calendarEventArtifacts)
          .where(combineWithSensitiveWritable(artifactOwnerColumns, eq(calendarEventArtifacts.metadataId, metadata.id), scopedPrincipal));
        const occurrenceKey = calendarOccurrenceKey(input.event);
        const session = await chatStorage.findMeetingSessionForOccurrence({
          occurrenceKey,
          calendarAccountId: input.event.accountId,
          calendarId: input.event.calendarId,
          providerEventId: input.event.id,
        });
        const pageIds = new Set<string>([
          ...(metadata.agendaLibraryPageId ? [metadata.agendaLibraryPageId] : []),
          ...artifacts.map(artifact => artifact.pageId),
          ...(session?.meeting?.recap?.pageId ? [session.meeting.recap.pageId] : []),
        ]);
        for (const pageId of pageIds) {
          await organizeMeetingLibraryPage({ pageId, nodePageId: node.id, vaultId: sourceVaultId, principal: scopedPrincipal });
        }
        const destinationRoot = await ensureMeetingsRoot(input.destinationVaultId, scopedPrincipal);
        if (sourceVaultId !== input.destinationVaultId || node.parentId !== destinationRoot.id) {
          await moveLibraryPage({
            pageId: node.id,
            destinationParentId: destinationRoot.id,
            destinationVaultId: input.destinationVaultId,
            protectedRootTag: MEETING_INSTANCE_TAG,
          }, scopedPrincipal);
        }
        const [updatedMetadata] = await tx
          .update(calendarEventMetadata)
          .set({ vaultId: input.destinationVaultId, updatedAt: new Date() })
          .where(combineWithSensitiveWritable(metadataOwnerColumns, eq(calendarEventMetadata.id, metadata.id), scopedPrincipal))
          .returning();
        if (!updatedMetadata) throw clientError(409, "Meeting metadata Vault transfer failed");
        await tx
          .update(calendarEventPeople)
          .set({ vaultId: input.destinationVaultId })
          .where(combineWithSensitiveWritable(peopleOwnerColumns, eq(calendarEventPeople.metadataId, metadata.id), scopedPrincipal));
        await tx
          .update(calendarEventArtifacts)
          .set({ vaultId: input.destinationVaultId, updatedAt: new Date() })
          .where(combineWithSensitiveWritable(artifactOwnerColumns, eq(calendarEventArtifacts.metadataId, metadata.id), scopedPrincipal));
        if (session) {
          const movedSession = await chatStorage.moveMeetingToVault(
            session.id,
            input.destinationVaultId,
            node.id,
          );
          if (!movedSession) throw clientError(409, "Meeting session Vault transfer failed");
        }
        log.info("meeting Vault aggregate moved", {
          metadataId: metadata.id,
          sourceVaultId,
          destinationVaultId: input.destinationVaultId,
          artifactCount: pageIds.size,
          sessionId: session?.id ?? null,
        });
        return { metadata: updatedMetadata, nodePageId: node.id, sessionId: session?.id ?? null };
      });
    }));
  // The meeting aggregate move writes calendar_event_metadata.vault_id directly,
  // so it must invalidate the Infinity-TTL calendar metadata cache the same way
  // every other metadata mutation does; otherwise stale reads revert the Vault.
  const { invalidateCalendarCache } = await import("../calendar-metadata");
  invalidateCalendarCache();
  return result;
}
