export const RESOURCES_REFRESH_INTERVAL_MS = 2000;
export const FRONTEND_EXPERIENCE_REFRESH_INTERVAL_MS = 30_000;
export const CONTEXT_HEALTH_REFRESH_INTERVAL_MS = 30_000;
export const RESOURCES_STALE_AFTER_MS = 5000;

export const RESOURCES_THRESHOLDS = {
  dbWaitingAmber: 1,
  dbWaitingRed: 5,
  dbSaturatedRedMs: 10_000,
  inFlightAmberMultiplier: 0.7,
  zombieAmber: 1,
  zombieRed: 6,
  eventLoopAmberMs: 100,
  eventLoopRedMs: 500,
  slowQueryAmberPerMin: 1,
  slowQueryRedPerMin: 5,
  divergenceAmber: 1,
  divergenceRed: 3,
  admissionQueueAmber: 1,
  admissionQueueRed: 6,
} as const;
