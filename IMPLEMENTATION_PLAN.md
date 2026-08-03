# Implementation plan: deterministic scratch.edit recovery

## Goal

A stale or ambiguous `scratch.edit` target may consume at most one evidence-backed retry. The system must require a successful reread of the same canonical file before that retry, then quarantine further edits to that file for the remainder of the run if the rebuilt patch still conflicts.

## Forces

- `scratch.edit` alone knows whether an exact replacement failed because the target was absent or ambiguous.
- The model may alter `old_string` after each failure, so retry identity cannot depend on complete arguments or error prose.
- Reads must remain available after a conflict; unrelated tools and edits to other files must continue.
- Chat, voice, timers, autonomous skills, SDK-owned execution, and executor fallback must obey one policy, so containment belongs in the run-owned AgentExecutor dispatch boundary rather than a route adapter or the source classifier.
- Recovery state must be bounded and run-scoped.

## Design

1. Add one discriminated `ToolFailure` envelope and one canonical scratch-operation resolver in `server/tool-operation-recovery.ts`.
2. Have the `scratch.edit` producer emit `scratch_edit_not_found` or `scratch_edit_ambiguous` with the canonical file resource key. Keep human-readable result text for the model/UI.
3. Preserve the envelope through `ToolResult`; do not parse result strings in the executor.
4. Put the recovery state machine in AgentExecutor’s run-owned dispatch boundary and preserve the source envelope through each bridge adapter:
   - serialize recovery transitions per run and canonical file so concurrent calls cannot bypass policy;
   - first source conflict → `read_required`;
   - successful `scratch.read` of the same canonical file → `retry_allowed`;
   - successful rebuilt edit → clear state;
   - second source conflict → `quarantined`;
   - edit attempted during `read_required` or `quarantined` → refuse before bridge dispatch and do not touch disk.
5. Bound retained state by run-relative TTL and a maximum entry count.

## Engineering-principle check

- **Single Source of Truth:** one source-owned failure discriminant; one execution-boundary recovery ledger.
- **Canonical Mutation Path:** containment wraps the unified tool executor, so both direct and SDK-owned tool calls cross it.
- **One Discriminant Per Decision:** policy switches on `failure.code`, never prose.
- **Encode Invariants in Structure:** the state machine makes blind retry and post-quarantine mutation unavailable.
- **Fail Loudly, Degrade Gracefully:** blocked attempts explicitly say what evidence is required; quarantine preserves unrelated work.
- **Minimum Viable Protocol:** only scratch exact-edit conflicts enter this policy; no generic retry framework or executor-wide abort is added.
- **Bounded Operations:** recovery state is TTL-pruned and size-capped.

## Scope

- `server/agent-executor.ts`
- `server/agent-timer-handler.ts`
- `server/autonomous-skill-runner.ts`
- `server/integrations/chat/routes.ts`
- `server/tool-execution.ts`
- `server/bridge-tools.ts`
- `server/tool-failure.ts`
- `server/tool-operation-recovery.ts`
- `IMPLEMENTATION_PLAN.md`

No UI, persistence schema, authorization, or generic retry framework changes.

## Verification

Run `npm run build`, then inspect the final diff and change scope. Per repository policy, add or run no tests or standalone typechecks.
