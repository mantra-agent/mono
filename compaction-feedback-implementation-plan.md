# Compaction Feedback Implementation Plan

## Target

Expose active between-turn compaction in the Session Window as one reconnect-safe inline activity row using the existing Thinking timeline language. The durable `compaction_operations` row remains the source of truth.

## Existing flow traced

- Live cognition and tool activity is represented as `ExecutionStep` rows in `StreamingContent`, reduced only on the server by `streaming-reducers.ts`, held by `SessionManager`, and delivered as `session.snapshot` plus `session.delta`.
- The client stores snapshots by session ID, resubscribes on reconnect/focus/visibility, and renders timeline rows through `SegmentStream` → `ExecutionTimeline` in every shared Session Window surface.
- Terminal assistant chronology is persisted in the streaming assistant draft as `systemSteps` plus `segmentChronology`, then reconstructed by `segmentsFromSavedMessage`.
- Durable compaction ownership is already encoded in principal-scoped `compaction_operations`. Operation IDs are stable across joins and reclaim attempts.

## Design

1. Add one public activity name, `session_compaction`, to the existing system-step catalog. Its stable step identity derives from the durable compaction operation ID.
2. Let `runBetweenTurnCompaction` emit lifecycle updates only after durable claim/join establishes the operation ID. `active` is emitted at claim/join. `done` is emitted for committed or harmlessly superseded work. `error` is emitted for archive or lifecycle failure.
3. In the chat route, project those updates through `SessionManager.applyEvent({ type: "system_step" })`. Record the terminal row in the existing pre-executor `systemSteps`/chronology so failure remains truthful after live-to-persisted handoff. Successful completion is hidden because the persisted compaction marker becomes the visible terminal artifact.
4. On every authenticated `session.subscribe`, query the principal-scoped active compaction operation and overlay the same stable system step into the outgoing snapshot. This reconstructs active feedback after socket reconnect or process restart without creating another operation or indicator.
5. Render active `session_compaction` with the existing Active Thinking spacing, typography, pulse, wave text, and timer. Hide `done`; render `error` with the existing system-step error treatment.

## Engineering-principle audit

- **Single Source of Truth:** PostgreSQL `compaction_operations` owns lifecycle. Streaming and persisted chronology are projections.
- **Canonical Mutation Path:** No client-created activity and no second widget store. All live updates cross `SessionManager` system steps.
- **Replayable / race-safe:** Stable operation-derived step IDs make claim, join, reconnect, and duplicate terminal updates idempotent in the reducer.
- **Assume No Starting Point:** Subscription hydration derives active state from PostgreSQL when in-memory runtime state is absent.
- **Least privilege:** Hydration occurs only after principal-scoped session visibility succeeds, and the operation query combines owner and account identity.
- **Data minimization:** The client receives only the operation ID-backed activity state and public copy. Archive references, snapshot hashes, model calls, and failure internals remain server-side.
- **Minimum Viable Protocol:** Reuse `system_step`, `StreamingContent`, existing subscription snapshots, and existing timeline rendering. No new widget, endpoint, or client state store.

## Security gate

Assets: private S2 session history and compaction lifecycle. Boundaries: authenticated `/ws/events` session subscription and PostgreSQL ownership scope. Abuse case: a caller subscribes to another user's session or operation ID and learns private maintenance state. Deterministic control: existing principal-scoped session lookup followed by owner/account-scoped compaction lookup. Residual risk is low and unchanged; the projection exposes no archive, summary, model, or internal failure detail.

## Verification

Run the only required automated gate, `npm run build`. Review git diff/status and change-scope evidence. Merge one PR to `main`.
