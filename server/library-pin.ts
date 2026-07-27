import { sql, type SQL } from "drizzle-orm";
import { libraryPagePins, libraryPages } from "@shared/models/info";

/**
 * Library pin predicate. The sidecar row is derived page metadata; callers
 * must still compose it with the page's principal-visible/writable predicate.
 */
export function libraryPageIsPinned(): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM ${libraryPagePins}
    WHERE ${libraryPagePins.pageId} = ${libraryPages.id}
  )`;
}
