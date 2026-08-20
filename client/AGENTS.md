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
- Terminal SessionManager snapshots are authoritative handoff state. Preserve their settled `StreamingContent` until the focused coherent Session snapshot reaches the terminal event's `durableRevision`; reject lower-revision query commits and never use a historical transcript union as continuity state. Never replace a saved/error snapshot with an empty stream or release it for a streaming checkpoint draft.
- A displayed stream and its persisted assistant checkpoint are one logical turn. The producer must mint one canonical run identity before the first durable checkpoint and pass that same identity into executor `run_start`; consumers match ownership by exact `assistantRunId` first, then exact `turnId`, using chronology only for legacy rows without comparable identity. While the live/frozen stream owns the turn, its matching checkpoint must not render a second transcript copy. The live draft React key is the server-minted `liveStreamRenderId` (attempt/run) once SessionManager publishes identity; a local `clientTurnId` draft key is only the pre-source placeholder and must not replace the attempt/run key mid-stream (Question answers and pending-turn adoption included). Focus/`activeSession` changes update subscribe diagnostic metadata only — they must not clear `requestedIds` or force a mass resubscribe of already-owned sessions.
- Finalized assistant turns preserve streamed content/tool boundaries. `transcript-projection.ts` alone owns the terminal-to-persisted handoff; persisted chronology must reconstruct the same segment sequence, and chronological timeline blocks receive full-turn graph context without collapsing across prose boundaries.
- Transcript fallback widgets derived from persisted lifecycle metadata must deduplicate against both persisted assistant segments and the currently displayed authoritative stream. A child lifecycle event may persist before its creating tool call, but the live-to-persisted handoff still has one visible widget owner.

### Segment visibility ownership

`segment-stream.tsx` owns the canonical execution-step visibility policy used by both live chat and persisted replay. Consumers may call the exported policy for summaries or timeline helpers, but must not inject a required filtering callback into `SegmentStream`; keeping the policy behind the renderer boundary prevents transport cancellation, replay replacement, or module-cycle timing from bypassing visibility filtering.

## Protocol
1. Chat route subscribes to the focused session plus bounded live streaming sessions via `session.subscribe { sessionId, subscriptionEpoch, supportsDelta: true }` on the shared WS. Each logical owner/session subscribe or unsubscribe advances `subscriptionEpoch`; `supportsDelta` advertises protocol-v2 capability.
2. Server replies with `session.snapshot { sessionId, content: StreamingContent, status, patchSeq }` — always the full state plus the patch baseline.
3. As each run progresses, the server sends `session.delta`. To v2-capable clients it is an incremental patch `{ segmentPatch: { length, set }, scalars, patchSeq, basePatchSeq, status, ... }`; to legacy clients it remains the full `{ streamingContent, status, ... }`. The client is not a domain reducer — it applies an opaque structural patch (truncate to `length`, overwrite `set` indices, merge scalars) over the baseline it already holds.
4. `patchSeq` is contiguous per session. If an incoming patch's `basePatchSeq` does not match the client's current baseline (dropped patch, or no baseline yet), the client discards it and requests a fresh snapshot rather than corrupt state. Snapshots and deltas carry `(runGeneration,eventSeq)` and only lexicographically advancing tuples are accepted; equal/regressive same-generation payloads are idempotent no-ops.
5. Disconnect, reconnect, visibility, `pageshow`, and focus feed one coalesced recovery coordinator in `useSessionSubscriptions`. That owner invalidates patch baselines and resubscribes to every cached live session; transcript components must not install parallel browser-resume refetch listeners.
6. The client cache publishes through a stable keyed external store. Transcript surfaces subscribe only to the focused session and its visible descendant previews; unrelated background deltas stay cached and must not invalidate the focused transcript subtree. Global orb activity is a separate discriminant-only context.

## React Query defaults

`client/src/lib/queryClient.ts` defaults: `staleTime: 30_000`, `refetchOnWindowFocus: false`. Do not override with `staleTime: 0` or `refetchOnMount: "always"` unless the surface is intentionally live and the fan-out cost is understood. Prefer event-carried invalidation over force-refetch on mount.

App-shell consumers of live Session state must read `SessionActivityProvider` through `useSessionStreams` plus `useSessionStreamState`; they must not call `useSessionSubscription` and create another logical subscription or browser-recovery owner. Bounded descendant renderers may use the single-session fallback only when their Session is not present in the provider-owned live set.

## Features page performance

`/features` must stay smooth under many humming pipeline sessions. Rules:

