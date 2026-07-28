# Canonical Agendas implementation plan

## Goal

Add Automation > Agendas as the user-owned source of truth for reusable conversational agenda definitions. A definition is editable and searchable; a Session receives an immutable execution snapshot whose item statuses and resolutions continue to live only in the canonical chat document. The reserved FTUE definition is replay-safely seeded and snapshotted into newly created recap-aware Welcome sessions without rewriting any existing Session.

## Design

1. Persist `agenda_definitions` as an additive principal-owned table with bounded names, descriptions, and ordered item JSON. Keep execution status and resolution out of this table by type and schema; definition instantiation always creates fresh `open` Session items.
2. Make `AgendaDefinitionStorage` the only ordinary mutation boundary for REST, Agent tooling, and FTUE seeding. Every read/write composes the canonical scoped-storage predicates or owned insert values. Serialize create/update/delete/FTUE adoption under one owner+account advisory lock, preserving replay safety and preventing conflicting definition writes.
3. Seed one reserved `FTUE` definition per owner/account from the existing code-owned FTUE bootstrap fixture. The authenticated Agendas page boundary and recap-aware onboarding ensure that seed exists; read-only Agent list/search calls remain side-effect-free. The reserved definition can be edited and renamed but cannot be deleted.
4. At recap-aware onboarding, read the current FTUE definition through the freshly provisioned workspace principal, instantiate a fresh Session agenda, and pass it only into `createSessionOnce`. If definition storage is temporarily unavailable, log a content-free warning and use the existing code-owned FTUE fixture as a bounded availability fallback. Existing Welcome sessions remain unchanged because `createSessionOnce` never replaces an existing session agenda.
5. Expose authenticated `/api/agendas` CRUD and the unified `agendas` tool (`list|get|search|create|update|delete`). Both delegate to the same storage boundary. Classify reads as tier 0 and writes as tier 1; register the tool schema in the unified registry.
6. Add `/agendas`, an Automation sidebar item, and `navigation.agendas.open`. The page uses the canonical hierarchy stack: search, persistent `+ New Agenda`, collapsible Onboarding/Agendas sections, compact expandable rows, and inline create/edit/delete controls. It remains full-width, single-column, and uses quiet loading/error/empty rows.
7. Update server architecture and security doctrine to record the new definition/snapshot boundary, then verify through the production build and change-scope review.

## Engineering-principle audit

- **Single Source of Truth:** PostgreSQL definitions own reusable templates; Session chat documents own execution progress. The plan rejects synchronizing definition edits into existing Sessions.
- **Canonical Mutation Path:** REST, tools, seed adoption, and onboarding reads all cross `AgendaDefinitionStorage`; Session snapshots still cross `chat-file-storage.ts`.
- **Encode Invariants in Structure:** Definition items have no status/resolution fields, the reserved FTUE key is unique per owner/account, and Session instantiation always adds `status: open`.
- **Safe Partial Updates:** blank optional strings/arrays are omission; description clearing requires explicit `clearFields`. Create still requires a non-empty name and at least one valid item.
- **Every Operation Is Replayable / Eliminate Races:** one owner-scoped transaction advisory lock serializes definition mutations and seeding; `createSessionOnce` retains its existing owner+session-key lock.
- **Minimum Viable Protocol:** no definition versions, assignment system, nested agendas, session backfill, split view, or second onboarding state model.
- **Fail Loudly, Degrade Gracefully:** CRUD failures surface; onboarding alone may use the bounded code fixture so account activation is not denied by an optional definition read.
- **Progressive Disclosure / Design From User Backward:** the page reuses the shared SessionMenu hierarchy primitives and inline expansion rather than cards or a separate detail pane.

## Security gate

Assets/data: A01 principal/account identity, A02/S2 private agenda text and Session snapshots, A03 durable FTUE/session state, A04 model tool mutations, and A08 database/UI availability. Boundaries: F02/F04/F06 across authenticated REST, Agent tooling, PostgreSQL, and onboarding session creation; B03/B06/B10.

Credible threats: guessed IDs reading or mutating another user's definitions; system-principal orphan writes; wildcard/unbounded search; malformed or oversized agenda content amplifying storage/model context; concurrent edits or duplicate FTUE seeds; deleting the required FTUE template; definition edits rewriting historical Session progress; and model-originated writes bypassing deterministic authority.

Deterministic controls: `requireAuth`, current user principal requirement, `combineWithVisibleScope`/`combineWithWritableScope`/`ownedInsertValues`, bounded schema normalization through the existing Session agenda validator, literal substring search, 100-row result cap, owner-scoped advisory transaction lock, unique owner/account name and reserved-key indexes, reserved FTUE delete rejection, unified tool authority/tier classification, and snapshot-only onboarding. Logs contain IDs/counts/outcomes, never agenda content.

Severity: high because a scope failure could expose private agenda content or corrupt onboarding state. Owner: Session Runtime / Agent Runtime / Application Platform. SLA: repair before merge. Residual risk: the production build cannot prove environment-bound owner isolation or migration execution; Stage deployment and authenticated CRUD/onboarding acceptance remain required before live promotion. No active authorization testing is performed under repository policy.

## Verification

Run `npm run build`; run Code/GitNexus change-scope analysis with git diff/status fallback if the graph is stale; inspect the final diff; commit, push, create a PR targeting `main`, and merge after the build passes.
