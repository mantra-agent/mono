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

/**
 * Canonical persisted orientation invariant.
 *
 * A session is established once it has a topic title. Transport locators
 * (`Slack DM:`, `Slack Channel:`) name the conversation, not the job, so they
 * do not seal orientation. Persona is optional: unoriented is a real state
 * when the opening has no job. Legacy sessions that predate persona-owned
 * context are still honored via their persisted context flags.
 */
export function isSessionOrientationEstablished(
  session: SessionOrientationSnapshot | null | undefined,
): boolean {
  if (hasRealSessionTitle(session?.title)) return true;
  return session?.contextFlags != null;
}
