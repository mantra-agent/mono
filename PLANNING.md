# PLANNING.md — Active Planning Process

This file is the canonical planning workflow. Use it for any complex task. For implementation-specific procedures, see CODING.md.


## Work Tracking Invariant

Before doing non-trivial work, create or identify a corresponding task. Every such task must be attached to at least one durable work container: a project or a milestone. Best case: attach it to the right project and the right milestone. Prefer existing projects and milestones. Do not create new projects unless Ray asks or the need is acute.

Every milestone and task Agent creates while planning must carry a deliberate, real due date. Runtime planning-aware context loads this file as the canonical policy; do not restate or fork this policy in code or another artifact.

If a relevant project exists but no existing milestone fits, keep the task on the relevant project and suggest a new milestone aligned with near-term goals/projects. Create a new milestone only when the work clearly needs one and the placement is obvious; otherwise ask Ray to confirm.

If the work does not fit cleanly into the current project stack, pause and ask where it belongs before proceeding. That alignment conversation is part of the work. Do not do untracked non-trivial work while placement is unclear.

Before ending the work, update the task to the truthful state: completed, blocked, active, or another accurate status. Include the outcome or blocker so the canonical work record reflects reality.

## Naming Conventions

- **Three-word titles.** When naming goals, initiatives, or projects, prefer three-word titles when possible — they are easier to remember and fit better in UIs.
- **Short project descriptions.** Keep project descriptions to one or two sentences maximum.

## Universal blocked_by protocol

Durable work prerequisites live in one Core graph: `address_links` rows with predicate `blocked_by`, mutated only through the blocking graph boundary (`blocking_graph` tool, `/api/blocking-graph/*`, `BlockingGraphService`). Domain objects stay authoritative in their own stores. The shared contract is `shared/blocked-by-protocol.ts`. Do not create a second dependency graph, a `dependencies[]` field on tasks/plans, or per-skill dependency vocabularies.

### Semantics

- **One relationship.** `blocked_by` is the only prerequisite predicate.
- **Direction.** `sourceAddress` is the blocked item; `targetAddress` is the prerequisite that must clear first. Reading “source blocked_by target” means source waits on target.
- **Typed canonical addresses.** Endpoints are `@type:id` protocol addresses (for example `@task:123`, `@project:33`, `@milestone:33~12`, `@page:…`). Normalize and validate before write; unknown or invisible endpoints fail closed at the boundary.
- **Not task status.** Graph edges are prerequisite truth. Task/project status (`ready`, `active`, `blocked`, `done`, …) remains a separate domain field. An active edge may justify reporting work as blocked; status must not invent or replace edges.
- **Not plan step order.** Plan step sequence is execution order inside one Plan run. It is not durable cross-object prerequisite truth and must not be treated as a `blocked_by` substitute.

### Operating rules

1. **Read before plan.** Before creating or sequencing non-trivial work, list active blockers for the addresses in scope (`blocking_graph.list_blockers` / list blocked items). Plan and capacity decisions consume the graph; they do not guess prerequisites from titles.
2. **Create on discovery.** When a real prerequisite is discovered, add an edge through the canonical boundary (`blocking_graph.add_blocker`, or the additive `blockedBy[]` convenience on work/task/project/milestone create|update). Convenience writes project into the graph only — they do not persist a parallel dependency array on the domain row.
3. **No self-edges or cycles.** Source and target must differ. The service rejects edges that would close a directed cycle.
4. **Provenance when it helps.** Prefer an optional `provenanceAddress` (decision, page, session, or other supporting address) when the edge is non-obvious. Idempotency keys are required on explicit adds; work convenience keys are deterministic per `(source, target)`.
5. **Conservative mutation.** Add or retire deliberate edges only. Do not bulk-rewrite the graph, infer edges from free text, or “fix” status by deleting prerequisites silently. Retire with `blocking_graph.remove_blocker` when the prerequisite no longer applies; do not hard-delete history (lifecycle is active → retired).
6. **Completion review.** Before marking work complete, review active blockers for that address. Either finish or explicitly retire each edge with cause. Do not complete work that still has unresolved active blockers unless the human accepts the exception.
7. **No duplicate dependency fields.** Never add `dependencies`, `blocked_by`, or equivalent arrays on task/plan/goal JSON as a second store. Never teach Streamline, Autonomy, Brief, or other skills a private dependency model. Reads go through the blocking graph and the shared dependency-context resolver.

