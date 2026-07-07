import { useQuery } from "@tanstack/react-query";
import { useState, useRef, useMemo } from "react";
import { TrendingUp, TrendingDown, DollarSign, ChevronDown, ChevronRight, Loader2, AlertCircle, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ForecastMonth {
  month: string;
  isPast: boolean;
  isCurrent: boolean;
  income: { gross: number; net: number; actual: number | null };
  taxes: number;
  retirement401k: number;
  deductions: Record<string, number>;
  deposits: Record<string, number>;
  expenses: Record<string, number>;
  totalExpenses: number;
  investments: number;
  investmentBreakdown: Record<string, number>;
  manual401kBalance: number;
  manual401kBreakdown: Record<string, number>;
  assets: number;
  manualAssetValue: number;
  financedAssetValue: number;
  cashBalance: number;
  liabilities: number;
  liabilityBreakdown: Record<string, number>;
  financedLoanBalance: number;
  totalDebtPayments: number;
  netCashFlow: number;
  cumulativeNetWorth: number;
}

interface ForecastData {
  currentMonth: string;
  months: ForecastMonth[];
  categories: string[];
  growthRate: number;
  deductionTypes: string[];
  depositAccounts: string[];
  liabilityNames: string[];
  investmentAccountNames: string[];
  manual401kAccountNames: string[];
  monthly401kContribution: number;
  monthlyInvestmentContribution: number;
  totalLiabilityPayments: number;
}

function formatCurrency(val: number): string {
  if (val === 0) return "-";
  const abs = Math.abs(val);
  if (abs >= 1000) return `${val < 0 ? "-" : ""}$${(abs / 1000).toFixed(1)}k`;
  return `${val < 0 ? "-" : ""}$${abs.toFixed(0)}`;
}

function formatMonthLabel(month: string): string {
  const [y, m] = month.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[parseInt(m) - 1]} ${y.slice(2)}`;
}

function SectionHeader({ label, expanded, onToggle, color }: { label: string; expanded: boolean; onToggle: () => void; color: string }) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1.5 w-full text-left py-1 hover:bg-muted/50 rounded px-1"
      data-testid={`forecast-section-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
      <div className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
      <span className="font-medium text-xs truncate">{label}</span>
    </button>
  );
}

function cellBg(m: ForecastMonth): string {
  if (m.isCurrent) return "bg-primary/5";
  if (m.isPast) return "bg-muted/20";
  return "";
}

