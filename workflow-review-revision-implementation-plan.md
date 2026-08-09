# Workflow Review Revision Repair

## Failed invariant

A declared review verdict is a domain transition, not an execution fault. The engine correctly transitioned `code_review changes_requested → implement`, but the target stage inferred `attemptNumber > 1` meant an execution retry and required `workflow_runs.failure_packet`. That packet is intentionally absent for domain verdicts, so child creation failed before revision work began. The same ordinal was also used for the execution-fault budget, contradicting the canonical verdict boundary.

## Smallest coherent repair

1. Derive each stage visit from the latest canonical inbound transition from a different stage.
2. Count only failed/blocked execution attempts within that visit against `maxAttemptsPerStage`; preserve the persisted stage attempt ordinal solely as identity/history.
3. Derive a revision assignment from the inbound transition's source attempt when its declared verdict is not `passed`, carrying the review/acceptance evidence and attempt-bound artifacts directly from canonical workflow state.
4. Render execution retry context and domain revision context independently. Never require or synthesize a failure packet merely because a stage has been visited before.
5. Document the invariant in `server/AGENTS.md` and update the canonical security finding.

## Engineering Principles check

- **One Discriminant Per Decision / Single Source of Truth:** verdict remains `attempt.result`; revision context derives from the persisted transition and source attempt rather than duplicating it into `failurePacket`.
- **Encode Invariants in Structure:** stage-visit and execution-fault budget are computed from transition/attempt structure, not inferred from an ordinal guard.
- **Canonical Mutation Path / Replayability:** no new write path or schema; existing completion and transition records remain authoritative and replay-safe.
- **Minimum Viable Protocol:** one derived revision context beside the existing execution retry context; no new workflow state store.
- **Violation cured before editing:** rejected the tempting patch of fabricating a failure packet for `changes_requested`, because it would collapse domain judgment into execution failure and preserve incorrect retry accounting.

## Ownership and security

This repairs existing non-installable Core workflow orchestration; it adds no capability, Mod contribution, route, permission, provider authority, or data class. Review evidence is already principal-scoped workflow state. The target stage receives only evidence from its own run's canonical source attempt and transition. Model-produced review content remains untrusted instructions and grants no tool or deployment authority.

## Verification and terminal state

Run `npm run build`, inspect change scope/diff, merge a PR to `main`, confirm Stage is building/serving the merge, then resume @workflow:wf_mslb828a_aoo8n9 so Implement receives the review cure rather than failing at child spawn.
