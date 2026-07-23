import { createLogger } from "../log";
import { eventBus } from "../event-bus";
import { getSecretSync } from "../secrets-store";

const voiceLog = createLogger("VoiceSession");

export type VoicePhaseEmitter = (
  phase: string,
  status: "started" | "done" | "error",
  elapsedMs?: number,
) => void;

export interface VoiceSystemStep {
  name: string;
  status: "done" | "error";
  elapsedMs?: number;
  detail?: string;
}

export async function resolveChatSessionKey(
  chatSessionId: string | null
): Promise<string | null> {
  if (!chatSessionId) return null;
  const { chatFileStorage } = await import("../chat-file-storage");
  const conv = await chatFileStorage.getSession(chatSessionId).catch(() => undefined);
  let key = conv?.sessionKey || null;
  if (!key) {
    const { randomUUID } = await import("crypto");
    key = `voice-dash:${randomUUID()}`;
    voiceLog.log(`generated chatSessionKey=${key} for chatSessionId=${chatSessionId}`);
    try {
      await chatFileStorage.updateSessionSessionKey(chatSessionId, key);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      voiceLog.warn(`failed to persist generated chatSessionKey: ${errMsg}`);
    }
  }
  return key;
}

export async function assembleVoiceContext(
  chatSessionId: string | null,
  sessionId: string,
  sendPhaseEvent: VoicePhaseEmitter,
): Promise<{ assembled: { systemPrompt: string } | null; contextElapsed: number; prefetchedSignedUrl?: string | null }> {
  const { assembleContext } = await import("../agent-context");
  const { getToolSchemas } = await import("../tool-registry");

  const ctxStart = Date.now();
  let contextElapsed = 0;

  const { preWarmContextCaches } = await import("../context-builder");
  try {
    await preWarmContextCaches();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    voiceLog.warn(`pre-warm before context build failed (non-fatal): ${errMsg}`);
  }

  const toolDefs = getToolSchemas().map(t => ({ name: t.name, description: t.description }));

  const contextPromise = assembleContext({
    profile: "voice",
    toolDefinitions: toolDefs,
    sessionId: chatSessionId || undefined,
    contextBuildId: `voice-session:${sessionId}:preparation`,
    onProgress: sendPhaseEvent,
  }).then((result) => {
    contextElapsed = Date.now() - ctxStart;
    voiceLog.log(`context assembly completed in ${contextElapsed}ms`);
    return result;
  }).catch((err: unknown) => {
    contextElapsed = Date.now() - ctxStart;
    const errMsg = err instanceof Error ? err.message : String(err);
    voiceLog.warn(`context assembly failed in ${contextElapsed}ms (non-fatal): ${errMsg}`);
    return null;
  });

  const signedUrlPromise = (async () => {
    const { getSignedUrl } = await import("../elevenlabs");
    const elAgentId = getSecretSync("ELEVENLABS_AGENT_ID");
    if (!elAgentId) return null;
    const signedUrlStart = Date.now();
    const url = await getSignedUrl(elAgentId);
    voiceLog.log(`signed URL prefetched in parallel in ${Date.now() - signedUrlStart}ms`);
    return url;
  })().catch((err: unknown) => {
    voiceLog.warn(`parallel signed URL prefetch failed (will retry): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });

  // Pre-warm the exact Claude CLI voice shape once context is ready. The warm
  // handle is keyed by voice session id and claimed by the first custom-LLM
  // callback, so the first spoken turn avoids the CLI cold spawn without
  // creating any chat-visible assistant message.
  const preWarmPromise = contextPromise.then(async (assembledResult) => {
    if (!assembledResult) return;
    try {
      const { preWarmVoiceCli } = await import("../cli-sdk-adapter");
      const { ACTIVITY_VOICE } = await import("../job-profiles");
      const { resolveModelCandidates } = await import("../model-routing");
      const { normalizeSessionModelTierOverride } = await import("../session-model-tier-override");
      const { resolveThinkingConfig } = await import("../thinking-config");
      const { getToolSchemas: getToolDefs } = await import("../tool-registry");
      const { chatFileStorage } = await import("../chat-file-storage");
      const chatSession = chatSessionId ? await chatFileStorage.getSession(chatSessionId) : null;
      const sessionTierOverride = normalizeSessionModelTierOverride(chatSession?.modelTier);
      const voiceRouting = (await resolveModelCandidates(
        ACTIVITY_VOICE,
        sessionTierOverride
          ? { semanticTierOverride: sessionTierOverride, overrideReason: "session model tier override", sessionId: chatSessionId || undefined }
          : { sessionId: chatSessionId || undefined },
      ))[0];
      if (voiceRouting.provider !== "claude-cli") {
        voiceLog.debug(`CLI pre-warm skipped for sessionId=${sessionId}: voice provider=${voiceRouting.provider}`);
        return;
      }
      const voiceThinking = resolveThinkingConfig(voiceRouting.model, { type: "disabled" });
      const fullToolDefs = getToolDefs();
      await preWarmVoiceCli({
        sessionId,
        systemPrompt: assembledResult.systemPrompt,
        model: voiceRouting.model,
        toolDefs: fullToolDefs,
        thinking: voiceThinking,
        connectorConfig: voiceRouting.modelConfig,
      });
      voiceLog.log(`CLI pre-warm ready for sessionId=${sessionId} model=${voiceRouting.model} tier=${voiceRouting.tier}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      voiceLog.warn(`CLI pre-warm failed (non-fatal, will cold-spawn): ${errMsg}`);
    }
  });

  const [assembled, prefetchedSignedUrl] = await Promise.all([contextPromise, signedUrlPromise, preWarmPromise]);
  const totalWall = Date.now() - ctxStart;
  voiceLog.log(`context + signedUrl + prewarm total wall time ${totalWall}ms (context=${contextElapsed}ms)`);

  return { assembled, contextElapsed, prefetchedSignedUrl };
}


