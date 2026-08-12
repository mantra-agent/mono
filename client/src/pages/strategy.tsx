import { usePageHeader } from "@/hooks/use-page-header";
import StrategyListTab from "./strategy-list-tab";

export default function ScenariosPage() {
  usePageHeader({ title: "Scenarios" });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StrategyListTab />
    </div>
  );
}
