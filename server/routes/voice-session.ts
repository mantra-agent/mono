import type { Express } from "express";
import { eq } from "drizzle-orm";
import { requireAuth } from "../auth";
import { createLogger } from "../log";
import { db } from "../db";
import { storage } from "../storage";
import { eventBus } from "../event-bus";
import { VoiceEvents } from "@shared/event-catalog";
import { getSecretSync } from "../secrets-store";

const voiceLog = createLogger("VoiceSession");

let agentSetupComplete = false;
let agentSetupPromise: Promise<void> | null = null;

async function performAgentSetup(elAgentId: string): Promise<void> {
  const { setupAgentCallbackUrl, fetchAndCacheVoiceId } = await import("../elevenlabs");
  await fetchAndCacheVoiceId(elAgentId);
  await setupAgentCallbackUrl(elAgentId);
  agentSetupComplete = true;
  voiceLog.log(`agent ${elAgentId} callback URL configured and voiceId cached`);
}

/**
 * Server-side single-flight for /api/voice/start, keyed by chatSessionId.
 * Concurrent starts for the same chat must converge on one outcome rather
 * than each independently calling createVoiceSession() and writing their
 * own ID into the in-memory sessions Map.
 *
 * Bounded by a 30s timeout so a process crash mid-handler can't hang
 * future clicks forever — when the timeout elapses, the slot is released
 * and the next request enters the slow path again.
 *
 * The "lock" is a shared Promise: the second concurrent caller awaits the
 * first's completion and then responds with a 409 + the first request's
 * sessionId so the client converges to the single live session rather than
 * spinning up a parallel one.
 */
type StartSingleFlight = {
  startedAt: number;
  requestId: string;
  done: Promise<{ sessionId: string | null; ok: boolean }>;
  resolve: (v: { sessionId: string | null; ok: boolean }) => void;
};
const startInflightByChat = new Map<string, StartSingleFlight>();
const START_LOCK_TIMEOUT_MS = 30_000;
const START_DUPLICATE_WARN_WINDOW_MS = 2_000;

function acquireStartLock(chatSessionId: string, requestId: string): { acquired: boolean; existing?: StartSingleFlight } {
  const existing = startInflightByChat.get(chatSessionId);
  if (existing) {
    const ageMs = Date.now() - existing.startedAt;
    if (ageMs < START_DUPLICATE_WARN_WINDOW_MS) {
      voiceLog.error(`[VoiceSession] DUPLICATE_START_WARNING chatSessionId=${chatSessionId} firstRequestId=${existing.requestId} secondRequestId=${requestId} ageMs=${ageMs} — task-923 invariant: two /api/voice/start calls within ${START_DUPLICATE_WARN_WINDOW_MS}ms`);
    }
    return { acquired: false, existing };
  }
  let resolveFn!: (v: { sessionId: string | null; ok: boolean }) => void;
  const done = new Promise<{ sessionId: string | null; ok: boolean }>((resolve) => { resolveFn = resolve; });
  const slot: StartSingleFlight = {
    startedAt: Date.now(),
    requestId,
    done,
    resolve: resolveFn,
  };
  startInflightByChat.set(chatSessionId, slot);
  // Auto-release after timeout to avoid permanent locks on crash.
  setTimeout(() => {
    if (startInflightByChat.get(chatSessionId) === slot) {
      voiceLog.warn(`[VoiceSession] START_LOCK_TIMEOUT chatSessionId=${chatSessionId} requestId=${requestId} — releasing after ${START_LOCK_TIMEOUT_MS}ms`);
      startInflightByChat.delete(chatSessionId);
      slot.resolve({ sessionId: null, ok: false });
    }
  }, START_LOCK_TIMEOUT_MS).unref?.();
  return { acquired: true };
}

function releaseStartLock(chatSessionId: string, result: { sessionId: string | null; ok: boolean }): void {
  const slot = startInflightByChat.get(chatSessionId);
  if (!slot) return;
  startInflightByChat.delete(chatSessionId);
  slot.resolve(result);
}



async function ensureAgentSetup(): Promise<void> {
  if (agentSetupComplete) return;
  const elAgentId = getSecretSync("ELEVENLABS_AGENT_ID");
  if (!elAgentId) return;
  if (agentSetupPromise) {
    await agentSetupPromise;
    if (agentSetupComplete) return;
    voiceLog.warn("ensureAgentSetup: boot setup promise resolved but agentSetupComplete is still false — falling through to retry");
  }
  voiceLog.log("ensureAgentSetup: retrying setup on first connection");
  agentSetupPromise = performAgentSetup(elAgentId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    voiceLog.error(`ensureAgentSetup retry failed: ${msg}`);
    agentSetupPromise = null;
  });
  await agentSetupPromise;
}