- One page-level `["/api/sessions"]` query; never re-query sessions inside each `FeatureRow`.
- One page-level `useSessionSubscriptions` store; rows read via `useSessionStreamState(store, sessionId)` — never per-row `useSessionSubscription`.
- **Exclusive session ownership.** Each live session binds to at most one Feature. Title match is exact launch title only (`${actionLabel|Discuss}: ${summary}` truncated to 80) — never `title.includes(summary)`. Page builds `titleSessionOwners` (sessionId → featureId); collisions prefer the longest summary and leave equal-length ties unowned. Linked/launched claims must not steal a session title-owned by another Feature.
- **Child session widget is expand-only.** `FeatureActiveSessionStrip` / `ChildSessionBlock` mounts only when the Feature row is expanded. Collapsed rows keep humming chrome (pulse title, spinner, Stop) without mounting the strip.
- Linked `/api/features/:id/sessions` is enabled only when the row launched a session, owns a title-matched session, Fast Forward is on, or is expanded — never N fan-out because some other Feature is humming.
- History (`/api/features/:id/history`) is expand-only (collapsed Feature rows use `HIERARCHY_SESSION_ROW_CLASS`; click-to-expand still owns `rowExpanded`). Collapsed setback chrome reads projected `attention` from the list payload — never N `/history` fetches.
- `FeatureRow` is `memo`ized. Browser telemetry kind `features` records `list_fetch`, `first_paint`, `session_match`, `expand`, `row_count`, `active_sessions` through `recordBrowserTelemetry`.
- Fast Forward is session-local operator mode (`sessionStorage` key `feature-fast-forward:<featureId>`). Sequencer is shell-mounted (`FeatureFastForwardHost` under `SessionActivityProvider`) so mode keeps walking after leaving `/features`; settle/launch memory is process-local maps, not a Feature column. Row chrome toggles mode and Pause→`runStopSession` only. Do not add a Feature column or a per-row `useSessionSubscription`. Fast Forward is Play-grammar: ghost icon, CTA-blue glyph, no filled square, no Sparkles (AI Review keeps the sparkle corner). Feature row session launch (`Discuss` / Play / Review) uses `openFocus: !useIsMobileViewport()` — never container-aware `useIsMobile()`, which is true in the narrow Features column on desktop and would skip Focus/session highlight. Phone/native keeps the under-row strip. Play/FF are row chrome only, not duplicated in the `…` menu. Expanded body: description max 5 lines, shared MD prose, no hover whitening; Status not a child; Owner is a people radio submenu (not compact ReferencePicker-in-menu); Product radio submenu; History is ProfileTreeRow (inline pitch like Spec), defaultOpen, description-frame width + 5-line cap, `ReferenceText` notes.
- Agent Feature controls (`platforms.play_feature` / `fast_forward_feature` / `pause_feature` / `stop_feature`) dispatch over the originating-tab events socket to shell-mounted `FeaturePipelineControlHost`. That host remotes the same acts as the Features row (session create + first message, sessionStorage Fast Forward mode, `POST /api/sessions/:id/abort`). It must not write Feature stage/status or invent a second sequencer.

## Browser navigation telemetry

`client/src/lib/navigation-trace.ts` is the single in-memory correlation boundary for SPA navigation evidence. History intent, route Suspense/lazy settlement, React Query activity, destination commit, main-thread evidence, and bounded session-stream pressure feed one terminal trace; only that terminal trace enters `browser_performance_telemetry`. Never persist per milestone, query event, frame, or stream delta, and never capture query keys or stream content. The readiness gate tracks only genuine initial loads (`query.state.status === "pending"`); background refetches and interval pollers must not hold a navigation trace open. Home-only exception: terminal `/home` traces may persist closed numeric identities `homeFeedMs`, `libraryListMs`, and `otherInitialQueryCount` matched by sanitized first `queryKey` segment (`/api/home/feed`, `/api/info/library`) — never `queryHash`, never raw keys, never suffixes. Browser telemetry kind `home` records Home attribution (`feed_ready`, `feed_render`, `section_commit`, `dwell_*`, `focus_presence`) through `recordHomeTelemetry` / `recordBrowserTelemetry`. Optional closed numeric metadata (`refresh`, `cacheHit`) is allowed. Do not change disclosure defaults or Focus mount to make traces prettier. Entry fetch may use the server non-refresh path by default; forced rebuild stays on pull-to-refresh and event invalidation — never invent a second feed API.

Route lifecycle is owned by `RouteLoadBoundary`: application chrome may overlay routed content but must never unmount it, each pathname gets an isolated Suspense/error boundary, and every module wait must settle visibly within the named budget. Arm the load cycle in `useLayoutEffect` so warm lazy routes cannot mark ready in a child `useEffect` and then get reset by a later parent arming effect. `lazyWithRetry` may retry bounded imports and reject into that boundary; it must never reload internally or install a never-settling promise. Confirmed chunk failures always enter `attemptVersionSkewRecovery` with recovery armed — including when `__MANTRA_BUILD_ID__` is the sentinel `development` (Docker builds without a commit ARG). Passive focus/visibility skew checks may stay quiet in local Vite; production client builds must bake the deploy commit via `RAILWAY_GIT_COMMIT_SHA` / `GIT_COMMIT_SHA` so ordinary skew detection stays truthful.

## WebSocket

A single shared WebSocket connection handles authenticated `/ws/events` updates for the lifetime of the application shell:

