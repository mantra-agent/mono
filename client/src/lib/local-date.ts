/**
 * Date helpers that operate on the user's local calendar day rather than raw
 * millisecond diffs. A naive `(now - then) / 86_400_000` will mis-bucket a
 * timestamp from 23:00 yesterday vs. 01:00 today (only ~2 hours apart, but a
 * different local day). These helpers anchor on local midnight so callers can
 * group/format by local day correctly across the midnight boundary.
 */

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function toDate(value: Date | string): Date {
  return typeof value === "string" ? new Date(value) : value;
}

/**
 * Returns the integer number of local calendar days between `now` and `date`.
 * Positive means `date` is in the past relative to `now`; negative means future.
 *
 * Uses Math.round so DST transitions (where a "day" is 23 or 25 hours) still
 * collapse to the correct integer day count.
 */
export function localDayDiff(date: Date | string, now: Date = new Date()): number {
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) return 0;
  const diffMs = startOfLocalDay(now) - startOfLocalDay(d);
  return Math.round(diffMs / 86_400_000);
}

export type LocalDayBucket = "today" | "yesterday" | "this-week" | "older";

/**
 * Bucket a date into a coarse local-day group. Future dates fold into "today".
 */
export function groupByLocalDay(date: Date | string, now: Date = new Date()): LocalDayBucket {
  const diff = localDayDiff(date, now);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return "this-week";
  return "older";
}

export interface FormatRelativeDateOptions {
  /** Reference "now" for testing or batched rendering. Defaults to `new Date()`. */
  now?: Date;
  /** Capitalize "today"/"yesterday". Default: false. */
  capitalize?: boolean;
  /**
   * When the local-day diff exceeds this many days, `fallback` is used instead
   * of the relative "Nd/Nw/Nmo ago" format. Default: Infinity.
   */
  fallbackAfterDays?: number;
  /** Renderer for dates beyond `fallbackAfterDays` (or beyond the months bound). */
  fallback?: (d: Date) => string;
  /** When to switch from "Nd ago" to "Nw ago". Default: 14. */
  weeksAfterDays?: number;
  /** When to switch from "Nw ago" to "Nmo ago". Default: 60. */
  monthsAfterDays?: number;
}

/**
 * Format a past date relative to `now` using local-day boundaries.
 *
 *   diff <= 0          -> "today"
 *   diff === 1         -> "yesterday"
 *   diff > fallbackAfterDays && fallback -> fallback(date)
 *   diff < weeksAfterDays                -> "Nd ago"
 *   diff < monthsAfterDays               -> "Nw ago"
 *   else && fallback                     -> fallback(date)
 *   else                                  -> "Nmo ago"
 */
export function formatRelativeDate(
  date: Date | string,
  opts: FormatRelativeDateOptions = {},
): string {
  const now = opts.now ?? new Date();
  const d = toDate(date);
  const diff = localDayDiff(d, now);
  const cap = (s: string) =>
    opts.capitalize ? s.charAt(0).toUpperCase() + s.slice(1) : s;

  if (diff <= 0) return cap("today");
  if (diff === 1) return cap("yesterday");

  const fallbackAfter = opts.fallbackAfterDays ?? Infinity;
  if (opts.fallback && diff > fallbackAfter) return opts.fallback(d);

  const weeksAfter = opts.weeksAfterDays ?? 14;
  const monthsAfter = opts.monthsAfterDays ?? 60;
  if (diff < weeksAfter) return `${diff}d ago`;
  if (diff < monthsAfter) return `${Math.floor(diff / 7)}w ago`;
  if (opts.fallback) return opts.fallback(d);
  return `${Math.floor(diff / 30)}mo ago`;
}
