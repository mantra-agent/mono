import PersonasContent from "./persona-tab";
import { usePageHeader } from "@/hooks/use-page-header";

export default function PersonasPage() {
  usePageHeader({ title: "Personas" });
  return (
    <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
      <PersonasContent />
    </div>
  );
}
