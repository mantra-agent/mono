import type { ActionCardProps } from "@shared/models/glasses";

export function ActionCard({ label, variant = "primary" }: ActionCardProps) {
  return (
    <div className="glasses-card focusable">
      <button className={`glasses-action ${variant}`} type="button">
        {label}
      </button>
    </div>
  );
}
