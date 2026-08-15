import type { MetricCollection } from "@shared/models/metrics";
import { queryMetricCollection } from "../metrics/core-engine";

/** Business Mod contribution over the neutral Core measurement protocol. */
export async function getBusinessMetricCollection(
  businessId: string,
  start: Date,
  end: Date,
): Promise<MetricCollection> {
  return queryMetricCollection(businessId, start, end);
}
