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
 * A session is established once it has a meaningful title and an active persona.
 * Persona is the single source of context sections and tools, so selecting one is
 * the orientation act that scopes the session. Legacy sessions that predate
 * persona-owned context are still honored via their persisted context flags.
 */
export function isSessionOrientationEstablished(
  session: SessionOrientationSnapshot | null | undefined,
): boolean {
  return hasRealSessionTitle(session?.title)
    && (session?.personaId != null || session?.contextFlags != null);
}
