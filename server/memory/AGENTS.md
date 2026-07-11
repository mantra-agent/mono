# Memory Architecture

The memory system provides persistent, searchable, graph-linked knowledge storage across three temporal tiers. It handles ingestion, embedding, consolidation, retrieval, graph relationships, and a nightly sleep cycle for maintenance.

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

Sleep/NREM/REM must prefer stage semantics for decay, reinforcement, dream seeding, pruning, and upkeep while preserving `layer` filters for compatibility.

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
- **Content**: Distilled knowledge, patterns, preferences

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
3. **Recency** — exponential decay weighting by `lastRecalledAt`
4. **Recall frequency** — `recallCount` as a weak positive signal
5. **Source diversity** — bonus for mixing layers and source types

### Graph Neighborhood Cache
- `memory_graph_cache` stores pre-computed neighbor lists per entry
- Refreshed during myelination (sleep cycle phase)
- `server/memory/graph.ts` — `computeNeighborhood()`, `cacheNeighborhoods()`

### Tiered Context Assembly (memory.graph)

The `memory.graph` context section uses tiered context assembly instead of flat rendering. It allocates token budget from the active persona and renders memories at depth proportional to relevance.

**Pipeline:**
```
persona cognitiveOverrides.memoryGraphTokenBudget (default 4000)
  → build focus text from session context
  → semanticSeedSearch() — single pgvector cosine query, limit 80, 450ms timeout
  → parallel: getLayer("short", 5) recency seeds
  → deduplicate seeds
  → score: causal (graph walk), contrastive (contradicts/evolves), temporal (±3 days)
  → source-backed boost (entries with memory_sources rows)
  → modulateWeights() by session type + emotional state
  → allocateTiers() greedy knapsack → Signal/Detail/Full
  → renderTieredEntry() per tier
```

**Key files:**
- `server/context-builder.ts` — `resolveGraphMemory()`, `getMemoryGraphTokenBudget()`, `allocateTiers()`, `renderTieredEntry()`
- `server/memory/semantic-seed-search.ts` — `semanticSeedSearch()` unified vector retrieval
- `server/memory/associative-retrieval.ts` — `modulateWeights()`, `detectSessionType()`, `BLEND_WEIGHTS`

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

## Sleep Cycle

A nightly maintenance cycle (runs ~2 AM CT) with 5 phases:

### Phase 1: Memory Decay
- `server/memory/decay.ts` — `runMemoryDecay()`
- Applies exponential decay to `recallCount` and link `strength`
- Entries below threshold get `deletionScheduledAt`
- Already-expired entries are hard-deleted

### Phase 2: Memory Reinforcement
- `server/memory/reinforcement.ts` — `runMemoryReinforcement()`
- Boosts entries with high recent recall
- Strengthens links between co-recalled entries

### Phase 3: NREM (Structural Maintenance)
- `server/memory/nrem.ts` — `runNREM()`
- Prunes weak/orphaned links
- Deduplicates similar entries
- Fixes broken references
- Library page self-heal operations

### Phase 4: REM (Creative Synthesis)
- `server/memory/rem.ts` — `runREM()`
- Samples entries across domains
- LLM generates "dream" narratives finding cross-domain connections
- Dreams stored as long-term entries and Library pages

### Phase 5: GSI (General Semantic Index)
- `server/memory/gsi.ts` — `computeGSI()`
- Computes a global semantic health score
- Measures coverage, connectivity, freshness, diversity

### Myelination (Separate from Sleep)
- `server/memory/myelination.ts` — `runMyelination()`
- Runs periodically on its own timer
- Strengthens high-traffic graph paths
- Recomputes `memory_graph_cache` neighborhoods
- Identifies and creates missing links between related entries

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

The extraction prompt (v7) enforces a predictive-value filter: every claim must improve Agent's ability to predict the external world or people in it. The scorer (`scoreClaimForBudget`) enforces this structurally.

**Hard rejections (prompt + scorer):**

- Ray's preferences about how Agent should work → stored in preferences system
- Agent behavioral rules or constraints → stored in rules system
- Agent/system architecture facts → recoverable from code, docs, tools
- Implementation summaries (PRs, merges, deploys, builds, row counts, task status)
- Short-lived calendar/scheduling facts
- Process status messages with no underlying external fact
- Near-restatements of the source

**Scorer penalties:**

- State claims matching preference/rule patterns (e.g. "Ray prefers...", "Agent should...") are hard-rejected with `rejectedReason: preference_rule_restatement`
- Architecture-shaped claims (e.g. "hosted on...", "PR #N merged") are hard-rejected with `rejectedReason: architecture_restatement`
- Cause claims receive the highest type score (+30), then action (+25), then state (+10)
- State claims can recover score through entity mentions and topic richness

**What qualifies:**

