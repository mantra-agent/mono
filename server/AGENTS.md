# Authority

Root `AGENTS.md` is mandatory and authoritative for Engineering Principles, architecture, and repository constraints. Root `CODING.md` is mandatory and authoritative for engineering workflow, Coding Task Gate, git policy, verification, and final reporting. This file adds local constraints only. Load this file before touching files under `server/`. For UI/product-facing work, also load root `DESIGN.md`. If instructions conflict, follow root `AGENTS.md` for principles/architecture and root `CODING.md` for procedure unless Ray explicitly overrides.

# Runtime Identity

`runtime-identity.ts` is the single source of truth for deployment identity: canonical Platform Environment, Railway environment/service, serving host (`RAILWAY_PUBLIC_DOMAIN`), canonical hosting-binding public URL, git commit, and DB host. `platform-environment-resolver.ts` is the canonical server boundary for mapping Railway's injected project/environment/service IDs or an explicit Platform Environment ID through the hosting binding, provider connection, encrypted credential, and provider configuration. Runtime identity resolves once at boot, flags unresolved bindings loudly, and is injected into agent context via the `world_model.runtime` spine section. New code that needs the public base URL for external callbacks must await `getRuntimePublicBaseUrl()`.

A Railway runtime may execute only its deployed entrypoint. Never launch `server/index.ts`, `npm run dev`, or another application server from an agent shell, verification command, or acceptance harness inside stage/live. Concurrent processes share the bound database and background services. Startup must never terminate PostgreSQL backends based on `application_name` or boot identity; PostgreSQL owns connection reclamation.

# Server Architecture

The server is a Node.js/Express/TypeScript monolith running all backend logic: API routes, LLM orchestration, autonomous execution, memory management, and integrations. This file covers the server-root subsystems. For deeper dives see:

- `memory/AGENTS.md` — Memory tiers, ingestion, consolidation, retrieval, graph, sleep
- `council/AGENTS.md` — Session tree, cross-session messaging, council deliberation
- See "Voice Architecture" section below for voice/ElevenLabs integration

---

## Access Control

Access control is server-owned and permission-based. Future code must plug into the existing principal/permission path instead of checking `user.role` or `isAdmin` directly.

### Key Files
- `principal.ts` — Principal model and system/service principal constructors
- `principal-context.ts` — AsyncLocalStorage for current principal in async server work
- `permissions.ts` — Permission vocabulary, effective permission lookup, `requirePermission(...)`, `user_permissions` schema ensure
- `scoped-storage.ts` — Principal-aware visible/writable predicates and `ownedInsertValues(...)` for normal user-owned tables
- `sensitive-scope.ts` — Principal-aware sensitive ownership helpers and privileged-mode audit gates
- `auth.ts` — Auth/session integration and `/api/auth/me` response shape

### Invariants
- Resolve every request or server action to a `Principal` before making authorization decisions.
- Named permissions are the authorization contract. Current vocabulary: `users:read`, `users:write`, `build:read`, `build:write`, `system:read`, `system:write`.
- `role=admin` only contributes base permissions inside `permissions.ts`. Do not use role checks as route authorization.
- User-specific grants live in `user_permissions`; do not duplicate permission state in settings, client state, or feature flags. Override updates are replace-set operations: omitted permissions are revoked, not inherited implicitly.
- System principals may bypass user permissions only for trusted internal jobs. User-triggered paths must preserve the user principal through async boundaries with `runWithPrincipal(...)` when they leave the request stack.
- Recall and other meeting transports must restore the durable `MeetingSessionMeta` owner through `meeting/owner-principal.ts` before transcript persistence, context assembly, model execution, recap generation, or any user-owned read/write. Provider callbacks never infer ownership.
- Authorization failures return `401` for missing principals and `403` for missing permissions, and record principal diagnostics through the central permission path.
- Sensitive/user-owned reads and writes must combine domain predicates with `visibleScopePredicate(...)`, `writableScopePredicate(...)`, `combineWithSensitiveVisible(...)`, `combineWithSensitiveWritable(...)`, `ownedInsertValues(...)`, or `sensitiveOwnershipValues(...)`. Raw `db.select/update/delete` on scoped tables must not be introduced without an explicit principal scope predicate.

### When Working Here
- Protect privileged routes with `requireAuth` before `requirePermission(permission)` or a central helper that delegates to `principalHasPermission(...)`; never leave credential, connected-account, admin, build, system, or permission-management endpoints ungated.
- When adding a privileged capability, first add the permission string/type in `permissions.ts`, then expose it through `/api/auth/me`, then gate routes/tools with that permission.
- Client-side permission checks are display affordances only. Server routes remain authoritative.
- Object/file access uses principal-aware ACL helpers; do not bypass them with raw object-storage reads for user-visible data.
- Migration note: legacy `requireAdmin`, `role`, `isAdmin`, and scope-string gates may remain only as compatibility wrappers or privileged-mode audit checks. New user-triggered authorization must be expressed as named permissions plus principal ownership predicates.


### Skills and Prompt Modules

- Skills are runnable workflows stored in `skills` with run records in `skill_runs`. They are user/agent-facing capabilities and may be launched by the skill runner.
- Prompt Modules are internal prompt templates stored in `prompt_modules` with snapshots in `prompt_module_versions`. They are loaded by code with `getPromptModulePrompt()` / `getPromptModule()` and are not runnable Skills.
- `prompt-module-registry.ts` is the typed manifest for prompt keys, domains, owner systems, and call-site metadata. Code should use manifest keys instead of ad hoc string literals.
- `prompt-module-defaults.ts` is bootstrap/backfill fixture data only. Runtime prompt fetch must fail closed when a DB prompt module is missing; do not silently recreate from defaults or Skills.
- Prompt module routes must enforce named permissions at the route boundary: read with `build:read`, mutation/backfill/restore/delete with `build:write` or `system:write`.
- Do not reintroduce boot-time reconciliation that rewrites live `skills` or `prompt_modules` from code defaults. Live DB rows are the source of truth after bootstrap/migration.

