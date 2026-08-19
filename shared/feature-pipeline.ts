/**
 * Feature pipeline contract.
 *
 * Feature stages are rooms (identity). Feature statuses are work in the room.
 * Every room has two jobs: Produce then Review. Produce never advances stage;
 * it writes the room artifact and sets needs_review. Only Review-pass advances
 * stage. Review is the opposite seat of Produce.
 *
 * The Feature row launches the job that matches current status. Procedure lives
 * here and in the `feature-pipeline` Skill. Call sites compose Feature context;
 * they do not invent procedure.
 *
 * Authority: @page:1ae60565-9dca-409a-89e5-3c8c047f0a2b
 */

import type { ProductContextKind } from "./models/platforms";

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

export const FEATURE_PIPELINE_JOBS = ["produce", "review"] as const;

export type FeatureStage = (typeof FEATURE_STAGES)[number];
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
export type FeaturePipelineJob = (typeof FEATURE_PIPELINE_JOBS)[number];
export type FeaturePipelinePersona = "Visionary" | "Architect" | "Engineer";

export interface FeaturePipelineJobContract {
  /** Short row-menu label. */
  actionLabel: string;
  persona: FeaturePipelinePersona;
  purpose: string;
  entryCriteria: string[];
  evidenceRequirements: string[];
  exitCriteria: string[];
  outcomes: string[];
  /**
   * Review-only. Required Product context kinds for this room.
   * The table is the switch — Features row must not branch on stage name.
   * Empty means load none (Test stays non-qualitative).
   */
  contextKinds?: readonly ProductContextKind[];
}

/** Optional room clock. The table is the switch — no stage-name branches in the row. */
export type FeatureAvailabilityClock = "product_stage_environment";
export type FeatureAvailabilityIdentity = "change_sha";

export interface FeaturePipelineAvailability {
  clock: FeatureAvailabilityClock;
  identity: FeatureAvailabilityIdentity;
}

/** Derived Play gate on GET /api/features. Client never derives commit identity. */
export type FeatureAvailabilityState = "on_stage" | "waiting" | "unknown";

export interface FeatureAvailabilityProjection {
  state: FeatureAvailabilityState;
}

/**
 * Derived glance on GET /api/features from the newest feature_history row.
 * Not a fourth status and not a Feature column. Omit when the latest
 * transition is not a setback. Never parse historyNote.
 */
export type FeatureAttentionState = "setback";

export interface FeatureAttentionProjection {
  state: FeatureAttentionState;
}

/** Kickback (to_stage earlier) or Review-fail (same stage, needs_review → ready). */
export function isFeatureHistorySetback(
  fromStage: string | null | undefined,
  toStage: string | null | undefined,
  fromStatus: string | null | undefined,
  toStatus: string | null | undefined,
): boolean {
  const fromIdx = fromStage ? FEATURE_STAGES.indexOf(fromStage as FeatureStage) : -1;
  const toIdx = toStage ? FEATURE_STAGES.indexOf(toStage as FeatureStage) : -1;
  if (fromIdx >= 0 && toIdx >= 0 && toIdx < fromIdx) return true;
  return (
    Boolean(fromStage) &&
    fromStage === toStage &&
    fromStatus === "needs_review" &&
    toStatus === "ready"
  );
}

export interface FeaturePipelineStage {
  stage: FeatureStage;
  /** Build-v1 analog this room is modeled on. */
  buildAnalog: string;
  /** Next stage on Review pass. Null means stay (maintain keep-alive or deprecate terminal). */
  nextStageOnPass: FeatureStage | null;
  /**
   * Optional availability clock for this room. Today only Test declares one.
   * Rooms without this render Play as before; the Features row must not branch on stage name.
   * waiting/unknown occupy the Play slot as a Timer; click rechecks Stage, it does not launch Smoke.
   */
  availability?: FeaturePipelineAvailability;
  produce: FeaturePipelineJobContract;
  review: FeaturePipelineJobContract;
}

const OPPOSITE_PERSONA: Record<FeaturePipelinePersona, FeaturePipelinePersona> = {
  Visionary: "Engineer",
  Architect: "Engineer",
  Engineer: "Architect",
};

