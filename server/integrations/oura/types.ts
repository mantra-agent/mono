export const OURA_PROVIDER = "oura" as const;

export type OuraScope =
  | "email"
  | "personal"
  | "daily"
  | "heartrate"
  | "workout"
  | "session"
  | "spo2"
  | "tag";

export type OuraDataset =
  | "daily_activity"
  | "daily_readiness"
  | "daily_sleep"
  | "daily_stress"
  | "daily_spo2"
  | "heart_rate"
  | "personal_info"
  | "session"
  | "sleep"
  | "workout";

export interface OuraTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  scope?: string;
}

export interface OuraTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface OuraPagedResponse<T> {
  data: T[];
  next_token?: string | null;
}

export interface OuraPersonalInfo {
  id: string;
  email?: string;
  age?: number;
  weight?: number;
  height?: number;
  biological_sex?: string;
}

export interface OuraContributors {
  activity_balance?: number;
  body_temperature?: number;
  hrv_balance?: number;
  previous_day_activity?: number;
  previous_night?: number;
  recovery_index?: number;
  resting_heart_rate?: number;
  sleep_balance?: number;
  stay_active?: number;
  timing?: number;
  total_sleep?: number;
}

export interface OuraDailyReadiness {
  id: string;
  day: string;
  score?: number | null;
  temperature_deviation?: number | null;
  temperature_trend_deviation?: number | null;
  contributors?: OuraContributors;
  timestamp?: string;
}

export interface OuraDailySleep {
  id: string;
  day: string;
  score?: number | null;
  contributors?: OuraContributors;
  timestamp?: string;
}

export interface OuraSleepSession {
  id: string;
  day: string;
  bedtime_start?: string;
  bedtime_end?: string;
  total_sleep_duration?: number | null;
  awake_time?: number | null;
  deep_sleep_duration?: number | null;
  light_sleep_duration?: number | null;
  rem_sleep_duration?: number | null;
  efficiency?: number | null;
  readiness?: OuraDailyReadiness | null;
}

export interface OuraDailyActivity {
  id: string;
  day: string;
  score?: number | null;
  steps?: number | null;
  active_calories?: number | null;
  total_calories?: number | null;
  equivalent_walking_distance?: number | null;
  high_activity_time?: number | null;
  medium_activity_time?: number | null;
  low_activity_time?: number | null;
  sedentary_time?: number | null;
  contributors?: OuraContributors;
  timestamp?: string;
}

export interface OuraHeartRateSample {
  bpm: number;
  source?: string;
  timestamp: string;
}

export interface OuraWorkout {
  id: string;
  day: string;
  activity?: string;
  calories?: number | null;
  distance?: number | null;
  intensity?: string | null;
  label?: string | null;
  source?: string | null;
  start_datetime?: string;
  end_datetime?: string;
}

export interface OuraSession {
  id: string;
  day: string;
  type?: string;
  start_datetime?: string;
  end_datetime?: string;
  mood?: string | null;
  heart_rate?: { average?: number | null; max?: number | null; min?: number | null } | null;
}


export type OuraWebhookOperation = "create" | "update" | "delete";

export type OuraWebhookDataType =
  | "tag"
  | "enhanced_tag"
  | "workout"
  | "session"
  | "sleep"
  | "daily_sleep"
  | "daily_readiness"
  | "daily_activity"
  | "daily_spo2"
  | "sleep_time"
  | "rest_mode_period"
  | "ring_configuration"
  | "daily_stress"
  | "daily_cardiovascular_age"
  | "daily_resilience"
  | "vo2_max"
  | "meal";

export interface OuraWebhookSubscriptionRequest {
  callback_url: string;
  verification_token: string;
  event_type: OuraWebhookOperation;
  data_type: OuraWebhookDataType;
}

export interface OuraWebhookSubscription {
  id: string;
  callback_url: string;
  event_type: OuraWebhookOperation;
  data_type: OuraWebhookDataType;
  expiration_time: string;
}

export interface OuraWebhookNotification {
  event_type?: OuraWebhookOperation;
  data_type?: OuraWebhookDataType;
  object_id?: string;
  user_id?: string;
  [key: string]: unknown;
}

export interface OuraRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  params?: Record<string, string | number | boolean | undefined | null>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
  retryOnRateLimit?: boolean;
}

export interface OuraCollectionFetchOptions<T> {
  accountId: string;
  path: string;
  params?: Record<string, string | number | boolean | undefined | null>;
  maxPages?: number;
  pageSize?: number;
  mapPage?: (items: unknown[]) => T[];
}
