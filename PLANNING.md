# PLANNING.md — Active Planning Process

This file is the canonical planning workflow. Use it for any complex task. For implementation-specific procedures, see CODING.md.


## Work Tracking Invariant

Before doing non-trivial work, create or identify a corresponding task. Every such task must be attached to at least one durable work container: a project or a milestone. Best case: attach it to the right project and the right milestone. Prefer existing projects and milestones. Do not create new projects unless Ray asks or the need is acute.

If a relevant project exists but no existing milestone fits, keep the task on the relevant project and suggest a new milestone aligned with near-term goals/projects. Create a new milestone only when the work clearly needs one and the placement is obvious; otherwise ask Ray to confirm.

If the work does not fit cleanly into the current project stack, pause and ask where it belongs before proceeding. That alignment conversation is part of the work. Do not do untracked non-trivial work while placement is unclear.

Before ending the work, update the task to the truthful state: completed, blocked, active, or another accurate status. Include the outcome or blocker so the canonical work record reflects reality.

## Plan Boundary

Use plan infrastructure only when a step materially benefits from fresh context: crossing into a genuinely different system/domain, creating an independent or adversarial review boundary, or decomposing work too large for one coherent context. Sequential publishing, build, deployment, or verification phases are not enough by themselves.

When a plan step becomes blocked, failed, or needs review, report the step, cause, and next required action to the parent session. Never leave the parent showing only the last successful checkpoint.

## When to Plan

Create a durable plan (via the `plan` tool) when:
- The task requires more than ~3 focused turns of work
- Multiple systems, domains, or stakeholders are involved
- The task touches core architecture or infrastructure
- You're entering unfamiliar territory that needs research
- Getting it wrong would be expensive to reverse

Skip planning when:
- The task is a single clear action (lookup, send, create a page)
- You already know exactly what to do and it fits in one turn
- The user is brainstorming and hasn't committed to action

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
- If plan creation or execution infrastructure fails, do not substitute `session.spawn_child` for an engineering step. Generic children are conversational delegations and deliberately lack trusted Git-write provenance. Repair/retry the plan path or continue the work in the trusted interactive session.
- Progress checkpoints to a Library page automatically
- If a step fails: assess whether to retry, skip, or pause for input
- If scope changes mid-execution: use `add_steps` or `pause`. Don't start over

## After Completion

- Summarize what was accomplished and note any follow-up needed
- If the plan produced a spec, completed review artifact, or other Ray-facing decision artifact, surface the Library page for Ray review in Home/Simple Inbox. Use Library surfacing (`surface=true`) with a clear review reason and enough duration that it remains visible for the next planning/review cycle. Do not rely on Ray finding it manually.
- The plan widget auto-clears from the session on completion

## Abandoned Plans

If a plan becomes irrelevant, pause it with a note explaining why. Don't leave zombie plans running.
