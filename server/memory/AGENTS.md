# Memory Architecture

A vNext claim is the deletion aggregate for its entity links, claim links, source refs, and any relationship evidence that cites those source refs. `MemoryVnextClaimStorage.deleteClaim(...)` is the sole ordinary aggregate deletion boundary: it locks the scoped claim and sources, removes principal-writable cross-link evidence first, then deletes the claim so existing cascades complete. The source-evidence foreign key remains restrictive for ordinary source deletion; do not weaken it globally to make claim deletion work.

The memory subsystem is in staged retirement. vNext claims are the active semantic graph and the nightly sleep substrate. The ordinary HTTP registrar is vNext-only: legacy 410 shims, retention purge, document/workspace compatibility, and legacy maintenance routes are not registered. Legacy `memory_entries` tiers remain as compatibility/archive data while non-route readers migrate; automatic legacy propagation and maintenance launchers are disabled. The separately registered privileged migration boundary retains only explicit document-store migration controls and legacy-memory quarantine status/prepare/apply operations.

## Active Tables and Ownership

| Table | Purpose | Authority |
|---|---|---|
| `memory_vnext_source_queue` | Versioned source admission and Runtime projection | Source owner + exact `last_modified_at`; atomic settled-source Runtime binding |
| `memory_vnext_claims` | Instance-pinned semantic claims (dual-write `instance_id` + acting `owner_user_id`) and lifecycle metadata | `applyObservation()` for ingestion; lifecycle service for stage transitions; visibility is Instance pin OR null+owner, never account alone |
| `memory_vnext_sources` | Claim provenance and source-to-claim evidence | Written with the claim observation, never as a detached mirror |
| `memory_vnext_claim_links` | Typed claim relationships and transition evidence | `vnext-transition-graph.ts` |
| `memory_vnext_entity_links` | Principal-scoped entity associations | vNext entity-resolution/link boundaries |
| `memory_vnext_exposures` | Replay-safe passive context exposure telemetry | Context build ID + claim identity; no strength authority |
| `memory_vnext_strength_events` | Explicit reinforcement/decay evidence | Canonical typed event mutations only |

Legacy `memory_entries` and its graph closure are archive/compatibility state, not active memory tables. Their physical retention and quarantine gates are documented below. Do not describe them as the source of truth for cognition, context, retrieval, lifecycle, or observations.

## Source Processing State Contract

`memory_vnext_source_queue` owns source admission and projects the exact native Runtime identity that may process each source version. `pending` rows have no Runtime binding; the bounded poller atomically selects one settled row with `FOR UPDATE SKIP LOCKED`, enqueues the idempotent Runtime Run inside the same database transaction, and persists `runtime_run_id` plus `runtime_source_version` before releasing the row. Replica races therefore distribute intake without creating another lease.

Native Runtime owns capacity and attempts. Its handler alone advances a bound source to `processing` by projecting `runtime_attempt_id` and `runtime_lease_epoch`. Graph mutation revalidates that exact source version and attempt under row lock; completion clears only the attempt projection and retains the durable Run/version relation. A later attempt may take over only after the previous Runtime attempt is durably retryable or lost. Legacy recovery may reset only rows with no Runtime projection.

## vNext Orthogonal Claim Dimensions

- The claim remains the center. Relationships, Integration Level, Certainty, Strength, and explicit time metadata remain independently inspectable.
- `memory_vnext_claims.confidence` is compatibility-only extraction confidence. It is never claim certainty.
- Source clarity and source-to-claim relationship certainty live on `memory_vnext_sources`; claim-link certainty remains separate on `memory_vnext_claim_links`.
- Integration is a canonical read projection of relationship-type, direction, lineage, entity, context, and certainty diversity. Raw link count cannot determine it.
- Strength is a canonical read projection of typed `memory_vnext_strength_events` plus decay. Exposure and legacy recall contribute zero.
- Claim time uses `observed_at`, `valid_from`, `valid_until`, `occurred_at`, and `expected_by`. Lifecycle stage is migration compatibility metadata, not truth authority.
- `vnext-claim-dimensions.ts` is the only dimension-derivation boundary. Do not store or introduce a combined memory-quality score.
- `vnext-transition-graph.ts` is the canonical claim-relationship mutation and transition-path derivation boundary. The physical edge identity is the owned `(fromClaimId, toClaimId, relationship)` tuple; producer replay tokens may only derive replay identity within that tuple and must never identify another edge. New edges use a structural class (`semantic`, `evidence`, `temporal`, `causal`, or `consolidation`), certainty, provenance, and observation/hypothesis status. Asserted edges cite source refs; derived edges also carry method/version. Causal edges remain `causal_hypothesis`; semantic similarity and temporal sequence never establish causality. Relationship failures log only bounded error type, SQLSTATE, and cause depth—never source passages, evidence quotes, SQL, parameters, or arbitrary error messages.
- `applyObservation()` in `vnext-claim-storage.ts` is the canonical source-ingestion boundary: one replay-safe observation commits matched/created claims, claim-specific source evidence, and typed relationships. Extractors may prepare embeddings and model output outside this boundary, but no ingestion path may independently write these graph parts or treat projections as sources of truth.
- `cognition.observe` enters that same boundary through `metacognitive-observations.ts`. Model-authored observations are typed provisional assertions with explicit model/session provenance; they re-enter the `thoughts` context section immediately from vNext source evidence. A lone observation cannot advance through lifecycle. Canonical dedup may add independent source evidence to the same claim, after which ordinary lifecycle may promote, link, merge, supersede, or retire it. Do not restore a parallel Thought/observation persistence path.
- Company entity identity is owned by canonical Company rows plus the scoped, append-only `company_identity_keys` ledger; canonical names and aliases share one active namespace uniqueness constraint. Resolution is exact after deterministic normalization and returns `resolved`, `unresolved`, or `ambiguous`. Memory must never use loose fuzzy company linking or private alias maps.
- Transition paths are bounded, ownership-scoped projections of explicit state → action → state temporal edges, with optional evidence-traceable cause/mechanism hypotheses. Recompute by stable derivation key; preserve raw claims, source refs, and legacy links.
- `vnext-prediction-ledger.ts` owns shadow forecast generation, later-evidence resolution, proper scoring, and prediction-derived relationship-certainty updates. Forecast probability/path/context snapshots are immutable; resolutions, corrections, and certainty events are append-only. Generation requires an evidence-backed causal transition plus newer evidence-backed state/action matches and abstains before using an already-visible outcome. Only the versioned bounded rule may update causal-edge certainty, inside the same transaction as its audit event. Predictions stay out of retrieval, context, tools, and user-facing surfaces until calibration earns activation.
- `vnext-shadow-evaluation.ts` owns dual-retrieval measurement, reviewed labels, independent-dimension ablations, strict-cutoff prediction baselines, causal-path reviews, and the user-scoped corrected-retrieval control. Missing control means compatibility retrieval; prediction output is structurally shadow-only. Context assembly may select corrected ranking only through this control and must fall back to compatibility on every evaluation failure. Never persist focus text, infer missing labels, or turn the ephemeral corrected ranking score into claim state.

