# Mantra — Personal Intelligence System

A conversational AI + life management + autonomous agent platform. Multi-user, one AI (Agent) per user, full-stack monorepo.

## Tech Stack

- **Server:** Node.js / Express / TypeScript
- **Client:** React 18 / Vite / TailwindCSS / shadcn/ui
- **Database:** PostgreSQL (Drizzle ORM) + pgvector for embeddings
- **Object Storage:** S3-compatible (Cloudflare R2 via GCS proxy)
- **Hosting:** Provider-backed Platform Environment bindings (Railway for current Web stage/live)
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

**Core and Mod Ownership**

Classify every new product capability before implementation as either non-installable Core or owned by exactly one installable Mod. Core is the stable substrate required for identity, safety, composition, and genuinely shared infrastructure; optional coherent product families belong to Mods. Shared primitives may live in Core, but optional user-facing behavior must not be smuggled into Core for implementation convenience.

Mod ownership is end-to-end. A Mod's routes, navigation, Home projections, widgets, actions, tools, Skills, Workflows, Hooks, Timers, integrations, onboarding, search providers, and notifications must be declared through the canonical Mod registry and resolved through the composition/lifecycle system. Do not add parallel hard-coded registration or ad hoc installation gates. If the contribution model cannot express a required surface, extend the canonical protocol rather than bypassing it.

Installation controls composition and owned-resource lifecycle; it never grants authority. Principal permissions, account scope, integration readiness, credentials, and provider authorization remain independent server-side gates. Disabling a Mod must stop its execution and projection without deleting durable user state or history, and reinstall must be replay-safe. Core exposes stable contracts and extension slots without depending on individual Mods.

**Encode Invariants in Structure, Not Guards**

When multiple guards cooperate to enforce a single invariant, the invariant belongs in the data model. Encode ownership in data so invalid states become unrepresentable, not merely prevented. If deleting any one guard reintroduces the bug, the fix is procedural and fragile.

**Canonical Mutation Path**

Critical writes go through one canonical path. If an invariant matters, every route, tool, job, and helper that mutates that state must cross the same enforcement boundary. If another write path can bypass the rule, the fix is incomplete.

**Progressive Disclosure**

Load what's needed, when it's needed, at the depth the task requires. Context is a budget. Never truncate; compress, and leave the thread back to depth.

**Minimum Viable Protocol**

Use the smallest set of patterns that expresses the system truthfully, and reuse them everywhere. Extend only when you can name the constraint the current pattern cannot represent without lying.

**Complexity Spends Reliability**

Every abstraction, state, dependency, asynchronous hop, fallback, and configuration option increases failure probability and recovery cost. Prefer deleting states and failure modes over documenting them.

**Don't Invent the Process**

Every added step — volume, seed, flag, supervisor — is another way to fail. If the sequence is technical and automatable, it was optional. Prefer the design that needs fewer things to be true. Do not automate a process you should have deleted.

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

**Consistent File Shape**

Comparable files should look and read alike. Follow the nearest established pattern for files with the same role; do not invent a new internal arrangement for personal preference. Unless a framework or subsystem convention requires otherwise, order files top-down as: imports, module constants and logger, public types/contracts, private types, public entry points or primary export, then private helpers in first-use order. Keep imports grouped consistently, keep side effects explicit and near the entry point that owns them, and keep exports deliberate rather than scattered accidentally through the file.

Consistency follows responsibility, not forced sameness: a route, React component, schema module, and storage adapter may each have a different canonical shape, but peer files of the same kind should share one. When no pattern exists, establish the smallest clear pattern and document it in the nearest `AGENTS.md` only if it is reusable. Do not churn unrelated files solely to restyle them; bring touched code toward the canonical local shape without obscuring the functional change.

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

**Telemetry Writes**

Observability samples and ordered audit rows share one delivery owner — do not invent a new queue per call site.

Two classes, one module family:

