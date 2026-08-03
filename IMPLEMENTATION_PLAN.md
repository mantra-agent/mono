# Implementation plan: cure deterministic scratch.edit recovery

## Goal

A stale or ambiguous `scratch.edit` may consume at most one evidence-backed retry, then the run must stop replanning that conflict. Producer classification, resource identity, and executor policy must each have one owner.

## Engineering-principles audit

The merged containment established the right boundary, but review found four violations:

1. **Single Source of Truth / DRY:** `bridge-tools.ts` and `tool-operation-recovery.ts` independently resolved scratch paths and constructed resource keys. Alias or symlink behavior could split one file into two ledgers.
2. **One Discriminant Per Decision:** structured `failure` existed at tool dispatch, then the executor flattened outcomes to text and reconstructed repeated-failure identity from error strings and mutable arguments.
3. **Bounded execution / Fail Loudly:** quarantine blocked disk access but returned another ordinary tool error, so the model could continue replanning until a generic breaker fired.
4. **Interfaces Before Implementation / Explicit Over Implicit:** the autonomous executor narrowed the result type, returned extra fields, and erased the mismatch with `as any`.

## Cure

- Extract canonical scratch path/resource identity helpers and reuse them in both the producer and recovery ledger.
- Preserve `ToolFailure` on recorded tool outcomes and use its stable `resourceKey + code` as the failure signature.
- Treat `scratch_edit_quarantined` as an immediate deterministic circuit-breaker outcome through the existing run termination contract.
- Replace the autonomous `as any` cast with the canonical `ToolExecutorResult` interface.
- Keep `scratch.edit` strict and keep recovery policy in `AgentExecutor`; do not add fallback mutation paths.

## Impact and verification

Affected boundary: scratch read/edit producer, run-scoped recovery state machine, executor result recording/circuit breaker, SDK event propagation, and autonomous adapter typing. No schema, ownership, UI, or external API changes.

Verification: production build only (`npm run build`), then diff/status review and merge to `main`.