## Integration Stages During Migration

`memory_entries.layer` remains the compatibility contract while `integration_stage` becomes the semantic lifecycle signal.
Report both until all consumers migrate.

| Stage | Meaning | Legacy layer compatibility |
|---|---|---|
| `stage_0` | Raw captured material | usually `short` |
| `stage_1` | Enriched with title/summary/tags | legacy enriched mirrors/workspace |
| `stage_2` | Consolidated into working knowledge | usually `mid` |
| `stage_3` | Deep/canonical integration | usually `long` |
| `stage_4` | Sleep-upkeep-maintained canonical memory | compatible with `long` |

The nightly sleep cycle no longer operates on integration stages or layers; it maintains vNext claims only. Stage semantics remain relevant for legacy consolidation/enrichment code until Phase B removal.

## Active Architecture

Semantic memory has one active claim graph, not short/mid/long stores. Sources enter `memory_vnext_source_queue`; native Runtime performs bounded extraction; `applyObservation()` atomically commits claims, provenance, and typed relationships; lifecycle derives integration without copying claims between tiers. `extracted | sourced | linked | canonical | retired` is compatibility processing metadata over the same claim identity.

Legacy consolidation/integration modules remain only where quarantine, migration, or rollback contracts still import them. Their presence does not make timer-driven tier promotion active, and no new caller may revive it.

## Retrieval

The retrieval system blends multiple signals to find relevant memories:

```
query → generateEmbedding(query)
      → pgvector similarity search (cosine distance)
      → graph neighborhood expansion
      → recency weighting
      → source diversity bonus
      → final ranked list
```

Key files:
- `server/memory/retrieval.ts` — `searchMemory()`, `retrieveForContext()`
- `server/memory/graph.ts` — `getNeighborhood()`, `expandGraph()`

### Retrieval Signals (blended)
1. **Semantic similarity** — pgvector cosine distance on embeddings
2. **Graph proximity** — entries linked to high-similarity hits get boosted
3. **Explicit time metadata / creation recency** — current applicability and recency where the retrieval mode uses them
4. **Source diversity** — bonus for mixing source types

Legacy `lastRecalledAt` and `recallCount` remain readable for migration diagnostics only. They are excluded from vNext ranking and must not be reintroduced as strength or certainty proxies.

### Retrieval Ownership

All user-facing and context retrieval is vNEXT-only. `memory.search`, `search_claims`, People summarization, Library semantic search, the Memory Query API, and `memory.graph` read `memory_vnext_claims`; they never query or fall back to `memory_entries`. Retrieval algorithms may expose different modes over the same claim store: explicit hybrid search for tools/UI and contextual graph expansion for prompt assembly. Shared ranking policy lives in `vnext-retrieval-policy.ts`, while each mode owns its orchestration. Legacy `memory_entries` code is write-side ingestion, migration, maintenance, and compatibility CRUD only until retirement. Do not import legacy search from a vNEXT module or blend stores in one result set.

Graph recency uses `active_touched_at`. `last_recalled_at` and `recall_count` are frozen compatibility telemetry and must never affect retrieval, strength, certainty, lifecycle, retirement, or deletion. Passive context inclusion records one `memory_vnext_exposures` row per claim and `context_build_id`; cache replay and retry converge on the same row and carry zero strength. Meaningful reinforcement enters only through typed `memory_vnext_strength_events` with canonical bounded weights and replay keys. Explicit claim reads and successful link mutations cross `MemoryVnextClaimStorage.touchClaim(s)`. Creation is fresh by `created_at`. Background lifecycle, embedding, and dedup maintenance do not constitute active touch.

### Tiered Context Assembly (memory.graph)

The `memory.graph` context section uses tiered context assembly instead of flat rendering. It allocates token budget from the active persona and renders memories at depth proportional to relevance.

**Pipeline:**
```
persona cognitiveOverrides.memoryGraphTokenBudget (default 4000)
  → build focus text from session context
  → retrieveVnextContext() — pgvector semantic search over memory_vnext_claims
  → blend signals: semantic, causal (claim links), contrastive, temporal
  → modulateWeights() by session type + emotional state
  → allocateTiers() greedy knapsack → Signal/Detail/Full
  → renderVnextContext() per tier
```

vNext-only. No legacy `memory_entries` fallback. Rendered output explicitly identifies vNEXT provenance; retrieval errors return "vNEXT graph memory temporarily unavailable."; empty results render empty. Short/mid/long layer sections were removed from context assembly entirely.

**Key files:**
- `server/context-builder.ts` — `resolveGraphMemory()`, `getMemoryGraphTokenBudget()`, `allocateTiers()`, `renderTieredEntry()`
- `server/memory/vnext-context-retrieval.ts` — `retrieveVnextContext()` blend scoring over claims
- `server/memory/vnext-claim-storage.ts` — semantic claim search + canonical `mapRawVnextClaimRow()` mapper
- `server/memory/vnext-retrieval-policy.ts` — `modulateWeights()`, `detectSessionType()`, `BLEND_WEIGHTS`
- `server/memory/vnext-search.ts` — explicit hybrid semantic/lexical vNEXT search with structured filters

