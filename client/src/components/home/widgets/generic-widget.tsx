import { Badge } from "@/components/ui/badge";
import type { SimpleFeedItem } from "@shared/models/simple";
import { SimpleCard } from "../home-card";

export function GenericWidget({ item }: { item: SimpleFeedItem }) {
  return (
    <SimpleCard item={item} meta={<Badge variant="outline" className="rounded-sm text-[10px]">{item.widgetType}</Badge>} />
  );
}