Key files:

- `prompt-modules.ts` — storage/helpers for prompt module retrieval and versioning
- `prompt-module-routes.ts` — API routes for Internal Prompts UI
- `prompt-module-registry.ts` — typed prompt key/domain/call-site manifest
- `prompt-module-defaults.ts` — bootstrap fixture, not live authority

## Communications

- `communications-storage.ts` is the canonical principal-scoped boundary for reusable People audiences and email campaign drafts.
- `routes/communications.ts` exposes ADMIN CRUD only. It intentionally has no send, approve, schedule, test-send, or SendGrid endpoint.
- People remains the canonical recipient identity source. Audience definitions store Person IDs, not copied contacts.

## Model Routing & Inference Tracking

Single boundary: all text LLM calls must go through `model-client.ts`. Callers pass intent (activity, source, run/session/skill/tool/plan metadata); `model-client.ts` resolves routing through `model-routing.ts` and `model-connectors.ts`, executes the provider adapter, and records inference through `cost-tracker.ts`. Direct provider/client calls for text LLM work are architectural violations.

Routing policy lives in `model-routing.ts` and `model-connectors.ts`. The active persona selects one semantic tier; no persona-level default is applied when no active persona is available. Enabled model connectors are attempted in one global priority order, and each connector translates that unchanged tier to its provider model. Activity is audit metadata only. Connector failures are recorded in the boundary audit and may fall through only before visible stream output.

Direct model overrides are exceptional and must include `overrideReason`. They are tracked as explicit overrides with routing metadata. Build verification guards that the model boundary remains compilable.

Inference tracking is boundary-owned. `chatCompletion` and `chatCompletionStream` record success, error, abort, and partial stream outcomes with provider/model/activity/source/status/usage/routing metadata. `trackChatCompletion` is deprecated compatibility only and skips results already marked `trackedAtBoundary`.

Provider failures are normalized once in `model-client.ts` into a sanitized structured envelope. The boundary logs one terminal `model.provider_failure` record through `createLogger`, preserves allowlisted provider codes, messages, response/request IDs, status, phase, retryability, event shape, and failed-response usage in inference audit, and carries a safe specific `userMessage` through the executor and chat journal. Never flatten a structured provider failure into a generic `Error`, persist arbitrary response headers/raw events, or expose the bounded raw body snippet outside internal inference diagnostics.

Reasoning effort is capability-gated, not name-matched. OpenAI connector tier mappings are the canonical configured source when present; legacy `model_profiles.tiers[*].thinking` remains compatibility fallback for callers that do not carry connector model config. `thinking-config.ts` resolves fallback thinking and `resolveOpenAIReasoningEffort` maps it to OpenAI effort values. The no-thinking floor is `none`; do not emit legacy `minimal` for GPT-5.6/Codex Responses requests. Models opt in via `thinking.selectableEffort` in `model-registry.ts` (`supportsSelectableEffort`). Effort-capable direct OpenAI models route through the Responses API adapters in `model-client.ts` (reusing the Codex input/tool converters); subscription/Codex requests carry `reasoning.effort`. Do not add a second effort setting or hard-code model IDs.

## Context Assembly & Retrieval

The context system builds the LLM prompt from ~40 dynamically resolved sections. Every chat, voice, and autonomous call gets a structured XML-section prompt.

### Key Files
- `context-builder.ts` — Core: resolvers, 3-layer cache, tiered graph memory retrieval, instruction/reference manifests, `renderToPrompt()`
- `context-spine-config.ts` — `SPINE_SECTIONS` array defining sections with freshness policies and context layers
- `context-instruction-groups.ts` — Semantic orientation flags mapped to instruction groups/context sections
- `shared/context-spine.ts` — Shared types: `ContextRequest`, `ResolvedSpine`, `SpineSectionConfig`, context-layer metadata
- `context-routes.ts` (146 lines) — HTTP inspection API for debugging

### Architecture
- **Context layers:** compact kernel, dynamic state, semantic instruction groups, and retrieval references
- **Semantic context flags:** orientation may set flags like `instructions.coding`, `instructions.library_artifact`, `context.relationships`, and `context.memory`; these expand to concrete section IDs without regex routing
- **3 cache layers:** Section cache (in-memory Map, TTL by freshness policy), Calendar background cache (15min TTL), Graph memory cache (5min TTL, SHA-256 keyed)
- **Event-based invalidation:** `INVALIDATION_EVENT_MAP` maps 11 event types to cache-invalidated sections
- **Coalescing:** `_sectionInFlight` Map prevents duplicate concurrent resolves
- **Graph memory retrieval:** `resolveGraphMemory()` is vNext-only — `retrieveVnextContext()` over `memory_vnext_claims` (semantic + causal + contrastive + temporal blend, weights modulated by session type and emotional state), rendered by `renderVnextContext()` with tiered allocation (`allocateTiers()`). No legacy fallback: errors return "Graph memory temporarily unavailable.", empty results render empty. No LLM calls at query time
- **No layer sections:** short/mid/long-term memory layers are no longer context sections. `memory_entries` remains a write-side store only (session summaries, sleep cycle) pending full retirement
- **Pre-warming:** 7 storage layers pre-warmed at boot (people, projects, tasks, principles, rules, goals, skills)
- **Budget:** compact boot context target; heavy docs render as retrieval references, no truncation of source data

### When Working Here
- Section resolvers run in parallel via `Promise.all` — each has a 15-second timeout
- Calendar resolves from a background cache, not live API — may return placeholder on cold boot
- Long-term memory section filters to un-graphed entries only (graphed entries come via graph retrieval)
- To add a new section: add to `SPINE_SECTIONS` in config, add resolver function, add to appropriate call type

---

## Voice Architecture