1. **Best-effort observability sink** — browser performance, mobile startup, ambient metrics. Fire-and-forget. Accept on the request path (`202` / void), insert in the background. Use `enqueueTelemetryWrite(label, run)` from `server/telemetry-write.ts`. That module owns `createSerialAsyncDelivery` + `withQueryAttributionAsync("log-sink", …)`. Domain storage validates and maps rows, then enqueues; routes must not `await db.insert` for telemetry.
2. **Serial durable write** — ordered audit rows that must return a result (e.g. `api_calls`). Await the write. Use `createSerialQueue({ label }).enqueueAndWait(fn)` from `server/utils/serial-async-delivery.ts`. Do not hand-roll `let writeQueue = Promise.resolve()` chains.

Never put durable correctness paths (ACLs, settings, billing, ownership mutations) on the telemetry sink. Their SLOW rows are pool-contention symptoms — fix attribution/caching/query shape, not fire-and-forget durability. STT and other transport callback serialization may use `createSerialAsyncDelivery` directly when the consumer is not a DB telemetry insert.

**Tracked LLM Boundary**

Every text/chat/streaming LLM call goes through `server/model-client.ts` via `chatCompletion(...)` or `chatCompletionStream(...)` with structured metadata. Do not call model providers directly from feature code. Specialized modalities must use a sibling tracked boundary before shipping.

**Database Over Filesystem**

Persistent state belongs in PostgreSQL. Filesystem paths are ephemeral in deployment. Legitimate filesystem uses are scratch workspace, bounded rotating diagnostic logs, and explicit user-facing file actions. Operational EventBus telemetry is process-local and must never compete with canonical state for database connections.

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

**Drift Is a Failure Mode**

Dependencies, schemas, configuration, flags, permissions, documentation, and runbooks need owners and review triggers. Continuously expose obsolete versions, unused flags, configuration divergence, and abandoned components.

**No Premature Optimization**

Write correct code first. Optimize with measured bottlenecks and evidence. Exception: architectural decisions expensive to reverse.

**Least Privilege**

Every component gets minimum access. Secrets never appear in code, logs, or error messages. Validate input at the boundary. API keys are scoped to exactly the permissions required.

**Safe Partial Updates**

Tool and route APIs must treat omitted optional fields, empty strings, empty arrays, and empty objects as "no value provided," not as destructive writes. Clearing persisted data requires an explicit clear contract such as `clearFields` plus any domain-required confirmation and reason. Do not rely on callers, schemas, or LLM behavior to omit blank defaults correctly; normalize empty optional inputs at the mutation boundary before constructing persistence patches.

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

**Missing principal context fails closed.** Call `requireCurrentPrincipal()` or `requireCurrentUserPrincipal()` at the boundary. Do not invent ambient system authority. System jobs enter through `runWithPrincipal(createNamedSystemPrincipal(...), fn)` or `createSystemPrincipal()` at the documented job entry only. If user-owned data is written under a system principal, `owner_user_id` will be `NULL` and the row orphaned.

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
- Personal Rules, observations
- Timers, hooks, intentions, parked ideas
- Email cache, calendar metadata, connected accounts
- Finance (Plaid), health/wellness logs
- Media items, render jobs, exports
- Content queue, landscape signals
- Skill runs, skill scores (the run belongs to the user; the skill definition may be global)

### Common Mistakes That Cause Data Bleed

1. **Forgetting `visibleScopePredicate` on a list/search query.** The query works, returns results, looks correct in dev with one user. With two users, it returns everyone's data.

2. **Running user-data work under a system principal.** System principals see everything they are granted. If an autonomous job uses a system principal instead of the owning user's principal, it reads/writes data without ownership boundaries.

3. **Adding a new table or column without ownership columns.** If a table stores user-specific data, it needs `owner_user_id`, `account_id`, and ideally `scope`. Adding the table without these columns means every query against it is unscoped.

4. **Inserting rows without `ownedInsertValues`.** The row gets created with NULL ownership. It may appear to "work" because system queries find it, but the user cannot see their own data through scoped queries.

