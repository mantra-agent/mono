import type { GoalStatus } from "./goals";

export type ScorecardMeasureState =
  | {
      kind: "measured";
      value: number;
      unit: string;
      observedAt: string;
      sourceRef: string;
    }
  | {
      kind: "unmeasured";
      instrumentationOwner: string;
    }
  | {
      kind: "stale";
      value: number;
      unit: string;
      observedAt: string;
      sourceRef: string;
      instrumentationOwner: string;
    }
  | {
      kind: "unavailable";
      reason: string;
      instrumentationOwner: string;
    }
  | {
      kind: "error";
      message: string;
      instrumentationOwner: string;
    };

export interface ScorecardMeasureDefinition {
  key: string;
  label: string;
  target: string;
  cadence: string;
  definition: string;
  state: ScorecardMeasureState;
}

export interface AdvantageObjectiveDefinition {
  goalId: string;
  owner: string;
  nextEvidence: string;
  measures: ScorecardMeasureDefinition[];
}

export interface AdvantageHealthDomainDefinition {
  key: string;
  label: string;
  instrumentationOwner: string;
  measures: ScorecardMeasureDefinition[];
}

export interface AdvantageOperatingCycle {
  key: string;
  organizationKey: string;
  periodLabel: string;
  startsOn: string;
  endsOn: string;
  thematicGoalId: string;
  sourcePageId: string;
  confidence: "low" | "medium" | "high";
  strategicJudgment: string;
  objectives: AdvantageObjectiveDefinition[];
  healthDomains: AdvantageHealthDomainDefinition[];
}

export interface AdvantageGoalProjection {
  id: string;
  shortName: string;
  description: string;
  parentId: string | null;
  status: GoalStatus;
  updatedAt?: string;
}
