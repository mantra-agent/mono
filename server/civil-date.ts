import { toZonedTime, format } from 'date-fns-tz';

/**
 * Converts a Date to YYYY-MM-DD in the user's specified timezone.
 * 
 * This is the canonical function for writing interaction dates and any other
 * user-visible date fields that should be interpreted in the user's local timezone.
 * 
 * @param timestamp - The Date to convert
 * @param timezone - IANA timezone string (e.g., 'America/Chicago')
 * @returns Date string in YYYY-MM-DD format, representing the civil date in the timezone
 */
export function toCivilDate(timestamp: Date, timezone: string): string {
  const zonedDate = toZonedTime(timestamp, timezone);
  return format(zonedDate, 'yyyy-MM-dd', { timeZone: timezone });
}

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
 * @param dateString - Date string in YYYY-MM-DD format
 * @returns Date object representing midnight at the start of that civil day
 */
export function fromCivilDate(dateString: string): Date {
  // Parse YYYY-MM-DD as midnight in local time, without Z suffix.
  // This allows the browser/runtime to interpret it in its own timezone context.
  return new Date(`${dateString}T00:00:00`);
}
