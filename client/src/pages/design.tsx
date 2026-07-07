import { usePageHeader } from "@/hooks/use-page-header";
import { DesignTab } from "@/pages/build";

export default function DesignPage() {
  usePageHeader({ title: "Design" });

  return (
    <div className="h-full min-h-0 overflow-auto" data-testid="design-page">
      <DesignTab />
    </div>
  );
}