**Tiers:**

| Tier | Content | Use case |
|------|---------|----------|
| Signal | title + score + age | "This exists and is relevant" |
| Detail | + summary + tags + stage | "Here's what it says" |
| Full | + content excerpt (500 chars) | "Here's the substance" |

**Budget rules:**
- Budget < 500 tokens → skip Full tier entirely, start at Detail
- Greedy allocation: highest-scored candidate gets richest affordable tier
- Each subsequent candidate degrades through tier order until budget exhausted
- Cache key includes tokenBudget (different personas get separate caches)

**Constraints:**
- No LLM calls at query time
- Single vector search query (pgvector `<=>` cosine, indexed)
- Target latency: < 200ms total pipeline
- Graceful degradation: timeout/failure in seed search falls back to recency seeds only

## Graph System

Claims are connected through principal-owned `memory_vnext_claim_links`. `vnext-transition-graph.ts` owns typed relationship mutation, provenance, replay identity, and bounded transition-path projection. Passive recall never strengthens links; explicit evidence and typed strength events own semantic change.

## Personal Graph Projection (Library-first)

`server/memory/personal-graph-projection.ts` is the bounded assembler behind `GET /api/memory/vnext/graph`. It is a disposable projection consumer, never an authority: it seeds every principal-visible live Library page and every authorized active `indexed_file_sources` file (including isolated, not-yet-semantically-processed sources) from slim metadata, aggregates whole-corpus authored occurrence edges through `getLibraryCorpusOccurrenceEdges` (row-bounded, never corpus-sized, never parses page bodies), resolves referenced non-page targets through `resolveAddressBatch` so both endpoints are authorized independently, then overlays vNext claims and selected strong domain facts. Meetings + Calendar participates through `server/meetings/meeting-graph-adapter.ts`, which emits canonical domain candidates; Decision + Strategy participates through `server/strategy/decision-strategy-graph-adapter.ts`, whose internal simulation nodes are admitted only when `selected` explicitly names the visible Strategy; Sessions + Plans + Workflows participate through `server/execution-provenance-graph-adapter.ts`, which emits bounded causal execution provenance while keeping execution foreign keys authoritative. The assembler admits an edge only after both endpoints exist as independently authorized nodes and reports per-adapter edge counts for parity. Query count is fixed by the adapter set. `LIBRARY_FIRST_GRAPH_ENABLED=false` rolls back to the retained claim-first `handleGetVnextGraphLegacy` without a redeploy. Assembly latency, node/edge/payload counts, and adapter query count are logged and published on `memory:personal_graph_projected`; the client records snapshot latency, payload bytes, init-task, first-interactive, and worker layout-settled samples under the `graph` browser-telemetry kind. Client force layout runs in `client/src/lib/graph-layout-worker.ts` on a budgeted ~60 Hz physics clock (adaptive Barnes-Hut theta/distanceMax by N; schedule delay = remaining frame budget so overruns never stack a fixed wait) with a fail-open main-thread fallback that shares the same charge profile. Visual admission is gated: the worker prestabilizes silently (multi-tick burst, no position posts) before the first transferable solve; the main thread keeps nodes hidden (`layoutAdmitted=false`) until that first post, then glides linearly between posts and eases out on the final `end` segment (`LAYOUT_FINAL_SEGMENT_MS` + smoothstep). Labels stay closed until the layout rests and only open for selected / hovered / focus-neighborhood nodes — never a full-graph label flood. Base edges render straight in one GPU pass while the focused neighborhood keeps curved links.

## Sleep Cycle (vNext)

A nightly maintenance cycle (runs ~2 AM CT), orchestrated by `server/sleep-cycle.ts` — `runFullSleepCycle()`. It operates exclusively on vNext claims and never mutates legacy `memory_entries`.

### Phase 1: vNext Claim Lifecycle
- `server/memory/vnext-lifecycle.ts` — `runVnextLifecycle()`
- Lifecycle stage is compatibility processing metadata: extracted → sourced → linked → canonical
- Retrieval silence, passive exposure, age, and low strength never decay certainty or retire/delete claims
- Retirement requires explicit duplicate, contradiction, or supersession evidence
- Bridge maintenance (cross-island bridge edges)
- New semantic consolidation remains excluded until it has lossless provenance and replay guarantees

### Phase 2: REM (Creative Synthesis)
- `server/memory/dream-engine.ts` — `runREMPhase()`
- Seeds: random active user-owned vNext claims + recent session titles/topics
- Single LLM call generates the dream (title, narrative, insight, domains)
- No memory mutation in the engine: the narrative returns through the tool result and the sleep skill files it to Library. Publishes `sleep:dream_generated`.

### Phase 3: GSI (Graph Structure Index, weekly)
- `server/memory/graph-metrics.ts` — `computeGSI()`
- Computed over vNext claims/links/sources/entity links, principal-scoped
- Components: connectivity, link quality, orphan rate, cluster balance (degree entropy), decay health (confidence-distribution entropy)
- Publishes `sleep:gsi_computed`; no legacy ingest

The cycle report goes to the journal (`appendJournalEntry`) and `sleep:cycle_complete` — it is not written to `memory_entries`. The sleep skill (v5.3+) files one night onto the single rolling Dreams Library page (purpose line + Dream + Memory); it does not write a Sleep Reports catalog.

Legacy sleep phases (entry decay, reinforcement, NREM over `memory_entries`, budget enforcement, belief pass, targeted forgetting) are removed. `sleep-maintenance.ts` is deleted. Consolidate/Integrate timers are durably disabled, their skill rows are deprecated for rollback visibility, manual legacy maintenance routes fail closed, and the in-process threshold/timed-promotion loops are removed.

## Entity Links

Cross-domain associations live in principal-owned `memory_vnext_entity_links`. Agent tools delegate reads and mutations to `MemoryVnextClaimStorage`; entity resolution stays in `vnext-entity-resolution.ts`. Canonical domain IDs are evidence links, never authorization shortcuts.

## Memory Files Compatibility

