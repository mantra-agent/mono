export const PLAN_REVIEW_DECISIONS = [
  "approve",
  "request_changes",
  "retry",
  "stop",
] as const;

export type PlanReviewDecision = (typeof PLAN_REVIEW_DECISIONS)[number];

export const PLAN_REVIEW_REASON_MAX_LENGTH = 2_000;
// The scannable ask (`prompt`) stays short; supporting detail can be longer
// but is still bounded so the review card never becomes an unbounded essay.
export const PLAN_REVIEW_DETAIL_MAX_LENGTH = 4_000;

export function isPlanReviewDecision(value: unknown): value is PlanReviewDecision {
  return typeof value === "string" && PLAN_REVIEW_DECISIONS.includes(value as PlanReviewDecision);
}
