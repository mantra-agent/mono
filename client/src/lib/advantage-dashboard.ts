import type {
  AdvantageOperatingCycle,
  ScorecardMeasureDefinition,
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

const sourcePageId = "cd29a16a-7594-4392-abd5-8859db908acb";

export const MANTRA_Q3_2026_ADVANTAGE_CYCLE: AdvantageOperatingCycle = {
  key: "mantra-2026-q3",
  organizationKey: "mantra",
  periodLabel: "Q3 2026",
  startsOn: "2026-07-01",
  endsOn: "2026-09-30",
  thematicGoalId: "80215d57",
  sourcePageId,
  confidence: "high",
  strategicJudgment:
    "Prove paid, retained value beyond Ray before capability breadth becomes a substitute for customer evidence.",
  objectives: [
    {
      goalId: "0b7635c0",
      owner: "Ray",
      nextEvidence: "Signed financing documents and cleared capital.",
      measures: [
        unmeasured("cleared-capital", "Cleared capital", "$1M Seed", "On change", "Signed and cleared Seed financing.", "Finance"),
        unmeasured("operating-envelope", "Operating envelope", "18 months approved", "On change", "Runway and spending gates recorded in the financial model.", "Finance"),
      ],
    },
    {
      goalId: "9db73311",
      owner: "Mantra · Ray accepts",
      nextEvidence: "A clean external goal-to-execution loop.",
      measures: [
        unmeasured("clean-external-loops", "Clean external loops", "5 consecutive", "Per loop", "External goal-to-execution loops completed without trust failure.", "Platform"),
        unmeasured("seven-day-onboarding", "7-day onboarding", "8 of 10 accounts", "Weekly", "Qualified accounts completing onboarding within seven days.", "Product"),
        unmeasured("fourteen-day-execution", "14-day first loop", "6 of 10 accounts", "Weekly", "Qualified accounts completing a first execution loop within fourteen days.", "Product"),
      ],
    },
    {
      goalId: "27289016",
      owner: "Ray · Mantra instruments",
      nextEvidence: "The first external account begins a third weekly cycle.",
      measures: [
        unmeasured("paying-attempts", "Paying-account attempts", "10 qualified", "Weekly", "Qualified external accounts asked to pay under the current offer.", "GTM"),
        unmeasured("d30-retained", "D30 retained", "5 accounts", "Weekly", "Paying accounts active thirty days after activation.", "Product"),
        unmeasured("standalone-max", "Standalone Max", "1 at $500/month", "On change", "A non-consulting Max subscription at the modeled price.", "Finance"),
        unmeasured("reviewed-actions", "Reviewed actions", "100 across cohort", "Weekly", "External cohort actions reviewed by their owner.", "Platform"),
      ],
    },
    {
      goalId: "f367fd69",
      owner: "Ray · Mantra",
      nextEvidence: "One entry motion produces comparable payment and retention evidence.",
      measures: [
        unmeasured("motion-tests", "Eligible motion tests", "Each run or killed", "Biweekly", "Direct, coach-assisted, and team cells meet their minimum test or fail an explicit gate.", "GTM"),
        unmeasured("leading-motion", "Leading motion", "Selected by Sep 30", "Monthly", "One provisional leader selected from observed evidence.", "GTM"),
        unmeasured("non-ray-signal", "Non-Ray expansion signal", "At least 1", "Weekly", "Referral, recipient activation, seat attach, or account advancement not driven by Ray.", "GTM"),
      ],
    },
    {
      goalId: "5b5fdff1",
      owner: "Mantra · Founding Engineer",
      nextEvidence: "Account-level human and platform costs begin recording.",
      measures: [
        unmeasured("human-hours", "Human hours per account", "Captured for every account", "Weekly", "Onboarding, support, and intervention hours by active account.", "Operations"),
        unmeasured("workflow-hours", "Repeated-workflow hours", "30% decline", "Monthly", "Human hours for the top repeated workflow versus first-account baseline.", "Operations"),
        unmeasured("reusable-workflows", "Reusable workflows", "Top 2–3", "Monthly", "Retained workflows converted from account-specific delivery into product behavior.", "Product"),
        unmeasured("ray-company-time", "Ray company time", "≥50% judgment/GTM", "Weekly", "Share of company time spent on product judgment, customer learning, GTM, narrative, and key relationships.", "Ray"),
      ],
    },
  ],
  healthDomains: [
    {
      key: "trust-security",
      label: "Trust and security",
      instrumentationOwner: "Security",
      measures: [
        unmeasured("sev1-incidents", "Severity-1 incidents", "0", "Continuous", "Privacy or security incidents meeting the severity-1 threshold.", "Security"),
        unmeasured("wrong-person-mutations", "Wrong-person mutations", "0", "Continuous", "Consequential writes applied to the wrong Person or account.", "Platform"),
        unmeasured("consequential-audit", "Consequential action audit", "100%", "Weekly", "Consequential actions carrying review and provenance evidence.", "Security"),
      ],
    },
    {
      key: "reliability-performance",
      label: "Reliability and performance",
      instrumentationOwner: "Platform",
      measures: [
        unmeasured("availability", "Availability", "Target band not set", "Daily", "Availability of customer-facing workflows.", "Platform"),
        unmeasured("action-success", "Action success", "Target band not set", "Daily", "Successful user-facing actions divided by attempted actions.", "Platform"),
        unmeasured("recovery-time", "Median recovery time", "Target band not set", "Per incident", "Median time from critical failure detection to restored service.", "Platform"),
      ],
    },
    {
      key: "customer-health",
      label: "Customer health and support",
      instrumentationOwner: "Customer success",
      measures: [
        unmeasured("active-paying", "Active paying accounts", "Target band not set", "Weekly", "Paying accounts with qualifying activity in the current period.", "Finance"),
        unmeasured("weekly-active", "Weekly active accounts", "Target band not set", "Weekly", "Activated accounts completing consequential work this week.", "Product"),
        unmeasured("customer-blockers", "Open customer blockers", "Target band not set", "Daily", "Unresolved blockers preventing customer value.", "Customer success"),
      ],
    },
    {
      key: "revenue-runway",
      label: "Revenue, cash, and runway",
      instrumentationOwner: "Finance",
      measures: [
        unmeasured("product-arr", "Product ARR", "Phase gate not set", "Monthly", "Annualized recurring product revenue.", "Finance"),
        unmeasured("cash-runway", "Cash runway", "18-month funded plan", "Monthly", "Months before cash exhaustion at trailing planned burn.", "Finance"),
        unmeasured("cleared-financing", "Cleared financing", "$1M Seed", "On change", "Committed financing that has cleared into company accounts.", "Finance"),
      ],
    },
    {
      key: "delivery-economics",
      label: "Delivery economics",
      instrumentationOwner: "Operations",
      measures: [
        unmeasured("account-human-cost", "Human hours per account", "Declining", "Weekly", "Total human delivery hours per active account.", "Operations"),
        unmeasured("account-platform-cost", "Platform cost per account", "Target band not set", "Monthly", "Model and infrastructure cost attributable to an active account.", "Finance"),
        unmeasured("workflow-reuse", "Workflow reuse", "Target band not set", "Monthly", "Share of retained workflows served by reusable product behavior.", "Product"),
      ],
    },
    {
      key: "product-release",
      label: "Product and release health",
      instrumentationOwner: "Engineering",
      measures: [
        unmeasured("deploy-health", "Production deploy health", "Target band not set", "Per deploy", "Production builds and deployments completing without rollback.", "Engineering"),
        unmeasured("critical-defects", "Critical defects", "Target band not set", "Daily", "Open product defects classified as critical.", "Engineering"),
        unmeasured("objective-linked-work", "Objective-linked work", "Target band not set", "Weekly", "Completed product work linked to the thematic goal or defining objectives.", "Product"),
      ],
    },
    {
      key: "founder-team",
      label: "Founder and team capacity",
      instrumentationOwner: "Ray",
      measures: [
        unmeasured("ray-time", "Ray time allocation", "≥50% judgment/GTM", "Weekly", "Company time by product, GTM, delivery, and administration.", "Ray"),
        unmeasured("sole-owner-domains", "Sole-owner domains", "Declining", "Monthly", "Consequential domains with exactly one capable owner.", "Operations"),
        unmeasured("founding-engineer", "Founding Engineer", "Hired or contingent", "On change", "Founding Engineer search and close status.", "Ray"),
      ],
    },
    {
      key: "corporate-stewardship",
      label: "Corporate stewardship",
      instrumentationOwner: "Operations",
      measures: [
        unmeasured("overdue-obligations", "Overdue obligations", "0", "Weekly", "Past-due legal, tax, payroll, insurance, or governance obligations.", "Operations"),
        unmeasured("contract-status", "Contract status", "Current", "Weekly", "Required company and customer contracts current and executed.", "Legal"),
        unmeasured("investor-actions", "Investor actions", "0 overdue", "Weekly", "Unresolved board or investor actions past their agreed date.", "Ray"),
      ],
    },
  ],
};
