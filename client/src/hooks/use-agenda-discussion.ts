import { useSessionLaunch, type SessionLaunch } from "@/hooks/use-session-launch";

/**
 * Agenda Discuss is the session-launch primitive with agenda-flavored defaults.
 * New call sites should use `useSessionLaunch` directly.
 */
export type AgendaDiscussionLaunch = SessionLaunch;

export function useAgendaDiscussion() {
  return useSessionLaunch();
}
