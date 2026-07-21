import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import type { SimpleFeedItem } from "@shared/models/simple";
import { resolveMeetingJoinMode, type MeetingJoinMode } from "@shared/schema";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MeetingJoinModeMenu, meetingJoinModeLabel } from "@/components/calendar/meeting-join-mode";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

function str(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value ? value : null;
}

/** Explicit per-event meeting participation mode. */
export function MeetingAgentToggle({ item }: { item: SimpleFeedItem }) {
  const queryClient = useQueryClient();
  const payload = item.payload as Record<string, unknown> | undefined;

  const googleEventId = str(payload, "googleEventId");
  const accountId = str(payload, "accountId");
  const calendarId = str(payload, "calendarId");
  const mode = resolveMeetingJoinMode(
    payload?.agentJoinMode,
    payload?.agentJoinEnabled === true,
    typeof payload?.agentJoinOverride === "boolean" ? payload.agentJoinOverride : null,
  );
  const status = str(payload, "agentJoinStatus");
  const detail = str(payload, "agentJoinDetail");
  const sessionId = str(payload, "agentJoinSessionId");

  const mutation = useMutation({
    mutationFn: async (nextMode: MeetingJoinMode) => {
      const res = await apiRequest("POST", "/api/calendar/agent-join", {
        googleEventId,
        accountId,
        calendarId,
        mode: nextMode,
      });
      return res.json();
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
    },
  });

  if (!googleEventId || !accountId || !calendarId) return null;

  if (sessionId && (status === "joined" || status === "failed")) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={`/session?c=${sessionId}`}
            onClick={(event) => event.stopPropagation()}
            className="flex w-5 shrink-0 items-center justify-center rounded p-0.5 hover:bg-accent/60"
            aria-label={status === "joined" ? "Agent joined; open meeting session" : "Agent failed; open meeting session"}
          >
            <Bot className={cn("h-3.5 w-3.5", status === "joined" ? "text-active" : "text-destructive")} />
          </a>
        </TooltipTrigger>
        <TooltipContent side="left">
          {status === "joined" ? "Agent joined. Open the meeting session." : detail || "Agent failed. Open the meeting session."}
        </TooltipContent>
      </Tooltip>
    );
  }

  const tooltip = mutation.isError
    ? mutation.error instanceof Error ? mutation.error.message : "Meeting mode update failed"
    : status === "no_link" ? detail || "No meeting link found on this event"
      : status === "failed" ? detail || "Agent failed to join"
        : meetingJoinModeLabel(mode);

  return (
    <div onClick={event => event.stopPropagation()}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn(
            "inline-flex rounded",
            mode === "dont_join" && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100",
          )}>
            <MeetingJoinModeMenu
              value={mode}
              onChange={nextMode => mutation.mutate(nextMode)}
              disabled={mutation.isPending}
              compact
              testId={`meeting-join-mode-${googleEventId}`}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">{tooltip}</TooltipContent>
      </Tooltip>
    </div>
  );
}