function reviewJob(args: {
  producePersona: FeaturePipelinePersona;
  artifactName: string;
  passOutcome: string;
  contextKinds: readonly ProductContextKind[];
  independentBars?: string;
}): FeaturePipelineJobContract {
  const persona = OPPOSITE_PERSONA[args.producePersona];
  const kindsLabel = args.contextKinds.length > 0
    ? args.contextKinds.join(", ")
    : "none";
  const independent = args.independentBars
    ? ` Also load ${args.independentBars}.`
    : "";
  return {
    actionLabel: "Review",
    persona,
    purpose: `Judge the room's ${args.artifactName} against this room's Product context kinds plus independently required repo files and any Spec-cited extras. Do not redo Produce. Do not add architecture, requirements, or fresh discovery.`,
    contextKinds: args.contextKinds,
    entryCriteria: [
      `Load the Feature and the room's ${args.artifactName}.`,
      `Resolve the Feature's productId and load every Product context page for required kinds (${kindsLabel}). The Spec does not have to mention them.${independent}`,
      "A missing required Product kind is a Review fail. Stay in the room. The residual names the Product and the missing kind. Do not invent repo-root stand-ins.",
      "Loaded Product pages plus independently required repo files are the governing bars. Spec-cited extras stay additive. Uncited preference is not a bar.",
      "Do not rediscover Product standards from the repository in place of those pages.",
      "Do not perform fresh architecture, repository, runtime, implementation, or dependency discovery.",
    ],
    evidenceRequirements: [
      "For each rejection, cite the exact artifact statement and the exact named governing-standard provision it violates.",
      "Unsupported preferences, newly discovered concerns, and uncited best practices are not rejection grounds.",
    ],
    exitCriteria: [
      "Cannot pass when a required Product context kind is empty on the Feature's Product.",
      "Pass unless the artifact contains a concrete cited violation of a named governing standard.",
      `On pass: advance the Feature stage only as this room's pass outcome requires (${args.passOutcome}). Stage change resets status to ready.`,
      "On fail: leave the Feature on the same stage, set status to ready, and name the required revision on the artifact. Do not advance stage.",
    ],
    outcomes: [
      `passed → ${args.passOutcome}`,
      "changes_requested → same stage / ready: revise the artifact",
    ],
  };
}

