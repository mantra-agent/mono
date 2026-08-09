# Agent Loop Boundary Cure

## Verified violations

1. `AgentExecutor.run()` has a wall-clock watchdog but no work ceiling on provider iterations. Every `shouldContinue` branch can re-enter the model loop indefinitely until the 40-minute process-local watchdog fires. This violates named budgets and makes iteration exhaustion indistinguishable from a timeout.
2. Both SDK-owned and executor-owned tool paths converge on `executeToolWithRecovery(...)`, but that boundary does not own a per-run tool-call budget. A model can continue dispatching tools until wall time expires even though Runtime already models `maxToolCalls` as a first-class resource concept.
3. A future budget stop would currently fall through `natural_stop → complete → succeeded` unless the producer emits a terminal degradation discriminant. Consumers would then persist a false clean completion.

## Smallest coherent cure

- Keep this capability in non-installable Core Agent Runtime; no Mod ownership or contribution surface changes.
- Add explicit bounded `maxIterations` and `maxToolCalls` executor options with conservative code-owned defaults and hard configuration ceilings.
- Resolve the budgets once at run initialization. Admit every actual tool execution at the existing cross-mode `executeToolWithRecovery(...)` boundary, so SDK and executor paths cannot drift.
- On exhaustion, stop before another provider dispatch or tool side effect, preserve completed work, synthesize one truthful continuation-safe terminal message, and emit one of two source-owned degradation discriminants: `iteration_budget_exhausted` or `tool_call_budget_exhausted`.
- Project the same discriminants through interactive and autonomous consumers with truthful warning copy. Do not treat budget exhaustion as cancellation, provider failure, permission failure, or clean success.
- Document the enduring executor budget contract in `server/AGENTS.md` and record the security boundary in `SECURITY.md`.

## Security gate

Affected assets are model-visible private context and tool arguments (S2/S3), tool side effects and external authority (A04/A06), run/inference/tool audit evidence (A07/A08), and availability. Credible abuse/failure: untrusted model output or prompt injection repeatedly requests continuations/tools, consuming provider spend and autonomous capacity or amplifying independently authorized side effects until a wall timeout. Deterministic owner: Core Agent Runtime admits each provider iteration and actual tool execution against code-bounded per-run counters; tool authority, principal scope, human gates, provider controls, idempotency, and Runtime capacity remain independent. No prompt grants or relaxes authority.

## Engineering-principles audit

- **Name Your Budgets:** work ceilings become explicit, logged, and terminally classified.
- **One Discriminant Per Decision:** exhaustion is computed once at the executor source and carried to consumers.
- **Canonical Mutation Path / DRY:** both tool execution modes spend budget at their existing common boundary.
- **Replayability:** completed tools remain canonical; no tool is executed after budget denial, and recovery asks a later turn to continue.
- **Fail Loudly, Degrade Gracefully:** preserve completed work and report a warning rather than timeout, false success, or generic error.
- **Least Privilege:** the budget limits execution only; it grants no tool or provider authority.

## Verification and rollback

Run `npm run build`, inspect change scope/diff, then merge to `main`. Rollback is a source-only revert; no schema, prompt-module, secret, or persisted-data migration is introduced.
