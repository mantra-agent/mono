import type { Principal } from "../principal";
import { eventBus } from "../event-bus";
import { storage } from "../storage";
import { assembleVoiceContext, ensureVoiceSessionPersona, resolveChatSessionKey } from "../voice/start-preparation";
import { createVoiceSession, generateVoiceSessionId } from "../voice/session";
import { setupAgentCallbackUrl } from "../elevenlabs";

export async function preparePhoneVoiceSession(principal: Principal, chatSessionId: string, requestId: string): Promise<string> {
  const sessionId = generateVoiceSessionId();
  const claim = await storage.claimVoiceSessionActive({
    sessionId, chatSessionId, requestId, bootId: eventBus.bootId, principal, reconnect: false,
  });
  if (claim.outcome !== "claimed") throw new Error("A voice session already owns this phone call");
  const agentId = (await import("../secrets-store")).getSecretSync("ELEVENLABS_AGENT_ID")?.trim();
  if (!agentId) throw new Error("ELEVENLABS_AGENT_ID is required for phone calls");
  try {
    await setupAgentCallbackUrl(agentId);
    await ensureVoiceSessionPersona(chatSessionId);
    const chatSessionKey = await resolveChatSessionKey(chatSessionId);
    const assembled = await assembleVoiceContext(chatSessionId, sessionId, () => undefined);
    const voiceSession = createVoiceSession(principal, chatSessionId, assembled.assembled?.systemPrompt, sessionId, chatSessionKey || undefined, false);
    voiceSession.toolMode = "standard";
    const completed = await storage.completeVoiceSessionStart(sessionId, eventBus.bootId, {
      agentId, sessionId, chatSessionId, chatSessionKey: chatSessionKey || undefined, transport: "twilio",
    });
    if (!completed) throw new Error("Phone voice lease disappeared before completion");
    return sessionId;
  } catch (error) {
    throw error;
  }
}
