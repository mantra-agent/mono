# Workflow Acceptance Wait — Implementation Plan

## Invariant

Acceptance begins only after the canonical target deployment containing the approved implementation reaches a terminal provider state. A Stage build still running, not yet discoverable, or temporarily hidden behind a provider-directed cooldown is **waiting**, not a product failure and not a consumed workflow attempt.

## Smallest coherent repair

1. Keep `waitForAcceptanceDeploymentTruth(...)` as the single readiness owner.
2. Give Stage deployment readiness a deliberate long budget (60 minutes) rather than the current 12-minute interactive assumption, and extend the Acceptance child idle monitor beyond that budget so legitimate waiting cannot be killed as an idle execution.
3. Classify only bounded transient unavailability as waitable: provider cooldown/rate limiting and absence of a deployment proven to contain the expected commit or post-implementation boundary.
4. Honor an explicit provider `retry after Ns` delay within the remaining budget; otherwise poll at the existing bounded cadence.
5. Return immediately for permanent configuration, credential, unsupported-provider, and other non-waitable failures; return only on current deployment success, current deployment terminal failure, or exhausted wait budget.
6. Keep the child Session visibly `waiting` for the entire readiness phase, restoring `streaming` afterward.
7. Document the boundary in `server/AGENTS.md` and the security/availability finding in `SECURITY.md`.

## Architecture check

- **Single Source of Truth / Canonical Mutation Path:** one readiness helper owns classification and waiting; no stage-agent prompt heuristics or parallel polling path.
- **One Discriminant Per Decision:** readiness remains `green | pending | failed | unavailable | timeout`; transient provider states stay internal until they resolve or the one budget expires.
- **Bounded Operations:** maximum wait is explicit and provider delay is capped by remaining budget; no unbounded loop.
- **Fail Loudly, Degrade Gracefully:** permanent authority/configuration failures still fail immediately; transient observation loss waits without lying about deployment truth.
- **Replayability:** evidence capture remains read-only and safe to retry; no deployment mutation is introduced.
- **Core/Mod ownership:** this changes Build workflow orchestration only. It adds no product surface, Mod contribution, install/disable lifecycle, permission, or deployment authority.

## Security gate

Affected assets are S1/S2 deployment identity and workflow evidence plus autonomous execution authority across the Platform/Railway boundary. The abuse/failure case is false certification or retry exhaustion when unavailable evidence is mistaken for product truth. Deterministic controls remain exact Environment lifecycle snapshot, source/hosting binding, expected-commit attribution, provider-directed cooldown, bounded wait, and independent auth/evidence gates. No secret, principal scope, credential flow, external mutation, or production-release authority changes.

## Verification

Run `npm run build`, then `git diff --check`, inspect status/diff, and ship one PR to `main`.
