/**
 * KPI sample compiler. Period × Samples → one queryMetric range.
 * Timezone is America/Chicago. Live is now − 5m → now.
 */

export const KPI_PERIODS = [
  "live",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "annually",
] as const;
export type KpiPeriod = (typeof KPI_PERIODS)[number];

export const KPI_STYLES = ["line", "heat"] as const;
export type KpiStyle = (typeof KPI_STYLES)[number];

export const KPI_DEFAULT_TIMEZONE = "America/Chicago";
export const KPI_MIN_SAMPLES = 1;
export const KPI_MAX_SAMPLES = 366;
export const KPI_LIVE_WINDOW_MS = 5 * 60 * 1000;

export const KPI_PERIOD_LABEL: Record<KpiPeriod, string> = {
  live: "Live",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annually",
};

export const METRIC_SAMPLE_SPAN_OPTIONS = [
  { id: "today", label: "Today", period: "daily" as const, samples: 1, range: "today" as const },
  { id: "last-24-hours", label: "Last 24 Hours", period: "hourly" as const, samples: 24, rangeHours: 24 },
  { id: "last-7-days", label: "Last 7 Days", period: "daily" as const, samples: 7, rangeHours: 24 * 7 },
  { id: "last-30-days", label: "Last 30 Days", period: "daily" as const, samples: 30, rangeHours: 24 * 30 },
  { id: "last-90-days", label: "Last 90 Days", period: "daily" as const, samples: 90, rangeHours: 24 * 90 },
  { id: "last-3-months", label: "Last 3 Months", period: "monthly" as const, samples: 3, rangeHours: 24 * 90 },
  { id: "last-4-quarters", label: "Last 4 Quarters", period: "quarterly" as const, samples: 4, rangeHours: 24 * 365 },
] as const;

export type MetricSampleSpanId = (typeof METRIC_SAMPLE_SPAN_OPTIONS)[number]["id"];

export const KPI_SAMPLE_PRESETS = METRIC_SAMPLE_SPAN_OPTIONS;

const CADENCE_TO_PERIOD: Record<string, KpiPeriod> = {
  live: "live",
  hourly: "hourly",
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
  quarterly: "quarterly",
  annually: "annually",
  yearly: "annually",
  year: "annually",
};

export function isKpiPeriod(value: unknown): value is KpiPeriod {
  return typeof value === "string" && (KPI_PERIODS as readonly string[]).includes(value);
}

export function isKpiStyle(value: unknown): value is KpiStyle {
  return typeof value === "string" && (KPI_STYLES as readonly string[]).includes(value);
}

export function periodFromCadence(cadence: string | null | undefined): KpiPeriod {
  const key = (cadence ?? "").trim().toLowerCase();
  return CADENCE_TO_PERIOD[key] ?? "weekly";
}

export function cadenceFromPeriod(period: KpiPeriod): string {
  return KPI_PERIOD_LABEL[period];
}

export function normalizeKpiSamples(period: KpiPeriod, samples: number): number {
  if (period === "live") return 1;
  if (!Number.isInteger(samples) || samples < KPI_MIN_SAMPLES || samples > KPI_MAX_SAMPLES) {
    throw Object.assign(new Error("samples must be an integer from 1 to 366"), { status: 400 });
  }
  return samples;
}

export function normalizeKpiPeriod(value: unknown, cadenceFallback?: string | null): KpiPeriod {
  if (isKpiPeriod(value)) return value;
  if (value == null || value === "") return periodFromCadence(cadenceFallback);
  throw Object.assign(new Error("period must be a closed KPI grain"), { status: 400 });
}

export function normalizeKpiStyle(value: unknown): KpiStyle {
  if (value == null || value === "") return "line";
  if (isKpiStyle(value)) return value;
  throw Object.assign(new Error("style must be line or heat"), { status: 400 });
}

export interface CompiledKpiSample {
  start: Date;
  end: Date;
  period: KpiPeriod;
  samples: number;
  latestBucketStart: Date;
  latestBucketEnd: Date;
}

function partsInZone(now: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

function zonedInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = partsInZone(new Date(guess), timeZone);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  return new Date(guess + (desired - actual));
}

