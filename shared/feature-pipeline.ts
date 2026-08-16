/**
 * Feature pipeline contract.
 *
 * Feature stages are the product lifecycle. Build workflow stages are the
 * software-delivery analog. This module is the single source for both the
 * Feature row launcher and the `feature-pipeline` Skill: stage identity,
 * seat, purpose, evidence, and pass standard. The row exposes only the
 * action for the Feature's current stage. Call sites compose Feature
 * *context*; they do not invent procedure.
 */

export const FEATURE_STAGES = [
  "idea",
  "spec",
  "develop",
  "test",
  "calibrate",
  "maintain",
  "deprecate",
] as const;

export const FEATURE_STATUSES = ["ready", "in_progress", "needs_review"] as const;

export type FeatureStage = (typeof FEATURE_STAGES)[number];
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
export type FeaturePipelinePersona = "Architect" | "Engineer";

export interface FeaturePipelineStage {
  stage: FeatureStage;
  /** Short row-menu label, same grammar as the idea-phase Spec button. */
  actionLabel: string;
  persona: FeaturePipelinePersona;
  /** Build-v1 analog this stage is modeled on. */
  buildAnalog: string;
  purpose: string;
  entryCriteria: string[];
  evidenceRequirements: string[];
  exitCriteria: string[];
  outcomes: string[];
}

