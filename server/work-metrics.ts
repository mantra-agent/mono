import { countMergedPrsInRange } from "./integrations/merged-pr-ledger";
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
  const [shippedPrs, meetings] = await Promise.all([
    countMergedPrsInRange(start, end),
    countCompletedMeetingsWithNotesInRange(start, end),
  ]);
  return { shippedPrs, meetings };
}
