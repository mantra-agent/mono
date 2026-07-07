import { usePageHeader } from "@/hooks/use-page-header";
import { CalendarContent } from "@/components/wellness/calendar-content";


export default function WellnessPage() {
  usePageHeader({ title: "Wellness" });

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto min-h-0"><CalendarContent /></div>
    </div>
  );
}
