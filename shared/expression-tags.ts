const EXPRESSION_TAG_REGEX =
  /(?:<[a-z][a-z\s,/]*>|(?<!!)\[[a-z][a-z\s,/]*\])/gi;

/**
 * Remove speech-only expression and emotion tags from text rendered to sighted
 * UI. Raw speech text should bypass this projection so supported TTS models can
 * still receive tags such as `[warm]` and `[curious]`.
 */
export function stripExpressionTags(text: string): string {
  return text.replace(EXPRESSION_TAG_REGEX, "").replace(/  +/g, " ").trim();
}

/** Normalize visible prose for exact/subsequence narration comparisons. */
export function normalizeExpressionText(text: string): string {
  return stripExpressionTags(text).replace(/\s+/g, " ").toLowerCase();
}
