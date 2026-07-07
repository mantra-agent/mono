export type SensorType = "event_bus" | "email" | "calendar_change";

export interface Sensor {
  id: string;
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  enabled: boolean;
  lastChecked: string | null;
}

export interface Perception {
  id: string;
  timestamp: string;
  source: string;
  type: SensorType;
  summary: string;
  raw: unknown;
  urgency: number;
}

export interface Picture {
  id: string;
  timestamp: string;
  perceptionId: string;
  situation: string;
  relevantContext: string;
  implication: string;
  significance?: "routine" | "notable" | "urgent";
  connectedIntentions?: string[];
  beliefRelevant?: boolean;
  intentionRelevant?: boolean;
}