export const FEATURE_PIPELINE: Record<FeatureStage, FeaturePipelineStage> = {
  idea: {
    stage: "idea",
    buildAnalog: "Design",
    nextStageOnPass: "spec",
    produce: {
      actionLabel: "Frame",
      persona: "Visionary",
      purpose:
        "Frame why this Feature exists. Write Problem, Solution, and External. Do not write the full specification — that is Spec's produce job.",
      entryCriteria: [
        "Start from the Feature context in this session. Do not widen the request.",
        "Inspect only enough product/runtime signal to write Problem, Solution, and External.",
        "Ask clarifying questions only when a consequential choice remains.",
      ],
      evidenceRequirements: [
        "Write Feature `description` as markdown with headings **Problem**, **Solution**, **External**. Problem is who is stuck and what is broken, then inspected evidence. Solution is done when these concrete conditions hold — not Scope and not a later Spec. External is what the outside world touches and what they see or receive.",
        "Do not create or link a Library spec page in this job.",
      ],
      exitCriteria: [
        "Description is coherent enough that Spec can specify without re-framing the request.",
        "Set Feature status to `needs_review`. Do not change stage.",
      ],
      outcomes: [
        "done → needs_review on idea: frame ready for opposite-seat Review",
        "blocked: consequential question remains; leave ready/in_progress with residual named",
      ],
    },
    review: reviewJob({
      producePersona: "Visionary",
      artifactName: "description frame",
      passOutcome: "stage spec / ready",
      contextKinds: ["product_definition"],
    }),
  },
  spec: {
    stage: "spec",
    buildAnalog: "Design",
    nextStageOnPass: "develop",
    produce: {
      actionLabel: "Spec",
      persona: "Architect",
      purpose:
        "Write the smallest coherent specification for this Feature from the approved frame. Name every governing standard the spec must satisfy.",
      entryCriteria: [
        "Load the Feature description frame and stay inside Problem / Solution / External; deepen those three.",
        "Inspect the repository and runtime only as needed to write Scope / Out-of-scope / Internal / Acceptance Criteria against the resolved Spec shape, and to name the governing standards.",
        "Ask clarifying questions only when a consequential choice remains.",
      ],
      evidenceRequirements: [
        "A durable Library specification (`kind: spec`) written against the resolved Spec shape page. Those headings are the required evidence — do not invent a second outline.",
        "Link that page onto the Feature via `specPageId`. Any expansion beyond the Feature must cite the repository evidence and invariant that require it.",
      ],
      exitCriteria: [
        "The specification satisfies the Feature without speculative systems, migrations, abstractions, or adjacent improvements.",
        "It is complete enough for implementation without Review adding architecture or requirements.",
        "Set Feature status to `needs_review` only after the spec page is linked. Do not change stage.",
      ],
      outcomes: [
        "done → needs_review on spec: specification linked and waiting for Review",
        "blocked: consequential question remains; leave ready/in_progress with residual named",
      ],
    },
    review: reviewJob({
      producePersona: "Architect",
      artifactName: "linked specification",
      passOutcome: "stage develop / ready",
      contextKinds: ["product_definition", "design_system"],
      independentBars: "repo AGENTS.md and SECURITY.md",
    }),
  },
  develop: {
    stage: "develop",
    buildAnalog: "Implement",
    nextStageOnPass: "test",
    produce: {
      actionLabel: "Build",
      persona: "Engineer",
      purpose: "Implement the approved specification. Do not redesign. Do not expand scope.",
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
        "After merge evidence is in place, set Feature status to `needs_review`. Do not change stage.",
        "If merge is blocked, leave status ready/in_progress and name the residual. Do not set needs_review without the artifact.",
      ],
      outcomes: [
        "done → needs_review on develop: merged implementation waiting for Review",
        "blocked: merge or authority gate; residual named; stage unchanged",
      ],
    },
    review: {
      ...reviewJob({
        producePersona: "Engineer",
        artifactName: "merged implementation evidence",
        passOutcome: "stage test / ready",
        contextKinds: ["product_definition", "design_system", "coding_process"],
        independentBars: "repo AGENTS.md and SECURITY.md",
      }),
      evidenceRequirements: [
        "For each rejection, cite the exact artifact statement and the exact named governing-standard provision it violates.",
        "Unsupported preferences, newly discovered concerns, and uncited best practices are not rejection grounds.",
        "On pass stage write to Test, stamp `changeSha` (the merge commit SHA already written to merged_pull_requests — never the PR head, never a historyNote parse) via platforms.update_feature so Test can join Stage.",
      ],
    },
  },
  test: {
    stage: "test",
    buildAnalog: "Implementation Review",
    nextStageOnPass: "calibrate",
    availability: { clock: "product_stage_environment", identity: "change_sha" },
    produce: {
      actionLabel: "Smoke",
      persona: "Engineer",
      purpose:
        "Binary works-proof on stage. Confirm the stage environment built, carries the change, and that an authenticated click-path proves the Feature works. Not quality, taste, design, or UX — that is Calibrate Produce (Tune).",
      entryCriteria: [
        "Read the Feature's projected `availability` from get/list (on_stage | waiting | unknown). Do not rediscover Stage or invent commit identity on the client or in ad hoc Railway calls.",
        "Identify the target stage environment and the change under test from the Feature and its develop evidence.",
        "Use automated authenticated session tooling against stage. Do not substitute a passing build or lifecycle progress for a click-path.",
      ],
      evidenceRequirements: [
        "Stage build/deploy evidence that the change is present (prefer projected availability on_stage plus click-path).",
        "Authenticated login + click-path evidence that the Feature path completes.",
        "Record pass/fail only. Do not write qualitative product judgment here.",
      ],
      exitCriteria: [
        "Pass the smoke only when stage is up, the change is present, and the Feature path completes.",
        "On smoke complete, set Feature status to `needs_review` with a historyNote naming the path proved. Do not change stage.",
        "On smoke fail, set stage to `develop` and status to `ready` with a historyNote that names the broken path. Smoke failure kicks the Feature back to Develop — do not leave it on test.",
      ],
      outcomes: [
        "done → needs_review on test: smoke evidence waiting for Review",
        "failed → develop / ready: broken path named on feature history",
        "blocked: environment residual named without a conclusive fail; stage unchanged only when smoke could not run",
      ],
    },
    review: reviewJob({
      producePersona: "Engineer",
      artifactName: "smoke evidence",
      passOutcome: "stage calibrate / ready",
      contextKinds: [],
      independentBars: "the Test contract, the linked Spec, and SECURITY.md if it independently requires",
    }),
  },
  calibrate: {
    stage: "calibrate",
    buildAnalog: "Acceptance Test",
    nextStageOnPass: "maintain",
    produce: {
      actionLabel: "Tune",
      persona: "Engineer",
      purpose:
        "Qualitative review of the approved specification against the shipped implementation. Find violated design principles, bad UI/UX, and misses against the goals of the spec. When linked KPIs are ready to measure, check in on the KPIs this Feature set out to move. This is not Smoke.",
      entryCriteria: [
        "Load the approved specification, prior smoke evidence, and any linked Feature KPIs (`intended_benefit`).",
        "Confirm the merged implementation is deployed and healthy enough to judge product quality — not merely that a click-path completes.",
        "Do not treat a passing build, smoke, or lifecycle progress as Tune complete.",
      ],
      evidenceRequirements: [
        "A Tune note that judges the implementation against the spec's goals: design-principle violations, UI/UX defects, and product-fit gaps, each cited to the spec or a named governing design standard (e.g. DESIGN.md).",
        "When KPIs are linked and measurable, record the current reading (or an explicit not-yet-measurable residual) for each intended-benefit KPI.",
        "Screenshots, routes, or runtime evidence that support each qualitative finding.",
      ],
      exitCriteria: [
        "Tune evidence is filed against the approved specification (and KPIs when applicable).",
        "Set Feature status to `needs_review`. Do not change stage.",
      ],
      outcomes: [
        "done → needs_review on calibrate: Tune evidence waiting for Review",
        "blocked: environment, evidence, or KPI residual named; stage unchanged",
      ],
    },
    review: reviewJob({
      producePersona: "Engineer",
      artifactName: "Tune evidence",
      passOutcome: "stage maintain / ready (product failure may return develop; specification failure may return idea — cite the defect)",
      contextKinds: ["product_definition", "design_system"],
      independentBars: "the approved Spec",
    }),
  },
  maintain: {
    stage: "maintain",
    buildAnalog: "Calibration",
    nextStageOnPass: null,
    produce: {
      actionLabel: "Calibrate",
      persona: "Architect",
      purpose:
        "Compare the approved specification, implementation outcome, and acceptance evidence to identify what the Feature taught us about the product and what should change next.",
      entryCriteria: [
        "Load the approved specification and Tune evidence for this Feature.",
      ],
      evidenceRequirements: [
        "A calibration note that records what the run taught us, what should change in the spec or product next, and whether documentation must be updated.",
      ],
      exitCriteria: [
        "Emit exactly one decision in the note: continue, update_docs, gate, fail_back, or retire.",
        "Set Feature status to `needs_review`. Do not change stage in Produce.",
      ],
      outcomes: [
        "done → needs_review on maintain: calibration note waiting for Review",
        "blocked: missing evidence; residual named",
      ],
    },
    review: {
      actionLabel: "Review",
      persona: "Engineer",
      purpose:
        "Judge the calibration note against this room's Product context kinds, Tune evidence, and the Feature's linked specification. Do not rewrite the calibration.",
      contextKinds: ["product_definition"],
      entryCriteria: [
        "Load the calibration note and the Feature's linked specification and acceptance evidence.",
        "Resolve the Feature's productId and load every Product context page for required kinds (product_definition). The Spec does not have to mention them. Also load Tune evidence.",
        "A missing required Product kind is a Review fail. Stay in the room. The residual names the Product and the missing kind.",
        "Do not perform fresh product discovery beyond what the note claims.",
      ],
      evidenceRequirements: [
        "For each rejection, cite the exact note statement and the governing standard or evidence gap it violates.",
      ],
      exitCriteria: [
        "Cannot pass when a required Product context kind is empty on the Feature's Product.",
        "On pass with continue/update_docs: leave stage on `maintain`, set status to ready, and record the calibration.",
        "On pass with retire: advance stage to `deprecate` (status resets to ready).",
        "On pass with fail_back: return stage to `idea` with the design defect named.",
        "On fail: same stage `maintain`, status ready, required revision named on the note.",
      ],
      outcomes: [
        "passed + continue|update_docs → maintain / ready",
        "passed + retire → deprecate / ready",
        "passed + fail_back → idea / ready",
        "changes_requested → maintain / ready",
      ],
    },
  },
  deprecate: {
    stage: "deprecate",
    buildAnalog: "Documentation",
    nextStageOnPass: null,
    produce: {
      actionLabel: "Document",
      persona: "Engineer",
      purpose:
        "Record the implemented truth, linked evidence, decisions, handoff, and any remaining gates so the Feature can be retired without losing what it taught.",
      entryCriteria: [
        "Load the Feature, its specification, and the calibration note.",
      ],
      evidenceRequirements: [
        "Durable final documentation that records the implemented truth, linked evidence, decisions, handoff, and any remaining gates under the loaded governing context.",
      ],
      exitCriteria: [
        "Terminal documentation is filed and linked. Do not delete evidence.",
        "Set Feature status to `needs_review`. Do not change stage.",
      ],
      outcomes: [
        "done → needs_review on deprecate: terminal docs waiting for Review",
        "blocked: missing evidence; residual named",
      ],
    },
    review: reviewJob({
      producePersona: "Engineer",
      artifactName: "terminal documentation",
      passOutcome: "stay on deprecate / ready (retired)",
      contextKinds: ["product_definition"],
    }),
  },
};

