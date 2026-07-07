import { SimpleFeedContent } from "@/components/home/home-feed-content";

/**
 * Minimal page for the /session route.
 * The FocusWidget overlay handles the actual session UI.
 * Render Simple behind it so FTUE tool-created goals/priorities have a live
 * surface mounted during the first conversation instead of only appearing
 * after the user manually navigates Home.
 */
export default function SessionPage() {
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
      <div className="flex-1 overflow-y-auto">
        <SimpleFeedContent />
      </div>
    </div>
  );
}
