import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2 } from "lucide-react";
import type { SimpleFeedItem } from "@shared/models/simple";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

function str(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * Per-event meeting agent auto-join toggle (M1.5).
 * Toggled on: the Recall.ai bot auto-joins at the meeting's start time.
 * Visual states: off (muted), scheduled (cta), no_link (amber + reason),
 * failed (destructive + reason), joined (green, links to the meeting session).
 */
export function MeetingAgentToggle({ item }: { item: SimpleFeedItem }) {
  const queryClient = useQueryClient();
  const payload = item.payload as Record<string, unknown> | undefined;

  const googleEventId = str(payload, "googleEventId");
  const accountId = str(payload, "accountId");
  const calendarId = str(payload, "calendarId");
  const enabled = payload?.agentJoinEnabled === true;
  const status = str(payload, "agentJoinStatus");
  const detail = str(payload, "agentJoinDetail");
  const sessionId = str(payload, "agentJoinSessionId");

  const mutation = useMutation({
    mutationFn: async (nextEnabled: boolean) => {
      const res = await apiRequest("POST", "/api/calendar/agent-join", {
        googleEventId,
        accountId,
        calendarId,
        enabled: nextEnabled,
      });
      return res.json();
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
    },
  });

  if (!googleEventId || !accountId || !calendarId) return null;

  // Joined: the bot is in (or was in) the call — link to the meeting session.
  if (enabled && status === "joined" && sessionId) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={`/session?c=${sessionId}`}
            onClick={(e) => e.stopPropagation()}
            className="flex w-5 shrink-0 items-center justify-center rounded p-0.5 hover:bg-accent/60"
            aria-label="Agent joined — open meeting session"
          >
            <Bot className="h-3.5 w-3.5 text-emerald-500" />
          </a>
        </TooltipTrigger>
        <TooltipContent side="left">Agent joined — open the meeting session</TooltipContent>
      </Tooltip>
    );
  }

  const tone = !enabled
    ? "text-muted-foreground/50 hover:text-muted-foreground"
    : status === "no_link"
      ? "text-amber-500"
      : status === "failed"
        ? "text-destructive"
        : "text-cta";

  const tooltip = mutation.isError
    ? (mutation.error instanceof Error ? mutation.error.message : "Toggle failed")
    : !enabled
      ? "Send the agent to this meeting"
      : status === "no_link"
        ? (detail || "No meeting link found on this event")
        : status === "failed"
          ? (detail || "Agent failed to join")
          : "Agent will join at start time";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={(e) => {
            e.stopPropagation();
            mutation.mutate(!enabled);
          }}
          className={cn(
            "flex w-5 shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-accent/60",
            !enabled && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
          )}
          aria-label={enabled ? "Disable agent auto-join" : "Enable agent auto-join"}
          aria-pressed={enabled}
        >
          {mutation.isPending
            ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            : <Bot className={cn("h-3.5 w-3.5", tone)} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
