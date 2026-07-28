# Session Ledger Discovery — Implementation Plan

## Target and done state

Target `Mantra / Web / stage` (Platform Environment 11), repository `mantra-agent/mono`, branch `feat/session-ledger-discovery`. Done means canonical session writes atomically maintain a bounded rebuildable search projection, ordinary `session.search` reads that projection with ownership/Vault scope inherited from the canonical document, incomplete rollout may fall back safely to the legacy blob query, routine Autonomy reconciliation follows exact execution-session provenance, `npm run build` passes, and the PR is merged to `main`.

## Design

1. Add `session_search_projection` (one derived state row per canonical chat document) and `session_search_segments` (bounded searchable rows keyed by canonical document + deterministic segment key). The canonical `document_store_documents` row remains truth; both relations use `ON DELETE CASCADE` and expose no independent product mutation path.
2. Generate segments deterministically from title, session outcome/summary, agenda items and resolutions, bounded message content, and redacted/bounded tool arguments/results. Cap segment count and bytes per segment, retain newest message/tool evidence when the session exceeds the budget, and record eligible/projected/truncated counts in projection state.
3. Make `writeConv` the atomic replacement boundary. If no ambient transaction exists, create one; otherwise reuse the caller transaction. Upsert the canonical document, then replace projection state/segments in the same transaction. Keep session-tree compatibility behavior unchanged. Repair the one raw chat recovery update to cross the same projection writer.
4. Search narrow segment text through a versioned `pg_trgm` GIN index, join canonical document metadata for principal/account/Vault visibility, recency, status, title, and ordering, and return the matched bounded segment as the snippet without loading/parsing whole session JSON. A scoped coverage check permits legacy fallback only while recent eligible documents are unprojected/stale; an environment switch can force the legacy read for rapid rollback.
5. Add post-ready, cross-replica-locked schema/index convergence plus bounded replay-safe backfill/rebuild of missing or stale projections. Each rebuilt document is row-locked and projected in a short transaction; the worker yields between batches. Diagnostics report search source, projection coverage, candidate/match timing, result count, and projection truncation counts without corpus text or identity.
6. Make Autonomy provenance-first through a guarded built-in Skill migration and checked-in default: inspect timer/skill/plan/workflow run records, follow their exact session IDs with `session.get`/`get_messages`, and use `session.search` only for historical discovery or missing provenance. Ensure Plan summaries expose canonical child session references; timers, skill runs, and workflow details already return exact session IDs.

## Engineering Principles audit

- **Single source / canonical mutation:** projection rows are derived only from canonical documents and have no independent API. The initial temptation to copy owner/account/Vault columns into the projection was rejected; reads join canonical metadata so authorization cannot drift.
- **Bounded operations:** segment sizes/counts, result count, backfill batch size, retries, lock/statement budgets, and yielding are named. Whole blobs leave the normal read path.
- **Replayability and concurrency:** deterministic keys plus transactional delete/insert replacement make replay identical; row/advisory locks serialize normal writes and rebuilds; FK cascade owns deletion consistency.
- **Migration and rollback:** additive tables first, dual-write immediately, bounded backfill, coverage-gated fallback, and an environment read switch preserve rollback without rewriting canonical storage.
- **Security:** assets A01/A02/A03/A08 and boundaries F02/F06/B03/B06 are affected. Credible threats are cross-owner search, projection divergence, secret duplication in tool payloads, and backfill resource exhaustion. Controls are canonical scope joins, atomic replacement, secret redaction, strict payload budgets, short transactions, and content-free diagnostics. Residual runtime acceptance is query-plan/latency/coverage evidence on Stage; build artifacts cannot prove it.

## Change scope

Expected code scope: shared memory schema, document schema bootstrap, session projection/search modules, canonical chat persistence/deletion/recovery, post-ready index/backfill maintenance, Autonomy Skill definition/migration, Plan summary output, server architecture/security documentation, and this design record. No client/UI change and no external API contract dependency.
