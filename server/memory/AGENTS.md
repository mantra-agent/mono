# Memory Architecture

The memory subsystem is in staged retirement. vNext claims are the active semantic graph and the nightly sleep substrate. Legacy `memory_entries` tiers remain as compatibility/archive data while their readers migrate; automatic legacy propagation and maintenance launchers are disabled.

## Core Tables

| Table | Purpose | Key Columns |
|---|---|---|
| `memory_entries` | All memory content | `id`, `content`, `layer`, `source`, `embedding` (pgvector 1536d), `metadata` (JSONB), `recallCount`, `lastRecalledAt`, `deletionScheduledAt` |
| `memory_links` | Graph edges between entries | `fromId`, `toId`, `relationship`, `strength` (0–1), `metadata` |
| `memory_entity_links` | Cross-domain associations | `memoryEntryId`, `entityType`, `entityId` |
| `memory_observations` | Metacognitive observations | `type` (pattern/gap/change/connection/opportunity), `content` |
| `memory_graph_cache` | Neighborhood pre-computation | `entryId`, `neighbors` (JSONB), `computedAt` |
| `memory_files` | Named knowledge files | `fileName`, `content` (e.g., PRINCIPLES.md, RELATIONSHIPS.md) |

## Processing State Contract

Memory processing state is stored directly on `memory_entries`, not in a side table. The lifecycle stage and the processing claim are both per-entry invariants, so keeping them on the entry prevents split-brain state between the row being advanced and a separate coordinator record.

Columns:

| Column | Meaning |
|---|---|
| `processing_status` | One of `idle`, `processing`, or `error`. Existing rows default to `idle`. |
| `processing_run_id` | Worker/run claim token while `processing_status='processing'`. Cleared on success or error. |
| `processing_started_at` | Time the active claim began. Cleared on success or error. |
| `processing_error` | Last bounded error message when status is `error`; null otherwise. |
| `processing_updated_at` | Last state transition time, used with stale-processing TTL recovery. |

Metadata may keep historical stage-sweep details for audit/display, but it is not the concurrency or API contract. Sweep code must claim, complete, fail, and recover stale work using these columns.

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

## Three-Tier Architecture

### Short-Term Memory
- **Source**: Chat messages, tool results, observations
- **Lifetime**: Hours to days
- **Ingestion**: `ingestShortTermMemory()` in `server/memory/ingestion.ts`
- **Content**: Raw exchange data with session context

### Mid-Term Memory
- **Source**: Consolidated from short-term clusters
- **Lifetime**: Days to weeks
- **Promotion**: `consolidateShortTerm()` in `server/memory/consolidation.ts` groups by topic similarity, merges clusters into summaries
- **Content**: Synthesized summaries with source links preserved

### Long-Term Memory
- **Source**: Integrated from mid-term when count threshold met
- **Lifetime**: Permanent (subject to decay)
- **Promotion**: `integrateMidToLong()` in `server/memory/integration.ts`
- **Content**: Distilled knowledge, patterns, and tendencies

## Ingestion Pipeline

```
Raw content → ingestShortTermMemory()
  → generateEmbedding() (OpenAI text-embedding-3-small, 1536d)
  → INSERT into memory_entries (layer='short', source tagged)
  → linkToRelated() — find top-k similar entries, create memory_links
```

Key files:
- `server/memory/ingestion.ts` — `ingestShortTermMemory()`, `ingestMemoryEntry()`
- `server/memory/embeddings.ts` — `generateEmbedding()`, `cosineSimilarity()`
- `server/memory/storage.ts` — All CRUD operations on memory tables

## Consolidation (Short → Mid)

Runs on a 30-minute timer. Groups short-term entries by semantic similarity using embedding clusters.

- `server/memory/consolidation.ts` — `consolidateShortTerm()`
- Clusters entries with cosine similarity above threshold
- Generates summary via LLM for each cluster
- Creates mid-term entry linked to source short-term entries
- Source entries get `deletionScheduledAt` set

## Integration (Mid → Long)

Runs when mid-term count exceeds threshold (or forced).

- `server/memory/integration.ts` — `integrateMidToLong()`
- Synthesizes related mid-term entries into durable long-term knowledge
- Preserves graph links through promotion

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

### Graph Neighborhood Cache
- `memory_graph_cache` stores pre-computed neighbor lists per entry
- Refreshed during myelination (sleep cycle phase)
- `server/memory/graph.ts` — `computeNeighborhood()`, `cacheNeighborhoods()`

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

