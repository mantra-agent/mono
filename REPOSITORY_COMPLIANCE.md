# Repository Compliance Contract

**Authority:** Root `AGENTS.md` owns universal engineering principles. `CODING.md` owns procedure. `SECURITY.md` owns security controls. `DESIGN.md` owns user-facing design. This contract defines the truthful repository denominator and how file responsibility changes file-shape expectations without weakening those authorities.

## Denominator

Every first-party file below the repository root is inventoried except ephemeral or dependency/build directories explicitly excluded by `repository-compliance.json`: `.git`, `node_modules`, `dist`, `.expo`, `.cache`, and `coverage`.

A file has exactly one class:

1. **Ordinary authored source** — the default. Application code, configuration, scripts, documentation, assets, and authored data are reviewed normally and must follow their nearest `AGENTS.md` plus every applicable root authority.
2. **Generated artifact** — deterministic output whose source and regeneration owner are named in the manifest. Review generator/input provenance and resulting diff; do not impose hand-authored formatting or decomposition on the output.
3. **Vendored code** — first-party-shipped external code with upstream version/provenance, local patch policy, owner, and review trigger recorded. It remains inside the security, supply-chain, licensing, reachability, and build contract; vendoring is not an exemption from risk.
4. **Immutable migration history** — checked-in migration SQL. Applied history is evidence and must not be rewritten to satisfy present-day style. Correct forward with a new migration. Migration runners and current schema owners remain ordinary authored source.
5. **Compatibility fixture** — authored bootstrap, fallback, or migration data retained for a proven compatibility contract. It must name the canonical live authority and cannot silently become a second source of truth.

Unclassified files are ordinary authored source. Exceptional classes are allowlisted by exact path or bounded glob in `repository-compliance.json`; each entry must carry provenance, owner, mutation method, and review trigger. Missing paths, empty matches, overlapping classifications, or incomplete evidence fail the production build.

## Universal Structure

The following principles apply structurally to every class where the concern exists:

- one source of truth and one canonical mutation path;
- explicit Core or single-Mod ownership for product capability;
- deterministic authority, principal/account/Vault scope, and default deny;
- bounded resource use, cancellation, truthful outcomes, observability, and recovery;
- no secret or unnecessary S1/S2 content in logs, artifacts, or model/provider context;
- reproducible provenance for dependencies, generated output, migrations, and vendored code;
- no hidden route, tool, Mod, Skill, Workflow, Hook, Timer, boot, script, native/plugin, provider-callback, or dynamic registration path;
- no tests, test harnesses, snapshots, fixtures, or test-only scripts under the repository's current no-test policy.

Responsibility changes shape, not principle. A generated lockfile need not meet a human function-length heuristic. A migration may be intentionally irreversible source history. A vendored minified worklet may remain monolithic. An authored compatibility fixture may be data-heavy. None may acquire ambiguous authority, unbounded execution, hidden reachability, or undocumented provenance.

## File-Shape Rules

- **Ordinary authored source:** prefer bounded modules and functions, explicit interfaces, shared contracts, and the nearest owning instruction file. Root size guidance is a review signal, not an automated proof of architectural failure; a cure requires a reachable flow, failed invariant, and coherent owner boundary.
- **Generated artifact:** change inputs or generator. Review that regeneration is reproducible and does not introduce unexpected authority or supply-chain drift.
- **Vendored code:** preserve upstream provenance and local patch notes. Do not refactor for house style unless ownership deliberately changes from vendored to authored.
- **Migration history:** add forward history; never edit an applied migration merely to satisfy current patterns. Security-critical mistakes still require immediate forward correction and an updated `SECURITY.md` finding.
- **Compatibility fixture:** keep the live source of truth explicit, bound reconciliation and fallback use, and delete the fixture only after reachability and persisted compatibility are disproven.

## Exception Mechanics

There is no free-form exception list. A structural exception is valid only when all are true:

1. the file is classified in `repository-compliance.json`;
2. current source proves the stated responsibility and reachability;
3. provenance, accountable owner, allowed mutation path, and review trigger are present;
4. the exception narrows file shape only — it does not waive security, authority, ownership, observability, recovery, or build requirements;
5. removing the entry when its premise expires is part of the owning change.

Ordinary authored source receives no manifest exemption. If a universal principle cannot truthfully apply, change the principle or the architecture rather than accumulating waivers.

## Enforcement and Audit

`script/repository-compliance.ts` inventories the denominator, validates exceptional evidence, assigns every file one class, rejects missing/overlapping declarations, and fails on conventional test/spec source identities or test/fixture/snapshot directories. Operational files that merely contain words such as `test`, `spec`, or `migration` are not findings by name alone. `npm run build` invokes the validator before any optional provider/database side effects or artifact generation.

The validator deliberately does not turn line count, naming, or an isolated code smell into a finding. Architecture audits must still prove the reachable flow and failed invariant under root `AGENTS.md`. Later cure steps should use the emitted class counts as their denominator, map confirmed ordinary-source violations to owners, and either cure them or place them in the plan backlog — never hide them by reclassification.