export function formatFeatureStage(stage: FeatureStage): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/** Status chooses the job. needs_review → Review; otherwise Produce. */
export function resolveFeaturePipelineJob(status: FeatureStatus): FeaturePipelineJob {
  return status === "needs_review" ? "review" : "produce";
}

/** Fast Forward walks Play/Review only. Maintain and Deprecate are not eligible. */
export function featureAllowsFastForward(stage: FeatureStage): boolean {
  return stage !== "maintain" && stage !== "deprecate";
}

export function getFeatureJobContract(
  stage: FeatureStage,
  job: FeaturePipelineJob,
): FeaturePipelineJobContract {
  return FEATURE_PIPELINE[stage][job];
}

export function getFeatureReviewContextKinds(stage: FeatureStage): readonly ProductContextKind[] {
  return FEATURE_PIPELINE[stage].review.contextKinds ?? [];
}

export interface FeatureProductContextPage {
  kind: string;
  libraryPageId: string;
  pageTitle?: string;
}

export interface FeatureLaunchContext {
  id: string;
  summary: string;
  stage: FeatureStage;
  status?: FeatureStatus;
  productName?: string;
  productId: number;
  ownerPersonId?: string;
  specPageId?: string | null;
  description?: string;
  productContextPages?: FeatureProductContextPage[];
}

