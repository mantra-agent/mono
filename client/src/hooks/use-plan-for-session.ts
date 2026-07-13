/**
 * Hook that detects active plans in a chat session's messages
 * and provides live plan data with real-time event updates.
 */
import { useMemo, useCallback, useReducer } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ChatMessage } from "@/components/chat-shared";
import type { PlanData, PlanStep, StepStatus } from "@/components/plan-shared";
import { usePlanEvents } from "@/hooks/use-plan-events";
import type { PlanEvent } from "@/hooks/use-plan-events";

const PLAN_ID_RE = /Plan ID:\s*(\S+)/;

/**
 * Scan messages for plan tool call results and return the most recent planId.
 */
function extractLatestPlanId(messages: ChatMessage[]): string | null {
  let latest: string | null = null;

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;

    for (const tc of msg.toolCalls) {
      if (tc.toolName !== "plan") continue;
      const action = tc.arguments?.action;
      if (action !== "create" && action !== "get" && action !== "execute" && action !== "associate_session") continue;
      if (tc.status !== "done") continue;

      const output = typeof tc.result === "string"
        ? tc.result
        : typeof tc.output === "string"
          ? tc.output
          : tc.result != null
            ? JSON.stringify(tc.result)
            : "";

      const match = output.match(PLAN_ID_RE);
      if (match) latest = match[1];
    }
  }

  return latest;
}

// ─── Live event reducer ──────────────────────────────────────────────

type StepOverride = { status: StepStatus; outcome?: string; error?: string; duration?: number };
type EventState = { stepOverrides: Record<string, StepOverride>; statusOverride: PlanData["status"] | null };
type EventAction = { type: "step_update"; stepId: string; override: StepOverride }
  | { type: "status_update"; status: PlanData["status"] }
  | { type: "reset" };

function eventReducer(state: EventState, action: EventAction): EventState {
  switch (action.type) {
    case "step_update":
      return { ...state, stepOverrides: { ...state.stepOverrides, [action.stepId]: action.override } };
    case "status_update":
      return { ...state, statusOverride: action.status };
    case "reset":
      return { stepOverrides: {}, statusOverride: null };
    default:
      return state;
  }
}

const INITIAL_EVENT_STATE: EventState = { stepOverrides: {}, statusOverride: null };

// ─── Hook ────────────────────────────────────────────────────────────

export function usePlanForSession(messages: ChatMessage[], serverPlanPageId?: string | null): {
  planId: string | null;
  plan: PlanData | null;
  isLoading: boolean;
} {
  const messagePlanId = useMemo(() => extractLatestPlanId(messages), [messages]);
  // Prefer server-provided plan association over client-side message scanning
  const planId = serverPlanPageId || messagePlanId;

  const [eventState, dispatch] = useReducer(eventReducer, INITIAL_EVENT_STATE);

  const { data: fetchedPlan, isLoading } = useQuery<PlanData>({
    queryKey: ["/api/plans", planId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/plans/${planId}`);
      return res.json();
    },
    enabled: !!planId,
    refetchInterval: (query) => {
      const plan = query.state.data;
      return plan?.status === "executing" ? 5000 : false;
    },
    staleTime: 2000,
  });

  // Reset event overrides when the fetched plan changes (fresh data supersedes live deltas)
  const prevPlanRef = useMemo(() => ({ id: fetchedPlan?.id, status: fetchedPlan?.status }), [fetchedPlan?.id, fetchedPlan?.status]);
  useMemo(() => {
    if (prevPlanRef.id) dispatch({ type: "reset" });
  }, [prevPlanRef]);

  // Subscribe to live plan events
  const handlePlanEvent = useCallback((event: PlanEvent) => {
    switch (event.type) {
      case "plan.step.started":
        if (event.stepId) {
          dispatch({ type: "step_update", stepId: event.stepId, override: { status: "running" } });
        }
        break;
      case "plan.step.completed":
        if (event.stepId) {
          dispatch({
            type: "step_update",
            stepId: event.stepId,
            override: { status: "completed", outcome: event.outcome, duration: event.duration },
          });
        }
        break;
      case "plan.step.failed":
        if (event.stepId) {
          dispatch({
            type: "step_update",
            stepId: event.stepId,
            override: { status: "failed", error: event.error, duration: event.duration },
          });
        }
        break;
      case "plan.started":
        dispatch({ type: "status_update", status: "executing" });
        break;
      case "plan.completed":
        dispatch({ type: "status_update", status: "completed" });
        break;
      case "plan.paused":
        dispatch({ type: "status_update", status: "paused" });
        break;
      case "plan.needs_review":
        if (event.stepId) {
          dispatch({ type: "step_update", stepId: event.stepId, override: { status: "needs_review" } });
        }
        dispatch({ type: "status_update", status: "needs_review" });
        break;
    }
  }, []);

  usePlanEvents(handlePlanEvent, planId ?? undefined);

  // Merge fetched plan with live event overrides
  const plan = useMemo<PlanData | null>(() => {
    if (!fetchedPlan) return null;

    const hasOverrides = eventState.statusOverride || Object.keys(eventState.stepOverrides).length > 0;
    if (!hasOverrides) return fetchedPlan;

    const mergedSteps: PlanStep[] = fetchedPlan.steps.map((step) => {
      const override = eventState.stepOverrides[step.id];
      if (!override) return step;
      return { ...step, ...override };
    });

    return {
      ...fetchedPlan,
      status: eventState.statusOverride ?? fetchedPlan.status,
      steps: mergedSteps,
    };
  }, [fetchedPlan, eventState]);

  return { planId, plan, isLoading: !!planId && isLoading };
}
