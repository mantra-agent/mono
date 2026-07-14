/**
 * Parses a YYYY-MM-DD string as midnight in the local/browser timezone.
 * 
 * This is used for round-tripping: a civil date stored as YYYY-MM-DD is read back
 * as a Date that represents midnight at the start of that civil day.
 * 
 * The browser/runtime will interpret this Date in its own local context, so the
 * exact interpretation depends on where this is called. For server work, callers
 * should ensure they have the user's timezone available and not rely on the
 * runtime timezone.
 * 
 * This is a pure utility that works in both client and server contexts.
 * 
 * @param dateString - Date string in YYYY-MM-DD format
 * @returns Date object representing midnight at the start of that civil day
 */
export function fromCivilDate(dateString: string): Date {
  // Parse YYYY-MM-DD as midnight in local time, without Z suffix.
  // This allows the browser/runtime to interpret it in its own timezone context.
  return new Date(`${dateString}T00:00:00`);
}