- `client/src/lib/ws-connection.ts` — Sole physical `/ws/events` creator; owns connection, reconnection, liveness, logical owners, and bounded diagnostics.
- `client/src/hooks/use-event-stream.ts` — App-root bounded generic-event projection over the shared transport; feature consumers read it and never create or close physical sockets.
- `client/src/components/route-load-boundary.tsx` — Sole tokenized route/application recovery UI. Route and app error boundaries may supply failure-specific copy and telemetry, but must reuse `RouteFailure` rather than expose raw errors or create parallel fallback styling.
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

**Live toasts only.** `useDataSync` may toast page surface / build completion / goal-change / object_share events only from live WS envelopes (`replay !== true`). WS `events.resume` catch-up still invalidates React Query so Home Inbox and other projections rebuild, but must never fire toasts. Do not store toast delivery in `localStorage` or any durable client store — durable attention catch-up is Home Inbox (including `object_share` rows). `useDataSync` mounts only under the authenticated app shell.

**Share sheet.** `ShareSheet` is the one grant modal. Recent people come from caller-scoped `GET /api/objects/grants/recent-people` (ledger projection, not People search). Explicit `subjectType` + `subjectId` grants known rows; typed email remains the path for new addresses.


## Skills vs Internal Prompts UI

Skills UI is for runnable workflows: capabilities with explicit run identity, sessions, scoring, and operator-facing execution. Internal Prompts UI is for non-runnable prompt templates used by code paths. Do not add run buttons, skill-run language, or session expectations to Internal Prompts unless a future architecture changes prompt execution.

Internal Prompts should show domain grouping, key/name/version/status, used-by/call-site metadata from the prompt-module registry, prompt/output-spec editing, and version restore. Skills should hide migrated internal helpers such as myelination, people summary, strategy simulation, chat compaction, and content-indexing prompt modules. Group Skills by `sourceMod` from the management read: Core plus each Mod that contributes Skills. Do not invent a second owner map or a tautological SKILLS section.
Skill persona controls edit the current user's override, not the shared skill definition. The picker is the skill's persona; selecting the product default clears the override. Persist the preference before reporting the skill edit as complete.

Memory UI should distinguish memory entries from session mirrors and archive/raw session data. When graph/search behavior excludes raw sessions, explain the policy in UI rather than making it look like data disappeared.

## Business Plan UI

`/business/plan` is the Business Plan screen; `/business/advantage` is a compatibility redirect. The Plan name is the Plan selector and inline editor. Vault membership belongs to the owning Business and must not be redefined on the Plan screen. Thematic Goal and Initiative Project rows use `ProfileTreeRow.menuContent` plus the universal `ReferencePicker` restricted to the relevant reference type for replacement. Each initiative reveals exactly one leading Metric and one lagging KPI binding through the same canonical reference primitives; legacy plan-level KPI rows remain compatibility projection only. Do not add local selectors or a parallel Plan switcher.

## Business Pricing UI

`/business/pricing` is the closed Max / Max+ / Factory+ catalog. Use `BusinessPageHeader`, a Hierarchy Tree of the three package rows plus Extras, and in-place field edits. Do not add a New tier control, cards, or a Library essay. Year-one monthly is derived display. Identity.pricingPageId stays narrative.

## Business Model UI

`/business/model` consumes Pricing; it does not reprint catalog Year 1 / Year 2 / includes / extras. Mix and volume stay on Assumptions. Forecast Accounts → Types shows period-end Max / Max+ / Factory+ counts only.

## Page Architecture

56 pages organized by domain. Each page is a route-level component:

| Domain | Pages | Key Routes |
|---|---|---|
| Chat | Focus session transcript, session list | `/`, `/chat/:id` |
| People | List, detail, interactions | `/people`, `/people/:id` |
| Work | Projects, tasks, milestones | `/work`, `/work/:id` |
| Goals | Goal tree, detail | `/goals`, `/goals/:id` |
| Health | Metric-type TreeView catalog in Wellness | `/health` |
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

Installable product routes gate through `ResolvedProductComposition.routes` by stable route ID. Do not inspect `activeMods` by key in page routing or add per-Mod wrappers; installation controls route composition, while named permissions and server authorization remain independent gates.

When adding admin or system UI:
- Check named permissions (`system:read`, `system:write`, `users:read`, `users:write`, `build:read`, `build:write`) through `hasPermission(...)`.
- Do not branch on `role` or legacy `isAdmin` except as a derived display convenience.
- Hide or redirect whole privileged surfaces when the read permission is absent; do not merely disable child actions while leaving sensitive tabs or data loaders mounted.
- If a new UI action needs a new permission, add the server permission first and consume the `/api/auth/me` contract after it exists.
- Permission editors must distinguish inherited/base permissions from explicit user overrides. Saving override state is replace-set semantics: unchecked explicit grants must be omitted so they revoke cleanly.
- Library Drive branch (`pages/library/drive-branch.tsx`): bound folders expand via `GET /api/drive/resources/:id/children` (Files API). Share uses `ShareSheet` with `objectType: "drive_resource"`. Do not call Google APIs from the client except the Picker bind flow.
- Files page (`pages/files.tsx` + `pages/library/drive-tree.tsx`): browse vault-bound resources and own semantic index policy UI (row toggles, inherited/status labels, durable run progress via `/api/files/index/*`). Connector connect/bind/unbind stays on Integrations — never add connector management here.

