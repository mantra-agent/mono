const PLACEHOLDER_TITLES = new Set(["New Session", "New Chat"]);

export interface SessionOrientationSnapshot {
  title?: string | null;
  contextFlags?: Record<string, boolean> | null;
}

/** A meaningful title is required for initial persona selection and routing. */
export function hasRealSessionTitle(title: string | null | undefined): boolean {
  return !!title && !PLACEHOLDER_TITLES.has(title);
}

/**
 * Canonical persisted orientation invariant.
 *
 * A session is established only after it has both a meaningful title and an
 * explicit context-scope decision. An empty contextFlags map is meaningful: it
 * selects bootstrap/default sections only. Undefined/null means scope has not
 * been established yet.
 */
export function isSessionOrientationEstablished(
  session: SessionOrientationSnapshot | null | undefined,
): boolean {
  return hasRealSessionTitle(session?.title) && session?.contextFlags != null;
}
