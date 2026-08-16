// Stable identities for product-owned DB Skills whose runtime authority depends
// on the exact row, not merely a mutable display/name field.
export const CANONICAL_SCAN_SKILL_ID = "e64a948e-5f91-4551-8f3f-a67bd7b7a58c";
export const CANONICAL_REGRESSION_SKILL_ID = "f4374a5d-1f97-4f0e-857a-0fef418d58c9";
export const CANONICAL_DAILY_BRIEF_SKILL_ID = "85ffa707-a446-4455-91ad-b9e97984b9f3";
export const CANONICAL_AFFIRM_SKILL_ID = "0b7f0748-1aca-45bb-9f5f-cc2aabe892a3";

/** Build-mod owned skill names — single source for routes, runner access, and config authority. */
export const BUILD_OWNED_SKILL_NAMES = ["sentry", "guard", "regression"] as const;
export type BuildOwnedSkillName = (typeof BUILD_OWNED_SKILL_NAMES)[number];
export const BUILD_OWNED_SKILL_NAME_SET = new Set<string>(BUILD_OWNED_SKILL_NAMES);

/**
 * Code-owned canonical launch instructions for Build-Mod skills.
 *
 * Build-owned skills carry a full authored process in the global `skills` table
 * in provisioned environments, but that row is optional: it predates the current
 * bootstrap fixture and is not part of `BUILTIN_SKILL_DEFAULTS`, so an
 * environment that never seeded it (or pruned it) has no DB definition. Their
 * scheduled launch path (the Build-managed Timers) also carries an empty prompt
 * and supplies no runtime preContext. When both are absent the skill run must
 * still execute a truthful, bounded contract rather than crash the pipeline.
 *
 * This map is that fail-safe: the single code-owned source used only when the
 * global Skill row is missing and no launch instructions were provided. It is a
 * degraded-mode operating contract, not a competing source of truth for the
 * richer authored process a provisioned DB row provides.
 */
export const BUILD_OWNED_SKILL_FALLBACK_INSTRUCTIONS: Record<BuildOwnedSkillName, string> = {
  sentry: `[Reliability Sentinel — degraded-mode contract]

Its authored Skill definition is not seeded in this environment, so run this bounded contract.

Mission: every run, inspect Mantra Web stage (environment 11) and production (environment 12) health and autonomously repair only bounded stage/main software defects. Production is observe-only and human-promoted.

1. Read runtime health: recent runtime errors and recurring warnings via system.logs and system.reliability, aggregated error fingerprints via issues.list_errors, open issues via issues.list, deployment/build state via platforms.get_environment_status and platforms.get_build_status for environments 11 and 12, and recent railway.deployments.
2. Split system.reliability failures into ambers (classified: input|permission|transient|internal) versus errors (unclassified surprises missing failureKind). Count only terminal outcomes in rates. Prefer remediating unclassified errors first; treat high amber volume as avoidable-input/setup signal, not unexplained instability.
3. Recent changelist remediation gate: before creating or reusing a task, repair handoff, conversation, or attention flag, compare every new or worsening software-defect candidate against recent stage/main changelists (up to 20 deployments in the last 24h, including in-progress builds). Assign exactly one disposition: unaddressed, repair_active, addressed_pending_live_promotion, live_verified, or uncertain (treat uncertain as unaddressed for notification safety). A match must cite a PR or commit SHA and explain how it addresses the failure mechanism; shared words or a newer SHA alone are not a match.
4. Deduplicate incidents by normalized signature + environment + likely subsystem. Update or reference an existing incident or open Issue instead of creating another. Inspect recent sentry skill runs and open issues/tasks/sessions to avoid duplicates.
5. For a bounded, well-understood stage or main software defect, repair it end-to-end through the standard coding path and open a PR to main. Never modify production directly.
6. Quiet is the default. Do not mint a conversation or set attention. This contract has no page primitive — never call session.initiate. Record findings only in this run's report.
7. Report a concise summary of what was inspected, incidents and dispositions, and any repair PR references.`,
  guard: `[Security Sentinel — degraded-mode contract]

Its authored Skill definition is not seeded in this environment, so run this bounded, read-only contract.

Mission: weekly read-only security review of mantra-agent/mono main. This run never modifies code, never opens PRs, and never runs active or destructive security testing.

1. Load SECURITY.md as the canonical security doctrine, threat model, and control baseline.
2. Default to a diff-only review of changes on main since the last review. Perform a full baseline review only every 4th run or after 30 days.
3. Prioritize changes touching trust boundaries, principals/permissions, user/account/vault scope, sensitive data, public routes/callbacks, streams, external/retrieved input, model context, memory, tool or autonomous authority, execution surfaces (browser/shell/git), secrets, dependencies, and deployment/backup/recovery paths.
4. For each credible finding, name the affected assets and data classes, the abuse case and STRIDE/LLM/agentic threat, the canonical deterministic control and owner, and a severity. Record or update the finding in SECURITY.md via the ordinary coding path in a follow-up run if a change is warranted; this review run itself stays read-only.
5. Deduplicate against existing SECURITY.md findings and open Issues instead of creating duplicates.
6. Report a concise summary of scope reviewed (diff-only or baseline), findings by severity, and recommended follow-ups. Alert Ray only for credible high or critical findings.`,
  regression: `[Regression — degraded-mode contract]

Its authored Skill definition is not seeded in this environment, so run this bounded contract.

Burn down the open Issue queue after a build. This is a disposition pipeline, not a cautious classifier.

1. Load every unresolved Issue through issues.list.
2. Inspect Issues individually through issues.get when body or evidence is present; skip get on empty-queue or title-only shells.
3. Dispose the queue: resolve fixed and non-actionable Issues (empty body / no repro steps / title-only noise = non-actionable → resolve). Keep real residual bugs open only with enough signal to act. blocked_on_testing is rare — only when an Issue has substance but this run truly cannot decide.
4. Prepend a dated run entry to the account's "Regression Testing Log" Library page (filed under Skills; create once if missing) and re-surface it. An empty open queue is a valid no-op success: list, log the no-op, surface, and stop.
5. Report counts and decisive evidence; reference the log page. Never invent metrics or create replacement Issues.`,
};

/**
 * Legacy skill/timer/prompt names → canonical skill name.
 * Single source for seed renames, timer aliasing, and runtime config resolve.
 */
export const SKILL_NAME_ALIASES: Record<string, string> = {
  "monthly-reflect": "reflect",
  "sleep-cycle": "sleep",
  "memory-sleep": "sleep",
  "introspect": "reflect",
  "reflect-daily": "reflect",
  "reflect-weekly": "reflect",
  "reflect-monthly": "reflect",
  "reflect-quarterly": "reflect",
  "reflect-annual": "reflect",
  "idea-generation": "ideate",
  "landscape-scan": "scan",
  "opportunity-research": "research",
  "council-advocate": "advocate",
  "coaching-model-1-0": "coach",
  "news-curation": "curate",
  "reliability-sentinel": "sentry",
  "security-sentinel": "guard",
};

export function resolveSkillRunName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return SKILL_NAME_ALIASES[trimmed] ?? SKILL_NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}