## Session Launch

`useSessionLaunch` is the interactive create-session + optional first-message + Focus-open primitive. Discuss call sites compose context only. Deliverable-producing buttons that only need a seated conversation compose Feature/object context plus a Skill or shared contract body — never a bespoke prompt string invented at the row.

When the door **is** a Skill (Habits Intentions, Home `+ Daily Goals`, Skills Run, Issues Self Heal / Burndown), use `useSkillLaunch`: `POST /api/skills/:id/run`, wait for `chat.autonomous.started`, open Focus on that session. Do not fake a skill by pasting process text into an ordinary session — that skips `skill_runs`, scoring, and the skill lattice.

Issues **Feature** converts an Issue into a Feature idea through the `issue-feature` Skill (Visionary) via session launch + contract body. `useAgendaDiscussion` is a compatibility alias for `useSessionLaunch`.

## Badge System

Tiered badge system for status indicators across the app:

- **Error** (red): Failures, critical issues
- **Active** (green): Currently running, live
- **Attention** (yellow): Needs review, warnings
- **Unread** (blue): New items, unseen content
- **Neutral** (gray): Default, inactive

Badges consolidate in the nav: highest-priority status wins per section.

Nav item labels stay `text-muted-foreground` unless the item is the current route. Status may recolor a nav label only for `error` or `active`. Do not map `attention`, `unread`, or `pinned` onto a nav item — those tokens are `text-foreground` and read as selected.

`mergeResolvedNavigation` keeps one placement per interaction target across all sidebar sections. A Mod contribution whose `section` no longer matches the static `navSections` must not reinsert that target.

Personas is a first-class route at `/personas`. `navigation.persona.open` must resolve to that path, not `/brain?tab=persona`. `TabParamSync` may apply `?tab=` only when the mounted page owns that tab value; an unowned slug must not rewrite the current page (System used to fall through to Logs). `/brain?tab=persona` remains a compatibility redirect onto `/personas`.

## Session UI Ownership

Session Menu is a projection of server-owned single-Vault Session placement. It filters ordinary and autonomous rows through the top-bar `visibleVaultIds`, colors titles through the same `vault-title-color.ts` resolver used by People and Work, and moves ordinary Sessions only through the shared ellipsis action. Meeting Sessions do not expose that move because their calendar/Library/session aggregate has a separate canonical transfer boundary. Event-carried Session updates must respect the current visible-Vault set so a move to a hidden Vault removes the row instead of reviving it from stale cache state. Normal navigation may load bounded sections lazily, but search must call the canonical authenticated server Session search and render its principal/Vault-scoped title, agenda, message, and tool matches as a flat result set; never recreate search by merging client buckets or filtering only title/topics. Expanded System and Archive are progressive-disclosure windows: mount the 25 most recent rows first and grow by 25 via Load More; collapsing resets the window. Recent is hard-capped at the same 25 budget after hot qualification (last activity < 1h, or page-load sticky from that same age rule); unread is row emphasis only and must not force Recent membership. Overflow remains visible under Today rather than Load More. Search remains the full-set path and must not inherit that expansion budget.

Focus Session is the canonical session entry surface. An optional conversation agenda renders display-only at the top of `SessionTranscriptSurface` through `SessionAgendaTree`, using the shared `HierarchyTreeRow`/Plan tree geometry; durable state and all edits remain server/session-tool owned, and absence renders no extra surface. Agenda rows use Session Menu spacing and section typography, expose description/resolution through row disclosure, highlight the first open item as current, and collapse the section by default when every item is complete. Section open/closed chrome is browser-local and principal+session scoped so a contracted Agenda stays contracted across Session Window revisits; when contracted, one preview line under the header shows the current open step. A Session may also project one pinned Plan immediately below the Agenda through the canonical `PlanWidget`; the principal-scoped Plan↔Session link owns pin state, and the pinned top surface suppresses that Plan's inline transcript copy so one logical widget has one visible owner. Keep ownership split by role:

