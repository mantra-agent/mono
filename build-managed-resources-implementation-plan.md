# Build-managed resources implementation plan

## Scope

Activate the three automation resources declared by the approved Build Mod specification without changing permissions, credentials, provider access, or Live:

- `build.timer.reliability-sentinel-30m` → user Timer `build-reliability-sentinel-30m` → Skill `sentry`
- `build.timer.security-sentinel-weekly` → user Timer `build-security-sentinel-weekly` → Skill `guard`
- `build.timer.post-acceptance-regression` → user Timer `post-build-regression` → Skill `regression`

The existing Timer row is the durable execution/history identity. `mod_installation_resources` records which row the Build installation owns; it does not copy Timer definitions or run history.

## Design

1. Extend the code-owned Build manifest with three validated timer-template contributions and keep their definitions in one Build-managed Timer catalog.
2. At the canonical `ModLifecycleService` transaction, reconcile each contribution by exact managed key first, then deterministic legacy identity (the approved historical names), adopting the earliest matching Timer rather than creating a duplicate. Reconcile the adopted row in place, disable any additional exact legacy duplicates, and upsert the installation-resource ledger row with a SHA-256 definition hash.
3. Build disable sets the exact ledger-owned Timer rows `enabled=false` and the ledger rows `disabled` in the same lifecycle transaction. Reinstall/install replay reuses the same installation and Timer IDs, reapplies the code-owned definition, sets them enabled, and returns the ledger to `active`. Timer and Skill run history remain attached to the unchanged Timer IDs.
4. A passed `build-v1` acceptance attempt inserts one deterministic pending `responsibility_runs` row for the ledger-owned Post-acceptance Regression Timer inside the same transaction that claims the attempt complete. If Build is disabled, admission is skipped. If Build is active but its managed consumer is missing or inconsistent, acceptance fails closed and remains active.
5. The existing Timer scheduler claims pending accepted-deployment runs with guarded PostgreSQL transitions, restores the Timer owner principal, executes the ordinary Regression Skill, and reclaims only stale running dispatches. Build disable prevents pending dispatch because both Timer enabled state and the active installation-resource ledger are checked.

## Engineering-principle audit

- **Single source of truth:** Timer definitions are code-owned; Timer rows own execution/history; the installation-resource ledger owns Mod attachment; Issue rows remain Regression outcomes.
- **Canonical mutation path:** Mod lifecycle owns install/disable/reinstall, Timer storage owns Timer mutations, workflow acceptance owns the accepted-deployment enqueue, and Timer scheduler owns execution.
- **Replayability:** account+Mod advisory locking, stable contribution IDs, deterministic legacy adoption, stable Timer IDs, attempt completion CAS, deterministic account + accepted provider-deployment run IDs, and guarded pending/stale claims.
- **Least privilege:** installation does not write permissions, provider credentials, connector state, or administrator state. The Timer owner principal is restored at execution and ordinary tool authority remains independently enforced.
- **No process-local correctness:** acceptance writes the durable Timer run in its transaction; process-local events/hooks are not used.

## Security gate

Affected assets: user/account identity, Mod installation state, autonomous Timer/Skill authority, Issue state, Workflow acceptance evidence, and execution audit history. Credible threats are cross-account adoption, duplicate autonomous execution, Build-disable bypass, stale-worker replay, and installation being mistaken for permission/provider authority. Controls are exact owner/account predicates, canonical ledger joins, active-installation plus enabled-Timer dispatch checks, deterministic identity and guarded claims, principal restoration, and unchanged downstream permission/provider gates. Residual risk is bounded to deployed database/runtime acceptance; the production build cannot exercise Stage concurrency or natural schedule delivery.

## Verification

Run only `npm run build`, review change scope and diff, merge the scoped PR to `main`, and do not touch or publish `live`.
