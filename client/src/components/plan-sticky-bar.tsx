/**
 * PlanStickyBar — sticky chat container for the shared plan widget.
 */
import { PlanWidget, type PlanWidgetPlan } from "@/components/plan-widget";

interface PlanStickyBarProps {
  plan: PlanWidgetPlan;
  sessionId?: string;
}

export function PlanStickyBar({ plan, sessionId }: PlanStickyBarProps) {
  return <PlanWidget plan={plan} variant="sticky" sessionId={sessionId} />;
}
