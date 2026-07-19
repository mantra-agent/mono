export type EventCategory =
  | "agent"
  | "system"
  | "session"
  | "channel"
  | "chat"
  | "gateway"
  | "tool"
  | "timer"
  | "responsibility"
  | "memory"
  | "strategy"
  | "voice"
  | "thought"
  | "user";

export const EventCategories = {
  AGENT: "agent" as const,
  SYSTEM: "system" as const,
  SESSION: "session" as const,
  CHANNEL: "channel" as const,
  CHAT: "chat" as const,
  GATEWAY: "gateway" as const,
  TOOL: "tool" as const,
  TIMER: "timer" as const,
  RESPONSIBILITY: "responsibility" as const,
  MEMORY: "memory" as const,
  STRATEGY: "strategy" as const,
  VOICE: "voice" as const,
  THOUGHT: "thought" as const,
  USER: "user" as const,
};

export const AgentEvents = {
  THINKING: "agent.thinking",
  RUN_START: "agent.run.start",
  RUN_COMPLETE: "agent.run.complete",
  RUN_ABORTED: "agent.run.aborted",
  RUN_ERROR: "agent.run.error",
  STARTED: "agent.started",
  STOPPED: "agent.stopped",
  TOOL_CALL: "agent.tool_call",
  TOOL_RESULT: "agent.tool_result",
  DATA_PEOPLE_CHANGED: "data:people_changed",

  DATA_RULE_CREATED: "data:rule_created",
  DATA_RULE_UPDATED: "data:rule_updated",
} as const;

export const ChatEvents = {
  STREAM: "chat.stream",
} as const;

export const SystemEvents = {
  PULSE: "pulse",
  COMMAND: "system:command",
  TACTICAL_DECIDED: "tactical:decided",
  TACTICAL_EXECUTED: "tactical:executed",
  TACTICAL_ERROR: "tactical:error",
  TACTICAL_SKIPPED: "tactical:skipped",
  TACTICAL_APPROVAL_NEEDED: "tactical:approval-needed",
  TACTICAL_ESCALATED: "tactical:escalated",
  TACTICAL_EXECUTION_ERROR: "tactical:execution-error",
  OODA_ORIENT_ERROR: "ooda:orient-error",
  OODA_DECIDE_ERROR: "ooda:decide-error",
} as const;

export const MemoryEvents = {
  ENTRIES_CHANGED: "entries_changed",
} as const;

export const ThoughtEvents = {
  STREAM: "thought.stream",
} as const;

export const VoiceEvents = {
  SESSION_END: "session_end",
  PHASE: "voice_phase",
  TOOLS_CLEARED: "voice_tools_cleared",
  DIAGNOSTIC_STEP: "voice_diagnostic_step",
} as const;

export const SYSTEM_STEP_META: Record<string, { label: string }> = {
  orientation: { label: "Orientation" },
  orientation_prepare: { label: "Load Router" },
  orientation_llm_call: { label: "Orientation LLM" },
  orientation_apply: { label: "Apply Orientation" },
  model_selection: { label: "Model Selection" },
  context_assembly: { label: "Context Assembly" },
  ctx_history: { label: "Loading History" },
  ctx_history_load: { label: "History: DB Load" },
  ctx_history_tokens: { label: "History: Token Estimate" },
  ctx_history_repair: { label: "History: Payload Repair" },
  ctx_history_compact: { label: "History: Compaction" },
  ctx_wm_identity: { label: "Identity & Voice" },
  ctx_wm_people: { label: "People" },
  ctx_pri_goals: { label: "Goals" },
  ctx_pri_today: { label: "Today's Priorities" },
  ctx_pri_week: { label: "Weekly Priorities" },
  ctx_pri_month: { label: "Monthly Priorities" },

  ctx_pri_principles: { label: "Principles" },
  ctx_pri_rules: { label: "Rules" },
  ctx_pri_journal: { label: "Journal" },
  ctx_wm_work: { label: "Active Work" },
  ctx_wm_calendar: { label: "Calendar" },
  ctx_wm_session: { label: "Session Context" },
  ctx_memory: { label: "Memory Retrieval" },
  ctx_skills_tools: { label: "Skills & Tools" },
  ctx_render: { label: "Assembling Prompt" },
  turn: { label: "Turn" },
  llm_call: { label: "Response" },
  llm_request_sent: { label: "Build & Dispatch Request" },
  llm_wait_provider: { label: "Wait for Provider" },
  llm_wait_first_token: { label: "Wait for First Token" },
  llm_receive_stream: { label: "Receive Output Stream" },
  llm_finalize: { label: "Finalize Inference" },
  llm_connected: { label: "Connected" },
  llm_headers: { label: "Headers Received" },
  compaction: { label: "Compaction" },
  working_context_compression: { label: "Working Context Compressed" },
  first_token: { label: "First Token" },
  thinking: { label: "Thinking" },
  tool_use: { label: "Tool Use" },
  context_assembly_voice: { label: "Context Assembly" },
  greeting_history_load: { label: "Loading Chat History" },
  greeting_model_select: { label: "Model Selection" },
  greeting_llm_call: { label: "Generating Greeting" },
  signed_url: { label: "Signed URL" },
  contextAssembly: { label: "Context Assembly" },
  signedUrl: { label: "Signed URL" },
  voice_turn_boundary: { label: "Turn Boundary" },
  voice_context_assembly: { label: "Context Assembly" },
  voice_filler_sent: { label: "Filler Sent" },
  voice_llm_first_delta: { label: "First Token" },
  voice_llm_timeout: { label: "LLM Timeout" },
  voice_turn_complete: { label: "Turn Complete" },
  voice_turn_aborted: { label: "Turn Aborted" },
  voice_circuit_breaker: { label: "Circuit Breaker" },
  voice_backpressure: { label: "Backpressure" },
  voice_session_health: { label: "Session Health" },
  voice_duplicate_message: { label: "Duplicate Message" },
  voice_error: { label: "Voice Error" },
  voice_disconnect: { label: "Disconnected" },
  voice_reconnect_attempt: { label: "Reconnect Attempt" },
  voice_reconnect_result: { label: "Reconnect Result" },
  voice_reconnect_exhausted: { label: "Reconnect Failed" },
  voice_grace_window: { label: "Grace Window" },
  voice_prefix_continuation: { label: "Prefix Continuation" },
  voice_recovery: { label: "Recovering…" },
};
