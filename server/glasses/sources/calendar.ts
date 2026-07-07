import { createLogger } from "../../log";

const log = createLogger("Cortex:Calendar");

export async function getCalendarContext(): Promise<string> {
  try {
    const { listAccounts } = await import("../../connected-accounts");
    const accounts = await listAccounts("google");
    if (accounts.length === 0) return "No calendar connected.";

    const { listEvents } = await import("../../google-calendar");
    const now = new Date();
    const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const allEvents: Array<{ summary: string; minutesUntil: number }> = [];

    for (const account of accounts) {
      try {
        const events = await listEvents(account.accountId, {
          timeMin: now.toISOString(),
          timeMax: twoHoursLater.toISOString(),
          maxResults: 5,
        });

        for (const event of events) {
          const startStr = event.start?.dateTime || event.start?.date;
          const startTime = startStr ? new Date(startStr) : null;
          if (!startTime || isNaN(startTime.getTime())) continue;

          const minutesUntil = Math.round(
            (startTime.getTime() - now.getTime()) / (60 * 1000),
          );
          allEvents.push({
            summary: event.summary || "Untitled event",
            minutesUntil,
          });
        }
      } catch (err) {
        log.warn(
          `Failed to query calendar for account ${account.accountId}: ${(err as Error).message}`,
        );
      }
    }

    if (allEvents.length === 0) return "No upcoming events in the next 2 hours.";

    const lines = allEvents.map((e) => {
      const timeLabel =
        e.minutesUntil <= 0
          ? "happening now"
          : e.minutesUntil < 60
            ? `in ${e.minutesUntil}m`
            : `in ${Math.round(e.minutesUntil / 60)}h`;
      return `- ${e.summary} (${timeLabel})`;
    });

    return `Upcoming events (next 2h):\n${lines.join("\n")}`;
  } catch (err) {
    log.warn(`Calendar source error: ${(err as Error).message}`);
    return "Calendar unavailable.";
  }
}
