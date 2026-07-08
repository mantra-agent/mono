# Mantra — Personal Intelligence System

A conversational AI + life management + autonomous agent platform. Multi-user, one AI (Agent) per user, full-stack monorepo.

## Tech Stack

- **Server:** Node.js / Express / TypeScript
- **Client:** React 18 / Vite / TailwindCSS / shadcn/ui
- **Database:** PostgreSQL (Drizzle ORM) + pgvector for embeddings
- **Object Storage:** S3-compatible (Cloudflare R2 via GCS proxy)
- **Hosting:** Railway (dev + prod)
- **LLM:** Claude (primary), OpenAI (embeddings, adversarial), multi-model via activity routing
- **Voice:** ElevenLabs Conversational AI SDK

## Active Coding Process

The procedural coding workflow lives in root `CODING.md`. Load and follow `CODING.md` before any code diagnosis, system debugging, file edit, build, PR, merge, deployment, or implementation planning.

`AGENTS.md` remains canonical for Engineering Principles, architecture, and repository-specific constraints. `CODING.md` is the active operating checklist that applies those principles.

## Engineering Principles

Non-negotiable. Every file, every function, every PR.

### Architecture

**Single Source of Truth**

Every piece of data or configuration has exactly one authoritative location. Everything else derives from it. PostgreSQL for persistent data. Unified Tool Registry for tool schemas. Skills table for runnable workflow definitions. Prompt Modules table for internal code-owned prompt templates. If you're synchronizing two stores manually, you have two sources of truth. Fix it.

**Modular Systems**

Build in bounded modules with explicit interfaces. A module owns its data, exposes its API, hides its implementation. The cognitive loop, memory system, tool registry, voice architecture, and strategy system are separate modules. Keep them that way.

**Encode Invariants in Structure, Not Guards**

When multiple guards cooperate to enforce a single invariant, the invariant belongs in the data model. Encode ownership in data so invalid states become unrepresentable, not merely prevented. If deleting any one guard reintroduces the bug, the fix is procedural and fragile.

**Canonical Mutation Path**

Critical writes go through one canonical path. If an invariant matters, every route, tool, job, and helper that mutates that state must cross the same enforcement boundary. If another write path can bypass the rule, the fix is incomplete.

**Progressive Disclosure**

Load what's needed, when it's needed, at the depth the task requires. Context is a budget. Never truncate; compress, and leave the thread back to depth.

**Minimum Viable Protocol**

Use the smallest set of patterns that expresses the system truthfully, and reuse them everywhere. Extend only when you can name the constraint the current pattern cannot represent without lying.

**One Discriminant Per Decision**

When an operation can end in multiple outcomes, represent the outcome as a single discriminated field computed at the source. Diagnostic detail lives alongside the discriminant but never replaces it.

**Do It Right or Do It Twice**

Rushing creates tech debt that costs more than the time "saved." Measure twice, cut once. When choosing between a quick workaround and a correct architecture, choose the architecture — you don't have time to rush. If the right fix is bigger than expected, that's information about the real complexity, not a reason to avoid it.

### Code Quality

**DRY**

Every piece of logic lives in exactly one place. Duplication creates divergence bugs that are invisible until catastrophic. Extract shared logic into shared utilities, schemas, registries.

**Explicit Over Implicit**

No magic. No hidden conventions. Every dependency is injected or imported explicitly. Every side effect is named and intentional.

**Interfaces Before Implementation**

Define the signature before writing the function. Define the public API before writing the module. Define the data contract before writing the feature. TypeScript types are contracts. Never use `any` in new interfaces unless the boundary truly is unknown.

**Names Are Interfaces**

Names describe what something does or when to use it, not how it currently works. Name by role, not by value. When purpose evolves, rename immediately.

**Small, Focused Functions**

A function does one thing. If you need "and" to describe it, split it. Functions longer than roughly 40 lines are almost always doing too much.

**Leave No Zombies**

Unused code, commented-out blocks, and workarounds actively mislead. Delete what isn't used. Fix causes, not symptoms. When you touch a file, leave it closer to these principles than you found it.

### Reliability & Operations

**Async-First**

Never block the event loop. No synchronous I/O after server startup. Use `fs.promises` throughout. The only exception is one-time boot initialization before connections are accepted.

**Eliminate Race Conditions**

Concurrent operations sharing state must be explicitly coordinated. Use locks, queues, or atomic operations. The most dangerous races pass all tests and only appear under production load.

**Every Operation is Replayable**

Any operation that can be interrupted must be safe to retry. Use idempotency keys, transaction boundaries, and deduplication checks. Running it twice must be indistinguishable from running it once.

