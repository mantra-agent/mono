import { usePageHeader } from "@/hooks/use-page-header";
import StrategyDecisionsTab from "./strategy-decisions-tab";

export default function DecisionsPage() {
  usePageHeader({ title: "Decisions" });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StrategyDecisionsTab />
    </div>
  );
}
