import { exists, notExists, sql, type SQL } from "drizzle-orm";
import { libraryPageTrash, libraryPages } from "@shared/models/info";

/**
 * Library Trash lifecycle predicates. A sidecar row is the single source of
 * truth: absence means live; presence means trashed. Callers must still compose
 * these with the page's principal-visible/writable scope predicate.
 */
export function libraryPageIsLive(): SQL {
  return notExists(
    sql`SELECT 1 FROM ${libraryPageTrash} WHERE ${libraryPageTrash.pageId} = ${libraryPages.id}`,
  );
}

export function libraryPageIsTrashed(): SQL {
  return exists(
    sql`SELECT 1 FROM ${libraryPageTrash} WHERE ${libraryPageTrash.pageId} = ${libraryPages.id}`,
  );
}
