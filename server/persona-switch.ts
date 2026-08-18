/**
 * Session persona re-orient — shared detection + run refresh.
 *
 * Detection belongs at the tool boundary (executeTool): every origin that
 * calls orient must stamp continuation "persona_switch" when the session
 * personaId actually changes. User pins still win inside orient (no id
 * change → no continuation).
 *
 * Refresh belongs on the executor when the run has a sessionId: re-resolve
 * routing, system prompt, tools, and persona identity. Callers must not
 * paper this with optional plugins or chat-only wrappers.
 */
import { createLogger } from "./log";
import type { ModelRoutingDecision } from "./model-routing";
import type { ToolDefinition } from "./tool-registry";
import type { PersonaSnapshot } from "@shared/models/chat";
import { ACTIVITY_VOICE, ACTIVITY_VOICE_GREETING, type ActivityId } from "./job-profiles";
import type { ToolInvocationOrigin, TrustedEngineeringDelegation } from "./agent-authority";
import type { ContextCallType } from "@shared/context-spine";

const log = createLogger("PersonaSwitch");

export type PersonaSwitchRefreshResult = {
  routingDecision: ModelRoutingDecision;
  systemPrompt: string;
  tools: ToolDefinition[];
  persona?: PersonaSnapshot;
};

export type PersonaSwitchRefreshOptions = {
  sessionId: string;
  activity: ActivityId | string;
  contextBuildId: string;
  /** Tool authority origin for the run. Defaults from activity when omitted. */
  origin?: ToolInvocationOrigin;
  trustedDelegation?: TrustedEngineeringDelegation;
  skillId?: string;
  skillName?: string;
  mayInitiateConversation?: boolean;
  runtimeRunId?: string;
  runtimeAttemptId?: string;
  sessionKey?: string;
  /** Context assembly profile. Defaults from origin/activity. */
  profile?: "chat" | "voice" | "background";
  /** Skill spine options (autonomous). When set, uses contextBuilder.resolve. */
  callType?: ContextCallType;
  includeSections?: string[];
  excludeSections?: string[];
  conversationHistory?: Array<{
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    toolCallId?: string;
    toolCalls?: unknown[];
    thinking?: string;
  }>;
  currentMessage?: string;
  meetingContext?: string;
};

/**
 * After a successful orient that requested a persona, compare session
 * personaId before/after. Returns "persona_switch" only when the pin moved.
 */
export async function detectOrientPersonaSwitch(args: {
  toolName: string;
  requestedPersona: unknown;
  sessionId: string | undefined | null;
  previousPersonaId: number | null | undefined;
  error?: boolean;
}): Promise<"persona_switch" | undefined> {
  if (args.toolName !== "orient") return undefined;
  if (args.requestedPersona === undefined || args.requestedPersona === null || args.requestedPersona === "") {
    return undefined;
  }
  if (args.error) return undefined;
  const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
  if (!sessionId) return undefined;

  const { chatFileStorage } = await import("./chat-file-storage");
  const session = await chatFileStorage.getSession(sessionId);
  const nextPersonaId = session?.personaId;
  if (nextPersonaId == null) return undefined;
  if (args.previousPersonaId != null && nextPersonaId === args.previousPersonaId) {
    return undefined;
  }
  return "persona_switch";
}

function defaultOrigin(activity: string, explicit?: ToolInvocationOrigin): ToolInvocationOrigin {
  if (explicit) return explicit;
  if (activity === ACTIVITY_VOICE || activity === ACTIVITY_VOICE_GREETING) return "voice";
  return "autonomous";
}

function defaultProfile(
  origin: ToolInvocationOrigin,
  explicit?: "chat" | "voice" | "background",
): "chat" | "voice" | "background" {
  if (explicit) return explicit;
  if (origin === "voice") return "voice";
  if (origin === "interactive" || origin === "slack_ingress" || origin === "timer") return "chat";
  return "background";
}

