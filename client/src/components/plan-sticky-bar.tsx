/**
 * PlanStickyBar — sticky chat container for the shared plan widget.
 */
import { PlanWidget, type PlanWidgetPlan } from "@/components/plan-widget";

interface PlanStickyBarProps {
  plan: PlanWidgetPlan;
}

export function PlanStickyBar({ plan }: PlanStickyBarProps) {
  return <PlanWidget plan={plan} variant="sticky" />;
}