export function resolveFeatureReviewContextPages(
  stage: FeatureStage,
  pages: readonly FeatureProductContextPage[] | undefined,
): { requiredKinds: readonly ProductContextKind[]; loaded: FeatureProductContextPage[]; missingKinds: ProductContextKind[] } {
  const requiredKinds = getFeatureReviewContextKinds(stage);
  const loaded = (pages ?? []).filter((page) =>
    requiredKinds.includes(page.kind as ProductContextKind),
  );
  const present = new Set(loaded.map((page) => page.kind));
  const missingKinds = requiredKinds.filter((kind) => !present.has(kind));
  return { requiredKinds, loaded, missingKinds };
}

/** Data only. The Feature as the session can resolve it. */
export function composeFeatureContext(feature: FeatureLaunchContext): string {
  const status = feature.status ?? "ready";
  const parts = [
    `Feature: **${feature.summary}**`,
    `Reference: @feature:${feature.id}`,
    `Current stage: ${feature.stage}`,
    `Current status: ${status}`,
    `Product: ${feature.productName ?? feature.productId}`,
  ];
  if (feature.ownerPersonId) parts.push(`Owner: @person:${feature.ownerPersonId}`);
  if (feature.specPageId) parts.push(`Spec: @page:${feature.specPageId}`);
  if (feature.description?.trim()) {
    parts.push("", "Description:", feature.description.trim());
  }
  return parts.join("\n");
}

