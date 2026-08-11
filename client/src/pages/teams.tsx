import { TeamsPanel } from "@/components/teams/teams-panel";
import { usePageHeader } from "@/hooks/use-page-header";

export default function TeamsPage() {
  usePageHeader({ title: "Teams" });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6 scrollbar-thin">
      <TeamsPanel />
    </div>
  );
}
