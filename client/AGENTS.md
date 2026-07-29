# Authority

Root `AGENTS.md` is mandatory and authoritative for engineering workflow, Coding Task Gate, Engineering Principles, git policy, and verification. This file adds local constraints only. Load this file before touching files under `client/`. For UI/product-facing work, inspect the live Design page / Build Design implementation as the living source of truth, and load root `DESIGN.md` as the mirrored/checkable doctrine. If they diverge, prefer the Design page and update `DESIGN.md` rather than following stale doc text. If instructions conflict, follow root `AGENTS.md` unless Ray explicitly overrides.

# Client Architecture

React 18 single-page application built with Vite, TailwindCSS, and shadcn/ui. Communicates with the server via REST API, shared WebSocket, and Server-Sent Events (SSE).

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 (functional components, hooks) |
| Bundler | Vite |
| Styling | TailwindCSS + shadcn/ui component library |
| State | React Query (server state) + React Context (local state) |
| Routing | Wouter (lightweight, ~1.5KB) |
| Icons | Lucide React |
| Charts | Recharts |

## Directory Structure

```
client/src/
├── components/       # Shared UI components
│   ├── ui/           # shadcn/ui primitives (Button, Dialog, Card, etc.)
│   ├── chat/         # Reference mention primitives for session input
│   ├── voice/        # Voice UI, audio visualization
│   └── ...           # Domain-specific shared components
├── pages/            # Route-level page components (56 pages)
├── hooks/            # Custom React hooks
├── lib/              # Utilities, API client, WebSocket manager
├── contexts/         # React Context providers
└── styles/           # Global CSS, Tailwind config
```

## Design System

Design system source of truth: the Design page / Build Design implementation is the living product source; `DESIGN.md` is the mirrored doctrine that should be kept aligned for implementation runs. Key principles:

- **Full-width layouts**: Page containers use full viewport width. No `max-w-{N}xl mx-auto` on page-level containers. Content-width variants: `max-w-3xl` (reading) or `max-w-5xl` (forms/config).
- **Color system**: Functional token names (e.g., `cat-critical` not `cat-purple`). 60/30/10 proportion rule. Dark theme is primary.
- **Typography**: 4 scale stops only: `text-sm` (body), `text-base` (emphasis), `text-lg` (section heads), `text-xl` (page titles).
- **Spacing**: 8px rhythm. Standard gaps: `gap-2` (tight), `gap-4` (default), `gap-6` (sections).
- **Zero states**: Preserve search, the blue `+ New Thing` action, and useful section structure. Render missing content as one left-aligned quiet row (`px-2 py-1.5 text-sm text-muted-foreground`). No hero icons, centered layouts, explanatory panels, or CTA inside the empty area. Chat is the explicit exception. See `DESIGN.md`.
- **Components**: shadcn/ui as base. Extend, don't reinvent.

## Streaming Architecture

Chat streaming uses **server-authoritative sessions**. The server's `SessionManager`
maintains streaming state (`StreamingContent`) for each active session. Clients
subscribe by sessionId via WS and receive snapshots + deltas.

