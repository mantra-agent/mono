# Task Assignment + D3 Provenance Implementation Plan

## Verified boundary

- `FileTaskStorage` is the canonical task mutation boundary. `owner` remains the `me | agent` execution owner.
- `FileProjectStorage` is the canonical project and first-class milestone creation boundary.
- `ObjectGrantService` is the only grant/revoke boundary. Assignment and D3 defaults must call transaction-capable methods there, never write `object_grants` directly.
- Meeting provenance reaches work tools through `_sessionId`; a meeting is canonically the meeting session, so `origin_id` is that session ID.
- D3's sharing group is derived from live meeting-origin task assignment grants already written for that meeting. The query is bounded. A project or milestone gets only the group known at its creation time. There is no later inheritance or retroactive parent exposure.

## Design

1. Add nullable `tasks.assignee_subject_type` and `tasks.assignee_subject_id` with a database pairing/type constraint. Extend the stable Task/InsertTask shape without changing `owner`.
2. Add transaction-capable canonical grant mutations to `ObjectGrantService`: set task-assignment access and grant D3 defaults. Assignment writes a task-only `write` grant, revokes the prior assignee's task grant on reassignment/clear, and audits all mutations in the task transaction.
3. Make task create/update transactional with assignment + grant synchronization. Treat assignment changes as admin-only reassignment. Omitted assignment fields remain no-change; one-sided or blank pairs fail closed; explicit clears must clear both fields.
4. Pass meeting provenance from the task tool into storage so assignment grants use `origin_type='meeting'` and `origin_id=<meeting session id>`; ordinary assignment uses `manual`.
5. At project and milestone creation only, pass meeting provenance into `FileProjectStorage`. In the same creation transaction, query the bounded set of subjects holding live meeting-origin `write` task grants for that meeting and create `read` grants on only the new object. Existing projects/milestones are never touched. Attaching a task to an existing project creates no parent grant.
6. Expose assignee fields sparsely in the tasks tool and task HTTP routes. Keep internal meeting provenance out of public schemas.
7. Add additive boot convergence and SQL migration, update server architecture/security doctrine, run `npm run build`, inspect change scope, then commit, PR, and merge to `main`.

## Engineering-principle audit

- Rejected overloading `owner`: it would collapse execution authority and human obligation.
- Rejected route/tool-side grant writes: they would bypass other storage callers and violate Canonical Mutation Path.
- Rejected parent inference at read time: it would disclose pre-existing parents and violate D3.
- Rejected retroactive meeting-group propagation: D3 explicitly requires creation-time provenance, not ongoing inheritance.
- Rejected non-atomic task assignment and grants: partial failure could create an obligation without access or access without obligation.
- Rejected direct `object_grants` inserts from storage: all writes remain inside `ObjectGrantService`, including transaction-scoped writes.

## Security gate

Assets/data: S2 private task/project/milestone content, assignee identities, grant authority, privileged audit history. Boundaries: authenticated user/tool to cross-account object access and meeting-derived sharing. Abuse cases: forged assignee IDs, one-sided assignment state, stale old-assignee access, assignment without grant, grant without assignment, parent disclosure from task placement, retroactive exposure of pre-existing work, and unbounded meeting fan-out. Deterministic controls: paired DB constraint, admin-only reassignment, canonical transactional grant service, exact task-only assignment grants, creation-time-only parent defaults, exact meeting origin ID, bounded subject lookup, owner-or-live-grant access predicates, and durable audit rows. Residual risk: subject existence/claim rebinding for `invited_subject` remains the next planned phase; this step stores the typed subject and fails closed on malformed pairs. Repository policy prohibits active authorization tests, so verification is production build plus static change-scope inspection.
