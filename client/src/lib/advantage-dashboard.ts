export type MetricState =
  | { kind: "measured"; value: string; freshness: string }
  | { kind: "unmeasured"; instrumentationOwner: string }
  | { kind: "stale"; value: string; freshness: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string };

export interface AdvantageMetricDefinition {
  id: string;
  label: string;
  target?: string;
  sourcePageId: string;
  refreshCadence: string;
  state: MetricState;
}

export interface AdvantageObjectiveDefinition {
  goalId: string;
  owner: string;
  metrics: AdvantageMetricDefinition[];
  nextEvidence: MetricState;
}

export interface AdvantageHealthDomain {
  id: string;
  label: string;
  instrumentationOwner: string;
  metrics: AdvantageMetricDefinition[];
}

export interface AdvantageCycleConfig {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  thematicGoalId: string;
  sourcePageId: string;
  confidence: string;
  strategicJudgment: string;
  objectives: AdvantageObjectiveDefinition[];
  healthDomains: AdvantageHealthDomain[];
}

const Q3_SOURCE_PAGE_ID = "cd29a16a-7594-4392-abd5-8859db908acb";

function unmeasured(instrumentationOwner: string): MetricState {
  return { kind: "unmeasured", instrumentationOwner };
}

function metric(
  id: string,
  label: string,
  instrumentationOwner: string,
  target?: string,
): AdvantageMetricDefinition {
  return {
    id,
    label,
    target,
    sourcePageId: Q3_SOURCE_PAGE_ID,
    refreshCadence: "Not established",
    state: unmeasured(instrumentationOwner),
  };
}

