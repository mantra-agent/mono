export type PlanningCadence =
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "annual";

type PeriodDescriptor = {
  key: string;
  label: string;
  start: string;
  endExclusive: string;
};

export type ScheduledPlanPeriodContract = {
  planningMode: "review_current_plan_next";
  anchorAt: string;
  anchorSource: "timerRun.intendedFireAt" | "timerRun.startedAt";
  timezone: string;
  cadence: PlanningCadence;
  reviewPeriod: PeriodDescriptor;
  reviewHorizon: string;
  reviewPeriodField: string | null;
  targetPeriod: PeriodDescriptor;
  parentPeriod: PeriodDescriptor;
  targetHorizon: string;
  targetPeriodField: string | null;
  parentHorizon: string;
};

type CivilParts = {
  year: number;
  month: number;
  day: number;
};

const TARGET_HORIZON_BY_CADENCE: Record<PlanningCadence, string> = {
  daily: "today",
  weekly: "this_week",
  monthly: "this_month",
  quarterly: "this_quarter",
  annual: "this_year",
};

const TARGET_PERIOD_FIELD_BY_CADENCE: Record<
  PlanningCadence,
  string | null
> = {
  daily: "periodDate",
  weekly: "periodWeek",
  monthly: "periodMonth",
  quarterly: null,
  annual: null,
};

const PARENT_HORIZON_BY_CADENCE: Record<PlanningCadence, string> = {
  daily: "this_week",
  weekly: "this_month",
  monthly: "this_quarter",
  quarterly: "this_year",
  annual: "three_year",
};

function getCivilParts(instant: Date, timezone: string): CivilParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = Number(parts.find((part) => part.type === type)?.value);
    if (!Number.isInteger(value)) {
      throw new Error(`Could not resolve ${type} for planning period`);
    }
    return value;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
  };
}

