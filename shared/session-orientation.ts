const PLACEHOLDER_TITLES = new Set(["New Session", "New Chat"]);
const LOCATOR_TITLE_PREFIXES = ["Slack DM:", "Slack Channel:"];

export interface SessionOrientationSnapshot {
  title?: string | null;
  personaId?: number | null;
  /** Legacy signal: pre-persona sessions marked orientation via context flags. */
  contextFlags?: Record<string, boolean> | null;
}

/** A topic title is required for initial persona selection and routing. Transport locators are not topics. */
export function hasRealSessionTitle(title: string | null | undefined): boolean {
  if (!title || PLACEHOLDER_TITLES.has(title)) return false;
  return !LOCATOR_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix));
}

function hasSelectablePersona(personaId: number | null | undefined): boolean {
  return typeof personaId === "number" && Number.isInteger(personaId) && personaId > 0;
}

/**
 * Canonical persisted orientation invariant.
 *
 * A session is established only when it has both a topic title and a
 * selectable persona. Transport locators (`Slack DM:`, `Slack Channel:`)
 * name the conversation, not the job, so they do not seal orientation.
 * Title-only never seals: the next turn must still bind a seat.
 * Root is composition, never a session seat. Unoriented is transient —
 * bootstrap retries until a selectable persona lands.
 */
export function isSessionOrientationEstablished(
  session: SessionOrientationSnapshot | null | undefined,
): boolean {
  return hasRealSessionTitle(session?.title) && hasSelectablePersona(session?.personaId);
}