**Fail Loudly, Degrade Gracefully**

Never silently swallow errors. Log every error with full context. Surface failures visibly in the UI. Design every integration with degraded-mode behavior, blast-radius control, timeout, fallback, and visible staleness where relevant.

**Observability**

Every async operation, tool call, and meaningful state transition emits a structured log at the moment it happens. Logs must reconstruct the full flow from a cold start. Client-side events must use `createLogger` from the app logging framework, never raw `console.*`.

**Logging Levels**

Classify logs by the contract of the local operation being logged:

- `error`: The operation failed to complete its intended contract. Use when work was not done, data was not saved, a request/tool/job could not complete, a required dependency failed, or user/system-visible correctness is affected. Do not use `error` for failed optional paths that recover successfully.

- `warn`: The operation completed or continued, but only after an unexpected, degraded, fallback, skipped, stale, partial, or suspicious condition. Use when the system worked around the issue and the caller can continue, but the event may indicate a bug, bad input, dependency instability, or reduced quality.

- `info`: A meaningful, non-noisy state transition or lifecycle milestone occurred. Use for startup/shutdown, route or mode changes, durable side effects, completed major operations, externally relevant decisions, and human-useful audit breadcrumbs. If it can fire repeatedly in a loop, render path, poller, stream chunk, heartbeat, cache lookup, or high-frequency branch, it is not `info`.

- `debug`: Low-level diagnostic detail for reconstructing execution flow without a debugger. Use for branch choices, payload shapes, timing, cache hits/misses, intermediate IDs/counts, request construction, guard checks, and trace breadcrumbs. Debug logs may be noisy and should carry enough context to diagnose behavior when enabled.

Severity is based on the local operation's contract, not whether the whole app survives. A failed email draft is `error` even if the app keeps running. A failed optional enrichment inside a batch that continues is usually `warn`. A retry attempt is `debug`; retry exhaustion is `error` if the operation fails, or `warn` if a fallback completes the contract.

**Tracked LLM Boundary**

Every text/chat/streaming LLM call goes through `server/model-client.ts` via `chatCompletion(...)` or `chatCompletionStream(...)` with structured metadata. Do not call model providers directly from feature code. Specialized modalities must use a sibling tracked boundary before shipping.

**Database Over Filesystem**

Persistent state belongs in PostgreSQL. Filesystem paths are ephemeral in deployment. Legitimate filesystem uses are scratch workspace and explicit user-facing file actions.

**Bound Every Database Operation**

Every DB operation is bounded, batched, and prioritized. Every fan-out has a concurrency cap. Stream immediately, persist in batches. Background work yields to foreground work. Tag queries by origin.

**Assume No Starting Point**

A reconnecting client sees exactly the same reality as one that never disconnected. Every meaningful state transition persists server-side the moment it happens. The client is a view, not a store.

### Process & Review

**Review Like an Architect**

Read code top-down and bottom-up. Look for structural violations before diving into fixes. Be vigilant about band-aids. Always review AGENTS.md for the systems you're touching. If code changes contradict AGENTS.md, update the nearest relevant AGENTS.md in the same PR. Keep AGENTS.md concise; every word must earn its place.

**Design From the User Backward**

Think backward from the interface, not forward from the data model. Always consult `DESIGN.md` when building user-facing code. Simpler is always better, even though it is harder to achieve.

**Ship With a Parachute**

Every deployment has a rollback path under 5 minutes. Feature flags gate risky new behavior. Database migrations are backwards-compatible and additive first.

**Migrate, Don't Mutate**

When interfaces change, the old contract runs alongside the new until all consumers migrate. Deprecation is explicit: mark, log usage, set a removal date, delete at zero.

**No Premature Optimization**

Write correct code first. Optimize with measured bottlenecks and evidence. Exception: architectural decisions expensive to reverse.

**Least Privilege**

Every component gets minimum access. Secrets never appear in code, logs, or error messages. Validate input at the boundary. API keys are scoped to exactly the permissions required.

**Access Control is Centralized**

Authorization decisions use the central principal + permission service, not route-local role checks. Resolve identity into a `Principal`, derive effective permissions from `server/permissions.ts`, and gate privileged operations with named permissions such as `users:read`, `users:write`, `build:read`, `build:write`, `system:read`, and `system:write`. If a route, tool, or background path needs a new capability, add it to the central permission vocabulary first and expose it through `/api/auth/me`; do not invent ad hoc booleans like `isAdmin` as the authority. User-owned data access must also use principal-aware scoping helpers, not raw table/object reads that bypass ownership columns.

**Name Your Budgets**

