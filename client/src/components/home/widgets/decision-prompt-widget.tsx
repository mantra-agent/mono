import { GenericWidget } from "./generic-widget";
import type { SimpleFeedItem } from "@shared/models/simple";

export function PlaceholderWidget({ item }: { item: SimpleFeedItem }) {
  return <GenericWidget item={item} />;
}
