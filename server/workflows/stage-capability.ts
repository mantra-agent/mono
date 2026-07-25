export const WORKFLOW_STAGE_ACTIONS = [
  "get_run",
  "complete_stage_attempt",
  "attach_artifact",
  "capture_publish_stage_evidence",
  "capture_acceptance_evidence",
  "capture_calibration_evidence",
] as const;

export type WorkflowStageAction = typeof WORKFLOW_STAGE_ACTIONS[number];

const WORKFLOW_STAGE_ACTION_SET = new Set<string>(WORKFLOW_STAGE_ACTIONS);

export function isWorkflowStageAction(action: string | undefined): action is WorkflowStageAction {
  return Boolean(action && WORKFLOW_STAGE_ACTION_SET.has(action));
}
