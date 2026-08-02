export const PLAN_REVIEW_DECISIONS = [
  "approve",
  "request_changes",
  "retry",
  "stop",
] as const;

export type PlanReviewDecision = (typeof PLAN_REVIEW_DECISIONS)[number];

export const PLAN_REVIEW_REASON_MAX_LENGTH = 2_000;

export function isPlanReviewDecision(value: unknown): value is PlanReviewDecision {
  return typeof value === "string" && PLAN_REVIEW_DECISIONS.includes(value as PlanReviewDecision);
}