### Key files
- `shared/streaming-types.ts` — Shared data types: `ExecutionStep`, `MessageSegment`, `StreamingContent`
- `server/streaming-reducers.ts` — Pure reducers for StreamingContent (appendThinking, addToolCall, etc.)
- `server/session-manager.ts` — Server-side session state: subscribe/unsubscribe, snapshot, delta broadcast
- `client/src/hooks/use-session-subscription.ts` — WS transport and cache: multi-session session.subscribe/session.unsubscribe, snapshot + delta handling keyed by sessionId
- `client/src/hooks/use-chat-send.ts` — Message send flow: POST to server, server handles streaming state
- `client/src/hooks/use-voice-streaming.ts` — Voice interceptor, phase tracking, voice-specific lifecycle
- `client/src/components/focus-widget.tsx` — Canonical session entry path: owns the transcript panel, session menu, and embedded desktop BottomBar
- `client/src/components/session-transcript-panel.tsx` — Transcript/header surface; consumes the selected `SessionStreamState` and never owns normal message composition
- `client/src/components/bottom-bar/index.tsx` — Single normal session composer/input owner; sends through `useChatSend`
- Physical mobile shell invariant: `AppLayout` owns the top bar, active page or Session Window, BottomBar, and post-keyboard viewport restoration as one normal-flow flex column. Composer focus is reported upward; only AppLayout may restore outer shell height/origin. Never mutate transcript/page scroll to repair keyboard geometry. Do not place keyboard-adjacent mobile controls in independent fixed/sticky layers or reconstruct their layout with a measured spacer; WebKit keyboard dismissal can split visual and hit-test coordinates.
- `client/src/components/chat-shared.tsx` — `filterStepsByLayer`
- Diagnostic trees render the complete trace before visibility filtering. Span duration comes from boundaries, milestones render as parent-relative offsets, and overlapping children are wall-clock/parallel rather than additive. Never reconstruct timing by subtracting visible child labels.
- Terminal SessionManager snapshots are authoritative handoff state. Preserve their settled `StreamingContent` until the matching assistant message is durably terminal; never replace a saved/error snapshot with an empty stream or release it for a streaming checkpoint draft.
- A displayed stream and its persisted assistant checkpoint are one logical turn. The producer must mint one canonical run identity before the first durable checkpoint and pass that same identity into executor `run_start`; consumers match ownership by exact `assistantRunId` first, then exact `turnId`, using chronology only for legacy rows without comparable identity. While the live/frozen stream owns the turn, its matching checkpoint must not render a second transcript copy.
- Finalized assistant turns preserve streamed content/tool boundaries. `transcript-projection.ts` alone owns the terminal-to-persisted handoff; persisted chronology must reconstruct the same segment sequence, and chronological timeline blocks receive full-turn graph context without collapsing across prose boundaries.
- Transcript fallback widgets derived from persisted lifecycle metadata must deduplicate against both persisted assistant segments and the currently displayed authoritative stream. A child lifecycle event may persist before its creating tool call, but the live-to-persisted handoff still has one visible widget owner.

### Protocol
1. Chat route subscribes to the focused session plus bounded live streaming sessions via `session.subscribe { sessionId }` on the shared WS
2. Server replies with `session.snapshot { sessionId, content: StreamingContent, status }`
3. As each run progresses, server sends `session.delta { sessionId, streamingContent, status }`
4. Client stores each snapshot/delta directly in a sessionId-keyed cache (no client-side reducers)
5. On disconnect/reconnect, client resubscribes to every cached live session and gets fresh snapshots

## Browser navigation telemetry

`client/src/lib/navigation-trace.ts` is the single in-memory correlation boundary for SPA navigation evidence. History intent, route Suspense/lazy settlement, React Query activity, destination commit, main-thread evidence, and bounded session-stream pressure feed one terminal trace; only that terminal trace enters `browser_performance_telemetry`. Never persist per milestone, query event, frame, or stream delta, and never capture query keys or stream content.

## WebSocket

A single shared WebSocket connection handles authenticated `/ws/events` updates for the lifetime of the application shell:

- `client/src/lib/ws-connection.ts` — Sole physical `/ws/events` creator; owns connection, reconnection, liveness, logical owners, and bounded diagnostics.
- `client/src/hooks/use-event-stream.ts` — App-root bounded generic-event projection over the shared transport; feature consumers read it and never create or close physical sockets.
- Used for: session updates, generic events, client presence, semantic UI interaction, notification badges, and real-time state sync.
- Multiplexed: different message `type` fields route to registered logical handlers.
- Feature hooks may acquire balanced logical owner leases, but component or route lifetimes must never own the physical transport.

## Data Sync & Event-Carried State

`client/src/hooks/use-data-sync.ts` bridges server-side events to React Query cache updates.

**INVALIDATION_MAP**: Maps server event names (e.g. `data:sessions_changed`) to React Query cache keys. When an event arrives over WS, the mapped queries are invalidated (triggering a refetch).

**Event-carried state** (preferred pattern): Instead of blind invalidation → refetch, server events carry a delta payload describing exactly what changed. The client applies the delta directly to the cache — no refetch, no race condition. This is the canonical pattern for any data that needs instant UI response to server changes.

Currently implemented for:
- **Session list** (`data:sessions_changed`): Server includes `{ delta: { action: 'created' | 'updated' | 'deleted', sessionId, session? } }`. Client's `applySessionDelta()` merges directly into `["/api/sessions"]` cache. Falls back to full invalidation when no delta is present.