function addDays(year: number, month: number, day: number, delta: number): {
  year: number;
  month: number;
  day: number;
} {
  const utc = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function weekdayMonday0(year: number, month: number, day: number): number {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function latestClosedBucket(
  period: Exclude<KpiPeriod, "live">,
  now: Date,
  timeZone: string,
): { start: Date; end: Date } {
  const local = partsInZone(now, timeZone);
  if (period === "hourly") {
    const end = zonedInstant(timeZone, local.year, local.month, local.day, local.hour, 0);
    const prev = addDays(local.year, local.month, local.day, local.hour === 0 ? -1 : 0);
    const startHour = local.hour === 0 ? 23 : local.hour - 1;
    const start = zonedInstant(timeZone, prev.year, prev.month, prev.day, startHour, 0);
    return { start, end };
  }
  if (period === "daily") {
    const end = zonedInstant(timeZone, local.year, local.month, local.day, 0, 0);
    const prev = addDays(local.year, local.month, local.day, -1);
    const start = zonedInstant(timeZone, prev.year, prev.month, prev.day, 0, 0);
    return { start, end };
  }
  if (period === "weekly") {
    const mondayOffset = weekdayMonday0(local.year, local.month, local.day);
    const thisMonday = addDays(local.year, local.month, local.day, -mondayOffset);
    const lastMonday = addDays(thisMonday.year, thisMonday.month, thisMonday.day, -7);
    return {
      start: zonedInstant(timeZone, lastMonday.year, lastMonday.month, lastMonday.day, 0, 0),
      end: zonedInstant(timeZone, thisMonday.year, thisMonday.month, thisMonday.day, 0, 0),
    };
  }
  if (period === "monthly") {
    const end = zonedInstant(timeZone, local.year, local.month, 1, 0, 0);
    const prev = addMonths(local.year, local.month, -1);
    const start = zonedInstant(timeZone, prev.year, prev.month, 1, 0, 0);
    return { start, end };
  }
  if (period === "quarterly") {
    const quarterStartMonth = Math.floor((local.month - 1) / 3) * 3 + 1;
    const end = zonedInstant(timeZone, local.year, quarterStartMonth, 1, 0, 0);
    const prev = addMonths(local.year, quarterStartMonth, -3);
    const start = zonedInstant(timeZone, prev.year, prev.month, 1, 0, 0);
    return { start, end };
  }
  const end = zonedInstant(timeZone, local.year, 1, 1, 0, 0);
  const start = zonedInstant(timeZone, local.year - 1, 1, 1, 0, 0);
  return { start, end };
}

function shiftBucket(
  period: Exclude<KpiPeriod, "live">,
  bucket: { start: Date; end: Date },
  delta: number,
  timeZone: string,
): { start: Date; end: Date } {
  if (delta === 0) return bucket;
  const startParts = partsInZone(bucket.start, timeZone);
  if (period === "hourly") {
    return {
      start: new Date(bucket.start.getTime() + delta * 60 * 60 * 1000),
      end: new Date(bucket.end.getTime() + delta * 60 * 60 * 1000),
    };
  }
  if (period === "daily") {
    const startDay = addDays(startParts.year, startParts.month, startParts.day, delta);
    const endDay = addDays(startDay.year, startDay.month, startDay.day, 1);
    return {
      start: zonedInstant(timeZone, startDay.year, startDay.month, startDay.day, 0, 0),
      end: zonedInstant(timeZone, endDay.year, endDay.month, endDay.day, 0, 0),
    };
  }
  if (period === "weekly") {
    const startDay = addDays(startParts.year, startParts.month, startParts.day, delta * 7);
    const endDay = addDays(startDay.year, startDay.month, startDay.day, 7);
    return {
      start: zonedInstant(timeZone, startDay.year, startDay.month, startDay.day, 0, 0),
      end: zonedInstant(timeZone, endDay.year, endDay.month, endDay.day, 0, 0),
    };
  }
  if (period === "monthly") {
    const startMonth = addMonths(startParts.year, startParts.month, delta);
    const endMonth = addMonths(startMonth.year, startMonth.month, 1);
    return {
      start: zonedInstant(timeZone, startMonth.year, startMonth.month, 1, 0, 0),
      end: zonedInstant(timeZone, endMonth.year, endMonth.month, 1, 0, 0),
    };
  }
  if (period === "quarterly") {
    const startMonth = addMonths(startParts.year, startParts.month, delta * 3);
    const endMonth = addMonths(startMonth.year, startMonth.month, 3);
    return {
      start: zonedInstant(timeZone, startMonth.year, startMonth.month, 1, 0, 0),
      end: zonedInstant(timeZone, endMonth.year, endMonth.month, 1, 0, 0),
    };
  }
  return {
    start: zonedInstant(timeZone, startParts.year + delta, 1, 1, 0, 0),
    end: zonedInstant(timeZone, startParts.year + delta + 1, 1, 1, 0, 0),
  };
}

export function compileKpiSample(
  period: KpiPeriod,
  samples: number,
  now: Date = new Date(),
  timeZone: string = KPI_DEFAULT_TIMEZONE,
): CompiledKpiSample {
  if (period === "live") {
    const end = now;
    const start = new Date(now.getTime() - KPI_LIVE_WINDOW_MS);
    return {
      start,
      end,
      period,
      samples: 1,
      latestBucketStart: start,
      latestBucketEnd: end,
    };
  }
  const count = normalizeKpiSamples(period, samples);
  const latest = latestClosedBucket(period, now, timeZone);
  const oldest = shiftBucket(period, latest, 1 - count, timeZone);
  return {
    start: oldest.start,
    end: latest.end,
    period,
    samples: count,
    latestBucketStart: latest.start,
    latestBucketEnd: latest.end,
  };
}

export function sampleBelongsToLatestBucket(
  sample: { observedAt: string; periodStart?: string | null; periodEnd?: string | null },
  compiled: CompiledKpiSample,
): boolean {
  if (compiled.period === "live") return true;
  const startMs = compiled.latestBucketStart.getTime();
  const endMs = compiled.latestBucketEnd.getTime();
  if (sample.periodStart) {
    const bucketStart = new Date(sample.periodStart).getTime();
    if (Number.isFinite(bucketStart)) return bucketStart >= startMs && bucketStart < endMs;
  }
  const observed = new Date(sample.observedAt).getTime();
  return Number.isFinite(observed) && observed >= startMs && observed < endMs;
}
