import { createLogger } from "../../log";

const log = createLogger("Cortex:Weather");

export async function getWeatherContext(): Promise<string> {
  try {
    const { getCurrentWeather } = await import("../../weather");
    const raw = await getCurrentWeather({ location: "Chicago" });

    const lower = raw.toLowerCase();
    const isSevere =
      lower.includes("warning") ||
      lower.includes("alert") ||
      lower.includes("severe") ||
      lower.includes("tornado") ||
      lower.includes("thunderstorm");

    if (isSevere) {
      return `SEVERE WEATHER ALERT: ${raw.slice(0, 300)}`;
    }

    // Return brief conditions for context, not as a candidate
    return `Weather: ${raw.slice(0, 150)}`;
  } catch (err) {
    log.warn(`Weather source error: ${(err as Error).message}`);
    return "Weather data unavailable.";
  }
}