When adding real-time sync for new data types, follow this pattern:
1. Server includes a typed delta in the event payload
2. Client handler checks for delta before falling back to `invalidateQueries`
3. Delta handler applies the change directly to `setQueryData`
4. Optimistic inserts are naturally deduplicated (delta `created` skips if ID already present)

**suppressDataSyncEvent**: Utility to temporarily ignore specific events (used by goals page). Avoid for new code — prefer event-carried state which eliminates the race structurally.


## Skills vs Internal Prompts UI

Skills UI is for runnable workflows: capabilities with explicit run identity, sessions, scoring, and operator-facing execution. Internal Prompts UI is for non-runnable prompt templates used by code paths. Do not add run buttons, skill-run language, or session expectations to Internal Prompts unless a future architecture changes prompt execution.

Internal Prompts should show domain grouping, key/name/version/status, used-by/call-site metadata from the prompt-module registry, prompt/output-spec editing, and version restore. Skills should hide migrated internal helpers such as myelination, people summary, strategy simulation, chat compaction, and content-indexing prompt modules.
Skill persona controls edit the current user's override, not the shared skill definition. Show the product recommendation explicitly as `Recommended · {Persona}`; selecting it clears the override. Persist the preference before reporting the skill edit as complete.

Memory UI should distinguish memory entries from session mirrors and archive/raw session data. When graph/search behavior excludes raw sessions, explain the policy in UI rather than making it look like data disappeared.

## Page Architecture

56 pages organized by domain. Each page is a route-level component:

| Domain | Pages | Key Routes |
|---|---|---|
| Chat | Focus session transcript, session list | `/`, `/chat/:id` |
| People | List, detail, interactions | `/people`, `/people/:id` |
| Work | Projects, tasks, milestones | `/work`, `/work/:id` |
| Goals | Goal tree, detail | `/goals`, `/goals/:id` |
| Health | Dashboard, activities, metrics | `/health` |
| Finance | Summary, transactions, budget | `/finance` |
| Memory | Search, entry detail, graph | `/memory`, `/memory/:id` |
| Library | Vault-scoped page tree, editor, notes | `/library` (`/library2` redirects here; Library2 organization is retired) |
| Exec | Skills, experience, opportunities | `/exec` |
| Strategy | Strategy list, move tree | `/strategy`, `/strategy/:id` |
| Comms | Email, content queue | `/comms` |
| System | Dev, settings, logs | `/system` |

### Tab Pattern
Most detail pages use a tabbed layout via `Tabs` from shadcn/ui:
```tsx
<Tabs defaultValue="overview">
  <TabsList>
    <TabsTrigger value="overview">Overview</TabsTrigger>
    <TabsTrigger value="details">Details</TabsTrigger>
  </TabsList>
  <TabsContent value="overview">...</TabsContent>
  <TabsContent value="details">...</TabsContent>
</Tabs>
```

## API Client

- `client/src/lib/api.ts` — Centralized fetch wrapper with auth, error handling
- All server communication goes through this client
- React Query handles caching, refetching, optimistic updates
- Query keys follow convention: `[domain, action, ...params]`


## Access-Control UI

The client consumes authorization state from `/api/auth/me` via `useAuth()` (`user`, `principal`, `permissions`, `hasPermission`). Use these values to hide, disable, or label privileged UI, but never treat client checks as enforcement. Server routes must still gate with the central permission service.

When adding admin or system UI:
- Check named permissions (`system:read`, `system:write`, `users:read`, `users:write`, `build:read`, `build:write`) through `hasPermission(...)`.
- Do not branch on `role` or legacy `isAdmin` except as a derived display convenience.
- Hide or redirect whole privileged surfaces when the read permission is absent; do not merely disable child actions while leaving sensitive tabs or data loaders mounted.
- If a new UI action needs a new permission, add the server permission first and consume the `/api/auth/me` contract after it exists.
- Permission editors must distinguish inherited/base permissions from explicit user overrides. Saving override state is replace-set semantics: unchecked explicit grants must be omitted so they revoke cleanly.

## Badge System

Tiered badge system for status indicators across the app:

