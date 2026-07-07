import type { SimpleFeedItem } from "@shared/models/simple";
import { SimpleCard } from "../home-card";

export function StateWidget({ item }: { item: SimpleFeedItem }) {
  return (
    <SimpleCard item={item}>
      <div>Simple is quiet. Nothing needs to be forced into the feed.</div>
    </SimpleCard>
  );
}
