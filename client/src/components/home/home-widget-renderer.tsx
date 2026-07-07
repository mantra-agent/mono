import type { SimpleFeedItem } from "@shared/models/simple";
import { PriorityTaskWidget } from "./widgets/priority-task-widget";
import { StateWidget } from "./widgets/state-widget";
import { MeetingWidget } from "./widgets/meeting-widget";
import { ProjectWidget } from "./widgets/project-widget";
import { InboxItemWidget } from "./widgets/inbox-item-widget";
import { WellnessWidget } from "./widgets/wellness-widget";
import { PersonWidget } from "./widgets/person-widget";
import { SimpleTreeRow } from "./home-tree-row";

/**
 * Renders each item as a tree row (time + checkbox + chevron + content).
 * Type-specific widgets provide the inline content.
 */
export function SimpleWidgetRenderer({ item, depth = 0 }: { item: SimpleFeedItem; depth?: number }) {
  const content = getInlineContent(item);

  // State widget is a special full-width display, not a tree row
  if (item.widgetType === "state") return <StateWidget item={item} />;

  return (
    <SimpleTreeRow item={item} depth={depth}>
      {content}
    </SimpleTreeRow>
  );
}

/** Get inline content for each widget type, or null to use default title/reference */
function getInlineContent(item: SimpleFeedItem) {
  switch (item.widgetType) {
    case "priority_task": return <PriorityTaskWidget item={item} inline />;
    case "meeting": return <MeetingWidget item={item} inline />;
    case "project": return <ProjectWidget item={item} inline />;
    case "inbox_item": return <InboxItemWidget item={item} inline />;
    case "wellness": return <WellnessWidget item={item} inline />;
    case "person": return <PersonWidget item={item} inline />;
    // These use default title/reference rendering from SimpleTreeRow
    case "decision_prompt":
    case "communication":
    case "generic":
    default:
      return null; // SimpleTreeRow renders its own default content
  }
}
