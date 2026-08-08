const RUN_OWNERSHIP_SETTLEMENT_MS = 5_000;

interface ExecutorRunObservation {
  runId: string;
  startedAt: number;
  admitted: boolean;
  aborted?: boolean;
}

interface AdmissionSlotObservation {
  runId: string;
}

export interface RunDivergenceObservation {
  value: number;
  detail: string;
}

export function classifyRunDivergence({
  runs,
  slots,
  suspendedSlots,
  activeZombies,
  now = Date.now(),
}: {
  runs: ExecutorRunObservation[];
  slots: AdmissionSlotObservation[];
  suspendedSlots: AdmissionSlotObservation[];
  activeZombies: number;
  now?: number;
}): RunDivergenceObservation {
  const accountedRunIds = new Set([
    ...slots.map((slot) => slot.runId),
    ...suspendedSlots.map((slot) => slot.runId),
  ]);
  const unmatchedRuns = runs.filter((run) => run.admitted && !run.aborted && !accountedRunIds.has(run.runId));
  const persistentRuns = unmatchedRuns.filter((run) => now - run.startedAt >= RUN_OWNERSHIP_SETTLEMENT_MS);
  const settlingRuns = unmatchedRuns.filter((run) => now - run.startedAt < RUN_OWNERSHIP_SETTLEMENT_MS);
  const unattributedZombies = Math.max(0, activeZombies - runs.filter((run) => run.aborted).length);
  const value = persistentRuns.length + unattributedZombies;
  const detail: string[] = [];

  if (persistentRuns.length > 0) {
    detail.push(`${persistentRuns.length} persistent unowned run(s): ${persistentRuns.map((run) => `${run.runId} (${Math.round((now - run.startedAt) / 1000)}s)`).join(", ")}`);
  }
  if (unattributedZombies > 0) detail.push(`${unattributedZombies} unattributed zombie(s)`);
  if (settlingRuns.length > 0) {
    detail.push(`${settlingRuns.length} run(s) settling: ${settlingRuns.map((run) => run.runId).join(", ")}`);
  }

  return { value, detail: detail.length > 0 ? detail.join("; ") : "in sync" };
}
