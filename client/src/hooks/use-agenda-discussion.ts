import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useToast } from "@/hooks/use-toast";

/**
 * Canonical session-launch path for "Discuss" affordances on both agenda
 * surfaces. Creates a session, preloads the discussion message, and routes the
 * global Session Window to it. Shared so the runtime-agenda and definition
 * surfaces cannot diverge on how a discussion is started.
 */

export interface AgendaDiscussionLaunch {
  /** Stable key identifying the originating row, for per-row pending state. */
  pendingKey: string;
  /** New session title (trimmed and length-capped by the launcher). */
  title: string;
  /** Preloaded first message content. */
  message: string;
  /** Stable suffix for the replay-safe clientTurnId. */
  clientTurnSuffix: string;
}

type CreatedSession = { id: string };

export function useAgendaDiscussion() {
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ title, message, clientTurnSuffix }: AgendaDiscussionLaunch) => {
      const response = await apiRequest("POST", "/api/sessions", {
        title: title.trim().slice(0, 80) || "Agenda Discussion",
      });
      const session: CreatedSession = await response.json();
      await apiRequest("POST", `/api/sessions/${session.id}/messages`, {
        content: message,
        clientTurnId: `agenda-discuss-${session.id}-${clientTurnSuffix}`.slice(0, 120),
      });
      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
    },
    onError: (error: Error) => {
      toast({
        title: "Could not start discussion",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
