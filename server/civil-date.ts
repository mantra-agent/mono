import { toZonedTime, format } from 'date-fns-tz';
import { fromCivilDate } from '../shared/civil-date';

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

// Re-export fromCivilDate from shared for backwards compatibility
export { fromCivilDate };
