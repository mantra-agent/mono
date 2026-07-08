import { usePageHeader } from "@/hooks/use-page-header";
import StrategyListTab from "./strategy-list-tab";

export default function StrategyPage() {
  usePageHeader({ title: "Strategy" });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StrategyListTab />
    </div>
  );
}