- `client/src/components/focus-widget.tsx` — Orchestrates the active session, transcript panel, session menu, and desktop contained BottomBar.
- `client/src/components/session-transcript-panel.tsx` — Transcript/header surface only. It renders messages, stream state, title/actions, linked entities, plan bar, and websocket health. It must not own the normal composer/input path.
- `client/src/components/bottom-bar/index.tsx` — Single normal composer/input owner for creating/sending session messages. It owns file upload, mention autocomplete, voice input display, and `useChatSend`.
- `client/src/components/message-list.tsx` — Message rendering with markdown, code blocks, tool calls, images, and entity/reference widgets.
- `client/src/components/question-widget.tsx` + `client/src/hooks/use-question-response.ts` — Inline clarification surface. Prompts derive from persisted question tool calls; structured answers travel through the canonical session message endpoint and are rendered back into the originating widget rather than as duplicate user bubbles. The newest valid Question call is the session's single active clarification; it supersedes older unanswered calls by chronology, without a separate mutable status. A visible unanswered widget is always answerable. Its persisted response is the durable state, and its local submit-in-flight flag is the only client interaction lock. Session activity, streaming, and unrelated pending turns must never disable it. Both selection modes render the standard `SimpleCheckCircle` control; selection mode changes cardinality, not control shape. The selected answer owns one optional note in Home page-widget type (`SIMPLE_TEXT_FRAME_CLASS`, `text-xs`). Choosing an option or Other, or first revealing a preselected note when the session becomes visible, focuses that field and selects its text so it reads as editable. Option description appears only when that option is selected. Recommendation is the confidence badge only — not a second fill. Do not render a widget-level Principles expander or a second note below the option list. Question widget ownership spans the visible transcript and recursively loaded history: newer pages claim immutable tool-call IDs first, and archived `MessageList` subtrees inherit those claims so one logical Question has exactly one renderer across pagination.
- Session Menu REVIEW is the derived human-review projection. `awaitingReview` is true for an unanswered Question, a principal-visible Session-linked email draft still in `draft`, a plan review hold, or — only when the principal holds `system:read` — an undismissed session `errorSeverity` from a transcript system notice; `reviewKinds` carries question, plan_review, ordinary draft/reply/meeting recap, and (operators only) `error` or `warning`. System-notice error/warning is an operator diagnostic, not ordinary user attention: the session list nulls `errorSeverity` and omits those review kinds without `system:read`. Email send/discard, Question response, and system-notice Dismiss resolve their owning canonical state and remove the Session from Review on the next event-driven refetch. Opening/marking a session read clears only the unread badge — it must not clear `errorSeverity`. Dismiss stamps `dismissedAt` on the notice, recomputes severity from remaining undismissed notices, and posts `Please continue...` to the same session. An active reminder still defers Review to Snooze. Session classification precedence is Archive → Snooze → Live → Review → Active → Pinned → recency buckets. Review outranks System: autonomous sessions with undismissed review attention leave the System bucket for Review until cleared, then return to System. Error/warning Review rows use destructive/warning icon and title color rather than vault tint. Icon shapes: Error = red circle (`AlertCircle`); Warning = amber triangle (`AlertTriangle`).
- Anything that sets session warning/error severity must also persist the canonical transcript `system_notice` widget (`chatFileStorage.recordSessionAttention`). Severity alone may light operator Home INBOX, but the opened session must still show the standard warning/error widget. Autonomous skill failures/degrades keep **at most one open system-attention session per skill per principal**: the producer clears prior open skill sessions and stamps a stable per-skill `artifactKey` so retries replace the notice instead of stacking Home rows.
- Home INBOX mirrors that same undismissed review projection as `payload.kind = "session_review"` rows: one row per session, title layout `{@session} had an Error|had a Warning|has a Question|needs an Approval` with matching icon/label color. Session titles truncate aggressively (~22 chars) so the phrase sits tight against the chip. Error/warning rows require `system:read` (same gate as Session Menu) and follow two clocks like reported Issues: they surface only while the session was updated within 48 hours, and any error/warning still sitting past 7 days is durably dismissed (its system notices cleared) so a later session update cannot resurrect it. For skill-keyed autonomous sessions (`sessionKey` `auto:{skillId}` or `triggerType=skill`), Home also collapses to the newest open error/warning per skill so legacy stacked runs do not fill INBOX. Ordinary users without `system:read` still get question / plan / email session_review rows; they must not see Build skill degrade spam as Home warnings. Dismiss/check-circle clear is durable and does not resurrect on boot. Session Menu remains the structural owner; Home only projects navigable attention. Rows are completable via check circle: complete clears the owning producers (dismiss notices, cancel active question, pause needs_review plans, discard unsent session-linked drafts) so both Home INBOX and Session Menu REVIEW drop on the next rebuild.
- Home INBOX also projects Build-visible reported Issues as `payload.kind = "reported_issue"` rows: `{@user} reported {@issue}`. The collector requires active Build plus `system:read`, then keeps only `kind=reported` Issues whose `platformEnvironmentId` is a Platform Environment the operator can already see and whose document was created within 48 hours. Check-circle complete writes an operator-local dismissal and does not resolve or mutate the Issue. Reports older than 7 days are auto-dismissed on the next Home collect so they cannot reappear as spam.
- `client/src/components/references/editable-reference-input.tsx` — Controlled rich composer input. Prevent supported `beforeinput` mutations and route them through React state. If WebKit mutates the DOM natively, remount the entire editable root and restore selection; never reconcile or re-key individual descendants after browser mutation.
- `client/src/hooks/use-client-presence.tsx` — One application-level provider owns presence registration and heartbeat. Consumers read its context; they must not instantiate transport side effects independently.
- `client/src/lib/ws-connection.ts` — The shared event socket owns a balanced logical-owner registry and exposes a read-only diagnostics snapshot. Every acquisition uses a stable owner ID, every cleanup releases that same ID, and session liveness is reference-counted by owner rather than a process-wide boolean.
- `client/src/hooks/use-ui-interaction.tsx` — The authenticated app-level semantic interaction owner. Registered targets expose stable allowlisted actions, not selectors; existing user controls and Agent commands invoke the same action. Guide commands are subject-discriminated: controls spotlight allowlisted actions, while canonical-reference resources reveal and expand their owning Home/Simple row in place. Home section preferences are browser-local and principal-scoped, unseen sections open by default, and guide-forced section/ancestor expansion is transient rather than a preference mutation. Every guide requires narration, blocks only outside the live target, supports Escape/Cancel, and completes on the target’s native activation before its ordinary action runs; execute commands and fallback confirmation resolve from the target’s canonical route/state outcome. Durable FTUE owns reissue after reload or reconnect.
- Session-scoped ephemeral aggregates carry an explicit owner session ID. Render voice transcripts, live drafts, and similar state only when that owner matches the visible session; clearing on navigation is cleanup, not the correctness boundary.
- Browser ElevenLabs voice worklets are first-party. `client/src/main.tsx` must call `installFirstPartyVoiceWorklets()` at module evaluation (before any voice start, including provisional immersive-orb). That intercept rewrites the SDK's hardcoded jsDelivr libsamplerate `addModule` URL to `/voice/libsamplerate.worklet.js` because `VoiceSessionSetup` still drops `libsampleratePath` on the OUTPUT context. `buildBrowserVoiceStartOptions` must still pass `workletPaths` and `libsampleratePath` to `/voice/*.worklet.js` for input + processors. Do not re-open a CDN CSP exception; WebKit evaluates worklets under `script-src` as well as `worker-src`.
- Native meeting transcription media is app-owned, not page-owned: `NativeMeetingTranscriptionProvider` owns the browser MediaStream, AudioContext/worklet, authenticated socket, pull-based microphone level, and native spoken-reply playback across navigation, while the Meetings action only initiates it from the direct user gesture. Construct and request resume of the AudioContext synchronously before the first awaited permission or network operation so iOS WebKit retains that gesture activation. Enabling spoken replies must synchronously unlock one reused same-origin `HTMLAudioElement` from the Listen Mode control by playing a guaranteed-decodable silent clip inside that user gesture, so iOS/WebKit keeps autoplay authorization for every later utterance. A single owner-scoped poll loop then long-polls the canonical meeting MP3 endpoint with `fetch`, reading HTTP status so an idle `204` re-polls immediately instead of poisoning the media element, and plays each returned `200` utterance through that one unlocked element from a per-utterance object URL that is revoked on completion. The loop pauses and clears the element on mute, leave, capture replacement, or provider unmount, which also flushes any in-flight utterance. Never point the media element's `src` directly at the long-poll endpoint — a bare media element cannot see the idle `204` and treats it as an undecodable body — and never turn playback into `arrayBuffer()` / `decodeAudioData()` whole-file WebAudio (MSE progressive streaming is also unavailable on iPhone Safari). Startup is not ready until the server acknowledges one valid PCM frame. Durable meeting lifecycle remains the correctness boundary.
- The authenticated app exposes synchronized voice visualization in two places: the persistent top-left `NavigationOrbButton` and the Session Window's established orb surface. Both are read-only projections of the same `VoiceSessionProvider` state and audio, falling back to the same app-owned native meeting capture; neither may create transport or duplicate lifecycle state. When neither voice source is active, only the persistent top-left orb projects account-wide text activity from `SessionActivityProvider`, using the canonical `visibleAssistantActivity` priority `tool > thinking > streaming > none`; the Session Window orb remains voice-owned.
- Visibility is the sole Session presentation discriminant. `Zero` is the default: active voice renders the canonical orb, active text renders only the Thinking cue, and settled text renders only the final assistant content segment. Richer modes render the canonical transcript. Never add a separate orb/transcript toggle or a second presentation state. History catchup is not assistant activity: if a selected Session already shows a prefix while the durable snapshot is still arriving, reuse the existing muted `Loader2` after the last turn. Do not add a Streaming label or a second brain. Text owns one durable preference via `/api/session/visibility-layer`. Voice presentation is a session-local overlay: every start begins at Zero, the `…` control may change only that overlay, and every idle/exit path drops it so the text preference returns. Voice must never POST the durable store. A reload or new start never inherits the previous voice override.

