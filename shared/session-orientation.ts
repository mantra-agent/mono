const PLACEHOLDER_TITLES = new Set(["New Session", "New Chat"]);
const LOCATOR_TITLE_PREFIXES = ["Slack DM:", "Slack Channel:"];

export interface SessionOrientationSnapshot {
  title?: string | null;
  personaId?: number | null;
  /** Legacy signal: pre-persona sessions marked orientation via context flags. */
  contextFlags?: Record<string, boolean> | null;
}

export function isLocatorSessionTitle(title: string | null | undefined): boolean {
  return !!title && LOCATOR_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix));
}

/** Any conversation name except the untitled placeholders. Locators count. */
export function hasSessionTitle(title: string | null | undefined): boolean {
  return !!title && !PLACEHOLDER_TITLES.has(title);
}

/** A topic title orientation may rewrite. Transport locators are names, not jobs. */
export function hasRealSessionTitle(title: string | null | undefined): boolean {
  return hasSessionTitle(title) && !isLocatorSessionTitle(title);
}

function hasSelectablePersona(personaId: number | null | undefined): boolean {
  return typeof personaId === "number" && Number.isInteger(personaId) && personaId > 0;
}

/**
 * Canonical persisted orientation invariant.
 *
 * A session is established when it has a conversation name and a
 * selectable persona. Transport locators (`Slack DM:`, `Slack Channel:`)
 * name the conversation and satisfy the title requirement; they must
 * not be rewritten. Placeholder titles (`New Session`) do not seal.
 * Title-only never seals: the next turn must still bind a seat.
 * Root is composition, never a session seat. Unoriented is transient —
 * bootstrap retries until a selectable persona lands.
 */
export function isSessionOrientationEstablished(
  session: SessionOrientationSnapshot | null | undefined,
): boolean {
  return hasSessionTitle(session?.title) && hasSelectablePersona(session?.personaId);
}