### Dependency-context resolver

`resolveWorkDependencyContext` (`server/work-dependency-context.ts`, contract `shared/work-dependency-context.ts`) is the sole read model for work prerequisites. It returns one discriminated state per address:

| State | Meaning |
|-------|---------|
| `ready` | No active `blocked_by` edges in scope |
| `blocked` | At least one active edge whose target is unresolved (not done/completed) |
| `stale` | Edges exist but every target is satisfied, inaccessible, or invalid — review/retire |
| `unavailable` | Address invalid, unauthorized, resolution error, or bound exceeded |

Bounds (callers may narrow, never exceed): 25 addresses, depth 1–2, fanout 20, 200 edges. Blocker rows may include status/owner/label/provenance only when the principal can see them. Load only for planning, selection, sequencing, scheduling, capacity, autonomy, or explicit work/dependency purposes (`WORK_DEPENDENCY_CONTEXT_PURPOSES`). Context assembly exposes a compact projection under `world_model.active_work.dependencies` when the active-work instruction group is on — never ambient full-chat noise, never a second graph.

### Goal Manager stays separate

Goal Manager owns goal hierarchy, horizons, and goal↔person/meeting links. It must not mint, rewrite, or act as authority for work `blocked_by` edges. Goals may be referenced as addresses when a work item truly waits on a goal outcome, but goal tooling must not grow a parallel dependency graph or treat goal parent/child links as `blocked_by`.

### Consumers (placement)

- **Plan tool / decomposition** — primary producer/consumer for discovered work prerequisites; distinguishes durable external blockers from internal step order; consumes `resolveWorkDependencyContext`.
- **Streamline / capacity** — excludes work with unresolved active blockers from executable capacity via the shared resolver.
- **Autonomy** — gates Agent execution on unresolved blockers and prefers executable prerequisites via the shared resolver.
- **Bootstrap / context** — may load bounded dependency state only for planning, selection, sequencing, scheduling, capacity, autonomy, or explicit work/dependency contexts (`world_model.active_work.dependencies`).
- All other skills — context-only if needed; no graph mutation and no private dependency fields.

## Agenda vs Plan

Agendas and Plans are different containers. Do not substitute one for the other.

**Session Agenda** — live conversation tracking with the user in the current session. Use it when the exchange will span many turns and you need an ordered checklist of topics, decisions, or conversational outcomes to work through together. The user is in the loop; progress is turn-by-turn dialogue. Mutate via the `session` agenda actions. Never put autonomous multi-step execution on an Agenda.

**Plan** — autonomous multi-step work you run without ongoing user intervention. Use the `plan` tool when the work should proceed in child sessions, produce durable deliverables, and only surface the user for genuine gates (review, blocked external dependency). The user is not steering each step. Never use a Plan to choreograph ordinary back-and-forth in the current conversation.

If the work is "keep this conversation on rails across many turns," use an Agenda. If the work is "go do a big thing and come back with results," use a Plan.

## Plan Boundary

Use plan infrastructure only when a step materially benefits from fresh context: crossing into a genuinely different system/domain, creating an independent or adversarial review boundary, or decomposing work too large for one coherent context. Sequential publishing, build, deployment, or verification phases are not enough by themselves.

When a plan step becomes blocked, failed, or needs review, report the step, cause, and next required action to the parent session. Never leave the parent showing only the last successful checkpoint.

## When to Plan

Create a durable plan (via the `plan` tool) when:
- The task requires more than ~3 focused turns of autonomous execution (not live conversation tracking)
- Multiple systems, domains, or stakeholders are involved
- The task touches core architecture or infrastructure
- You're entering unfamiliar territory that needs research
- Getting it wrong would be expensive to reverse
- The work should proceed without turn-by-turn user steering

Skip planning when:
- The task is a single clear action (lookup, send, create a page)
- You already know exactly what to do and it fits in one turn
- The user is brainstorming and hasn't committed to action
- You need to track topics across many turns of live conversation with the user — use a Session Agenda instead

## Think Before You Plan

