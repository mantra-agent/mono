import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";
import { driveResources, uploadResourceSources } from "@shared/schema";
import { vaults } from "@shared/models/vaults";

const log = createLogger("UploadResourceService");
const UPLOAD_PATH = /\/objects\/uploads\/[A-Za-z0-9._-]+/g;

export interface RegisterUploadInput {
  objectPath: string;
  name: string;
  mimeType?: string | null;
  sessionId?: string | null;
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
  return db.transaction(async (tx) => {
    const [resource] = await tx.insert(driveResources).values({
      accountId: principal.accountId!, vaultId, connectedAccountId: null, provider: "mantra",
      providerFileId: objectPath, name: input.name.trim() || objectPath.split("/").pop()!,
      mimeType: input.mimeType ?? null, resourceType: "file", origin: "upload",
      sourceSessionId: input.sessionId ?? null, addedByUserId: principal.userId,
    }).onConflictDoUpdate({
      target: [driveResources.vaultId, driveResources.provider, driveResources.providerFileId],
      set: { name: input.name.trim() || objectPath.split("/").pop()!, mimeType: input.mimeType ?? null },
    }).returning();
    if (input.sessionId) {
      await tx.insert(uploadResourceSources).values({ driveResourceId: resource.id, sessionId: input.sessionId, sourceKind: "conversation" }).onConflictDoNothing();
    }
    log.info("upload registered as file resource", { driveResourceId: resource.id, vaultId, hasSessionSource: !!input.sessionId });
    return resource;
  });
}

export async function reconcileUploadResources(): Promise<{ scanned: number; registered: number; unassigned: number }> {
  const principal = requireCurrentUserPrincipal();
  const result = await db.execute(sql`
    SELECT document_id, vault_id, content FROM document_store_documents
    WHERE document_type = 'chat' AND owner_user_id = ${principal.userId}
      AND account_id = ${principal.accountId} AND vault_id IS NOT NULL
    ORDER BY document_store_id ASC LIMIT 5000
  `);
  let registered = 0;
  const seen = new Set<string>();
  for (const row of result.rows as Array<{ document_id: string; content: string }>) {
    const paths = String(row.content ?? "").match(UPLOAD_PATH) ?? [];
    for (const objectPath of paths) {
      const key = `${row.document_id}:${objectPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await registerUploadResource({ objectPath, name: objectPath.split("/").pop()!, sessionId: row.document_id });
      registered += 1;
    }
  }
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
  return { scanned: result.rows.length, registered, unassigned: Number((unassignedResult.rows[0] as { count?: number })?.count ?? 0) };
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
