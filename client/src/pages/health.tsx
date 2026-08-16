import { usePageHeader } from "@/hooks/use-page-header";
import { HealthIndex } from "@/components/wellness/health-index";

export default function HealthPage() {
  usePageHeader({ title: "Health" });
  return <HealthIndex />;
}
