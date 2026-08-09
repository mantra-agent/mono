# Workflow Context Boundary Repair

## Failed invariant

A Build workflow linked directly to a Platform Environment can currently persist with `lifecycleSnapshot = null`. Environment identity is present, but the Environment-owned acceptance target, authentication mode, evidence policy, source commit, and hosting binding are absent. Acceptance then guesses `/workflows` and `authMode=none`, so the workflow can test the wrong route and wrong authority boundary.

## Smallest coherent repair

- Keep Platform Environment context artifacts as the sole product/design governing context; do not add repository exemplars or deprecated context sources.
- Make the enabled Environment Build Lifecycle the canonical acceptance-target resolver for every `build-v1` run linked to an Environment, including ordinary `workflows.create_run` calls.
- Before persisting a Build run without an explicit lifecycle snapshot, resolve and snapshot the linked Environment's current lifecycle configuration through the existing principal-scoped Platform lifecycle service. Fail closed before creating the workflow page/run if the Environment lacks an enabled lifecycle.
- Reuse the same public snapshot resolver in `startEnvironmentBuildWorkflow`; do not duplicate acceptance target, source commit, binding, or gate derivation.
- Preserve an explicitly supplied lifecycle snapshot for replay/import callers.
- Domain-verdict routing is already repaired on current `main` by PR 2171; do not duplicate it.

## Ownership and security

This changes no product/Mod ownership: Build Mod remains the owner of Build workflow orchestration; Platform Environment and Build Lifecycle remain the source of target/binding authority. Affected assets are workflow objectives/evidence (S2), Platform and deployment identities (S1/S2), connector-backed acceptance auth (S3 boundary), and autonomous browser/tool authority. Credible threat: a model-created run supplies an Environment ID but silently omits its lifecycle, causing acceptance against a fallback route or unauthenticated surface. Deterministic control: principal-scoped lifecycle lookup plus an immutable run snapshot before persistence; no prompt or caller-provided target grants authority.

## Engineering-principles audit

- **Single Source of Truth:** Environment Build Lifecycle owns acceptance configuration; workflow run stores its immutable execution snapshot.
- **Canonical Mutation Path:** `createWorkflowRun` becomes the shared persistence gate for all Build run producers.
- **Encode Invariants in Structure:** an Environment-linked Build run cannot be persisted without a lifecycle snapshot.
- **Explicit Over Implicit:** fallback `/workflows` remains only for explicitly snapshot-configured targets that omit a route, not for missing lifecycle state.
- **Every Operation is Replayable:** caller-supplied snapshots remain unchanged; automatic resolution occurs once before insert.
- **Least Privilege:** existing Platform visibility and Library/context-artifact authorization remain unchanged.

## Verification and rollback

Run `npm run build`, inspect diff/status, then merge a PR to `main`. Rollback is a server-only revert; no schema migration or stored secret changes.
