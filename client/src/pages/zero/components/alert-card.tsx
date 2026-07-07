import type { AlertCardProps } from "@shared/models/glasses";

export function AlertCard({ message, severity }: AlertCardProps) {
  return (
    <div className={`glasses-card focusable alert-${severity}`}>
      <p className="glasses-title">{message}</p>
    </div>
  );
}
