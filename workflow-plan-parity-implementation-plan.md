# Workflow Plan Parity

## Insight

Plans and Workflows are the same execution geometry: a durable parent owns ordered child-session attempts, monitors their lifecycle, fences retries, pauses safely, recovers after process loss, and renders a Library projection. Workflow stages additionally require a structured verdict because the result selects a transition and may carry deployment/acceptance evidence.

## Smallest coherent change

1. Give each active Workflow stage attempt a durable monitor lease (`owner`, `lease id`, expiry, claimed time), matching the repaired Plan executor’s cross-replica ownership pattern at the attempt boundary where Workflow execution actually lives.
2. Centralize Workflow child monitoring behind claim/renew/release and one in-process abort controller. Pass the abort signal into the shared child monitor so Pause has the same terminate-and-confirm behavior as Plans.
3. Make Resume reconcile an orphaned active attempt before creating a retry. A terminal child without a structured verdict becomes the existing `missing_verdict` failure; a nonterminal child whose monitor lease expired is terminated and failed as interrupted. Never infer a pass from prose.
4. Add a bounded continuous recovery sweep. It discovers active attempts under a named system principal, restores the exact owner principal, and recovers only unleased/expired attempts. Live leases remain untouched.
5. Keep the necessary Workflow differences: template-defined transitions, explicit `complete_stage_attempt` verdicts, artifacts/gates, environment truth, and acceptance evidence remain Workflow-owned.

## Engineering-principles audit

- **Single source of truth:** PostgreSQL Workflow run/attempt rows remain canonical; Library and UI remain projections.
- **Encode invariants in structure:** durable attempt leases replace process-local monitor ownership assumptions.
- **Canonical mutation path:** all terminal recovery crosses `completeStageAttempt`; all monitors cross one lease wrapper.
- **Replayability:** lease claims and terminal attempt CAS make duplicate monitor/recovery calls no-ops.
- **Least privilege:** cross-account discovery uses only the named recovery principal; every mutation restores the exact Workflow owner.
- **Bounded operations:** recovery scans at most 100 active attempts and defers live leases.
- **Fail safely:** unconfirmed child termination blocks the attempt; it never starts a retry beside a possibly live child.
- **Core/Mod:** no ownership change. Workflows remain Build Mod behavior using existing contribution and access gates; this changes execution reliability only.
- **Rollback:** additive nullable columns are inert after code rollback; reverting service/boot changes restores prior monitoring semantics.

## Security gate

Assets are S2 workflow objectives/evidence and autonomous tool authority. The credible threat is duplicate or orphaned stage monitors causing concurrent child authority, stale completion, or cross-user recovery. Deterministic controls are principal-scoped queries, exact owner restoration, expiring lease CAS, terminal-attempt CAS, bounded scans, and confirmed child termination before retry. Residual risk: a child on another replica may continue briefly after its expired monitor lease during a partition, but the terminal attempt CAS prevents it from advancing after recovery wins.

## Verification

Run `npm run build`, inspect change scope and diff, then merge the PR to `main`.
