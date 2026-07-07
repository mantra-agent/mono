/**
 * Period Artifact Storage — lightweight date-keyed artifact links.
 *
 * Stores which Library pages are linked as briefs, reviews, weekly plans,
 * weekly reflections, monthly plans, and monthly reflections for each
 * date/period combination.
 *
 * Replaces the artifact-linking subset of the old CheckIn storage.
 */
import { documentStorage } from "./memory/document-storage";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";

const log = createLogger("PeriodArtifacts");

export interface PeriodArtifacts {
  briefPageId?: string | null;
  reviewPageId?: string | null;
  briefViewedAt?: string | null;
  reviewViewedAt?: string | null;
  dailyPlanPageId?: string | null;
  weeklyReflectionPageId?: string | null;
  weeklyPlanPageId?: string | null;
  monthlyPlanPageId?: string | null;
  monthlyReflectionPageId?: string | null;
  quarterlyPlanPageId?: string | null;
  quarterlyReflectionPageId?: string | null;
}

type PeriodType = "daily" | "weekly" | "monthly" | "quarterly";

function docId(date: string, period: PeriodType): string {
  const principal = getCurrentPrincipalOrSystem();
  const ownerKey = principal.accountId || principal.userId || principal.actorType;
  return `${ownerKey}:artifact:${date}:${period}`;
}

export async function getArtifacts(date: string, period: PeriodType): Promise<PeriodArtifacts | null> {
  const doc = await documentStorage.getDocument("period_artifact", docId(date, period));
  if (!doc) return null;
  const meta = (doc.metadata || {}) as Record<string, unknown>;
  return {
    briefPageId: (meta.briefPageId as string) || null,
    reviewPageId: (meta.reviewPageId as string) || null,
    briefViewedAt: (meta.briefViewedAt as string) || null,
    reviewViewedAt: (meta.reviewViewedAt as string) || null,
    dailyPlanPageId: (meta.dailyPlanPageId as string) || null,
    weeklyReflectionPageId: (meta.weeklyReflectionPageId as string) || null,
    weeklyPlanPageId: (meta.weeklyPlanPageId as string) || null,
    monthlyPlanPageId: (meta.monthlyPlanPageId as string) || null,
    monthlyReflectionPageId: (meta.monthlyReflectionPageId as string) || null,
    quarterlyPlanPageId: (meta.quarterlyPlanPageId as string) || null,
    quarterlyReflectionPageId: (meta.quarterlyReflectionPageId as string) || null,
  };
}

export async function setArtifact(
  date: string,
  period: PeriodType,
  updates: Partial<PeriodArtifacts>,
): Promise<PeriodArtifacts> {
  const existing = await getArtifacts(date, period) || {};
  const merged: PeriodArtifacts = { ...existing, ...updates };

  await documentStorage.upsertDocument(
    "period_artifact",
    docId(date, period),
    `artifacts/${period}/${date}.json`,
    `Artifacts ${date} (${period})`,
    "",
    merged as Record<string, unknown>,
  );

  log.debug(`setArtifact date=${date} period=${period} fields=${Object.keys(updates).join(",")}`);
  return merged;
}