Before creating a plan, work through these silently:

1. **Goal.** What does done look like? What would the user accept as complete?
2. **Assumptions.** What am I assuming? Which assumptions could be wrong?
3. **Research.** Do I need to look anything up first? External docs, memory, codebase, web?
4. **Domain loading.** Code work → load AGENTS.md, CODING.md, relevant subdir docs, DESIGN.md for UI. Non-code work → load whatever domain context applies (people, finances, calendar, etc).
5. **Approach.** What's the simplest path? What are the alternatives? Why this one?
6. **Open questions.** Any genuine blockers my principles and context can't resolve? If yes, ask. If no, proceed.

## Creating a Plan

**Decompose by deliverable, not pipeline phase.** Steps are missions, not stages. Every child session boots with the full standard operating procedure for its domain — a coding child already carries CODING.md's implement → build → PR → merge path inside every step. Never create steps for work the child's ambient instructions already mandate.

- One step = one shippable, verifiable outcome: a merged PR, a written spec, a completed analysis. Never a stage of one.
- Anti-example: "Step 4: Build and submit PR" is wrong — every coding step that wrote code already built, submitted, and merged its own change. Same failure class: "write tests", "verify it compiles", "create the PR".
- Split when outcomes are separable and can each survive an independent fresh context. Merge when splitting would force one deliverable across two contexts.
- A final verification step is legitimate only when it checks cross-cutting, whole-system behavior no single step could see — never a re-run of per-step mechanics.
- Each step must be independently executable in a spawned child session
- Assign each mission its execution persona: **Engineer** for implementation, debugging, migrations, builds, deployments, and PR work; **Architect** for structural design, domain modeling, interfaces, and specifications where code is not the primary deliverable; **Default** for other missions. Choose from the primary deliverable, not incidental verbs.
- Step instructions include what context to load and what "done" looks like
- Order steps by dependency, not importance
- Begin execution immediately after creation. Do not wait for permission unless you surfaced blocking questions above

## During Execution

- The plan tool spawns child sessions per step with fresh context
- **Choose wait mode once — never poll.** `plan.execute` is either blocking or non-blocking; pick deliberately and stop watching.
  - **Wait for the result in this turn** → create/execute with `blocking: true`. The runtime holds this session until the Plan finishes (or hits a real gate). Do not call `plan.get`, `session.get`, `session.list`, or `system.active_runs` in a loop “to see if it’s done.”
  - **Fire and move on** → create/execute with `blocking: false` (default for larger Plans). Hand off immediately: tell the user the Plan is running, point at `@plan:…`, and continue other work or end the turn. Do not poll for completion. Completion, failures, and `needs_review` surface through Plan/Runtime checkpoints, the Plan page, and ordinary attention — not through the orchestrator spinning on status reads.
  - **Forbidden:** any multi-call wait loop after `plan.execute` (`plan.get` / child `session.get` / `active_runs` / sleep-and-recheck). That burns the parent turn, races the executor, and duplicates Runtime’s job.
  - Re-enter a running Plan only for a concrete reason: user asked status, a child messaged the parent, you must `add_steps` / `pause` / recover a failed step, or you are answering a human review gate. One targeted read is fine; polling is not.
- If plan creation or execution infrastructure fails, preserve the intended execution semantics. For a single independent engineering mission, `session.spawn_child` with `delegation=engineering` is a valid fallback; for multi-step work, repair/retry the plan path so ordering, checkpoints, and step outcomes remain durable. Never rely on free-text instructions to grant authority.
- Progress checkpoints to a Library page automatically
- If a step fails: assess whether to retry, skip, or pause for input
- If scope changes mid-execution: use `add_steps` or `pause`. Don't start over

## After Completion

- Summarize what was accomplished and note any follow-up needed
- If the plan produced a spec, completed review artifact, or other Ray-facing decision artifact, surface the Library page for Ray review in Home/Simple Inbox. Use Library surfacing (`surface=true`) with a clear review reason and enough duration that it remains visible for the next planning/review cycle. Do not rely on Ray finding it manually.
- The plan widget auto-clears from the session on completion

## Abandoned Plans

If a plan becomes irrelevant, pause it with a note explaining why. Don't leave zombie plans running.
