import type { ToolHandlerResult } from "../contracts";

/**
 * Append a profile-summary quality warning to a people-write result when
 * supporting notes were saved but the concise quickSummary profile is empty.
 * Shared by every people-write handler that persists supporting notes (add_note
 * and create/update), so the empty-summary quality signal stays identical across
 * the people domain. Do not reintroduce per-module copies of this wrapper.
 */
export function withPeopleSummaryStatus(
  result: string,
  quickSummary: unknown,
  supportingNoteWritten: boolean,
): ToolHandlerResult {
  const summaryMissing = supportingNoteWritten && !(typeof quickSummary === "string" && quickSummary.trim());
  if (!summaryMissing) return { result };
  return {
    result: `${result}\n\nWarning: supporting notes were saved, but the concise profile summary is empty. Add quickSummary with people.update.`,
    data: { summaryMissing: true },
  };
}
