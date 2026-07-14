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

/**
 * A date-only string in strict YYYY-MM-DD form (a "civil date").
 *
 * Branded so APIs can require a validated civil date instead of an arbitrary
 * string. Produce values via `isCivilDate` narrowing.
 *
 * Never pass a civil date string directly to `new Date(...)`: the ECMAScript
 * spec parses bare YYYY-MM-DD as UTC midnight, which renders as the previous
 * day in any timezone west of UTC. Use `fromCivilDate` (known-civil input) or
 * `parseDateString` (mixed input) instead.
 */
export type CivilDateString = string & { readonly __brand: "CivilDateString" };

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Type guard: true when the value is a strict YYYY-MM-DD civil date string.
 */
export function isCivilDate(value: string): value is CivilDateString {
  return CIVIL_DATE_PATTERN.test(value);
}

/**
 * Parses a date string that may be either a civil date (YYYY-MM-DD) or a full
 * timestamp (ISO 8601 or other Date-parseable form).
 *
 * Civil dates are parsed as local midnight via `fromCivilDate`; everything
 * else falls through to native Date parsing. Use this at boundaries where the
 * stored format is mixed (e.g. legacy records with timestamps alongside new
 * civil-date records).
 */
export function parseDateString(value: string): Date {
  return isCivilDate(value) ? fromCivilDate(value) : new Date(value);
}
