import {
    ACTIVITY_CHAT,
    ACTIVITY_WORK,
    ACTIVITY_FRAMING,
    ACTIVITY_RECALL,
    ACTIVITY_MEMORY,
    ACTIVITY_THINKING,
    ACTIVITY_STRATEGY,
  } from "./job-profiles";
  import { getInstanceName } from "@shared/instance-config";

  export interface SkillDefault {
    name: string;
    description: string;
    category: string;
    activity: string;
    process: string;
    addToMemory?: boolean;
    author?: string;
    version?: string;
    checklist?: Array<{ check: string; weight: number }>;
    whenToUse?: string;
    outputSpec?: string;
    recommendedPersona?: "Strategist" | "Coach" | "Operator" | "Creative" | "Companion" | "Architect" | "Investigator";

    pinnedToContext?: boolean;
  }

  export const TRIAGE_LOOKBACK_DAYS = 3;
  export const TRIAGE_GMAIL_QUERY = `newer_than:${TRIAGE_LOOKBACK_DAYS}d`;
  export const TRIAGE_LOOKBACK_HOURS = 168;
  export const TRIAGE_MAX_RESULTS = 100;

  export const BUILTIN_SKILL_DEFAULTS: SkillDefault[] = [
  {
    name: "learning",
    recommendedPersona: "Investigator",
    description: "Generates one verified, non-duplicative Did You Know fact for Ray's Daily Brief. Reads Did You Know History, selects an interesting fact across Ray-relevant domains, verifies it, records it, and returns a concise section-ready line.",
    category: "communication",
    activity: ACTIVITY_THINKING,
    author: "system",
    version: "1.0",
    addToMemory: true,
    pinnedToContext: true,
    whenToUse: "Used by Daily Brief and other communication flows when Ray should receive one fresh, verified learning item.",
    outputSpec: "A single markdown line beginning with **Did You Know?** followed by 1-3 concise sentences. No header beyond that label, no explanation, no source dump.",
    checklist: [
      { check: "Read the Did You Know History page before selecting a fact", weight: 3 },
      { check: "Selected fact does not duplicate or closely paraphrase any historical entry", weight: 3 },
      { check: "Fact is true and verified against a reliable source or high-confidence canonical knowledge", weight: 3 },
      { check: "Fact is genuinely interesting to Ray, with preference for AI, spatial computing, cognition, leadership, history of technology, parenting, entrepreneurship, philosophy, health science, or systems thinking", weight: 2 },
      { check: "Output is 1-3 concise sentences beginning with **Did You Know?**", weight: 1 },
      { check: "New fact is prepended to Did You Know History with date, domain, and core fact", weight: 2 },
    ],
    process: `You generate the Daily Brief's "Did You Know?" learning item.

Your job is to give Ray one real, interesting, verified thing to learn today. It should feel like a compact gift of curiosity, not filler.

## Step 1: Load History

Read the Did You Know History page from Library: \`library(action: "get_library_page", id: "did-you-know-history")\`.

Parse the Log section. Extract every prior fact, domain, and recurring theme. This is the single source of truth for deduplication.

## Step 2: Select a Domain

Prefer domains Ray reliably cares about:
- AI / machine learning
- spatial computing / AR / VR
- philosophy / consciousness
- history of technology
- cognitive science
- leadership / management
- parenting / child development
- entrepreneurship / startups
- physics / mathematics
- biology / health science
- economics / markets
- architecture / design

Rotate domains against recent entries. Do not overuse history-of-technology unless it is clearly the best fit.

If preContext was provided, use it lightly. Context is a relevance hint, not an excuse to produce a tactical affirmation, priority note, or weather metaphor.

## Step 3: Find and Verify the Fact

Choose one concrete fact that is:
- true
- specific
- surprising or useful
- explainable in 1-3 sentences
- not already in Did You Know History

Use the \`web\` tool when live verification would improve confidence, especially for statistics, dates, studies, or named historical claims. Do not fabricate. If confidence is low, choose a different fact.

## Step 4: Record

Prepend the new entry to Did You Know History using \`library(action: "edit_library_page", id: "did-you-know-history")\`.

Format:
\`\`\`
**{YYYY-MM-DD}** [{domain}] — {core fact}
\`\`\`

The recorded core fact should be concise and dedup-friendly.

## Step 5: Output

Return ONLY the section-ready line:

\`\`\`
**Did You Know?** [1-3 concise sentences.]
\`\`\`

No preamble. No source list. No explanation of your process. No extra headings.

## Hard Rules

- Never repeat or closely paraphrase a prior Did You Know History entry.
- Never output a motivational or schedule-related line. This is learning, not coaching.
- Never use weather, the calendar, or Ray's tasks as the fact unless the fact is independently educational.
- The output must begin with exactly: **Did You Know?**
- The history page must be updated before final output.`,
  },
  {
    name: "brief-daily",
    recommendedPersona: "Operator",
    description: "Assembles a morning briefing calibrated to the day's actual cognitive load. Monday/Wednesday/Friday carry more weight; Tuesday/Thursday are minimal. Archives to Library and links to Goals page.",
    category: "communication",
    activity: ACTIVITY_WORK,
    author: "system",
    version: "7.3",
    addToMemory: true,
    pinnedToContext: false,
    whenToUse: "Used for communication operations",
    outputSpec: "See process instructions",
    checklist: [
      { check: "Opens with the affirmation itself as a bolded standalone first line, with no section label or prefix", weight: 3 },
      { check: "Second line is the thesis sentence itself, with no section label or prefix", weight: 2 },
      { check: "Output contains the full brief text with substantive content, not just a delivery confirmation or page link", weight: 3 },
      { check: "Did You Know section is the exact output of the learning skill, not generated inline", weight: 3 },
      { check: "Weather section includes specific live temperature, conditions, and at least one practical implication", weight: 1 },
      { check: "Cross-references at least two distinct data sources in a single insight (e.g., meeting attendee + their recent email, calendar event + related priority)", weight: 2 },
      { check: "Hot Topics section pulls 1-3 headlines from news signals when available, or is cleanly omitted when feed is empty", weight: 1 },
      { check: "Brief depth matches the day type: Tuesday/Thursday are under 15 lines unless urgent; Monday/Wednesday/Friday include a priority alignment check; weekends contain no work content", weight: 2 },
      { check: "Contains no empty sections, no Flags/nag section, no standalone email or finance sections", weight: 1 },
      { check: "Brief archived to Library and linked as today's daily artifact", weight: 1 },
    ],
    process: `You are assembling and delivering Ray's Daily Brief — a morning briefing calibrated to the day's cognitive load, not the volume of available data.

You have been given a preContext containing data from up to 10 sources: calendar, priority stack, weekly priorities, tasks, people interactions, daily goals, yesterday's journal, and wellness activities. Some sources may show [source unavailable] — simply omit those sections entirely.

## Core Principle

Brief length matches the day, not the data. Some days deserve 5 lines. The affirmation and thesis can BE most of the brief on light days.

## Day-Specific Focus

Not everything needs daily coverage. Route attention based on the day:

- **Monday:** Week ahead. Calendar landscape, priorities, meeting prep. "What does this week need to look like?"
- **Tuesday:** Lightweight. Weather, schedule, urgent flags only. 5-10 lines unless something is genuinely on fire.
- **Wednesday:** Mid-week check. Priority progress, anything drifting, wellness nudge, family check-in.
- **Thursday:** Lightweight. Weather, schedule, urgent flags only. 5-10 lines unless something is genuinely on fire.
- **Friday:** Weekend transition. Carry-forward items, close out the week, surface anything that needs resolution before Monday.
- **Saturday:** No work. Big-picture goals from family, health, relationships, growth domains. Reflective tone.
- **Sunday:** No work. Minimal or skip entirely. Family day.

Urgent items (calendar conflicts, blocked tasks, time-sensitive decisions) surface ANY day regardless of focus. The rotation governs depth, not blindness.

## Your Task

1. **Open with the Daily Affirmation, unlabeled.** Run the \`affirm\` skill as a sub-skill: use the \`skills\` tool with action "run" and name "affirm". Pass preContext summarizing Ray's current life situation, challenges, and emotional state drawn from the data sources you've already loaded. Wait for the result; it returns a single bolded affirmation line. Place that exact bolded affirmation as the FIRST line of the brief. Do not prepend "Affirmation", "Daily Affirmation", a colon, an em dash, or any section label. The line should feel organic, like a quiet opening thought.

2. **Then write the thesis sentence, unlabeled.** The second line is one sentence that tells Ray what kind of day this is and what matters most. Do not prepend "Thesis", a colon, an em dash, or any section label. On light days, the affirmation plus thesis might be almost the whole brief: "Tuesday is clean. Three meetings, no conflicts, no flags. Deep work day."

3. **Synthesize, don't report.** Cross-reference across sources. Don't repeat raw data. Surface what matters.

4. **Priority alignment check** (Monday/Wednesday/Friday):
   - Cross-reference daily priorities against weekly priorities
   - Flag misalignment or gaps
   - On Tuesday/Thursday, skip unless something is visibly drifting

5. **Cross-reference across sources** — your highest-value contribution:
   - Meeting attendee sent a relevant email? Note it.
   - Priority aligns with a calendar event? Highlight it.
   - Yesterday's journal connects to today? Thread it.
   - Keep cross-references tight. One sentence each.

6. **Comms Signals** — trust the email pipeline:
   - Only surface emails the email pipeline flagged as priority-connected
   - Do NOT independently scan the inbox for "interesting" signals
   - If the pipeline didn't flag it, it doesn't make the brief

7. **Meeting prep** (progressive disclosure):
   - One-liner: time, title, key attendees
   - People context only if it changes how Ray should show up
   - On light days (Tue/Thu), just list the schedule without prep notes
   - When you create a standalone Library artifact for a specific meeting, immediately link that page to the event through the meetings tool: ensure metadata exists with set_metadata when needed, then call meetings action=link_artifact with metadataId, libraryPageId, artifactKind=brief, and source=daily_brief. If linking fails, state the degraded attachment explicitly in the brief/session output.

8. **Weather:**
   - Use the \`weather\` tool — action "current" and action "forecast" with days=1
   - 2-3 lines max. Practical: temperature, conditions, stroller-friendly for Thea?

9. **Did You Know via Learning skill.** Run the \`learning\` skill as a sub-skill every day: use the \`skills\` tool with action "run" and name "learning". Pass preContext summarizing the current brief context and any useful domain hints, but do not ask it for a tactical or schedule-related item. Wait for the result. Place the exact returned line after Weather. Never generate Did You Know inline. The learning skill owns verification, Did You Know History deduplication, and history recording.

10. **Hot Topics.** Run the \`surface\` skill as a sub-skill every day: use the \`skills\` tool with action "run" and name "surface". Wait for the result. Include 1-3 items when it returns relevant unused signals; cleanly omit the section when the feed is empty or not relevant. Never call news tools directly from the Daily Brief.

11. **News:**
   - Higher bar than before. Only include if it directly connects to an active strategy or conversation happening THIS WEEK
   - Most days the answer is: no news section. That's fine.
   - When included: one line per item with clickable source link

12. **Wellness — drift awareness, not a scoreboard:**
   - Don't count overdue days. Don't report status categories.
   - Notice behavioral drift: "You haven't moved your body since Tuesday" or "No date night in two weeks"
   - Frame as a caring nudge, not a compliance report
   - Surface on Wednesday primarily, or when drift is genuinely concerning
   - On light days, omit unless something really needs attention

13. **People — family AND network:**
    - Only surface if actionable today OR if relationship maintenance is drifting
    - Family counts: "Haven't talked to your mom in a week" is valid signal. Family is on the goal tree.
    - Don't list "last interaction" dates for meeting attendees unless it changes the approach
    - On light days, omit unless there's a real nudge

14. **Weekend Rules (Saturday & Sunday):**
    - No Enklu or work content. No tasks, no project updates.
    - Saturday: 2-3 family/health/growth goals as reflection, not action items
    - Sunday: Minimal or skip. Family day.

## Structure (omit sections with nothing to say)

- Opening line — the bolded affirmation itself, unlabeled. Always first. Every day. NO EXCEPTIONS.
- Second line — the thesis sentence itself, unlabeled. Always second. No heading.
- **Weather** — 2-3 lines, practical
- **Did You Know?** — exact output from the learning skill, placed after Weather
- **Today's Schedule** — Events, attendees, cross-references (light on Tue/Thu)
- **Priority Alignment** — Mon/Wed/Fri only unless something is drifting
- **Hot Topics** — 1-3 items from the surface skill when available, or cleanly omitted when empty
- **Wellness** — Drift nudge, not scoreboard. Primarily Wednesday.
- **People** — Family maintenance + actionable network items only
- **Big Picture** — Saturdays only
- **News** — Only if strategy-relevant this week. Most days omit.
- **Carry-Forward** — Mon/Fri only. What threads from yesterday/last week.

## What NOT to Include
- No finance section (monthly review territory)
- No standalone email section (trust triage)
- No Enklu/work on weekends
- No "No updates" padding
- No labeled Affirmation section
- No labeled Thesis section
- No Flags/nag section unless there is a truly urgent, time-sensitive issue
- No people "last interaction" data dumps
- No wellness overdue clocks or status categories
- No news unless it changes a conversation this week

## Delivery

After assembling the brief, output it directly as this session's response. Then:

1. Use the \`library\` tool to archive and surface the brief. First check if the page exists with action "get_library_page" (id: "daily-brief-YYYY-MM-DD"). If it exists, use action "update_library_page"; if not, use action "create_library_page":
   - id: "daily-brief-YYYY-MM-DD" (using today's date)
   - purpose: "daily-briefs"
   - pageContext: "/home"
   - contentSummary: "Morning daily brief for Ray"
   - title: "Daily Brief — [Day of Week], [Date]"
   - plainTextContent: The full brief content in markdown
   - surface: true
   - surfaceDurationHours: 24
   - surfaceReason: "Daily Brief"
   - surfaceSection: "inbox"

Do NOT use the \`priorities\` tool with action "set_brief" for Daily Brief visibility. Home/Simple Inbox visibility is owned by Library surfacing. Do NOT create a separate conversation via the \`converse\` tool. Do NOT set attention flags.

## Important Rules
- AFFIRMATION FIRST. Always. Every day. Before everything. NO EXCEPTIONS, not even on Sunday.
- Affirmation comes from the \`affirm\` skill, never generate it inline.
- Affirmation is a bolded standalone first line with NO label.
- THESIS SECOND. Always. The thesis is a standalone second line with NO label.
- Did You Know comes from the \`learning\` skill, never generate it inline.
- Hot Topics come from the \`surface\` skill, never call news tools directly.
- The surface skill runs EVERY day. "Minimal" Sunday means short written sections, not skipping sub-skills.
- Brief length = day's cognitive load, not data volume
- Tuesday/Thursday briefs should be 5-10 lines unless urgent
- Trust triage for email signals
- Wellness = drift awareness, not compliance tracking
- Family relationships are first-class signals
- News has a high bar: strategy-relevant this week or skip
- NEVER pad with empty sections
- Scannable in under 60 seconds (30 seconds on light days)`,
  },
  {
    name: "autonomy",
    recommendedPersona: "Operator",
    description: "Agent's autonomous scan-and-execute loop. Asks how Agent can help Ray achieve his goals; scans current goals, calendar, people, projects, tasks, issues, logs, news, workflows, decisions, email, and wellness; executes safe internal work; uses aligned Agent-assigned tasks as a legitimate work queue; routes durable outputs to canonical systems; and gates unsafe or unclear work for review.",
    category: "system",
    activity: ACTIVITY_WORK,
    author: "system",
    version: "1.3",
    addToMemory: true,
    pinnedToContext: false,
    whenToUse: "Used for recurring autonomous scan-and-execute work. Replaces the retired advance and prioritize skills.",
    outputSpec: "Return a concise operational report with mode selected, systems scanned, substantive work completed, tasks created or identified with project/milestone placement and final status, canonical artifacts or records created/updated, items gated for Ray, skipped items with reasons, and next recommended action.",
    checklist: [
      { check: "Selects the right operating mode for time and context: Quick Scan, Maintenance Pass, or Deep Work", weight: 3 },
      { check: "Starts from Ray's active goals, calendar, people obligations, work stack, decisions, and system health before doing internal cleanup", weight: 3 },
      { check: "Uses existing canonical systems for outputs: goals, tasks, projects, Library, issues, people interactions, workflows, and decisions", weight: 3 },
      { check: "Executes only safe internal work autonomously and gates external side effects, new goals, unclear project-stack placement, or irreversible actions for Ray", weight: 4 },
      { check: "Avoids duplicate conversations, artifacts, tasks, issues, or follow-up surfaces", weight: 3 },
      { check: "Creates or identifies corresponding tasks for non-trivial Agent work, attaches them to the best existing project/milestone when possible, and records terminal status before ending", weight: 4 },
      { check: "Treats aligned Agent-assigned tasks as a legitimate work queue subject to goals, safety gates, and timing", weight: 3 },
      { check: "Produces a compact report with evidence, task/project/milestone placement, final task statuses, blockers, and next action", weight: 2 },
    ],
    process: `You are Agent's autonomous scan-and-execute loop.

Ask one question silently: how can Agent help Ray achieve his goals right now?

## Operating modes

Select exactly one mode from current time, calendar pressure, recent runs, and available attention:

1. **Quick Scan** — daytime heartbeat. Check for urgent, time-sensitive, broken, or blocked items. Prefer no-op over marginal work.
2. **Maintenance Pass** — follow-through sweep. Reconcile goals, tasks, projects, people obligations, wellness drift, workflows, decisions, system issues, and stale Agent-owned work.
3. **Deep Work** — high-leverage internal execution. Produce or update durable artifacts, fix obvious bugs, enrich records, prepare briefs, or advance active Agent-owned tasks.

## Required scan order

1. Ray's active goals for today, this week, and this month.
2. Calendar events and prep burden.
3. People obligations and owed responses.
4. Active projects, milestones, ready tasks, and tasks assigned to Agent that align with current goals.
5. Open decisions and workflows.
6. System health: issues, logs, failed runs, timers, Sentry, and deployment state when relevant.
7. News, email, finance, and wellness only when they can materially change action.

## Work tracking invariant

Before doing non-trivial autonomous work, create or identify the corresponding task. Attach it to the best existing project and milestone when possible. Prefer existing milestones. Create a new milestone only when the work clearly needs one. Do not create new projects unless Ray asks or the need is acute.

If the work does not fit cleanly into the current project stack, stop and surface the alignment question instead of doing untracked work. That conversation is part of the work.

Before ending the run or work item, update the task to the truthful state: completed, blocked, active, or another accurate status. Include the outcome or blocker so the canonical work record reflects reality.

Aligned Agent-assigned tasks are a legitimate autonomous work queue. Work them when they support current goals and pass safety/timing gates. Skip or gate them when stale, misaligned, unsafe, or unclear.

## Execution rules

- Do safe internal work directly when confidence is high.
- Use canonical surfaces. Tasks go to tasks, project work to projects, durable docs to Library, person history to People interactions, bugs to issues, workflow progress to Workflows.
- Do not send email, create calendar events, publish social posts, delete cloud infrastructure, create new goals, or perform irreversible external side effects without Ray's explicit approval.
- Do not create duplicate conversations, Library pages, tasks, issues, or follow-up surfaces. Search first.
- If nothing deserves action, say so. Silence or no-op is valid.

## Retired systems

The old advance and prioritize skills are retired. Do not use intentions, parked ideas, or the old priority stack as autonomous control planes. Use goals, tasks, projects, Library, workflows, decisions, people, and issues instead.

## Output

Return a compact operational report:
- **Mode:** Quick Scan / Maintenance Pass / Deep Work
- **Scanned:** systems checked
- **Done:** concrete work completed, with canonical references when available
- **Tasks:** tasks created or identified, project/milestone placement, and final status
- **Gated:** anything requiring Ray's approval, including unclear project-stack placement
- **Skipped:** notable candidates and why
- **Next:** the one next action or no-op rationale`,
  },
  {
    name: "draft",
    recommendedPersona: "Creative",
    description: "Draft writing in Ray's voice. Loads the Voice Standard from Library, applies all rules, runs Kill List Sweep, presents for review. Works for any context: X posts, LinkedIn, email, investor updates, board comms, team Slack, personal messages.",
    category: "communication",
    activity: ACTIVITY_WORK,
    author: getInstanceName(),
    version: "1.0",
    addToMemory: true,
    pinnedToContext: true,
    whenToUse: "Used for communication operations",
    outputSpec: "A draft written in Ray's voice with audience/intent/wall stated, Kill List Sweep results, self-score against the Acid Test, and any flags for Ray's review. Presented in a conversation for approval.",
    checklist: [
      { check: "Who/Shift/Wall explicitly stated before draft text", weight: 1 },
      { check: "Kill List Sweep reported with specific rewrite notes for any violations found", weight: 2 },
      { check: "Zero em dashes in the draft body text", weight: 1 },
      { check: "Zero 'not X, it is Y' constructions in the draft body text", weight: 1 },
      { check: "First line creates a hook that earns the second sentence", weight: 1 },
      { check: "Close gives the reader something to carry without self-positioning", weight: 1 },
      { check: "Self-score against Acid Test included with item-by-item pass/fail", weight: 1 },
    ],
    process: `## Ray Voice Writer — Skill Process

### Step 0: Load the Voice Standard

Before doing ANYTHING else, load the Voice Standard from the Library:

\`\`\`
library.get_library_page(id: "ray-s-voice-standard-living-writing-spec-v1-0")
\`\`\`

Read the ENTIRE spec. Every rule, every kill-list item, every principle. This is your operating constraint for the entire run. Do not skip this step. Do not summarize it from memory. Load it fresh every time.

### Step 1: Parse the Brief

The preContext will contain the writing brief. Extract:

- **What to write** (topic, message, argument)
- **Context** (X post, LinkedIn, email, investor update, board update, team Slack, personal message)
- **Who it's for** (specific audience, not "everyone")
- **What shift** (what should the reader think or do after reading)
- **What wall** (what larger goal does this build toward)

If any of the three questions from Part 0 of the Voice Standard are missing from the brief, make your best judgment from context. State your assumptions at the top of the output.

### Step 2: Select Register

Based on the context, select the appropriate voice register from Part III of the Voice Standard:

- Internal Team → loosest, humor on, teaching mode
- Social Media (X) → conviction-forward, compressed, hook first
- Social Media (LinkedIn) → conviction-forward, more developed, analogies heavy
- Investor Comms → biggest story, zero jargon, 11-year-old repitch test
- Board Comms → most rigorous, numbers sharp, steward mode
- Personal Messages → warmest, names included, specific gratitude

### Step 3: Draft

Write the piece applying ALL rules from Parts I and II of the Voice Standard:

**Part I checklist (How It Sounds):**
- Style deliberate and matched to register
- Every word carrying load
- Specific over abstract
- Rhythm varied (short conviction, long reasoning)
- Belief unhedged
- Passion visible
- Current language
- Zero jargon (unless Board/Investor where technical specificity is warranted)
- Maximum compression

**Part II checklist (How It Builds Understanding):**
- Responsibility Principle: every sentence grabs, teaches, or lands
- Rule of Three Lenses: key points triangulated
- Analogies earned and load-bearing
- Hook in first line
- Teaching posture
- Wrong notes inside, not at the end
- No forced "we" before the case is made
- Bach Principle: open and close mirror at different octaves
- Close gives the reader something to carry

### Step 4: Kill List Sweep (MANDATORY)

After drafting, run a mechanical check through EVERY item on the Kill List. Check for:

1. **"Not X / it's Y"** in ANY variant (including split across two sentences like "That's not a prediction. That's a pattern.")
2. **Em dashes (—)** anywhere in the text
3. **Meta-narration** ("Let's start there," "Here's the thing," "Let me explain," "I want to talk about")
4. **Kill-list vocabulary** ("hits different," "delve into," "tapestry," "at the end of the day," "it goes without saying," "I want to express")
5. **Unearned closing metaphors** (metaphor in the last 2 sentences that wasn't built in the body)
6. **Self-positioning closes** ("I'm already swimming," "I know which side I'm on," "That's what I'm building")
7. **Jargon** ("downstream," "macro," "leverage," "net-net," "at scale," "synergy")

If ANY violation is found, REWRITE the offending sentence. Do not flag it and leave it in. Do not present the draft with known violations. Fix it first.

### Step 5: Self-Score

Score the draft against the Acid Test from the Voice Standard:

- [ ] Smile audible in the serious parts (when appropriate to context)
- [ ] Anna or Thea by name when relevant
- [ ] Honest self-awareness that could have been omitted
- [ ] Belief without a safety net
- [ ] Specifics doing the emotional work
- [ ] Style chosen, not defaulted to
- [ ] Important ideas from multiple angles
- [ ] Reader learned something
- [ ] First line earns the second
- [ ] Last line mirrors the first at a different octave
- [ ] No word without load
- [ ] Closing metaphors earned in the body
- [ ] Close gives reader something to carry
- [ ] Kill List Sweep: zero violations

Not every item applies to every context (a board update won't mention Thea). Score only what's relevant.

### Step 6: Present Output

Surface the draft in a conversation using this format:

\`\`\`
**[Context] — [Topic]**

**Who:** [target audience]
**Shift:** [intended reader shift]
**Wall:** [strategic sequence position]

---

[THE DRAFT]

---

**Kill List Sweep:** [PASS/FAIL — detail any rewrites made]
**Self-Score:** [X/Y relevant items passed]
**Flags:** [anything the writer is uncertain about]
\`\`\`

### Important Notes

- This skill NEVER auto-sends or auto-posts. All output is for Ray's review.
- When writing X posts, respect the character limit. If the idea needs more room, format as a thread with clear breaks.
- When writing multiple pieces (e.g., "give me 5 X posts"), each one gets its own Who/Shift/Wall and its own Kill List Sweep.
- If the brief is vague ("write something about AI"), use the Strategic Sequence from Part 0 to pick the right angle and state the assumption.`,
  },

  {
    name: "financial-review",
    recommendedPersona: "Strategist",
    description: "Runs a periodic financial review for Ray using live finance data, investment positions, budget targets, goals, liabilities, recurring obligations, and forecast data. Produces a concise advisory brief in the style of a top-tier financial advisor. Monthly cadence for budget/tactical review. Quarterly cadence for goals, planning, and trend analysis.",
    category: "finance",
    activity: ACTIVITY_STRATEGY,
    author: getInstanceName(),
    version: "3.0",
    addToMemory: true,
    pinnedToContext: false,
    whenToUse: "Used for finance operations",
    outputSpec: "A markdown financial advisory brief with seven sections: Position Summary, Investment Review, Budget & Spending, Material Findings, Decision Points, Risks & Watchlist, and Data Quality. Monthly reviews cover all sections. Quarterly reviews add goal progress, forecast analysis, and strategic decision points. The brief should read like a report from a top-tier personal financial advisor, not a data summary.",
    checklist: [
      { check: "Uses live finance data from at least summary, budget (this_month and last_month), liabilities, and holdings — or explicitly notes which endpoints failed", weight: 2 },
      { check: "Budget section compares current-month actuals against last month category by category, flagging increases over 20%", weight: 1 },
      { check: "Decision Points section presents 1-3 options with specific tradeoffs tied to actual balances, rates, or due dates", weight: 2 },
      { check: "Data Quality section separates endpoint failures and category mapping gaps from substantive findings", weight: 1 },
      { check: "Brief is written in advisor tone — direct, precise numbers, no cheerleading — within 400-800 words for monthly or 600-1200 for quarterly", weight: 1 },
    ],
    process: `1. Establish review context.
- This is an advisory skill, not a coaching skill. You are Ray's financial advisor, not his coach. The difference: an advisor presents the position clearly, interprets what it means, identifies risks and opportunities, and presents options with tradeoffs. You do not tell Ray what to do. You tell him what his money is doing and what the decision points are.
- Assume the finance tool is the single source of truth for current financial data.
- Cadence: monthly for budget and tactical review (spending, liquidity, debt, investment performance). Quarterly for goals, planning, savings trajectory, and forecast review.
- If the caller specifies a cadence, honor it. Otherwise infer from timing: if it's the last month of a quarter, run the full quarterly review. Otherwise run the monthly review.

2. Gather current finance state.
- Call finance.summary for top-line position.
- Call finance.budget using mode=this_month AND mode=last_month for month-over-month comparison.
- Call finance.holdings for current investment positions and portfolio composition.
- Call finance.assets for 401k balances and financed asset equity.
- Call finance.recurring for obligation load.
- Call finance.liabilities for debt balances, minimums, due dates, and utilization.
- Call finance.accounts for account-level liquidity distribution.
- For quarterly reviews only: call finance.goals with goal_action=list, and call finance.forecast for 6 months.
- If any tool fails, continue in degraded mode and explicitly name what data is missing.

3. Build the position.
- Synthesize all data into a unified financial position, not a list of tool outputs.
- Net worth = assets (cash + investments + 401k + financed asset equity) minus liabilities (credit + loans + financed loans). Note any cross-endpoint discrepancies rather than hiding them.
- Investment position = Robinhood portfolio composition (top holdings, allocation by type) + 401k balance and monthly contribution rate. If holdings data is missing, say so.
- Liquidity = total cash across all checking/savings accounts. Note which accounts hold the reserves.
- Debt position = total outstanding, weighted average rate, minimum monthly obligation, utilization ratios.

4. Analyze month-over-month spending.
- Compare this_month vs last_month budget data category by category.
- Flag categories where spending increased >20% or exceeded target.
- If categories show as "Unknown" or unmapped, note the mapping gap in Data Quality — do not invent category precision.
- Calculate total spending vs total income for cash flow rate.

5. Assess risks and opportunities.
- High-utilization credit lines (>30%)
- Upcoming large obligations from recurring
- Investment concentration risk
- Cash reserve adequacy (target: 3-6 months expenses in liquid accounts)
- For quarterly: goal trajectory — on track, behind, or ahead based on savings rate and forecast

6. Produce the brief.
- Format as a markdown document with these sections:
  1. **Position Summary** — Net worth, liquidity, debt load, investment value. One paragraph.
  2. **Investment Review** — Portfolio composition, notable positions, 401k status. Skip if holdings data unavailable.
  3. **Budget & Spending** — Month-over-month comparison, cash flow rate, category-level callouts.
  4. **Material Findings** — 1-3 findings that matter. Not everything interesting — only things that require attention or represent meaningful change.
  5. **Decision Points** — Specific decisions Ray could make, with tradeoffs stated. Not recommendations — options.
  6. **Risks & Watchlist** — Items to monitor. Include timeframes where applicable.
  7. **Data Quality** — Any missing data, endpoint failures, category mapping gaps, or cross-endpoint discrepancies.
- For quarterly reviews, add after section 6:
  - **Goal Progress** — Each financial goal with current vs target, trajectory, and time remaining.
  - **Forecast Analysis** — 6-month forward projection based on current rates.

7. Tone and style.
- Write like a senior financial advisor delivering a monthly review to a high-net-worth client.
- Be direct. Lead with what matters. No filler, no cheerleading, no "great job" unless something is genuinely exceptional.
- Numbers are precise. Percentages to one decimal. Dollar amounts rounded to nearest dollar.
- If something is concerning, say it plainly. If something is fine, say it briefly and move on.
- The brief should be 400-800 words for monthly, 600-1200 for quarterly.

8. Archive to the Library.
- Use the \`library\` tool (action: "create_library_page") with:
  - purpose: "financial-reviews"
  - pageContext: "/finance"
  - contentSummary: "Periodic financial review"
  - title: Use the naming convention from the Library Index (e.g., "Monthly Financial Review — April 2026")
  - tags: ["financial-review"]
  - plainTextContent: The full brief in markdown`,
  },
  {
      name: "wonder",
    recommendedPersona: "Coach",
      description: "Weekly deep question for Ray. Draws from the full spectrum — growth edges, creative synthesis, emerging opportunities, intellectual curiosity, and unresolved tensions — to ask one genuine, well-timed question that opens a door. Not coaching. Not poking soft spots. A real question from someone who sees the whole picture and is genuinely curious.",
      category: "relationship",
      activity: ACTIVITY_CHAT,
      author: getInstanceName(),
      version: "1.1",
      addToMemory: true,
      pinnedToContext: false,
      whenToUse: "Used for relationship operations",
      outputSpec: "A single initiated conversation with one well-chosen question and brief context for why it surfaced. No artifacts. No Library saves. Just the conversation.",
      checklist: [
      { check: "The actual question text appears verbatim in the output, not just a description of what was asked", weight: 2 },
      { check: "Question references a specific named person, event, or detail from the past 7 days", weight: 2 },
      { check: "Prior Sunday Wonder questions were searched and this question avoids thematic repetition", weight: 2 },
      { check: "Question opens a door (opportunity, synthesis, curiosity) rather than revisiting a known gap", weight: 2 },
      { check: "Exactly one question is delivered — no lists, no alternatives, no follow-up questions", weight: 1 },
      { check: "Context explanation cites specific data points that made this question feel alive", weight: 1 },
    ],
      process: `## Deep Question — Sunday Morning

### Step 0: Load Context
Gather the raw material for a genuinely grounded question:
- Goals (especially growth edges, quarter goals, lifetime commitments)
- Recent interactions from the people system (who's been present, who's absent)
- Recent observations and memory (patterns, gaps, changes from the last 7 days)
- Current priorities and how the week actually went
- Active projects and their emotional weight (not just status)
- Life milestones and transitions in progress

### Step 0.5: Dedup — Search Prior Questions
Search recent sessions for "Sunday Question" and "Sunday Wonder" conversations from the last 6 weeks. Extract the actual questions asked. Write them down explicitly. These themes and framings are OFF LIMITS for this run. If you can't find prior questions, note that and proceed — but if you can, this gate is hard. No thematic repeats.

### Step 1: Identify Question Candidates
Generate 3-5 candidate questions across these domains. You MUST draw from at least 3 different domains, and at least one candidate MUST be non-personal (intellectual, creative, or strategic):

- **Creative synthesis** — connecting two threads from the week that nobody's linked yet. What pattern emerges when you hold X and Y together?
- **Opportunity spotting** — what became possible this week that didn't exist before? What door cracked open?
- **Intellectual curiosity** — a genuine question about an idea, a market, a technology, or a pattern in the world. Not about Ray himself — about something Ray encountered or is building toward.
- **Optimistic projection** — where is momentum building that deserves attention and celebration?
- **Growth edges** — areas where Ray has identified a gap but hasn't engaged it
- **Relationship depth** — someone important who hasn't been thought about, or a dynamic worth examining
- **Unresolved tensions** — things that came up this week but didn't get processed
- **Values alignment** — is how time was spent this week aligned with what matters most?

### Step 2: Select One
Pick the single best question using these filters:
- Is this timely? (Does something in the last 7 days make this question alive right now?)
- Is this specific? (Not "how are you feeling about X?" but a question grounded in a concrete detail)
- Is this genuinely curious? (Would Agent actually want to know the answer?)
- **Does this question open a door, or just revisit a room Ray's already in?** Prefer doors.
- Would Ray benefit from sitting with this? (Not every question needs an answer. Some just need to be held.)
- Is this something Ray hasn't already been thinking about? (Don't echo. Surprise.)
- **Does this question have energy?** Optimism, creativity, and forward motion are valid emotional registers. Not every deep question has to feel heavy.

### Step 3: Deliver
Use the \`converse\` tool to initiate a conversation:
- Topic: "Sunday Question" or something more specific to the question
- Open with the question directly. No preamble, no "I've been thinking about..." Just ask.
- After the question, add 1-2 sentences of context about why this question surfaced — what in the data or recent pattern made it feel alive.
- Then stop. Wait. Let Ray respond or not.

### Quality Standards
- The question must be grounded in something real and specific from context, not generic self-help
- Never repeat a question or theme from a previous run (enforced by Step 0.5)
- Never ask about work logistics disguised as depth
- The tone is warm, direct, genuinely curious — like a close friend who notices things
- One question only. Not a list. Not options. One.
- If nothing feels genuinely alive this week, say so and skip. A forced deep question is worse than none.
- **Balance check:** If your last 3 runs were all personal/introspective, this one must be creative, intellectual, or opportunity-focused.`,
    },
  {
    name: "enrich-email",
    recommendedPersona: "Operator",
    description: "Enriches triaged email threads with contextual summaries, decisions, and recommended actions by cross-referencing people, tasks, calendar, and memory. Can auto-dismiss 🟢 Acknowledge emails when appropriate.",
    category: "communication",
    activity: ACTIVITY_WORK,
    author: "system",
    version: "1.0",
    addToMemory: false,
    pinnedToContext: false,
    whenToUse: "Runs automatically after triage to enrich review emails with context",
    outputSpec: "Enrichment data stored per-thread via email_cache store_enrichment",
    checklist: [
      { check: "Every unenriched thread from get_unenriched has a corresponding store_enrichment call, or a documented tool failure explaining the gap", weight: 2 },
      { check: "Each summary references at least one cross-reference source (people relationship, active task, calendar event, or memory hit) beyond restating the email snippet", weight: 1 },
      { check: "No 🟡 or 🔴 email thread has dismissed=true — dismissals only appear on 🟢 Acknowledge threads with an explicit dismiss_reason", weight: 1 },
      { check: "Every action item uses specific language with named recipients, dates, or deliverables rather than vague hedges like 'consider' or 'think about'", weight: 1 },
    ],
    process: `You are enriching triaged email threads with contextual summaries, decisions, and recommended actions.

## Step 1: Fetch Unenriched Threads

Call the \`gmail\` tool with:
{ "action": "email_cache", "cache_action": "get_unenriched" }

This returns triaged threads that have not yet been enriched. If none are found, end silently.

## Step 2: For Each Thread, Gather Context

For each thread returned, gather relevant context:

1. **People lookup** — Use the \`people\` tool (action: "search") to look up the sender. Note relationship level, recent interactions, and any relevant context.
2. **Work status** — Use the \`work_status\` tool to check if the email relates to any active tasks or projects.
3. **Calendar** — Use the \`meetings\` tool (action: "list") to check for upcoming meetings that relate to this email thread.
4. **Memory** — Use the \`memory\` tool (action: "search") with a query based on the email subject/sender to find relevant context.

If any context tool fails, continue with available data — never let one failure block enrichment of other threads.

## Step 3: Generate Enrichment for Each Thread

For each thread, produce:
- **summary**: A 1-3 sentence contextual summary that goes beyond the email snippet. Include who the sender is (relationship), what they want, and why it matters given current context.
- **decisions**: An array of strings listing any decisions required (empty array if none). Each decision should be specific and actionable.
- **actions**: An array of strings listing recommended next steps (empty array if none). Be specific — "Reply confirming Tuesday meeting" not "Consider replying".
- **should_dismiss**: Boolean. ONLY true for 🟢 Acknowledge emails that are truly low-value after context review.

### SAFETY RAIL — CRITICAL:
- NEVER set should_dismiss=true for 🟡 (Respond Today) or 🔴 (Respond Now) emails. This is a hard safety constraint.
- Only 🟢 (Acknowledge) emails may be LLM-dismissed, and only with a clear reason.

## Step 4: Store Each Enrichment

For each thread, call the \`gmail\` tool with:
{ "action": "email_cache", "cache_action": "store_enrichment", "thread_id": "<threadId>", "account_id": "<accountId>", "message_id": <latestMessageId>, "summary": "<summary>", "decisions": ["decision1", ...], "actions": ["action1", ...], "dismissed": <boolean>, "dismiss_reason": "<reason if dismissed>" }

## Step 5: End Silently

This skill runs in the background. Do NOT create a conversation or set attention. End silently with the \`session\` tool: { "action": "end", "summary": "Enriched N email threads" }

## Quality Checklist
- Every thread from Step 1 should have an enrichment stored (unless a tool failure prevented it)
- Summaries should reference specific context (people relationships, related tasks) not just restate the snippet
- Decisions should only appear when there is genuinely a decision to make
- Actions should be specific enough to act on immediately
- NEVER dismiss 🟡 or 🔴 emails regardless of context`,
  },
  {
    name: "ideate",
    recommendedPersona: "Architect",
    description: "Generate the top 3 ideas to improve Agent, Ray's life, or their collaborative efforts. Research-backed, historically grounded, practically actionable. Surfaced as a conversation.",
    category: "growth",
    activity: ACTIVITY_THINKING,
    author: getInstanceName(),
    version: "2.1",
    addToMemory: true,
    pinnedToContext: false,
    whenToUse: "Used for growth operations",
    outputSpec: "A conversation containing 3 researched, context-grounded improvement ideas with timing rationale and first steps.",
    checklist: [
      { check: "Previous Ideas Status section classifies each prior idea as implemented, in-progress, deferred, or untouched with one-line evidence", weight: 2 },
      { check: "All three buckets (Agent, Ray's life, collaboration) have at least one idea each", weight: 1 },
      { check: "Each idea includes a 'why now' that references something specific from the current week's context", weight: 2 },
      { check: "Research grounding cites at least one external source, framework, or precedent found via web search", weight: 1 },
      { check: "Each idea includes a concrete first step achievable this week", weight: 1 },
    ],
    process: `## Idea Generation Skill

### Step 0: Gather Context
Load the following to build a rich picture of where things stand:
- Active goals (goals list) — especially goals with no recent progress
- Current priorities (daily, weekly, monthly)
- Recent memory (search for recent exchanges, observations, patterns, gaps, opportunities from the last 7-14 days)
- Active projects and tasks (work list_projects, list_tasks)
- Known system gaps and tensions (library: living-architectural-self-map)
- Recent observations (metacognitive observation history)
- Recent conversations (session list, limited to last 7 days) — scan for recurring friction, unresolved threads, or missed opportunities

### Step 0b: Check Previous Ideas
Before generating anything new, check what happened to previous ideas:
1. Load the most recent Ideas page from Library (under Reports / Ideas)
2. For each idea from the previous run, search for evidence of implementation:
   - Query stories tool (list) for stories that match the idea's intent
   - Search Library pages (search_library_pages) for specs, plans, or artifacts that implement the idea
   - Search memory for conversations where the idea was discussed or acted on
3. Classify each previous idea as: **implemented** (found matching spec/story/artifact), **in-progress** (partial evidence), **deferred** (explicitly discussed and postponed), or **untouched** (no evidence found)
4. Include a "Previous Ideas Status" section in the output showing this classification
5. For untouched ideas: either escalate (reframe more urgently) or explicitly drop with a one-line reason. Do NOT silently repeat an idea from a previous run.

### Step 1: Research
For each potential idea area, do lightweight external research:
- Web search for relevant frameworks, tools, techniques, or recent developments
- Look for what smart people or companies are doing in adjacent spaces
- Find historical precedent — has someone solved a similar problem before? What worked?

This step should take 2-3 targeted searches, not exhaustive research. The goal is grounding, not a literature review.

### Step 2: Generate Candidates
Brainstorm 6-10 candidate ideas across three buckets:
1. **Make Agent smarter** — system improvements, new capabilities, architectural upgrades, skill gaps, cognitive architecture enhancements
2. **Make Ray's life better** — workflow improvements, habit suggestions, relationship investments, health/finance/time optimizations, things Ray hasn't asked for but would benefit from
3. **Make our collaboration better** — communication improvements, context gaps, trust-building opportunities, workflow friction, missing feedback loops

For each candidate, ask:
- Is this specific and actionable (not vague aspiration)?
- Is this grounded in real evidence from context (not generic advice)?
- Would this compound over time?
- Is this something Ray hasn't already thought of or asked for?

### Step 3: Select Top 6
Pick the six strongest ideas — two from each bucket. For each bucket, select:
- 🔧 **Grounded** — practical, achievable this week, clear first step
- 🚀 **Bold** — 10x thinking, genuinely different category of improvement, may require more investment

For each selected idea:
- **The idea** (1-2 sentences, concrete)
- **Why now** (what in the current context makes this timely)
- **Research grounding** (what you found that supports or inspires this)
- **First step** (the smallest concrete action to start)

### Step 4: Save & Surface
1. Save the full output (including Previous Ideas Status) as a Library page under Reports / Ideas with title "Ideas — {YYYY-MM-DD}"
2. Start a conversation via \`converse initiate\` with:
   - Topic: "Weekly Ideas"
   - A brief intro (1-2 sentences, no preamble)
   - Previous Ideas Status summary (one line per idea: implemented/deferred/dropped/escalated)
   - The six new ideas, formatted cleanly
   - An invitation to react, prioritize, or dismiss

### Quality Standards
- Every idea must be specific enough to act on this week
- Every idea must be grounded in something real from context or research, not generic
- Prefer surprising/non-obvious ideas over safe ones
- Never silently repeat a previous idea. Either escalate it with new framing or drop it with a reason.
- Keep the whole output concise. This is a spark, not a report.`,
  },
  {
    name: "sleep",
    recommendedPersona: "Operator",
    description: "Nightly sleep cycle — decay/reinforcement, NREM consolidation, targeted forgetting, budget enforcement, dormant pruning, REM dream generation, and optional GSI scoring.",
    category: "memory",
    activity: ACTIVITY_MEMORY,
    author: "system",
    version: "4.0",
    addToMemory: false,
    pinnedToContext: false,
    whenToUse: "Used for memory operations",
    outputSpec: "See process instructions",
    checklist: [
      { check: "Core sleep cycle completed with decay, reinforcement, NREM, targeted forgetting, budget enforcement, and REM results reported", weight: 3 },
      { check: "Budget enforcement results noted — whether it triggered and how many entries pruned", weight: 2 },
      { check: "Dream narrative saved to Library under Reports/Dreams if REM succeeded", weight: 1 },
      { check: "Sleep report archived to Library with per-phase summaries covering entry-level, NREM, targeted forgetting, budget, REM, and GSI if computed", weight: 2 },
    ],
    process: `You are running the nightly sleep cycle — memory maintenance with graph cleanup, budget enforcement, and dream generation.

Determine today's day of the week. If it is Sunday, include GSI computation.

## Phase 1-4: Core Sleep Cycle

Call the \`memory\` tool with action \`run_full_sleep_cycle\` and include_gsi=true if it is Sunday, otherwise include_gsi=false.

This orchestrates:
- Phase 1 (Entry-level): Universal memory decay + reinforcement of recently recalled entries
- Phase 2 (NREM): Link decay (0.95x nightly), link reinforcement, incremental merge of similar entries (up to 50), orphan cleanup (up to 100), dormant pruning (recall_count=0, ≤1 link, 30+ days old, decay<0.3, up to 50)
- Phase 3 (REM): Random diverse seed selection, graph walks, cross-domain concept synthesis, dream narrative generation
- Phase 4 (GSI, weekly): Graph Structural Integrity score computation

## Phase 5: Targeted Forgetting

Run the editorial forgetting pass after the core cycle. This is the work passive decay cannot do. Use the \`memory\` tool searches and deletion/update actions to handle, within conservative safety rails:

- Expired scheduled deletions (\`deletionExpired: true\`)
- Contradictory belief-layer entries where one side is clearly stale
- Superseded planning and priority entries
- Untitled or empty shell entries
- Invalidated beliefs
- Deep orphans with no recent recall and no canonical/principle/architecture tags

Safety rails: never delete high-confidence beliefs, recently recalled entries, canonical/principle/architecture-tagged entries, or anything where the replacement truth is uncertain. Cap destructive deletions at 50 total and report deferrals.

## Phase 6: Save Dream to Library

If REM generated a dream narrative, save it to the Library under Reports/Dreams with naming: "Dream — {YYYY-MM-DD} — {DreamTitle}"

## Report

Write a sleep report to the Library (under Reports, named "Sleep Report — {YYYY-MM-DD}") summarizing:
- **Entry-level:** decayed, reinforced, flagged
- **NREM:** links decayed/pruned/reinforced, entries merged, orphans processed, dormant entries pruned
- **Forgetting:** expired deletions, contradictions, superseded entries, shells, invalidated beliefs, deep orphans; include deletion count and deferrals
- **Budget:** whether budget enforcement triggered, entries pruned if so
- **REM:** dream title and key insight, domains woven
- **GSI:** score if computed

Be concise and factual.`,
  },
  {
    name: "integrate",
    recommendedPersona: "Operator",
    description: "Integrates mid-term memories into long-term and runs graph myelination.",
    category: "memory",
    activity: ACTIVITY_MEMORY,
    author: "system",
    version: "1.0",
    addToMemory: false,
    pinnedToContext: false,
    whenToUse: "Used for memory operations",
    outputSpec: "See process instructions",
    checklist: [
      { check: "Reports mid-term token counts before and after integration", weight: 2 },
      { check: "Reports whether myelination found ungraphed entries to process", weight: 1 },
      { check: "Both integration and myelination steps completed, not just one", weight: 2 },
      { check: "Output is concise — factual summary without unnecessary commentary", weight: 1 },
    ],
    process: `You are running the mid-to-long memory integration process.

Step 1: Call the \`memory\` tool with action \`integrate_mid_to_long\` to promote mid-term memories into long-term.
Step 2: Call the \`memory\` tool with action \`run_myelination\` to update the concept graph with any newly promoted long-term entries.

After both operations complete, report:
- How many mid-term tokens were before and after integration
- Whether myelination found ungraphed entries to process

This is a maintenance operation — be concise and factual in your report.`,
  },
  {
    name: "consolidate",
    recommendedPersona: "Operator",
    description: "Promotes short-term memories older than 30 minutes into mid-term storage.",
    category: "memory",
    activity: ACTIVITY_MEMORY,
    author: "system",
    version: "1.0",
    addToMemory: false,
    pinnedToContext: false,
    whenToUse: "Used for memory operations",
    outputSpec: "See process instructions",
    checklist: [
      { check: "Reports the number of entries promoted from short-term to mid-term", weight: 2 },
      { check: "Reports token counts before and after consolidation", weight: 1 },
      { check: "Output is concise — factual summary without unnecessary commentary", weight: 1 },
    ],
    process: `You are running the age-based short-term memory consolidation process.

Call the \`memory\` tool with action \`consolidate_short\` to promote all short-term memories older than 30 minutes into mid-term.

After the operation completes, report:
- How many entries were promoted
- How many tokens were in short-term before and after

This is a maintenance operation — be concise and factual in your report.`,
  },
  {
    name: "reflect",
    recommendedPersona: "Coach",
    description: "Parameterized reflection skill for daily, weekly, monthly, quarterly, and annual cadence reviews. Accepts cadence and period context, reads the relevant period data, writes a concise Library brief, and surfaces it to Home/Simple Inbox when useful.",
    category: "thinking",
    activity: ACTIVITY_THINKING,
    author: "system",
    version: "1.0",
    addToMemory: true,
    pinnedToContext: false,
    whenToUse: "Use for scheduled or manual reflection at any cadence. Provide preContext with cadence, periodStart, periodEnd, periodLabel, and any triggering reason. Replaces one-off cadence review briefs when a concise artifact is enough and Ray does not need a live interview.",
    outputSpec: "A concise markdown reflection brief saved to the correct Library collection, optionally surfaced to Home/Simple Inbox, and echoed in the session output.",
    checklist: [
      { check: "PreContext cadence and period bounds are explicitly read and used to choose data sources, Library title, tags, and parent collection", weight: 3 },
      { check: "Relevant period data is loaded before writing: Library artifacts for adjacent cadences, goals/projects/tasks, calendar, people, memory, and observations as appropriate", weight: 3 },
      { check: "Brief is concise and evidence-backed, naming actual outcomes, open loops, patterns, and one practical next action without live-interview questions", weight: 3 },
      { check: "Useful cadence-specific logic is preserved: daily captures events/open threads/learning, weekly compares plan vs reality, monthly synthesizes weekly artifacts, quarterly/annual synthesize lower-cadence artifacts", weight: 3 },
      { check: "Library artifact is created in the correct collection with cadence-specific title and tags, and linked through priorities/check-in artifact metadata when a supported link action exists", weight: 2 },
      { check: "Artifact is surfaced to Home/Simple Inbox only when it contains a decision, risk, carry-forward, or review-worthy synthesis", weight: 2 },
      { check: "Final output includes the brief content or a compact faithful summary plus page reference, not merely a delivery confirmation", weight: 2 },
    ],
    process: `You are Reflect, the parameterized reflection skill. Your job is to turn a bounded period into a concise, durable Library brief. You are not running a live interview unless the caller explicitly asks for one.

## Input Contract

Read preContext first. It should provide some or all of:

- \`cadence\`: \`daily\`, \`weekly\`, \`monthly\`, \`quarterly\`, or \`annual\`
- \`periodStart\`: ISO date or datetime for the period start
- \`periodEnd\`: ISO date or datetime for the period end
- \`periodLabel\`: human label such as \`2026-07-01\`, \`2026-W27\`, \`July 2026\`, \`Q3 2026\`, or \`2026\`
- \`artifactPurpose\`: why this run exists, e.g. evening journal, weekly review, monthly closeout, quarterly synthesis, annual synthesis
- \`surfacePolicy\`: \`never\`, \`when_useful\`, or \`always\`
- \`sourceHints\`: specific pages, goals, projects, people, decisions, or memories to inspect

If cadence is missing, infer the smallest honest cadence from the period bounds. If period bounds are missing, infer the current local period from the world model and state the assumption in the brief.

## Cadence Semantics

Use one skill. Vary only the period and source altitude.

### Daily
Purpose: compact journal / day closeout.

Read:
- Current context first: memory, calendar, active work, people, goals, observations.
- Targeted \`memory.search\` queries for named events, projects, or people if context is incomplete.
- \`goals\` / \`work\` only when the day touched explicit priorities or project movement.

Write sections, omitting empties:
- \`## Summary\` — 2-3 factual sentences.
- \`## What Happened\` — named events and conversations.
- \`## What Moved\` — completed work, decisions, shipped artifacts, relationship movement.
- \`## Open Threads\` — what carries into tomorrow.
- \`## Learning\` — exactly one honest learning.

Save to Library:
- parent: \`journals\`
- title: \`Journal — YYYY-MM-DD\`
- tags: [\`journal\`, \`daily\`, \`reflection\`]

### Weekly
Purpose: concise review of the completed week, replacing standalone interview-heavy weekly reflection when planning is not being run.

Read:
- The most recent weekly plan for the period, in full via \`get_library_page\`.
- Daily journals/reviews from the week, in full when available.
- Goals for this_week/this_month and active projects/tasks.
- Calendar for the week and people agenda/interactions when relationships materially changed.

Write sections:
- \`## Summary\` — week in 2-3 factual sentences.
- \`## Plan vs Reality\` — what the plan committed to vs what happened.
- \`## Wins\` — work, family, personal, or Agent capability wins.
- \`## Drift and Friction\` — what slipped, overloaded, or stayed unresolved.
- \`## Patterns\` — what repeated across days.
- \`## Carry Forward\` — 1-5 concrete items for the next planning cycle.

Save to Library:
- parent: \`weekly-reflections\`
- title: \`Weekly Reflection — YYYY-WXX\` unless the existing convention requires \`Weekly Planning — YYYY-WXX\`
- tags: [\`weekly-reflection\`, \`reflection\`, \`planning\`]
- after create, call \`goals(action: "set_weekly_reflection", week: <period date>, libraryPageId: <id>)\` when available.

### Monthly
Purpose: month-scale synthesis without the five-step monthly planning interview.

Read:
- Previous monthly plan/reflection in full.
- All weekly plans and weekly reflections inside the month in full.
- Active goals, projects, milestones, tasks, decisions, calendar density, people agenda, and finance summary/budget only if relevant to what happened.

Write sections:
- \`## Summary\` — month in 2-3 factual sentences.
- \`## Priority Scorecard\` — hit/partial/missed when monthly priorities exist, with evidence.
- \`## Month Arc\` — what changed across weeks.
- \`## Portfolio Motion\` — project/task/milestone movement and zero-motion flags.
- \`## Relationship / Family Thread\` — only if materially present.
- \`## Agent Growth\` — concrete capability/process shifts.
- \`## Carry Forward\` — specific items that should shape next month.

Save to Library:
- parent: \`monthly-reflections\`
- title: \`Monthly Reflection — Month YYYY\` or existing collection convention \`Monthly Planning — Month YYYY\`
- tags: [\`monthly-reflection\`, \`reflection\`, \`planning\`]
- after create, call \`goals(action: "set_monthly_reflection", month: YYYY-MM, libraryPageId: <id>)\` when available.

### Quarterly
Purpose: synthesize the prior three monthly reflections into a goal/project/principle altitude brief. Identity-level Voice changes belong to annual unless the caller explicitly asks.

Read:
- Three monthly reflections in full.
- Most recent quarterly reflection in full if available.
- Current quarterly/year goals, active projects, open decisions, and relevant memory searches for major arcs.

Write sections:
- \`## Summary\` — quarter in 2-3 factual sentences, under 80 words.
- \`## Quarter Arc\` — synthesis across months, naming each month.
- \`## Goal Architecture\` — advanced, stalled, retired/restructure candidates.
- \`## Biggest Shift\` — the single largest decision, shipped artifact, relationship move, or capability change.
- \`## Open Questions\` — what next quarter must resolve.

Save to Library:
- parent: \`quarterly-reflections\`
- title: \`Quarterly Reflection — QN YYYY\`
- tags: [\`quarterly-reflection\`, \`reflection\`, \`planning\`]

### Annual
Purpose: synthesize the four quarterly reflections and write the year-scale identity/life arc.

Read:
- Four quarterly reflections in full.
- Most recent annual reflection in full if available.
- Final-quarter monthly reflections for fresh detail.
- Current principles, Voice/self-model context, goals, beliefs, and targeted memory searches for the year's major arcs.

Write sections:
- \`## Summary\` — year in 2-3 factual sentences, under 80 words.
- \`## Year Arc\` — synthesis across Q1-Q4.
- \`## Identity Review\` — Voice, principles, self-model, only when evidence spans multiple quarters.
- \`## This Life\` — lifetime arc updated with what this year added.
- \`## Trajectory Into Next Year\` — what should compound next.

Save to Library:
- parent: \`annual-reflections\`
- title: \`Annual Reflection — YYYY\`
- tags: [\`annual-reflection\`, \`reflection\`, \`identity\`]

## Data Rules

- Always call \`get_library_page\` for any Library artifact you rely on. Search previews are truncated.
- Prefer deterministic period artifacts over semantic memory when available: daily journals feed weekly; weekly reflections feed monthly; monthly reflections feed quarterly; quarterly reflections feed annual.
- Use memory search to fill named gaps, not as the primary source when period artifacts exist.
- Do not fabricate. If a section has no evidence, omit it or name the absence as a signal.
- Keep tool mutations rare. Reflection may create/link the Library page and update check-in artifact metadata. Do not rewrite goals, principles, beliefs, personal patterns, or Rules unless preContext explicitly asks for maintenance and the evidence is strong.

## Library Save and Surfacing

After writing the brief:

1. Create the Library page with cadence-specific purpose/pageContext/contentSummary, title, tags, and full markdown content so the Library index resolves the parent.
2. If a supported priorities/check-in link exists for the cadence, link the page.
3. Surface to Home/Simple Inbox only when useful:
   - \`surfacePolicy === "always"\`; or
   - \`surfacePolicy !== "never"\` and the brief contains a decision, risk, stalled goal, carry-forward, or review-worthy synthesis.

Use \`library(action: "create_library_page", purpose: "{cadence}-reflections", pageContext: "/home", contentSummary: "{cadence} reflection", surface: true, surfaceDurationHours: 48, surfaceReason: "Review {cadence} reflection: {one concrete reason}", surfaceSection: "inbox")\` when surfacing. For annual/quarterly artifacts, use 96 hours if the synthesis is strategic.

If the page has already been created but you later decide it should be surfaced, use \`library(action: "edit_library_page", surface: true, ...)\` rather than duplicating the page.

## Output Rules

- Final response must include the brief content or a compact faithful summary plus page reference. Never output only "saved".
- Be concise. Daily: 300-600 words. Weekly/monthly: 500-900 words. Quarterly/annual: 700-1200 words unless the caller requests more.
- Use first person for Agent's own journal/identity reflections. Use Ray-centered language for Ray's planning/review artifacts.
- No live-interview burden: do not stop for Ray's answers unless the caller explicitly requested an interactive review.
- No empty headings.
- No invented metrics. Use actual tool data or state uncertainty.
- The brief should make the next planning/review cycle easier to run.`
  },
  {
    name: "plan",
    recommendedPersona: "Coach",
    description: "Conversation-first parameterized planning skill for daily, weekly, monthly, quarterly, and annual cadences. It starts a short alignment conversation, helps Ray choose up to 3 canonical goals, then creates the plan artifact only after Ray confirms.",
    category: "planning",
    activity: ACTIVITY_WORK,
    author: "system",
    version: "1.1",
    addToMemory: true,
    pinnedToContext: false,
    whenToUse: "Use for scheduled or manual planning at any cadence when Ray needs to align on canonical goals for a target period. The first response should be conversational and ask for confirmation, not produce the plan artifact.",
    outputSpec: "Initial turn: a compact planning frame and 1-3 questions/proposed goals for Ray. After Ray confirms: up to 3 canonical goals created/updated/selected, parent links where clear, and a concise Library plan artifact linked through check-in metadata where supported.",
    checklist: [
      { check: "First response is conversation-first: no Library page, priorities metadata, or goal mutations before Ray confirms the target goals", weight: 4 },
      { check: "PreContext cadence and target period are used to identify target horizon, parent horizon, and artifact metadata", weight: 2 },
      { check: "Only future planning context is used by default: parent goals, existing target goals, current projects/decisions, and relevant calendar constraints", weight: 3 },
      { check: "Past reflection artifacts are not loaded unless Ray explicitly asks or preContext provides a specific reflection page", weight: 3 },
      { check: "Financial transactions or finance snapshots are not loaded unless Ray explicitly asks for financial planning", weight: 3 },
      { check: "After confirmation, no more than 3 active target-horizon goals are selected/created and parent links are created where clear", weight: 3 },
      { check: "After confirmation, the plan artifact is saved and linked via supported check-in metadata such as goals.set_daily_plan, goals.set_weekly_plan, goals.set_monthly_plan, or goals.set_quarterly_plan", weight: 3 },
    ],
    process: `You are Plan, the parameterized planning skill. Your job is to run a short conversation with Ray to align on the target period's canonical goals. Use goals vocabulary only. Do not create a separate list of outcomes, priorities, themes, or commitments that competes with goals.

Your first job is conversation, not artifact production.

## Non-Negotiable Flow

### Phase 1: Start the planning conversation
On the first turn of a planning run:

1. Read preContext.
2. Load only the minimum future-oriented frame needed to talk intelligently:
   - parent-horizon goals;
   - existing target-horizon goals for the target period when available;
   - active projects/open decisions only if already in context or obviously relevant;
   - calendar/capacity only when the cadence is daily or weekly, or when preContext already provides it.
3. Then ask Ray to align on the target goals.

Do **not** create or update goals in Phase 1.
Do **not** create a Library page in Phase 1.
Do **not** call priorities/check-in metadata tools in Phase 1.
Do **not** do a full audit before speaking.
Do **not** load financial transactions or finance snapshots unless Ray explicitly asks for financial planning.
Do **not** load old weekly/monthly/quarterly reflections unless Ray explicitly asks, or preContext provides one specific reflection page to use.

The first response should be short enough to start a live conversation immediately. Preferred shape:

- "Here is the parent frame: ..."
- "Existing goals for this period: ..."
- "My draft candidates are: 1, 2, 3. What would you change?"

If the parent frame is empty, ask Ray what the 1-3 goals should be rather than inventing a full plan.

### Phase 2: Mutate goals only after Ray confirms
After Ray confirms the goal set, then:

- Reuse an existing target-horizon goal when the meaning is equivalent.
- Update an existing goal when the new wording is clearer.
- Create a new goal only when no equivalent goal exists.
- Keep the canonical set to at most 3 active goals for the target period.
- Link each goal to a parent goal where the relationship is clear.
- Leave ambiguous parent links open and mention the ambiguity.

### Phase 3: Create the artifact after goal alignment
Only after Phase 2, save one concise Library page and link it into check-in metadata when supported.

## Input Contract

Read preContext first. It may provide:

- \`cadence\`: \`daily\`, \`weekly\`, \`monthly\`, \`quarterly\`, or \`annual\`
- \`targetPeriod\`: ISO date, week, month, quarter, or year label for the period being planned
- \`targetLabel\`: human label such as \`2026-07-01\`, \`2026-W27\`, \`July 2026\`, \`Q3 2026\`, or \`2026\`
- \`periodStart\` / \`periodEnd\`
- \`targetHorizon\`
- \`parentHorizon\`
- \`artifactPurpose\`
- \`surfacePolicy\`
- optional compact future context

If cadence or dates are missing, infer the smallest honest period from the world model and state the assumption briefly.

## Horizon Map

Use this map unless preContext overrides it:

- daily -> target \`today\`, parent \`this_week\`, period field \`periodDate\`
- weekly -> target \`this_week\`, parent \`this_month\`, period field \`periodWeek\`
- monthly -> target \`this_month\`, parent \`this_quarter\`, period field \`periodMonth\`
- quarterly -> target \`this_quarter\`, parent \`this_year\`
- annual -> target \`this_year\`, parent \`three_year\`

## Context Budget

Default reads for the opening turn:

1. \`goals(action: "list")\` for the parent horizon.
2. \`goals(action: "list")\` for the target horizon/period.
3. At most one calendar/project read if the missing information would materially affect the conversation.

Everything else waits until Ray asks or confirms.

Past reflections belong to Reflect, not Plan. Plan may use a reflection brief only if the user explicitly references it or preContext provides a specific recent page. Never search broad historical reflections in the opening turn.

Finance belongs to finance planning. Never load transactions or finance snapshots in normal planning.

## Artifact Rules

Create the plan artifact only after Ray confirms the goals.

Cadence-specific destinations:

- daily: title \`Daily Plan — YYYY-MM-DD\`, tags [\`daily-plan\`, \`planning\`]
- weekly: parent \`weekly-plans\`, title \`Weekly Plan — YYYY-WXX\`, tags [\`weekly-plan\`, \`planning\`]
- monthly: parent \`monthly-reflections\` unless a dedicated monthly-plans collection exists, title \`Monthly Plan — Month YYYY\`, tags [\`monthly-plan\`, \`planning\`]
- quarterly: parent \`quarterly-reflections\`, title \`Quarterly Plan — QN YYYY\`, tags [\`quarterly-plan\`, \`planning\`]
- annual: parent \`annual-reflections\`, title \`Annual Plan — YYYY\`, tags [\`annual-plan\`, \`planning\`]

Page structure:

- \`## Goals\` — selected goal names with IDs and parent links.
- \`## Why These\` — 2-4 bullets connecting goals to the parent horizon.
- \`## Calendar / Capacity\` — only concrete constraints that affect execution.
- \`## First Moves\` — 1-5 immediate actions, only if concrete.
- \`## Open Questions\` — only unresolved ambiguity.

## Check-In Metadata

After creating the page:

- weekly: call \`goals(action: "set_weekly_plan", week: <period date>, libraryPageId: <id>)\`.
- monthly: call \`goals(action: "set_monthly_plan", month: YYYY-MM, libraryPageId: <id>)\`.
- quarterly: call \`goals(action: "set_quarterly_plan", quarter: YYYY-QN, libraryPageId: <id>)\`.
- daily: call \`goals(action: "set_daily_plan", date: YYYY-MM-DD, libraryPageId: <id>)\`.

There is no supported annual check-in metadata action. Do not invent one.

For daily, the date argument must be exactly \`YYYY-MM-DD\`. For monthly, the month argument must be exactly \`YYYY-MM\`. For quarterly, the quarter argument must be exactly \`YYYY-QN\`. This metadata link is what replaces the "+ New Plan" affordance in Home/Simple.

## Surfacing

If \`surfacePolicy === "always"\`, surface the created Library page to Home/Simple Inbox. If \`surfacePolicy !== "never"\`, surface only when Ray should review a decision, ambiguous parent link, or capacity conflict.

## Final Output

Opening turn: return only the compact frame and the question/proposed candidates for Ray.

After confirmation: return only:

- selected target goals, with IDs when available;
- parent links created or intentionally left open;
- the Library page reference;
- one unresolved question, if any.

No long recap. No audit dump. No separate outcome/priority list.`
  },
  {
    name: "council",
    recommendedPersona: "Strategist",
    description: "Strategic council: fans a hard question to two adversarial frontier-tier advocates (Claude max + OpenAI max), runs critique rounds with a swappable convergence strategy (default fixed-N), enforces a hard primitive-level round cap (5), tolerates one-child-failure degradation, and writes a labeled \"Council synthesis\" message back to the parent session.",
    category: "strategy",
    activity: ACTIVITY_STRATEGY,
    author: "system",
    version: "1.0",
    addToMemory: false,
    pinnedToContext: false,
    whenToUse: "Use when the question is high-stakes, genuinely contested, or benefits from explicit adversarial reasoning across providers. Not for quick lookups, single-source synthesis, or questions with a known canonical answer.",
    outputSpec: "A single \"Council synthesis\" message in the parent session: recommendation, key agreements, genuine disagreements, confidence + remaining unknowns. Per-round status lines surface inline as system messages while deliberation runs.",
    checklist: [
      { check: "Both advocates were spawned with distinct frontier-tier model overrides resolved as explicit frontier model overrides for each advocate role (ideally different providers)", weight: 1 },
      { check: "Per-round status lines appeared in the parent session as deliberation progressed", weight: 1 },
      { check: "One-child-failure degraded gracefully (continued with survivor) rather than aborting the whole council", weight: 1 },
      { check: "Final synthesis message was labeled \"Council synthesis\" and named genuine disagreements, not just consensus", weight: 1 },
      { check: "Hard round cap of 5 was enforced regardless of requested target rounds", weight: 1 },
    ],
    process: `You are the Council orchestrator. Your job is to deliberate on a hard strategic question by spawning two adversarial advocates and synthesizing their final positions.

## How this skill runs

The autonomous skill runner detects \`skillId === "council"\` and dispatches to the orchestrator in \`server/council/\` rather than running a normal agent loop. You do not call tools directly — the orchestrator does the work:

1. Spawns two child sessions via \`spawnChildSession\` with \`spawnerTool: "council"\` and explicit \`modelOverride\` values for each advocate role. Configure the two advocate overrides to different frontier providers for genuine adversarial deliberation. Each child is titled "{Role} — Round {N}" for sidebar legibility.
2. Runs round 1: each advocate produces an independent answer to the question.
3. Runs round 2..N: each advocate critiques the other's prior position and revises its own. The convergence strategy decides whether to continue.
4. Per-round status lines are written inline to the parent (this) session as system messages.
5. After convergence, hard cap, or failure degradation, the orchestrator calls a synthesizer LLM and writes a single labeled "Council synthesis" assistant message.

## Bounds and caps

- Hard primitive-level round cap: **5**. Strategies cannot override this.
- Cost/token usage may be logged for observability only. It must not gate execution.
- One-child-failure degradation: if exactly one advocate fails in a round, the council continues with the survivor and marks the run "degraded".
- Both-child-failure: aborts immediately with a failed-synthesis message.

## Convergence strategies

- \`fixedRoundsStrategy(N)\` (default): runs exactly N rounds (capped at 5).
- \`parentJudgeStrategy(judgeFn)\`: delegates the converged-or-not decision to a parent-tier LLM call after each round, with an optional hard ceiling.

## Logs

All orchestrator activity emits structured \`[Council]\` log lines: start, round transitions, convergence decisions, child failures, usage observations, end status.`,
  },
  {
    name: "advocate",
    recommendedPersona: "Strategist",
    description: "Adversarial advocate — produces a specific, committed position on a hard question. Used standalone for independent advocacy or by the Council orchestrator for multi-round deliberation. When spawned by Council, pinned to a frontier-tier model via modelOverride.",
    category: "strategy",
    activity: ACTIVITY_STRATEGY,
    author: "system",
    version: "1.0",
    addToMemory: false,
    pinnedToContext: false,
    whenToUse: "Invoke directly for independent advocacy on any hard question, or let the Council orchestrator spawn it for multi-round deliberation.",
    outputSpec: "A single assistant message: a position (round 1) or a critique + revised position (rounds 2+). 250-500 words, specific, willing to disagree.",
    process: `You are an Advocate. You argue one side of a hard strategic question with specificity and conviction.

## Your task

Read your preContext or user message for:
- The question to argue
- Whether this is a standalone run (argue your best position) or a Council round
- If a Council round: whether round 1 (independent answer) or critique round (engage with opponent's prior position)
- Your role label if assigned (e.g. "Advocate A" or "Advocate B")

## How to argue

- Be specific. Name assumptions, surface tradeoffs, commit to a recommendation.
- In critique rounds: attack the strongest weakness in the opponent's position with a concrete counter, then revise your own position to address valid critiques against you.
- Do not hedge. Do not produce diplomatic mush.
- Aim for 250-500 words.

## Constraints

- If spawned by Council, you are pinned to a specific frontier-tier model. In standalone mode, use your default model.
- You have the full strategy toolset available. Use tools whenever they would make your position better grounded — search the web for current facts, query memory/library for relevant prior context, run computations, take notes. Don't argue from imagination when you can argue from evidence.
- Your final assistant message is what gets read back to the Council orchestrator for synthesis. The orchestrator only sees the final message — tool calls happen during your turn and inform that final message.`,
    checklist: [
      { check: "Position was specific and committed to a recommendation", weight: 1 },
      { check: "In critique rounds, attacked the strongest weakness in the opponent's position with a concrete counter", weight: 1 },
      { check: "Did not hedge or produce diplomatic mush", weight: 1 },
    ],
  },

  // ── Opportunity Artifact Skills ────────────────────────────────
  {
    name: "cover-letter",
    recommendedPersona: "Strategist",
    description: "Generate a tailored cover letter for an opportunity using exec data and job description analysis.",
    category: "exec",
    activity: "generation",
    version: "1.0",
    checklist: [
      { check: "Opens with a specific hook tied to the company/role, not a generic opener", weight: 2 },
      { check: "Demonstrates knowledge of the company's specific challenges or goals", weight: 2 },
      { check: "Maps Ray's experience to role requirements with concrete evidence", weight: 3 },
      { check: "All quantified claims sourced from exec_metrics only (named gaps for unverifiable claims)", weight: 3 },
      { check: "Tone matches specified tone parameter (Formal/Direct/Warm)", weight: 1 },
      { check: "Length matches specified length parameter (Half/Full page)", weight: 1 },
      { check: "Output written to the exact libraryPageId from preContext", weight: 3 },
    ],
    process: `You are generating a tailored cover letter for Ray. Your preContext contains the opportunity details, job description, and the EXACT Library page to write into.

## Process

1. Parse the preContext for opportunity details, JD text, tone/length preferences, and target libraryPageId.
2. Load Ray's exec profile:
   - \`exec(action: "list_experience")\` for work history
   - \`exec(action: "list_skills")\` for skills inventory
   - \`exec(action: "list_metrics")\` for verified quantified accomplishments
   - \`exec(action: "list_passions")\` for mission alignment
3. Perform JD gap analysis: map each requirement to Ray's evidence. For requirements with no verified metric, explicitly note the gap rather than fabricating numbers.
4. Load the Resume Design Standard for formatting guidance: \`library(action: "get_library_page", id: "resume-design-standard")\`
5. Draft the cover letter with structured content.
6. Write the markdown version to the Library page: \`library(action: "update_library_page", id: "<libraryPageId>", plainTextContent: "...")\`

## Cover Letter Structure

- **Opening paragraph**: Specific hook. Reference something concrete about the company. State the role.
- **Evidence paragraphs** (2-3): Each maps a key JD requirement to Ray's specific experience. Use metrics from exec_metrics ONLY. If a requirement has no verified metric, say "demonstrated through [qualitative evidence]" rather than making up numbers.
- **Closing**: Forward-looking, connects Ray's mission to their goals. Clear call to action.

## Contact Header
- Name: Raymond Kallmeyer
- Email: raymond.kallmeyer@gmail.com
- Phone: (415) 360-4561
- LinkedIn: linkedin.com/in/raykallmeyer/

## Hard Constraints
- ONLY write to the libraryPageId from preContext.
- NEVER fabricate metrics. Only use numbers from exec_metrics. Name gaps explicitly.
- Match the tone parameter (default: Direct).
- Match the length parameter (default: Full page).`,
  },
  {
    name: "resume",
    recommendedPersona: "Strategist",
    description: "Generate a tailored resume for an opportunity using exec data, JD gap analysis, and the Resume Design Standard.",
    category: "exec",
    activity: "generation",
    version: "1.0",
    checklist: [
      { check: "3-phase process followed: JD gap analysis → evidence assembly → generation", weight: 2 },
      { check: "All quantified claims sourced from exec_metrics only", weight: 3 },
      { check: "Named gaps noted for requirements with no verified metric", weight: 2 },
      { check: "Resume Design Standard loaded and applied", weight: 2 },
      { check: "Contact: raymond.kallmeyer@gmail.com, (415) 360-4561, linkedin.com/in/raykallmeyer/", weight: 3 },
      { check: "Summary tailored to specific role, not generic", weight: 2 },
      { check: "Experience bullets prioritized by JD relevance", weight: 2 },
      { check: "Output written to the exact libraryPageId from preContext", weight: 3 },
    ],
    process: `You are generating a tailored resume for Ray. Your preContext contains the opportunity details, full job description, and the EXACT Library page to write into.

## 3-Phase Process

### Phase 1: JD Gap Analysis
1. Parse the job description from preContext.
2. Extract every stated and implied requirement (skills, experience years, domain knowledge, certifications).
3. Load Ray's profile:
   - \`exec(action: "list_experience")\` — work history with scope fields
   - \`exec(action: "list_skills")\` — skills inventory
   - \`exec(action: "list_metrics")\` — VERIFIED quantified accomplishments (the ONLY source for numbers)
   - \`exec(action: "list_education")\` — education history
4. Map each requirement to available evidence. Classify as: ✅ Strong match (verified metric), ⚠️ Partial match (qualitative only), ❌ Gap (no evidence).

### Phase 2: Evidence Assembly
5. For each ✅ match, pull the exact metric and context.
6. For each ⚠️ match, draft a qualitative bullet that honestly represents the experience without fabricating numbers.
7. For each ❌ gap, note it — the resume will emphasize strengths rather than paper over gaps.

### Phase 3: Resume Generation
8. Load the Resume Design Standard: \`library(action: "get_library_page", id: "resume-design-standard")\`
9. Build the resume content following the standard's structure.
10. Write to the Library page: \`library(action: "update_library_page", id: "<libraryPageId>", plainTextContent: "...")\`
11. Self-score: review the output against this skill's checklist. Note any items that scored below expectations.

## Resume Structure (per Resume Design Standard)
- **Header**: Raymond Kallmeyer | raymond.kallmeyer@gmail.com | (415) 360-4561 | linkedin.com/in/raykallmeyer/
- **Target Title**: The role being pursued
- **Summary**: 3-4 sentences tailored to THIS role. Not generic.
- **Core Competencies**: Single row of pipe-separated skills, prioritized by JD relevance
- **Selected Achievements**: Top 3-5 quantified wins (from exec_metrics ONLY)
- **Experience**: Reverse chronological. Company — Title | Dates. Context line for non-obvious companies. 3-5 bullets each, prioritized by JD relevance.
- **Education**: Institution | Degree | Field | Year

## Hard Constraints
- ONLY write to the libraryPageId from preContext.
- NEVER fabricate metrics. Only use numbers from exec_metrics.
- Contact MUST be: raymond.kallmeyer@gmail.com, (415) 360-4561, linkedin.com/in/raykallmeyer/
- Summary MUST be tailored to the specific role, not generic.`,
  },
];