Every user-facing interaction has a latency target. Every background operation has a resource ceiling. Every LLM call has a token budget. When a budget is exceeded, treat it like a failing test.

## Multi-User Data Ownership

Mantra is a multi-user system. Every piece of persisted data is either **user-owned**, **global**, or **system**. This section is the single source of truth for how data ownership works. Violating these rules causes data bleed between users.

### The Invariant

**No user can ever see, search, list, load, mutate, or receive in context another user's private data.** This is not aspirational. It is a correctness requirement equivalent to "the server must not crash." Every query, every insert, every context assembly path, every tool handler, and every autonomous background job must enforce it.

### Ownership Model

Every owned table has these columns:

| Column | Purpose |
|--------|---------|
| `scope` | `'user'`, `'global'`, or `'system'`. Determines visibility rules. |
| `owner_user_id` | The user who owns this row. Required when `scope='user'`. |
| `account_id` | The account (personal workspace) this row belongs to. |
| `created_by_user_id` | Who created it (audit). |

Tables without a `scope` column use `owner_user_id` and/or `account_id` directly.

**Scope rules:**
- `scope='user'` → visible/writable only by the owning user (matched by `owner_user_id` or `account_id`).
- `scope='global'` → readable by all users, writable only by admins or system. Used for templates, default skills, default personas, product docs.
- `scope='system'` → internal system records. NOT a template. NOT visible to normal users unless they own it via `owner_user_id`.

### Principal

Every request and every async server operation must have a resolved `Principal` (`server/principal.ts`). The principal carries `actorType` (`user` | `service` | `system`), `userId`, `accountId`, `role`, `scopes`, and `permissions`.

- **HTTP requests:** Principal attached by auth middleware from session or bearer token.
- **Autonomous runs (timers, skills, hooks):** Must wrap execution in `runWithPrincipal(userPrincipal, fn)` using `server/principal-context.ts`. The user principal comes from the user who owns the timer/skill/hook.
- **System jobs (sleep cycle, migrations):** Use `createSystemPrincipal()`.

**`getCurrentPrincipalOrSystem()`** falls back to a system principal when no principal is in AsyncLocalStorage. This is a safety net, not an excuse. If user-owned data is being written and the principal is system, the `owner_user_id` will be `NULL` and the data will be orphaned. Every code path that creates or queries user data must have a real user principal in scope.

### Scoped Storage Helpers (`server/scoped-storage.ts`)

These are the correct way to enforce ownership. Do not write raw queries against owned tables without using them.

| Helper | Purpose |
|--------|---------|
| `visibleScopePredicate(principal, columns)` | SQL predicate: user's own rows + global templates. Add to WHERE clauses on reads. |
| `writableScopePredicate(principal, columns)` | SQL predicate: user's own rows only (no templates). Add to WHERE on updates/deletes. |
| `ownedInsertValues(principal, columns)` | Returns `{ ownerUserId, accountId, scope }` values to spread into INSERT. |
| `combineWithVisibleScope(principal, columns, existingPredicate?)` | Combines your WHERE with the visibility predicate. |
| `combineWithWritableScope(principal, columns, existingPredicate?)` | Combines your WHERE with the writable predicate. |
| `assertVisible(principal, row, label)` | Throws 404 if the row is not visible to the principal. Use after single-row fetches. |
| `assertWritable(principal, row, label)` | Throws 403 if the row is not writable by the principal. Use before updates/deletes. |

### What This Means In Practice

**Every SELECT on an owned table** must include `visibleScopePredicate` or `combineWithVisibleScope` in its WHERE clause. No exceptions. If you forget, the query returns all users' data.

**Every INSERT on an owned table** must spread `ownedInsertValues(principal, scopeColumns)` into the values. If you forget, `owner_user_id` is NULL and the row is orphaned (invisible to the user, but polluting system queries).

**Every UPDATE/DELETE on an owned table** must include `writableScopePredicate` or use `assertWritable` after fetch. If you forget, one user can mutate another user's data.

**Context assembly** must scope memory queries, library page queries, persona queries, emotional state queries, and all other personal data to the current principal. Leaking another user's memories or library pages into the LLM context is the most dangerous form of data bleed.

**Tool handlers** execute within a principal context. When a tool reads or writes user data, it must use the scoped helpers. The tool registry does not automatically scope data access.

### Content Classification

**Global (readable by all, writable by admin/system):**
- Default skill definitions (`scope='global'`)
- Default persona templates (`source='seed'` or `is_default=true`)
- Product thesis / mission library pages
- System settings that are platform-wide

