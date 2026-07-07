import type { TimerCardProps } from "@shared/models/glasses";

export function TimerCard({ label, targetTime, format }: TimerCardProps) {
  // v1: static time display — live countdown deferred
  let display = targetTime;
  try {
    const target = new Date(targetTime);
    if (format === "time") {
      display = target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } else {
      display = target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
  } catch {
    // Keep raw value
  }

  return (
    <div className="glasses-card focusable">
      <span className="glasses-label">{label}</span>
      <div className="glasses-timer">{display}</div>
    </div>
  );
}