Composer turn admission must use a synchronous ref before any state update or await. React state is display state, not a concurrency lock. Every message POST carries a stable `clientTurnId` so the server can make retries replay-safe. Ordinary authenticated text composition, Session creation, and message admission must never depend on privileged executor/gateway diagnostics; the authenticated Session endpoints own availability and authorization, while `/api/gateway/status` remains a permission-gated system projection.

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

### Responsive Action Menus

`client/src/components/ui/dropdown-menu.tsx` is the canonical action-menu primitive and MUST be used for action menus. Consumers declare one Radix-compatible action tree; desktop renders pointer-friendly Radix flyouts while mobile renders the same hierarchy as an inset Universal Picker-style panel with drill-in submenus and Back. The mobile panel is black, thin-bordered, small-radius, handle-free, shadow-free, and uses dense single-line rows with quiet 14px icons and full-width selected states; the shared presenter measures the real trigger, opens in the larger adjacent viewport region, and owns one scroll boundary so every action remains reachable. Do not import raw Radix dropdown primitives, create local menu renderers, branch on mobile at call sites, or introduce a parallel responsive-menu component. `PopoverContent`, `SelectContent`/`SelectItem`, `ContextMenuContent`/items, and inline `Command` lists share its compact menu/picker grammar; task dialogs, workflow modals, tooltips, and hover cards do not. The Design screen's **Responsive action menus** playground is the canonical implementation example and must stay aligned with `DESIGN.md` § Action menus.

