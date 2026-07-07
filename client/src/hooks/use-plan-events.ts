/**
 * React hook for subscribing to real-time plan execution events via WebSocket.
 * Listens for plan.step.started, plan.step.completed, plan.step.failed,
 * plan.completed, and plan.paused events.
 */
import { useEffect, useCallback, useRef } from "react";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import { createLogger } from "@/lib/logger";

const log = createLogger("PlanEvents");

export type PlanEventType =
  | "plan.started"
  | "plan.step.started"
  | "plan.step.completed"
  | "plan.step.failed"
  | "plan.completed"
  | "plan.paused";

export interface PlanEvent {
  type: PlanEventType;
  planId: string;
  pageId?: string;
  stepId?: string;
  stepTitle?: string;
  stepIndex?: number;
  outcome?: string;
  duration?: number;
  error?: string;
  reason?: string;
  title?: string;
  totalDuration?: number;
  stepCount?: number;
}

type PlanEventHandler = (event: PlanEvent) => void;

/**
 * Subscribe to plan events for a specific plan ID (or all plans if no ID provided).
 */
export function usePlanEvents(
  handler: PlanEventHandler,
  planId?: string,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const ws = acquireSharedWS("plan-events");
    const handlerId = `plan-events-${planId || "all"}-${Date.now()}`;

    ws.addMessageHandler(handlerId, (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      if (m.type !== "event") return;

      const event = m.event as Record<string, unknown> | undefined;
      if (!event) return;

      const eventName = event.event as string;
      if (!eventName?.startsWith("plan.")) return;

      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      // Filter by planId if specified
      if (planId && payload.planId !== planId) return;

      const planEvent: PlanEvent = {
        type: eventName as PlanEventType,
        planId: payload.planId as string,
        pageId: payload.pageId as string | undefined,
        stepId: payload.stepId as string | undefined,
        stepTitle: payload.stepTitle as string | undefined,
        stepIndex: payload.stepIndex as number | undefined,
        outcome: payload.outcome as string | undefined,
        duration: payload.duration as number | undefined,
        error: payload.error as string | undefined,
        reason: payload.reason as string | undefined,
        title: payload.title as string | undefined,
        totalDuration: payload.totalDuration as number | undefined,
        stepCount: payload.stepCount as number | undefined,
      };

      handlerRef.current(planEvent);
    });

    return () => {
      ws.removeMessageHandler(handlerId);
      releaseSharedWS("plan-events");
    };
  }, [planId]);
}
