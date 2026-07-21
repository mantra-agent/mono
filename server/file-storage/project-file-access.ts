import { and, sql } from "drizzle-orm";
import { projects } from "@shared/schema";
import { db } from "../db";
import type { Principal } from "../principal";
import { combineWithVisibleScope } from "../scoped-storage";

const projectScopeColumns = {
  scope: projects.scope,
  ownerUserId: projects.ownerUserId,
  accountId: projects.accountId,
};

/**
 * Project attachments inherit read visibility from their owning project.
 *
 * Object ACL rows remain the fast path for newly uploaded files. This bounded
 * fallback preserves access to historical attachments created before project
 * uploads wrote an ACL, without broadening access beyond the parent project.
 */
export async function canReadProjectAttachment(
  principal: Principal,
  objectPath: string,
): Promise<boolean> {
  if (!objectPath.startsWith("/objects/")) return false;

  const linkedAttachment = sql<boolean>`EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(${projects.files}, '[]'::jsonb)) AS attachment
    WHERE attachment ->> 'objectKey' = ${objectPath}
  )`;

  const [visibleProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      combineWithVisibleScope(
        principal,
        projectScopeColumns,
        and(linkedAttachment),
      ),
    )
    .limit(1);

  return Boolean(visibleProject);
}