async function resolveToolsForSession(options: PersonaSwitchRefreshOptions, origin: ToolInvocationOrigin): Promise<ToolDefinition[]> {
  const { getToolSchemas } = await import("./tool-registry");
  const { filterToolSchemasForAuthority } = await import("./agent-authority");
  const { filterModToolSchemas } = await import("./mods/mod-access");
  const { requireCurrentPrincipal } = await import("./principal-context");
  const { filterToolsForPersonaBundle } = await import("./tool-registry");
  const { resolveSessionPersonaComposition } = await import("./session-persona");

  const authority = filterToolSchemasForAuthority(getToolSchemas(), {
    origin,
    trustedDelegation: options.trustedDelegation,
    activity: options.activity,
    skillId: options.skillId,
    skillName: options.skillId ? options.skillName : undefined,
    mayInitiateConversation: options.mayInitiateConversation,
    runtimeRunId: options.runtimeRunId,
    runtimeAttemptId: options.runtimeAttemptId,
    sessionKey: options.sessionKey,
    sessionId: options.sessionId,
  });
  const modScoped = await filterModToolSchemas(requireCurrentPrincipal(), authority);
  const definitions: ToolDefinition[] = modScoped.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  // Interactive / voice honor persona tool bundles. Autonomous skill runs
  // historically expose the full authority set (empty bundle = passthrough).
  if (origin === "interactive" || origin === "slack_ingress" || origin === "voice" || origin === "timer") {
    const { toolBundle } = await resolveSessionPersonaComposition(options.sessionId, { persistFallback: false });
    return filterToolsForPersonaBundle(definitions, toolBundle);
  }
  return definitions;
}

/**
 * Re-resolve routing, system prompt, tools, and persona after orient switches
 * the session seat. Requires a sessionId — fail closed without one.
 */
export async function refreshRunAfterPersonaSwitch(
  options: PersonaSwitchRefreshOptions,
): Promise<PersonaSwitchRefreshResult> {
  const sessionId = options.sessionId?.trim();
  if (!sessionId) {
    throw new Error("Persona switch refresh requires a sessionId");
  }

  const origin = defaultOrigin(String(options.activity), options.origin);
  const { resolveModelCandidates } = await import("./model-routing");
  const { normalizeSessionModelTierOverride } = await import("./session-model-tier-override");
  const { chatFileStorage } = await import("./chat-file-storage");
  const { resolveSessionPersonaSnapshot } = await import("./session-persona");

  const session = await chatFileStorage.getSession(sessionId);
  const sessionTierOverride = normalizeSessionModelTierOverride(session?.modelTier);
  const routingDecision = (
    await resolveModelCandidates(
      options.activity as ActivityId,
      sessionTierOverride
        ? {
            semanticTierOverride: sessionTierOverride,
            overrideReason: "session model tier override",
            sessionId,
          }
        : { sessionId },
    )
  )[0];

  const tools = await resolveToolsForSession({ ...options, sessionId }, origin);

  let systemPrompt: string;
  if (options.callType) {
    const { contextBuilder } = await import("./context-builder");
    const spine = await contextBuilder.resolve({
      callType: options.callType,
      llmMode: origin === "voice" ? "voice" : "text",
      activity: options.activity as ActivityId,
      sessionId,
      contextBuildId: options.contextBuildId,
      includeSections: options.includeSections,
      excludeSections: options.excludeSections,
      toolDefinitions: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    });
    systemPrompt = contextBuilder.renderToPrompt(spine);
  } else {
    const { assembleContext } = await import("./agent-context");
    let meetingContext = options.meetingContext;
    if (!meetingContext && session?.type === "meeting" && session.meeting) {
      try {
        const { buildMeetingContextPacket, renderMeetingContextPacket } = await import("./meeting/context-packet");
        const packet = await buildMeetingContextPacket(session.meeting);
        meetingContext = packet ? renderMeetingContextPacket(packet) : undefined;
      } catch (err) {
        log.warn(
          `meeting context degraded sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const refreshed = await assembleContext({
      profile: defaultProfile(origin, options.profile),
      conversationHistory: options.conversationHistory as Parameters<typeof assembleContext>[0]["conversationHistory"],
      toolDefinitions: tools.map((tool) => ({ name: tool.name, description: tool.description })),
      model: routingDecision.modelString,
      activity: options.activity as ActivityId,
      sessionId,
      contextBuildId: options.contextBuildId,
      currentMessage: options.currentMessage,
      meetingContext,
      includeSections: options.includeSections,
      excludeSections: options.excludeSections,
    });
    systemPrompt = refreshed.systemPrompt;
  }

  const persona = await resolveSessionPersonaSnapshot(sessionId);
  log.log(
    `refresh applied sessionId=${sessionId} origin=${origin} persona=${persona?.name || "none"} model=${routingDecision.modelString} tier=${routingDecision.tier} tools=${tools.length}`,
  );
  return { routingDecision, systemPrompt, tools, persona };
}
