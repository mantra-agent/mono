import { createLogger } from "../log";

const log = createLogger("MemoryEnrichment");

export type { ClaimCandidate } from "./vnext-claim-extraction";

export interface MyelinationProgress {
  phase: string;
  current: number;
  total: number;
  detail?: string;
}

export interface MyelinationResult {
  summarized: number;
  embedded: number;
  linked: number;
  errors: string[];
  durationMs: number;
}

interface MyelinationStatus {
  running: boolean;
  phase: string;
  current: number;
  total: number;
  detail: string;
  result: MyelinationResult | null;
  error: string | null;
}

const LEGACY_MYELINATION_RETIRED_MESSAGE =
  "Legacy memory entry myelination is retired; use run_vnext_lifecycle or runFullSleepCycle for vNext claim maintenance.";

function retiredMyelinationResult(startedAt = Date.now()): MyelinationResult {
  return {
    summarized: 0,
    embedded: 0,
    linked: 0,
    errors: [LEGACY_MYELINATION_RETIRED_MESSAGE],
    durationMs: Date.now() - startedAt,
  };
}

const myelinationStatus: MyelinationStatus = {
  running: false,
  phase: "retired",
  current: 0,
  total: 0,
  detail: LEGACY_MYELINATION_RETIRED_MESSAGE,
  result: retiredMyelinationResult(),
  error: LEGACY_MYELINATION_RETIRED_MESSAGE,
};

export function getMyelinationStatus(): MyelinationStatus {
  return { ...myelinationStatus };
}

export function startMyelinationBackground(
  _phase: "all" | "summarize" | "embed" | "link" = "all",
): { alreadyRunning: false; retired: true } {
  log.warn(LEGACY_MYELINATION_RETIRED_MESSAGE);
  return { alreadyRunning: false, retired: true };
}

export async function runMemoryEnrichment(
  options: {
    phase?: "all" | "summarize" | "embed" | "link";
    batchSize?: number;
    onProgress?: (progress: MyelinationProgress) => void;
  } = {},
): Promise<MyelinationResult> {
  const startedAt = Date.now();
  log.warn(`${LEGACY_MYELINATION_RETIRED_MESSAGE} phase=${options.phase || "all"}`);
  options.onProgress?.({
    phase: "retired",
    current: 0,
    total: 0,
    detail: LEGACY_MYELINATION_RETIRED_MESSAGE,
  });
  return retiredMyelinationResult(startedAt);
}