5. **Context assembly loading data without principal scoping.** Memory, library, personas, emotional state, and other personal data assembled into LLM context must be filtered by the current user's principal. Loading unscoped data here means the agent's responses contain another user's private information.

6. **Autonomous background jobs not wrapping in `runWithPrincipal`.** Timer-fired skills, hook actions, email sync, and other background work must resolve the owning user and wrap execution in their principal. Without this, all writes land as system-owned orphans.


## Coding Workflows

Procedural coding workflows, diagnostic workflow, git/PR workflow, verification workflow, and final coding report checklist live in root `CODING.md`.

## Architecture Audit Standard

`REPOSITORY_COMPLIANCE.md` and `repository-compliance.json` define the repository-wide file denominator, responsibility classes, and evidence-backed exception mechanics. The production build validates that contract before artifact generation. Unclassified files are ordinary authored source; generated artifacts, vendored code, immutable migration history, and compatibility fixtures require explicit provenance and remain subject to universal authority, security, ownership, observability, recovery, and build principles. `server-standards-disposition.json` assigns every `server/`, `shared/`, `script/`, `scripts/`, and `migrations/` file exactly one reviewed, cured, or exceptional-class exemption disposition against that same denominator; the build rejects gaps, overlap, ordinary-source exemptions, and stale entries.

Architecture claims are verified only when current source demonstrates both the behavior and its owning composition or mutation boundary. Use exact repository search for identifiers and registrations, GitNexus for callers/flows/impact, and read the authoritative implementation before recording a finding. A principle violation must name the principle, concrete source locations, reachable flow, failed invariant, and smallest coherent cure. Heuristics, file size, naming, or an isolated code smell are leads, not findings.

Dead code requires stronger proof: no static imports/callers; no route, tool, Mod, Skill, Workflow, Hook, Timer, boot, script, native/plugin, provider-callback, or dynamic lookup registration; and no persisted identifier, migration, rollback, or supported compatibility contract that can still reach it. Search strings and graph results are evidence, not proof by themselves. If any dynamic or compatibility path remains plausible, retain the code and state what proof is missing. Do not turn uncertainty into a backlog.

Root `AGENTS.md` records repository-wide truths only. The nearest subtree `AGENTS.md` owns local contracts; source composition roots remain the runtime authority. Update guidance in the same PR when source proves it stale, but do not duplicate detailed subsystem law at root.

## Runtime Architecture

```
Interface      — `client/` web application and `mobile/` Expo application
Shared protocol — `shared/` cross-runtime contracts, schemas, references, permissions, Mod contracts
Server         — `server/` HTTP/WebSocket composition, domain services, Agent/LLM execution, autonomy, integrations
Persistence    — PostgreSQL relational/document state, object storage, bounded process-local caches
Operations     — `script/` production build plus `scripts/`, `migrations/`, and provider-backed Platform lifecycle
```

## Composition Roots

- `server/index.ts` owns process boot, ordered schema/service readiness, route registration, post-ready workers, and graceful shutdown.
- `server/routes.ts#registerRoutes` owns WebSocket upgrades and the complete top-level HTTP composition. It delegates one evolving route family to `server/routes/index.ts#registerDomainRoutes` and registers additional root routers directly; do not copy router counts or exhaustive lists here because those files are authoritative.
- `client/src/main.tsx` and `client/src/App.tsx` own web bootstrap and route composition. Mod/product composition may filter declared surfaces but does not replace those roots.
- `mobile/app/_layout.tsx` owns Expo provider/navigation composition; `mobile/metro.config.js` is the cross-repository shared-contract bridge.
- `shared/` has no runtime composition root. It contains dependency-light contracts consumed by server, web, mobile, and build validation.
- `script/build.ts` is the required production build gate. Root `package.json`, Dockerfile, and Platform Environment bindings own package, image, and deployment entrypoints.

## Canonical State Stores