Single engine: ElevenLabs handles audio, our server handles LLM via custom-LLM transport.

Real-time voice database work uses the reserved `voice` lane. Install it before route registration for start, custom-LLM callback, and session-save endpoints only. AsyncLocalStorage selects the lane through the canonical `db` proxy, so storage methods must not bypass it with raw general-pool access. The four voice connections are carved from the existing thirty-connection per-process budget and enforce a 750 ms acquisition ceiling plus a 4 s statement ceiling. Config, diagnostics, boot reconciliation, and other non-call traffic remain on the general lane. Pool closure belongs to the server's graceful-shutdown coordinator, never an eager module-level signal handler.

### Key Files
- `voice/` — Decomposed custom-LLM pipeline (see `voice/AGENTS.md` for full module map)
  - `voice/utils.ts` — Text helpers, URL resolution (`getPublicBaseUrl`)
  - `voice/session.ts` — Session CRUD, health watchdog, turn locking, DB reconciliation
  - `voice/sse.ts` — SSE primitives, orphan handling, lifecycle event wiring
  - `voice/persistence.ts` — Turn data persistence (messages, early transcript, errors, orphaned turns)
  - `voice/prompt.ts` — System prompt assembly (cached), conversation messages, `resolvePromptAndMessages`
  - `voice/circuit-breaker.ts` — Circuit breaker, concurrency cap, blocker wait
  - `voice/pipeline-log.ts` — Pipeline stage logging, turn forensics, completion summaries
  - `voice/turn-io.ts` — Coalescing, backpressure, cascade keepalive, stream chunks
  - `voice/turn-handlers.ts` — Success/abort/error handlers, `runExecutorPhase`
  - `voice/types.ts` — Shared types (`VoiceSession`, `VoiceMessage`, `TurnContext`, `SSEWriteState`)
  - `voice/tool-middleware.ts` — Voice-specific tool middleware (session.end, park_idea, journal, correlation IDs)
  - `voice/thinking-filter.ts` — Strips `<thinking>` blocks from voice streaming output
  - `voice/turn-context.ts` — `TurnContext` factory for per-turn state
  - `voice/index.ts` — Public exports (`voiceEngine`, `handleV25CustomLLM`, diagnostics, transcript)
  - `voice/engine.ts` — Engine handle, delegates to `turn-lifecycle.ts`
  - `voice/turn-lifecycle.ts` — Request entry, SSE instrumentation, diagnostics
  - `voice/sse-stream.ts` — Response SSE instrumentation (v2.5)
  - `voice/diagnostics.ts` — WS routing + thinking persistence
  - `voice/transcript.ts` — Interim/final transcript fan-out
  - `voice/session-state.ts` — Shim for v2.5 callers (delegates to session.ts)
- `voice-llm.ts` — Orchestration hub (~1500 lines): handleCustomLLM, executeVoiceTurn, turn lifecycle. Imports from voice/ submodules.
- `tool-execution.ts` — Unified tool execution pipeline with middleware chain and idempotency cache
- `elevenlabs.ts` — ElevenLabs API client (`setupAgentCallbackUrl`, `getSignedUrl`, `fetchAndCacheVoiceId`, `provisionV2Agent`)
- `routes/voice-session.ts` — `/api/voice/sessions/start` and `/api/voice/sessions/end`
- `routes/voice-engine.ts` — Webhook base URL override routes
- `cli-sdk-adapter.ts` — CLI SDK streaming + voice pre-warming (`preWarmVoiceCli`, `claimVoiceWarmHandle`, `cleanupVoiceWarmHandle`)
- `shared/voice-engine.ts` — `VoiceStartParams`, `VoiceStartResult` types

### Voice Start Flow
1. Client POSTs `/api/voice/sessions/start` with `chatSessionId`
2. Server ensures agent is configured (`setupAgentCallbackUrl`)
3. Context assembly runs in parallel with signed URL prefetch
4. Once context is ready, CLI pre-warm spawns a subprocess (`preWarmVoiceCli`)
5. ElevenLabs signed URL returned to client; client connects via WebSocket
6. Client plays connection chime on connect (`client/src/lib/voice-chime.ts`)
7. User speaks first (no canned greeting)

### CLI Pre-Warming
- `preWarmVoiceCli(opts)` — spawns CLI subprocess with delegating tool handlers during voice start
- `claimVoiceWarmHandle(sessionId, toolExecutor)` — claimed on first custom-LLM callback, binds real tool executor
- `cleanupVoiceWarmHandle(sessionId)` — cleanup on session end
- Warm handles expire after 60s; background sweep every 30s

---

## Session Streaming

Server-authoritative streaming state for chat sessions. The server maintains a `StreamingContent` state object per active session. Clients subscribe via WebSocket and receive a snapshot + deltas. No client-side reducers or reconciliation — the server is the single source of truth.

### Key Files
- `session-manager.ts` — `SessionManager` singleton. Maintains `Map<sessionId, LiveSession>` with streaming state, subscriber sets, and run status. Provides `applyEvent()` to mutate state and broadcast deltas, `subscribe()`/`unsubscribe()` for WS clients
- `streaming-reducers.ts` — Pure reducer functions for `StreamingContent` (appendThinking, addToolCall, appendToolResult, setSegments, etc.). Used by SessionManager
- `shared/streaming-types.ts` — Shared types: `ExecutionStep`, `MessageSegment`, `StreamingContent`, `StreamingStatus`
- Diagnostic timing is normalized by the shared streaming reducer: every node is either a span with authoritative `startedAt`/`endedAt` boundaries or a milestone with one `occurredAt`; only spans contribute duration. Producers must preserve stable IDs and parents, and visibility filtering must never alter timing accounting.