**User-owned (private by default):**
- Chat sessions and messages
- Memory entries, links, content blocks, entity links
- Library pages (most), notes, annotations
- People, contacts, interactions
- Goals, priorities, check-ins
- Projects, tasks, milestones
- Decisions, strategies, theses
- Emotional states, active persona selection
- Preferences, rules, beliefs, observations
- Timers, hooks, intentions, parked ideas
- Email cache, calendar metadata, connected accounts
- Finance (Plaid), health/wellness logs
- Media items, render jobs, exports
- Content queue, landscape signals
- Skill runs, skill scores (the run belongs to the user; the skill definition may be global)

### Common Mistakes That Cause Data Bleed

1. **Forgetting `visibleScopePredicate` on a list/search query.** The query works, returns results, looks correct in dev with one user. With two users, it returns everyone's data.

2. **Using `getCurrentPrincipalOrSystem()` in a code path that handles user data.** The system principal sees everything. If an autonomous job uses system principal instead of the owning user's principal, it reads/writes data without ownership boundaries.

3. **Adding a new table or column without ownership columns.** If a table stores user-specific data, it needs `owner_user_id`, `account_id`, and ideally `scope`. Adding the table without these columns means every query against it is unscoped.

4. **Inserting rows without `ownedInsertValues`.** The row gets created with NULL ownership. It may appear to "work" because system queries find it, but the user cannot see their own data through scoped queries.

5. **Context assembly loading data without principal scoping.** Memory, library, personas, emotional state, and other personal data assembled into LLM context must be filtered by the current user's principal. Loading unscoped data here means the agent's responses contain another user's private information.

6. **Autonomous background jobs not wrapping in `runWithPrincipal`.** Timer-fired skills, hook actions, email sync, and other background work must resolve the owning user and wrap execution in their principal. Without this, all writes land as system-owned orphans.


## Coding Workflows

Procedural coding workflows, diagnostic workflow, git/PR workflow, verification workflow, and final coding report checklist live in root `CODING.md`.

## Runtime Architecture (6 Layers)

```
Layer 6: Intelligence    — Skills, prompt modules, scoring, campaigns, council deliberation
Layer 5: Interface       — Chat streaming, voice (ElevenLabs), 56 UI pages, Focus widget
Layer 4: Orchestration   — Agent executor, timer scheduler, admission controller, hooks
Layer 3: Domain Services — Memory, people, finance, wellness, library, email, social
Layer 2: Storage         — PostgreSQL, S3 object storage, document store, TTL caches
Layer 1: Infrastructure  — Express server, WebSocket, event bus, DB pool, auth
```

## Composition Roots

**Route registration** (`server/routes.ts`): `registerRoutes()` delegates to:

`registerDomainRoutes()` — 26 domain routers: setup, gateway, workspace, system, identity, inference, events, integrations, voice, brain, work, ooda, plaid, finance, spec, health, info, captures, email, session-display, content, hooks, session-reminder, cognition, secrets, railway

Plus: `registerChatRoutes`, `registerPeopleRoutes`, `registerGoalRoutes`, `registerTagRoutes`, `registerCalendarRoutes`, `registerTimerRoutes`, `registerMemoryRoutes`, `registerMigrationRoutes`, `registerContextRoutes`, `registerThoughtRoutes`, `registerStrategyRoutes`, `registerObjectStorageRoutes`, `registerSkillRoutes`

**Boot hooks** (`server/index.ts`): Memory listener, timer scheduler, content publisher, nightly sleep cycle (2 AM CT)

## Canonical State Stores

| Domain | Storage | Key Tables/Files |
|--------|---------|-----------------|
| Memory + graph | PostgreSQL + pgvector | `memory_entries`, `memory_links` |
| Conversations | Document store (JSON blobs) | `workspace_documents` |
| Intentions | PostgreSQL | `intention_items` |
| Timers | PostgreSQL + TTLCache | `timers`, `timer_schedules` |
| Skills | PostgreSQL | `skills`, `skill_runs` |
| Prompt modules | PostgreSQL | `prompt_modules`, `prompt_module_versions` |
| Session artifacts | PostgreSQL | `session_artifacts` (join table: sessions → Library pages, files, memory, content, docx) |
| People | Document store | `workspace_documents` (type: person) |
| Library | PostgreSQL | `library_pages` (TipTap JSON) |
| Email | PostgreSQL | `email_messages`, `email_enrichments` (7 tables) |
| Finance | PostgreSQL (Plaid) | 26 tables in `shared/models/finance.ts` |
| Wellness | PostgreSQL | `wellness_activities`, `wellness_logs` |
| Social content | PostgreSQL | `content_queue` |
| Decisions | PostgreSQL | `decisions`, `decision_updates`, `decision_links` |
| Hooks | PostgreSQL + TTLCache | `system_hooks` |
| Settings | PostgreSQL KV | `system_settings` |
| Principals + permissions | PostgreSQL + request context | `users`, `user_permissions`, `server/principal.ts`, `server/permissions.ts`, `server/principal-context.ts` |
| Tool definitions | In-memory | Rebuilt on demand from `tool-registry.ts` |
| Exec (career) | PostgreSQL | `exec_experience`, `exec_skills`, `exec_opportunities`, `exec_metrics`, `exec_education`, `opportunity_artifacts` |
| Persistent files | Object storage (R2) | Cloud |
| Scratch workspace | Local filesystem | Ephemeral |


