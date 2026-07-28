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

export function createRecapFtueAgenda(): SessionAgenda {
  return {
    items: [
      {
        id: "set-first-goal",
        title: "Set first goal",
        description: "Elicit one meaningful goal, create it through the canonical goals tool, then use ui target navigation.goals.open in guide mode so the user sees the real Goals surface. Complete this item only after the goal exists.",
        status: "open",
      },
      {
        id: "review-meeting-notes",
        title: "Review meeting notes",
        description: "Review the recipient-safe meeting recap supplied in context, including decisions, questions, action items, and assigned tasks. Then use ui target navigation.meetings.open in guide mode to show where the user's future captured meetings will live. Never attempt to open the meeting owner's private session or Library page.",
        status: "open",
      },
      {
        id: "plan-goal-as-project",
        title: "Plan goal as project",
        description: "Turn the first goal into a canonical project linked to that goal, with measurable milestones and concrete tasks using work and tasks. Then use ui target navigation.projects.open in guide mode. Complete only after the project, milestones, and tasks exist.",
        status: "open",
      },
      {
        id: "show-the-memory-graph",
        title: "Show the memory graph",
        description: "Use ui target navigation.memoryGraph.open in guide mode. Explain briefly how conversation-derived memory compounds and connect the visible graph to what the user has shared; do not invent claims or create parallel onboarding state.",
        status: "open",
      },
      {
        id: "highlight-relevant-other-features",
        title: "Highlight relevant other features",
        description: "Choose only features relevant to the user's goal and recap, then reveal their existing sidebar controls with ui guide targets such as navigation.people.open, navigation.schedule.open, navigation.library.open, or navigation.wellness.open. Keep the tour anchored to the user's life, not a generic feature list.",
        status: "open",
      },
      {
        id: "identify-next-integration-steps",
        title: "Identify next integration steps",
        description: "Agree on concrete next steps for integrating Mantra into the user's routines, including any useful connections, capture habits, or follow-through cadence. Persist real commitments through their canonical domain tools, summarize what is now live, and complete this item with the agreed integration plan.",
        status: "open",
      },
    ],
  };
}
