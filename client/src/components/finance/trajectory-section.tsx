import { TrendingUp, TrendingDown, AlertTriangle, CheckCircle2, ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export interface TrajectoryDivergentCategory {
  category: string;
  expected: number;
  actual: number;
  deltaAbs: number;
  deltaPct: number | null;
}

export interface TrajectoryLastMonth {
  month: string;
  expectedIncome: number;
  actualIncome: number;
  expectedSpending: number;
  actualSpending: number;
  expectedNetCashFlow: number;
  actualNetCashFlow: number;
  netCashFlowDeviationPct: number | null;
  topDivergentCategories: TrajectoryDivergentCategory[];
}

export interface TrajectoryData {
  currentNetWorth: number;
  projectedNetWorth12mo: number;
  monthlyNetCashFlow: number;
  liquidCash: number;
  totalLiabilities: number;
  trajectoryStatus: "on_track" | "drifting" | "off_track";
  lastCompletedMonth: TrajectoryLastMonth | null;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function statusMeta(status: TrajectoryData["trajectoryStatus"]) {
  if (status === "on_track") return { label: "On Track", icon: CheckCircle2, color: "text-success", bg: "bg-success/10", border: "border-success/30" };
  if (status === "drifting") return { label: "Drifting", icon: AlertTriangle, color: "text-warning", bg: "bg-warning/10", border: "border-warning/30" };
  return { label: "Off Track", icon: AlertTriangle, color: "text-error", bg: "bg-error/10", border: "border-error/30" };
}

interface TrajectorySectionProps {
  data: TrajectoryData | undefined | null;
  isLoading: boolean;
  humanCategory: (cat: string) => string;
  onViewForecast?: () => void;
}

export function TrajectorySection({ data, isLoading, humanCategory, onViewForecast }: TrajectorySectionProps) {
  if (isLoading) {
    return (
      <section data-testid="section-trajectory">
        <div className="rounded-lg border border-border/50 bg-card p-5">
          <Skeleton className="h-4 w-40 mb-3" />
          <Skeleton className="h-10 w-72 mb-4" />
          <Skeleton className="h-4 w-56" />
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section data-testid="section-trajectory">
        <div className="rounded-lg border border-border/50 bg-card p-5">
          <p className="text-xs text-muted-foreground">Trajectory data is not available yet. Connect more accounts and let data accumulate to see your projection.</p>
        </div>
      </section>
    );
  }

  const meta = statusMeta(data.trajectoryStatus);
  const StatusIcon = meta.icon;
  const trending12mo = data.projectedNetWorth12mo - data.currentNetWorth;
  const TrendIcon = trending12mo >= 0 ? TrendingUp : TrendingDown;
  const trendColor = trending12mo >= 0 ? "text-success" : "text-error";

  return (
    <section data-testid="section-trajectory">
      <div className={`rounded-lg border ${meta.border} ${meta.bg} p-5 flex flex-col gap-4`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Net Worth Trajectory (12mo)</span>
              <span className={`inline-flex items-center gap-1 text-xs font-medium ${meta.color}`} data-testid="trajectory-status-badge">
                <StatusIcon className="h-3 w-3" />
                {meta.label}
              </span>
            </div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-2xl @md:text-3xl font-bold text-foreground" data-testid="text-current-net-worth">
                {formatCurrency(data.currentNetWorth)}
              </span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <span className={`text-2xl @md:text-3xl font-bold ${trendColor}`} data-testid="text-projected-net-worth">
                {formatCurrency(data.projectedNetWorth12mo)}
              </span>
            </div>
            <div className={`flex items-center gap-1 text-sm mt-1 ${trendColor}`}>
              <TrendIcon className="h-3.5 w-3.5" />
              <span data-testid="text-trajectory-delta">{trending12mo >= 0 ? "+" : ""}{formatCurrency(trending12mo)} over 12 months</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 pt-3 border-t border-border/50">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wider">Monthly Net</div>
            <div className={`text-sm font-semibold ${data.monthlyNetCashFlow >= 0 ? "text-foreground" : "text-error"}`} data-testid="text-monthly-net-cashflow">
              {data.monthlyNetCashFlow >= 0 ? "+" : ""}{formatCurrency(data.monthlyNetCashFlow)}/mo
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wider">Liquid Cash</div>
            <div className="text-sm font-semibold text-foreground" data-testid="text-liquid-cash">{formatCurrency(data.liquidCash)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wider">Liabilities</div>
            <div className="text-sm font-semibold text-foreground" data-testid="text-total-liabilities">{formatCurrency(data.totalLiabilities)}</div>
          </div>
        </div>

        {data.lastCompletedMonth && (
          <div className="pt-3 border-t border-border/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Last Completed Month ({data.lastCompletedMonth.month})</span>
              {data.lastCompletedMonth.netCashFlowDeviationPct !== null && (
                <span className={`text-xs font-medium ${data.lastCompletedMonth.netCashFlowDeviationPct >= 0 ? "text-success" : "text-error"}`} data-testid="text-last-month-deviation">
                  {data.lastCompletedMonth.netCashFlowDeviationPct >= 0 ? "+" : ""}{data.lastCompletedMonth.netCashFlowDeviationPct.toFixed(0)}% vs plan
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 @sm:grid-cols-3 gap-2 text-xs mb-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Income:</span>
                <span className="text-foreground font-medium" data-testid="text-last-month-income">
                  {formatCurrency(data.lastCompletedMonth.actualIncome)} / {formatCurrency(data.lastCompletedMonth.expectedIncome)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Spending:</span>
                <span className="text-foreground font-medium" data-testid="text-last-month-spending">
                  {formatCurrency(data.lastCompletedMonth.actualSpending)} / {formatCurrency(data.lastCompletedMonth.expectedSpending)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Net flow:</span>
                <span className="text-foreground font-medium" data-testid="text-last-month-net">
                  {formatCurrency(data.lastCompletedMonth.actualNetCashFlow)} / {formatCurrency(data.lastCompletedMonth.expectedNetCashFlow)}
                </span>
              </div>
            </div>
            {data.lastCompletedMonth.topDivergentCategories.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Top Divergences</div>
                <div className="flex flex-col gap-1">
                  {data.lastCompletedMonth.topDivergentCategories.map(c => (
                    <div key={c.category} className="flex items-center justify-between text-xs" data-testid={`divergence-${c.category}`}>
                      <span className="text-foreground">{humanCategory(c.category)}</span>
                      <span className={c.deltaAbs >= 0 ? "text-error font-medium" : "text-success font-medium"}>
                        {c.deltaAbs >= 0 ? "+" : ""}{formatCurrency(c.deltaAbs)}
                        {c.deltaPct !== null && ` (${c.deltaPct >= 0 ? "+" : ""}${c.deltaPct.toFixed(0)}%)`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {onViewForecast && (
          <button
            type="button"
            onClick={onViewForecast}
            className="self-start text-xs text-primary flex items-center gap-1 hover:underline"
            data-testid="link-view-forecast"
          >
            View full forecast <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
    </section>
  );
}
