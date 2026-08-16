import { usePageHeader } from "@/hooks/use-page-header";
import { CalendarContent } from "@/components/wellness/calendar-content";

export default function HabitsPage() {
  usePageHeader({ title: "Habits" });

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CalendarContent />
      </div>
    </div>
  );
}
