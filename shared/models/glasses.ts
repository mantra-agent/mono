// Glasses Surface types — shared between server Cortex and client renderers

export interface SurfaceDescriptor {
  version: 1;
  timestamp: string;
  components: ComponentDescriptor[];
  reasoning?: CortexReasoning;
}

export type ComponentType =
  | "TextCard"
  | "ActionCard"
  | "ListCard"
  | "TimerCard"
  | "AlertCard"
  | "TransitionCard";

export interface ComponentDescriptor {
  type: ComponentType;
  id: string;
  focusable: boolean;
  props:
    | TextCardProps
    | ActionCardProps
    | ListCardProps
    | TimerCardProps
    | AlertCardProps
    | TransitionCardProps;
}

export interface TextCardProps {
  title: string;
  subtitle?: string;
  icon?: string;
  urgency?: "low" | "medium" | "high" | "critical";
}

export interface ActionCardProps {
  label: string;
  action: string;
  icon?: string;
  variant?: "primary" | "secondary";
}

export interface ListCardProps {
  title: string;
  items: Array<{ label: string; meta?: string; icon?: string }>;
  maxVisible?: number;
}

export interface TimerCardProps {
  label: string;
  targetTime: string;
  format: "countdown" | "elapsed" | "time";
}

export interface AlertCardProps {
  message: string;
  severity: "info" | "warning" | "critical";
  dismissible: boolean;
}

export interface TransitionCardProps {
  message: string;
  duration?: number;
}

export interface CortexReasoning {
  contextSnapshot: string;
  reasoning: string;
  decision: "nothing" | "surface";
  computedAt: string;
  modelUsed: string;
  sessionOwned: boolean;
  owningSessionId?: string;
}