function toUtcCivil(parts: CivilParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function formatCivil(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addCivilDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfIsoWeek(date: Date): Date {
  const dayFromMonday = (date.getUTCDay() + 6) % 7;
  return addCivilDays(date, -dayFromMonday);
}

function isoWeekKey(monday: Date): string {
  const thursday = addCivilDays(monday, 3);
  const weekYear = thursday.getUTCFullYear();
  const januaryFourth = new Date(Date.UTC(weekYear, 0, 4));
  const firstMonday = startOfIsoWeek(januaryFourth);
  const week =
    Math.floor((monday.getTime() - firstMonday.getTime()) / 604_800_000) + 1;
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

function dayPeriod(start: Date): PeriodDescriptor {
  const key = formatCivil(start);
  return {
    key,
    label: key,
    start: key,
    endExclusive: formatCivil(addCivilDays(start, 1)),
  };
}

function weekPeriod(start: Date): PeriodDescriptor {
  const monday = startOfIsoWeek(start);
  const key = isoWeekKey(monday);
  return {
    key,
    label: key,
    start: formatCivil(monday),
    endExclusive: formatCivil(addCivilDays(monday, 7)),
  };
}

function monthPeriod(year: number, zeroBasedMonth: number): PeriodDescriptor {
  const start = new Date(Date.UTC(year, zeroBasedMonth, 1));
  const end = new Date(Date.UTC(year, zeroBasedMonth + 1, 1));
  const resolvedYear = start.getUTCFullYear();
  const resolvedMonth = start.getUTCMonth();
  const key = `${resolvedYear}-${String(resolvedMonth + 1).padStart(2, "0")}`;
  return {
    key,
    label: new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "long",
      year: "numeric",
    }).format(start),
    start: formatCivil(start),
    endExclusive: formatCivil(end),
  };
}

function quarterPeriod(year: number, quarterIndex: number): PeriodDescriptor {
  const start = new Date(Date.UTC(year, quarterIndex * 3, 1));
  const resolvedYear = start.getUTCFullYear();
  const resolvedQuarter = Math.floor(start.getUTCMonth() / 3) + 1;
  return {
    key: `${resolvedYear}-Q${resolvedQuarter}`,
    label: `Q${resolvedQuarter} ${resolvedYear}`,
    start: formatCivil(start),
    endExclusive: formatCivil(
      new Date(Date.UTC(resolvedYear, resolvedQuarter * 3, 1)),
    ),
  };
}

function yearPeriod(year: number): PeriodDescriptor {
  return {
    key: String(year),
    label: String(year),
    start: `${year}-01-01`,
    endExclusive: `${year + 1}-01-01`,
  };
}

function threeYearPeriod(startYear: number): PeriodDescriptor {
  return {
    key: `${startYear}-${startYear + 2}`,
    label: `${startYear}–${startYear + 2}`,
    start: `${startYear}-01-01`,
    endExclusive: `${startYear + 3}-01-01`,
  };
}

function resolvePeriods(
  cadence: PlanningCadence,
  anchorCivil: Date,
): {
  reviewPeriod: PeriodDescriptor;
  targetPeriod: PeriodDescriptor;
  parentPeriod: PeriodDescriptor;
} {
  if (cadence === "daily") {
    const reviewPeriod = dayPeriod(anchorCivil);
    const targetPeriod = dayPeriod(addCivilDays(anchorCivil, 1));
    return {
      reviewPeriod,
      targetPeriod,
      parentPeriod: weekPeriod(new Date(`${targetPeriod.start}T00:00:00Z`)),
    };
  }

  if (cadence === "weekly") {
    const reviewStart = startOfIsoWeek(anchorCivil);
    const targetStart = addCivilDays(reviewStart, 7);
    return {
      reviewPeriod: weekPeriod(reviewStart),
      targetPeriod: weekPeriod(targetStart),
      parentPeriod: monthPeriod(
        targetStart.getUTCFullYear(),
        targetStart.getUTCMonth(),
      ),
    };
  }

  if (cadence === "monthly") {
    const year = anchorCivil.getUTCFullYear();
    const month = anchorCivil.getUTCMonth();
    const targetStart = new Date(Date.UTC(year, month + 1, 1));
    return {
      reviewPeriod: monthPeriod(year, month),
      targetPeriod: monthPeriod(year, month + 1),
      parentPeriod: quarterPeriod(
        targetStart.getUTCFullYear(),
        Math.floor(targetStart.getUTCMonth() / 3),
      ),
    };
  }

  if (cadence === "quarterly") {
    const year = anchorCivil.getUTCFullYear();
    const quarterIndex = Math.floor(anchorCivil.getUTCMonth() / 3);
    const targetStart = new Date(Date.UTC(year, (quarterIndex + 1) * 3, 1));
    return {
      reviewPeriod: quarterPeriod(year, quarterIndex),
      targetPeriod: quarterPeriod(year, quarterIndex + 1),
      parentPeriod: yearPeriod(targetStart.getUTCFullYear()),
    };
  }

  const year = anchorCivil.getUTCFullYear();
  return {
    reviewPeriod: yearPeriod(year),
    targetPeriod: yearPeriod(year + 1),
    parentPeriod: threeYearPeriod(year + 1),
  };
}

export function buildScheduledPlanPeriodContract(options: {
  cadence: PlanningCadence;
  anchorAt: string;
  anchorSource: ScheduledPlanPeriodContract["anchorSource"];
  timezone: string;
}): ScheduledPlanPeriodContract {
  const anchor = new Date(options.anchorAt);
  if (Number.isNaN(anchor.getTime())) {
    throw new Error("Scheduled Plan run is missing a valid time anchor");
  }
  const anchorCivil = toUtcCivil(getCivilParts(anchor, options.timezone));
  const periods = resolvePeriods(options.cadence, anchorCivil);
  return {
    planningMode: "review_current_plan_next",
    anchorAt: anchor.toISOString(),
    anchorSource: options.anchorSource,
    timezone: options.timezone,
    cadence: options.cadence,
    ...periods,
    reviewHorizon: TARGET_HORIZON_BY_CADENCE[options.cadence],
    reviewPeriodField: TARGET_PERIOD_FIELD_BY_CADENCE[options.cadence],
    targetHorizon: TARGET_HORIZON_BY_CADENCE[options.cadence],
    targetPeriodField: TARGET_PERIOD_FIELD_BY_CADENCE[options.cadence],
    parentHorizon: PARENT_HORIZON_BY_CADENCE[options.cadence],
  };
}

export function renderScheduledPlanPeriodContract(
  contract: ScheduledPlanPeriodContract,
): string {
  return [
    "# Parameterized Plan Request",
    `cadence: ${contract.cadence}`,
    `planningMode: ${contract.planningMode}`,
    `anchorAt: ${contract.anchorAt}`,
    `anchorSource: ${contract.anchorSource}`,
    `timezone: ${contract.timezone}`,
    `reviewPeriod: ${contract.reviewPeriod.key}`,
    `reviewLabel: ${contract.reviewPeriod.label}`,
    `reviewStart: ${contract.reviewPeriod.start}`,
    `reviewEndExclusive: ${contract.reviewPeriod.endExclusive}`,
    `reviewHorizon: ${contract.reviewHorizon}`,
    contract.reviewPeriodField
      ? `reviewPeriodField: ${contract.reviewPeriodField}`
      : undefined,
    `targetPeriod: ${contract.targetPeriod.key}`,
    `targetLabel: ${contract.targetPeriod.label}`,
    `targetStart: ${contract.targetPeriod.start}`,
    `targetEndExclusive: ${contract.targetPeriod.endExclusive}`,
    `targetHorizon: ${contract.targetHorizon}`,
    contract.targetPeriodField
      ? `targetPeriodField: ${contract.targetPeriodField}`
      : undefined,
    `parentHorizon: ${contract.parentHorizon}`,
    `parentPeriod: ${contract.parentPeriod.key}`,
    `parentLabel: ${contract.parentPeriod.label}`,
    `parentStart: ${contract.parentPeriod.start}`,
    `parentEndExclusive: ${contract.parentPeriod.endExclusive}`,
    `artifactPurpose: Scheduled ${contract.cadence} plan`,
    "surfacePolicy: always",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
