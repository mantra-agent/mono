import { createLogger } from "../../log";

const log = createLogger("Cortex:Priorities");

export async function getPrioritiesContext(): Promise<string> {
  try {
    const { goalsService } = await import("../../goals-service");
    const { userDateStr } = await import("../../utils/user-time");

    const today = userDateStr(new Date());
    const priorities = await goalsService.listPrioritiesForPeriod("today", today);

    if (priorities.length === 0) return "No daily priorities set.";

    const lines = priorities.map(
      (p: { title: string; urgency?: string }, i: number) =>
        `${i + 1}. ${p.title} (${p.urgency || "pending"})`,
    );

    return `Today's priorities:\n${lines.join("\n")}`;
  } catch (err) {
    log.warn(`Priorities source error: ${(err as Error).message}`);
    return "Priorities unavailable.";
  }
}