### Glass Tooltips

`client/src/components/ui/tooltip.tsx` is the only hover-label primitive. `Tooltip` always mounts a same-module `TooltipProvider` around Radix Root so missing-provider crashes are unrepresentable; app-level `TooltipProvider` remains optional for shared skip-delay. `TooltipContent` already paints `GLASS_SURFACE_CLASS` — the navbar glass is the default, not a special case. Do not invent a local tooltip, restyle a popover into a label, or use native `title=` as designed hover chrome. Children on glass use `text-white` / `text-white/70`, never canvas muted/foreground tokens. Width, `side`, and `align` only. Chart series popovers stay on `ChartTooltipContent`. The Design screen's **Glass tooltips** playground must stay aligned with `DESIGN.md` § Tooltips.

### Universal Reference Picker

One control for `@anything`. Do not invent local typeaheads for tags, people, pages, goals, or other linkable objects.

- **Search:** `client/src/lib/reference-search.ts` (`loadReferenceSuggestions`) is the single multi-type source.
- **Resolution:** `shared/references.ts#REFERENCE_REGISTRY` owns known type identity and fallback routes. `client/src/components/references/reference-registry.tsx` may add presentation labels/icons and type-specific route detail, but every shared registered type must remain renderable through the shared fallback rather than degrading as unknown.
- **Rows:** `client/src/components/references/reference-suggestion-row.tsx` — compact one-line rows (icon · label · type).
- **Field / menu control:** `client/src/components/references/reference-picker.tsx` (`ReferencePicker`). Support `types`, multi/single, inline/menu, and tag create when needed.
- **Chat:** `useMentionAutocomplete` + `MentionPopover` consume the same search path and rows.
- **Tags only:** `UniversalTagPicker` is a thin `types:['tag']` facade over `ReferencePicker`. Prefer `ReferencePicker` for new work.
- **Design:** interactive playground lives under Build → Design → References (§15). The glass tooltip playground is §14.

### Dashboard activity heatmaps

Dashboard heatmap **visibility and order** come from `useProductComposition().dashboardHeatmaps` (Core + active entitled Mods). The host requests `/api/dashboard/activity?series=…` with those series keys; the API intersects with composition and only runs collectors for the allowlist. Presentation markers (icon/criterion thresholds) stay host-owned per series key. Wellness owns `wellness_completions` — it appears only when the Wellness mod is active.

### Profile Tree Rows

Use `ProfileTreeRow` for compact label/value rows with optional progressive disclosure. Pass `defaultOpen` only when readiness or missing required configuration must be visible on first render; ordinary detail rows stay collapsed.

`HierarchyTreeRow indent="icon"` is the compact child indent for trees whose parent uses a `ProfileTreeRow` icon (`px-2` + `h-3.5`). It places the L spine on that icon center and must not change the default Project-task indent. Budgets uses it for department/category/line-item children; keep line-item cash as formatted accounting text until click-to-edit.

### Meeting Tree Rows

Network Meetings reuses `SimpleWidgetRenderer` and `SimpleTreeRow` for completed meeting sessions. Meeting rows render as canonical CTA-blue references, omit completion controls because completion is implied by the index, and expand the recap summary directly when present. Participants stay in the canonical meeting record/tool response but are not duplicated as UI children because the summary already names them; non-recap Library artifacts may remain as reference children. Do not create a second meeting card or a split-view detail surface. Its search/action/section stack must consume `HIERARCHY_TREE_STACK_CLASS`, `HIERARCHY_PRIMARY_ACTION_CLASS`, and `HIERARCHY_SECTION_HEADER_CLASS`, which are shared with the Session Menu rather than copied locally. Historical meeting sections enable their React Query request only after disclosure; This Week alone defaults open.

### Opportunity Vault Visibility

Opportunity UI surfaces use `useVisibleVaults().isVaultEnabled`: unassigned Opportunities remain visible, while assigned Opportunities render only when their concrete Vault is enabled in the top bar. Expanded Pipelines rows own the title in the parent row and render frameless `ProfileTreeRow` children directly beneath it.