### WebSocket Protocol
- `session.subscribe { sessionId }` — Client subscribes to a session. Server replies with `session.snapshot`
- `session.snapshot { sessionId, content: StreamingContent, status }` — Full state snapshot on subscribe or reconnect
- `session.delta { sessionId, streamingContent, status }` — Incremental state update during streaming
- `session.unsubscribe { sessionId }` — Client unsubscribes
- `/ws/events` upgrades require an authenticated user Principal. Generic events carry one audience discriminant (`user`, `system`, or `global`); both live and replay delivery use the same visibility predicate. `session.subscribe` must verify the requested session through principal-scoped storage before touching `SessionManager`.
- Event reconnect uses `events.resume` with a process-local event ID cursor. Replay is principal-scoped, bounded to 200 buffered events, and filtered by canonical payload identity. A restart invalidates the cursor; clients then recover from canonical session state. Replayed records use the ordinary `type: "event"` envelope so live and replay consumers share one reducer.

### Event Flow
```
AgentExecutor stream → publishJournalToUI() → SessionManager.applyEvent()
  → reducer mutates StreamingContent → broadcast delta to WS subscribers
```

Generic EventBus events are process-local operational signals. `chat.stream` is delivered synchronously and discarded; other events live in a principal-scoped 2,000-entry memory ring for current-boot history, hook testing, and reconnect replay. EventBus never writes to PostgreSQL. Canonical user state and hook execution records remain durable in their owning stores.

### When Working Here
- `SessionManager` is a singleton — one instance per server process
- Chat response ownership begins when a message is accepted, before model selection or context assembly. `server/integrations/chat/run-lifecycle.ts` is the sole generation authority across preparation, execution, persistence, and finalization. User messages always persist; only the newest generation may produce or settle an assistant response. Supersession and explicit cancellation are distinct terminal reasons.
- Browser message POSTs carry a `clientTurnId`. `chat-file-storage.ts` atomically deduplicates that ID under the session lock before generation ownership changes, so a replay cannot create another user row or supersede the active run.
- Client presence is one logical entry per browser tab. WebSocket registration and HTTP heartbeat must carry the same per-tab ID and merge at `server/client-presence.ts`; transports are not clients.
- Event-socket subscription mutation is synchronous with socket lifecycle. `server/realtime-transport-metrics.ts` mirrors physical socket↔session links for observability, while `SessionManager` remains authoritative for logical subscription owners; the Performance page reports divergence between them.
- State is in-memory only — lost on restart. Clients resubscribe and get a fresh snapshot on reconnect
- Reducers are pure functions — all side effects (broadcast, status tracking) live in SessionManager

### Event-Carried State for Session List

`chat-file-storage.ts` → `invalidateSessionsCache(delta?)` publishes `data:sessions_changed` events. When a delta is provided, the event payload includes `{ action: 'created' | 'updated' | 'deleted', sessionId, session? }`. The client applies deltas directly to its cache without refetching.

**Key call sites with deltas:** `createSession`, `createVoiceSession`, `createAutonomousSession` (created), `deleteSession`, `archiveSession` (deleted), `saveSession`, `updateSessionTitle`, `updateSessionStatus` (updated). Remaining call sites (message saves, context updates) omit the delta — client falls back to full invalidation.

**When adding new session-mutating operations:** Pass a delta to `invalidateSessionsCache()` if the operation changes session metadata visible in the sidebar (title, status, existence). Operations that only change message content don't need deltas.

---

## Tool Architecture

126 bridge tool handlers in a single dispatch table. Three invocation paths converge on one `executeTool()` entry point.

### Key Files
- `bridge-tools.ts` (11,670 lines / 587KB) — **The monolith.** All handlers, `DISPATCH_MAP`, `executeTool()`
- `tool-registry.ts` (1,602 lines) — Tool metadata (`TOOLS` map), schema generation, `buildRegistry()`
- `tool-details.ts` (358 lines) — Extended per-tool documentation
- `cli-sdk-adapter.ts` (1,005 lines) — Claude Agent SDK/MCP bridge, Zod schema conversion
- `agent-executor.ts` (1,771 lines) — `AgentExecutor` class: multi-iteration LLM loop, write-ordering, compaction

### Architecture
- **DISPATCH_MAP** merges `localHandlers` + `bridgeHandlers` (126 named async handlers)
- **Umbrella pattern:** Most LLM-facing tools take an `action` parameter and route internally (e.g., `memory`, `gmail`, `people`)
- **Every tool gets a `reasoning` parameter** injected automatically for audit trail
- **Argument validation:** Checks required params + rejects unknown keys. No type/range validation
- **Side-effect classification:** Tools classified as `sideEffectOnly` when result doesn't need LLM display (orient, observe, write operations)
- **Write-ordering** in `AgentExecutor`: reads batched concurrently (`pLimit(4)`), writes serialized, reads on mutated resources serialized
- **Tool stats:** Cumulative call counts, error counts, duration. Persisted to `system_settings`

### Execution Ownership Mode
Tool execution flows through exactly one owner per invocation, determined at run initialization:
- **`sdk_owned`** — When `options.toolExecutor` is provided (voice and interactive chat). The Claude Agent SDK calls `toolExecutor` inside `iterator.next()`. The executor's `pendingToolCalls` is always empty — SDK-handled tools route directly to `resolvedToolCalls` for persistence. Double-execution is structurally impossible.
- **`executor_owned`** — When no `toolExecutor` is provided (direct or non-interactive executor callers). The executor collects `pendingToolCalls` from `tool_use` blocks and executes them post-stream.

### Unified Tool Executor
`tool-execution.ts` provides `createToolExecutor(middlewares[], ctx)` — a middleware chain pattern where voice-specific concerns (session.end interception, park_idea source injection, journal logging, correlation IDs) are middleware functions composed at the call site, not a parallel execution path. An always-on idempotency guard keyed by `(runId, toolCallId)` prevents duplicate execution even if the structural fix has a gap.