| Domain | Storage | Key Tables/Files |
|--------|---------|-----------------|
| Memory + graph | PostgreSQL + pgvector | `memory_vnext_claims`, `memory_vnext_claim_links`, `memory_vnext_sources`; legacy `memory_entries` closure pending quarantine |
| Conversations | PostgreSQL incremental message rows + ordered revisions; document aggregate for scoped metadata/legacy reads | `conversation_messages`, `conversation_revisions`, `document_store_documents` via `conversation-persistence.ts` / `chat-file-storage.ts` |
| Intentions | PostgreSQL | `intention_items` |
| Timers | PostgreSQL + TTLCache | `timers` (`schedules` JSONB column), `responsibility_runs` |
| Skills | PostgreSQL | `skills`, `skill_runs` |
| Prompt modules | PostgreSQL | `prompt_modules`, `prompt_module_versions` |
| Session artifacts | PostgreSQL | `session_artifacts` (join table: sessions → Library pages, files, memory, content, docx) |
| People | PostgreSQL relational storage | `persons`, `person_vault_memberships`, `person_emails`, `person_merge_aliases` |
| Library | PostgreSQL | `library_pages` (TipTap JSON) |
| Email | PostgreSQL | `email_messages`, `email_enrichments` (7 tables) |
| Finance | PostgreSQL (Plaid) | 26 tables in `shared/models/finance.ts` |
| Business Plans | PostgreSQL | `business_plans`; `/business/advantage` is the Business Plan screen (formerly Mandate) |
| Wellness | PostgreSQL | `wellness_activities`, `wellness_logs` |
| Social content | PostgreSQL | `content_queue` |
| Decisions | PostgreSQL | `decisions`, `decision_updates`, `decision_links` |
| Hooks | PostgreSQL + TTLCache | `system_hooks` |
| Settings | PostgreSQL KV | `system_settings` |
| Principals + permissions | PostgreSQL + request context | `users`, `user_permissions`, `server/principal.ts`, `server/permissions.ts`, `server/principal-context.ts` |
| Tool definitions | In-memory | Rebuilt on demand from `tool-registry.ts` |
| Exec (career) | PostgreSQL | `exec_experience`, `exec_skills`, `exec_opportunities`, `exec_metrics`, `exec_education`, `opportunity_artifacts` |
| Persistent files | Object storage (R2) | Cloud |
| External files (multi-provider) | Google Drive + Mantra object storage (+ Box stub) | `server/files-api.ts` + `server/files-providers.ts` — vault-bound reads only; authorize in FilesApi, transport in adapters; full Drive bodies AES-GCM envelope-encrypted to R2 + `indexed_content` with source-fingerprint keys and a completeness contract (`sourceBytes`/`stagedBytes`/`complete`/`next`) |
| Scratch workspace | Local filesystem | Ephemeral |

### PostgreSQL Runtime Shape

`server/db.ts` is the ordinary application boundary: one instrumented Drizzle proxy selects the general or reserved voice lane through AsyncLocalStorage. Authentication retains a separate `connect-pg-simple` pool, and diagnosed export/watchdog operations may open bounded dedicated clients. Raw SQL remains valid for DDL, catalog queries, PostgreSQL-specific operators, bulk SQL, and migrations; Drizzle is the default mapper, not an exclusive abstraction. Pool sizes and operational limits are runtime policy: read `server/db.ts` and `server/AGENTS.md` § Database Architecture rather than copying numeric budgets into root guidance.

`server/schema-convergence.ts` is the deployed-schema composition authority. It owns pre-readiness ordering, fatality, phase observability, DB Sync baseline delegation, and the explicit post-ready delegation for concurrent document-search indexes. `runSchemaBootstrap()` and subsystem ensure functions remain idempotent implementation actors beneath that boundary; immutable migration SQL and Drizzle declarations remain specifications/history rather than independent runtime owners. Route registration must be DDL-free. Expensive concurrent index replacement remains deliberately post-ready and delegated because PostgreSQL forbids it inside the ordinary boot transaction/lock shape.

### Skills vs Prompt Modules