export function ForecastContent() {
  const [monthCount, setMonthCount] = useState(12);
  const [growthRate, setGrowthRate] = useState(7);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["income", "expenses", "summary"]));
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentMonthRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error } = useQuery<ForecastData>({
    queryKey: ["/api/finance/forecast", `?months=${monthCount}&pastMonths=3&growthRate=${growthRate}`],
  });

  const scrolledToCurrentMonth = useRef(false);
  if (data && !scrolledToCurrentMonth.current && currentMonthRef.current && scrollRef.current) {
    scrolledToCurrentMonth.current = true;
    setTimeout(() => {
      currentMonthRef.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }, 100);
  }

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const netWorthTrend = useMemo(() => {
    if (!data || data.months.length < 2) return null;
    const futureMonths = data.months.filter(m => !m.isPast);
    if (futureMonths.length < 2) return null;
    const first = futureMonths[0].cumulativeNetWorth;
    const last = futureMonths[futureMonths.length - 1].cumulativeNetWorth;
    return last - first;
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="forecast-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground gap-2" data-testid="forecast-error">
        <AlertCircle className="h-5 w-5" />
        <span>Failed to load forecast data</span>
      </div>
    );
  }

  const { months: grid, categories, depositAccounts, liabilityNames, investmentAccountNames, manual401kAccountNames } = data;
  const hasTaxes = grid.some(m => m.taxes > 0);
  const has401k = grid.some(m => m.retirement401k > 0);
  const hasManual401k = grid.some(m => m.manual401kBalance > 0);
  const hasInsurance = grid.some(m => (m.deductions["insurance"] || 0) > 0);
  const hasOtherDed = grid.some(m => (m.deductions["other_deductions"] || 0) > 0);

  return (
    <div className="flex flex-col h-full p-4 gap-4" data-testid="forecast-content">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Financial Forecast</h2>
          {netWorthTrend !== null && (
            <span className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${netWorthTrend >= 0 ? "bg-success/10 text-success-foreground" : "bg-error/10 text-error-foreground"}`}>
              {netWorthTrend >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {formatCurrency(Math.abs(netWorthTrend))} projected
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground whitespace-nowrap">Forward</Label>
            <div className="flex items-center">
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7 rounded-r-none"
                onClick={() => setMonthCount(prev => Math.max(3, prev - 3))}
                data-testid="forecast-months-decrease"
              >
                <Minus className="h-3 w-3" />
              </Button>
              <div className="h-7 px-2 flex items-center border-y text-xs font-medium min-w-[2rem] justify-center" data-testid="forecast-months-display">
                {monthCount}
              </div>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7 rounded-l-none"
                onClick={() => setMonthCount(prev => Math.min(60, prev + 3))}
                data-testid="forecast-months-increase"
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground whitespace-nowrap">Growth %</Label>
            <Input
              type="number"
              value={growthRate}
              onChange={(e) => setGrowthRate(parseFloat(e.target.value) || 0)}
              className="h-7 w-16 text-xs"
              step={0.5}
              min={0}
              max={30}
              data-testid="input-growth-rate"
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden border rounded-lg bg-card" data-testid="forecast-table-container">
        <div className="overflow-auto h-full" ref={scrollRef}>
          <table className="text-xs border-collapse w-full">
            <thead className="sticky top-0 z-10 bg-card">
              <tr>
                <th className="sticky left-0 z-20 bg-card border-b border-r px-3 py-2 text-left font-medium text-muted-foreground min-w-[180px]">
                  Category
                </th>
                {grid.map(m => (
                  <th
                    key={m.month}
                    ref={m.isCurrent ? currentMonthRef as any : undefined}
                    className={`border-b px-2 py-2 text-center font-medium min-w-[80px] ${m.isCurrent ? "bg-primary/10 text-primary" : m.isPast ? "text-muted-foreground bg-muted/30" : "text-foreground"}`}
                    data-testid={`forecast-month-header-${m.month}`}
                  >
                    {formatMonthLabel(m.month)}
                    {m.isPast && <div className="text-xs font-normal opacity-60">Actual</div>}
                    {m.isCurrent && <div className="text-xs font-normal">Current</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* ---- INCOME ---- */}
              <tr>
                <td className="sticky left-0 z-10 bg-card border-r px-1 py-0">
                  <SectionHeader label="Income" expanded={expandedSections.has("income")} onToggle={() => toggleSection("income")} color="bg-success" />
                </td>
                {grid.map(m => (
                  <td key={m.month} className={`px-2 py-1 text-right font-medium text-success-foreground ${cellBg(m)}`}>
                    {formatCurrency(m.income.net)}
                  </td>
                ))}
              </tr>
              {expandedSections.has("income") && (
                <>
                  <tr className="text-muted-foreground">
                    <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Gross Pay</td>
                    {grid.map(m => (
                      <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                        {formatCurrency(m.income.gross)}
                      </td>
                    ))}
                  </tr>
                  {grid.some(m => m.income.actual !== null) && (
                    <tr className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Actual (Plaid)</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                          {m.income.actual !== null ? formatCurrency(m.income.actual) : "-"}
                        </td>
                      ))}
                    </tr>
                  )}
                </>
              )}

              {/* ---- TAXES ---- */}
              {hasTaxes && (
                <tr className="border-t">
                  <td className="sticky left-0 z-10 bg-card border-r px-1 py-0">
                    <SectionHeader label="Taxes" expanded={expandedSections.has("taxes")} onToggle={() => toggleSection("taxes")} color="bg-warning" />
                  </td>
                  {grid.map(m => (
                    <td key={m.month} className={`px-2 py-1 text-right font-medium text-warning-foreground ${cellBg(m)}`}>
                      {m.taxes > 0 ? `-${formatCurrency(m.taxes)}` : "-"}
                    </td>
                  ))}
                </tr>
              )}
              {hasTaxes && expandedSections.has("taxes") && (
                <tr className="text-muted-foreground">
                  <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Total Tax Withholding</td>
                  {grid.map(m => (
                    <td key={m.month} className={`px-2 py-0.5 text-right text-warning/70 ${cellBg(m)}`}>
                      {m.taxes > 0 ? `-${formatCurrency(m.taxes)}` : "-"}
                    </td>
                  ))}
                </tr>
              )}

              {/* ---- 401K / RETIREMENT ---- */}
              {(has401k || hasManual401k) && (
                <tr className="border-t">
                  <td className="sticky left-0 z-10 bg-card border-r px-1 py-0">
                    <SectionHeader label="401k / Retirement" expanded={expandedSections.has("401k")} onToggle={() => toggleSection("401k")} color="bg-cat-system" />
                  </td>
                  {grid.map(m => (
                    <td key={m.month} className={`px-2 py-1 text-right font-medium text-cat-system-foreground ${cellBg(m)}`}>
                      {m.manual401kBalance > 0 ? formatCurrency(m.manual401kBalance) : m.retirement401k > 0 ? `-${formatCurrency(m.retirement401k)}` : "-"}
                    </td>
                  ))}
                </tr>
              )}
              {(has401k || hasManual401k) && expandedSections.has("401k") && (
                <>
                  {has401k && (
                    <tr className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Monthly Contributions</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right text-cat-system/70 ${cellBg(m)}`}>
                          {m.retirement401k > 0 ? `-${formatCurrency(m.retirement401k)}` : "-"}
                        </td>
                      ))}
                    </tr>
                  )}
                  {(manual401kAccountNames || []).map(name => (
                    <tr key={`401k-${name}`} className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7 truncate max-w-[180px]">{name}</td>
                      {grid.map(m => {
                        const val = m.manual401kBreakdown?.[name] ?? 0;
                        return (
                          <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                            {val > 0 ? formatCurrency(val) : "-"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {data.monthly401kContribution > 0 && (
                    <tr className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Monthly 401k Contribution</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right text-cat-system/70 ${cellBg(m)}`}>
                          {!m.isPast ? formatCurrency(data.monthly401kContribution) : "-"}
                        </td>
                      ))}
                    </tr>
                  )}
                </>
              )}

              {/* ---- OTHER DEDUCTIONS (insurance, etc) ---- */}
              {(hasInsurance || hasOtherDed) && (
                <tr className="border-t">
                  <td className="sticky left-0 z-10 bg-card border-r px-1 py-0">
                    <SectionHeader label="Other Deductions" expanded={expandedSections.has("other_ded")} onToggle={() => toggleSection("other_ded")} color="bg-neutral" />
                  </td>
                  {grid.map(m => {
                    const total = (m.deductions["insurance"] || 0) + (m.deductions["other_deductions"] || 0);
                    return (
                      <td key={m.month} className={`px-2 py-1 text-right font-medium text-neutral-foreground ${cellBg(m)}`}>
                        {total > 0 ? `-${formatCurrency(total)}` : "-"}
                      </td>
                    );
                  })}
                </tr>
              )}
              {(hasInsurance || hasOtherDed) && expandedSections.has("other_ded") && (
                <>
                  {hasInsurance && (
                    <tr className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Insurance</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                          {(m.deductions["insurance"] || 0) > 0 ? `-${formatCurrency(m.deductions["insurance"])}` : "-"}
                        </td>
                      ))}
                    </tr>
                  )}
                  {hasOtherDed && (
                    <tr className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Other</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                          {(m.deductions["other_deductions"] || 0) > 0 ? `-${formatCurrency(m.deductions["other_deductions"])}` : "-"}
                        </td>
                      ))}
                    </tr>
                  )}
                </>
              )}

              {/* ---- EXPENSES ---- */}
              <tr className="border-t">
                <td className="sticky left-0 z-10 bg-card border-r px-1 py-0">
                  <SectionHeader label="Expenses" expanded={expandedSections.has("expenses")} onToggle={() => toggleSection("expenses")} color="bg-error" />
                </td>
                {grid.map(m => (
                  <td key={m.month} className={`px-2 py-1 text-right font-medium text-error-foreground ${cellBg(m)}`}>
                    {m.totalExpenses > 0 ? `-${formatCurrency(m.totalExpenses)}` : "-"}
                  </td>
                ))}
              </tr>
              {expandedSections.has("expenses") && categories.map(cat => (
                <tr key={`exp-${cat}`} className="text-muted-foreground">
                  <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7 truncate max-w-[180px]">{cat}</td>
                  {grid.map(m => (
                    <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                      {m.expenses[cat] ? formatCurrency(m.expenses[cat]) : "-"}
                    </td>
                  ))}
                </tr>
              ))}

              {/* ---- DEPOSITS ---- */}
              {depositAccounts.length > 0 && (
                <>
                  <tr className="border-t">
                    <td className="sticky left-0 z-10 bg-card border-r px-1 py-0">
                      <SectionHeader label="Deposits" expanded={expandedSections.has("deposits")} onToggle={() => toggleSection("deposits")} color="bg-info" />
                    </td>
                    {grid.map(m => {
                      const total = Object.values(m.deposits).reduce((s, v) => s + v, 0);
                      return (
                        <td key={m.month} className={`px-2 py-1 text-right font-medium text-info-foreground ${cellBg(m)}`}>
                          {total > 0 ? formatCurrency(total) : "-"}
                        </td>
                      );
                    })}
                  </tr>
                  {expandedSections.has("deposits") && depositAccounts.map(acct => (
                    <tr key={`dep-${acct}`} className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7 truncate max-w-[180px]">{acct}</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                          {m.deposits[acct] ? formatCurrency(m.deposits[acct]) : "-"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </>
              )}

              {/* ---- INVESTMENTS ---- */}
              <tr className="border-t">
                <td className="sticky left-0 z-10 bg-card border-r px-1 py-0">
                  <SectionHeader label="Investments" expanded={expandedSections.has("investments")} onToggle={() => toggleSection("investments")} color="bg-cat-ai" />
                </td>
                {grid.map(m => (
                  <td key={m.month} className={`px-2 py-1 text-right font-medium text-cat-ai-foreground ${cellBg(m)}`}>
                    {formatCurrency(m.investments + m.manual401kBalance)}
                  </td>
                ))}
              </tr>
              {expandedSections.has("investments") && (
                <>
                  {investmentAccountNames.map(name => (
                    <tr key={`inv-${name}`} className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7 truncate max-w-[180px]">{name}</td>
                      {grid.map(m => {
                        const val = m.investmentBreakdown?.[name] ?? 0;
                        return (
                          <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                            {val > 0 ? formatCurrency(val) : "-"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {(manual401kAccountNames || []).map(name => (
                    <tr key={`inv-401k-${name}`} className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7 truncate max-w-[180px]">{name}</td>
                      {grid.map(m => {
                        const val = m.manual401kBreakdown?.[name] ?? 0;
                        return (
                          <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                            {val > 0 ? formatCurrency(val) : "-"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {data.monthly401kContribution > 0 && (
                    <tr className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Monthly 401k Contribution</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right text-cat-ai/70 ${cellBg(m)}`}>
                          {!m.isPast ? formatCurrency(data.monthly401kContribution) : "-"}
                        </td>
                      ))}
                    </tr>
                  )}
                  {data.monthlyInvestmentContribution > 0 && (
                    <tr className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Monthly Contribution</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right text-cat-ai/70 ${cellBg(m)}`}>
                          {!m.isPast ? formatCurrency(data.monthlyInvestmentContribution) : "-"}
                        </td>
                      ))}
                    </tr>
                  )}
                </>
              )}

              {/* ---- ASSETS ---- */}
              <tr className="border-t">
                <td className="sticky left-0 z-10 bg-card border-r px-1 py-0">
                  <SectionHeader label="Assets" expanded={expandedSections.has("assets")} onToggle={() => toggleSection("assets")} color="bg-success" />
                </td>
                {grid.map(m => (
                  <td key={m.month} className={`px-2 py-1 text-right font-medium text-success-foreground ${cellBg(m)}`}>
                    {formatCurrency(m.assets)}
                  </td>
                ))}
              </tr>
              {expandedSections.has("assets") && (
                <>
                  <tr className="text-muted-foreground">
                    <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Cash Balance</td>
                    {grid.map(m => (
                      <td key={m.month} className={`px-2 py-0.5 text-right ${m.cashBalance >= 0 ? "text-success-foreground/70" : "text-error/70"} ${cellBg(m)}`}>
                        {formatCurrency(m.cashBalance)}
                      </td>
                    ))}
                  </tr>
                  {grid.some(m => m.financedAssetValue > 0) && (
                    <tr className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Financed Assets</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                          {m.financedAssetValue > 0 ? formatCurrency(m.financedAssetValue) : "-"}
                        </td>
                      ))}
                    </tr>
                  )}
                  {grid.some(m => m.manualAssetValue > 0) && (
                    <tr className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7" data-testid="label-manual-assets">Manual Assets</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`} data-testid={`value-manual-assets-${m.month}`}>
                          {m.manualAssetValue > 0 ? formatCurrency(m.manualAssetValue) : "-"}
                        </td>
                      ))}
                    </tr>
                  )}
                </>
              )}

              {/* ---- LIABILITIES ---- */}
              <tr className="border-t">
                <td className="sticky left-0 z-10 bg-card border-r px-1 py-0">
                  <SectionHeader label="Liabilities" expanded={expandedSections.has("liabilities")} onToggle={() => toggleSection("liabilities")} color="bg-cat-event" />
                </td>
                {grid.map(m => (
                  <td key={m.month} className={`px-2 py-1 text-right font-medium text-cat-event-foreground ${cellBg(m)}`}>
                    {m.liabilities > 0 ? `-${formatCurrency(m.liabilities)}` : "-"}
                  </td>
                ))}
              </tr>
              {expandedSections.has("liabilities") && (
                <>
                  {liabilityNames.map((name, idx) => (
                    <tr key={`lia-${idx}-${name}`} className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7 truncate max-w-[180px]">{name}</td>
                      {grid.map(m => {
                        const bal = m.liabilityBreakdown?.[name] ?? 0;
                        return (
                          <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                            {bal > 0 ? formatCurrency(bal) : "-"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {grid.some(m => m.financedLoanBalance > 0) && (
                    <tr className="text-muted-foreground">
                      <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Financed Asset Loans</td>
                      {grid.map(m => (
                        <td key={m.month} className={`px-2 py-0.5 text-right ${cellBg(m)}`}>
                          {m.financedLoanBalance > 0 ? formatCurrency(m.financedLoanBalance) : "-"}
                        </td>
                      ))}
                    </tr>
                  )}
                  <tr className="text-muted-foreground">
                    <td className="sticky left-0 z-10 bg-card border-r px-3 py-0.5 pl-7">Monthly Debt Payments</td>
                    {grid.map(m => (
                      <td key={m.month} className={`px-2 py-0.5 text-right text-cat-event/70 ${cellBg(m)}`}>
                        {m.totalDebtPayments > 0 ? `-${formatCurrency(m.totalDebtPayments)}` : "-"}
                      </td>
                    ))}
                  </tr>
                </>
              )}

              {/* ---- SUMMARY ROWS ---- */}
              <tr className="border-t-2 border-primary/20 bg-muted/20">
                <td className="sticky left-0 z-10 bg-muted/20 border-r px-3 py-1.5 font-semibold text-success-foreground">
                  Total Income
                </td>
                {grid.map(m => {
                  const effectiveIncome = (m.isPast && m.income.actual !== null) ? m.income.actual : m.income.net;
                  return (
                    <td key={m.month} className={`px-2 py-1.5 text-right font-semibold text-success-foreground ${m.isCurrent ? "bg-primary/10" : ""}`}>
                      {formatCurrency(effectiveIncome)}
                    </td>
                  );
                })}
              </tr>
              <tr className="bg-muted/20">
                <td className="sticky left-0 z-10 bg-muted/20 border-r px-3 py-1.5 font-semibold text-error-foreground">
                  Total Expenses
                </td>
                {grid.map(m => (
                  <td key={m.month} className={`px-2 py-1.5 text-right font-semibold text-error-foreground ${m.isCurrent ? "bg-primary/10" : ""}`}>
                    {m.totalExpenses > 0 ? `-${formatCurrency(m.totalExpenses)}` : "-"}
                  </td>
                ))}
              </tr>
              <tr className="bg-muted/30">
                <td className="sticky left-0 z-10 bg-muted/30 border-r px-3 py-1.5 font-semibold flex items-center gap-1.5">
                  <DollarSign className="h-3.5 w-3.5 text-primary" />
                  Net Cash Flow
                </td>
                {grid.map(m => (
                  <td key={m.month} className={`px-2 py-1.5 text-right font-semibold ${m.netCashFlow >= 0 ? "text-success-foreground" : "text-error-foreground"} ${m.isCurrent ? "bg-primary/10" : ""}`}
                    data-testid={`forecast-cashflow-${m.month}`}
                  >
                    {formatCurrency(m.netCashFlow)}
                  </td>
                ))}
              </tr>

              <tr className="border-t bg-primary/5">
                <td className="sticky left-0 z-10 bg-primary/5 border-r px-3 py-1.5 font-semibold flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 text-primary" />
                  Net Worth
                </td>
                {grid.map(m => (
                  <td key={m.month} className={`px-2 py-1.5 text-right font-bold ${m.cumulativeNetWorth >= 0 ? "text-primary" : "text-error-foreground"} ${m.isCurrent ? "bg-primary/10" : ""}`}
                    data-testid={`forecast-networth-${m.month}`}
                  >
                    {formatCurrency(m.cumulativeNetWorth)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
        <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-muted-foreground/30" /> Past = actual transactions</span>
        <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-primary/30" /> Current month</span>
        <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-foreground/20" /> Future = budget projections</span>
        <span>Investment growth: {growthRate}% annual</span>
      </div>
    </div>
  );
}