export async function ensureVoiceSessionPersona(chatSessionId: string | null): Promise<void> {
  if (!chatSessionId) return;
  const { chatFileStorage } = await import("../chat-file-storage");
  const session = await chatFileStorage.getSession(chatSessionId);
  if (!session || session.personaId) return;
  const { personaStorage } = await import("../file-storage/persona-storage");
  const companion = await personaStorage.getByName("Companion");
  if (!companion) {
    voiceLog.warn(`[VoiceSession] Companion persona not found chatSessionId=${chatSessionId}`);
    return;
  }
  const { setSessionPersona } = await import("../session-persona");
  await setSessionPersona(chatSessionId, companion.id);
  voiceLog.info(`[VoiceSession] defaulted session persona to Companion chatSessionId=${chatSessionId}`);
}

export async function preOrientFtueVoiceSession(chatSessionId: string | null): Promise<boolean> {
  if (!chatSessionId) return false;

  const preOrientStart = Date.now();
  voiceLog.log(`[VoiceSession] ftue_preorient_start chatSessionId=${chatSessionId}`);

  try {
    const { chatFileStorage } = await import("../chat-file-storage");
    const conv = await chatFileStorage.getSession(chatSessionId);
    if (!conv?.ftueWelcome) {
      voiceLog.debug(`[VoiceSession] ftue_preorient_skip chatSessionId=${chatSessionId} reason=not_ftue_welcome`);
      return false;
    }

    if (!conv.manualTitle) {
      await chatFileStorage.updateSessionTitle(chatSessionId, conv.title || "Welcome", { source: "orient" });
    }
    await chatFileStorage.updateSessionTopics(chatSessionId, ["FTUE", "onboarding", "voice"]);

    const existingFlags = await chatFileStorage.readSessionContextFlags(chatSessionId);
    await chatFileStorage.updateSessionContextFlags(chatSessionId, {
      ...(existingFlags || {}),
      "world_model.people.self.chat_instructions": true,
      "session_context": true,
      "context.memory": false,
      "context.active_work": false,
      "context.relationships": false,
      "world_model.people.partner": false,
      "world_model.active_work": false,
      "world_model.decisions": false,
      "memory": false,
      "thoughts": false,
      "capabilities.skills": false,
      "capabilities.library": false,
    });

    const { personaStorage } = await import("../file-storage/persona-storage");
    const companion = await personaStorage.getByName("Companion");
    if (companion) {
      const { setSessionPersona } = await import("../session-persona");
      await setSessionPersona(chatSessionId, companion.id);
      eventBus.publish({
        category: "agent",
        event: "cognition.persona.switched",
        payload: { sessionId: chatSessionId, personaId: companion.id, personaName: companion.name },
      });
    } else {
      voiceLog.warn(`[VoiceSession] ftue_preorient persona Companion not found chatSessionId=${chatSessionId}`);
    }

    const updated = await chatFileStorage.getSession(chatSessionId);
    const sessionKey = updated?.sessionKey || `dashboard:${chatSessionId}`;
    eventBus.publish({
      category: "chat",
      event: "chat.stream",
      payload: { type: "session_updated", sessionId: chatSessionId, title: updated?.title, topics: updated?.topics || [] },
      sessionKey,
    });

    voiceLog.log(`[VoiceSession] ftue_preorient_done chatSessionId=${chatSessionId} persona=Companion elapsedMs=${Date.now() - preOrientStart}`);
    return true;
  } catch (err: unknown) {
    voiceLog.warn(`[VoiceSession] ftue_preorient_failed chatSessionId=${chatSessionId} elapsedMs=${Date.now() - preOrientStart} error=${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function handleFastReconnect(
  chatSessionId: string,
  previousLeaseSessionId: string | null,
  _sendPhaseEvent: VoicePhaseEmitter,
): Promise<{ assembled: { systemPrompt: string } | null; previousSessionId: string; previousTurnCount: number } | null> {
  if (!previousLeaseSessionId) {
    voiceLog.warn(`[fast-reconnect] no previous durable lease found for chatSessionId=${chatSessionId}`);
    return null;
  }
  const { getVoiceSession } = await import("../voice-llm");
  const prevSession = getVoiceSession(previousLeaseSessionId);
  if (!prevSession || prevSession.chatSessionId !== chatSessionId) {
    voiceLog.warn(`[fast-reconnect] previous durable lease is not owned by this process chatSessionId=${chatSessionId} previousSessionId=${previousLeaseSessionId}`);
    return null;
  }
  const previousSessionId = prevSession.id;
  const previousTurnCount = prevSession.turnCount;
  voiceLog.log(`[fast-reconnect] found previous session=${previousSessionId} turnCount=${previousTurnCount}`);

  return {
    assembled: null,
    previousSessionId,
    previousTurnCount,
  };
}

function shouldPersistVoiceSystemSteps(
  systemSteps: VoiceSystemStep[],
): boolean {
  // Connection/startup phases are operational diagnostics, not assistant
  // turns. Persisting them as an empty assistant message creates a ghost
  // bubble at the top of new voice sessions. Durable diagnostics already
  // live in voice diagnostic records and logs; chat history should only get
  // system-step-only assistant rows for exceptional states that matter later.
  return systemSteps.some(step => step.status === "error" || step.name === "voice_reconnect");
}

export async function persistVoiceSystemSteps(
  chatSessionId: string | null,
  systemSteps: VoiceSystemStep[],
): Promise<boolean> {
  if (!chatSessionId || systemSteps.length === 0) return false;
  if (!shouldPersistVoiceSystemSteps(systemSteps)) {
    voiceLog.debug(`skipped voice startup system-step persistence convId=${chatSessionId} systemSteps=${systemSteps.length}`);
    return false;
  }

  try {
    const { chatFileStorage } = await import("../chat-file-storage");
    // Error and reconnect steps are chat-visible (shouldPersistVoiceSystemSteps gates);
    // all others are diagnostic-only forensics.
    const hasUserVisible = systemSteps.some(s => s.status === "error");
    await chatFileStorage.createMessage(
      chatSessionId, "assistant", "",
      undefined, undefined, "elevenlabs-voice", [...systemSteps],
      undefined, undefined, undefined, undefined, undefined, undefined,
      hasUserVisible ? undefined : "diagnostic",
    );
    voiceLog.log(`persisted voice system steps convId=${chatSessionId} systemSteps=${systemSteps.length} visibility=${hasUserVisible ? "chat" : "diagnostic"}`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    voiceLog.warn(`failed to persist voice system steps: ${msg}`);
    return false;
  }
}