### Controlled Tool Continuations
Tool handlers may return an internal continuation discriminant when ordinary post-tool model continuation would violate the interaction contract. `persona_switch` interrupts the old provider query, refreshes context/model/persona, and continues the same run. `await_user` interrupts the provider query after persisting the tool call, then ends the run successfully so a later user message starts a new turn. The SDK adapter waits for observed tool executions and correlation IDs to settle before interrupting and closing the iterator. Do not emulate either boundary with prompt instructions, side-effect-only classification, or client state.

### Tool Output Artifact Layer
`tool-output-artifacts.ts` enforces the context-budget invariant for tool results. `AgentExecutor` wraps the active `toolExecutor` before SDK handoff and also bounds executor-owned fallback results before they are persisted, streamed, or appended as `tool_result` blocks. Results over the configured inline budget are stored through `indexed_content`/object storage using heuristic indexing, and the transcript receives a compact archived-output reference plus preview. Context reconstruction must treat those references as opaque unless the model explicitly calls `indexed_content` to read a section.

Environment knobs:
- `TOOL_OUTPUT_ARTIFACTS_ENABLED=false` disables the layer for rollback.
- `TOOL_OUTPUT_INLINE_TOKEN_BUDGET` default `8000`.
- `TOOL_OUTPUT_MAX_INLINE_CHARS` default `32000`.
- `TOOL_OUTPUT_PREVIEW_CHAR_BUDGET` default `4000`.
- `TOOL_OUTPUT_FORCE_ARTIFACT_TOKEN_BUDGET` default `20000`.

### Git Session Isolation

Git write actions (clone, add, commit, push, create_pr, merge_pr, delete_branch) are available in all sessions, with **session-scoped working trees** to prevent concurrent sessions from clobbering each other's branches and commits.

**Clone isolation:** The `clone` action always appends `-{sessionId[:8]}` to the directory name. `git(clone, url, directory: "xyz")` produces `repos/xyz-{sessionId[:8]}`. This is structural, not optional. Clone is idempotent: re-cloning in the same session returns the existing directory.

**Write ownership:** All git write operations (pull, branch create/switch, checkout, add, commit, push, create_pr, merge_pr, delete_branch) verify the directory ends with the calling session's suffix. A session cannot write to another session's clone. Read operations (status, log, diff, show, branch list) are unrestricted.

**Behavioral guardrails** (from Code Instructions bootstrap context):

- Branch from main with descriptive names (feat/, fix/)
- PRs always target main — never merge directly to live
- Build verify with `npm run build` before committing. Do not create, restore, or run tests. Do not run standalone TypeScript checks (`npm run check`, `tsc --noEmit`, or equivalent) unless Ray explicitly reverses the build-only policy in the current conversation.
- Read AGENTS.md before editing any directory
- Update AGENTS.md in the same PR when architecture changes

The `gitWriteOverride` field on session metadata is retained as an admin escape hatch for disabling writes on specific sessions.

### Invocation Paths
1. **Chat (sdk_owned)** — `AgentExecutor.run()` → SDK calls the route-provided `toolExecutor` → `executeTool()`. Tool-triggered `persona_switch` and `await_user` boundaries use the controlled continuation protocol above.
2. **Voice (sdk_owned)** — `AgentExecutor.run()` → SDK calls `toolExecutor` → `createToolExecutor(voiceMiddlewares)` → middleware chain → `executeTool()`. No batching, no write-ordering. `pendingToolCalls` stays empty.
3. **UI/REST** — `POST /api/agent/tools/:toolName` → `executeBridgeTool()`

### When Working Here
- Treat tool arguments as sparse patches, not full records. Optional empty strings, empty arrays, and empty objects are absence unless a handler explicitly allows empties. Destructive clears must flow through an explicit clear contract, never through schema-default blank values.
- **Never add a handler without also adding it to `TOOLS` in `tool-registry.ts`** — unregistered handlers are invisible to the LLM
- **New `TOOLS` entries must be top-level keys** — inserting inside an existing tool's object literal silently nests the new entry as a property of that tool instead of registering it. Always verify the new entry is a direct child of the `TOOLS` object (same indentation as `meta:`, `expo:`, `railway:`, etc.) and that the preceding entry's `},` is closed before the new key starts.
- Tool handlers use lazy dynamic imports for storage modules — `const { foo } = await import("./bar")`
- Person ID resolution at `bridge-tools.ts:78` is reused by all people-related handlers (fuzzy match, Levenshtein)
- The monolith is the biggest codebase risk — a syntax error breaks all tools

---

## Autonomous Execution & Scheduling

Four interacting layers: intention stack (what), timer scheduler (when), skill runner (how), admission controller (whether).

### Key Files
- `autonomous-skill-runner.ts` (1,796 lines) — Skill execution pipeline, intention execution, campaign management
- `timer-scheduler.ts` (1,658 lines) — Timer registry, schedule computation, 18 system timer seeds
- `run-admission.ts` (373 lines) — Slot-based concurrency with tier-based priority
- `hook-executor.ts` (297 lines) — Event-pattern → action reactor
- `routes/intentions.ts` — Intention CRUD
- `routes/timers.ts` — Timer CRUD
- `routes/hooks.ts` — Hook CRUD
- `integrations/batch/` — Batch job infrastructure

### Intention Stack
- Status lifecycle: `pending → in_progress → pending_review → complete` (or `failed`/`not_planned`)
- Execution modes: `gift` (tier-1 internal-write only), `supervised` (creates session, flags for attention), `campaign` (chunked work plan from Library page)
- Attempts tracked per intention with outcome, tokens, session ID

### Timer Scheduler
- **18 system timer seeds** hardcoded and reconciled on every boot
- Key timers: Consolidate (30min), Sleep (2AM), Brief Daily (7AM), Intention Advance (6h), Email Sync (1h)
- **Serialized queue** — timers run one at a time with 12s stagger delay
- **PreContext builders** for skill timers: brief, review, reflect, plan (weekly redirects to monthly on last Friday)