- **Error** (red): Failures, critical issues
- **Active** (green): Currently running, live
- **Attention** (yellow): Needs review, warnings
- **Unread** (blue): New items, unseen content
- **Neutral** (gray): Default, inactive

Badges consolidate in the nav: highest-priority status wins per section.

## Session UI Ownership

Focus Session is the canonical session entry surface. An optional conversation agenda renders display-only at the top of `SessionTranscriptSurface` through `SessionAgendaTree`, using the shared `HierarchyTreeRow`/Plan tree geometry; durable state and all edits remain server/session-tool owned, and absence renders no extra surface. Agenda rows use Session Menu spacing and section typography, expose description/resolution through row disclosure, highlight the first open item as current, and collapse the section by default when every item is complete. Keep ownership split by role:

- `client/src/components/focus-widget.tsx` — Orchestrates the active session, transcript panel, session menu, and desktop contained BottomBar.
- `client/src/components/session-transcript-panel.tsx` — Transcript/header surface only. It renders messages, stream state, title/actions, linked entities, plan bar, and websocket health. It must not own the normal composer/input path.
- `client/src/components/bottom-bar/index.tsx` — Single normal composer/input owner for creating/sending session messages. It owns file upload, mention autocomplete, voice input display, and `useChatSend`.
- `client/src/components/message-list.tsx` — Message rendering with markdown, code blocks, tool calls, images, and entity/reference widgets.
- `client/src/components/question-widget.tsx` + `client/src/hooks/use-question-response.ts` — Inline clarification surface. Prompts derive from persisted question tool calls; structured answers travel through the canonical session message endpoint and are rendered back into the originating widget rather than as duplicate user bubbles. The newest valid Question call is the session's single active clarification; it supersedes older unanswered calls by chronology, without a separate mutable status. A visible unanswered widget is always answerable. Its persisted response is the durable state, and its local submit-in-flight flag is the only client interaction lock. Session activity, streaming, and unrelated pending turns must never disable it. Both selection modes render the standard `SimpleCheckCircle` control; selection mode changes cardinality, not control shape. Sessions with an unanswered question surface in the sidebar's Review group via the derived `awaitingQuestionResponse` field unless an active reminder defers them to Snooze. Session classification precedence is Archive → Snooze → Review → Active → Pinned → recency buckets.
- `client/src/components/references/editable-reference-input.tsx` — Controlled rich composer input. Prevent supported `beforeinput` mutations and route them through React state. If WebKit mutates the DOM natively, remount the entire editable root and restore selection; never reconcile or re-key individual descendants after browser mutation.
- `client/src/hooks/use-client-presence.tsx` — One application-level provider owns presence registration and heartbeat. Consumers read its context; they must not instantiate transport side effects independently.
- `client/src/lib/ws-connection.ts` — The shared event socket owns a balanced logical-owner registry and exposes a read-only diagnostics snapshot. Every acquisition uses a stable owner ID, every cleanup releases that same ID, and session liveness is reference-counted by owner rather than a process-wide boolean.
- `client/src/hooks/use-ui-interaction.tsx` — The authenticated app-level semantic interaction owner. Registered targets expose stable allowlisted actions, not selectors; existing user controls and Agent commands invoke the same action. Guide commands are subject-discriminated: controls spotlight allowlisted actions, while canonical-reference resources reveal and expand their owning Home/Simple row in place. Every guide requires narration, remains transient, blocks only outside the live target, supports Escape/Cancel, and completes on the target’s native activation before its ordinary action runs; execute commands and fallback confirmation resolve from the target’s canonical route/state outcome. Durable FTUE owns reissue after reload or reconnect.
- Session-scoped ephemeral aggregates carry an explicit owner session ID. Render voice transcripts, live drafts, and similar state only when that owner matches the visible session; clearing on navigation is cleanup, not the correctness boundary.
- Native meeting transcription media is app-owned, not page-owned: `NativeMeetingTranscriptionProvider` owns the browser MediaStream, AudioContext/worklet, authenticated socket, pull-based microphone level, and native spoken-reply playback across navigation, while the Meetings action only initiates it from the direct user gesture. Construct and request resume of the AudioContext synchronously before the first awaited permission or network operation so iOS WebKit retains that gesture activation. Enabling spoken replies must synchronously start one same-origin `HTMLAudioElement` from the Listen Mode control; that element consumes the existing meeting MP3 endpoint progressively, and its single owner-scoped poll lifecycle pauses and unloads on mute, leave, capture replacement, or provider unmount. Never turn that stream back into `arrayBuffer()` / `decodeAudioData()` whole-file playback. Startup is not ready until the server acknowledges one valid PCM frame. Durable meeting lifecycle remains the correctness boundary.
- The authenticated app exposes synchronized voice visualization in two places: the persistent top-left `NavigationOrbButton` and the Session Window's established orb surface. Both are read-only projections of the same `VoiceSessionProvider` state and audio, falling back to the same app-owned native meeting capture; neither may create transport or duplicate lifecycle state.