### Skills vs Prompt Modules

Skills are runnable workflows with run identity, sessions, scoring, and operator-facing execution. Prompt Modules are internal DB-backed prompt templates used by code paths inside memory, people, strategy, tools, and chat. Do not store internal helper prompts as Skills just to make them editable. Do not add skill-runner/session semantics to Prompt Modules unless a future design explicitly requires it.

## Main Data Flows

1. **Chat Streaming** — Server-side `SessionManager` maintains authoritative streaming state per session. Clients subscribe via WebSocket (`session.subscribe`) and receive snapshot + deltas. Single channel, single source of truth. Types in `shared/streaming-types.ts`, reducers in `server/streaming-reducers.ts`
2. **Chat → Memory** — Messages → event bus → memory listener → exchange buffer → short-term entries → consolidation
3. **Session → Artifact Linking** — Tool call succeeds → `recordSessionArtifact()` → `session_artifacts` table; session resolves → scorer enriches transcript with artifact content; output buffer reads linked pages from artifacts table
4. **Timer → Skill** — Timer fires → scheduler preconditions → pre-context → autonomous skill execution
5. **Intention → Execution** — Intention selected → autonomous conversation → context → agent executor → artifacts
6. **Email Sync → Triage → Enrich** — Gmail poll → cache → LLM classification → thread enrichment → People integration
7. **Social Pipeline** — Draft → review → scheduled + calendar → timer claims → X/Twitter post
8. **Daily Artifacts** — Timer → skill → Library page → set_brief/set_review → CheckIn → UI gold dot
9. **Hook Reactor** — System event → pattern match → condition + cooldown → action dispatch
10. **Sleep Cycle** — Nightly: decay → reinforce → NREM merge/prune → REM dream → GSI score
11. **Memory Consolidation** — Session summaries may mirror into memory; short→mid (threshold/timer) → mid→long (integration) → graph myelination powered by Prompt Modules. Raw session/archive rows are not graph nodes by default.
12. **Access Control** — Session/auth middleware resolves a `Principal` → permission service computes base role + `user_permissions` overrides → `/api/auth/me` exposes principal/scopes/permissions → privileged routes call `requirePermission(...)` or equivalent central checks
13. **Calendar Metadata** — Google event → local overlay → type, linked tasks, auto-linked People
14. **Wellness Rhythm** — Activity logged → urgency recalculated → trends → briefs
15. **Idea Pipeline** — Voice/chat capture → park_idea → parked_ideas → advance cycle → promote or expire
16. **Opportunity Artifacts** — Generate button → server provisions Library slot → spawns skill session → skill writes to Library page → render_artifact_docx → DOCX download
17. **Context Assembly** — semantic orientation flags + kernel/state/instruction/reference layers → parallel resolve → tree assembly → memory injection → XML prompt

## Known Structural Gaps

1. **`bridge-tools.ts` is a 587KB monolith** — 126 handlers, no domain isolation
2. **Two parallel storage strategies** — SQL-direct (newer) vs document-backed (older), no unified abstraction
3. **Session blob storage** — Full JSON rewrite on every message, no pagination
4. **voice-llm.ts is 3,104 lines** — Session management, SSE, keepalive, persistence in one file
5. **Timer execution is strictly serial** — One slow skill blocks all subsequent timers

## Subdirectory Context

- `server/AGENTS.md` — Server subsystems: context, tools, autonomous execution, skills, email, social, supporting systems
- `server/memory/AGENTS.md` — Memory architecture: tiers, ingestion, consolidation, retrieval, graph, sleep cycle
- `server/council/AGENTS.md` — Session tree, cross-session messaging, council multi-model deliberation
- `server/voice/AGENTS.md` — Voice pipeline: module structure, tool middleware, session lifecycle, turn flow
- `server/voice-v3/AGENTS.md` — Voice architecture: v2/v2.5/v3 engines, ElevenLabs integration
- `client/AGENTS.md` — Client: React app shell, routing, state management, chat streaming, voice UI, components