export const FEATURE_PIPELINE: Record<FeatureStage, FeaturePipelineStage> = {
  idea: {
    stage: "idea",
    actionLabel: "Spec",
    persona: "Architect",
    buildAnalog: "Design",
    purpose:
      "Write the smallest coherent specification for this Feature. Start from the originating Feature, inspect the repository and runtime only as needed to identify the failed or missing invariant, and name every governing standard the spec must satisfy.",
    entryCriteria: [
      "Start from the Feature context in this session. Do not widen the request.",
      "Inspect the repository and runtime only as needed to identify the failed invariant, the smallest coherent repair, and the named governing standards the specification must satisfy.",
      "Ask clarifying questions only when a consequential choice remains. Do not interview for preference.",
    ],
    evidenceRequirements: [
      "A durable Library specification (`kind: spec`) that names the smallest coherent implementation, success conditions, target truth, verification path, terminal state, and every governing standard relied upon.",
      "Link that page onto the Feature via specPageId. Any expansion beyond the Feature must cite the repository evidence and invariant that require it.",
    ],
    exitCriteria: [
      "The specification satisfies the Feature without speculative systems, migrations, abstractions, or adjacent improvements.",
      "It is complete enough for implementation without Review adding architecture or requirements.",
      "Advance the Feature to stage `spec` only after the spec page is linked.",
    ],
    outcomes: [
      "passed → spec: specification is implementation-ready and linked",
      "blocked: a consequential question remains; do not invent the answer",
    ],
  },
  spec: {
    stage: "spec",
    actionLabel: "Review",
    persona: "Architect",
    buildAnalog: "Design Review",
    purpose:
      "Review the Design-produced specification against the named governing standards only. Pass unless the specification contains a concrete cited violation.",
    entryCriteria: [
      "Load the Feature's linked specification and the named governing standards it cites.",
      "Do not perform fresh architecture, repository, runtime, or dependency discovery.",
    ],
    evidenceRequirements: [
      "For each rejection, cite the exact specification statement and the exact named governing-standard provision it violates.",
      "Do not introduce a requirement that is absent from those standards. Concrete SECURITY.md violations may reject the specification.",
    ],
    exitCriteria: [
      "Pass unless the specification contains a concrete cited violation of a named governing standard.",
      "Unsupported preferences, newly discovered architecture concerns, and uncited best practices are not rejection grounds.",
      "On pass, advance the Feature to stage `develop`. On changes requested, leave it on `spec` and record the required revision on the spec page.",
    ],
    outcomes: [
      "passed → develop: no cited standards violation remains",
      "changes_requested → stay on spec: revise the specification",
    ],
  },
  develop: {
    stage: "develop",
    actionLabel: "Build",
    persona: "Engineer",
    buildAnalog: "Implement",
    purpose:
      "Implement the approved specification. Do not redesign. Do not expand scope.",
    entryCriteria: [
      "Load and implement the approved specification linked on this Feature.",
      "Follow root AGENTS.md, CODING.md, and any subdirectory AGENTS.md for touched trees. Load DESIGN.md for UI work.",
    ],
    evidenceRequirements: [
      "Implementation evidence, production-build result, impact/change-scope evidence, and branch/commit/PR references proving the approved specification was executed.",
      "Do not report coding work done until the PR is merged to main, unless merge is blocked or review-first was requested.",
    ],
    exitCriteria: [
      "The approved specification is implemented under the loaded governing context.",
      "Advance the Feature to stage `test` after merge, or leave it on `develop` with the residual named if merge is blocked.",
    ],
    outcomes: [
      "passed → test: merged implementation matches the approved spec",
      "blocked: merge or authority gate; name the residual",
    ],
  },
  test: {
    stage: "test",
    actionLabel: "Audit",
    persona: "Engineer",
    buildAnalog: "Implementation Review",
    purpose:
      "Inspect the complete implementation against the approved specification and every loaded governing artifact before judging readiness.",
    entryCriteria: [
      "Inspect the complete implementation, affected systems, approved design, and every loaded governing artifact before judging readiness.",
    ],
    evidenceRequirements: [
      "Find and report material defects, inconsistencies, technical debt, and governing-context violations in the resulting implementation.",
      "State required cures, residual risk, and acceptance readiness.",
    ],
    exitCriteria: [
      "Pass only when no material implementation or governing-context violation remains.",
      "On pass, advance the Feature to stage `calibrate`. On changes requested, return it to `develop` with the required cures.",
    ],
    outcomes: [
      "passed → calibrate: no material implementation or governing-context violation remains",
      "changes_requested → develop: revise the implementation",
    ],
  },
  calibrate: {
    stage: "calibrate",
    actionLabel: "Accept",
    persona: "Engineer",
    buildAnalog: "Acceptance Test",
    purpose:
      "Confirm the merged implementation is deployed and healthy, and that the deployed result does what the approved specification requires.",
    entryCriteria: [
      "Load the approved specification, then confirm the merged implementation is deployed and healthy in the target environment.",
      "Do not treat a passing build or lifecycle progress as acceptance.",
    ],
    evidenceRequirements: [
      "Deployment, boot/health, target-route, screenshot, runtime-log, and safe feature-path evidence sufficient to determine whether the deployed result satisfies the approved specification.",
    ],
    exitCriteria: [
      "Pass only when the deployed system boots successfully and satisfies the approved specification.",
      "On pass, advance the Feature to stage `maintain`. Product failure returns it to `develop`. Specification failure returns it to `idea` with the spec defect named.",
    ],
    outcomes: [
      "passed → maintain: deployed result satisfies the approved spec",
      "product_failure → develop: correct the product",
      "specification_failure → idea: correct the specification",
    ],
  },
  maintain: {
    stage: "maintain",
    actionLabel: "Calibrate",
    persona: "Architect",
    buildAnalog: "Calibration",
    purpose:
      "Compare the approved specification, implementation outcome, and acceptance evidence to identify what the Feature taught us about the product and what should change next.",
    entryCriteria: [
      "Load the approved specification and acceptance evidence for this Feature.",
    ],
    evidenceRequirements: [
      "A calibration note that records what the run taught us, what should change in the spec or product next, and whether documentation must be updated.",
    ],
    exitCriteria: [
      "Emit exactly one decision: continue, update_docs, gate, or fail_back.",
      "continue or update_docs → advance to `deprecate` only when the Feature is being retired; otherwise remain on `maintain` and record the calibration.",
      "fail_back → return the Feature to `idea` to recalibrate the design.",
    ],
    outcomes: [
      "continue: Feature stays in maintain; record the calibration",
      "update_docs: record required documentation updates",
      "gate: hold for a human calibration decision",
      "fail_back → idea: recalibrate the design",
    ],
  },
  deprecate: {
    stage: "deprecate",
    actionLabel: "Document",
    persona: "Engineer",
    buildAnalog: "Documentation",
    purpose:
      "Record the implemented truth, linked evidence, decisions, handoff, and any remaining gates so the Feature can be retired without losing what it taught.",
    entryCriteria: [
      "Load the Feature, its specification, and the calibration note.",
    ],
    evidenceRequirements: [
      "Durable final documentation that records the implemented truth, linked evidence, decisions, handoff, and any remaining gates under the loaded governing context.",
    ],
    exitCriteria: [
      "The Feature's terminal documentation is filed and linked. Do not delete evidence.",
    ],
    outcomes: ["passed: Feature documentation is complete and linked"],
  },
};

