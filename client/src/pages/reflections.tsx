import { usePageHeader } from "@/hooks/use-page-header";
import { JournalIndex } from "@/components/wellness/journal-index";

export default function ReflectionsPage() {
  usePageHeader({ title: "Reflections" });
  return <JournalIndex kind="reflection" />;
}
