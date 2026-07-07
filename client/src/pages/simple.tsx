// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { usePageHeader } from "@/hooks/use-page-header";
import { SimpleFeedContent } from "@/components/home/home-feed-content";

const log = createLogger("HomePage");

export default function HomePage() {
  usePageHeader({ title: "" });
  log.debug("render Home page");
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <SimpleFeedContent />
      </div>
    </div>
  );
}