### Admission Controller
- **4 tiers:** communication (highest, always granted), realtime, request, background (lowest)
- **Partitioned budget:** `RUN_ADMISSION_FOREGROUND_BUDGET` defaults to 7 and caps communication/realtime/request work; `RUN_ADMISSION_BACKGROUND_BUDGET` defaults to 3 and caps background work. Total concurrency is their sum, default 10.
- **Inherited work:** user-originated plan and workflow children run at foreground realtime priority and share the root session lineage; runs in one lineage never preempt one another.
- **Blocking children:** a parent executor suspends its slot while a blocking plan execute/resume tool owns execution, then reacquires before continuing.
- **Yield contract:** a genuine yield is terminal for that child attempt. Persist the failed session/spawn/block state so the plan or workflow monitor can retry or pause; never leave a yielded session streaming.
- **Background lifetime:** background slots have a 15-minute max age
- **Cooldown:** env-configurable post-communication cooldown via `RUN_ADMISSION_IDLE_THRESHOLD_MS`, default 60 seconds; cooldown blocks background runs
- **Preemption:** Higher tier can set `yieldRequested` on lower-tier slots outside its execution lineage

### Hook System
- Event-driven: glob pattern match → AND-condition on payload → cooldown check → rate limit (100/min)
- Actions: `run_skill`, `initiate_conversation`, `tool_call`
- Template interpolation: `{{payload.sessionId}}` in action configs

### Campaign Architecture
- Intention + `workPlanPageId` = campaign. Library page contains numbered chunks with status emojis
- `truncateWorkPlanForContext()` intelligently compresses work plans (7000 char budget)
- Continuation via `chat.autonomous.checkpoint` event → 10s cooldown → re-execute
- Idle recovery via `system.state.idle` event → scan for retriable candidates

### When Working Here
- `activeSkillRuns` Set prevents concurrent duplicate executions — check before adding new skill paths
- Triage is fire-and-forget (not awaited) to avoid DB pool exhaustion — don't change this
- Campaign continuation hooks fire on events, not timers — no polling
- Side-effect tier enforcement only applies in `gift` mode — every tool call checked against `SIDE_EFFECT_TIERS`

---

## Skill System

Runnable workflow skills are stored in the DB, executed by the autonomous runner, and scored by LLM-evaluated checklists. Internal prompt templates belong to Prompt Modules, not this inventory.

### Key Files
- `skill-defaults.ts` — Bootstrap fixture for runnable workflow Skills only. Not live authority and not a boot-time mutation source.
- `skill-scoring.ts` (~350 lines) — Checklist evaluation, comparative scoring, transcript assembly with artifact enrichment
- `session-artifacts.ts` (~160 lines) — Session↔artifact join table: `recordSessionArtifact()`, `getArtifactsBySession()`, `getSessionsByArtifact()`, `resolveArtifactContent()`
- `skill-seed.ts` (507 lines) — Boot seeding, migrations, rename map, zombie cleanup
- `skill-routes.ts` (310 lines) — REST API
- `shared/models/skills.ts` — Schema: `skills`, `skill_runs`, `skill_scores`, `skill_references`

### Architecture
- **16 hardcoded `SKILL_RUN_CONFIGS`** — callType, activity, temperature, timeout per skill
- **Dynamic fallback** for user-created skills: `callType: "full"`, 10-minute timeout, `sessionType: "agent"`
- **Scoring pipeline:** Event-driven on `chat.session.status_changed` → transcript assembly (50K char budget) + artifact content enrichment → checklist evaluation → comparative (vs prior run) → persist to `skill_runs`
- **Session artifacts:** `session_artifacts` join table links sessions to artifacts created during tool calls. Recorded by `recordSessionArtifact()` in bridge-tools handlers (library create/update/edit, files write, memory write, content queue_draft, exec render_artifact_docx, docx write/clone). The scorer fetches artifact content via `resolveArtifactContent()` to evaluate actual output quality
- **Trust score:** `successCount / (successCount + failureCount * 3)` — failures weighted 3×
- **3 pinned to context:** plan, spec, draft (always in prompt regardless of recency)
- **8 skip memory:** enrich-email, sleep, integrate, consolidate, tools-indexcontent, council, advocate

### When Working Here
- `customized: true` flag on a skill prevents seed overwrite on boot — user edits are preserved
- Post-execution side effects (reflect→library, review→temporal) are hardcoded in the runner, not skill-defined
- Scoring activity always uses `ACTIVITY_FRAMING` tier regardless of skill's own model tier

---

## Comms / Email System

- Email draft creation and editing are the only LLM-facing write operations; sending remains human-only through the authenticated widget route.
- Gmail `update_draft` body edits are patch-first and mutually exclusive: exact `findReplace`, hash-guarded `rangePatch`, or explicit `replaceBody`. Route every mode through `EmailDraftStorage.mutateBody`; never perform handler-side read/modify/write.

Gmail OAuth sync into a 7-table PostgreSQL cache, with triage classification, thread enrichment, and People import.

### Key Files
- `gmail.ts` (1,033 lines) — Gmail API wrapper, OAuth, contact scanning
- `email-sync.ts` (447 lines) — Full/incremental sync pipeline
- `triage-runner.ts` (368 lines) — Programmatic LLM triage (5 tiers: 🔴🟡🟢📋🗑️)
- `email-enrichment.ts` (70 lines) — Two-phase: deterministic dismissal + LLM enrichment
- `import-queue.ts` (405 lines) — People contact import from unknown senders
- `routes/email.ts` (545 lines) — REST API
- `bridge-tools.ts` lines 743–1728 — Gmail/email_cache bridge handlers

