import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useCategoryLabels } from "./category-labels";

interface CategoryBarProps {
  category: string;
  amount: number;
  annualized: number;
  maxAmount: number;
  delta?: number;
  onClick?: () => void;
  testId?: string;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

export function CategoryBar({ category, amount, annualized, maxAmount, delta, onClick, testId }: CategoryBarProps) {
  const { labels } = useCategoryLabels();
  const humanCategory = (cat: string) => labels[cat] || cat.split("_").map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
  const pct = maxAmount > 0 ? Math.min((amount / maxAmount) * 100, 100) : 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left flex flex-col gap-1 py-1.5",
        onClick && "cursor-pointer hover:opacity-80"
      )}
      data-testid={testId}
    >
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-foreground font-medium truncate">{humanCategory(category)}</span>
          {delta !== undefined && (
            <span className={cn(
              "inline-flex items-center gap-0.5 text-xs shrink-0",
              delta > 0 ? "text-error-foreground" : delta < 0 ? "text-success-foreground" : "text-muted-foreground"
            )}>
              {delta > 0 ? <TrendingUp className="h-2.5 w-2.5" /> : delta < 0 ? <TrendingDown className="h-2.5 w-2.5" /> : null}
              {delta > 0 ? "+" : ""}{delta.toFixed(0)}%
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-muted-foreground">{formatCurrency(amount)}/mo</span>
          <span className="text-muted-foreground/70">·</span>
          <span className="text-muted-foreground">{formatCurrency(annualized)}/yr</span>
        </div>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary/70 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </button>
  );
}

export function CategoryBarSkeleton() {
  return (
    <div className="flex flex-col gap-1 py-1.5 animate-pulse">
      <div className="flex justify-between">
        <div className="h-3 w-20 bg-muted rounded" />
        <div className="h-3 w-16 bg-muted rounded" />
      </div>
      <div className="h-1.5 w-full bg-muted rounded-full" />
    </div>
  );
}
