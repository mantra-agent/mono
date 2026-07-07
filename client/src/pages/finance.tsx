import { useState, useEffect, useCallback } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { Home, ArrowLeftRight, Landmark, CreditCard, RefreshCw, Target, Wallet, Tag, TrendingUp, Briefcase, Car } from "lucide-react";
import { FinanceHomeContent } from "@/components/finance/finance-home";
import { TransactionsContent } from "@/components/finance/transactions-content";
import { AccountsContent } from "@/components/finance/accounts-content";
import { LiabilitiesContent } from "@/components/finance/liabilities-content";
import { RecurringContent } from "@/components/finance/recurring-content";
import { GoalsContent } from "@/components/finance/goals-content";
import { BudgetContent } from "@/components/finance/budget-content";
import { CategoriesContent } from "@/components/finance/categories-content";
import { IncomeContent } from "@/components/finance/income-content";
import { ForecastContent } from "@/components/finance/forecast-content";
import { InvestmentsContent } from "@/components/finance/investments-content";
import { AssetsContent } from "@/components/finance/assets-content";
import {
  markFinanceVisited,
  financeTabVisitedKey,
  FINANCE_LAST_VISITED_KEY,
  type FinanceAreaKey,
} from "@/components/finance/finance-activity-indicator";

const financeTabsBase: Array<{
  value: FinanceAreaKey;
  label: string;
  icon: JSX.Element;
  testId: string;
}> = [
  { value: "home", label: "Home", icon: <Home className="h-3.5 w-3.5" />, testId: "tab-finance-home" },
  { value: "goals", label: "Goals", icon: <Target className="h-3.5 w-3.5" />, testId: "tab-finance-goals" },
  { value: "budget", label: "Monthly", icon: <Wallet className="h-3.5 w-3.5" />, testId: "tab-finance-budget" },
  { value: "recurring", label: "Recurring", icon: <RefreshCw className="h-3.5 w-3.5" />, testId: "tab-finance-recurring" },
  { value: "liabilities", label: "Liabilities", icon: <CreditCard className="h-3.5 w-3.5" />, testId: "tab-finance-liabilities" },
  { value: "transactions", label: "Transactions", icon: <ArrowLeftRight className="h-3.5 w-3.5" />, testId: "tab-finance-transactions" },
  { value: "accounts", label: "Accounts", icon: <Landmark className="h-3.5 w-3.5" />, testId: "tab-finance-accounts" },
  { value: "investments", label: "Investments", icon: <Briefcase className="h-3.5 w-3.5" />, testId: "tab-finance-investments" },
  { value: "assets", label: "Assets", icon: <Car className="h-3.5 w-3.5" />, testId: "tab-finance-assets" },
  { value: "forecast", label: "Forecast", icon: <TrendingUp className="h-3.5 w-3.5" />, testId: "tab-finance-forecast" },
  { value: "categories", label: "Categories", icon: <Tag className="h-3.5 w-3.5" />, testId: "tab-finance-categories" },
];

export default function FinancePage() {
  const validTabs = new Set<FinanceAreaKey>(financeTabsBase.map(t => t.value));

  const readUrlParams = useCallback((): { tab: FinanceAreaKey } => {
    const params = new URLSearchParams(window.location.search);
    let tab = params.get("tab") || "home";
    if (tab === "income") tab = "budget";
    return { tab: validTabs.has(tab as FinanceAreaKey) ? (tab as FinanceAreaKey) : "home" };
  }, []);

  const initial = readUrlParams();
  const [activeTab, setActiveTab] = useState<FinanceAreaKey>(initial.tab);

  useEffect(() => {
    markFinanceVisited(FINANCE_LAST_VISITED_KEY);
  }, []);

  useEffect(() => {
    markFinanceVisited(financeTabVisitedKey(activeTab));
  }, [activeTab]);

  useEffect(() => {
    const syncFromUrl = () => {
      const p = readUrlParams();
      setActiveTab(p.tab);
    };
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [readUrlParams]);

  const handleTabChange = useCallback((tab: string) => {
    const normalized = tab === "income" ? "budget" : tab;
    setActiveTab(normalized as FinanceAreaKey);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", normalized);
    window.history.pushState({}, "", url.toString());
  }, []);

  const financeTabs = financeTabsBase.map(tab => ({
    ...tab,
    indicatorKey: `finance-${tab.value}`,
  }));

  usePageHeader({
    title: "Finance",
    tabs: financeTabs,
    activeTab,
    onTabChange: handleTabChange,
  });

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {activeTab === "home" && <div className="flex-1 overflow-y-auto min-h-0"><FinanceHomeContent onTabChange={handleTabChange} /></div>}
      {activeTab === "transactions" && <div className="flex-1 overflow-y-auto min-h-0"><TransactionsContent /></div>}
      {activeTab === "accounts" && <div className="flex-1 overflow-y-auto min-h-0"><AccountsContent /></div>}
      {activeTab === "investments" && <div className="flex-1 overflow-y-auto min-h-0"><InvestmentsContent /></div>}
      {activeTab === "assets" && <div className="flex-1 overflow-y-auto min-h-0"><AssetsContent /></div>}
      {activeTab === "liabilities" && <div className="flex-1 overflow-y-auto min-h-0"><LiabilitiesContent /></div>}
      {activeTab === "recurring" && <div className="flex-1 overflow-y-auto min-h-0"><RecurringContent /></div>}
      {activeTab === "goals" && <div className="flex-1 overflow-y-auto min-h-0"><GoalsContent /></div>}
      {activeTab === "budget" && (
        <div className="flex-1 overflow-y-auto min-h-0">
          <IncomeContent />
          <BudgetContent />
        </div>
      )}
      {activeTab === "forecast" && <div className="flex-1 overflow-y-auto min-h-0"><ForecastContent /></div>}
      {activeTab === "categories" && <div className="flex-1 overflow-y-auto min-h-0"><CategoriesContent /></div>}
    </div>
  );
}