Skills are runnable workflows with run identity, sessions, scoring, and operator-facing execution. Prompt Modules are internal DB-backed prompt templates used by code paths inside memory, people, strategy, tools, and chat. Do not store internal helper prompts as Skills just to make them editable. Do not add skill-runner/session semantics to Prompt Modules unless a future design explicitly requires it.

## Main Data Flows

1. **Chat Streaming** — Server-side `SessionManager` maintains authoritative streaming state per session. Clients subscribe via WebSocket (`session.subscribe`) and receive snapshot + deltas. Single channel, single source of truth. Types in `shared/streaming-types.ts`, reducers in `server/streaming-reducers.ts`.
   - Every logical `(connection, owner, session)` subscribe or unsubscribe advances `subscriptionEpoch`. Revalidate it after asynchronous authorization/hydration and immediately before registration or delivery; stale work is an idempotent no-op.
   - Every snapshot and delta carries `(runGeneration, eventSeq)`. Clients accept only advancing tuples; equal/regressive same-generation payloads and older generations cannot replace current state. Idle snapshots use generation `0`.
   - Reconnect, visibility, `pageshow`, and focus feed one coalesced recovery coordinator owned by the app-level subscription layer. Transcript renderers must not install parallel browser-resume refetch loops; durable revision advancement owns terminal handoff.
   - Every active stream is registered with a complete `{ runId, turnId, assistantAttemptId }` tuple before its first event, checkpoint, draft, or snapshot. Live events and durable messages reuse that tuple; new producers may not omit or heuristically reconstruct identity.
2. **Chat → Memory** — Persisted sessions enqueue canonical vNext sources → bounded extraction → claim persistence and source provenance
3. **Session → Artifact Linking** — Tool call succeeds → `recordSessionArtifact()` → `session_artifacts` table; session resolves → scorer enriches transcript with artifact content; output buffer reads linked pages from artifacts table
4. **Timer → Skill** — Timer fires → scheduler preconditions → pre-context → autonomous skill execution
5. **Intention → Execution** — Intention selected → autonomous conversation → context → agent executor → artifacts
6. **Email Sync → Triage → Enrich** — Gmail poll → cache → LLM classification → thread enrichment → People integration
7. **Social Pipeline** — Draft → review → scheduled + calendar → timer claims → X/Twitter post
8. **Daily Artifacts** — Timer → skill → Library page → set_brief/set_review → CheckIn → UI gold dot
9. **Hook Reactor** — System event → pattern match → condition + cooldown → action dispatch
10. **Sleep Cycle** — Nightly vNext lifecycle maintenance → REM synthesis → optional GSI structural scoring; legacy entry decay, reinforcement, NREM, and tier-budget phases are retired.
11. **Memory Lifecycle** — vNext source extraction persists provenance-backed claims; nightly lifecycle, REM, and GSI maintain the active claim graph without legacy tier promotion.
12. **Access Control** — Session/auth middleware resolves a `Principal` → permission service computes base role + `user_permissions` overrides → `/api/auth/me` exposes principal/scopes/permissions → privileged routes call `requirePermission(...)` or equivalent central checks
13. **Calendar Metadata** — Google event → local overlay → type, linked tasks, auto-linked People
14. **Wellness Rhythm** — Activity logged → urgency recalculated → trends → briefs
15. **Idea Pipeline** — Voice/chat capture → park_idea → parked_ideas → advance cycle → promote or expire
16. **Opportunity Artifacts** — Generate button → server provisions Library slot → spawns skill session → skill writes to Library page → render_artifact_docx → DOCX download
17. **Context Assembly** — semantic orientation flags + kernel/state/instruction/reference layers → parallel resolve → tree assembly → memory injection → XML prompt

## Issue filing rule

Never file an Issue without a non-empty **issue description** plus **platform environment** and **build** linkage. `storage.createIssue` is the sole create path and rejects title-only shells; when env/build are omitted it fills them from runtime identity. Report creation is Core feedback infrastructure, while cross-owner triage and repair remain Build-owned. Prefer evidence-rich bugs over volume. Full boundary: `server/AGENTS.md` → **Issue create boundary**.

