# PLANNING.md — Active Planning Process

This file is the canonical planning workflow. Use it for any complex task. For implementation-specific procedures, see CODING.md.


## Work Tracking Invariant

Before doing non-trivial work, create or identify a corresponding task. Attach it to the best existing project and milestone when possible. Prefer existing milestones; create a new milestone only when the work clearly needs one. Do not create new projects unless Ray asks or the need is acute.

If the work does not fit cleanly into the current project stack, pause and ask where it belongs before proceeding. That alignment conversation is part of the work.

Before ending the work, update the task to the truthful state: completed, blocked, active, or another accurate status. Include the outcome or blocker so the canonical work record reflects reality.

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

- Each step must be independently executable in a spawned child session
- Step instructions include what context to load and what "done" looks like
- Order steps by dependency, not importance
- For code work, reference CODING.md's Standard Ship Path in step instructions
- Begin execution immediately after creation. Do not wait for permission unless you surfaced blocking questions above

## During Execution

- The plan tool spawns child sessions per step with fresh context
- Progress checkpoints to a Library page automatically
- If a step fails: assess whether to retry, skip, or pause for input
- If scope changes mid-execution: use `add_steps` or `pause`. Don't start over

## After Completion

- Summarize what was accomplished and note any follow-up needed
- If the plan produced a spec, completed review artifact, or other Ray-facing decision artifact, surface the Library page for Ray review in Home/Simple Inbox. Use Library surfacing (`surface=true`) with a clear review reason and enough duration that it remains visible for the next planning/review cycle. Do not rely on Ray finding it manually.
- The plan widget auto-clears from the session on completion

## Abandoned Plans

If a plan becomes irrelevant, pause it with a note explaining why. Don't leave zombie plans running.
