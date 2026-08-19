import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useToast } from "@/hooks/use-toast";

/**
 * Canonical interactive session-launch path.
 *
 * Creates a session, optionally seats a persona, optionally instantiates an
 * agenda, posts an optional first message, and by default opens Focus. Pass
 * `openFocus: false` when the host surfaces the session in place (Features).
 * Discuss call sites compose context only. Deliverable-producing buttons
 * compose context plus a Skill/contract body — never a bespoke prompt string
 * invented at the row.
 */

export interface SessionLaunch {
  /** Stable key identifying the originating row, for per-row pending state. */
  pendingKey: string;
  /** New session title (trimmed and length-capped by the launcher). */
  title: string;
  /** Optional agenda definition instantiated before the first message. */
  applyAgendaId?: string;
  /** Optional preloaded first message. Context, or context + Skill contract. */
  message?: string;
  /** Stable suffix for the replay-safe clientTurnId. */
  clientTurnSuffix: string;
  /** Optional persona seat by id. */
  personaId?: number;
  /** Optional persona seat by name. Ignored when personaId is set. */
  personaName?: string;
  /** Toast title on failure. */
  errorTitle?: string;
  /**
   * Open the Focus session surface after create. Default true.
   * Features passes `!isMobile`: desktop opens Focus; mobile keeps the
   * under-row session strip so launch does not full-screen leave the page.
   * Fast Forward host auto-walks keep false so the sequencer does not thrash Focus.
   */
  openFocus?: boolean;
}

type CreatedSession = { id: string };

export function useSessionLaunch() {
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({
      title,
      applyAgendaId,
      message,
      clientTurnSuffix,
      personaId,
      personaName,
    }: SessionLaunch) => {
      const response = await apiRequest("POST", "/api/sessions", {
        title: title.trim().slice(0, 80) || "Session",
        ...(personaId ? { personaId } : personaName ? { personaName } : {}),
      });
      const session: CreatedSession = await response.json();
      if (applyAgendaId) {
        await apiRequest("POST", `/api/sessions/${session.id}/agenda`, {
          agendaId: applyAgendaId,
        });
      }
      if (message) {
        await apiRequest("POST", `/api/sessions/${session.id}/messages`, {
          content: message,
          clientTurnId: `session-launch-${session.id}-${clientTurnSuffix}`.slice(0, 120),
        });
      }
      return session;
    },
    onSuccess: (session, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      // Hosts that keep the user on-page (Features under-row session) skip Focus.
      // On mobile, setWidgetOpen(true) is a full-screen leave of the current route.
      if (variables.openFocus === false) return;
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
    },
    onError: (error: Error, variables) => {
      toast({
        title: variables.errorTitle || "Could not start discussion",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