export const MANTRA_Q3_ADVANTAGE: AdvantageCycleConfig = {
  id: "mantra-q3-2026",
  label: "Q3 2026",
  startsOn: "2026-07-01",
  endsOn: "2026-09-30",
  thematicGoalId: "80215d57",
  sourcePageId: Q3_SOURCE_PAGE_ID,
  confidence: "High",
  strategicJudgment: "Prove retained customer value before shipping velocity becomes a substitute for evidence.",
  objectives: [
    {
      goalId: "0b7635c0",
      owner: "Ray",
      metrics: [
        metric("cleared-capital", "Signed documents and cleared capital", "Ray", "$1M Seed"),
        metric("operating-envelope", "Approved operating envelope", "Ray", "18 months"),
        metric("founding-engineer-search", "Founding Engineer search", "Ray", "Initiated or contingent close"),
      ],
      nextEvidence: unmeasured("Ray"),
    },
    {
      goalId: "9db73311",
      owner: "Mantra · Ray accepts",
      metrics: [
        metric("clean-loops", "Consecutive clean external loops", "Mantra", "5"),
        metric("safe-actions", "Private-context leaks, wrong-person mutations, or unreviewed consequential actions", "Mantra", "0"),
        metric("onboarding", "Qualified accounts onboarded within 7 days", "Mantra", "8 of 10"),
        metric("first-loop", "Qualified accounts completing a first loop within 14 days", "Mantra", "6 of 10"),
      ],
      nextEvidence: unmeasured("Mantra"),
    },
    {
      goalId: "27289016",
      owner: "Ray · Mantra instruments",
      metrics: [
        metric("paying-attempts", "Qualified paying-account attempts", "Ray", "10"),
        metric("weekly-cycles", "Accounts completing three weekly cycles without Ray prompting", "Mantra", "5"),
        metric("d30-retention", "D30-retained accounts", "Mantra", "5"),
        metric("max-account", "Stand-alone Max account", "Ray", "$500/month"),
        metric("reviewed-actions", "Reviewed actions across the cohort", "Mantra", "100"),
      ],
      nextEvidence: unmeasured("Ray"),
    },
    {
      goalId: "f367fd69",
      owner: "Ray · Mantra",
      metrics: [
        metric("motion-tests", "Entry motions reaching their minimum viable test or an explicit kill", "Ray", "All three motions"),
        metric("leading-motion", "Provisional leading motion selected", "Ray", "By September 30"),
        metric("non-ray-signal", "Credible non-Ray-advanced account signal", "Mantra", "At least 1"),
      ],
      nextEvidence: unmeasured("Ray"),
    },
    {
      goalId: "5b5fdff1",
      owner: "Mantra · Founding Engineer next",
      metrics: [
        metric("human-hours", "Human hours per active account", "Mantra"),
        metric("workflow-decline", "Human hours for the top repeated workflow", "Mantra", "30% decline from baseline"),
        metric("reusable-workflows", "Retained workflows converted to reusable product behavior", "Mantra", "2–3"),
        metric("ray-time", "Ray time preserved for judgment, learning, GTM, narrative, and key relationships", "Ray", "At least 50%"),
      ],
      nextEvidence: unmeasured("Mantra"),
    },
  ],
  healthDomains: [
    {
      id: "trust-security",
      label: "Trust and security",
      instrumentationOwner: "Mantra",
      metrics: [
        metric("security-incidents", "Severity-1 privacy or security incidents", "Mantra"),
        metric("identity-failures", "Wrong-person mutations and private-context leaks", "Mantra"),
        metric("action-audit", "Audit coverage for consequential actions", "Mantra"),
      ],
    },
    {
      id: "reliability-performance",
      label: "Reliability and performance",
      instrumentationOwner: "Mantra",
      metrics: [
        metric("availability", "Availability", "Mantra"),
        metric("action-success", "Successful user-facing action rate", "Mantra"),
        metric("recovery-time", "Median recovery time", "Mantra"),
      ],
    },
    {
      id: "customer-health",
      label: "Customer health and support",
      instrumentationOwner: "Mantra",
      metrics: [
        metric("active-paying", "Active paying accounts", "Mantra"),
        metric("activation-rate", "Activation rate", "Mantra"),
        metric("d30", "D30 retention", "Mantra"),
      ],
    },
    {
      id: "revenue-cash",
      label: "Revenue, cash, and runway",
      instrumentationOwner: "Ray",
      metrics: [
        metric("product-revenue", "Product MRR and ARR", "Ray"),
        metric("cash-runway", "Cash, burn, and runway", "Ray"),
        metric("financing", "Committed versus cleared financing", "Ray"),
      ],
    },
    {
      id: "delivery-economics",
      label: "Delivery economics",
      instrumentationOwner: "Mantra",
      metrics: [
        metric("hours-account", "Human hours per active account", "Mantra"),
        metric("cost-account", "Model and infrastructure cost per account", "Mantra"),
        metric("workflow-reuse", "Workflow reuse rate", "Mantra"),
      ],
    },
    {
      id: "product-release",
      label: "Product and release health",
      instrumentationOwner: "Mantra",
      metrics: [
        metric("deploy-health", "Production build and deploy health", "Mantra"),
        metric("critical-defects", "Critical defect backlog", "Mantra"),
        metric("objective-work", "Product work tied to the thematic goal", "Mantra"),
      ],
    },
    {
      id: "founder-capacity",
      label: "Founder and team capacity",
      instrumentationOwner: "Ray",
      metrics: [
        metric("ray-time-allocation", "Ray time by operating domain", "Ray"),
        metric("sole-owner", "Unresolved sole-owner domains", "Ray"),
        metric("engineer-hiring", "Founding Engineer hiring status", "Ray"),
      ],
    },
    {
      id: "corporate-stewardship",
      label: "Corporate stewardship",
      instrumentationOwner: "Ray",
      metrics: [
        metric("obligations", "Overdue filings or obligations", "Ray"),
        metric("payroll-tax", "Payroll and tax status", "Ray"),
        metric("board-actions", "Unresolved board and investor actions", "Ray"),
      ],
    },
  ],
};
