import type { Express } from "express";
import { eq } from "drizzle-orm";
import { requireAuth } from "../auth";
import { createLogger } from "../log";
import { db } from "../db";
import { storage } from "../storage";
import { eventBus } from "../event-bus";
import { VoiceEvents } from "@shared/event-catalog";
import { getSecretSync } from "../secrets-store";
import { FTUE_AGENT_NAME } from "../onboarding";
import {
  assembleVoiceContext,
  ensureVoiceSessionPersona,
  handleFastReconnect,
  persistVoiceSystemSteps,
  preOrientFtueVoiceSession,
  resolveChatSessionKey,
  type VoiceSystemStep,
} from "../voice/start-preparation";

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
  // Boot recovery is fully fire-and-forget and bounded. Multiple app processes
  // can share the same database, so a foreign boot_id may still own a healthy
  // voice session. Only leases older than the server-wide two-hour maximum are
  // safe to abandon here. Periodic reconciliation is separately owner-scoped.
  const BOOT_BULK_BUDGET_MS = 2000;
  const VOICE_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
  const bulkStart = Date.now();
  const staleBefore = new Date(bulkStart - VOICE_SESSION_MAX_AGE_MS);
  Promise.race([
    storage.abandonExpiredVoiceSessions(staleBefore),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), BOOT_BULK_BUDGET_MS)),
  ]).then(async (orphaned) => {
    const ts = new Date().toISOString();
    if (orphaned === null) {
      try {
        process.stderr.write(`[BOOT_QUARANTINE] step=abandonExpiredVoiceSessions id=bulk reason="timeout" elapsedMs=${Date.now() - bulkStart} ts=${ts}\n`);
      } catch {}
    } else if (orphaned.length > 0) {
      const elapsedMs = Date.now() - bulkStart;
      for (const row of orphaned) {
        try {
          process.stderr.write(`[BOOT_QUARANTINE] step=abandonExpiredVoiceSessions id=${row.sessionId} reason="expired" ownerBootId=${row.bootId || "null"} elapsedMs=${elapsedMs} ts=${ts}\n`);
        } catch {}
      }
      voiceLog.warn(`Boot cleanup: marked ${orphaned.length} expired voice session(s) as abandoned: ${orphaned.map(s => s.sessionId).join(", ")}`);
    }
    const { reconcileDbVoiceState } = await import("../voice-llm");
    await reconcileDbVoiceState();
    voiceLog.log(`Boot: owner-scoped DB→memory voice state reconciliation complete bootId=${eventBus.bootId}`);
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    voiceLog.warn(`Boot cleanup of expired voice sessions failed (non-fatal): ${msg}`);
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
            undefined, undefined, undefined, undefined, undefined, undefined, "diagnostic",
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
            await storage.endVoiceSessionActive(sessionIdToEnd, "abandoned", { kind: "process", bootId: eventBus.bootId });
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

    if (!chatSessionId) {
      return res.status(400).json({ error: "chatSessionId is required to start voice" });
    }
    if (req.principal?.actorType !== "user" || !req.principal.userId || !req.principal.accountId) {
      return res.status(401).json({ error: "Authenticated user principal required to start voice" });
    }

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
    const accumulatedSystemSteps: VoiceSystemStep[] = [];
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

    // Send the immediate lease_claim phase so upstream layers never retry a
    // silent request while PostgreSQL chooses the authoritative starter.
    sendPhaseEvent("lease_claim", "started");

    try {
      const { generateVoiceSessionId } = await import("../voice-llm");
      sessionId = generateVoiceSessionId();
      const leaseClaim = await storage.claimVoiceSessionActive({
        sessionId,
        chatSessionId,
        requestId,
        bootId: eventBus.bootId,
        principal: req.principal,
        reconnect: isReconnect,
      });
      if (leaseClaim.outcome === "conflict") {
        const existingSessionId = leaseClaim.lease.sessionId;
        voiceLog.warn(`voice lease claim conflict requestId=${requestId} chatSessionId=${chatSessionId} existingSessionId=${existingSessionId}`);
        if (wantsStream) {
          sendSSE({
            type: "error",
            error: "duplicate_start",
            requestId,
            sessionId: existingSessionId,
            chatSessionId,
            message: "An active voice session already owns this conversation.",
          });
          res.end();
        } else {
          res.status(409).json({ error: "duplicate_start", requestId, sessionId: existingSessionId, chatSessionId });
        }
        return;
      }
      if (leaseClaim.outcome === "existing") {
        if (leaseClaim.lease.status !== "active") {
          const terminalPayload = {
            error: "start_request_finalized",
            requestId,
            sessionId: leaseClaim.lease.sessionId,
            chatSessionId,
            status: leaseClaim.lease.status,
          };
          voiceLog.warn(`voice start replay rejected for terminal request requestId=${requestId} sessionId=${leaseClaim.lease.sessionId} status=${leaseClaim.lease.status}`);
          if (wantsStream) {
            sendSSE({ type: "error", ...terminalPayload });
            res.end();
          } else {
            res.status(409).json(terminalPayload);
          }
          return;
        }
        currentPhase = "lease_replay";
        phaseStartMs = Date.now();
        sendPhaseEvent("lease_replay", "started");
        const replayDeadline = Date.now() + 30_000;
        let replayLease = leaseClaim.lease;
        while (!replayLease.startReadyAt || !replayLease.startResponse) {
          if (Date.now() >= replayDeadline) {
            throw new Error("Timed out waiting for the authoritative voice start response");
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          const refreshed = await storage.getVoiceSessionStartByRequest(requestId, req.principal);
          if (!refreshed) {
            throw new Error("The authoritative voice start failed before completion");
          }
          replayLease = refreshed;
        }
        const replayMetadata = replayLease.startResponse as Record<string, unknown>;
        const { getSignedUrl: getReplaySignedUrl } = await import("../elevenlabs");
        const replaySignedUrl = await getReplaySignedUrl(elAgentId);
        const replayPayload = {
          ...replayMetadata,
          signedUrl: replaySignedUrl,
          replayed: true,
        };
        sendPhaseEvent("lease_replay", "done", Date.now() - phaseStartMs);
        voiceLog.log(`voice start replay complete requestId=${requestId} sessionId=${replayLease.sessionId} freshCredential=true`);
        if (wantsStream) {
          sendSSE({ type: "complete", ...replayPayload });
          res.end();
        } else {
          res.json(replayPayload);
        }
        return;
      }
      const replacedLeaseSessionId = leaseClaim.replacedSessionId;
      sendPhaseEvent("lease_claim", "done", Date.now() - phaseStartMs);
      voiceLog.log(`voice lease claimed requestId=${requestId} sessionId=${sessionId} chatSessionId=${chatSessionId} replacedSessionId=${replacedLeaseSessionId || "(none)"}`);

      currentPhase = "engine_setup";
      phaseStartMs = Date.now();
      sendPhaseEvent("engine_setup", "started");
      const engineSetupStart = Date.now();
      await ensureAgentSetup();
      sendPhaseEvent("engine_setup", "done", Date.now() - engineSetupStart);

      const { getCachedVoiceId, getSignedUrl } = await import("../elevenlabs");
      const { createVoiceSession, resumeVoiceSession, endSessionsForChat } = await import("../voice-llm");
      const voiceId = getCachedVoiceId();

      let contextElapsed = 0;
      let assembled: { systemPrompt: string } | null = null;
      let usedFastReconnect = false;
      let previousSessionId: string | null = null;
      let previousTurnCount = 0;

      if (isReconnect && chatSessionId) {
        const reconnectResult = await handleFastReconnect(chatSessionId, replacedLeaseSessionId, sendPhaseEvent);
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

      if (!usedFastReconnect) await ensureVoiceSessionPersona(chatSessionId);
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

      // The in-memory session inherits the same Principal that won the durable claim.
      session.principal = req.principal;

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
            .map(m => ({ role: m.role, content: m.content || "", timestamp: typeof m.createdAt === "string" ? m.createdAt : (m.createdAt as unknown) instanceof Date ? (m.createdAt as unknown as Date).toISOString() : new Date().toISOString(), persona: m.persona }));
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
            const { userProfiles: userProfilesTable } = await import("@shared/schema");
            const { getCurrentPrincipal } = await import("../principal-context");
            const principal = getCurrentPrincipal();
            if (principal?.userId) {
              const [userProfile] = await db
                .select({ preferredName: userProfilesTable.preferredName, displayName: userProfilesTable.displayName })
                .from(userProfilesTable)
                .where(eq(userProfilesTable.userId, principal.userId))
                .limit(1);
              const userName = userProfile?.preferredName || userProfile?.displayName || "there";
              firstMessage = `Hey ${userName}! I'm ${FTUE_AGENT_NAME}. I help you keep track of what matters and turn it into action. To start, what's one goal or commitment you'd like me to help move forward?`;
              voiceLog.log(`FTUE firstMessage composed for user=${userName} agent=${FTUE_AGENT_NAME}`);
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

      const sessionPersona = chatSessionId
        ? await (await import("../session-persona")).resolveSessionPersonaSnapshot(chatSessionId)
        : undefined;
      const replayMetadata = {
        agentId: elAgentId,
        voiceId,
        sessionId,
        chatSessionId: chatSessionId || session.chatSessionId,
        chatSessionKey: chatSessionKey || undefined,
        timings: { ...timings, total: totalElapsed },
        ...(sessionPersona ? { persona: sessionPersona } : {}),
        ...(serverTranscript ? { serverTranscript } : {}),
        ...(firstMessage ? { firstMessage } : {}),
      };
      const completedLease = await storage.completeVoiceSessionStart(sessionId!, eventBus.bootId, replayMetadata);
      if (!completedLease) {
        throw new Error("Voice start lease disappeared before completion");
      }
      const payload = { signedUrl, ...replayMetadata };

      if (wantsStream) {
        sendSSE({ type: "complete", ...payload });
        res.end();
      } else {
        res.json(payload);
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" | ") : undefined;
      voiceLog.error(`start failed at phase=${currentPhase}: ${errMsg}`, errStack);
      if (sessionId) {
        try {
          const { endVoiceSession } = await import("../voice-llm");
          endVoiceSession(sessionId, `start_error:${errMsg.slice(0, 100)}`);
          await storage.endVoiceSessionActive(sessionId, "abandoned", { kind: "process", bootId: eventBus.bootId }).catch((dbError: unknown) => {
            voiceLog.warn(`start error lease cleanup failed sessionId=${sessionId}: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
          });
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
