import { WorkflowWidget } from "@/components/workflow-widget";
import type { WorkflowWidgetRun } from "@/components/workflow-shared";
import type { SessionStreamMap } from "@/hooks/use-session-subscription";

export interface WorkflowStickyBarProps {
  workflow: WorkflowWidgetRun;
  sessionId?: string;
  sessionTitleById?: Record<string, string>;
  sessionStreams?: SessionStreamMap;
}

export function WorkflowStickyBar({
  workflow,
  sessionId,
  sessionTitleById,
  sessionStreams,
}: WorkflowStickyBarProps) {
  return (
    <WorkflowWidget
      workflow={workflow}
      sessionId={sessionId}
      sessionTitleById={sessionTitleById}
      sessionStreams={sessionStreams}
      className="shrink-0 border-b border-border/20 px-4 py-2"
    />
  );
}
