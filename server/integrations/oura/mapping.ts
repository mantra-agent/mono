import type { InsertHealthMetric } from "@shared/models/health";
import type {
  OuraDailyActivity,
  OuraDailyReadiness,
  OuraDailySleep,
  OuraHeartRateSample,
  OuraSession,
  OuraSleepSession,
  OuraWorkout,
} from "./types";

const OURA_SOURCE = "oura";
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

type MaybeMetric = InsertHealthMetric | null | undefined;

function finiteMetric(metricType: string, value: unknown, unit: string, date: string | undefined | null): MaybeMetric {
  if (!date) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return {
    metricType,
    value: Math.round(numeric * 1000) / 1000,
    unit,
    source: OURA_SOURCE,
    date: date.substring(0, 10),
  };
}

function durationHours(metricType: string, seconds: unknown, date: string | undefined | null): MaybeMetric {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric)) return null;
  return finiteMetric(metricType, numeric / SECONDS_PER_HOUR, "hr", date);
}

function durationMinutes(metricType: string, seconds: unknown, date: string | undefined | null): MaybeMetric {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric)) return null;
  return finiteMetric(metricType, numeric / SECONDS_PER_MINUTE, "min", date);
}

function workoutDurationMinutes(workout: OuraWorkout): MaybeMetric {
  if (!workout.start_datetime || !workout.end_datetime) return null;
  const start = Date.parse(workout.start_datetime);
  const end = Date.parse(workout.end_datetime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return finiteMetric("workout_minutes", (end - start) / 60000, "min", workout.day);
}

function sessionDurationMinutes(session: OuraSession): MaybeMetric {
  if (!session.start_datetime || !session.end_datetime) return null;
  const start = Date.parse(session.start_datetime);
  const end = Date.parse(session.end_datetime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return finiteMetric("session_minutes", (end - start) / 60000, "min", session.day);
}

function compact(rows: MaybeMetric[]): InsertHealthMetric[] {
  return rows.filter((row): row is InsertHealthMetric => !!row);
}

export function mapOuraDailyReadiness(readiness: OuraDailyReadiness[]): InsertHealthMetric[] {
  const rows: MaybeMetric[] = [];
  for (const doc of readiness) {
    rows.push(
      finiteMetric("readiness_score", doc.score, "score", doc.day),
      finiteMetric("body_temperature_deviation", doc.temperature_deviation, "celsius", doc.day),
      finiteMetric("body_temperature_trend_deviation", doc.temperature_trend_deviation, "celsius", doc.day),
      finiteMetric("readiness_hrv_balance", doc.contributors?.hrv_balance, "score", doc.day),
      finiteMetric("readiness_recovery_index", doc.contributors?.recovery_index, "score", doc.day),
      finiteMetric("readiness_resting_heart_rate", doc.contributors?.resting_heart_rate, "score", doc.day),
      finiteMetric("readiness_sleep_balance", doc.contributors?.sleep_balance, "score", doc.day),
      finiteMetric("readiness_total_sleep", doc.contributors?.total_sleep, "score", doc.day),
    );
  }
  return compact(rows);
}

export function mapOuraDailySleep(dailySleep: OuraDailySleep[]): InsertHealthMetric[] {
  const rows: MaybeMetric[] = [];
  for (const doc of dailySleep) {
    rows.push(
      finiteMetric("sleep_score", doc.score, "score", doc.day),
      finiteMetric("sleep_balance", doc.contributors?.sleep_balance, "score", doc.day),
      finiteMetric("sleep_timing", doc.contributors?.timing, "score", doc.day),
      finiteMetric("sleep_efficiency_score", doc.contributors?.total_sleep, "score", doc.day),
    );
  }
  return compact(rows);
}

export function mapOuraSleepSessions(sessions: OuraSleepSession[]): InsertHealthMetric[] {
  const rows: MaybeMetric[] = [];
  for (const session of sessions) {
    rows.push(
      durationHours("sleep_total", session.total_sleep_duration, session.day),
      durationHours("sleep_awake", session.awake_time, session.day),
      durationHours("sleep_deep", session.deep_sleep_duration, session.day),
      durationHours("sleep_core", session.light_sleep_duration, session.day),
      durationHours("sleep_rem", session.rem_sleep_duration, session.day),
      finiteMetric("sleep_efficiency", session.efficiency, "percent", session.day),
    );
  }
  return compact(rows);
}

export function mapOuraDailyActivity(activity: OuraDailyActivity[]): InsertHealthMetric[] {
  const rows: MaybeMetric[] = [];
  for (const doc of activity) {
    rows.push(
      finiteMetric("activity_score", doc.score, "score", doc.day),
      finiteMetric("steps", doc.steps, "count", doc.day),
      finiteMetric("active_calories", doc.active_calories, "kcal", doc.day),
      finiteMetric("total_calories", doc.total_calories, "kcal", doc.day),
      finiteMetric("walking_distance", doc.equivalent_walking_distance, "m", doc.day),
      durationMinutes("high_activity_minutes", doc.high_activity_time, doc.day),
      durationMinutes("medium_activity_minutes", doc.medium_activity_time, doc.day),
      durationMinutes("low_activity_minutes", doc.low_activity_time, doc.day),
      durationMinutes("sedentary_minutes", doc.sedentary_time, doc.day),
      finiteMetric("activity_balance", doc.contributors?.activity_balance, "score", doc.day),
      finiteMetric("stay_active", doc.contributors?.stay_active, "score", doc.day),
    );
  }
  return compact(rows);
}

export function mapOuraWorkouts(workouts: OuraWorkout[]): InsertHealthMetric[] {
  const rows: MaybeMetric[] = [];
  for (const workout of workouts) {
    rows.push(
      finiteMetric("workout_calories", workout.calories, "kcal", workout.day),
      finiteMetric("workout_distance", workout.distance, "m", workout.day),
      workoutDurationMinutes(workout),
    );
  }
  return compact(rows);
}

export function mapOuraSessions(sessions: OuraSession[]): InsertHealthMetric[] {
  const rows: MaybeMetric[] = [];
  for (const session of sessions) {
    rows.push(
      sessionDurationMinutes(session),
      finiteMetric("session_heart_rate_avg", session.heart_rate?.average, "bpm", session.day),
      finiteMetric("session_heart_rate_max", session.heart_rate?.max, "bpm", session.day),
      finiteMetric("session_heart_rate_min", session.heart_rate?.min, "bpm", session.day),
    );
  }
  return compact(rows);
}

export function mapOuraHeartRate(samples: OuraHeartRateSample[]): InsertHealthMetric[] {
  const byDay = new Map<string, number[]>();
  for (const sample of samples) {
    const bpm = Number(sample.bpm);
    if (!Number.isFinite(bpm) || !sample.timestamp) continue;
    const day = sample.timestamp.substring(0, 10);
    const values = byDay.get(day) ?? [];
    values.push(bpm);
    byDay.set(day, values);
  }

  const rows: MaybeMetric[] = [];
  for (const [day, values] of byDay.entries()) {
    if (values.length === 0) continue;
    const sum = values.reduce((acc, value) => acc + value, 0);
    rows.push(
      finiteMetric("heart_rate_avg", sum / values.length, "bpm", day),
      finiteMetric("heart_rate_min", Math.min(...values), "bpm", day),
      finiteMetric("heart_rate_max", Math.max(...values), "bpm", day),
    );
  }
  return compact(rows);
}

export function mapOuraDocuments(input: {
  dailyReadiness?: OuraDailyReadiness[];
  dailySleep?: OuraDailySleep[];
  sleep?: OuraSleepSession[];
  dailyActivity?: OuraDailyActivity[];
  workouts?: OuraWorkout[];
  sessions?: OuraSession[];
  heartRate?: OuraHeartRateSample[];
}): InsertHealthMetric[] {
  return [
    ...mapOuraDailyReadiness(input.dailyReadiness ?? []),
    ...mapOuraDailySleep(input.dailySleep ?? []),
    ...mapOuraSleepSessions(input.sleep ?? []),
    ...mapOuraDailyActivity(input.dailyActivity ?? []),
    ...mapOuraWorkouts(input.workouts ?? []),
    ...mapOuraSessions(input.sessions ?? []),
    ...mapOuraHeartRate(input.heartRate ?? []),
  ];
}
