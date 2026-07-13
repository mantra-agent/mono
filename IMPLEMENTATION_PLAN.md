# Implementation plan: meeting addressed-turn fallback

## Goal

Every persisted meeting utterance crosses exactly one addressing decision boundary. The result uses one discriminant: `explicit`, `classified`, `fallback`, or `ignored`, and always includes `shouldRespond`, `reason`, and decision latency. Explicit Mantra invocation remains deterministic. A failed classifier cannot silently discard an ordinary conversational question, while conservative mode still prevents unsolicited interjections.

## Design

1. Replace the current `addressed | not_addressed | uncertain` intermediate result with one final `MeetingAddressDecision` contract. Only the addressing module decides whether to respond.
2. Resolve deterministic cases before inference:
   - explicit supported Mantra invocation => `explicit`, respond;
   - clear address to another participant => `ignored`;
   - direct reply by the same speaker to a recent Agent question => `classified`, respond without model inference.
3. Keep the contextual classifier bounded at 1.5 seconds. Successful classifications become `classified` when they produce a confident response and `ignored` otherwise.
4. On timeout, provider error, or invalid output, compute one deterministic fallback from:
   - question form;
   - continuity with the speaker in the recent Agent exchange;
   - recency and interrogative form of recent Agent speech;
   - meeting participation behavior.
   The current supported behavior is conservative/on-address. In this mode, fallback responds only to an ordinary question when the speaker is continuing a recent exchange with Agent. It never responds to standalone participant questions, statements, or questions clearly addressed to another participant.
5. Emit one structured decision log at the canonical ingestion boundary with outcome, response bit, reason, latency, confidence, and classifier failure kind. Emit a warning from the classifier boundary when fallback was required, without transcript content.
6. Keep the canonical persistence, replay claim, and executor paths unchanged.

## Engineering-principle audit

- One Discriminant Per Decision: one final outcome describes every utterance; `shouldRespond` is derived at the same source.
- Canonical Mutation Path: only `inferAddressedMeetingTurn` decides participation; routes consume the final contract.
- Encode Invariants in Structure: no `uncertain` state can leak to the caller and silently become non-response.
- Fail Loudly, Degrade Gracefully: timeout/error maps to an explicit deterministic fallback plus structured warning.
- Minimum Viable Protocol: no new storage, route, prompt stack, or unsolicited participation mode.
- Name Your Budgets: classifier and total decision latency are measured and emitted.
- Privacy: telemetry contains IDs and decision metadata, never transcript text.

## Verification

Run `npm run build`, code change-scope analysis, inspect git diff/status, then commit, push, create a PR to `main`, and merge.