Entries are linked via `memory_links` with typed relationships and strength scores.

- `server/memory/graph.ts` — `createLink()`, `pruneWeakLinks()`, `myelinate()`
- Link types: `related`, `supports`, `contradicts`, `supersedes`, `derived_from`
- Strength decays over time if not reinforced
- Myelination strengthens frequently-co-recalled links

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

The cycle report goes to the journal (`appendJournalEntry`) and `sleep:cycle_complete` — it is not written to `memory_entries`. The sleep skill (v5) files the dream and a sleep report to the Library.

Legacy sleep phases (entry decay, reinforcement, NREM over `memory_entries`, budget enforcement, belief pass, targeted forgetting) are removed. `sleep-maintenance.ts` is deleted. Consolidate/Integrate timers are durably disabled, their skill rows are deprecated for rollback visibility, manual legacy maintenance routes fail closed, and the in-process threshold/timed-promotion loops are removed.

## Entity Links

Cross-domain associations connecting memories to people, goals, projects, etc.

- `server/memory/entity-links.ts` — `linkEntity()`, `getEntityLinks()`
- `entityType`: person, project, goal, skill, decision, etc.
- Enables queries like "all memories about person X"

## Memory Files

Named markdown files for durable reference knowledge:

- `server/memory/files.ts` — `readFile()`, `writeFile()`
- Examples: `PRINCIPLES.md`, `RELATIONSHIPS.md`, `VOICE.md`
- These are separate from memory_entries — documents, not graph nodes

## Workspace Document Extraction

`DocumentStorage` is the compatibility boundary for workspace documents while legacy memory retires. PostgreSQL `document_store_cutover_state` is the sole authority for migration state; deployment variables must never control storage ownership. Before readiness, startup installs the atomic compatibility mirror and reconciles the full workspace projection. Independent activation occurs only when PostgreSQL contains an explicit activation request created after the variable-free binary is fully deployed; the next boot performs the one-way transition. The server must not register document consumers or accept traffic until this barrier completes. Missing state, mismatches, or target errors fail startup visibly; never add a silent legacy read fallback.

After independent activation, `document_store_documents` is the only read/write authority. The persisted epoch removes the forward mirror and installs database guards rejecting any future `memory_entries(layer='workspace')` mutation. Archived workspace rows remain untouched until a separately approved retention deletion. Do not add legacy workspace fallbacks or bypass writes. Small indexed metadata mutations use `patchDocumentMetadata(...)` so they follow the active write authority without requiring a full document read; callers must remain principal-scoped and must not use this path to bypass content invariants.

## When Working Here

- **Embeddings are 1536-dimensional** (OpenAI text-embedding-3-small). All vector operations use this dimension.
- **pgvector** extension required. Index type is IVFFlat on `memory_entries.embedding`.
- **Consolidation timer** runs every 30 minutes. Don't assume entries consolidate immediately.
- **Sleep cycle** is gated by a timer (~2 AM CT), not a cron expression.
- **Graph operations are expensive**. Neighborhood expansion has a depth limit (default 2). Don't increase without measuring.
- **`metadata` is JSONB** — used for tags, source details, deletion scheduling, and arbitrary key-value pairs. Check existing patterns before adding new keys.
- **Deletion is soft then hard**. Setting `deletionScheduledAt` marks for future cleanup. Hard deletion happens during sleep decay phase.
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

`memory-enrichment.ts` re-exports `ClaimCandidate` and preserves `generateTitleSummaryTags` for summarization call sites, but legacy myelination entry points are fail-closed archival compatibility only. `consolidation.ts` preserves legacy status/types for rollback visibility, but short→mid, mid→long, Stage-1 advancement, and graph enrichment runtime entry points are fail-closed and must not mutate `memory_entries`.

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
| Summarize/enrich | `myelination-summarize` | `memory-enrichment.ts` |
| Link discovery | `myelination-link` | `graph-discovery.ts`, `memory-enrichment.ts` |
| Cross-concept links | `myelination-cross-concept` | `graph-discovery.ts` |
| Mid-term merge | `myelination-mid-merge` | `memory-transitions.ts` |
| Consolidation | `myelination-mid-merge-consolidate` | `memory-transitions.ts` |


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
- Generic long-title repair lives in `long-title-maintenance.ts`; it must not be coupled to a cognitive domain.
