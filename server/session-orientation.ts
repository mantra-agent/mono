const PLACEHOLDER_TITLES = new Set(["New Session", "New Chat"]);

export interface SessionOrientationSnapshot {
  title?: string | null;
  personaId?: number | null;
  /** Legacy signal: pre-persona sessions marked orientation via context flags. */
  contextFlags?: Record<string, boolean> | null;
}

/** A meaningful title is required for initial persona selection and routing. */
export function hasRealSessionTitle(title: string | null | undefined): boolean {
  return !!title && !PLACEHOLDER_TITLES.has(title);
}

/**
 * Canonical persisted orientation invariant.
 *
 * A session is established once it has a meaningful title. Persona is optional:
 * unoriented is a real state when the opening has no job. Legacy sessions that
 * predate persona-owned context are still honored via their persisted context flags.
 */
export function isSessionOrientationEstablished(
  session: SessionOrientationSnapshot | null | undefined,
): boolean {
  return hasRealSessionTitle(session?.title);
}
