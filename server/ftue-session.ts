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
    description: "Open on the recipient-safe meeting recap supplied in context, walking through summary, decisions, open questions, action items, and assigned tasks. Then use ui target navigation.meetings.open in guide mode so the user can open this meeting's recap and see where their future captured meetings will live. Never attempt to open the meeting owner's private session or Library page.",
  },
  {
    id: "set-first-goal",
    title: "Set first goal",
    description: "Elicit one meaningful goal and create it through the canonical goals tool. The new goal surfaces on Simple automatically through the data:goals_changed event; do not navigate to Goals. Complete this item only after the goal exists.",
  },
  {
    id: "plan-goal-as-project",
    title: "Plan goal as project",
    description: "Turn the first goal into a canonical project linked to that goal, with measurable milestones and concrete tasks using work and tasks. The project, milestones, and tasks surface on Simple's hierarchy automatically; do not navigate to Projects. Complete only after the project, milestones, and tasks exist.",
  },
  {
    id: "show-the-memory-graph",
    title: "Show the memory graph",
    description: "Use ui target navigation.memoryGraph.open in guide mode. Explain briefly how conversation-derived memory compounds and connect the visible graph to what the user has shared; do not invent claims or create parallel onboarding state.",
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
