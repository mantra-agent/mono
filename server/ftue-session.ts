import type {
  ChatSession,
  SessionAgenda,
  SessionAgendaItem,
} from "@shared/models/chat";

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
    description: "Elicit one meaningful goal and create it through the canonical goals tool while the user remains on Home/Simple. The new goal surfaces there automatically through the data:goals_changed event; do not navigate to Goals or any other page. Complete this item only after the goal exists and is visible in the live Home view.",
  },
  {
    id: "plan-goal-as-project",
    title: "Plan goal as project",
    description: "Turn the first goal into a canonical project linked to that goal, with measurable milestones and concrete tasks created through work and tasks while the user remains on Home/Simple. Give every milestone a real dueDate and every task a real deadline, near-term and dependency-ordered, never omitted. The project, milestones, and tasks surface in the live Simple hierarchy automatically; do not navigate to Projects or any other page. Complete only after the project, milestones, and tasks exist with their dates and are visible on Home.",
  },
  {
    id: "show-the-memory-graph",
    title: "Show the memory graph",
    description: "Move to the Memory Graph with exactly two sequential narrated ui guides. First target navigation.sidebar.toggle in guide mode, asking the user to activate the persistent Agent orb that expands the navigation; wait for that guide to complete. Then target navigation.memoryGraph.open in guide mode, asking the user to choose Graph and landing on /memory?tab=graph. Never skip the sidebar beat, issue guides in parallel, navigate directly, or invent claims. Once on Graph, briefly explain how conversation-derived memory compounds and connect it to what the user has shared.",
  },
  {
    id: "highlight-relevant-other-features",
    title: "Highlight relevant other features",
    description: "Choose only features relevant to the user's goal and recap, then reveal their existing sidebar controls with ui guide targets such as navigation.people.open, navigation.schedule.open, navigation.library.open, or navigation.wellness.open. Keep the tour anchored to the user's life, not a generic feature list.",
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
 * Composes the authenticated FTUE greeting (the replay-safe first assistant
 * message). Recap onboarding opens on the first open agenda mission rather than
 * a hardcoded goal ask, so the greeting always matches whatever the agenda leads
 * with. Keyed on the canonical first item so a future reorder cannot reintroduce
 * a stale goal question.
 */
export function composeFtueFirstMessage(params: {
  recapAware: boolean;
  userFirstName: string;
  agentName: string;
  openItem: SessionAgendaItem | undefined;
}): string {
  const { recapAware, userFirstName, agentName, openItem } = params;
  if (!recapAware) {
    return `Hello ${userFirstName}. I'm ${agentName}. I help you keep track of what matters and turn it into action. To start, what's one goal you'd like me to help move forward?`;
  }
  if (!openItem) {
    return `Hello ${userFirstName}. Your onboarding agenda is complete. What should we move forward next?`;
  }
  if (openItem.id === "review-meeting-notes") {
    return `Hello ${userFirstName}. Your meeting notes are ready. Let's start by walking through them together.`;
  }
  return `Hello ${userFirstName}. Let's pick up with ${openItem.title.toLowerCase()}.`;
}
