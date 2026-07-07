import type { TextCardProps } from "@shared/models/glasses";

export function TextCard({ title, subtitle, urgency }: TextCardProps) {
  const urgencyClass = urgency ? `urgency-${urgency}` : "";

  return (
    <div className={`glasses-card focusable`}>
      <h3 className={`glasses-title ${urgencyClass}`}>{title}</h3>
      {subtitle && <p className="glasses-subtitle">{subtitle}</p>}
    </div>
  );
}
