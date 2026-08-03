# Bounded Agent Provider Context — Implementation Design

## Invariant

The durable transcript and indexed-content archive preserve exact tool evidence. The provider request is a disposable projection: a current tool result remains exact through the first successful post-tool inference; later requests receive a typed indexed receipt for oversized historical results. Assistant/tool protocol pairs remain structurally intact.

## Smallest coherent change

1. Extend the canonical tool-output archive helper so oversized errors and denied results are archived exactly as successes are; keep replay-safe `operationKey` reuse and principal-scoped indexed storage.
2. Make `projectImmediateToolResult` archive oversized success/error evidence but return the exact result for the first provider inference.
3. Re-enable `projectWorkingSet` as the single historical provider projection boundary. Clone messages, identify completed cycles as tool results before the latest assistant message, and replace only oversized historical tool-result content with typed indexed receipts. Never mutate durable `messages`.
4. Add a hard cumulative projection budget. If receipt replacement is insufficient, compact oldest completed assistant/tool cycle spans with the existing deterministic continuation-capsule machinery before the model call; preserve recent cycles and protocol pairing.
5. Make `working_set_refresh` continuation conditional on measured projected shrinkage rather than raw current-cycle size alone.
6. Update `server/AGENTS.md` so the server contract states the new exact-once/archive/receipt invariant.
7. Keep SDK-consumed result IDs as a one-request ledger: snapshot before projection, clear only the IDs included in a successful provider request, and retain them across provider retries.

## Engineering-principle audit

- **Single source of truth / canonical mutation path:** exact evidence remains in the durable transcript plus existing `indexed_content` archive; provider projection lives only in `projectWorkingSet` at the executor model-request boundary.
- **No new parallel subsystem:** reuse `tool-output-artifacts.ts`, `content-indexer.ts`, context budgets, and continuation capsules. No table, queue, or per-tool policy framework.
- **Replayability:** archive writes retain the existing run/tool-call operation key; repeated projection reuses the same reference.
- **Protocol safety:** transformations operate on whole message/block structures and completed cycle spans, never arbitrary message deletion or broken tool pairs.
- **Multi-user ownership:** archive access remains behind existing principal-scoped indexed-content helpers.
- **Fail loudly, degrade gracefully:** archive failure leaves exact content in the provider projection and emits existing errors; it never fabricates a receipt whose evidence is unavailable.
- **Bounded operations:** projection is one linear scan plus bounded archival calls only for oversized historical/current results; cumulative request size is checked against the existing operating budget.

## Primary risk

The dangerous failure mode is replacing evidence before the model has consumed it. The structural guard is temporal, not heuristic: only tool results before the latest assistant message are historical and eligible for receipt replacement. Results after the latest assistant remain exact.
