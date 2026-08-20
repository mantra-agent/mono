import { extname } from "path";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { getPostgresErrorCode } from "./postgres-errors";
import { requireCurrentUserPrincipal } from "./principal-context";
import { driveResources, indexedFileSources, uploadResourceSources } from "@shared/schema";
import { vaults } from "@shared/models/vaults";

const log = createLogger("UploadResourceService");
const UPLOAD_PATH = /\/objects\/uploads\/[A-Za-z0-9._-]+/g;
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERIC_UPLOAD_NAME =
  /^(img|dsc|pxl|mov|vid|photo|image|picture|untitled|download|screenshot|screen[ _-]?shot)([-_ .]?\d+)*$/i;
const NAME_FILLER =
  /^(this|that|the|an|a|image|photo|picture|screenshot|shows?|depicts?|contains?|features?|appears?|showing|of|with|and|to|be|is|are|it)$/i;

export interface RegisterUploadInput {
  objectPath: string;
  name: string;
  mimeType?: string | null;
  sessionId?: string | null;
}

function basenameWithoutExt(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim();
}

export function isGenericUploadName(name: string): boolean {
  const base = basenameWithoutExt(name.split("/").pop() ?? name);
  if (!base) return true;
  if (UUID_NAME.test(base)) return true;
  if (GENERIC_UPLOAD_NAME.test(base)) return true;
  return false;
}

