# Voice Pipeline Architecture

The voice pipeline handles real-time voice conversations via ElevenLabs custom-LLM transport. Audio I/O is managed by ElevenLabs; this server handles LLM orchestration, tool execution, and session management.

## Module Structure

```
voice-llm.ts              — Orchestration hub (~600 lines): handleCustomLLM, executeVoiceTurn, executeVoiceTurnBody
voice/
├── utils.ts              — Text helpers (word-level prefix, content hash), URL resolution (getPublicBaseUrl)
├── session.ts            — Session CRUD, health watchdog, turn locking, DB reconciliation, journal/event helpers
├── finalize.ts           — User-triggered terminal completion across lease, voice runtime, SessionManager, and durable chat status
├── sse.ts                — SSE stream primitives, orphan handling, lifecycle event wiring, backpressure tracking
├── persistence.ts        — Turn data persistence: messages, early transcript, error messages, orphaned turns
├── prompt.ts             — System prompt assembly (cached), conversation messages, tool list, resolvePromptAndMessages
├── circuit-breaker.ts    — Circuit breaker, blocker wait, executor run detection (runtime capacity authority owns voice admission)
├── pipeline-log.ts       — Pipeline stage logging, turn forensics, completion summaries, expected-stage auditing
├── turn-io.ts            — Presence writer, phrase assembler, hold-as-presence, stream chunk handler
├── turn-handlers.ts      — Success/abort/error handlers, runExecutorPhase (LLM agent wiring)
├── types.ts              — Shared types: VoiceSession, VoiceMessage, TurnContext, PresenceState, SSEWriteState
├── tool-middleware.ts    — Voice-specific tool execution middleware
├── thinking-filter.ts    — Strips <thinking> blocks from streaming output
├── synthesis.ts          — Canonical portable speech synthesis for non-browser transports
├── stt.ts                — Compatibility re-export of the canonical bounded `server/speech-recognition/` module; meeting transports migrate through it without a parallel STT interface
├── turn-context.ts       — TurnContext factory for per-turn state
├── session-state.ts      — Compatibility type re-export during call-site migration
├── sse-stream.ts         — Response SSE instrumentation
├── diagnostics.ts        — WebSocket routing + thinking persistence
├── transcript.ts         — Interim/final transcript fan-out
├── keepalive.ts          — Soft/cascade buffer calibration re-export (hold cadence)
└── index.ts              — Public custom-LLM engine surface
```

## Key Concepts

### Tool Execution Ownership
Voice turns use `sdk_owned` execution mode. The Claude Agent SDK calls `toolExecutor` inside `iterator.next()`. The unified tool executor (`tool-execution.ts`) is composed with voice middleware:

1. **Session interceptor** — Catches `session(end)` to trigger audio teardown immediately
2. **Park idea injector** — Forces `source="voice"` and injects `sessionId` for park_idea calls
3. **Park failure handler** — Deterministic error reporting when park_idea fails
4. **Journal logger** — Logs tool_call/tool_result with per-turn correlation IDs

Authenticated voice attached to a durable chat session is a user-interactive transport and crosses the same central engineering-authority boundary as typed chat. `build:write` remains mandatory. Sessionless voice endpoints and restricted public/provisional sessions never receive this trust; provisional sessions keep `toolMode=none`.

### Session Lifecycle
Sessions are in-memory (`Map<string, VoiceSession>` in `session.ts`) with a health watchdog. A session maps 1:1 to an ElevenLabs connection and 1:1 to a chat session. Sessions auto-expire after 2 hours max, 10 minutes idle (with turns), or 5 minutes idle (no turns). `voice_session_active.boot_id` is the durable owner of that process-local Map entry; `owner_user_id` and `account_id` are the durable user owner. Periodic reconciliation and inflight mutations must filter to the current process boot ID. User-triggered completion goes through `finalize.ts`, binds voice ID + chat ID + authenticated user/account, then settles the process-local voice runtime, SessionManager projection, and durable chat row. Replacement/reconnect cleanup remains runtime-only and must never complete the shared chat. Boot cleanup may only abandon rows older than the global maximum session age. A process must never infer that a foreign boot ID is stale merely because the session is absent from its own Map.

