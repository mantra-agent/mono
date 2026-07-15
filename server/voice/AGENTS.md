# Voice Pipeline Architecture

The voice pipeline handles real-time voice conversations via ElevenLabs custom-LLM transport. Audio I/O is managed by ElevenLabs; this server handles LLM orchestration, tool execution, and session management.

## Module Structure

```
voice-llm.ts              — Orchestration hub (~600 lines): handleCustomLLM, executeVoiceTurn, executeVoiceTurnBody
voice/
├── utils.ts              — Text helpers (word-level prefix, content hash), URL resolution (getPublicBaseUrl)
├── session.ts            — Session CRUD, health watchdog, turn locking, DB reconciliation, journal/event helpers
├── sse.ts                — SSE stream primitives, orphan handling, lifecycle event wiring, backpressure tracking
├── persistence.ts        — Turn data persistence: messages, early transcript, error messages, orphaned turns
├── prompt.ts             — System prompt assembly (cached), conversation messages, tool list, resolvePromptAndMessages
├── circuit-breaker.ts    — Circuit breaker, concurrency cap, blocker wait, executor run detection
├── pipeline-log.ts       — Pipeline stage logging, turn forensics, completion summaries, expected-stage auditing
├── turn-io.ts            — Coalescing, backpressure, cascade keepalive, stream chunk handler, timing constants
├── turn-handlers.ts      — Success/abort/error handlers, runExecutorPhase (LLM agent wiring)
├── types.ts              — Shared types: VoiceSession, VoiceMessage, TurnContext, SSEWriteState, BackpressureState
├── tool-middleware.ts    — Voice-specific tool execution middleware
├── thinking-filter.ts    — Strips <thinking> blocks from streaming output
├── synthesis.ts          — Canonical portable speech synthesis for non-browser transports
├── stt.ts                — Provider-neutral labeled PCM recognition boundary + canonical high-quality Scribe policy
├── turn-context.ts       — TurnContext factory for per-turn state
├── session-state.ts      — Shim for v2.5 callers (delegates to session.ts)
├── sse-stream.ts         — Response SSE instrumentation (v2.5)
├── diagnostics.ts        — WebSocket routing + thinking persistence
├── transcript.ts         — Interim/final transcript fan-out
├── keepalive.ts          — Cascade keepalive (re-exports calibration)
└── index.ts              — Public exports (v2.5 engine surface)
```

## Key Concepts

### Tool Execution Ownership
Voice turns use `sdk_owned` execution mode. The Claude Agent SDK calls `toolExecutor` inside `iterator.next()`. The unified tool executor (`tool-execution.ts`) is composed with voice middleware:

1. **Session interceptor** — Catches `session(end)` to trigger audio teardown immediately
2. **Park idea injector** — Forces `source="voice"` and injects `sessionId` for park_idea calls
3. **Park failure handler** — Deterministic error reporting when park_idea fails
4. **Journal logger** — Logs tool_call/tool_result with per-turn correlation IDs

### Session Lifecycle
Sessions are in-memory (`Map<string, VoiceSession>` in `session.ts`) with a health watchdog. A session maps 1:1 to an ElevenLabs connection and 1:1 to a chat session. Sessions auto-expire after 2 hours max, 10 minutes idle (with turns), or 5 minutes idle (no turns). `voice_session_active.boot_id` is the durable owner of that process-local Map entry; `owner_user_id` and `account_id` are the durable user owner. Periodic reconciliation and inflight mutations must filter to the current process boot ID. User-triggered completion must filter to the authenticated user/account. Boot cleanup may only abandon rows older than the global maximum session age. A process must never infer that a foreign boot ID is stale merely because the session is absent from its own Map.

Voice start authority is PostgreSQL. `claimVoiceSessionActive` serializes per account/conversation, enforces one active user lease per conversation, and binds each `start_request_id` durably across terminal states. A same-request replay must match the original conversation; active successful starts replay the same non-secret metadata with a fresh ElevenLabs signed URL, while terminal requests fail closed. The signed URL is never persisted.

Provider custom-LLM callbacks resolve by one exact app voice session ID. The ID comes from `customLlmExtraBody.sessionId`; route or top-level copies are accepted only when every supplied value agrees. Missing or conflicting identity fails closed. Recovery may use only the exact active lease owned by the current process, must reconstruct its durable user Principal, and must verify the chat session through principal-scoped storage before running a turn.

### Turn Flow
1. ElevenLabs sends custom-LLM callback with user transcript → `handleCustomLLM` (voice-llm.ts)
2. Session resolved by exact app voice session ID, with exact owned-lease recovery only (`session.ts`)
3. Coalesce/cascade detection handled in `handleCustomLLM`
4. `executeVoiceTurn` handles abort, locking, circuit breaker, message building
5. `executeVoiceTurnBody` wires prompt assembly, SSE init, executor, result handling
6. Content streamed through SSE to ElevenLabs for TTS
7. Turn data persisted (`persistence.ts`), diagnostics emitted

### Content Accumulation
Uses per-iteration content model (`iterationResults[]`) with explicit `mergeIterationResults()`. Tool call continuations replace pre-tool preamble. Max-tokens continuations concatenate.

## When Working Here
- The `VoiceSession` interface in `types.ts` is the source of truth
- `voice-llm.ts` is the thin orchestration layer (~600 lines) importing from submodules
- Session state lives in `session.ts` — access via exported functions, not the raw Map
- Tool middleware runs inside `iterator.next()` — keep it fast, no heavy I/O
- The thinking filter is stateful per-turn — always create a fresh one via `createThinkingFilter()`
- Never block the SSE response — use fire-and-forget for non-critical logging

### Speech Synthesis Ownership
Normal voice configuration is the sole source of truth for voice identity, model, expression tags, pronunciation, and voice settings. `voice/synthesis.ts` owns the portable provider request: `streamVoiceAudio()` returns progressive audio, and buffered consumers derive bytes through `synthesizeVoiceAudio()` rather than opening a second provider path. Meeting/Recall and phone/Twilio may deliver, buffer, or transcode that audio, but must not own provider selection or speech configuration.
