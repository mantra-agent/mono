/** Agent's canonical voice visual state shared by meeting and client transports. */
export type AgentVisualState =
  | "idle"
  | "listening"
  | "thinking"
  | "tool_call"
  | "speaking"
  | "degraded";

export type AgentVisualizerEvent =
  | {
      type: "agent.state";
      state: AgentVisualState;
      sequence: number;
      occurredAt: number;
    }
  | {
      type: "audio.level";
      level: number;
      sequence: number;
      occurredAt: number;
    };
