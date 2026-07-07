import { WorkflowWidget } from "@/components/workflow-widget";
import type { WorkflowWidgetRun } from "@/components/workflow-shared";

export interface WorkflowStickyBarProps { workflow: WorkflowWidgetRun; }

export function WorkflowStickyBar({ workflow }: WorkflowStickyBarProps) { return <WorkflowWidget workflow={workflow} variant="sticky" />; }
