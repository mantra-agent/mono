import type { GoalStatus } from "./goals";

export type ScorecardMeasureState =
  | {
      kind: "measured";
      value: number;
      unit: string;
      observedAt: string;
      sourceRef: string;
      evidence?: string;
    }
  | {
      kind: "unmeasured";
      instrumentationOwner: string;
      evidence?: string;
    }
  | {
      kind: "stale";
      value: number;
      unit: string;
      observedAt: string;
      sourceRef: string;
      instrumentationOwner: string;
      evidence?: string;
    }
  | {
      kind: "unavailable";
      reason: string;
      instrumentationOwner: string;
      evidence?: string;
    }
  | {
      kind: "error";
      message: string;
      instrumentationOwner: string;
      evidence?: string;
    }
  | {
      kind: "on_track";
      evidence?: string;
      instrumentationOwner?: string;
    }
  | {
      kind: "at_risk";
      evidence?: string;
      instrumentationOwner?: string;
    }
  | {
      kind: "off_track";
      evidence?: string;
      instrumentationOwner?: string;
    }
  | {
      kind: "achieved";
      evidence?: string;
      instrumentationOwner?: string;
    }
  | {
      kind: "blocked";
      evidence?: string;
      instrumentationOwner?: string;
    };

export interface ScorecardMeasureDefinition {
  key: string;
  label: string;
  target: string;
  cadence: string;
  definition: string;
  state: ScorecardMeasureState;
}

export interface AdvantageDefiningObjective {
  /** Stable slot id for this initiative — parity with standing-objective slot keys, so a project can be assigned to a slot. */
  key: string;
  /** Project hand-picked into this initiative slot (assignable like a KPI's standingObjectiveKey). */
  projectId: number;
  owner: string;
  /** Fallback intent when the linked project has no description yet. */
  intent?: string;
  nextEvidence?: string;
  measures: ScorecardMeasureDefinition[];
}

export interface AdvantageStandingOperatingObjective {
  key: string;
  label: string;
  owner: string;
  cadence: string;
  definition: string;
  health: ScorecardMeasureState;
}

export interface AdvantageOperatingCycle {
  key: string;
  organizationKey: string;
  /** Display label for the operating cycle (e.g. "Q3 2026"). */
  label: string;
  periodLabel: string;
  startsOn: string;
  endsOn: string;
  thematicGoalId: string;
  /** Fallback thematic statement when the goal description is missing. */
  thematicGoalStatement?: string;
  sourcePageId: string;
  confidence: "low" | "medium" | "high";
  strategicJudgment: string;
  definingObjectives: AdvantageDefiningObjective[];
  standingOperatingObjectives: AdvantageStandingOperatingObjective[];
}

export interface AdvantageGoalProjection {
  id: string;
  shortName: string;
  description?: string;
  parentId?: string | null;
  status?: GoalStatus | string;
  horizon?: string;
  owner?: string;
  updatedAt?: string;
}

/** @deprecated Prefer AdvantageDefiningObjective */
export type AdvantageObjectiveDefinition = AdvantageDefiningObjective;

/** @deprecated Prefer AdvantageStandingOperatingObjective */
export interface AdvantageHealthDomainDefinition {
  key: string;
  label: string;
  instrumentationOwner: string;
  measures: ScorecardMeasureDefinition[];
}
