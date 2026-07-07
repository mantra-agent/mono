/**
 * Shared wellness activity window utilities.
 * Determines whether the current time falls within an activity's configured window.
 * Used by both server (alert gating) and client (indicator rendering).
 */

// --- Timezone-aware date parts ---

function getLocalParts(now: Date, timezone: string) {
  const str = now.toLocaleString('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  // Parse "Mon, 06/15/2026, 14:30" style output
  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  const parts = str.split(', ');
  const weekdayStr = parts[0];
  const datePart = parts[1]; // MM/DD/YYYY
  const timePart = parts[2]; // HH:MM

  const [monthStr, dayStr] = datePart.split('/');
  const month = parseInt(monthStr, 10); // 1-12
  const day = parseInt(dayStr, 10); // 1-31
  const hour = parseInt(timePart.split(':')[0], 10); // 0-23
  const dayOfWeek = weekdayMap[weekdayStr] ?? 1; // 1=Mon, 7=Sun

  return { hour, dayOfWeek, day, month };
}

// --- Range check with wrap-around ---

/**
 * Check if `value` is in [start, end] with wrap-around modulo.
 * Range is inclusive on both ends.
 * Examples (mod=24): inRange(22, 18, 6) -> true (wraps midnight)
 *                    inRange(10, 18, 6) -> false
 */
export function inRange(value: number, start: number, end: number): boolean {
  if (start <= end) {
    return value >= start && value <= end;
  }
  // Wraps around: e.g. 22-6 means 22,23,0,1,2,3,4,5,6
  return value >= start || value <= end;
}

// --- Category config ---

interface CategoryConfig {
  extract: (parts: ReturnType<typeof getLocalParts>) => number;
  minVal: number;
  maxVal: number;
}

const CATEGORY_CONFIG: Record<string, CategoryConfig> = {
  daily_practice: { extract: (p) => p.hour, minVal: 0, maxVal: 23 },
  weekly_ritual: { extract: (p) => p.dayOfWeek, minVal: 1, maxVal: 7 },
  monthly_renewal: { extract: (p) => p.day, minVal: 1, maxVal: 28 },
  quarterly_reset: {
    extract: (p) => ((p.month - 1) % 3) + 1, // 1-3 within quarter
    minVal: 1,
    maxVal: 3,
  },
  annual_checkup: { extract: (p) => p.month, minVal: 1, maxVal: 12 },
};

// --- Core: isInWindow ---

/**
 * Determine whether `now` falls inside the activity's configured window.
 * Returns false if either windowStart or windowEnd is null (no window = no indicator).
 */
export function isInWindow(
  category: string,
  windowStart: number | null,
  windowEnd: number | null,
  now: Date,
  timezone: string,
): boolean {
  if (windowStart == null || windowEnd == null) return false;

  const config = CATEGORY_CONFIG[category];
  if (!config) return false;

  const parts = getLocalParts(now, timezone);
  const current = config.extract(parts);
  return inRange(current, windowStart, windowEnd);
}

// --- Validation ---

export function validateWindow(
  category: string,
  windowStart: number | null,
  windowEnd: number | null,
): { valid: boolean; error?: string } {
  if (windowStart == null && windowEnd == null) return { valid: true };
  if (windowStart == null || windowEnd == null) {
    return { valid: false, error: 'Both window_start and window_end must be set or both null' };
  }

  const config = CATEGORY_CONFIG[category];
  if (!config) return { valid: false, error: `Unknown category: ${category}` };

  const { minVal, maxVal } = config;
  if (windowStart < minVal || windowStart > maxVal) {
    return { valid: false, error: `window_start must be ${minVal}--${maxVal} for ${category}` };
  }
  if (windowEnd < minVal || windowEnd > maxVal) {
    return { valid: false, error: `window_end must be ${minVal}--${maxVal} for ${category}` };
  }

  return { valid: true };
}

// --- Display labels ---

export function formatHour(h: number): string {
  if (h === 0) return '12:00 AM';
  if (h === 12) return '12:00 PM';
  if (h < 12) return `${h}:00 AM`;
  return `${h - 12}:00 PM`;
}

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function getWindowLabel(category: string, windowStart: number, windowEnd: number): string {
  switch (category) {
    case 'daily_practice':
      return `${formatHour(windowStart)} – ${formatHour(windowEnd)}`;
    case 'weekly_ritual':
      return `${DAY_NAMES[windowStart] ?? windowStart} – ${DAY_NAMES[windowEnd] ?? windowEnd}`;
    case 'monthly_renewal':
      return `Day ${windowStart} – Day ${windowEnd}`;
    case 'quarterly_reset':
      return `Month ${windowStart} – Month ${windowEnd}`;
    case 'annual_checkup':
      return `${MONTH_NAMES[windowStart] ?? windowStart} – ${MONTH_NAMES[windowEnd] ?? windowEnd}`;
    default:
      return `${windowStart} – ${windowEnd}`;
  }
}
