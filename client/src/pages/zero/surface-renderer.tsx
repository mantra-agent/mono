import type { SurfaceDescriptor, ComponentDescriptor } from "@shared/models/glasses";
import { TextCard } from "./components/text-card";
import { ActionCard } from "./components/action-card";
import { ListCard } from "./components/list-card";
import { TimerCard } from "./components/timer-card";
import { AlertCard } from "./components/alert-card";
import { TransitionCard } from "./components/transition-card";

const COMPONENT_MAP: Record<string, React.ComponentType<any>> = {
  TextCard,
  ActionCard,
  ListCard,
  TimerCard,
  AlertCard,
  TransitionCard,
};

function renderComponent(descriptor: ComponentDescriptor) {
  const Component = COMPONENT_MAP[descriptor.type];
  if (!Component) return null;

  return (
    <div
      key={descriptor.id}
      className={descriptor.focusable ? "focusable" : undefined}
      data-component-id={descriptor.id}
    >
      <Component {...descriptor.props} />
    </div>
  );
}

interface SurfaceRendererProps {
  descriptor: SurfaceDescriptor | null;
}

export function SurfaceRenderer({ descriptor }: SurfaceRendererProps) {
  // Empty canvas is the default state — dark/nothing is the product working.
  // No TransitionCard, no "you're good" message. Just darkness.
  return (
    <div className="glasses-surface">
      {descriptor?.components.map((component) => renderComponent(component))}
    </div>
  );
}
