import { fetchMergedPrsSince } from "./integrations/github-timeline";
import { countCompletedMeetingsWithNotesInRange } from "./meetings/meeting-index";

export interface WorkRangeSample {
  shippedPrs: number;
  meetings: number;
}

/**
 * Derived work counts for one bounded half-open interval. Build/Git and Meetings
 * retain authority for qualifying records; Metrics owns only this aggregate
 * sampling composition.
 */
export async function sampleWorkRange(start: Date, end: Date): Promise<WorkRangeSample> {
  const [mergedPrs, meetings] = await Promise.all([
    fetchMergedPrsSince(start),
    countCompletedMeetingsWithNotesInRange(start, end),
  ]);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const shippedPrs = mergedPrs.filter((pr) => {
    const mergedAt = new Date(pr.mergedAt).getTime();
    return Number.isFinite(mergedAt) && mergedAt >= startMs && mergedAt < endMs;
  }).length;
  return { shippedPrs, meetings };
}