Voice start authority is PostgreSQL. `claimVoiceSessionActive` serializes per account/conversation, enforces one active user lease per conversation, and binds each `start_request_id` durably across terminal states. A same-request replay must match the original conversation; active successful starts replay the same non-secret metadata with a fresh ElevenLabs signed URL, while terminal requests fail closed. The signed URL is never persisted. Finalization uses the existing voice session ID as its idempotency identity: the lease transition returns `completed | already_complete | superseded | not_completable`, preserves the original completion timestamp on replay, fences delayed retries when a newer call owns the chat, and the chat document records that exact voice ID only after durable terminal save. A lost HTTP acknowledgement is `unknown`, never failure; the client sends one keepalive request, retries once, then reconciles the exact voice ID plus saved chat status. Provisional recap FTUE uses the sibling `claimProvisionalVoiceSessionActive` boundary: a hash-keyed system lease, no User/chat session, no persistence or owner context, and `VoiceSession.toolMode=none`; exact callback recovery must revalidate the onboarding hash before reconstructing the restricted service principal.

Provider custom-LLM callbacks resolve by one exact app voice session ID. The ID comes from `customLlmExtraBody.sessionId`; route or top-level copies are accepted only when every supplied value agrees. Missing or conflicting identity fails closed. Recovery may use only the exact active lease owned by the current process, must reconstruct its durable user Principal, and must verify the chat session through principal-scoped storage before running a turn. `chat-owner.ts` is the canonical boundary for every authenticated voice chat read/write: it re-enters the VoiceSession's required Principal and returns distinct outcomes for owner-scoped chat unavailability, supersession, missing owner context, and storage failure. A scoped null is never deletion evidence, and superseded attempt chronology is discarded rather than persisted.

### Turn Flow
1. ElevenLabs sends custom-LLM callback with user transcript → `handleCustomLLM` (voice-llm.ts)
2. Session resolved by exact app voice session ID, with exact owned-lease recovery only (`session.ts`)
3. Coalesce/cascade detection handled in `handleCustomLLM`
4. `executeVoiceTurn` handles abort, locking, circuit breaker, message building
5. Sessions without established orientation (meaningful title plus explicit context scope) run the shared orientation bootstrap (`orientation-bootstrap.ts`) serially before persona snapshot resolution. The bootstrap applies title/topics/context through the canonical orient path and assigns its routed persona only when the session has none; a persona selected before bootstrap remains authoritative through an atomic conversation-lock mutation. On apply, the cached system prompt is invalidated so the turn reassembles under the effective persona. `world_model.orientation` itself is real-time in the context spine, so a startup prompt assembled before the first utterance cannot survive this mutation through a lower cache. Memoized on `VoiceSession.orientationEnsured`; fallback outcomes retry next turn. FTUE preorientation establishes title, persona, and context scope and therefore short-circuits. Ordinary FTUE retains the canonical introduction; recap-origin FTUE derives its opening from the first open persisted agenda item and deduplicates the transcript greeting through the ordinary assistant-artifact boundary.
6. `executeVoiceTurnBody` wires prompt assembly, SSE init, executor, result handling
7. Content streams through SSE to ElevenLabs for TTS
8. Turn data persists (`persistence.ts`), diagnostics emit

### Content Accumulation
Uses per-iteration content model (`iterationResults[]`) with explicit `mergeIterationResults()`. Every visible iteration is preserved in order, including pre-tool prose, with the same separator encoded into persisted segment chronology.

Voice assistant persistence is replay-safe by canonical `turnId` and inserts the assistant row immediately after its matching user row. Provider callback completion order must never create a second assistant row for one logical turn or detach a response from the utterance that caused it.

### Presence rooms (1:1 custom-LLM)
`turn-io.ts` owns five rooms behind frozen ports (start/lease/finalize/callback/SSE/turn-identity unchanged):

1. **Presence writer** — sole speakable SSE write. Every speakable uses `buildSSEChunk(..., flush=true)`. Sets `TurnContext.presence` (`speaking | holding | silent | reconnecting`). Unflushed non-speech never leaves the helper.
2. **Phrase assembler** — soft flush (80ms timer, first content) emits only completed sentences via `takeCompletedSpeakable`. Forced empty only for `turn_end`, overflow, guide introduction. Tool start must not invent a period or force-chop; remainder survives tools.
3. **Hold as presence** — silent. Comment-only ticks on the cascade-safe window. No spoken filler (`One moment.`, `One second.`, `Still on it.`, `Working.`). Unflushed `"... "` and unflushed `" "` role-chunks are unrepresentable.
4. **Silent reconnect** — client keeps last live conversational visual until reconnect exhaustion; captions clear on retry; no user-facing degraded theater mid-retry.
5. **Spine** — `session.id` + `turnId` + `assistantAttemptId` on flush/hold/SSE/reconnect events. Long-turn forensics promote to `info` when tools > 0, duration ≥ 10s, holds fired, or reconnect. No transcript bodies in diagnostics.

