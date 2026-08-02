# Build deployment Inbox implementation plan

## Target and terminal state

- Target: Mantra / Web / stage, Platform Environment 11, `mantra-agent/mono` branch `main`, Railway stage host `https://mono-stage.up.railway.app/`.
- Work branch: `feat/build-deployment-home`.
- Verification: `npm run build`; merge one coherent PR to `main`; never touch `live`.

## User-backward contract

When Build is active, each canonical Railway `SUCCESS` deployment observed through a visible Platform Environment binding appears once in Home Inbox with Platform / Product / Environment identity, success, commit SHA when Railway supplies it, deployment time, and an action that opens that Environment. Home reads only PostgreSQL. Dismissal and Build disable preserve durable provider evidence and projection history.

## Smallest coherent design

1. Add account-owned `platform_deployment_observations` and `build_deployment_home_projections` tables. The database unique key `(account_id, platform_environment_id, provider, provider_deployment_id)` makes observation replay safe; projection uniqueness by observation makes Home exactly once. Projection dismissal is independent from immutable provider evidence.
2. Add one canonical Build-access resolver shared by observation, projection, and Home. It derives authority from the rollout switch, registered compatible Build Mod, active entitlement, and active installation. Persistence takes the existing account+Build lifecycle lock and rechecks access after provider I/O, so disable and observation serialize without holding a transaction across Railway.
3. Add one bounded Build-owned post-ready observer. A named system principal discovers only bounded active Build owners; it restores each exact user principal, revalidates Build and Platform visibility, calls the existing Railway deployment-list boundary outside transactions, and records only allowlisted canonical `SUCCESS` fields. Database uniqueness owns cross-replica convergence; a process-local overlap guard only reduces waste.
4. Declare the collector as a Build `home.inbox` widget contribution and register its collector key. Home assembly checks canonical Build access, then reads the durable undismissed projection only; it never calls Railway. The existing Home completion control dismisses the projection through the lifecycle-locked mutation boundary.
5. Inspect the merged Build slice against the approved acceptance criteria. Keep any remaining Live/Stage-only runtime evidence explicit rather than claiming it from the production build.

## Engineering-principle audit and cures before editing

- **Single source / canonical mutation:** provider evidence is persisted once in the observation table; Home is a database projection, never a provider fetch. One Build-access resolver replaces route-local lifecycle inference.
- **Encode invariants structurally:** unique indexes encode deployment and projection idempotency; a nullable dismissal timestamp encodes Inbox lifecycle without rewriting provider evidence.
- **Replayability / races:** cross-replica pollers may observe the same deployment; conflict-safe inserts converge. Provider calls occur outside transactions; the short write takes the same lifecycle lock as disable and rechecks active Build.
- **Multi-user ownership:** discovery is system-only and content-minimal; every account mutation restores the exact user principal and uses owner/account predicates. Platform visibility is revalidated before credential use and persistence.
- **Bounded work:** bounded owner/environment candidates and deployment page size; one process-local overlap guard reduces duplicate provider work while database uniqueness owns correctness.
- **Fail loudly / degrade gracefully:** collector failures are bounded per environment and logged without credentials or provider payloads; Home continues from existing durable state.
- **Disable semantics:** producer, dismissal mutation, and consumer recheck active Build; disable removes collection/projection without deleting evidence or dismissal state.
- **Least privilege:** installation grants no permissions or credentials; existing provider credential custody and Platform visibility remain independent gates.
- **Rollback:** `MOD_PLATFORM_ENABLED=false` stops collection/composition; reverting source leaves additive inert tables and evidence intact.

## Security gate

Assets: A01 user/account/Platform identity, A03 Mod/deployment/projection state, A07 audit evidence, A08 provider/background capacity; boundaries F04/F05/F06 with S2 provider metadata. Abuse cases: cross-account provider credential use, one deployment projected into another account, duplicate Inbox amplification, disable bypass, malformed provider payload persistence, and unbounded polling. Controls: exact Principal restoration, scoped Platform/Mod revalidation, allowlisted bounded provider fields, bounded queries, unique database identities, lifecycle-lock serialization, no credential logging, and default deny when Build is inactive. Residual risk: build verification cannot prove Railway Stage payloads or multi-replica polling; Stage deployment and natural observation acceptance remain required without touching Live.
