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
- `client/src/components/chat-shared.tsx` — `filterStepsByLayer`
- Diagnostic trees render the complete trace before visibility filtering. Span duration comes from boundaries, milestones render as parent-relative offsets, and overlapping children are wall-clock/parallel rather than additive. Never reconstruct timing by subtracting visible child labels.

### Protocol
1. Chat route subscribes to the focused session plus bounded live streaming sessions via `session.subscribe { sessionId }` on the shared WS
2. Server replies with `session.snapshot { sessionId, content: StreamingContent, status }`
3. As each run progresses, server sends `session.delta { sessionId, streamingContent, status }`
4. Client stores each snapshot/delta directly in a sessionId-keyed cache (no client-side reducers)
5. On disconnect/reconnect, client resubscribes to every cached live session and gets fresh snapshots

## WebSocket

A single shared WebSocket connection handles real-time updates:

- `client/src/lib/websocket.ts` — Connection manager, reconnection logic, message routing
- Used for: session updates, notification badges, voice audio, real-time state sync
- Multiplexed: different message `type` fields route to different handlers
- Auto-reconnects with exponential backoff

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
| Library | Page tree, editor, notes | `/library`, `/library/:slug` |
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

Focus Session is the canonical session entry surface. Keep ownership split by role:

- `client/src/components/focus-widget.tsx` — Orchestrates the active session, transcript panel, session menu, and desktop contained BottomBar.
- `client/src/components/session-transcript-panel.tsx` — Transcript/header surface only. It renders messages, stream state, title/actions, linked entities, plan bar, and websocket health. It must not own the normal composer/input path.
- `client/src/components/bottom-bar/index.tsx` — Single normal composer/input owner for creating/sending session messages. It owns file upload, mention autocomplete, voice input display, and `useChatSend`.
- `client/src/components/message-list.tsx` — Message rendering with markdown, code blocks, tool calls, images, and entity/reference widgets.
- `client/src/hooks/use-client-presence.tsx` — One application-level provider owns presence registration and heartbeat. Consumers read its context; they must not instantiate transport side effects independently.
- `client/src/lib/ws-connection.ts` — The shared event socket owns a balanced logical-owner registry and exposes a read-only diagnostics snapshot. Every acquisition uses a stable owner ID, every cleanup releases that same ID, and session liveness is reference-counted by owner rather than a process-wide boolean.

Composer turn admission must use a synchronous ref before any state update or await. React state is display state, not a concurrency lock. Every message POST carries a stable `clientTurnId` so the server can make retries replay-safe.

Do not reintroduce a second embedded session input under the transcript panel. If a new surface needs to send a message, route it through BottomBar ownership or extract a shared hook with one owner of visible composition state.

## Component Conventions

- **All components are functional** with hooks. No class components.
- **Props use TypeScript interfaces**, not inline types.
- **Loading states**: Use `Skeleton` from shadcn/ui for content loading.
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
