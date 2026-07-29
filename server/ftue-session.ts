import type {
  ChatSession,
  SessionAgenda,
  SessionAgendaItem,
} from "@shared/models/chat";
import { AGENT_WORK_DEADLINE_INSTRUCTION } from "./planning-instructions";

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
    description: "Open on the recipient-safe meeting recap supplied in context, walking through summary, decisions, open questions, action items, and assigned tasks. Stay on Home/Simple. Use ui in guide mode with the exact recipient-owned meetingResource from ftue_recap_context and surface=home; this expands and highlights the real recap row inline without navigating to Meetings. Never use the source meeting triggerId, open the meeting owner's private session or Library page, or navigate away from Home for this beat. Complete only after the user has activated the highlighted recap row and reviewed what was captured.",
  },
  {
    id: "set-first-goal",
    title: "Set first goal",
    description: "Elicit one meaningful goal and create it through the canonical goals tool while the user remains on Home/Simple. The new goal surfaces there automatically through the data:goals_changed event; do not navigate to Goals or any other page. Complete this item only after the goal exists and is visible in the live Home view.",
  },
  {
    id: "plan-goal-as-project",
    title: "Plan goal as project",
    description: `Turn the first goal into a canonical project linked to that goal, with measurable milestones and concrete tasks using work and tasks while the user remains on Home/Simple. ${AGENT_WORK_DEADLINE_INSTRUCTION} The project, milestones, and tasks surface in the live Simple hierarchy automatically; do not navigate to Projects or any other page. Complete only after the project, milestones, and tasks exist with their required dates and are visible on Home.`,
  },
  {
    id: "show-the-memory-graph",
    title: "Show the memory graph",
    description: "Move to the Memory Graph with exactly two sequential narrated ui guides. First call ui with target navigation.sidebar.toggle in guide mode and ask the user to activate the persistent Agent orb that expands or collapses the main navigation; wait for that guide to complete. Then call ui with target navigation.memoryGraph.open in guide mode and ask the user to choose Graph; wait for activation and land on /memory?tab=graph. Do not skip the sidebar beat, issue both guides in parallel, navigate directly, invent claims, or create parallel onboarding state. Once on Graph, explain briefly how conversation-derived memory compounds and connect the visible graph to what the user has shared.",
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
