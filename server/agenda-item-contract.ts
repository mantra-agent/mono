// Single source of truth for the Session agenda item runtime contract.
//
// These bounds are enforced whenever an agenda is instantiated into a live
// Session (see `chat-file-storage.ts`). Because they only bite at instantiation
// time, a code-owned agenda fixture (e.g. the FTUE onboarding agenda) that
// violates one of them fails silently on the first real signup rather than at
// build time. Keeping the pure bounds and validators here lets both the runtime
// mutation boundary and the build-time fixture guard share exactly one contract,
// so a non-compliant fixture cannot drift past review again.

export const SESSION_AGENDA_MAX_ITEMS = 20;
export const SESSION_AGENDA_TITLE_MAX_CHARS = 80;
export const SESSION_AGENDA_DESCRIPTION_MAX_CHARS = 600;
export const SESSION_AGENDA_RESOLUTION_MAX_CHARS = 1_200;
export const SESSION_AGENDA_TITLE_MIN_WORDS = 3;
export const SESSION_AGENDA_TITLE_MAX_WORDS = 5;

export function boundedAgendaText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxChars) throw new Error(`${label} must be ${maxChars} characters or fewer`);
  return normalized;
}

export function normalizeAgendaTitle(value: unknown): string {
  const title = boundedAgendaText(value, "Agenda item title", SESSION_AGENDA_TITLE_MAX_CHARS);
  const wordCount = title.split(/\s+/).length;
  if (wordCount < SESSION_AGENDA_TITLE_MIN_WORDS || wordCount > SESSION_AGENDA_TITLE_MAX_WORDS) {
    throw new Error("Agenda item titles must be 3–5 words");
  }
  return title;
}

/**
 * Assert one agenda item's title and description satisfy the same runtime
 * contract that instantiation enforces. Throws a descriptive error naming the
 * offending field so a code-owned fixture failure is immediately diagnosable.
 * `id` is used only to make the error message point at the exact item.
 */
export function assertAgendaItemContract(item: { id?: string; title: string; description: string }): void {
  const where = item.id ? ` (item "${item.id}")` : "";
  try {
    normalizeAgendaTitle(item.title);
    boundedAgendaText(item.description, "Agenda item description", SESSION_AGENDA_DESCRIPTION_MAX_CHARS);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Agenda item contract violation${where}: ${detail}`);
  }
}