/** Procedure for one assigned (stage, job). Shared by the Skill body and the launcher. */
export function composeFeatureJobProcess(stage: FeatureStage, job: FeaturePipelineJob): string {
  const room = FEATURE_PIPELINE[stage];
  const contract = room[job];
  const hardRule =
    job === "produce"
      ? "Produce never advances stage except Smoke fail → develop. After a successful artifact, set status to `needs_review` only. Blocked work stays ready/in_progress with the residual named. Every stage/status write must include `historyNote` (why) via platforms.update_feature."
      : "Review never redoes Produce. On pass, write the stage transition this room requires (status resets to ready) with a historyNote. On fail, same stage and status ready with the defect named on the artifact and in historyNote.";
  const testQualitativeBan =
    job === "review" && stage === "test"
      ? [
          "",
          "Test Review does not judge quality, taste, brand, or product thesis. Those bars belong to Calibrate.",
        ]
      : [];

  return [
    `# ${contract.actionLabel} — ${formatFeatureStage(stage)} ${job === "produce" ? "Produce" : "Review"}`,
    "",
    `Room: ${formatFeatureStage(stage)}. Job: ${job}. Seat: ${contract.persona}.`,
    `Build analog: ${room.buildAnalog}.`,
    "",
    "## Purpose",
    contract.purpose,
    "",
    "Work adversarially against this purpose. Do not let completed prior work, a passing build, or lifecycle progress substitute for the judgment this job exists to make.",
    "",
    "## Before Starting",
    "- Load Feature history first: `platforms` action `list_feature_history` for this `@feature` (newest first). Use it to understand prior stage/status transitions and why this run exists before judging or writing.",
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
    hardRule,
    ...testQualitativeBan,
    "",
    "Execute only this assigned job. Update the Feature through the platforms Feature actions when this job's exit criteria require a status, stage, description, or specPageId change. Always pass `historyNote` on stage/status changes so provenance records why. Ask a clarifying question only when a consequential choice remains.",
  ].join("\n");
}

/** @deprecated Use composeFeatureJobProcess(stage, job). */
export function composeFeatureStageProcess(stage: FeatureStage): string {
  return composeFeatureJobProcess(stage, "produce");
}

/** Interactive first message: Feature context + the assigned job contract. */
export function composeFeatureLaunchMessage(
  feature: FeatureLaunchContext,
  job: FeaturePipelineJob = resolveFeaturePipelineJob(feature.status ?? "ready"),
): string {
  const stage = feature.stage;
  const contract = getFeatureJobContract(stage, job);
  const reviewContext = job === "review"
    ? resolveFeatureReviewContextPages(stage, feature.productContextPages)
    : null;
  const reviewContextBlock = reviewContext
    ? [
        "",
        "Required Product context kinds for this Review:",
        reviewContext.requiredKinds.length > 0
          ? reviewContext.requiredKinds.map((kind) => `- ${kind}`).join("\n")
          : "- none",
        "",
        reviewContext.loaded.length > 0
          ? [
              "Resolved Product context pages — load these before judging:",
              ...reviewContext.loaded.map((page) =>
                `- ${page.kind}: @page:${page.libraryPageId}${page.pageTitle ? ` ${page.pageTitle}` : ""}`,
              ),
            ].join("\n")
          : reviewContext.requiredKinds.length > 0
            ? "No Product context pages resolved for the required kinds. Fail closed. Residual names the Product and the missing kind."
            : "This room requires no Product context kinds.",
        reviewContext.missingKinds.length > 0
          ? `Missing required kinds: ${reviewContext.missingKinds.join(", ")}. Review cannot pass.`
          : "",
      ].filter(Boolean)
    : [];
  return [
    `Run the ${contract.actionLabel} ${job} job of the feature-pipeline Skill for this Feature.`,
    "",
    composeFeatureContext({ ...feature, status: feature.status ?? "ready" }),
    ...reviewContextBlock,
    "",
    `Assigned job: ${job}`,
    `Assigned stage: ${stage}`,
    "",
    composeFeatureJobProcess(stage, job),
  ].join("\n");
}

/**
 * Discuss launch: stage Produce persona seat, Feature context only.
 * No pipeline Skill, no Produce/Review procedure — open conversation about the Feature.
 */