export async function registerVoiceSessionRoutes(app: Express) {
  // Boot recovery is fully fire-and-forget. Each underlying step has its own
  // 2s budget (BOOT_RECOVERY_PER_ROW_BUDGET_MS in voice-llm); we additionally
  // bound the bulk abandonStaleVoiceSessions call here so a stuck pool client
  // can never hold the boot path open. Every quarantine event — bulk timeout
  // OR each individually abandoned row — logs [BOOT_QUARANTINE] to stderr
  // (synchronously, SIGKILL-survivable) so poisoned row IDs are always
  // attributable in production logs.
  const BOOT_BULK_BUDGET_MS = 2000;
  const bulkStart = Date.now();
  Promise.race([
    storage.abandonStaleVoiceSessions(eventBus.bootId),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), BOOT_BULK_BUDGET_MS)),
  ]).then(async (orphaned) => {
    const ts = new Date().toISOString();
    if (orphaned === null) {
      try {
        process.stderr.write(`[BOOT_QUARANTINE] step=abandonStaleVoiceSessions id=bulk reason="timeout" elapsedMs=${Date.now() - bulkStart} ts=${ts}\n`);
      } catch {}
    } else if (orphaned.length > 0) {
      const elapsedMs = Date.now() - bulkStart;
      for (const row of orphaned) {
        try {
          process.stderr.write(`[BOOT_QUARANTINE] step=abandonStaleVoiceSessions id=${row.sessionId} reason="abandoned" prevBootId=${row.bootId || "null"} elapsedMs=${elapsedMs} ts=${ts}\n`);
        } catch {}
      }
      voiceLog.warn(`Boot cleanup: marked ${orphaned.length} stale voice session(s) as abandoned: ${orphaned.map(s => s.sessionId).join(", ")}`);
    }
    const { reconcileDbVoiceState } = await import("../voice-llm");
    await reconcileDbVoiceState();
    voiceLog.log("Boot: DB→memory voice state reconciliation complete");
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    voiceLog.warn(`Boot cleanup of stale voice sessions failed (non-fatal): ${msg}`);
  });

  const bootAgentId = getSecretSync("ELEVENLABS_AGENT_ID");
  if (bootAgentId) {
    agentSetupPromise = performAgentSetup(bootAgentId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      voiceLog.warn(`Boot: agent setup failed (will retry on first connection): ${msg}`);
      agentSetupPromise = null;
    });
  } else {
    voiceLog.warn("Boot: ELEVENLABS_AGENT_ID not set — skipping agent callback URL setup");
  }

  const voiceLlmHandler = async (req: import("express").Request, res: import("express").Response) => {
    try {
      const { handleV25CustomLLM } = await import("../voice");
      await handleV25CustomLLM(req, res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      voiceLog.error(`route handler crashed: path=${req.path} bodyKeys=[${Object.keys(req.body || {}).join(",")}] error=${message}`, stack);
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  };

  app.post("/api/voice/llm/route/chat/completions", voiceLlmHandler);
  app.post("/api/voice/llm/:sessionId/:chatSessionId/chat/completions", voiceLlmHandler);
  app.post("/api/voice/llm/:sessionId/chat/completions", voiceLlmHandler);

  // Greetings removed — user speaks first, connection chime signals readiness.

  app.post("/api/voice/diagnostic", async (req, res) => {
    const { event, details } = req.body || {};
    if (event === "disconnected") {
      const reason = details?.reason ?? "";
      const closeCode = details?.closeCode ?? details?.code ?? "";
      const closeReason = details?.closeReason ?? "";
      const message = details?.message ?? "";
      const wasClean = details?.wasClean ?? "";
      const agentMode = details?.agentMode ?? "";
      const turnCount = details?.turnCount ?? "";
      const elapsed = details?.elapsed ?? "";
      const msSinceLastActivity = details?.msSinceLastActivity ?? "";
      const intentionalEnd = details?.intentionalEnd ?? false;
      const reconnectAttempt = details?.reconnectAttempt ?? "";
      const elevenLabsDetails = details?.elevenLabsDetails ?? {};
      voiceLog.warn(`[VoiceSession] CLIENT_DISCONNECT reason=${reason} closeCode=${closeCode} closeReason=${closeReason || "(none)"} message=${message || "(none)"} wasClean=${wasClean} agentMode=${agentMode} turnCount=${turnCount} elapsed=${elapsed}ms msSinceLastActivity=${msSinceLastActivity}ms intentionalEnd=${intentionalEnd} reconnectAttempt=${reconnectAttempt} elevenLabsDetails=${JSON.stringify(elevenLabsDetails)}`);
      if (!intentionalEnd) {
        const logMsg = `Voice disconnect: reason=${reason || "(unknown)"} closeCode=${closeCode || "(none)"} closeReason=${closeReason || "(none)"} message=${message || "(none)"} wasClean=${wasClean} agentMode=${agentMode} turnCount=${turnCount} elapsed=${elapsed}ms msSinceLastActivity=${msSinceLastActivity}ms reconnectAttempt=${reconnectAttempt}`;
        voiceLog.warn(logMsg);
      }
      const diagChatSessionId = details?.chatSessionId as string | undefined;
      if (diagChatSessionId && !intentionalEnd) {
        const disconnectDetail = `Connection dropped (code ${closeCode || "unknown"})${closeReason ? ` — ${closeReason}` : ""}`;
        import("../voice-llm").then(({ findSessionForChat }) => {
          const voiceSession = findSessionForChat(diagChatSessionId);
          if (voiceSession) {
            voiceSession.disconnectReason = `${closeCode || "unknown"}:${reason || ""}`;
            eventBus.publish({
              category: "voice",
              event: "voice_connection_dropped",
              payload: {
                sessionId: voiceSession.id,
                chatSessionId: diagChatSessionId,
                timestamp: Date.now(),
                closeCode,
                reason: reason || undefined,
                closeReason: closeReason || undefined,
                detail: disconnectDetail,
              },
              sessionKey: voiceSession.chatSessionKey || `voice:${voiceSession.id}`,
            });
            voiceLog.log(`published voice_connection_dropped event to chat UI convId=${diagChatSessionId}`);
          }
        }).catch((err: unknown) => { voiceLog.warn(`voice_connection_dropped publish failed: ${err instanceof Error ? err.message : String(err)}`); });
        import("../chat-file-storage").then(({ chatFileStorage }) => {
          const disconnectStep = {
            name: "voice_disconnect",
            status: "done" as const,
            detail: `Disconnect closeCode=${closeCode} reason=${reason || "(none)"} elapsed=${elapsed}ms turnCount=${turnCount}`,
          };
          chatFileStorage.createMessage(
            diagChatSessionId, "assistant", "",
            undefined, undefined, "elevenlabs-voice", [disconnectStep],
          ).then(() => {
            voiceLog.log(`persisted disconnect lifecycle system step convId=${diagChatSessionId}`);
          }).catch((err: unknown) => {
            voiceLog.warn(`failed to persist disconnect lifecycle: ${err instanceof Error ? err.message : String(err)}`);
          });
        }).catch((importErr: unknown) => { voiceLog.warn(`disconnect lifecycle import failed: ${importErr instanceof Error ? importErr.message : String(importErr)}`); });
      }
    } else if (event === "start_failed") {
      const reason = (details?.reason ?? "") as string;
      const closeCode = (details?.closeCode ?? "") as string;
      const closeReason = (details?.closeReason ?? "") as string;
      const message = (details?.message ?? "") as string;
      const elapsed = (details?.elapsedMs ?? "") as string | number;
      const signedUrlReceived = !!details?.signedUrlReceived;
      const diagChatSessionId = details?.chatSessionId as string | undefined;
      const diagVoiceSessionId = details?.voiceSessionId as string | undefined;
      voiceLog.warn(`[VoiceSession] CLIENT_START_FAILED reason=${reason || "(unknown)"} closeCode=${closeCode || "(none)"} closeReason=${closeReason || "(none)"} message=${message || "(none)"} signedUrlReceived=${signedUrlReceived} chatSessionId=${diagChatSessionId || "(none)"} voiceSessionId=${diagVoiceSessionId || "(none)"} elapsed=${elapsed}ms`);

      try {
        const { findSessionForChat, endVoiceSession, getVoiceSession } = await import("../voice-llm");
        let voiceSession = diagVoiceSessionId ? getVoiceSession(diagVoiceSessionId) : null;
        if (!voiceSession && diagChatSessionId) {
          voiceSession = findSessionForChat(diagChatSessionId);
        }
        if (voiceSession) {
          const sessionIdToEnd = voiceSession.id;
          const sessionKey = voiceSession.chatSessionKey || `voice:${sessionIdToEnd}`;
          const effectiveChatSessionId = diagChatSessionId || voiceSession.chatSessionId || undefined;
          const detail = `Voice session failed to start — ${message || reason || "unknown reason"}`;
          endVoiceSession(sessionIdToEnd, `start_failed:${reason || "unknown"}`);
          try {
            await storage.endVoiceSessionActive(sessionIdToEnd, "abandoned");
          } catch (dbErr: unknown) {
            voiceLog.warn(`[VoiceSession] start_failed: endVoiceSessionActive(${sessionIdToEnd}) failed (already gone?): ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
          }
          if (effectiveChatSessionId) {
            eventBus.publish({
              category: "voice",
              event: "voice_connection_dropped",
              payload: {
                sessionId: sessionIdToEnd,
                chatSessionId: effectiveChatSessionId,
                timestamp: Date.now(),
                closeCode: closeCode || undefined,
                reason: reason || undefined,
                closeReason: closeReason || undefined,
                detail,
              },
              sessionKey,
            });
          }
          voiceLog.log(`[VoiceSession] start_failed: ended voice session ${sessionIdToEnd} for chatSessionId=${effectiveChatSessionId || "(none)"} reason=${reason}`);
        } else {
          voiceLog.log(`[VoiceSession] start_failed: no matching server-side voice session (chatSessionId=${diagChatSessionId || "(none)"} voiceSessionId=${diagVoiceSessionId || "(none)"}) — nothing to tear down`);
        }
      } catch (err: unknown) {
        voiceLog.warn(`[VoiceSession] start_failed handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (event === "reconnect_result") {
      const attempt = details?.attempt ?? "";
      const success = details?.success ?? false;
      const reason = details?.reason ?? "";
      const closeCode = details?.closeCode ?? details?.code ?? "";
      const closeReason = details?.closeReason ?? "";
      const elapsed = details?.elapsed ?? "";
      voiceLog.warn(`client event=${event} attempt=${attempt} success=${success} reason=${reason} closeCode=${closeCode} closeReason=${closeReason || "(none)"} elapsed=${elapsed}ms`);
      const logMsg = `Voice reconnect attempt ${attempt}: ${success ? "succeeded" : "failed"} reason=${reason || "(unknown)"} closeCode=${closeCode || "(none)"} closeReason=${closeReason || "(none)"} elapsed=${elapsed}ms`;
      if (success) voiceLog.log(logMsg); else voiceLog.warn(logMsg);
    } else if (event === "reconnect_exhausted") {
      const attempts = details?.attempts ?? "";
      const reason = details?.reason ?? "";
      const closeCode = details?.closeCode ?? details?.code ?? "";
      const closeReason = details?.closeReason ?? "";
      const elapsed = details?.elapsed ?? "";
      voiceLog.warn(`client event=${event} attempts=${attempts} reason=${reason} closeCode=${closeCode} closeReason=${closeReason || "(none)"} elapsed=${elapsed}ms`);
      const logMsg = `Voice reconnect exhausted after ${attempts} attempt(s) — session lost reason=${reason || "(unknown)"} closeCode=${closeCode || "(none)"} closeReason=${closeReason || "(none)"} elapsed=${elapsed}ms`;
      voiceLog.warn(logMsg);
    } else if (event === "heartbeat") {
      const sessionDuration = details?.sessionDuration ?? "";
      const agentMode = details?.agentMode ?? "";
      const msSinceLastActivity = details?.msSinceLastActivity ?? "";
      const turnCount = details?.turnCount ?? "";
      voiceLog.log(`[VoiceSession] HEARTBEAT sessionDuration=${sessionDuration}ms agentMode=${agentMode} msSinceLastActivity=${msSinceLastActivity}ms turnCount=${turnCount}`);
    } else {
      voiceLog.warn(`client event=${event || "unknown"} ${JSON.stringify(details || {})}`);
    }
    res.status(200).json({ ok: true });
  });

  function persistDiagnosticRecord(record: {
    sessionId: string;
    chatSessionId: string | null;
    timings: Record<string, number>;
    total: number;
    timestamp: string;
  }) {
    const slowPhases: string[] = [];
    const thresholds: Record<string, number> = { context_assembly_voice: 5000, greeting_llm_call: 3000, signed_url: 3000 };
    for (const [phase, ms] of Object.entries(record.timings)) {
      if (thresholds[phase] && ms > thresholds[phase]) slowPhases.push(`${phase}=${ms}ms`);
    }
    const level = slowPhases.length > 0 ? "warn" : "info";
    const timingsJson = JSON.stringify(record.timings);
    const message = `[voice-diagnostics] sessionId=${record.sessionId} chatSessionId=${record.chatSessionId || "(none)"} total=${record.total}ms timings=${timingsJson}${slowPhases.length > 0 ? ` SLOW: ${slowPhases.join(", ")}` : ""}`;
    if (level === "warn") voiceLog.warn(message); else voiceLog.log(message);
  }

  app.get("/api/voice/diagnostics/recent", async (_req, res) => {
    try {
      const { readLogFile, getCurrentLogFile } = await import("../log");
      const currentFile = getCurrentLogFile();
      const allLines = await readLogFile(currentFile, { limit: 500 });
      const diagnosticLogs = allLines
        .filter(l => l.source === "VoiceSession" && l.message.includes("[voice-diagnostics]"))
        .slice(0, 20)
        .map(l => {
          const sessionIdMatch = l.message.match(/sessionId=(\S+)/);
          const chatSessionIdMatch = l.message.match(/chatSessionId=(\S+)/);
          const totalMatch = l.message.match(/total=(\d+)ms/);
          const timingsMatch = l.message.match(/timings=(\{[^}]+\})/);
          return {
            sessionId: sessionIdMatch?.[1] || "",
            chatSessionId: chatSessionIdMatch?.[1] === "(none)" ? null : chatSessionIdMatch?.[1] || null,
            timings: timingsMatch?.[1] ? JSON.parse(timingsMatch[1]) : {},
            total: totalMatch ? parseInt(totalMatch[1], 10) : 0,
            timestamp: l.ts || "",
            level: l.level || "info",
          };
        });
      res.json(diagnosticLogs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      voiceLog.warn(`diagnostics/recent failed: ${msg}`);
      res.json([]);
    }
  });

  async function resolveChatSessionKey(
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

  async function assembleVoiceContext(
    chatSessionId: string | null,
    sessionId: string,
    sendPhaseEvent: (phase: string, status: "started" | "done" | "error", elapsedMs?: number) => void,
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
        const { resolveModelForActivity, ACTIVITY_VOICE } = await import("../job-profiles");
        const { resolveThinkingConfig } = await import("../thinking-config");
        const { getToolSchemas: getToolDefs } = await import("../tool-registry");
        const voiceRouting = resolveModelForActivity(ACTIVITY_VOICE);
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
        });
        voiceLog.log(`CLI pre-warm ready for sessionId=${sessionId} model=${voiceRouting.model}`);
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


  async function preOrientFtueVoiceSession(chatSessionId: string | null): Promise<boolean> {
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
        await personaStorage.activate(companion.id);
        eventBus.publish({
          category: "agent",
          event: "cognition.persona.switched",
          payload: { personaId: companion.id, personaName: companion.name },
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

  async function handleFastReconnect(
    chatSessionId: string,
    _sendPhaseEvent: (phase: string, status: "started" | "done" | "error", elapsedMs?: number) => void,
  ): Promise<{ assembled: { systemPrompt: string } | null; previousSessionId: string; previousTurnCount: number } | null> {
    const { findSessionForChat } = await import("../voice-llm");
    const prevSession = findSessionForChat(chatSessionId);
    if (!prevSession) {
      voiceLog.warn(`[fast-reconnect] no previous session found for chatSessionId=${chatSessionId}`);
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
    systemSteps: Array<{ name: string; status: "done" | "error"; elapsedMs?: number; detail?: string }>,
  ): boolean {
    // Connection/startup phases are operational diagnostics, not assistant
    // turns. Persisting them as an empty assistant message creates a ghost
    // bubble at the top of new voice sessions. Durable diagnostics already
    // live in voice diagnostic records and logs; chat history should only get
    // system-step-only assistant rows for exceptional states that matter later.
    return systemSteps.some(step => step.status === "error" || step.name === "voice_reconnect");
  }

  async function persistVoiceSystemSteps(
    chatSessionId: string | null,
    systemSteps: Array<{ name: string; status: "done" | "error"; elapsedMs?: number; detail?: string }>,
  ): Promise<boolean> {
    if (!chatSessionId || systemSteps.length === 0) return false;
    if (!shouldPersistVoiceSystemSteps(systemSteps)) {
      voiceLog.debug(`skipped voice startup system-step persistence convId=${chatSessionId} systemSteps=${systemSteps.length}`);
      return false;
    }

    try {
      const { chatFileStorage } = await import("../chat-file-storage");
      await chatFileStorage.createMessage(
        chatSessionId, "assistant", "",
        undefined, undefined, "elevenlabs-voice", [...systemSteps],
      );
      voiceLog.log(`persisted voice system steps convId=${chatSessionId} systemSteps=${systemSteps.length}`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      voiceLog.warn(`failed to persist voice system steps: ${msg}`);
      return false;
    }
  }

  app.post("/api/voice/start", requireAuth, async (req, res) => {
    const startTime = Date.now();
    const userAgent = req.headers["user-agent"] || "(unknown)";
    const origin = req.headers.origin || req.headers.referer || "(unknown)";
    const isMobile = /mobile|iphone|ipad|android/i.test(userAgent);
    let sessionId: string | undefined;
    let currentPhase = "init";
    let phaseStartMs = Date.now();

    const wantsStream = req.headers.accept?.includes("text/event-stream");
    const requestId = req.body.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const chatSessionId: string | null = req.body.chatSessionId || null;
    const isReconnect = !!req.body.isReconnect;

    voiceLog.log(`start request requestId=${requestId} chatSessionId=${chatSessionId || "(new)"} origin=${origin} mobile=${isMobile} stream=${!!wantsStream} isReconnect=${isReconnect}`);

    // ---- Pre-await error checks (must run BEFORE any res.writeHead). ----
    const elAgentId = getSecretSync("ELEVENLABS_AGENT_ID");
    if (!elAgentId) {
      voiceLog.error(`start aborted requestId=${requestId} — ELEVENLABS_AGENT_ID not configured`);
      if (wantsStream) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Agent not configured — set ELEVENLABS_AGENT_ID in Settings → Connections" }));
      }
      return res.status(400).json({ error: "Agent not configured — set ELEVENLABS_AGENT_ID in Settings → Connections" });
    }

    // ---- Server-side single-flight (task-923 step 1c). ----
    // Concurrent /api/voice/start calls for the same chatSessionId must
    // converge on a single voice session. The second caller awaits the
    // first's outcome and returns 409 + the first's sessionId.
    let duplicateOfSessionId: string | null = null;
    if (chatSessionId) {
      const lock = acquireStartLock(chatSessionId, requestId);
      if (!lock.acquired && lock.existing) {
        try {
          const result = await Promise.race([
            lock.existing.done,
            new Promise<{ sessionId: string | null; ok: boolean }>((resolve) =>
              setTimeout(() => resolve({ sessionId: null, ok: false }), 15_000).unref?.()
            ),
          ]);
          duplicateOfSessionId = result.sessionId;
          voiceLog.warn(`start single-flight: duplicate request requestId=${requestId} chatSessionId=${chatSessionId} converged on primarySession=${duplicateOfSessionId || "(unknown)"}`);
        } catch (err: unknown) {
          voiceLog.warn(`start single-flight: await of primary failed requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (wantsStream) {
          res.writeHead(409, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            error: "duplicate_start",
            requestId,
            sessionId: duplicateOfSessionId,
            chatSessionId,
            message: "A start for this chatSessionId is already in flight; reuse the primary session.",
          }));
        }
        return res.status(409).json({
          error: "duplicate_start",
          requestId,
          sessionId: duplicateOfSessionId,
          chatSessionId,
        });
      }
    }

    // ---- Now safe to write SSE headers. CRITICAL: must happen BEFORE
    // any await on slow upstream work (ensureAgentSetup,
    // context assembly, etc) or upstream layers will retry the
    // silent POST and we get the duplicate-start race documented in
    // task-923 finding #1.
    function sendSSE(data: Record<string, unknown>) {
      if (!wantsStream) return;
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e: any) { voiceLog.warn(`sendSSE write failed type=${data?.type} error=${e?.message}`); }
    }

    if (wantsStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Flush an immediate phase byte so no upstream layer ever sees a
      // silent connection. This was the root trigger for the retry.
      try { res.write(`: ok\n\n`); } catch {/* connection already gone */}
      voiceLog.log(`SSE stream established requestId=${requestId}`);
    }

    let chatSessionKey: string | null = null;
    const accumulatedSystemSteps: Array<{ name: string; status: "done" | "error"; elapsedMs?: number; detail?: string }> = [];
    const seenStepNames = new Set<string>();

    function sendPhaseEvent(phase: string, status: "started" | "done" | "error", elapsedMs?: number, error?: string) {
      const payload: Record<string, unknown> = {
        requestId,
        ...(sessionId ? { sessionId } : {}),
        phase,
        status,
        elapsedMs: elapsedMs ?? 0,
        totalElapsed: Date.now() - startTime,
        ...(error ? { error } : {}),
      };

      sendSSE({ type: "phase", ...payload });

      // Per-bubble chip cap + dedup by phase name (task-923 step 5).
      // Without this, every retried/duplicate phase event accumulates as
      // a separate chip on whichever bubble happens to consume them.
      if (status === "done" || status === "error") {
        if (seenStepNames.has(phase)) return;
        if (accumulatedSystemSteps.length >= 12) return;
        seenStepNames.add(phase);
        accumulatedSystemSteps.push({ name: phase, status, elapsedMs });
      }
    }

    // Send the immediate engine_setup "started" event so the wire is
    // never silent during the slow ensureAgentSetup path.
    sendPhaseEvent("engine_setup", "started");

    try {
      const engineSetupStart = Date.now();
      await ensureAgentSetup();
      sendPhaseEvent("engine_setup", "done", Date.now() - engineSetupStart);

      const { getCachedVoiceId, getSignedUrl } = await import("../elevenlabs");
      const { generateVoiceSessionId, createVoiceSession, resumeVoiceSession, endSessionsForChat } = await import("../voice-llm");

      sessionId = generateVoiceSessionId();
      const voiceId = getCachedVoiceId();

      let contextElapsed = 0;
      let assembled: { systemPrompt: string } | null = null;
      let usedFastReconnect = false;
      let previousSessionId: string | null = null;
      let previousTurnCount = 0;

      if (isReconnect && chatSessionId) {
        const reconnectResult = await handleFastReconnect(chatSessionId, sendPhaseEvent);
        if (reconnectResult) {
          usedFastReconnect = true;
          assembled = reconnectResult.assembled;
          previousSessionId = reconnectResult.previousSessionId;
          previousTurnCount = reconnectResult.previousTurnCount;
        }
      }

      if (chatSessionId) {
        const cleanup = endSessionsForChat(chatSessionId, usedFastReconnect ? previousSessionId || undefined : undefined);
        if (cleanup.closed > 0) {
          voiceLog.log(`cleaned up ${cleanup.closed} stale session(s) for chatSessionId=${chatSessionId}${usedFastReconnect ? ` (preserved ${previousSessionId} for resume)` : ""}`);
          // Defense in depth (task-923 step 6): publish a "duplicate
          // detected" signal so the client can tear down any older
          // Conversation it may still be holding. Triggered ONLY here
          // (real duplicate cleanup), NOT on every reconnect path —
          // attemptReconnect's clean swap legitimately replaces
          // conversationRef without going through this branch.
          if (cleanup.chatSessionKey) {
            eventBus.publish({
              category: "voice",
              event: "voice_duplicate_detected",
              payload: {
                chatSessionId,
                chatSessionKey: cleanup.chatSessionKey,
                primarySessionId: sessionId,
                supersededSessionIds: cleanup.closedIds,
                requestId,
              },
              sessionKey: cleanup.chatSessionKey,
            });
          }
        }
      }

      chatSessionKey = await resolveChatSessionKey(chatSessionId);
      if (chatSessionKey) {
        voiceLog.log(`resolved chatSessionKey=${chatSessionKey} for chatSessionId=${chatSessionId}`);
      }

      let prefetchedSignedUrl: string | null = null;

      const ftuePreOriented = !usedFastReconnect ? await preOrientFtueVoiceSession(chatSessionId) : false;
      if (ftuePreOriented) {
        accumulatedSystemSteps.push({ name: "ftue_preorient", status: "done" as const });
      }

      if (!assembled) {
        currentPhase = "context_assembly_voice";
        phaseStartMs = Date.now();
        const result = await assembleVoiceContext(chatSessionId, sessionId!, sendPhaseEvent);
        assembled = result.assembled;
        contextElapsed = result.contextElapsed;
        prefetchedSignedUrl = result.prefetchedSignedUrl || null;
      }

      let session;
      if (usedFastReconnect && previousSessionId) {
        const resumed = await resumeVoiceSession(previousSessionId, sessionId!, chatSessionKey || undefined);
        if (resumed) {
          session = resumed;
          voiceLog.log(`[fast-reconnect] resumed session ${previousSessionId}→${sessionId} turnCount=${session.turnCount} activeTurnNumber=${session.activeTurnNumber}`);
          accumulatedSystemSteps.push({
            name: "voice_reconnect",
            status: "done" as const,
            detail: `Resumed session ${previousSessionId}→${sessionId} turnCount=${session.turnCount} previousTurnCount=${previousTurnCount}`,
          });
          eventBus.publish({
            category: "voice",
            event: "voice_reconnect_lifecycle",
            payload: {
              sessionId: sessionId!,
              chatSessionId,
              previousSessionId,
              previousTurnCount,
              status: "resumed",
              turnCount: session.turnCount,
              activeTurnNumber: session.activeTurnNumber,
            },
          });
        } else {
          session = createVoiceSession(chatSessionId || undefined, undefined, sessionId, chatSessionKey || undefined, isReconnect);
          voiceLog.log(`[fast-reconnect] resume failed — created fresh session ${sessionId}`);
          accumulatedSystemSteps.push({
            name: "voice_reconnect",
            status: "error" as const,
            detail: `Resume failed for ${previousSessionId} — created fresh session ${sessionId}`,
          });
          eventBus.publish({
            category: "voice",
            event: "voice_reconnect_lifecycle",
            payload: {
              sessionId: sessionId!,
              chatSessionId,
              previousSessionId,
              status: "resume_failed_fresh",
            },
          });
        }
      } else {
        session = createVoiceSession(chatSessionId || undefined, undefined, sessionId, chatSessionKey || undefined, isReconnect);
      }

      // Store the authenticated principal so voice LLM callbacks run in the correct scope.
      if (req.principal) session.principal = req.principal;

      if (assembled) {
        session.cachedSystemPrompt = assembled.systemPrompt;
        session.cachedSystemPromptFocusKey = null;
        session.cachedAt = Date.now();
        voiceLog.log(`system prompt pre-cached len=${assembled.systemPrompt.length}`);
      } else {
        voiceLog.log(`system prompt not pre-cached — will build on first turn`);
      }

      voiceLog.log(`session ready agent=${elAgentId} voice=${voiceId} chatSessionId=${chatSessionId || "(new)"}`);

      currentPhase = "signed_url";
      phaseStartMs = Date.now();
      sendPhaseEvent("signed_url", "started");
      let signedUrl: string;
      let signedUrlElapsed: number;
      if (prefetchedSignedUrl) {
        signedUrl = prefetchedSignedUrl;
        signedUrlElapsed = 0;
        voiceLog.log(`signed URL used from parallel prefetch (0ms)`);
      } else {
        const signedUrlStart = Date.now();
        signedUrl = await getSignedUrl(elAgentId);
        signedUrlElapsed = Date.now() - signedUrlStart;
        voiceLog.log(`signed URL fetched in ${signedUrlElapsed}ms`);
      }
      sendPhaseEvent("signed_url", "done", signedUrlElapsed);

      const totalElapsed = Date.now() - startTime;
      const pathLabel = usedFastReconnect ? "fast-reconnect" : "full-setup";
      voiceLog.log(`start complete path=${pathLabel} in ${totalElapsed}ms sessionId=${sessionId}${previousSessionId ? ` previousSessionId=${previousSessionId}` : ""} ctx=${contextElapsed}ms signedUrl=${signedUrlElapsed}ms`);

      if (accumulatedSystemSteps.length > 0 && chatSessionId) {
        persistVoiceSystemSteps(chatSessionId, accumulatedSystemSteps)
          .then((persisted) => {
            try { sendSSE({ type: "phase_persisted", persisted, chatSessionId }); } catch (e: any) { voiceLog.debug(`phase_persisted SSE send failed: ${e?.message}`); }
          })
          .catch((err: unknown) => {
            voiceLog.warn(`fire-and-forget persistVoiceSystemSteps failed: ${err instanceof Error ? err.message : String(err)}`);
          });
      }

      storage.createVoiceSessionActive(sessionId, chatSessionId, eventBus.bootId)
        .then(() => {
          voiceLog.log(`persisted voice_session_active row sessionId=${sessionId} chatSessionId=${chatSessionId}`);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          voiceLog.error(`failed to persist voice_session_active row sessionId=${sessionId}: ${msg}`);
        });

      const timings = {
        context_assembly_voice: contextElapsed,
        signed_url: signedUrlElapsed,
      };

      persistDiagnosticRecord({
        sessionId: sessionId!,
        chatSessionId,
        timings,
        total: totalElapsed,
        timestamp: new Date().toISOString(),
      });

      let serverTranscript: Array<{ role: string; content: string; timestamp?: string }> | undefined;
      if (isReconnect && chatSessionId) {
        try {
          const { chatFileStorage } = await import("../chat-file-storage");
          const msgs = await chatFileStorage.getMessagesBySession(chatSessionId);
          serverTranscript = msgs
            .filter(m => m.role === "user" || m.role === "assistant")
            .map(m => ({ role: m.role, content: m.content || "", timestamp: typeof m.createdAt === "string" ? m.createdAt : (m.createdAt as unknown) instanceof Date ? (m.createdAt as unknown as Date).toISOString() : new Date().toISOString() }));
          voiceLog.log(`reconnect transcript loaded msgCount=${serverTranscript.length} chatSessionId=${chatSessionId}`);
        } catch (err: unknown) {
          voiceLog.warn(`failed to load reconnect transcript: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Compose FTUE first_message if this is a welcome session
      let firstMessage: string | undefined;
      if (chatSessionId && !isReconnect) {
        try {
          const { chatFileStorage } = await import("../chat-file-storage");
          const sessionMeta = await chatFileStorage.getSession(chatSessionId);
          if (sessionMeta?.ftueWelcome) {
            const { userProfiles: userProfilesTable, agentProfiles: agentProfilesTable } = await import("@shared/schema");
            const { getCurrentPrincipal } = await import("../principal-context");
            const principal = getCurrentPrincipal();
            if (principal?.userId) {
              const [[userProfile], [agentProfile]] = await Promise.all([
                db.select({ preferredName: userProfilesTable.preferredName, displayName: userProfilesTable.displayName })
                  .from(userProfilesTable).where(eq(userProfilesTable.userId, principal.userId)).limit(1),
                db.select({ agentName: agentProfilesTable.agentName })
                  .from(agentProfilesTable).where(eq(agentProfilesTable.userId, principal.userId)).limit(1),
              ]);
              const userName = userProfile?.preferredName || userProfile?.displayName || "there";
              const agentName = agentProfile?.agentName || "Agent";
              if (agentName !== "Agent") {
                firstMessage = `Hey ${userName}! I'm going to go by ${agentName}. Nice to meet you. Does that feel right, or would you rather I go by something else?`;
              } else {
                firstMessage = `Hey ${userName}! It's great to meet you. Let's get started.`;
              }
              voiceLog.log(`FTUE firstMessage composed for user=${userName} agent=${agentName}`);
            }
          }
        } catch (err: unknown) {
          voiceLog.warn(`FTUE firstMessage composition failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Persist FTUE first_message as the first assistant message in the session.
      // Server is the single source of truth — persist at the point of creation
      // so the message exists in session history regardless of voice connection outcome.
      if (firstMessage && chatSessionId) {
        try {
          const { chatFileStorage: cfs } = await import("../chat-file-storage");
          await cfs.createMessage(chatSessionId, "assistant", firstMessage);
          voiceLog.log("FTUE firstMessage persisted to chat session", { chatSessionId });
        } catch (persistErr: unknown) {
          voiceLog.warn(`FTUE firstMessage persistence failed (non-fatal): ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`);
        }
      }

      const payload = {
        signedUrl,
        agentId: elAgentId,
        voiceId,
        sessionId,
        chatSessionId: chatSessionId || session.chatSessionId,
        chatSessionKey: chatSessionKey || undefined,
        timings: { ...timings, total: totalElapsed },
        ...(serverTranscript ? { serverTranscript } : {}),
        ...(firstMessage ? { firstMessage } : {}),
      };

      if (wantsStream) {
        sendSSE({ type: "complete", ...payload });
        res.end();
      } else {
        res.json(payload);
      }
      if (chatSessionId) releaseStartLock(chatSessionId, { sessionId: sessionId!, ok: true });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" | ") : undefined;
      voiceLog.error(`start failed at phase=${currentPhase}: ${errMsg}`, errStack);
      if (sessionId) {
        try {
          const { endVoiceSession } = await import("../voice-llm");
          endVoiceSession(sessionId, `start_error:${errMsg.slice(0, 100)}`);
        } catch (cleanupErr: any) { voiceLog.warn(`endVoiceSession cleanup failed sessionId=${sessionId}: ${cleanupErr?.message || String(cleanupErr)}`); }
      }
      if (wantsStream) {
        const phaseElapsed = Date.now() - phaseStartMs;
        sendPhaseEvent(currentPhase, "error", phaseElapsed, errMsg);
        sendSSE({ type: "error", error: errMsg, phase: currentPhase, elapsedMs: phaseElapsed, totalElapsed: Date.now() - startTime });
        res.end();
      } else {
        res.status(500).json({ error: errMsg });
      }
      if (chatSessionId) releaseStartLock(chatSessionId, { sessionId: sessionId || null, ok: false });
    }
  });

  app.post("/api/voice/sessions/save", async (req, res) => {
    try {
      const transcript = Array.isArray(req.body.transcript) ? req.body.transcript : [];
      const toolCalls = Array.isArray(req.body.toolCalls) ? req.body.toolCalls : [];
      const chatSessionId = req.body.chatSessionId;

      const structuredResults: Record<string, unknown> = {};
      if (req.body.flaggedTasks?.length) structuredResults.flaggedTasks = req.body.flaggedTasks;
      if (req.body.insights?.length) structuredResults.insights = req.body.insights;

      const { chatFileStorage } = await import("../chat-file-storage");
      let storedPrompt: string | null = null;
      if (chatSessionId) {
        storedPrompt = await chatFileStorage.getInitialContext(chatSessionId);
      }

      const systemPrompt = storedPrompt || "(system prompt not captured)";
      const { getToolSchemas } = await import("../tool-registry");
      const tools = getToolSchemas().map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

      const { voiceSessionEngine } = await import("../voice-session-engine");
      const voiceSession = await voiceSessionEngine.createSessionFromCheckIn(
        "daily",
        transcript,
        toolCalls,
        { systemPrompt, firstMessage: req.body.firstMessage || "", tools },
        { profile: "quick", endedBy: req.body.endedBy || "user" },
        Object.keys(structuredResults).length > 0 ? structuredResults : undefined,
        req.body.summary,
      );

      if (chatSessionId) {
        const existing = await chatFileStorage.getSession(chatSessionId);
        if (existing) {
          const existingMessages = await chatFileStorage.getMessagesBySession(chatSessionId);
          const persistedContents = new Set(
            existingMessages.map(m => `${m.role}:${(m.content || "").trim()}`)
          );
          let skipped = 0;
          for (const entry of transcript) {
            if (entry.source === "user") {
              const role = "user";
              const content = (entry.message || "").trim();
              const contentKey = `${role}:${content}`;
              if (persistedContents.has(contentKey)) {
                skipped++;
                continue;
              }
              const contentLower = content.toLowerCase();
              const isSubsetOfExisting = existingMessages.some(
                existing => existing.role === role && existing.content.toLowerCase().startsWith(contentLower) && existing.content.length > content.length
              );
              if (isSubsetOfExisting) {
                skipped++;
                continue;
              }
              await chatFileStorage.createMessage(
                chatSessionId,
                role,
                content,
                undefined,
                undefined,
                undefined,
              );
              persistedContents.add(contentKey);
            }
          }
          if (skipped > 0) {
            voiceLog.log(`[VoiceLlm] save: skipped ${skipped} already-persisted entries convId=${chatSessionId}`);
          }

        } else {
          voiceLog.warn(`session ${chatSessionId} not found, creating new voice session`);
          const title = req.body.summary
            ? req.body.summary.slice(0, 80)
            : `Voice: ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
          await chatFileStorage.createVoiceSession(title, voiceSession.id, transcript, toolCalls, req.body.summary);
        }
      } else {
        const title = req.body.summary
          ? req.body.summary.slice(0, 80)
          : `Voice: ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
        await chatFileStorage.createVoiceSession(title, voiceSession.id, transcript, toolCalls, req.body.summary);
      }

      res.json({ ok: true, voiceSessionId: voiceSession.id });
    } catch (error: any) {
      voiceLog.warn("failed to save voice session record:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/voice/context", async (_req, res) => {
    try {
      const { assembleContext } = await import("../agent-context");
      const { getToolSchemas } = await import("../tool-registry");
      const tools = getToolSchemas();
      const toolDefs = tools.map(t => ({ name: t.name, description: t.description }));
      const assembled = await assembleContext({ profile: "voice", toolDefinitions: toolDefs });
      const estimatedTokens = Math.ceil(assembled.systemPrompt.length / 4);
      res.json({
        systemPrompt: assembled.systemPrompt,
        tools: tools.map(t => ({ name: t.name, description: t.description })),
        estimatedTokens,
        architecture: "v4-unified-spine",
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
