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

function explicitOverride(payload: Record<string, unknown> | undefined): boolean | null {
  return typeof payload?.agentJoinOverride === "boolean" ? payload.agentJoinOverride : null;
}

/**
 * Per-event meeting agent override.
 * Click cycles inherit policy → force on → force off → inherit policy.
 */
export function MeetingAgentToggle({ item }: { item: SimpleFeedItem }) {
  const queryClient = useQueryClient();
  const payload = item.payload as Record<string, unknown> | undefined;

  const googleEventId = str(payload, "googleEventId");
  const accountId = str(payload, "accountId");
  const calendarId = str(payload, "calendarId");
  const enabled = payload?.agentJoinEnabled === true;
  const override = explicitOverride(payload);
  const status = str(payload, "agentJoinStatus");
  const detail = str(payload, "agentJoinDetail");
  const sessionId = str(payload, "agentJoinSessionId");

  const mutation = useMutation({
    mutationFn: async (nextOverride: boolean | null) => {
      const res = await apiRequest("POST", "/api/calendar/agent-join", {
        googleEventId,
        accountId,
        calendarId,
        override: nextOverride,
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

  const tone = !enabled
    ? override === false ? "text-destructive/70" : "text-muted-foreground/50 hover:text-muted-foreground"
    : status === "no_link" ? "text-warning-foreground"
      : status === "failed" ? "text-destructive"
        : "text-cta";

  const tooltip = mutation.isError
    ? mutation.error instanceof Error ? mutation.error.message : "Override failed"
    : status === "no_link" ? detail || "No meeting link found on this event"
      : status === "failed" ? detail || "Agent failed to join"
        : override === true ? "Forced on. Click to force off."
          : override === false ? "Forced off. Click to inherit your policy."
            : enabled ? "Joining by policy. Click to force on."
              : "Not joining by policy. Click to force on.";

  const nextOverride = override === null ? true : override === true ? false : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={(event) => {
            event.stopPropagation();
            mutation.mutate(nextOverride);
          }}
          className={cn(
            "flex w-5 shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-accent/60",
            override === null && !enabled && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
          )}
          aria-label={tooltip}
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
