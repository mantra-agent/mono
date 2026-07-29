export const AGENT_WORK_DEADLINE_INSTRUCTION = [
  "Every milestone and task created during Agent planning must have a deliberate, real calendar date: set milestone `dueDate` and task `deadline`; never leave either null or omitted.",
  "Derive dates from known goal/project targets and dependency order. If no target exists, choose a sensible near-term date instead of omitting it: tasks default within the next 7 days and milestones within the next 30 days, sequenced so prerequisite work comes first.",
  "Use today only for work intended to finish today, never use a past date, and surface any target conflict rather than inventing an impossible schedule.",
].join(" ");
