import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { FreshnessBadge } from "./freshness-badge";

interface SummaryMetricCardProps {
  label: string;
  value: string;
  secondaryValue?: string;
  delta?: number | null;
  deltaLabel?: string;
  icon?: React.ReactNode;
  freshness?: string | null;
  testId?: string;
}

export function SummaryMetricCard({ label, value, secondaryValue, delta, deltaLabel, icon, freshness, testId }: SummaryMetricCardProps) {
  const deltaDirection = delta === null || delta === undefined ? "neutral" : delta > 0 ? "up" : delta < 0 ? "down" : "neutral";

  return (
    <div
      className="rounded-lg border border-border/50 bg-card p-4 flex flex-col gap-1.5 min-w-0"
      data-testid={testId}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="truncate">{label}</span>
      </div>
      <div data-testid={testId ? `${testId}-value` : undefined}>
        <div className="text-xl font-semibold text-foreground tracking-tight truncate">{value}</div>
        {secondaryValue && (
          <div className="text-xs text-muted-foreground truncate">{secondaryValue}</div>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {(delta !== null && delta !== undefined) ? (
          <div className="flex items-center gap-1 text-xs">
            {deltaDirection === "up" && <TrendingUp className="h-3 w-3 text-success-foreground shrink-0" />}
            {deltaDirection === "down" && <TrendingDown className="h-3 w-3 text-error-foreground shrink-0" />}
            {deltaDirection === "neutral" && <Minus className="h-3 w-3 text-muted-foreground shrink-0" />}
            <span className={cn(
              deltaDirection === "up" && "text-success-foreground",
              deltaDirection === "down" && "text-error-foreground",
              deltaDirection === "neutral" && "text-muted-foreground",
            )}>
              {delta > 0 ? "+" : ""}{typeof delta === "number" ? delta.toFixed(1) : "0"}%
            </span>
            {deltaLabel && <span className="text-muted-foreground">{deltaLabel}</span>}
          </div>
        ) : deltaLabel ? (
          <span className="text-xs text-muted-foreground">{deltaLabel}</span>
        ) : null}
        {freshness && <FreshnessBadge lastUpdated={freshness} />}
      </div>
    </div>
  );
}

export function SummaryMetricCardSkeleton() {
  return (
    <div className="rounded-lg border border-border/50 bg-card p-4 flex flex-col gap-2 animate-pulse">
      <div className="h-3 w-16 bg-muted rounded" />
      <div className="h-6 w-24 bg-muted rounded" />
      <div className="h-3 w-20 bg-muted rounded" />
    </div>
  );
}
