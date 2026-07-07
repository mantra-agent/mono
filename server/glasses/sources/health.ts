import { createLogger } from "../../log";

const log = createLogger("Cortex:Health");

export async function getHealthContext(): Promise<string> {
  try {
    const { queryWellnessActivities, computeActivityPulse } = await import(
      "../../routes/wellness"
    );
    const { db } = await import("../../db");
    const { wellnessLogs } = await import("@shared/models/health");
    const { desc, eq } = await import("drizzle-orm");

    const activities = await queryWellnessActivities();
    const overdueItems: Array<{ name: string; pulsePercent: number }> = [];

    for (const activity of activities) {
      const logs = await db
        .select({ completedAt: wellnessLogs.completedAt })
        .from(wellnessLogs)
        .where(eq(wellnessLogs.activityId, activity.id))
        .orderBy(desc(wellnessLogs.completedAt))
        .limit(10);

      const pulse = computeActivityPulse(
        logs.map((l) => ({ completedAt: l.completedAt })),
        activity.intervalDays,
        activity.category,
      );

      if (pulse.pulse === "danger") {
        overdueItems.push({
          name: activity.name,
          pulsePercent: pulse.pulsePercent ?? 0,
        });
      }
    }

    if (overdueItems.length === 0) return "All wellness activities on track.";

    const lines = overdueItems.map(
      (item) => `- ${item.name}: overdue (${item.pulsePercent}% pulse)`,
    );

    return `Overdue wellness activities:\n${lines.join("\n")}`;
  } catch (err) {
    log.warn(`Health source error: ${(err as Error).message}`);
    return "Health data unavailable.";
  }
}
