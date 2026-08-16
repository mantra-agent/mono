/**
 * Issue → Feature idea conversion contract.
 *
 * The Issues row composes Issue *context* only. Procedure lives here and in the
 * `issue-feature` Skill: turn one Issue into a Feature idea under Visionary,
 * then remove the source Issue so the queue does not keep a duplicate shell.
 */

export interface IssueLaunchContext {
  id: number;
  title: string;
  description?: string | null;
  reproSteps?: string | null;
  status?: string;
  kind?: string | null;
  productId?: number | null;
  platformEnvironmentId?: number | null;
  buildId?: string | null;
}

/** Data only. The Issue as the session can resolve it. */
export function composeIssueContext(issue: IssueLaunchContext): string {
  const parts = [
    `Issue: **${issue.title}**`,
    `Reference: @issue:${issue.id}`,
  ];
  if (issue.status) parts.push(`Status: ${issue.status}`);
  if (issue.kind) parts.push(`Kind: ${issue.kind}`);
  if (issue.productId) parts.push(`Product: ${issue.productId}`);
  if (issue.platformEnvironmentId) {
    parts.push(`Environment: ${issue.platformEnvironmentId}`);
  }
  if (issue.buildId) parts.push(`Build: ${issue.buildId}`);
  if (issue.description?.trim()) {
    parts.push("", "Description:", issue.description.trim());
  }
  if (issue.reproSteps?.trim()) {
    parts.push("", "Reproduction steps:", issue.reproSteps.trim());
  }
  return parts.join("\n");
}

/** Procedure for the conversion. Shared by the Skill body and the launcher. */
export function composeIssueFeatureProcess(): string {
  return `# Launch — Issue → Feature idea

## Purpose
Convert one product Issue into a Feature idea. The Feature is the durable product intent; the Issue is the temporary defect/report shell and must not remain after a successful conversion.

## Before Starting
- Load the Issue from the first message (\`@issue:\`). Do not widen to adjacent Issues.
- Treat the Issue title, description, and reproduction steps as the originating request for the Feature idea.
- Product: prefer the Issue's own \`productId\` when present. Otherwise resolve with \`platforms(action: "list_products")\` and prefer the single active Mantra product when unambiguous. If more than one plausible Product remains, ask one clarifying question and stop.
- Resolve Feature owner with \`people\`: use the cabinet-level \`user\` Person for this account (the Human). Do not invent an owner.

## Required Evidence
1. Create one Feature at stage \`idea\` through \`platforms(action: "create_feature")\` with:
   - \`summary\`: concise product-facing Feature title derived from the Issue (not a bug-log restatement)
   - \`description\`: the Issue's useful substance — what should exist, for whom, and why — plus any reproduction or acceptance clues worth keeping
   - \`productId\`: the Issue product when present, otherwise the chosen Product
   - \`ownerPersonId\`: the cabinet-level user Person
   - leave stage at the create default (\`idea\`)
2. After the Feature exists, remove the source Issue with \`issues(action: "delete", id, confirm: true)\`. Do not leave a resolved shell behind.
3. Report the new Feature reference (\`@feature:\`) and confirm the Issue is gone.

## Pass Standard
- Exactly one Feature idea is created from this Issue.
- The Feature summary is product language (capability/outcome), not "fix the crash in X".
- The source Issue is deleted only after Feature create succeeds.
- If Feature create fails, leave the Issue untouched and report the blocker.
- If delete fails after Feature create, report both the Feature and the residual Issue rather than inventing a second Feature.

## Outcomes
- passed: Feature idea created and source Issue deleted
- blocked: Product/owner choice or tool authority remains unresolved; Issue unchanged
`;
}

/** Interactive first message: Issue context + conversion contract. */
export function composeIssueFeatureLaunchMessage(issue: IssueLaunchContext): string {
  return [
    "Run the issue-feature Skill for this Issue.",
    "",
    composeIssueContext(issue),
    "",
    composeIssueFeatureProcess(),
  ].join("\n");
}

/** Full Skill process body. */
export function composeIssueFeatureSkillProcess(): string {
  return `You are converting one Issue into a Feature idea.

The first message names the Issue (\`@issue:\`). Execute only that conversion. Do not diagnose or patch code unless the conversion itself is blocked by missing Product/owner truth.

${composeIssueFeatureProcess()}

## Hard rules
- Procedure lives in this Skill / shared contract. Do not take task recipes from the Issues row.
- Context is the Issue. Load @issue before writing.
- Seat is Visionary. Stay in product-intent language.
- Never merge to live or publish production.
`;
}