## Voice

Voice transcript rows use one required lifecycle discriminant: `provisional`, `committed`, or `placeholder`. Only canonical server transcript events may create committed user speech. Local provider/native callbacks may create provisional composer text, and reconnect snapshots contain committed persisted history. Live and replayed voice events must pass through one event-ID-deduplicating reducer and require exact `chatSessionId` identity before mutating state or advancing the cursor. Voice finalization settlement likewise has one discriminant: `finalized`, `not_finalized`, or `unknown`. A transport error cannot prove failure; send the bounded request with `keepalive`, retry once with the same voice-session identity, then reconcile that exact identity against durable saved session state before surfacing a destructive error.

Browser speaker attribution is Mantra-owned. An ElevenLabs `user` role is transport evidence, not identity proof during assistant playback: the canonical echo-admission boundary interrupts playback, requires continued microphone activity after interruption, and may use bounded similarity to recent assistant text as supporting echo evidence before admitting user speech. Diagnostics retain only the outcome, playback/interruption booleans, bounded timing, and similarity score—never raw audio or transcript content. The SDK owns capture, resampling, playback, and cleanup; client code must not access private conversation fields or vendor an SDK playback worklet. Browser/SDK-thrown Errors are foreign immutable values: normalize by creating an owned Error with the foreign value as `cause`, then attach product diagnostics only to that owned wrapper. Never decorate a caught DOMException or provider Error in place; Safari exposes read-only fields such as `code`, and a wrapper failure would mask the provider error and skip recovery.

`client/src/lib/voice-transcript-state.ts` is the canonical pure mutation boundary for user voice transcript rows. It owns cleaning, normalized comparison, sequence ordering, placeholder replacement, provisional-to-committed promotion, and duplicate rejection. React hooks generate timestamps/turn IDs and emit diagnostics, but must not reproduce transcript transition logic.

## Immersive-Orb Presentation Mode

The voice-orb entrance is a provisional, capability-scoped shell—not an authenticated app shell. `client/src/components/app-shell-immersive.tsx` (`AppShellImmersive`) deliberately mounts only the entrance orb, provisional voice transport, and account-claim affordance; it mounts none of the authenticated app providers or product surfaces.

- **One provisional transport.** `VoiceSessionProvider onboardingToken=...` owns the mic prompt, greeting, `POST /api/voice/start`, hash-keyed lease, and `VoiceSession.toolMode=none`. `ProvisionalVoiceController` starts it exactly once and publishes visual/audio state through `LiveVoiceProvider`; `ImmersiveOrbSlot` is a pure visual and never starts voice itself.
- **Claim is a hard shell boundary.** After claim establishes the authenticated cookie, the entrance calls the same `completeStartupOnboarding` mutation used by ordinary registration, derives the destination through `getStartupOnboardingDestination`, and uses `window.location.replace(...)`. This removes the onboarding capability from active history and cleanly mounts `AuthGate → BootGate → VaultProvider → AppShell`. Never mount authenticated providers, authenticated voice, Home/Simple projections, rails, or a Session clone inside `AppShellImmersive`.
- **Canonical Home FTUE.** `/home` always renders the real `HomePage`. The shared destination is `/home?c=<ftueSessionId>&autoVoice=1`; the authenticated app's outer `FocusWidget` only ensures the Session Window is mounted, while `FocusWidgetPanel` alone consumes the parameters, selects the exact canonical Welcome session, and starts voice through the ordinary authenticated `VoiceSessionProvider` only after that session is the active panel discriminant. Registration, first-admin setup, and recap claim all use this one destination helper. Recap claim passes its capability only into authenticated onboarding completion so the server can attach recipient-validated provenance and the canonical Session Agenda; the raw token never enters Home state or session persistence.
- **Chimeless exit.** The provisional entrance chime plays normally. After successful claim, the entrance suppresses only its terminal disconnect tone while navigation transfers ownership to the authenticated app.
- **Visual continuity across the hard boundary.** Claim records one short-lived, content-free session marker before `window.location.replace`. The next document holds a black veil above ordinary authenticated boot; the canonical desktop/mobile voice orb dismisses it from its actual first rendered frame, with a bounded fail-open timeout. Never render a second bridge orb or carry geometry, token, identity, product data, provider, or transport across the boundary.
- **Entry contract.** `client/src/lib/immersive-entrance.ts` is the single source of truth for the entrance URL: `/visualizer?i=<onboardingToken>` with no meeting `token`. `main.tsx` excludes that URL from the standalone visualizer root, and `App.tsx` renders `AppShellImmersive` for it before authentication.
- **Do not confuse with the Recall meeting visualizer.** `client/src/pages/visualizer.tsx` (`/visualizer?token=<meetingToken>` and `/visualizer?state=` preview) keeps its lightweight standalone render root and page-owned media lifecycle. It must not gain provisional-voice or app-shell wiring.