### Architecture
- **Sync:** Hourly via system timer. Full sync (500 msg cap) or incremental (Gmail History API). Reconciliation runs after sync but skips untriaged messages (triage-before-reconcile invariant — new messages must enter the triage pipeline before reconciliation can mark them isDone). Email Sync owns downstream triage/enrichment after a successful sync; the old standalone twice-daily Email Pipeline system timer has been removed to prevent split-brain diagnostics
- **Pipeline scope:** All pipeline queries (triage input, enrichment input, pipeline counts) use a 30-day recency filter instead of isDone as the scope boundary. isDone is an attention-layer concept (inbox cleared) and does not gate pipeline eligibility. Recency prevents reprocessing the entire email archive while allowing new messages on old threads to enter the pipeline
- **Triage:** Programmatic pipeline (sub-batches of 5, 2 workers) runs from Email Sync downstream and manual `email_cache.run_downstream`. Skill-based legacy triage is not the scheduled path
- **Enrichment:** Phase 1 auto-dismisses 🗑️/📋 threads. Phase 2 LLM enriches remaining. Server-side guard: any thread with an inbound triaged 🟡/🔴 message can never be auto-dismissed. Staleness detection: if a thread has newer messages than its existing enrichment, the thread is treated as unenriched and re-enters the enrichment pipeline
- **People integration:** On triage, matched senders get interaction logged; unmatched get queued to ImportQueue
- **Review model:** Review is decoupled from isDone. The Review tab shows all triaged, enriched, undismissed threads regardless of reply status. The Inbox tab retains isDone=false filtering. The badge counts unread, undismissed, triaged+enriched messages
- **Dismissal staleness:** When a dismissed thread receives a new inbound message newer than the dismissal timestamp, the dismissal is considered stale and the thread resurfaces in Review. Implemented via `excludeDismissed=true` server-side filter with NOT EXISTS + staleness comparison

### When Working Here
- Triage was hardened after an Apr 20 production hang (DB pool exhaustion) — conservative concurrency defaults exist for a reason
- `mark_triaged` does significantly more than update status — it auto-dismisses, archives in Gmail, logs interactions, and queues People imports
- Import queue is a single JSON blob in `system_settings` — not concurrent-safe
- **Triage-before-reconcile invariant:** Reconciliation must skip untriaged messages. If reconciliation sets isDone=true before triage runs, the message falls through both the triage pipeline and the Review tab permanently
- **Review ≠ Inbox:** Review shows the full enriched thread history (for triage decisions). Inbox shows only actionable unreplied messages. These are separate concerns with separate filters

---

## Social / Publishing

Content queue with draft→scheduled→published lifecycle, X/Twitter OAuth 1.0a posting, and a parallel content indexer for large-content archiving.

### Key Files
- `content-publisher.ts` (243 lines) — Publish loop, time suggestions, calendar sync
- `content-storage.ts` (124 lines) — Queue CRUD with `FOR UPDATE SKIP LOCKED` claiming
- `twitter.ts` (433 lines) — Hand-rolled OAuth 1.0a, tweet/thread/news operations
- `content-indexer.ts` (303 lines) — Large-content archiving with LLM structural indexes
- `routes/content.ts` (190 lines) — REST API

### Architecture
- **Publishing:** 5-minute system timer → `claimContentForPublish()` (atomic `SKIP LOCKED`) → post to X → update status
- **Threads:** First tweet + chained `replyToTweet()` for each subsequent part
- **Time suggestions:** Weekday slots (9 AM / 3 PM CT), Wednesday priority, 4-hour minimum gap
- **Content indexer:** Used by 10+ callers (web fetch, email, shell, git) for large content. Writes to object storage + generates LLM structural index with section offsets

### When Working Here
- Content tool can `queue_draft` but cannot approve/schedule/publish — those are REST-only
- `postTweet()` makes 2 API calls per post (tweet + verifyCredentials for URL)
- Content indexer is not social-specific — it's a platform-wide archiving utility

---

## Exec / Career Management

Skills inventory, experience log with scope metadata, opportunities pipeline with artifact generation, verified metrics bank, and education records.

### Key Files
- `exec-storage.ts` (669 lines) — Experience CRUD, skill linking, auto-heal DDL for scope columns + metrics/education tables
- `opportunity-storage.ts` (276 lines) — Opportunities CRUD, artifact slot management (upsert/get/setDocx)
- `opportunity-artifacts.ts` (143 lines) — Library page provisioner: resolves/creates Opportunities → Company → artifact hierarchy, builds preContext work orders
- `artifact-docx.ts` (183 lines) — DOCX renderer for resume and cover letter from zod-validated content schemas
- `docx-brand.ts` (106 lines) — Brand design tokens for DOCX generation
- `routes/exec.ts` (530 lines) — REST API for all exec entities + artifact generation endpoint
- `shared/models/exec.ts` — Drizzle schemas + zod content contracts (resumeContentSchema, coverLetterContentSchema)
- `shared/models/opportunities.ts` — opportunity_artifacts table schema, artifact kinds

### Architecture
- **6 tables:** `exec_experience` (with scope: title, location, teamSizePeak, directReports, pnlOwned, budgetManaged, fundingRaised, companyContext), `exec_skills`, `exec_opportunities`, `exec_metrics` (verified quantified accomplishments), `exec_education`, `opportunity_artifacts`
- **Artifact slot system:** Each opportunity has 3 slots (research, cover_letter, resume). Slots are upserted via unique(opportunityId, kind) constraint. Each slot links to a Library page and optionally a generated DOCX file
- **Server-owned provisioning:** `ensureArtifactSlot()` resolves or creates the Library hierarchy (Opportunities root → Company → artifact page) before spawning the skill session. This prevents race conditions on page creation
- **Skill spawning:** POST `/api/exec/opportunities/:id/artifacts/:kind/generate` → provisions slot → builds preContext → `executeAutonomousSkillRun()` → navigates client to skill session
- **Concurrency guard:** Checks for active skill session before allowing generation (prevents duplicate runs)
- **3 artifact generators:** research (opportunity mode: web research → Library page), cover-letter (structured content → Library + DOCX), resume (3-phase gap analysis → Library + DOCX)
- **Metrics bank:** Verified quantified accomplishments (metric name, value, optional experienceId link). Resume skill pulls ONLY from metrics bank — never fabricates numbers
- **DOCX rendering:** `render_artifact_docx` bridge tool action validates content against zod schema, renders via docx package with BRAND tokens, writes to object storage

