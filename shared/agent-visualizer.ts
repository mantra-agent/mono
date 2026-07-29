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
    }
  | {
      // Barge-in stop signal: the agent's in-flight speech was preempted. The
      // visualizer page must immediately halt and tear down its buffered
      // <audio> playback, since destroying the server stream alone leaves
      // already-delivered audio playing in the element.
      type: "speech.interrupt";
      reason: string;
      sequence: number;
      occurredAt: number;
    };