- People: identity, relationships, motivations, behavior predictions
- Organizations: dynamics, power structures, incentive alignment
- Finances: compensation ranges, funding status, deal terms
- Family: dynamics, conflict, support patterns, health trajectories
- Strategy: why decisions were made, what pressure created them, binding constraints
- Commitments: promises between people (not Agent task assignments)
- Market: industry shifts, competitor moves, pricing dynamics

**Eval evidence (v7 prompt, 2026-07-09):** 12 samples (5 noise sources, 7 positive sources). Noise rejection: 5/5 (100%). External-fact recall: 7/7 (100%). No regression from v6's 18/18 on external facts; self-referential restatements now fully rejected.

### Claim shape

- Every vNext claim carries a `title` (1-3 word Title Case label) extracted at claim creation alongside the claim sentence. The extraction prompt requests it; `normalizeClaimTitle` in `vnext-claim-extraction.ts` enforces the word cap and derives a fallback from content when the model omits it. UI surfaces (Layers list, graph nodes, tool serializations) display `title` and fall back to `content` for pre-title claims.
- Destructive reset: `POST /api/memory/vnext/claims/nuke` (body `{"confirm":"NUKE"}`) calls `nukeAllClaims()`, which deletes only the current user principal's claims via `writableScopePredicate`; source refs, entity links, and claim links cascade via FK. System principals are rejected.

### vNext module boundaries

All vNext claim logic lives in `server/memory/vnext-*` modules with zero imports from legacy `consolidation.ts` or `memory-enrichment.ts`:

| Module | Responsibility |
|---|---|
| `vnext-claim-extraction.ts` | Canonical `ClaimCandidate` type, extraction prompt (v6), chunk-level extraction, cross-chunk dedup, budget scoring/ranking, `processVnextClaimsForSource` entry point |
| `vnext-claim-storage.ts` | DB CRUD for `memory_vnext_claims`, `memory_vnext_claim_links`, `memory_vnext_source_refs`, semantic search, reinforcement, nuke, and the canonical `persistClaimCandidates()` mutation path (two-phase dedup, create, entity linking, causal linking). Phase 1: intra-batch semantic dedup merges paraphrases from the same extraction before any DB write (`CLAIM_INTRA_BATCH_DEDUP_THRESHOLD = 0.85`). Phase 2: cross-source dedup against existing DB claims reinforces near-duplicates (`CLAIM_DEDUP_SIMILARITY_THRESHOLD = 0.85`). Both thresholds defined and exported here. `sourceMemoryId` is a nullable legacy column (no FK to `memory_entries`); canonical provenance lives in `memory_vnext_sources` (source refs) |
| `vnext-entity-resolution.ts` | Resolve entity mentions from claims to People/Project/Goal records |
| `vnext-source-poller.ts` | Queue-based extraction: poll settled sources, chunk, extract via `vnext-claim-extraction`, persist, reconcile stale claims |
| `vnext-lifecycle.ts` | Lifecycle stage transitions: confidence decay, retirement candidates. Runs during sleep cycle (after reinforcement, before NREM) and via manual tool trigger. Canonical claims decay confidence by 0.05 per run when unreinforced for 14+ days. Claims retire when: duplicate content hash, contradicted/superseded, low-confidence stale action (< 0.45, 30+ days), or generic low confidence (< 0.3) + stale (21+ days) + no recall. Retired claims excluded from searchClaims defaults and findClaimsBySourceOrigin but remain queryable with explicit lifecycleStage=retired filter. |
| `vnext-content-chunking.ts` | Content loading (sessions, library pages) and chunking helpers |
| `vnext-source-queue.ts` | Source queue DB operations (poll, mark processing/completed, reset stuck) |

`memory-enrichment.ts` re-exports `ClaimCandidate` for backward compatibility but owns only legacy enrichment: title/summary/tags generation, myelination (summarize/embed/link), and batch processing. `consolidation.ts` owns legacy memory tier transitions (short→mid→long), the Stage-1 advancement sweep, and graph enrichment.

### Ingestion paths

Session and Library ingestion must follow idempotent source-of-truth sync patterns:

- Sessions: archive/saved-session summary sync writes or updates one compact session-summary memory and writes `memoryEntryId` back to the session record.
- Library pages: page create/update sync writes or updates a compact memory entry and keeps the page-to-memory pointer current.
- Both paths must attach `memory_sources`, set/maintain `integration_stage`, preserve hash-based skip behavior, and emit structured logs for create/update/skip/error/source-ref outcomes.
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

Legacy active vNext claims missing embeddings are repaired through a bounded, idempotent backfill under each owning principal. Retired claims are excluded, and each update rechecks both ownership and `embedding IS NULL` so retries are safe.

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
| Mid-term merge | `myelination-mid-merge` | `memory-transitions.ts`, `sleep-maintenance.ts` |
| Consolidation | `myelination-mid-merge-consolidate` | `memory-transitions.ts` |

