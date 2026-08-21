import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { onAutonomousStarted } from "@/hooks/use-data-sync";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useToast } from "@/hooks/use-toast";

/**
 * Launch a real Skill run (skill_runs + skill process + scoring), then open Focus
 * on the session emitted by chat.autonomous.started.
 *
 * Deliverable buttons that own a Skill must use this — not useSessionLaunch with a
 * "run the skill" prompt, which bypasses skill infrastructure.
 */

export interface SkillLaunch {
  /** Skill name (catalog identity). */
  skillName: string;
  /** Stable key identifying the originating row, for per-row pending state. */
  pendingKey: string;
  /** Optional bounded launch context interpreted by the Skill process. */
  preContext?: string;
  /** Toast title on failure. */
  errorTitle?: string;
  /**
   * Open Focus after the skill session is created. Default true.
   * Pass false when the host surfaces the session in place.
   */
  openFocus?: boolean;
}

type SkillListRow = { id: string; name: string; status?: string };

type SkillRunAccepted = {
  accepted: boolean;
  skillId: string;
  skillName: string;
  runtimeRunId: string;
  status: string;
};

const SKILL_SESSION_WAIT_MS = 45_000;

export function useSkillLaunch() {
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const { toast } = useToast();
  const pendingLaunchRef = useRef<{
    skillId: string;
    skillName: string;
    openFocus: boolean;
    resolve: (sessionId: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const skillsQuery = useQuery<SkillListRow[]>({
    queryKey: ["/api/skills"],
    staleTime: 60_000,
  });

  useEffect(() => {
    onAutonomousStarted((payload) => {
      const pending = pendingLaunchRef.current;
      if (!pending) return;
      // Runner payload skillId is the skill UUID; skillName is the catalog label.
      const matchesId = payload.skillId === pending.skillId;
      const matchesLabel = payload.skillName === pending.skillName;
      if (!matchesId && !matchesLabel) return;
      clearTimeout(pending.timer);
      pendingLaunchRef.current = null;
      pending.resolve(payload.sessionId);
    });
    return () => {
      onAutonomousStarted(null);
      const pending = pendingLaunchRef.current;
      if (pending) {
        clearTimeout(pending.timer);
        pendingLaunchRef.current = null;
        pending.reject(new Error("Skill launch cancelled"));
      }
    };
  }, []);

  return useMutation({
    mutationFn: async ({
      skillName,
      preContext,
      openFocus = true,
    }: SkillLaunch) => {
      const skills =
        skillsQuery.data
        ?? (await queryClient.fetchQuery<SkillListRow[]>({ queryKey: ["/api/skills"] }));
      const skill = skills.find((row) => row.name === skillName && row.status !== "deprecated");
      if (!skill) {
        throw new Error(`Skill "${skillName}" not found or not available`);
      }

      const sessionPromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingLaunchRef.current?.skillId === skill.id) {
            pendingLaunchRef.current = null;
            reject(new Error(`Timed out waiting for ${skillName} session`));
          }
        }, SKILL_SESSION_WAIT_MS);
        pendingLaunchRef.current = {
          skillId: skill.id,
          skillName,
          openFocus,
          resolve,
          reject,
          timer,
        };
      });

      const response = await apiRequest(
        "POST",
        `/api/skills/${skill.id}/run`,
        preContext ? { preContext } : undefined,
      );
      const accepted: SkillRunAccepted = await response.json();
      if (!accepted?.accepted) {
        const pending = pendingLaunchRef.current;
        if (pending) {
          clearTimeout(pending.timer);
          pendingLaunchRef.current = null;
        }
        throw new Error(`Skill "${skillName}" was not accepted`);
      }

      const sessionId = await sessionPromise;
      return { sessionId, skillId: skill.id, skillName, openFocus };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/skills", result.skillName, "runs"] });
      if (result.openFocus === false) return;
      setSessionForRoute(route, result.sessionId);
      setWidgetOpen(true);
    },
    onError: (error: Error, variables) => {
      const pending = pendingLaunchRef.current;
      if (pending) {
        clearTimeout(pending.timer);
        pendingLaunchRef.current = null;
      }
      toast({
        title: variables.errorTitle || "Could not start skill",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
