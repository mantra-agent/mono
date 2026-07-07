import { AlertTriangle, Clock, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AttentionItem {
  id: string;
  severity: "warning" | "info" | "urgent";
  title: string;
  description: string;
  action?: string;
  link?: string;
}

const severityStyles: Record<string, { bg: string; border: string; icon: typeof AlertTriangle }> = {
  urgent: { bg: "bg-error/5", border: "border-error/20", icon: AlertTriangle },
  warning: { bg: "bg-warning/5 dark:bg-warning/5", border: "border-warning/20", icon: Clock },
  info: { bg: "bg-info/5", border: "border-info/20", icon: TrendingUp },
};

interface AttentionCardProps {
  item: AttentionItem;
  onClick?: () => void;
}

export function AttentionCard({ item, onClick }: AttentionCardProps) {
  const style = severityStyles[item.severity] || severityStyles.info;
  const Icon = style.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-lg border p-3 flex items-start gap-3 transition-colors",
        style.bg, style.border,
        onClick && "cursor-pointer hover:opacity-80"
      )}
      data-testid={`attention-card-${item.id}`}
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium text-foreground">{item.title}</span>
        <span className="text-xs text-muted-foreground">{item.description}</span>
        {item.action && (
          <span className="text-xs text-primary mt-1">{item.action}</span>
        )}
      </div>
    </button>
  );
}
