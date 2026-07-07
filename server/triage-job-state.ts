export interface TriageJobState {
  status: "idle" | "running" | "completed" | "error";
  processed: number;
  total: number;
  triaged: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  workersInFlight: number;
  avgPerEmailMs: number;
  remaining: number;
  passes: number;
  lastTriageError: { message: string; timestamp: number } | null;
}

export const triageJob: TriageJobState = {
  status: "idle",
  processed: 0,
  total: 0,
  triaged: 0,
  startedAt: null,
  completedAt: null,
  error: null,
  workersInFlight: 0,
  avgPerEmailMs: 0,
  remaining: 0,
  passes: 0,
  lastTriageError: null,
};
