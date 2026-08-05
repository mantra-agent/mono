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

export type AdvantageStandingOperatingObjectiveDefinition = Omit<
  AdvantageStandingOperatingObjective,
  "health"
>;

/**
 * Canonical Business Advantage standing objectives.
 *
 * Metrics/KPI defaults consume this catalog directly so the eight cards and
 * their seeded definitions cannot drift into parallel, invented taxonomies.
 */
export const ADVANTAGE_STANDING_OBJECTIVES = [
  {
    key: "trust-security",
    label: "Trust and security",
    owner: "Security",
    cadence: "Continuous",
    definition:
      "Zero severity-1 privacy/security incidents, zero wrong-person mutations, and full audit coverage on consequential actions.",
  },
  {
    key: "reliability-performance",
    label: "Reliability and performance",
    owner: "Platform",
    cadence: "Daily",
    definition:
      "Customer-facing availability, action success rate, and median recovery time stay inside the operating band.",
  },
  {
    key: "customer-health",
    label: "Customer health and support",
    owner: "Customer success",
    cadence: "Weekly",
    definition:
      "Active paying accounts, weekly active accounts, and open customer blockers stay healthy enough to support retention evidence.",
  },
  {
    key: "revenue-runway",
    label: "Revenue, cash, and runway",
    owner: "Finance",
    cadence: "Monthly",
    definition:
      "Product ARR, cash runway against the funded plan, and cleared Seed financing remain on the operating path.",
  },
  {
    key: "delivery-economics",
    label: "Delivery economics",
    owner: "Operations",
    cadence: "Weekly",
    definition:
      "Human hours and platform cost per account decline as workflow reuse rises.",
  },
  {
    key: "product-release",
    label: "Product and release health",
    owner: "Engineering",
    cadence: "Per deploy",
    definition:
      "Production deploys stay healthy, critical defects stay controlled, and completed work links to the thematic goal or defining objectives.",
  },
  {
    key: "founder-team",
    label: "Founder and team capacity",
    owner: "Ray",
    cadence: "Weekly",
    definition:
      "Ray time stays majority judgment/GTM, sole-owner domains decline, and Founding Engineer status advances.",
  },
  {
    key: "corporate-stewardship",
    label: "Corporate stewardship",
    owner: "Operations",
    cadence: "Weekly",
    definition:
      "Legal, tax, payroll, insurance, contracts, and investor actions stay current with zero overdue obligations.",
  },
] as const satisfies readonly AdvantageStandingOperatingObjectiveDefinition[];

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
