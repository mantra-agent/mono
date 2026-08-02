# Regression simplification implementation plan

## User outcome
After each genuinely new deployed build, run the existing Regression Skill once. The Skill pages through every unresolved Issue, inspects each with existing diagnostics and automation, and classifies it exactly once as still open, clearly resolved, or blocked on testing. Only clearly resolved Issues are mutated to `resolved`.

## Smallest coherent change
1. Retire the Regression runtime domain: model-facing tool, run/contract/result models and services, scenario browser, dispatch/admission loops, Issue contract/history API, Workflow/Publish coupling, and deployed tables.
2. Extend the existing `issues` tool with paginated `list` and bounded evidence-only `resolve`; preserve `get` and ordinary Issue storage as the source of truth.
3. Rewrite the built-in Regression Skill v2.0 to use those Issue actions and ordinary diagnostic tools. No Plans, contracts, product definitions, result ledger, deployment snapshot, or bespoke browser DSL.
4. Add one managed user Skill Timer with `fireOnNextBuild`; generalize the existing boot-trigger evaluation to execute any timer carrying `fireOnNextBoot` or `fireOnNextBuild`. Keep existing Timer ownership, run history, retries, admission, SkillRun, and scoring infrastructure.
5. Add one terminal boot migration and additive SQL migration that drop the three retired Regression tables and append-only trigger function. Preserve the historical creation migration as migration history; remove every runtime schema owner so the domain cannot resurrect.
6. Update the server architecture and security baselines to describe the ordinary Timer → Skill → Issue path and the reduced authority surface.

## Engineering Principles audit
- **Single Source of Truth:** Issues remain canonical; parallel contracts, results, runs, and deployment snapshots are removed.
- **Minimum Viable Protocol:** one existing Skill, one existing Timer, and two ordinary Issue actions.
- **Canonical Mutation Path:** resolving uses existing principal-scoped Issue storage; no result store or deployment adapter participates.
- **Every Operation Replayable:** the existing build-ID gate, durable TimerRun history, autonomous admission, and Skill single-flight remain the launch controls; resolving an already resolved Issue is idempotent.
- **Least Privilege:** the Skill receives no bespoke browser, credential, deployment, contract-authoring, or scenario-execution authority; every diagnostic tool retains its own deterministic authorization.
- **Bounded work:** Issue listing is paginated at 500 records per call; the Skill must drain all pages before claiming complete coverage.
- **Failure mode:** model ambiguity could close an Issue incorrectly. The Skill therefore requires affirmative current-behavior evidence and leaves uncertainty open as `blocked_on_testing`.

## Security gate
Affected assets: A01 user/account authority, A02/S2 Issue evidence, A03 Timer/Skill state, A04 autonomous tool authority, A07 run evidence, and A08 background capacity across F04/F05/F06 and B03/B06/B10/B11. Credible threats are cross-owner Issue reads or writes, false resolution from weak evidence, duplicate build-triggered work, and retained browser/deployment authority after the product domain is removed. Controls remain deterministic: Timer execution restores the exact owner principal; DocumentStorage preserves principal/account/Vault scope; `issues.resolve` accepts only an Issue ID plus a bounded affirmative-evidence note; every other tool call crosses its existing authority boundary; the retired tables and tool are deleted from runtime reachability. No public route, provider credential, arbitrary-host browser path, or external side effect is added. Residual risk is semantic judgment: automated evidence may still be insufficient, so uncertainty must remain open and be reported as blocked on testing.
