import { Suspense } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { Loader2 } from "lucide-react";
import { lazyWithRetry } from "@/lib/lazy-with-retry";

const OpportunitiesTab = lazyWithRetry(() => import("@/pages/profile-opportunities-tab"));

function TabFallback() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

export default function PipelinesPage() {
  usePageHeader({ title: "Pipelines" });

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <Suspense fallback={<TabFallback />}>
        <OpportunitiesTab />
      </Suspense>
    </div>
  );
}
