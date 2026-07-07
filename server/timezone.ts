// Use createLogger for logging ONLY
import { getSetting, setSetting } from "./system-settings";
import { createLogger } from "./log";

const log = createLogger("Timezone");

const SETTING_KEY = "user_timezone";
const DEFAULT_TIMEZONE = "America/New_York";

let cachedTimezone: string | null = null;

export async function readTimezoneFromDb(): Promise<string> {
  try {
    const stored = await getSetting<string>(SETTING_KEY);
    if (stored) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: stored });
        return stored;
      } catch {
        return DEFAULT_TIMEZONE;
      }
    }
  } catch (err) { log.warn("DB lookup failed", err); }
  return DEFAULT_TIMEZONE;
}

export async function writeTimezone(timezone: string): Promise<void> {
  await setSetting(SETTING_KEY, timezone);
  cachedTimezone = timezone;
  applyTimezone(timezone);
}

export function writeTimezoneToUserMd(timezone: string): void {
  writeTimezone(timezone).catch(err => {
    log.error("Failed to write timezone to DB:", err.message);
  });
}

export function getTimezone(): string {
  if (cachedTimezone) return cachedTimezone;
  return DEFAULT_TIMEZONE;
}

export function isUsingDefaultTimezone(): boolean {
  return cachedTimezone === null;
}

export function applyTimezone(tz: string): void {
  process.env.TZ = tz;
  cachedTimezone = tz;
}

export function invalidateTimezoneCache(): void {
  cachedTimezone = null;
}

export function getDateInTimezone(tz?: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz || getTimezone() });
}

export function getTzDateStr(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function getTzOffsetISO(tz: string): string {
  const now = new Date();
  const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = now.toLocaleString("en-US", { timeZone: tz });
  const diffMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  const sign = diffMs >= 0 ? "+" : "-";
  const absMins = Math.abs(Math.round(diffMs / 60000));
  const h = String(Math.floor(absMins / 60)).padStart(2, "0");
  const m = String(absMins % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

export function formatInTimezone(date: Date, options?: Intl.DateTimeFormatOptions): string {
  const tz = getTimezone();
  return date.toLocaleString("en-US", { ...options, timeZone: tz });
}

export function nowInTimezone(): Date {
  return new Date();
}

/**
 * Format a Date as `[YYYY-MM-DD HH:MM TZ]` in the user's configured timezone
 * for prepending onto LLM-facing message content. Uses 24-hour time and tries
 * the "shortGeneric" timeZoneName (e.g. `CT`, `ET`, `PT`); falls back to
 * "short" (e.g. `EST`/`EDT`) when the runtime returns something unhelpful
 * like `GMT+5` or an empty string.
 */
export function formatMessageTimestamp(date: Date): string {
  const tz = getTimezone();

  let datePart = date.toISOString().slice(0, 10);
  let timePart = date.toISOString().slice(11, 16);
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const get = (t: string) => parts.find(p => p.type === t)?.value || "";
    const y = get("year");
    const mo = get("month");
    const d = get("day");
    let h = get("hour");
    const mi = get("minute");
    if (h === "24") h = "00";
    if (y && mo && d) datePart = `${y}-${mo}-${d}`;
    if (h && mi) timePart = `${h}:${mi}`;
  } catch { /* keep ISO fallback */ }

  const looksUnhelpful = (z: string) =>
    !z || /^GMT([+\-]|$)/i.test(z) || /^UTC([+\-]|$)/i.test(z) || /^[+\-]\d/.test(z);

  let zonePart = "";
  try {
    const zoneFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortGeneric" });
    const z = zoneFmt.formatToParts(date).find(p => p.type === "timeZoneName")?.value || "";
    if (!looksUnhelpful(z)) zonePart = z;
  } catch { /* fall through */ }

  if (!zonePart) {
    try {
      const zoneFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" });
      const z = zoneFmt.formatToParts(date).find(p => p.type === "timeZoneName")?.value || "";
      if (z) zonePart = z;
    } catch { /* fall through */ }
  }

  if (!zonePart) zonePart = tz;

  return `[${datePart} ${timePart} ${zonePart}]`;
}

/**
 * Convenience helper for prefixing the in-flight user turn with a "now"
 * timestamp so the LLM sees a continuous, sorted timeline.
 */
export function nowMessageTimestamp(): string {
  return formatMessageTimestamp(new Date());
}

export function getLocalTimeString(): string {
  const tz = getTimezone();
  return new Date().toLocaleString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export async function initTimezone(): Promise<void> {
  const tz = await readTimezoneFromDb();
  applyTimezone(tz);
  log.log(`Initialized: ${tz}`);
}
