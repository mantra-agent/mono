import type {
  AdvantageOperatingCycle,
  ScorecardMeasureDefinition,
  ScorecardMeasureState,
} from "@shared/models/advantage-dashboard";

function unmeasured(
  key: string,
  label: string,
  target: string,
  cadence: string,
  definition: string,
  instrumentationOwner: string,
): ScorecardMeasureDefinition {
  return {
    key,
    label,
    target,
    cadence,
    definition,
    state: { kind: "unmeasured", instrumentationOwner },
  };
}

function unmeasuredHealth(instrumentationOwner: string): ScorecardMeasureState {
  return { kind: "unmeasured", instrumentationOwner };
}

const sourcePageId = "cd29a16a-7594-4392-abd5-8859db908acb";

export const MANTRA_Q3_2026_ADVANTAGE_CYCLE: AdvantageOperatingCycle = {
  key: "mantra-2026-q3",
  organizationKey: "mantra",
  label: "Q3 2026",
  periodLabel: "Q3 2026",
  startsOn: "2026-07-01",
  endsOn: "2026-09-30",
  thematicGoalId: "80215d57",
  thematicGoalStatement:
    "Prove Generalizable Value Beyond Ray — paid, retained external value before capability breadth substitutes for customer evidence.",
  sourcePageId,
  confidence: "high",
  strategicJudgment:
    "Prove paid, retained value beyond Ray before capability breadth becomes a substitute for customer evidence.",
  definingObjectives: [
    {
      key: "funding-stability",
      projectId: 33,
      owner: "Ray",
      nextEvidence: "Signed financing documents and cleared capital.",
      measures: [
        unmeasured(
          "cleared-capital",
          "Cleared capital",
          "$1M Seed",
          "On change",
          "Signed and cleared Seed financing.",
          "Finance",
        ),
        unmeasured(
          "operating-envelope",
          "Operating envelope",
          "18 months approved",
          "On change",
          "Runway and spending gates recorded in the financial model.",
          "Finance",
        ),
      ],
    },
    {
      key: "external-loops",
      projectId: 50,
      owner: "Mantra · Ray accepts",
      nextEvidence: "A clean external goal-to-execution loop.",
      measures: [
        unmeasured(
          "clean-external-loops",
          "Clean external loops",
          "5 consecutive",
          "Per loop",
          "External goal-to-execution loops completed without trust failure.",
          "Platform",
        ),
        unmeasured(
          "seven-day-onboarding",
          "7-day onboarding",
          "8 of 10 accounts",
          "Weekly",
          "Qualified accounts completing onboarding within seven days.",
          "Product",
        ),
        unmeasured(
          "fourteen-day-execution",
          "14-day first loop",
          "6 of 10 accounts",
          "Weekly",
          "Qualified accounts completing a first execution loop within fourteen days.",
          "Product",
        ),
      ],
    },
    {
      key: "paid-retention",
      projectId: 32,
      owner: "Ray · Mantra instruments",
      nextEvidence: "The first external account begins a third weekly cycle.",
      measures: [
        unmeasured(
          "paying-attempts",
          "Paying-account attempts",
          "10 qualified",
          "Weekly",
          "Qualified external accounts asked to pay under the current offer.",
          "GTM",
        ),
        unmeasured(
          "d30-retained",
          "D30 retained",
          "5 accounts",
          "Weekly",
          "Paying accounts active thirty days after activation.",
          "Product",
        ),
        unmeasured(
          "standalone-max",
          "Standalone Max",
          "1 at $500/month",
          "On change",
          "A non-consulting Max subscription at the modeled price.",
          "Finance",
        ),
        unmeasured(
          "reviewed-actions",
          "Reviewed actions",
          "100 across cohort",
          "Weekly",
          "External cohort actions reviewed by their owner.",
          "Platform",
        ),
      ],
    },
    {
      key: "gtm-motion",
      projectId: 42,
      owner: "Ray · Mantra",
      nextEvidence: "One entry motion produces comparable payment and retention evidence.",
      measures: [
        unmeasured(
          "motion-tests",
          "Eligible motion tests",
          "Each run or killed",
          "Biweekly",
          "Direct, coach-assisted, and team cells meet their minimum test or fail an explicit gate.",
          "GTM",
        ),
        unmeasured(
          "leading-motion",
          "Leading motion",
          "Selected by Sep 30",
          "Monthly",
          "One provisional leader selected from observed evidence.",
          "GTM",
        ),
        unmeasured(
          "non-ray-signal",
          "Non-Ray expansion signal",
          "At least 1",
          "Weekly",
          "Referral, recipient activation, seat attach, or account advancement not driven by Ray.",
          "GTM",
        ),
      ],
    },
    {
      key: "leverage-cost",
      projectId: 41,
      owner: "Mantra · Founding Engineer",
      nextEvidence: "Account-level human and platform costs begin recording.",
      measures: [
        unmeasured(
          "human-hours",
          "Human hours per account",
          "Captured for every account",
          "Weekly",
          "Onboarding, support, and intervention hours by active account.",
          "Operations",
        ),
        unmeasured(
          "workflow-hours",
          "Repeated-workflow hours",
          "30% decline",
          "Monthly",
          "Human hours for the top repeated workflow versus first-account baseline.",
          "Operations",
        ),
        unmeasured(
          "reusable-workflows",
          "Reusable workflows",
          "Top 2–3",
          "Monthly",
          "Retained workflows converted from account-specific delivery into product behavior.",
          "Product",
        ),
        unmeasured(
          "ray-company-time",
          "Ray company time",
          "≥50% judgment/GTM",
          "Weekly",
          "Share of company time spent on product judgment, customer learning, GTM, narrative, and key relationships.",
          "Ray",
        ),
      ],
    },
  ],
  standingOperatingObjectives: [
    {
      key: "trust-security",
      label: "Trust and security",
      owner: "Security",
      cadence: "Continuous",
      definition:
        "Zero severity-1 privacy/security incidents, zero wrong-person mutations, and full audit coverage on consequential actions.",
      health: unmeasuredHealth("Security"),
    },
    {
      key: "reliability-performance",
      label: "Reliability and performance",
      owner: "Platform",
      cadence: "Daily",
      definition:
        "Customer-facing availability, action success rate, and median recovery time stay inside the operating band.",
      health: unmeasuredHealth("Platform"),
    },
    {
      key: "customer-health",
      label: "Customer health and support",
      owner: "Customer success",
      cadence: "Weekly",
      definition:
        "Active paying accounts, weekly active accounts, and open customer blockers stay healthy enough to support retention evidence.",
      health: unmeasuredHealth("Customer success"),
    },
    {
      key: "revenue-runway",
      label: "Revenue, cash, and runway",
      owner: "Finance",
      cadence: "Monthly",
      definition:
        "Product ARR, cash runway against the funded plan, and cleared Seed financing remain on the operating path.",
      health: unmeasuredHealth("Finance"),
    },
    {
      key: "delivery-economics",
      label: "Delivery economics",
      owner: "Operations",
      cadence: "Weekly",
      definition:
        "Human hours and platform cost per account decline as workflow reuse rises.",
      health: unmeasuredHealth("Operations"),
    },
    {
      key: "product-release",
      label: "Product and release health",
      owner: "Engineering",
      cadence: "Per deploy",
      definition:
        "Production deploys stay healthy, critical defects stay controlled, and completed work links to the thematic goal or defining objectives.",
      health: unmeasuredHealth("Engineering"),
    },
    {
      key: "founder-team",
      label: "Founder and team capacity",
      owner: "Ray",
      cadence: "Weekly",
      definition:
        "Ray time stays majority judgment/GTM, sole-owner domains decline, and Founding Engineer status advances.",
      health: unmeasuredHealth("Ray"),
    },
    {
      key: "corporate-stewardship",
      label: "Corporate stewardship",
      owner: "Operations",
      cadence: "Weekly",
      definition:
        "Legal, tax, payroll, insurance, contracts, and investor actions stay current with zero overdue obligations.",
      health: unmeasuredHealth("Operations"),
    },
  ],
};

export type { AdvantageOperatingCycle };