The `memory.read` / `memory.write` file actions remain a separate compatibility surface for named workspace knowledge documents. They are not semantic claims, do not participate in lifecycle or retrieval, and must not be described as graph nodes or a substitute source of truth.

## Legacy Memory Quarantine

The retired legacy `memory_entries` graph can be moved off the active `public` schema on stage without dropping data. `legacy-memory-quarantine.ts` is the sole authority: `legacy_memory_quarantine_state` in PostgreSQL is the monotonic epoch (no environment variable enables it), and the exact allowlisted physical catalog closure is `memory_entries` plus `memory_sources`, `memory_links`, `memory_transitions`, `memory_content_blocks`, `memory_events`, and `memory_entity_links`. All seven tables must exist exactly once in the expected pre-apply schema; real foreign keys are archived as catalog metadata but do not define membership because historical Stage constraints may be absent. Any missing, duplicate, split, retired-schema, or unclassified memory table fails closed. Prepare builds a deterministic REPEATABLE-READ JSONL archive (catalog inventory + row counts + FKs + triggers + indexes + exact `::text` vector/array bytes + SHA-256 manifest), uploads it under `private/archives/legacy-memory/stage/env-11/` through the direct object backend (never `backup_jobs`), and read-back byte-verifies it. The archive body is assembled as ordered newline-terminated `Buffer` lines concatenated once; it must never be joined into a single JS string because the legacy closure's `::text` embedding/array literals overflow V8's maximum string length. Apply re-verifies those persisted objects, then uses one transaction to drop only inbound FKs from active public tables and `ALTER TABLE ... SET SCHEMA legacy_memory_archive`, validates exact catalog closure and manifest row counts, and persists exact reverse SQL. Apply byte-verifies the archive (SHA-256 + length) and the deterministic checksum sidecar, but verifies the manifest by its authoritative `archiveSha256`/`archiveByteLength` fields rather than raw bytes, because the ledger stores it as JSONB with normalized key order. The prepare/verify/apply core is environment-agnostic and shared (DRY): `LegacyMemoryQuarantineEnvironment` carries the only environment-specific facts — the archive object prefix and the authoritative Platform Environment stamped into and verified against the manifest. `prepareLegacyMemoryQuarantine(env)` refuses to prepare an archive whose runtime Platform Environment does not match `env`, and `applyLegacyMemoryQuarantine(env)` verifies the persisted manifest against `env.platformEnvironmentId`. `stage-legacy-memory-quarantine-operation.ts` passes `STAGE_LEGACY_MEMORY_QUARANTINE_ENV` (env 11, `private/archives/legacy-memory/stage/env-11/`), gates prepare/apply to Platform Environment #11 plus independent document-store ownership, and requests the supervised planned restart. The Stage path retains no HTTP/tool mutation surface.