### When Working Here
- Experience scope fields are auto-healed on boot — DDL adds columns if missing, backfills title=domain
- Artifact DOCX files live in object storage at `artifacts/{filename}`
- The opportunity_library_pages physical table still exists in DB (legacy) but is unused — opportunityArtifacts replaced it
- Resume skill requires the Resume Design Standard Library page at runtime
- Cover letter and resume skills validate output against zod schemas before DOCX generation — malformed content fails gracefully

---

## Supporting Systems

### Library & Wiki
- **5 tables:** `library_pages`, `library_annotations`, `library_page_views`, `library_page_links`, `info_notes`
- **Dual content:** `plainTextContent` (markdown, source of truth) + `content` (TipTap JSON, rendered)
- **Memory integration:** Every page synced to `memory_entries` with `source=library` via `upsertLibraryPageMemory()`
- **Filing system:** `library-index.ts` maps section slugs to parent page IDs for auto-filing
- Key files: `routes/info.ts` (1,238 lines, 30 endpoints), `library-index.ts` (177 lines)

### People & Relationships
- **Document-backed** in `workspace_documents` (type: person). `PeopleStorage` class (1,141 lines)
- **Full-load-then-filter** pattern — all queries load all people into memory
- **Computed fields:** rollup (contact frequency), due status (cadence-based), outreach priority, mobilization readiness
- Key files: `people-storage.ts` (1,141 lines), `import-queue.ts` (405 lines)

### Finance
- **26 Plaid-connected tables** in `shared/models/finance.ts`
- **Plaid service** (1,422 lines): incremental sync, holdings, liabilities, recurring, per-item locking
- **75 REST endpoints** in `routes/finance.ts` (1,950 lines) — largest API surface
- Manual assets, amortization, income modeling, budget comparison, forecast

### Wellness
- **4 tables:** `wellness_activities`, `wellness_logs`, `health_metrics`, `gratitude_entries`
- **Metric-linked auto-completion:** Activities link to metric types with great/good thresholds
- **Apple Health webhook:** `POST /api/health/webhook` — no authentication
- **Pulse scoring:** 0-1 per activity based on completion rate in rolling window
- Key file: `routes/wellness.ts` (1,266 lines)

### Decisions
- **3 tables:** `decisions`, `decision_updates`, `decision_links`
- **Lifecycle:** open → closed (with traffic light: green/yellow/red). Updates are append-only
- **Auto-heal:** Storage runs `CREATE TABLE IF NOT EXISTS` on first error
- Key file: `decisions-storage.ts` (252 lines)

### Capabilities & Stories
- Removed legacy story/capability table registry entries; capability state is derived from current tools, skills, code graph, and reports rather than the removed capability cache table.

### File-Storage Abstraction
- **16 modules** (3,713 lines) using `BaseDocumentStore<T>` pattern over `workspace_documents`
- Covers: projects, priorities, personas, principles, predictions, beliefs, preferences, check-ins, issues, emotional state
- **Common pattern:** documentStorage backend → TTLCache(Infinity) → invalidate on write → JSON serialization
- **Gotcha:** Every module loads ALL documents of its type for any query

### Settings
- `system_settings` table — key TEXT, value JSONB
- Heavily used: temporal log layers, library index, import queue, feature flags, tool stats
- Key file: `system-settings.ts` (66 lines)
## Finance Access-Control Boundary

- Finance routes must use `server/finance-scope.ts` for ownership predicates and schema healing. Do not add route-local finance ownership migrations or bespoke missing-column retry logic.
- Finance user data must fail closed: if the finance ownership schema cannot be ensured, return an error rather than falling back to unscoped reads.
- New finance tables that contain balances, transactions, assets, liabilities, income, or goals must be added to the finance sensitive table registry and queried through `visibleFinance` / `writableFinance` or the current-principal helper.

## Platform environment publishing

Production publishing is addressed as an explicit `sourcePlatformEnvironmentId -> targetPlatformEnvironmentId` promotion. `server/integrations/railway/publish.ts` resolves source and target GitHub bindings, Railway hosting bindings/connectors, and enabled lifecycle configuration before any branch or deployment mutation. The target lifecycle must be `manual_promote`, bind the exact source and target branches, use `platform_binding` auth, and require human approval. Publish runs persist both environment IDs so retries cannot silently switch targets. Railway API calls receive the target connector credential explicitly. The live branch remains human-promoted, and Railway deployment rollback remains the provider rollback path.
Legacy host-level Railway setup is not an application configuration surface. Cross-environment operations must resolve a canonical Platform Environment and its hosting binding/connector. Current-runtime self-inspection may use runtime identity only to resolve that same canonical environment. Do not reintroduce dev/prod secret bundles, `/api/railway/dev|prod/*` routes, or an Integrations Railway setup page.

## Cloudflare Pages provider boundary

Cloudflare Pages project truth and deployment commands live in `server/platforms/cloudflare-pages-service.ts`. Callers supply a decrypted credential obtained through the scoped provider-connection store. The boundary uses bounded requests, returns provider project Git/build truth, and represents deployment commands with the single `outcome` discriminant. Never expose or log provider credentials.

## Runtime Architecture

Container deployments use Tini as PID 1. The shell entrypoint must `exec` the Node server as Tini's direct child. Never make Node PID 1 and never replace Tini with route-level or child-specific reaping logic; Tini owns signal forwarding and orphaned descendant reaping for git, esbuild, Chromium, and provider tooling.
