import type {
  ChatSession,
  SessionAgenda,
  SessionAgendaItem,
} from "@shared/models/chat";
import { assertAgendaItemContract, SESSION_AGENDA_MAX_ITEMS } from "./agenda-item-contract";

export const RECAP_FTUE_TRIGGER_NAME = "recap_ftue";
export const FTUE_FIRST_MESSAGE_ARTIFACT_KEY = "ftue:first-message:v1";

export function isRecapFtueSession(
  session: Pick<ChatSession, "ftueWelcome" | "triggerName" | "triggerId"> | null | undefined,
): session is Pick<ChatSession, "ftueWelcome" | "triggerName" | "triggerId"> & { triggerId: string } {
  return Boolean(
    session?.ftueWelcome
      && session.triggerName === RECAP_FTUE_TRIGGER_NAME
      && session.triggerId,
  );
}

export function firstOpenAgendaItem(
  agenda: SessionAgenda | undefined,
): SessionAgendaItem | undefined {
  return agenda?.items.find((item) => item.status === "open");
}

export const RECAP_FTUE_AGENDA_ITEMS = [
  {
    id: "say-hello",
    title: "Say a warm hello",
    description: "Greet the user warmly and establish the conversation. Complete this item immediately through session.complete_agenda_item once you have exchanged an initial hello with the user; do not begin the introduction or any later agenda item before this completion is persisted.",
  },
  {
    id: "introduce-mantra",
    title: "Introduce what Mantra does",
    description: "Briefly explain that Mantra helps the user hold context, pursue meaningful goals, and carry commitments into action. Ask what the user already knows about Mantra, offer to explain more, and invite their questions. Answer those initial questions before proceeding. Complete this item immediately through session.complete_agenda_item only after that introduction and invitation have happened and the user's initial questions have been answered or they confirm they have none.",
  },
  {
    id: "review-meeting-notes",
    title: "Review meeting notes",
    description: "Open on the recipient-safe meeting recap supplied in context, walking through summary, decisions, open questions, action items, and assigned tasks without leaving Home/Simple. Use ui in guide mode with the exact recipient-owned meetingResource from ftue_recap_context and surface=home so the real recap row expands and highlights inline. Never use the source meeting triggerId or open the meeting owner's private session or Library page. Complete only after the user has activated the highlighted recap row and reviewed what was captured.",
  },
  {
    id: "capture-meeting-detail-preference",
    title: "Set meeting detail level",
    description: "Ask one focused question about how much detail the user wants in their meeting notes and follow-ups, for example concise highlights versus thorough detail. Persist their answer immediately as a durable personal Rule through the rules tool with action save, scope contextual, and context naming meeting-notes detail level, so future recaps honor it. Keep this to a single exchange while the user stays on Home/Simple; do not navigate anywhere. Complete this item once the preference Rule is saved, then move to the goal step.",
  },
  {
    id: "set-first-goal",
    title: "Set first goal",
    description: "Elicit one meaningful goal and create it through the canonical goals tool while the user remains on Home/Simple. The new goal surfaces there automatically through the data:goals_changed event; do not navigate to Goals or any other page. Complete this item immediately through session.complete_agenda_item only after the canonical goal creation succeeds and the goal is visible in the live Home view; discussing or naming a goal without creating it is not completion.",
  },
  {
    id: "plan-goal-as-project",
    title: "Plan goal as project",
    description: "Propose 3–5 measurable, dependency-ordered milestones with due dates, and ask the user to confirm or revise them. Do not create a project, milestone, or task before they explicitly confirm. After confirmation, create the goal-linked project, confirmed milestones, and dated tasks through work and tasks while the user stays on Home/Simple. Complete this item only once confirmation and successful creation are both true and the dated structure is visible on Home.",
  },
  {
    id: "show-the-memory-graph",
    title: "Show the memory graph",
    description: "Move to the Memory Graph with exactly two sequential narrated ui guides. First target navigation.sidebar.toggle in guide mode, asking the user to activate the persistent Agent orb that expands the navigation; wait for that guide to complete. Then target navigation.memoryGraph.open in guide mode, asking the user to choose Graph and landing on /memory?tab=graph. Never skip the sidebar beat, issue guides in parallel, navigate directly, or invent claims. Once on Graph, briefly explain how conversation-derived memory compounds and connect it to what the user has shared.",
  },
  {
    id: "highlight-relevant-other-features",
    title: "Highlight relevant other features",
    description: "Choose only features relevant to the user's goal and recap, then reveal their existing sidebar controls with ui guide targets such as navigation.people.open, navigation.schedule.open, navigation.library.open, or navigation.habits.open. Keep the tour anchored to the user's life, not a generic feature list.",
  },
  {
    id: "identify-next-integration-steps",
    title: "Identify next integration steps",
    description: "Agree on concrete next steps for integrating Mantra into the user's routines, including any useful connections, capture habits, or follow-through cadence. Persist real commitments through their canonical domain tools, summarize what is now live, and complete this item with the agreed integration plan.",
  },
] as const;