Live (Platform Environment #12) uses `LIVE_LEGACY_MEMORY_QUARANTINE_ENV` (`private/archives/legacy-memory/live/env-12/`). `live-legacy-memory-quarantine-operation.ts` is prepare-and-report ONLY: on Live boot after readiness it builds and byte-verifies the archive, persists prepared state, records a zero-write observation, and NEVER moves a table or requests a restart-for-apply. The authenticated `system:write` routes in `migration-routes.ts` are the Live surface: `GET /api/memory/migrations/legacy-memory/status` (read-only catalog + ledger + write-activity), `POST /api/memory/migrations/legacy-memory/live/prepare` (non-mutating archive build, env-12 only), and `POST /api/memory/migrations/legacy-memory/live/apply` — the explicit human-authorized destructive gate that moves the seven tables and drops the two inbound FKs only when the exact confirmation string `APPLY-LIVE-LEGACY-MEMORY-QUARANTINE` is supplied on env 12. `observeLegacyMemoryWriteActivity()` is the read-only zero-write primitive (cumulative `pg_stat_user_tables` counters for `memory_entries`/`memory_links`); two samples across the prepare→apply window prove zero writes. Bootstrap retirement is unconditional: `runSchemaBootstrap()` filters the seven-table closure from every baseline, fresh-database, heal, generic timestamp, and ownership/Vault convergence path regardless of quarantine state. No environment may recreate, alter, index, trigger, backfill, or otherwise repopulate those tables through boot. The quarantine ledger and its monotonic trigger remain active, and the explicit prepare/apply boundary remains the only code authorized to inspect, archive, or move the physical closure. The post-readiness stage hook prepares and verifies the archive on its first eligible boot, then applies only on a later fresh boot after refreshing that snapshot; the Stage hook has no HTTP/tool mutation surface. The Live path never self-applies: its boot hook is prepare-only and the destructive move happens exclusively through the explicit human-authorized `live/apply` route.

## Memory Database Workload

Memory uses the ordinary instrumented `db` proxy in `server/db.ts`; it does not own another pool. Its active PostgreSQL workload combines pgvector cosine search, relational graph/source/entity joins, JSONB metadata, native arrays, and the independent document store. Raw SQL is used where Drizzle cannot express the contract cleanly, especially vector distance and maintenance/catalog operations. Every memory query still inherits the general 10 s statement timeout unless a checked-out maintenance session explicitly changes it.

Active context retrieval is bounded but multi-query: `retrieveVnextContext()` generates one embedding, runs semantic and five-row recency seeds in parallel, expands at most two sequential graph hops with an 80-row frontier, hydrates claims by batched IDs, and reads source refs once for the resulting set. The surrounding graph cache is process-local for five minutes and records replay-safe exposure rows on fresh or cached use. Cache hits reduce retrieval reads on one replica; they do not provide cross-replica coherence.

The source poller is scheduled by `server/index.ts` after 30 seconds and every five minutes. One invocation binds at most 10 settled source versions. Each iteration uses `bindNextSettledSourceRuntime()` to select one unbound row with `FOR UPDATE SKIP LOCKED`, restore its exact owner principal, enqueue the account-scoped idempotent Runtime Run, and persist the Run/source-version relation in the same transaction. This transaction contains bounded database work only; extraction and model calls remain outside it. Native `short_worker` dispatch is the sole execution owner: the queue projects the current run/attempt/epoch fence, a later attempt may take over only after the prior attempt is durably `retry` or `lost`, and legacy maintenance never clears Runtime-bound fences. Before graph writes, `withSourceRuntimeFence()` locks and revalidates the exact source version and attempt; `applyObservation()` inherits that ambient transaction, so a concurrent source edit cannot commit obsolete evidence. Completion clears only the attempt projection while retaining the Runtime run/source-version relation. Claim/source dedup remains replay protection, not lease authority.

`semantic-source-adapters.ts` is the only source-content load boundary for the poller. `VNEXT_SOURCE_TYPES` currently includes `session`, `library_page`, and `drive_file`. Adapters are thin: identify → authorize → normalize text → return one envelope. Queue hashing, claim extraction, provenance, retries, and Runtime fencing stay in the shared core. `drive_file` source ids prefer `drive_resources.id` for explicit binds and fall back to `indexed_file_sources.id` for discovered descendants; content loads only through `FilesApi` (authorize + staged archive/normalized text). Personal graph projection maps `drive_file` source refs to durable `file:<id>` nodes under the same principal visibility rules as FilesApi.

Files semantic indexing policy is separate from binds: `file_index_policies` (mode `off|self|recursive` on a bound `drive_resource`), `indexed_file_sources` (materialized discovered files only), and `file_index_reconciliation_runs` (durable progress: discovering|indexing|complete|partial|failed|canceled). `files-index-service.ts` is the ordinary toggle/status/retry mutation boundary; `files-index-reconciler.ts` is the background worker (FilesApi list/children only, provider-fingerprint dirty detection, cycle-safe bounded batches, overlap-safe retire, failed-file retry without full tree restart). File enable enqueues `markSourceChanged('drive_file', driveResourceId)`; folder enable/disable enqueues a reconciliation run. Folder UI status follows that run — folders never own an `indexed_file_sources` row, so a missing source is not Stale. Coverage is multi-policy with no per-child exclusions in v1.

`applyObservation()` is the canonical graph mutation boundary for new ingestion. Source content and embeddings may be prepared outside the transaction; matched/created claims, source evidence, and typed relationships commit through that boundary. `replaceVnextSourceLinks()` is the separate canonical post-extraction boundary for source-object understanding: under the exact source Runtime revision fence it atomically replaces explicit canonical-reference and inferred-mention links, records evidence/provenance/confidence, independently resolves both endpoints, and abstains on ambiguity. It never edits source files or writes `reference_occurrences`/`address_links`. Files owns Drive selection/freshness and materializes selected descendants as stable `drive_resources`; vNext owns interpretation and graph projection. Avoid holding database transactions across extraction/model calls. Lifecycle/detail/count APIs contain explicit `Promise.all` fan-out, but each branch must remain bounded; the existing `getCounts()` eight-query fan-out is a diagnostic cost, not a pattern to copy into foreground context assembly.

## Workspace Document Extraction

`DocumentStorage` is the compatibility boundary for workspace documents while legacy memory retires. PostgreSQL `document_store_cutover_state` is the sole authority for migration state; deployment variables must never control storage ownership. Before readiness, startup installs the atomic compatibility mirror and reconciles the full workspace projection. Independent activation occurs only when PostgreSQL contains an explicit activation request created after the variable-free binary is fully deployed; the next boot performs the one-way transition. The server must not register document consumers or accept traffic until this barrier completes. Missing state, mismatches, or target errors fail startup visibly; never add a silent legacy read fallback.

`document_store_documents` is the sole runtime read/write authority. `DocumentStorage` has no cutover switch or `memory_entries(layer='workspace')` fallback. This is a PostgreSQL table—not an external document database—with whole-document `content TEXT`, indexed `metadata JSONB`, ownership/Vault columns, and inert source/migration sidecars retained only for historical reconciliation. The persisted epoch removes the forward mirror and installs database guards rejecting any future `memory_entries(layer='workspace')` mutation. Archived workspace rows remain untouched until a separately approved retention deletion. Do not add legacy workspace fallbacks or bypass writes. The one-time stage rollout may request this epoch only after terminal readiness on canonical Platform Environment #11, through `requestIndependentDocumentStoreActivation()`; its supervised next boot still owns every reconciliation and trigger gate. No environment variable or runtime hook may enable independent writes directly. Small indexed metadata mutations use `patchDocumentMetadata(...)` so they follow the active write authority without requiring a full document read; callers must remain principal-scoped and must not use this path to bypass content invariants. Multi-session consumers must hydrate through principal-scoped `DocumentStorage.getDocuments(...)` and `chatFileStorage.getSessions(...)`; the latter may query `session_tree` only for IDs returned by the authorized document read, with named 500-ID batches and sequential best-effort legacy repair.

Chat mutation uses two levels of serialization in `chat-file-storage.ts`: a process-local promise chain and the `CHAT_DOCUMENT` transaction advisory lock. Inside that transaction, nested storage calls inherit the same Drizzle transaction through `runWithDatabaseTransaction(...)`. A normal message or metadata mutation still reads/parses the session and rewrites the complete serialized JSON document; metadata indexes accelerate projections but do not remove content write amplification. Keep external/model work outside this lock, preserve deterministic lock order when another domain lock participates, and use `patchDocumentMetadata(...)` only for fields whose invariants do not require content hydration.

Exact chat-session substring search remains title-or-complete-content `ILIKE`; never replace it with token-only full-text retrieval or an unbounded in-memory scan. User terms are literal substrings: the shared pattern builder escapes its explicit LIKE escape character plus `%` and `_` before adding the surrounding wildcards. Runtime search executes the complete query inside a short transaction with `SET LOCAL statement_timeout = '2500ms'`, so PostgreSQL cancels pathological recheck work and the pooled connection cannot retain the override. `buildTargetSessionSearchQuery(...)` is the single source of truth for the target-store query and its operational `EXPLAIN`. It isolates title/content matching into a materialized UNION of internal primary-key candidates so each branch is independently GIN-indexable, then applies recency, `messageCount`, ordering, limit, and the canonical principal/account/Vault `combineWithVisibleScope` predicate once on the outer rows. Never authorize on candidate IDs, join candidates by public `document_id`, or duplicate scope logic inside candidate branches. Search result hydration must reuse the matched authorized document payload rather than issue one follow-up document query per result. `DOCUMENT_STORE_CHAT_SEARCH_INDEXES` owns the partial title/content trigram index identities (GIN `gin_trgm_ops` on both title and content). Their partial predicate is `document_type = 'chat'` ONLY; `messageCount > 0` remains an outer query recheck. The write-heavy complete-content index disables GIN `fastupdate` so searches never inherit an unbounded pending-list scan; title retains normal fast updates. Changing an index predicate or storage policy requires a fresh index name built concurrently before its predecessor enters `RETIRED_DOCUMENT_STORE_CHAT_SEARCH_INDEXES`. `document-search-indexes.ts` converges these derived indexes after readiness under one session-scoped cross-replica advisory lock on a checked-out general-pool client, proves the segment trigram index is physically usable with a planner-forced capability `EXPLAIN`, then runs a bounded `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` over the exact shared 30-day query using one real recent owner/account/Vault scope and an internal corpus-derived substring. The exact production plan may truthfully enter through owner/Vault/document indexes before applying the segment filter, so it is operational evidence but must not be required to name the trigram index. The maintenance session temporarily raises statement timeout to 15 minutes and lock timeout to 30 seconds, resets both before release, and discards the client if reset/unlock fails. Verification emits only coarse timings, row/buffer counts, index names, and option state—never SQL, parameters, principals, query text, plans, titles, snippets, or corpus content. Runtime search failure is an explicit sanitized error, never an empty successful result.

The maintenance proof is necessary but not sufficient: Live on 2026-07-28 repeatedly canceled real session searches at the former general 10 s ceiling (`57014`) even while the general pool retained idle clients and no saturation incident existed. The immediate mitigation is the canonical literal-pattern boundary plus a 2.5 s transaction-local runtime search ceiling; the remaining mechanism is lossy trigram candidate recheck over whole-session blobs, not evidence that the pool needs more connections or that the indexes are absent. Generic DB instrumentation excludes SQL text and parameters; subsystem evidence must also exclude patterns, principals, snippets, plans, and corpus content.

## When Working Here

- **Active vNext embeddings are 384-dimensional** (`all-MiniLM-L6-v2`, generated locally per `embedding-profile.ts`), stored in `memory_vnext_claims.embedding` with an HNSW `vector_cosine_ops` index (`idx_memory_vnext_claim_embedding`) created in `schema-bootstrap.ts`. Semantic search is cosine `<=>` and depends on that ANN index plus the `embedding IS NOT NULL` + non-retired predicate; do not assume a plain sequential scan or a different dimension.
- **Legacy `memory_entries.embedding` is the retiring 1536-dim OpenAI store** with its own HNSW index heal. It is not the active retrieval path. Never conflate the two dimensions or index identities.
- **pgvector** extension is required and ensured at boot (`CREATE EXTENSION IF NOT EXISTS vector`).
- **Legacy Consolidate/Integrate timers are disabled.** Native Runtime source ingestion and the nightly vNext lifecycle are the active processing paths; do not revive timer-driven tier promotion.
- **Sleep cycle** is gated by a timer (~2 AM CT), not a cron expression.
- **Graph operations are expensive**. vNext context expansion is capped at two hops with an 80-row frontier and result cap. Don't increase without measuring.
- **`metadata` is JSONB** — used for tags, source details, deletion scheduling, and arbitrary key-value pairs. Check existing patterns before adding new keys.
- **vNext retirement is evidence-based.** Claims retire for explicit duplicate, contradiction, or supersession evidence; retrieval silence, age, or passive exposure never schedules deletion. Legacy `deletionScheduledAt` belongs only to retiring compatibility data.
- **Test with small datasets**. The memory table can have 500K+ entries. Always use LIMIT in development queries.
- Cross-reference: Retrieval is consumed by Context Assembly (see `/server/AGENTS.md` § Context Assembly). Sleep cycle is scheduled by the timer system (see `/server/AGENTS.md` § Autonomous Execution).



## Memory vNext Source-Backed Pipeline

The active migration target is source-backed, stage-driven memory. Treat this section as the governing contract for new memory ingestion and processing work.

### Core invariants

- A memory row is a compact cognitive claim or summary. Raw transcripts, raw autonomous runs, tool-output blobs, and legacy exchange records are source material, not graphable memory.
- `memory_sources` is the provenance path. New ingestion code must attach source refs with enough context to explain why the memory exists.
- `integration_stage` is processing depth, not memory ontology. Keep `layer` compatibility until all callers migrate, but do not design new behavior around short/mid/long as the semantic model.
- Stage 1 means indexed/enriched: title, summary/one-liner, topics/tags, and a validated search embedding are present before admission completes. Candidate embeddings generated for semantic dedup are reused for persistence; embedding failure aborts the retryable source admission rather than creating an unsearchable active claim.
- Stage 2 means shallow-linked/integrated. A memory may reach Stage 2 either because the StageOneSweep created/preserved shallow source refs, or because reconciliation recognizes existing source/link evidence that already satisfies the Stage 2 invariant.
- Stage 3/4 work belongs to deep integration and sleep/upkeep. Do not put expensive deep LLM or broad graph work in foreground writes or the Stage 1 sweep.

### Claim quality contract

The extraction prompt (v8) enforces a predictive-value filter: every claim must improve Agent's ability to predict people or the external world. Stable personal facts, tastes, tendencies, working patterns, and communication patterns qualify when they improve prediction. The scorer (`scoreClaimForBudget`) enforces this structurally.

**Hard rejections (prompt + scorer):**

- Deterministic Agent commands or constraints → stored as personal Rules when individual, or in the owning system when universal
- Universal product behavior or tool policy → stored in the owning system, never personal memory
- Agent/system architecture facts → recoverable from code, docs, tools
- Implementation summaries (PRs, merges, deploys, builds, row counts, task status)
- Short-lived calendar/scheduling facts
- Process status messages with no underlying external fact
- Near-restatements of the source

**Scorer penalties:**

- Deterministic Agent-command claims (e.g. "Agent should..." or "Agent must...") are hard-rejected with `rejectedReason: agent_command_restatement`
- Descriptive personal patterns (e.g. "Ray prefers..." or "Ray tends to...") remain eligible state claims
- Architecture-shaped claims (e.g. "hosted on...", "PR #N merged") are hard-rejected with `rejectedReason: architecture_restatement`
- Cause claims receive the highest type score (+30), then action (+25), then state (+10)
- State claims can recover score through entity mentions and topic richness

**What qualifies:**

- People: identity, relationships, motivations, behavior predictions
- Personal patterns: tastes, recurring choices, working style, communication style, and stable tendencies
- Organizations: dynamics, power structures, incentive alignment
- Finances: compensation ranges, funding status, deal terms
- Family: dynamics, conflict, support patterns, health trajectories
- Strategy: why decisions were made, what pressure created them, binding constraints
- Commitments: promises between people (not Agent task assignments)
- Market: industry shifts, competitor moves, pricing dynamics

**Evaluation status:** v8 deliberately broadens admission to soft personal patterns while preserving deterministic Agent-command rejection. Do not reuse v7 preference-rejection metrics as evidence for v8 behavior.

### Claim shape

- Every vNext claim carries a `title` (1-3 word Title Case label) extracted at claim creation alongside the claim sentence. The extraction prompt requests it; `normalizeClaimTitle` in `vnext-claim-extraction.ts` enforces the word cap and derives a fallback from content when the model omits it. UI surfaces (Layers list, graph nodes, tool serializations) display `title` and fall back to `content` for pre-title claims.
- Destructive reset: `POST /api/memory/vnext/claims/nuke` (body `{"confirm":"NUKE"}`) calls `nukeAllClaims()`, which deletes only the current user principal's claims via `writableScopePredicate`; source refs, entity links, and claim links cascade via FK. System principals are rejected.

### vNext module boundaries

All vNext claim logic lives in `server/memory/vnext-*` modules with zero imports from legacy `consolidation.ts` or `memory-enrichment.ts`:

| Module | Responsibility |
|---|---|
| `vnext-claim-extraction.ts` | Canonical `ClaimCandidate` type, extraction prompt (v8), chunk-level extraction, cross-chunk dedup, budget scoring/ranking, `processVnextClaimsForSource` entry point |
| `vnext-claim-storage.ts` | DB CRUD for `memory_vnext_claims`, `memory_vnext_claim_links`, `memory_vnext_source_refs`, semantic search, reinforcement, nuke, and the canonical `persistClaimCandidates()` mutation path (two-phase dedup, create, entity linking, causal linking). Phase 1: intra-batch semantic dedup merges paraphrases from the same extraction before any DB write (`CLAIM_INTRA_BATCH_DEDUP_THRESHOLD = 0.85`). Phase 2: cross-source dedup against existing DB claims reinforces near-duplicates (`CLAIM_DEDUP_SIMILARITY_THRESHOLD = 0.85`), with a title-collision fallback that dedups same-titled active claims at `CLAIM_TITLE_DEDUP_SIMILARITY_THRESHOLD = 0.55` (same-fact restatements extracted on different days drift to 0.58–0.84 similarity). All thresholds defined and exported here. `sourceMemoryId` is a nullable legacy column (no FK to `memory_entries`); canonical provenance lives in `memory_vnext_sources` (source refs). Structured lifecycle audit values are constructed once by the application and bound as explicit `jsonb`; never spread nullable fields across polymorphic PostgreSQL JSON-builder parameters. |
| `vnext-entity-resolution.ts` | Resolve entity mentions from claims to People/Project/Goal records |
| `vnext-source-poller.ts` | Queue-based extraction: poll settled sources, chunk, extract via `vnext-claim-extraction`, persist, reconcile stale claims |
| `vnext-lifecycle.ts` | Lifecycle stage transitions: confidence decay, retirement candidates, and bridge maintenance. Runs unchanged as sleep cycle Phase 1 and via manual tool trigger. Canonical claims decay confidence by 0.05 per run when unreinforced for 14+ days. Claims retire when: duplicate content hash, contradicted/superseded, low-confidence stale action (< 0.45, 30+ days), or generic low confidence (< 0.3) + stale (21+ days) + no recall. Retired claims excluded from searchClaims defaults and findClaimsBySourceOrigin but remain queryable with explicit lifecycleStage=retired filter. |
| `vnext-content-chunking.ts` | Content loading (sessions, library pages) and chunking helpers |
| `vnext-source-queue.ts` | Source queue DB operations (poll, mark processing/completed, reset stuck) |

Generic bounded title/summary/tag generation lives in neutral `server/title-summary-tags.ts` and is used directly by legitimate document consumers. The obsolete `MemoryStorage`, tier consolidation, transition, graph-walker, link-scheduling, listener, title-maintenance, and boot-diagnostic implementations are removed from ordinary runtime composition. vNext modules depend only on vNext storage and neutral embedding/summarization primitives.

### Ingestion paths

Session and Library ingestion must follow idempotent source-of-truth sync patterns:

- vNext source admission is independent of legacy mirrors. Saved sessions enqueue `session:<id>` directly, and Library create/update enqueues `library_page:<id>` directly. A failed or removed `memory_entries` mirror must never prevent vNext source registration, extraction, or claim persistence.
- The vNext poller loads complete source content from the session and Library stores, persists claims with canonical source refs, and sets `sourceMemoryId: null`.
- Legacy compatibility mirrors may still be maintained separately: sessions write/update one compact summary mirror and Library pages maintain their page-to-memory pointer. Mirror writes are not an admission boundary for vNext.
- Legacy mirror paths must attach `memory_sources`, set/maintain `integration_stage`, preserve hash-based skip behavior, and emit structured logs for create/update/skip/error/source-ref outcomes.
- Do not reintroduce raw `[Exchange]` memory writes or make full transcripts graph eligible.

### StageOneSweep and legacy reconciliation

The Stage 1 → Stage 2 worker is a bounded sweep, not per-memory timers.

Required protections:

- single-worker/run claim via processing columns,
- batch limit,
- runtime cap,
- touch-delay for recently modified rows,
- stale-processing recovery,
- compact structured logs.

When diagnosing Stage 1 backlog, distinguish two cases:

1. New Stage 1 entries awaiting shallow source-ref work.
2. Legacy Stage 1 entries that already have links/source evidence but were never reconciled into Stage 2.

Do not assume age alone should advance a memory. Advance when Stage 2 evidence exists or the sweep successfully creates/preserves it.

Every vNext claim admitted through the canonical Stage 1 mutation path must have a validated embedding before persistence completes. Candidate embeddings generated for semantic deduplication are reused for persistence; embedding failure aborts admission so an active unsearchable claim is never silently created.

Legacy active vNext claims missing embeddings are repaired through the settled-source maintenance path using a bounded, idempotent backfill under each owning principal. Retired claims are excluded, and each update rechecks both ownership and `embedding IS NULL` so retries are safe. `vnext_claim_counts` is the principal-scoped coverage check; healthy coverage is `activeMissingEmbedding=0` and `embeddingCoverage=1`.

vNext graph context is the only context retrieval path. It combines principal-scoped semantic and recent seeds, follows at most two bounded hops across visible claim links, excludes retired claims, scores lifecycle stage, claim type, confidence, reinforcement, connectivity, provenance, semantic/causal/contrastive/temporal signals, balances semantic and recent graph results, and renders within the existing persona memory token budget. Empty results stay empty; failures surface as vNEXT unavailable and never fall back to `memory_entries`.

### Observability

Memory ingestion and stage processing should be diagnosable from system logs and the Memory UI without Railway logs. Log compact events for:

- session/library sync start,
- skip reason,
- unchanged hash,
- memory create/update,
- `memoryEntryId` writeback,
- source-ref attach/preserve,
- stage advance,
- processing failure.

The Memory UI should remain minimal and Tree Hierarchy based: use section/row color or spinner state for processing, and reveal detailed status only inside expanded rows.

## Session Summary Mirrors

Human/agent sessions may create distilled memory mirror entries when a session is closed or archived. The session/history store remains the source of truth; memory mirrors are compact graphable or searchable summaries with metadata linking back to the source session. Avoid writing raw transcripts into graphable memory. One session should have at most one active summary mirror for the same mirror kind.

Expected metadata includes `mirrorKind`, `sourceOfTruth`, and `sessionId`. UI and tooling should make the mirror relationship explicit in both directions: session → memory mirror and memory mirror → source session.

## Graph Eligibility and Archive Exclusion

Raw session transcripts, archived workspace/session rows, and legacy exchange rows are excluded from default memory retrieval, graph stats, myelination, and visualization unless an explicit archive/debug mode is requested. Distilled summaries may be graph eligible. Do not treat a lower graph count as deletion without checking archive/session filters.

When adding a new memory source, decide explicitly whether it is graph eligible, search visible by default, myelination eligible, or archive-only. Store that decision in metadata rather than relying on route-level heuristics.

Autonomous chat sessions are not durable memory sources. Enforce that invariant at the canonical vNext source upsert boundary using the persisted `ChatSession.sessionType`, not labels or route-local guards. Maintenance cleanup must be bounded, idempotent, principal-aware, remove source refs before deleting claims, and preserve claims that retain any other valid source.

## Prompt Modules Used by Memory

Memory/myelination prompt templates live in Prompt Modules, not Skills. They have zero `skill_runs` by design because memory code loads them internally. Do not migrate them back to runnable Skills. Runtime prompt lookup should fail closed if a required module is missing.

| Phase | Prompt module key | Primary code path |
|---|---|---|
| Summarize/enrich | `myelination-summarize` | `server/title-summary-tags.ts` |
| Link discovery | `myelination-link` | `graph-discovery.ts`, `memory-enrichment.ts` |
| Cross-concept links | `myelination-cross-concept` | `graph-discovery.ts` |
| Mid-term merge | `myelination-mid-merge` | Retained DB Prompt Module; no runtime caller |
| Consolidation | `myelination-mid-merge-consolidate` | Retained DB Prompt Module; no runtime caller |


### Personal Rules cutover

- Preferences is retired as a tool, UI, context section, API, event family, and export domain. The string `preference` remains only where it denotes a generic product/UI setting, a People relationship-memory category, or the legacy document type read by migration.
- Personal Rules contain only explicit user-owned deterministic behavioral overrides. They do not carry confidence, reinforcement, violation, or principle-link fields.
- `legacy-rule-migration.ts` is the bounded disposition for the audited legacy Rule set. It retains the records that pass the personal-delta razor and removes the rest after their universal behavior has moved into owning system/tool/domain instructions. The v2 repair restores the two retained Rules lost by the former mirror-cleanup path only for the owner of the vNext claim created from the exact allowlisted legacy Rule source ID, then writes a durable owner-specific completion marker so later user deletion remains authoritative.
- `legacy-preference-migration.ts` promotes six hard personal overrides to Rules, converts seven soft personal patterns to vNext claims through `persistClaimCandidates`, and removes four system-owned correction records. It deletes each legacy document only after its destination mutation succeeds.
- Both migration workers restore the document owner's principal and vault before mutation, are replay-safe, and run in bounded batches from the vNext poller.
- vNext `content_hash` includes the owning principal key separated with ASCII unit separator 31. The database keeps one global unique constraint over that owner-scoped hash, preventing both same-user duplicates and cross-user collisions. The poller repairs legacy hashes in bounded batches; runtime boot never performs an unbounded table rewrite.


### Retired Beliefs subsystem

- The standalone Beliefs tool, API, context section, storage model, reflection reads, export, capture target, and confidence lifecycle are removed. Existing rows are archival-only and must not be read, migrated, or deleted by runtime retirement code.
- Probabilistic person/world knowledge belongs in vNext claims. Deliberate explanatory positions with evidence and predictions belong in Theses. Do not recreate a generic Beliefs abstraction.
- Quick-capture memory writes a filed Library source artifact so normal ingestion can decide whether it yields a vNext claim.
- Title/summary generation for legitimate document consumers remains neutral in `server/title-summary-tags.ts`; legacy memory-entry title maintenance is retired.
