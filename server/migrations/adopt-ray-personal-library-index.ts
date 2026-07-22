import { and, eq, sql } from "drizzle-orm";
import { libraryPages } from "@shared/models/info";
import { syncContentFields } from "@shared/markdown-tiptap";
import { db } from "../db";
import { createLogger } from "../log";

const log = createLogger("AdoptRayPersonalLibraryIndex");

const RAY_OWNER_USER_ID = "f6de5710-5f8a-4e91-afa2-c673a997ce2d";
const RAY_APPROVED_INDEX_ACCOUNT_ID = "1d52cbc6-d922-4afd-b5e8-0eeeb5babd47";
const RAY_PERSONAL_VAULT_ACCOUNT_ID = "1d52cbcd-d922-4afd-b5e8-0eeeb5babd47";
const RAY_PERSONAL_VAULT_ID = "f26432c0-7d60-4b50-9541-e67eab2d5542";
const APPROVED_INDEX_PAGE_ID = "c9c75e5d-b096-49d4-ab9f-35890d1ec95d";
const PERSONAL_INDEX_PAGE_ID = "e8a1cbe7-66d4-4024-910d-d895a45e6a53";
const EXPERIMENTAL_INDEX_MARKDOWN =
  "# Library Index\n\n## Entities\n\n## Concepts\n\n## Synthesis\n\nThis semantic catalog lists compiled Wiki pages only. It is intentionally empty until ingest creates or updates Wiki pages.";

/**
 * Replay-safe adoption of Ray's already approved Personal organization.
 *
 * The July 21 Library2 bootstrap created an experimental generic Index in the
 * Personal vault while the reviewed domain Index remained a separate owned
 * document. Copying the approved content into the canonical Personal-vault
 * Index corrects the producer without moving, reparenting, or deleting pages.
 * Exact identity and seed-content guards make user edits win and limit this
 * repair to Ray's established documents.
 */
export async function adoptRayPersonalLibraryIndex(): Promise<void> {
  const [approved] = await db
    .select({
      plainTextContent: libraryPages.plainTextContent,
      tags: libraryPages.tags,
    })
    .from(libraryPages)
    .where(
      and(
        eq(libraryPages.id, APPROVED_INDEX_PAGE_ID),
        eq(libraryPages.ownerUserId, RAY_OWNER_USER_ID),
        eq(libraryPages.accountId, RAY_APPROVED_INDEX_ACCOUNT_ID),
        eq(libraryPages.scope, "user"),
        eq(libraryPages.structuralRole, "meta"),
      ),
    )
    .limit(1);

  if (!approved) {
    log.warn("approved Personal Index source not found; migration skipped");
    return;
  }

  const synced = syncContentFields({ markdown: approved.plainTextContent });
  const tags = Array.from(
    new Set([...(approved.tags ?? []), "library-index", "library-meta", "personal"]),
  );
  const updated = await db
    .update(libraryPages)
    .set({
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      tags,
      updatedByUserId: RAY_OWNER_USER_ID,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(libraryPages.id, PERSONAL_INDEX_PAGE_ID),
        eq(libraryPages.ownerUserId, RAY_OWNER_USER_ID),
        eq(libraryPages.accountId, RAY_PERSONAL_VAULT_ACCOUNT_ID),
        eq(libraryPages.vaultId, RAY_PERSONAL_VAULT_ID),
        eq(libraryPages.scope, "user"),
        eq(libraryPages.structuralRole, "meta"),
        eq(libraryPages.plainTextContent, EXPERIMENTAL_INDEX_MARKDOWN),
      ),
    )
    .returning({ id: libraryPages.id });

  if (updated.length > 0) {
    log.info("adopted approved domain organization into Ray's Personal Index", {
      indexPageId: PERSONAL_INDEX_PAGE_ID,
      sourcePageId: APPROVED_INDEX_PAGE_ID,
      vaultId: RAY_PERSONAL_VAULT_ID,
    });
  }
}
