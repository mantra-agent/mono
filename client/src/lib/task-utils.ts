import type { Task, TaskStatus, ProjectStatus } from "@shared/models/work";

export const STATUS_CONFIG: Record<TaskStatus, { label: string; className: string }> = {
  on_hold: { label: "On Hold", className: "bg-muted text-muted-foreground" },
  ready: { label: "Ready", className: "bg-warning/15 text-warning-foreground" },
  active: { label: "Active", className: "bg-info/15 text-info-foreground dark:text-info" },
  done: { label: "Done", className: "bg-success/15 text-success-foreground" },
};

export const PROJECT_STATUS_CONFIG: Record<ProjectStatus, { label: string; className: string }> = {
  idea: { label: "Idea", className: "bg-muted text-muted-foreground" },
  planning: { label: "Planning", className: "bg-muted text-muted-foreground" },
  active: { label: "Active", className: "bg-info/15 text-info-foreground dark:text-info" },
  on_hold: { label: "On Hold", className: "bg-warning/15 text-warning-foreground" },
  completed: { label: "Done", className: "bg-success/15 text-success-foreground" },
};

const SORT_RANK: Record<string, number> = { high: 0, mid: 1, low: 2 };
const EFFORT_SORT_RANK: Record<string, number> = { low: 0, mid: 1, high: 2 };

function getDeadlineSortValue(deadline: string | null): number {
  if (!deadline) return Infinity;
  return new Date(deadline + 'T23:59:59').getTime();
}

export function sortTasksByAttributes(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pA = SORT_RANK[a.priority] ?? 1;
    const pB = SORT_RANK[b.priority] ?? 1;
    if (pA !== pB) return pA - pB;
    const dlA = getDeadlineSortValue(a.deadline);
    const dlB = getDeadlineSortValue(b.deadline);
    if (dlA !== dlB) return dlA - dlB;
    const iA = SORT_RANK[a.impact as string] ?? 1;
    const iB = SORT_RANK[b.impact as string] ?? 1;
    if (iA !== iB) return iA - iB;
    const eA = EFFORT_SORT_RANK[a.effort as string] ?? 1;
    const eB = EFFORT_SORT_RANK[b.effort as string] ?? 1;
    return eA - eB;
  });
}

export function cycleTaskStatus(current: TaskStatus): TaskStatus {
  const order: TaskStatus[] = ["on_hold", "ready", "active", "done"];
  const idx = order.indexOf(current);
  return order[(idx + 1) % order.length];
}

export interface GroupedTasks {
  active: Task[];
  ready: Task[];
  on_hold: Task[];
  done: Task[];
}

export function groupTasksByStatus(tasks: Task[]): GroupedTasks {
  return {
    active: sortTasksByAttributes(tasks.filter(t => t.status === "active")),
    ready: sortTasksByAttributes(tasks.filter(t => t.status === "ready")),
    on_hold: sortTasksByAttributes(tasks.filter(t => t.status === "on_hold")),
    done: tasks.filter(t => t.status === "done"),
  };
}