export function createRecapFtueAgenda(): SessionAgenda {
  return {
    items: RECAP_FTUE_AGENDA_ITEMS.map((item) => ({ ...item, status: "open" as const })),
  };
}

/**
 * Assert the code-owned FTUE agenda fixture satisfies the same Session agenda
 * runtime contract that instantiation enforces (item count, 3–5 word titles,
 * ≤600 char descriptions). Runtime attach fails gracefully by dropping the
 * agenda, so a non-compliant fixture would otherwise only surface as a broken
 * onboarding on the first real signup. The production build runs this so a
 * contract-violating fixture fails at build time instead of on a live user.
 */
export function validateFtueAgendaFixture(): void {
  if (RECAP_FTUE_AGENDA_ITEMS.length > SESSION_AGENDA_MAX_ITEMS) {
    throw new Error(
      `FTUE agenda fixture has ${RECAP_FTUE_AGENDA_ITEMS.length} items; the Session agenda contract allows at most ${SESSION_AGENDA_MAX_ITEMS}.`,
    );
  }
  for (const item of RECAP_FTUE_AGENDA_ITEMS) {
    assertAgendaItemContract(item);
  }
}

/**
 * Composes the authenticated FTUE hello (the replay-safe first assistant
 * message). The persisted agenda owns every step after that greeting, including
 * the distinct introduction and goal rows, so this message must not skip ahead.
 * Recap onboarding remains keyed on its first open item for compatibility with
 * user-edited definitions.
 */
export function composeFtueFirstMessage(params: {
  recapAware: boolean;
  userFirstName: string;
  agentName: string;
  hasAgenda: boolean;
  openItem: SessionAgendaItem | undefined;
}): string {
  const { recapAware, userFirstName, agentName, hasAgenda, openItem } = params;
  if (!recapAware) {
    return `Hello ${userFirstName}. I'm ${agentName}. It's good to meet you.`;
  }
  // A recap FTUE whose agenda failed to attach must never claim completion.
  // Missing agenda and agenda-all-done are different states; only the latter is
  // "complete". Open the conversation warmly instead of asserting we are done.
  if (!hasAgenda) {
    return `Hello ${userFirstName}. I'm ${agentName}. It's good to meet you.`;
  }
  if (!openItem) {
    return `Hello ${userFirstName}. Your onboarding agenda is complete. What should we move forward next?`;
  }
  if (openItem.id === "review-meeting-notes") {
    return `Hello ${userFirstName}. Your meeting notes are ready. Let's start by walking through them together.`;
  }
  if (openItem.id === "say-hello") {
    return `Hello ${userFirstName}. I'm ${agentName}. It's good to meet you.`;
  }
  return `Hello ${userFirstName}. Let's pick up with ${openItem.title.toLowerCase()}.`;
}