Composer turn admission must use a synchronous ref before any state update or await. React state is display state, not a concurrency lock. Every message POST carries a stable `clientTurnId` so the server can make retries replay-safe.

Do not reintroduce a second embedded session input under the transcript panel. If a new surface needs to send a message, route it through BottomBar ownership or extract a shared hook with one owner of visible composition state.

## Component Conventions

- **All components are functional** with hooks. No class components.
- **Props use TypeScript interfaces**, not inline types.
- **Loading states**: Full-screen and page-level loading uses one centered circular `Loader2` spinner in `text-muted-foreground`. Use `Skeleton` only for inline content whose eventual shape is already known.
- **Error boundaries**: Wrap page-level components. Show friendly error with retry.
- **Responsive**: Mobile-first, but desktop is the primary target. Minimum viable mobile support.

## Infrastructure Configuration

Hosting credentials and environment configuration belong to Platform Environment binding flows. Do not add standalone provider setup pages under Integrations or host-level dev/prod variable forms. Provider-specific status and controls render within the bound Platform Environment.

## When Working Here

- **Check the Design page first for visual decisions**. Treat `DESIGN.md` as the aligned implementation doctrine, not an independent source of truth. If the Design page and `DESIGN.md` diverge, prefer the Design page and update `DESIGN.md` in the same change.
- **No `max-w mx-auto` on page containers**. Full-width is the rule. Content-width only for reading-heavy or form contexts.
- **shadcn/ui components live in `components/ui/`**. Don't duplicate or create parallel implementations. Extend via composition.
- **React Query is the data layer**. Don't use `useState` + `useEffect` for server data. Use `useQuery`/`useMutation`.
- **Wouter, not React Router**. Routes use `<Route path="..." component={...} />`. No `useNavigate` — use `useLocation` from Wouter.
- **TailwindCSS only**. No inline styles, no CSS modules, no styled-components. Exception: dynamic values that can't be expressed as Tailwind classes.
- **Icons are Lucide**. Import from `lucide-react`. Don't mix icon libraries.
- **Tab naming**: Call them "Tabs" in all specs and discussions — that's the UI system vocabulary.
- **Test in dark mode**. Dark theme is primary. Light mode exists but is secondary.
- Cross-reference: The streaming protocol is produced by the server chat route (see `/server/AGENTS.md`). WebSocket events originate from various server subsystems.

## Shared UI Patterns

### Profile Tree Rows

Use `ProfileTreeRow` for compact label/value rows with optional progressive disclosure. Pass `defaultOpen` only when readiness or missing required configuration must be visible on first render; ordinary detail rows stay collapsed.

### Meeting Tree Rows

Network Meetings reuses `SimpleWidgetRenderer` and `SimpleTreeRow` for completed meeting sessions. Meeting rows render as canonical CTA-blue references, omit completion controls because completion is implied by the index, and expand the recap summary directly when present. Participants stay in the canonical meeting record/tool response but are not duplicated as UI children because the summary already names them; non-recap Library artifacts may remain as reference children. Do not create a second meeting card or a split-view detail surface. Its search/action/section stack must consume `HIERARCHY_TREE_STACK_CLASS`, `HIERARCHY_PRIMARY_ACTION_CLASS`, and `HIERARCHY_SECTION_HEADER_CLASS`, which are shared with the Session Menu rather than copied locally. Historical meeting sections enable their React Query request only after disclosure; This Week alone defaults open.

### Opportunity Vault Visibility

