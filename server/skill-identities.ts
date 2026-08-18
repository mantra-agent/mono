// Stable identities for product-owned DB Skills whose runtime authority depends
// on the exact row, not merely a mutable display/name field.
export const CANONICAL_REGRESSION_SKILL_ID = "f4374a5d-1f97-4f0e-857a-0fef418d58c9";
export const CANONICAL_DAILY_BRIEF_SKILL_ID = "85ffa707-a446-4455-91ad-b9e97984b9f3";
export const CANONICAL_AFFIRM_SKILL_ID = "0b7f0748-1aca-45bb-9f5f-cc2aabe892a3";

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