export function formatFeatureStage(stage: FeatureStage): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

export interface FeatureLaunchContext {
  id: string;
  summary: string;
  stage: FeatureStage;
  productName?: string;
  productId: number;
  ownerPersonId?: string;
  specPageId?: string | null;
  description?: string;
}

/** Data only. The Feature as the session can resolve it. */
export function composeFeatureContext(feature: FeatureLaunchContext): string {
  const parts = [
    `Feature: **${feature.summary}**`,
    `Reference: @feature:${feature.id}`,
    `Current stage: ${feature.stage}`,
    `Product: ${feature.productName ?? feature.productId}`,
  ];
  if (feature.ownerPersonId) parts.push(`Owner: @person:${feature.ownerPersonId}`);
  if (feature.specPageId) parts.push(`Spec: @page:${feature.specPageId}`);
  if (feature.description?.trim()) {
    parts.push("", "Description:", feature.description.trim());
  }
  return parts.join("\n");
}

/** Procedure for one assigned stage. Shared by the Skill body and the launcher. */
export function composeFeatureStageProcess(stage: FeatureStage): string {
  const contract = FEATURE_PIPELINE[stage];
  return [
    `# ${contract.actionLabel} — ${formatFeatureStage(stage)}`,
    "",
    `Build analog: ${contract.buildAnalog}.`,
    "",
    "## Purpose",
    contract.purpose,
    "",
    "Work adversarially against this purpose. Do not let completed prior work, a passing build, or lifecycle progress substitute for the judgment this stage exists to make.",
    "",
    "## Before Starting",
    ...contract.entryCriteria.map((line) => `- ${line}`),
    "",
    "## Required Evidence",
    ...contract.evidenceRequirements.map((line) => `- ${line}`),
    "",
    "## Pass Standard",
    ...contract.exitCriteria.map((line) => `- ${line}`),
    "",
    "## Outcomes",
    ...contract.outcomes.map((line) => `- ${line}`),
    "",
    "Execute only this assigned stage. Update the Feature through the platforms Feature actions when the stage's exit criteria require a stage or spec change. Ask a clarifying question only when a consequential choice remains.",
  ].join("\n");
}

/** Interactive first message: Feature context + the assigned stage contract. */
export function composeFeatureLaunchMessage(
  feature: FeatureLaunchContext,
  stage: FeatureStage = feature.stage,
): string {
  return [
    `Run the ${FEATURE_PIPELINE[stage].actionLabel} stage of the feature-pipeline Skill for this Feature.`,
    "",
    composeFeatureContext(feature),
    "",
    composeFeatureStageProcess(stage),
  ].join("\n");
}

/** Full Skill process: every stage contract, assigned at launch by stage key. */
export function composeFeaturePipelineSkillProcess(): string {
  const stages = FEATURE_STAGES.map((stage) => composeFeatureStageProcess(stage)).join("\n\n---\n\n");
  return `You are running one assigned stage of the Feature pipeline.

The first message names the Feature (\`@feature:\`) and the assigned stage. Execute only that stage. Do not start a Build workflow; the Feature row owns this launch. Do not invent adjacent Features or widen the request.

The pipeline is modeled on Build workflow v1 (Design → Design Review → Implement → Implementation Review → Acceptance Test → Calibration → Documentation), mapped onto Feature stages idea → spec → develop → test → calibrate → maintain → deprecate.

${stages}

## Hard rules
- Procedure lives in this Skill / shared contract. Do not take task recipes from the Feature row.
- Context is the Feature. Load @feature, its spec page, Product context artifacts, and repository evidence as the stage requires.
- Personas: Architect for idea, spec, and maintain. Engineer for develop, test, calibrate, and deprecate.
- Never merge to live or publish production. Promotion remains independently authorized.
`;
}