Opportunity UI surfaces use `useVisibleVaults().isVaultEnabled`: unassigned Opportunities remain visible, while assigned Opportunities render only when their concrete Vault is enabled in the top bar. Expanded Pipelines rows own the title in the parent row and render frameless `ProfileTreeRow` children directly beneath it.

## Voice

Voice transcript rows use one required lifecycle discriminant: `provisional`, `committed`, or `placeholder`. Only canonical server transcript events may create committed user speech. Local provider/native callbacks may create provisional composer text, and reconnect snapshots contain committed persisted history. Live and replayed voice events must pass through one event-ID-deduplicating reducer and require exact `chatSessionId` identity before mutating state or advancing the cursor. Voice finalization settlement likewise has one discriminant: `finalized`, `not_finalized`, or `unknown`. A transport error cannot prove failure; send the bounded request with `keepalive`, retry once with the same voice-session identity, then reconcile that exact identity against durable saved session state before surfacing a destructive error.

`client/src/lib/voice-transcript-state.ts` is the canonical pure mutation boundary for user voice transcript rows. It owns cleaning, normalized comparison, sequence ordering, placeholder replacement, provisional-to-committed promotion, and duplicate rejection. React hooks generate timestamps/turn IDs and emit diagnostics, but must not reproduce transcript transition logic.

## Immersive-Orb Presentation Mode

The voice-orb entrance is a provisional, capability-scoped shell—not an authenticated app shell. `client/src/components/app-shell-immersive.tsx` (`AppShellImmersive`) deliberately mounts only the entrance orb, provisional voice transport, and account-claim affordance; it mounts none of the authenticated app providers or product surfaces.

- **One provisional transport.** `VoiceSessionProvider onboardingToken=...` owns the mic prompt, greeting, `POST /api/voice/start`, hash-keyed lease, and `VoiceSession.toolMode=none`. `ProvisionalVoiceController` starts it exactly once and publishes visual/audio state through `LiveVoiceProvider`; `ImmersiveOrbSlot` is a pure visual and never starts voice itself.
- **Claim is a hard shell boundary.** After claim establishes the authenticated cookie, the entrance calls the same `completeStartupOnboarding` mutation used by ordinary registration, derives the destination through `getStartupOnboardingDestination`, and uses `window.location.replace(...)`. This removes the onboarding capability from active history and cleanly mounts `AuthGate → BootGate → VaultProvider → AppShell`. Never mount authenticated providers, authenticated voice, Home/Simple projections, rails, or a Session clone inside `AppShellImmersive`.
- **Canonical Home FTUE.** `/home` always renders the real `HomePage`. The shared destination is `/home?c=<ftueSessionId>&autoVoice=1`; the authenticated app's global `FocusWidget` consumes those parameters, selects the canonical Welcome session, opens the Session Window where appropriate, and starts voice through the ordinary authenticated `VoiceSessionProvider`. Registration, first-admin setup, and recap claim all use this one destination helper. Recap claim passes its capability only into authenticated onboarding completion so the server can attach recipient-validated provenance and the canonical Session Agenda; the raw token never enters Home state or session persistence.
- **Chimeless exit.** The provisional entrance chime plays normally. After successful claim, the entrance suppresses only its terminal disconnect tone while navigation transfers ownership to the authenticated app.
- **Visual continuity across the hard boundary.** Claim records one short-lived, content-free session marker before `window.location.replace`. The next document mounts a shared-AgentOrb visual bridge above ordinary authenticated boot; the canonical desktop/mobile voice orb dismisses it from its actual first rendered frame and exact viewport geometry, with a bounded fail-open timeout. The bridge owns no token, identity, product data, provider, or transport.
- **Entry contract.** `client/src/lib/immersive-entrance.ts` is the single source of truth for the entrance URL: `/visualizer?i=<onboardingToken>` with no meeting `token`. `main.tsx` excludes that URL from the standalone visualizer root, and `App.tsx` renders `AppShellImmersive` for it before authentication.
- **Do not confuse with the Recall meeting visualizer.** `client/src/pages/visualizer.tsx` (`/visualizer?token=<meetingToken>` and `/visualizer?state=` preview) keeps its lightweight standalone render root and page-owned media lifecycle. It must not gain provisional-voice or app-shell wiring.