## Verified Structural Gaps

These are current source-backed conditions, not a speculative backlog. Re-verify the owning source before citing or curing one.

1. **Tool domain migration** — public tool identity and invocation remain singular in `server/tool-registry.ts` and `server/bridge-tools.ts#executeTool`; `server/tools/domain-adapters.ts` exhaustively owns each registered tool by domain and composes exactly one handler source per public name. Legacy private implementation helpers may remain inside `bridge-tools.ts`, but cannot enter the dispatch map or act as registration/authority. Remaining file-size reduction is implementation migration, not an authority gap.
2. **PostgreSQL query-path observability** — constructors and pool lifecycle now converge through `server/database-adapters.ts`, while `server/db.ts` owns ordinary general/voice execution policy and raw SQL remains supported. Checked-out clients plus named auth, metrics, and dedicated adapters retain workload-local observability rather than the ordinary lane instrumentation. Detailed evidence lives in `server/AGENTS.md` § Database Architecture.
3. **Incremental conversation migration** — `conversation_messages` is active transcript authority with stable message IDs, mutable ordinals, per-message revisions, and principal/account/Vault scope; `conversation_revisions` is append-only commit evidence. `document_store_documents` remains the Session aggregate/search anchor and legacy blob input, but active writes persist an empty message projection rather than rewriting the transcript. Legacy sessions adopt their blob messages on the first canonical write.
4. **Legacy schema implementation concentration** — deployed ordering and observability now converge through `server/schema-convergence.ts`; the retained large `runSchemaBootstrap()` body and subsystem ensures are delegated implementation actors whose future decomposition must preserve that one composition owner.
5. **Runtime compatibility retirement** — the fenced Runtime kernel is canonical for capacity, attempts, leases, retries, cancellation, and terminal receipts. Top-level Skill execution (including Council and Regression), scheduled Skill Timers, Plan launches, and memory-source extraction enter through native Runtime handlers; retained process-local schedulers and monitors are discovery/projection adapters or child-domain coordinators and must not grant capacity or terminalize a Runtime Run. The legacy admission façade remains a bounded adapter for interactive Agent/browser and non-Skill Hook work until those producers gain native handlers.

## Owned Subsystems and Instruction Boundaries

Instruction boundaries are inherited: always load root `AGENTS.md` and `CODING.md`, then every nearest `AGENTS.md` for a subtree inspected, changed, or relied upon. Absence of a nested file means the nearest ancestor owns the guidance; it does not mean the subsystem is unowned.

| Boundary | Owned scope |
|---|---|
| `server/AGENTS.md` | Server root, storage/schema, auth/principals, HTTP/WebSocket composition, Agent/model/context/tools, autonomy/runtime, Mods, integrations, and domain services unless a deeper boundary exists |
| `server/memory/AGENTS.md` | vNext memory ingestion, retrieval, graph, lifecycle, provenance, and legacy-memory compatibility |
| `server/council/AGENTS.md` | Session tree messaging and council deliberation |
| `server/voice/AGENTS.md` | Current ElevenLabs/custom-LLM voice pipeline and voice-local middleware/lifecycle |
| `client/AGENTS.md` | Web shell, routes/pages/components, React Query/state, references, streaming projection, voice UI, and design-system application |
| `mobile/AGENTS.md` | Expo Router app, native modules/plugins, WebViews, auth/voice, telemetry, and shared-contract integration |

Repository-owned subsystems without deeper instructions remain under `server/AGENTS.md`: `runtime`, `tools`, `mods`, `workflows`, `sessions`, `meeting`/`meetings`, `speech-recognition`, `platforms`, `integrations`, `file-storage`, `object_storage`, `relationships`, `strategy`, `simple`, `media`, `notifications`, `phone`, `glasses`, routes, and root-level domain services. `shared/`, `migrations/`, `script/`, and `scripts/` remain root-governed. Create a nested `AGENTS.md` only when a durable local contract cannot stay concise and truthful in its current owner.
