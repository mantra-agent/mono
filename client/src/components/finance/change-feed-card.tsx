import { TrendingUp, TrendingDown, AlertCircle, BarChart3 } from "lucide-react";

export interface ChangeFeedItemData {
  id: string;
  icon: "up" | "down" | "alert" | "info";
  title: string;
  description: string;
  timestamp: string;
  link?: { tab: string; filter?: string };
}

interface ChangeFeedCardProps {
  item: ChangeFeedItemData;
  onClick?: () => void;
  testId?: string;
}

export function ChangeFeedCard({ item, onClick, testId }: ChangeFeedCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 px-3 py-2.5 hover:bg-muted/30 transition-colors"
      data-testid={testId}
    >
      <div className="mt-0.5 shrink-0">
        {item.icon === "up" && <TrendingUp className="h-3.5 w-3.5 text-success-foreground" />}
        {item.icon === "down" && <TrendingDown className="h-3.5 w-3.5 text-error-foreground" />}
        {item.icon === "alert" && <AlertCircle className="h-3.5 w-3.5 text-warning-foreground" />}
        {item.icon === "info" && <BarChart3 className="h-3.5 w-3.5 text-info-foreground" />}
      </div>
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="text-xs font-medium text-foreground">{item.title}</span>
        <span className="text-xs text-muted-foreground">{item.description}</span>
      </div>
      <span className="text-xs text-muted-foreground/60 shrink-0 mt-0.5">{item.timestamp}</span>
    </button>
  );
}

export function ChangeFeedCardSkeleton() {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 animate-pulse">
      <div className="h-3.5 w-3.5 bg-muted rounded shrink-0 mt-0.5" />
      <div className="flex flex-col gap-1 flex-1">
        <div className="h-3 w-32 bg-muted rounded" />
        <div className="h-2.5 w-48 bg-muted rounded" />
      </div>
      <div className="h-2.5 w-12 bg-muted rounded shrink-0 mt-0.5" />
    </div>
  );
}
