import { usePageHeader } from "@/hooks/use-page-header";
import { JournalIndex } from "@/components/wellness/journal-index";

export default function GratitudePage() {
  usePageHeader({ title: "Gratitude" });
  return <JournalIndex kind="gratitude" />;
}