export function composeFeatureDiscussMessage(feature: FeatureLaunchContext): string {
  return [
    `Let's discuss this Feature.`,
    "",
    composeFeatureContext({ ...feature, status: feature.status ?? "ready" }),
    "",
    "This is an open discussion, not a pipeline job. Do not run Frame, Spec, Build, Smoke, Tune, Review, or any other feature-pipeline procedure unless asked. Help think through the Feature.",
  ].join("\n");
}

/** Persona seat for open Feature discussion — stage Produce seat, not Review opposite. */
export function getFeatureDiscussPersona(stage: FeatureStage): FeaturePipelinePersona {
  return FEATURE_PIPELINE[stage].produce.persona;
}

/** Full Skill process: every stage's produce and review jobs. */
export function composeFeaturePipelineSkillProcess(): string {
  const body = FEATURE_STAGES.map((stage) => {
    return [
      composeFeatureJobProcess(stage, "produce"),
      "",
      "---",
      "",
      composeFeatureJobProcess(stage, "review"),
    ].join("\n");
  }).join("\n\n====\n\n");

  return `You are running one assigned job of the Feature pipeline.

The first message names the Feature (\`@feature:\`), the stage (room), and the job (produce | review). Execute only that job. Do not start a Build workflow; the Feature row owns this launch. Do not invent adjacent Features or widen the request.

## Model
- **Stage is the room** — idea, spec, develop, test, calibrate, maintain, deprecate.
- **Status is the work in the room** — ready, in_progress, needs_review.
- **Produce** makes the room's artifact and sets \`needs_review\`. Produce never advances stage.
- **Review** is the door check. Opposite seat of Produce. Only Review-pass advances stage (status resets to ready). Review-fail stays in the room with status ready.

## Status machine
create → idea/ready · launch Produce → in_progress · Produce done + artifact → needs_review · Review pass → next stage/ready · Review fail → same stage/ready · any stage change → ready

## Spec Produce — document template vessel
When the assigned job is Spec Produce:
1. Call \`templates(action: "resolve", skill: "feature-pipeline", key: "spec")\` before writing the Library spec.
2. Read the resolved shape page. Its headings are the required vessel (not prompt folklore).
3. Write a *new* Library spec (\`canonicalFolder: "specs"\`) against those headings. Template page ≠ output page.
4. After write, if required headings are missing/empty, append trailing \`## Residual\` naming them and include the same headings in Feature \`historyNote\`. Still link \`specPageId\`. Produce may still set \`needs_review\`.
5. If resolve fails, stamp residual \`template_unavailable\` in historyNote, warn, and still write if you can — fail loud, degrade. Do not hardcode TIVE-only headings in process text; account overlays retarget \`spec\` without forking this skill.

${body}

## Hard rules
- Procedure lives in this Skill / shared contract. Do not take task recipes from the Feature row.
- Context is the Feature. Load @feature, its status, its history (\`list_feature_history\`), its spec page, and the Product context pages this room's Review \`contextKinds\` require. Spec citations are extra bars, not the set. Missing required kinds fail closed. Do not rediscover Product standards from the repo in place of those pages. Repository evidence (AGENTS.md, SECURITY.md) stays independently required where the room says so.
- Every Feature stage/status mutation must include a \`historyNote\` explaining why. History is the provenance of how the Feature got here.
- Personas: Visionary produces idea. Architect produces spec and maintain. Engineer produces develop, test (Smoke), calibrate, and deprecate. Review is always the opposite seat (Visionary/Architect → Engineer; Engineer → Architect).
- Test Produce is Smoke: binary works-proof on stage (build present, change present, authenticated click-path). Read projected Feature \`availability\` (on_stage | waiting | unknown) instead of rediscovering Stage. Smoke fail kicks the Feature back to develop/ready with the broken path on history. Qualitative judgment is Calibrate Produce (Tune) only — spec-vs-implementation, design/UX, goals of the spec, and KPI check-in when measurable.
- Develop Review pass into Test must stamp \`changeSha\` (merge commit, not PR head) on the stage write so Test can join Stage's activeCommitSha.
- Never merge to live or publish production. Promotion remains independently authorized.
`;
}