export function deriveUploadDisplayName(description: string, currentName: string): string {
  const rawExt = extname(currentName) || extname(currentName.split("/").pop() ?? "") || ".png";
  const ext = rawExt.toLowerCase();
  const words = description
    .replace(/[`*_#>\[\]()]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9-]/g, ""))
    .filter((word) => word.length > 1 && !NAME_FILLER.test(word))
    .slice(0, 6);
  const chosen = words.length >= 2 ? words : ["Analyzed", "Image"];
  const title = chosen
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
  return `${title}${ext}`;
}

async function resolveUploadVault(sessionId?: string | null): Promise<string> {
  const principal = requireCurrentUserPrincipal();
  if (sessionId) {
    const rows = await db.execute(sql`
      SELECT vault_id FROM document_store_documents
      WHERE document_type = 'chat' AND document_id = ${sessionId}
        AND owner_user_id = ${principal.userId} AND account_id = ${principal.accountId}
      LIMIT 1
    `);
    const vaultId = (rows.rows[0] as { vault_id?: string } | undefined)?.vault_id;
    if (vaultId) return vaultId;
    throw Object.assign(new Error("Session not found"), { status: 404 });
  }
  const [personal] = await db.select({ id: vaults.id }).from(vaults).where(and(
    eq(vaults.accountId, principal.accountId), eq(vaults.isDefault, true), eq(vaults.isArchived, false),
  )).limit(1);
  if (!personal) throw new Error("Personal vault is unavailable");
  return personal.id;
}

export async function registerUploadResource(input: RegisterUploadInput) {
  const principal = requireCurrentUserPrincipal();
  const objectPath = input.objectPath.trim();
  if (!objectPath.startsWith("/objects/uploads/")) throw Object.assign(new Error("Invalid upload object path"), { status: 400 });
  const vaultId = await resolveUploadVault(input.sessionId);
  const incomingName = input.name.trim() || objectPath.split("/").pop()!;
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({
      id: driveResources.id,
      name: driveResources.name,
    }).from(driveResources).where(and(
      eq(driveResources.vaultId, vaultId),
      eq(driveResources.provider, "mantra"),
      eq(driveResources.providerFileId, objectPath),
    )).limit(1);
    const nextName = existing && !isGenericUploadName(existing.name) && isGenericUploadName(incomingName)
      ? existing.name
      : incomingName;
    const [resource] = await tx.insert(driveResources).values({
      accountId: principal.accountId!, vaultId, connectedAccountId: null, provider: "mantra",
      providerFileId: objectPath, name: nextName,
      mimeType: input.mimeType ?? null, resourceType: "file", origin: "upload",
      sourceSessionId: input.sessionId ?? null, addedByUserId: principal.userId,
    }).onConflictDoUpdate({
      target: [driveResources.vaultId, driveResources.provider, driveResources.providerFileId],
      set: { name: nextName, mimeType: input.mimeType ?? null },
    }).returning();
    if (input.sessionId) {
      await tx.insert(uploadResourceSources).values({ driveResourceId: resource.id, sessionId: input.sessionId, sourceKind: "conversation" }).onConflictDoNothing();
    }
    log.info("upload registered as file resource", { driveResourceId: resource.id, vaultId, hasSessionSource: !!input.sessionId });
    return resource;
  });
}

/** Rename only the Files display name. Object-storage keys stay immutable. */
export async function renameUploadResourceDisplayName(input: {
  objectPath: string;
  name: string;
}): Promise<{ id: string; previousName: string; name: string } | null> {
  const principal = requireCurrentUserPrincipal();
  const objectPath = input.objectPath.trim().split("?")[0];
  const nextName = input.name.trim();
  if (!objectPath.startsWith("/objects/uploads/") || !nextName) return null;

  const [resource] = await db.select({
    id: driveResources.id,
    name: driveResources.name,
    origin: driveResources.origin,
  }).from(driveResources).where(and(
    eq(driveResources.accountId, principal.accountId!),
    eq(driveResources.provider, "mantra"),
    eq(driveResources.providerFileId, objectPath),
    eq(driveResources.origin, "upload"),
  )).limit(1);
  if (!resource) return null;
  if (!isGenericUploadName(resource.name) || resource.name === nextName) {
    return { id: resource.id, previousName: resource.name, name: resource.name };
  }

  const [updated] = await db.update(driveResources)
    .set({ name: nextName })
    .where(eq(driveResources.id, resource.id))
    .returning({ id: driveResources.id, name: driveResources.name });
  if (!updated) return null;

  await db.update(indexedFileSources)
    .set({ name: nextName, updatedAt: new Date() })
    .where(eq(indexedFileSources.driveResourceId, resource.id));

  log.info("upload display name renamed", {
    driveResourceId: resource.id,
    previousName: resource.name,
    name: updated.name,
  });
  return { id: updated.id, previousName: resource.name, name: updated.name };
}

/** Prefer recent chats; hard caps keep reconcile under the general 10s statement ceiling. */
const RECONCILE_SESSION_LIMIT = 200;
const RECONCILE_SESSION_BATCH = 25;
const RECONCILE_MESSAGES_PER_BATCH = 500;
const RECONCILE_SOURCE_ROW_CAP = 5000;

type UploadSourceRow = { document_id: string; content: string };

async function registerUploadPathsFromRows(
  rows: UploadSourceRow[],
  seen: Set<string>,
): Promise<number> {
  let registered = 0;
  for (const row of rows) {
    const paths = String(row.content ?? "").match(UPLOAD_PATH) ?? [];
    for (const objectPath of paths) {
      const key = `${row.document_id}:${objectPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await registerUploadResource({
        objectPath,
        name: objectPath.split("/").pop()!,
        sessionId: row.document_id,
      });
      registered += 1;
    }
  }
  return registered;
}

/**
 * Scan principal-owned chats for `/objects/uploads/` paths and register missing
 * mantra drive_resources. Newest-first + small batches so the route finishes
 * inside the general pool statement_timeout instead of one giant CTE join.
 */
export async function reconcileUploadResources(): Promise<{
  scanned: number;
  registered: number;
  unassigned: number;
  partial: boolean;
}> {
  const principal = requireCurrentUserPrincipal();
  const sessionsResult = await db.execute(sql`
    SELECT document_id, vault_id, content
    FROM document_store_documents
    WHERE document_type = 'chat'
      AND owner_user_id = ${principal.userId}
      AND account_id = ${principal.accountId}
      AND vault_id IS NOT NULL
    ORDER BY id DESC
    LIMIT ${RECONCILE_SESSION_LIMIT}
  `);
  const sessions = sessionsResult.rows as Array<{
    document_id: string;
    vault_id: string;
    content: string | null;
  }>;

  const seen = new Set<string>();
  let registered = 0;
  let sourceRows = 0;
  let partial = sessions.length >= RECONCILE_SESSION_LIMIT;

  // Legacy blob content still carries transcript text until first canonical write.
  const blobHits = sessions
    .filter((session) => String(session.content ?? "").includes("/objects/uploads/"))
    .map((session) => ({ document_id: session.document_id, content: String(session.content ?? "") }));
  sourceRows += blobHits.length;
  registered += await registerUploadPathsFromRows(blobHits, seen);

  try {
    for (let offset = 0; offset < sessions.length; offset += RECONCILE_SESSION_BATCH) {
      if (sourceRows >= RECONCILE_SOURCE_ROW_CAP) {
        partial = true;
        break;
      }
      const batch = sessions.slice(offset, offset + RECONCILE_SESSION_BATCH);
      const sessionIds = batch.map((session) => session.document_id);
      if (sessionIds.length === 0) continue;
      const remaining = RECONCILE_SOURCE_ROW_CAP - sourceRows;
      const rowLimit = Math.min(RECONCILE_MESSAGES_PER_BATCH, remaining);
      // Bound to a small session set so the LIKE scan rides account/session indexes
      // instead of casting every conversation_messages payload for the account.
      const messageResult = await db.execute(sql`
        SELECT session_id AS document_id, payload::text AS content
        FROM conversation_messages
        WHERE owner_user_id = ${principal.userId}
          AND account_id = ${principal.accountId}
          AND session_id IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})
          AND payload::text LIKE '%/objects/uploads/%'
        ORDER BY id DESC
        LIMIT ${rowLimit}
      `);
      const messageRows = messageResult.rows as UploadSourceRow[];
      if (messageRows.length === 0) continue;
      if (messageRows.length >= rowLimit) partial = true;
      sourceRows += messageRows.length;
      registered += await registerUploadPathsFromRows(messageRows, seen);
    }
  } catch (error) {
    // Partial progress already registered is still a completed route contract.
    // Statement timeout (57014) must not surface as DriveResourceRoutes ERRORS.
    partial = true;
    const code = getPostgresErrorCode(error);
    log.warn("upload reconcile message scan degraded", {
      code,
      scanned: sessions.length,
      registered,
      sourceRows,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let unassigned = 0;
  try {
    const unassignedResult = await db.execute(sql`
      SELECT count(*)::int AS count FROM object_acls oa
      WHERE oa.object_key LIKE '%/uploads/%'
        AND (oa.policy->>'ownerUserId' = ${principal.userId} OR oa.policy->>'owner' = ${principal.userId})
        AND oa.policy->>'accountId' = ${principal.accountId}
        AND NOT EXISTS (
          SELECT 1 FROM drive_resources dr
          WHERE dr.account_id = ${principal.accountId} AND dr.provider = 'mantra'
            AND split_part(dr.provider_file_id, '/objects/', 2) = regexp_replace(oa.object_key, '^(vaults/[^/]+/|private/)', '')
        )
    `);
    unassigned = Number((unassignedResult.rows[0] as { count?: number })?.count ?? 0);
  } catch (error) {
    // Unassigned count is diagnostic only — never fail the reconcile contract on it.
    partial = true;
    log.warn("upload reconcile unassigned count degraded", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (partial) {
    log.warn("upload reconcile completed partially", {
      scanned: sessions.length,
      registered,
      unassigned,
      sourceRows,
      sessionLimit: RECONCILE_SESSION_LIMIT,
    });
  } else {
    log.info("upload reconcile completed", {
      scanned: sessions.length,
      registered,
      unassigned,
      sourceRows,
    });
  }

  return { scanned: sessions.length, registered, unassigned, partial };
}

export async function listUnassignedUploads() {
  const principal = requireCurrentUserPrincipal();
  if (!principal.permissions.includes("system:read")) throw Object.assign(new Error("Permission required"), { status: 403 });
  const result = await db.execute(sql`
    SELECT oa.object_key, oa.updated_at FROM object_acls oa
    WHERE oa.object_key LIKE '%/uploads/%'
      AND (oa.policy->>'ownerUserId' = ${principal.userId} OR oa.policy->>'owner' = ${principal.userId})
      AND oa.policy->>'accountId' = ${principal.accountId}
      AND NOT EXISTS (
        SELECT 1 FROM drive_resources dr
        WHERE dr.account_id = ${principal.accountId} AND dr.provider = 'mantra'
          AND split_part(dr.provider_file_id, '/objects/', 2) = regexp_replace(oa.object_key, '^(vaults/[^/]+/|private/)', '')
      )
    ORDER BY oa.updated_at DESC LIMIT 500
  `);
  return result.rows;
}