SSE comments remain socket liveness only — never presence. One utterance owns one generator; `VoiceSession.activeWriteRes` is a hot-swappable write port. Same-utterance custom-LLM POSTs attach; they must not increment `turnCount` or abort the generator. EL soft-timeout spoken filler is off.

## When Working Here
- The `VoiceSession` interface in `types.ts` is the source of truth
- `voice-llm.ts` is the thin orchestration layer (~600 lines) importing from submodules
- Session state lives in `session.ts` — access via exported functions, not the raw Map
- Tool middleware runs inside `iterator.next()` — keep it fast, no heavy I/O
- The thinking filter is stateful per-turn — always create a fresh one via `createThinkingFilter()`
- Never block the SSE response — use fire-and-forget for non-critical logging
- STT adapters consume `SpeechRecognitionHints`; meeting/voice entry points resolve user-owned identity, roster, and People vocabulary once and providers only translate that contract to their wire format
- `SpeechRecognitionStreamCoordinator` owns protocol-ready candidate startup, bounded audio buffering/backpressure, same-binding reconnect with a fresh attempt ID, and graceful finish for Recall and native meeting capture. Adapters own only wire protocol and provider EOS.
- Every coordinator attempt owns one bounded serialized recognition sink. Consumer/database failures settle and log separately from provider transport failures and never become unhandled rejections.
- Every voice assistant attempt mints and retains one complete `{ runId, turnId, assistantAttemptId }` tuple before `SessionManager.registerSession`; supersession events reuse that tuple, and a revised attempt replaces it atomically rather than reconstructing partial identity.

### Speech Synthesis Ownership
Normal voice configuration is the sole source of truth for voice identity, model, expression tags, pronunciation, and voice settings. `voice/synthesis.ts` owns the portable provider request: `streamVoiceAudio()` returns progressive audio, and buffered consumers derive bytes through `synthesizeVoiceAudio()` rather than opening a second provider path. Meeting/Recall and phone/Twilio may deliver, buffer, or transcode that audio, but must not own provider selection or speech configuration.

## Start Flow

`start-preparation.ts` owns start-domain preparation: chat session-key resolution, context and signed-URL prefetch, CLI pre-warm, default persona readiness, FTUE pre-orientation, exact reconnect preparation, and exceptional system-step persistence. HTTP/SSE transport, lease claiming, provider handoff, and response completion remain in `routes/voice-session.ts`. Do not pass Express request or response objects into the preparation module.

### Residual Migration Constraints

- `session-state.ts`, `sse-stream.ts`, and the internal `handleV25CustomLLM` implementation name remain compatibility identities for current imports and provider configuration; they do not represent another engine. The public callback is `handleCustomLLM`. Remove the compatibility names only after repository imports and stored/provider callback contracts reach zero usage.
- `voice-session-engine.ts` and `/api/voice/sessions/save` remain a legacy voice-session archive consumed by persisted transcript UI. They are not call-lifecycle authority; canonical live and durable conversation state remains the chat Session plus `voice_session_active` lease. Retire the archive only after migrating stored `voice_session` documents and their UI.
- Webhook base-URL override caching is process-local. The mutating request reconfigures ElevenLabs in its handling process; other replicas converge on restart/reload and must not treat their cache as provider truth.

### Phone register-call transport

Twilio phone calls enter the same VoiceSession/custom-LLM engine through `server/phone/voice-session.ts`. PostgreSQL `twilio_number_bindings` owns inbound number → user/account/Vault authority and `phone_call_records` owns call SID → Session/VoiceSession correlation and terminal interaction receipt. ElevenLabs owns phone audio through register-call; phone code must pass only the exact app VoiceSession ID in `custom_llm_extra_body.sessionId`. Do not restore a phone STT/TTS pipeline, `/ws/twilio-media`, or process-local accepted-call correlation.

### Provider-Owned System Tools
ElevenLabs system tools arrive on each custom-LLM request as OpenAI-format tool definitions. `provider-system-tools.ts` is the allowlist and validation boundary. Merge only recognized provider tools into the voice executor, intercept them before ordinary bridge-tool dispatch, then return the selected call to ElevenLabs as OpenAI-format SSE so ElevenLabs remains the sole owner of conversation language and other provider state.
