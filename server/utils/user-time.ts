import { getTimezone } from "../timezone";

export function userDateStr(date?: Date): string {
  const d = date ?? new Date();
  return d.toLocaleDateString("en-CA", { timeZone: getTimezone() });
}

function findUserMidnight(year: number, month: number, day: number): Date {
  const tz = getTimezone();
  let guess = new Date(Date.UTC(year, month - 1, day, 6, 0, 0, 0));
  for (let i = 0; i < 5; i++) {
    const parts = getUserParts(guess, tz);
    const guessDateStr = userDateStr(guess);
    const targetDateStr = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (guessDateStr === targetDateStr && parts.hour === 0 && parts.minute === 0 && parts.second === 0) {
      return guess;
    }
    const dateDiff = guessDateStr < targetDateStr ? 1 : guessDateStr > targetDateStr ? -1 : 0;
    const adjustMs = (dateDiff * 24 * 3600 - parts.hour * 3600 - parts.minute * 60 - parts.second) * 1000;
    if (adjustMs === 0 && guessDateStr !== targetDateStr) {
      guess = new Date(guess.getTime() + (dateDiff >= 0 ? 3600000 : -3600000));
    } else {
      guess = new Date(guess.getTime() + adjustMs);
    }
  }
  return guess;
}

export function userNoon(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const midnight = findUserMidnight(year, month, day);
  return new Date(midnight.getTime() + 12 * 3600 * 1000);
}

export function userDayBounds(dateStr: string): { start: Date; end: Date } {
  const [year, month, day] = dateStr.split("-").map(Number);
  const start = findUserMidnight(year, month, day);

  const nextDay = new Date(year, month - 1, day + 1);
  const nextStart = findUserMidnight(nextDay.getFullYear(), nextDay.getMonth() + 1, nextDay.getDate());

  const end = new Date(nextStart.getTime() - 1);
  return { start, end };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function userWeekdayMonStart(now: Date): number {
  const tz = getTimezone();
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[weekday] ?? 0;
  return (dow + 6) % 7; // 0 = Mon, 6 = Sun
}

/**
 * Returns the [start, end] bounds (in real wall-clock UTC) of the *current period*
 * the activity belongs to, based on the user's local timezone. The bounds align
 * with `userDayBounds` so checking `log.completedAt >= start && <= end` matches
 * exactly which user-local day the log was written in.
 */
export function userPeriodBounds(category: string, now: Date = new Date()): { start: Date; end: Date } {
  const todayStr = userDateStr(now);
  const [y, m, d] = todayStr.split("-").map(Number);

  switch (category) {
    case "daily_practice":
      return userDayBounds(todayStr);

    case "weekly_ritual": {
      const dowMon = userWeekdayMonStart(now);
      const monday = new Date(Date.UTC(y, m - 1, d - dowMon));
      const sunday = new Date(Date.UTC(y, m - 1, d - dowMon + 6));
      const mondayStr = `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
      const sundayStr = `${sunday.getUTCFullYear()}-${pad2(sunday.getUTCMonth() + 1)}-${pad2(sunday.getUTCDate())}`;
      return { start: userDayBounds(mondayStr).start, end: userDayBounds(sundayStr).end };
    }

    case "monthly_renewal": {
      const firstStr = `${y}-${pad2(m)}-01`;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const lastStr = `${y}-${pad2(m)}-${pad2(lastDay)}`;
      return { start: userDayBounds(firstStr).start, end: userDayBounds(lastStr).end };
    }

    case "quarterly_reset": {
      const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
      const qEndMonth = qStartMonth + 2;
      const firstStr = `${y}-${pad2(qStartMonth)}-01`;
      const lastDay = new Date(Date.UTC(y, qEndMonth, 0)).getUTCDate();
      const lastStr = `${y}-${pad2(qEndMonth)}-${pad2(lastDay)}`;
      return { start: userDayBounds(firstStr).start, end: userDayBounds(lastStr).end };
    }

    case "annual_checkup": {
      return { start: userDayBounds(`${y}-01-01`).start, end: userDayBounds(`${y}-12-31`).end };
    }

    default:
      return userDayBounds(todayStr);
  }
}

function getUserParts(date: Date, tz: string): { hour: number; minute: number; second: number } {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).forEach(p => {
    parts[p.type] = p.value;
  });
  return {
    hour: parseInt(parts.hour === "24" ? "0" : parts.hour),
    minute: parseInt(parts.minute),
    second: parseInt(parts.second),
  };
}
