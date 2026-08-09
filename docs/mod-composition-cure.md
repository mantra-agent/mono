# Mod Composition Cure

## Classification and scope

This change repairs the existing Mod composition plane; it does not introduce a new product capability. Core remains the non-installable substrate. Planning, Build, Business, Wellness, Network, and Finance each remain the sole owner of their optional contributions.

## Security gate

- Assets/data: account-scoped Mod entitlements/installations, executable tool/Skill/Workflow/Timer identities, principal permissions, connector readiness, and durable owned-resource history.
- Boundaries: authenticated/model/autonomous callers -> code-owned Mod registry -> principal-scoped active-installation predicate -> independently authorized domain/provider boundary.
- Abuse case: a stale schema, direct API call, hard-coded Skill name, or parallel route/tool list could execute an inactive Mod capability; treating installation as authority could grant permissions or provider access.
- Deterministic control: one registry-derived contribution owner index and one generic active-Mod predicate gate discovery and invocation. Installation only composes and reconciles ledger-owned resources. Existing permission, Principal/Vault, credential, provider, human-review, and Runtime gates remain independent.
- Blast radius: fail closed for an inactive or unknown optional contribution. Disable retains durable data and run history; reinstall reconciles the same identities.

## Implementation plan checked against Engineering Principles

1. Make the registry truthfully declare every currently enforced optional route group, tool, Skill, Workflow, and Timer identity; repair the malformed Wellness timer declaration.
2. Build generic registry-derived owner lookup plus active-Mod, route, tool, Skill, and Workflow gates; replace per-Mod parallel adapters and chained filters.
3. Delete only no-op managed-resource adapters and superseded per-Mod access adapters after repository search proves their callers migrated.
4. Keep Build and Wellness materializers as the only Mods with lifecycle-owned rows. Finance and other Mods remain state-only until they declare managed resources.
5. Strengthen build/boot validation so duplicate executable identities, unknown keys, and undeclared route/tool references fail loudly.
6. Update server architecture and SECURITY findings, run the production build, inspect scope, and merge to main.

The plan cures Single Source of Truth, Core/Mod Ownership, Canonical Mutation Path, DRY, Least Privilege, and replayability violations. It deliberately avoids a second composition store and does not let registry membership substitute for authorization.
