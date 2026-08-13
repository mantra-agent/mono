import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  AlertCircle,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  X,
} from "lucide-react";
import type { SystemNotice } from "@shared/models/chat";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgendaDiscussion } from "@/hooks/use-agenda-discussion";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { getClientTabId } from "@/lib/client-tab-identity";

interface SystemNoticeMessageProps {
  notice: SystemNotice;
  timestamp?: string;
  /** Originating session for Discuss / dismiss context. */
  sessionId?: string | null;
  /** Stable id for per-row pending state and dismiss target. */
  noticeKey?: string;
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  processing_stopped: "Processing stopped",
  response_interrupted: "Response interrupted",
  response_incomplete: "Response incomplete",
  user_stopped: "Stopped",
  something_went_wrong: "Something went wrong",
  temporarily_busy: "Temporarily busy",
};

const CONTINUE_MESSAGE = "Please continue...";

function formatOptional(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return String(value);
}

/** Seed message for Engineer Discuss from a transcript error/warning widget. */
export function buildSystemNoticeDiscussionMessage({
  notice,
  sessionId,
  timestamp,
}: {
  notice: SystemNotice;
  sessionId?: string | null;
  timestamp?: string;
}): string {
  const isError = notice.severity === "error";
  const label =
    ERROR_TYPE_LABELS[notice.errorType] || notice.errorType || (isError ? "Error" : "Warning");
  const lines = [
    isError
      ? "Diagnose and fix this session error. Start investigating immediately."
      : "Diagnose this session warning. Start investigating immediately and fix if it indicates a real defect.",
    "",
    `${isError ? "Error" : "Warning"}: **${label}**`,
    `Description: ${notice.description}`,
    `Action hint: ${notice.actionHint}`,
  ];

  if (sessionId) {
    lines.push(`Originating session: @session:${sessionId}`);
  }
  if (timestamp) {
    lines.push(`Occurred at: ${timestamp}`);
  }

  const diagnostics: Array<[string, string | null]> = [
    ["Notice type", formatOptional(notice.errorType)],
    ["Severity", formatOptional(notice.severity)],
    ["Termination reason", formatOptional(notice.terminationReason)],
    ["Abort reason", formatOptional(notice.abortReason)],
    ["Degradation reason", formatOptional(notice.degradationReason)],
    ["Last stop reason", formatOptional(notice.lastStopReason)],
    ["Iterations used", formatOptional(notice.iterationsUsed)],
    ["Duration (ms)", formatOptional(notice.durationMs)],
    ["Tool call count", formatOptional(notice.toolCallCount)],
  ];

  const present = diagnostics.filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (present.length > 0) {
    lines.push("", "Diagnostic fields:");
    for (const [key, value] of present) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  lines.push(
    "",
    isError
      ? "Load the originating session transcript and relevant logs, identify the failed invariant, and ship the smallest coherent fix."
      : "Load the originating session transcript and relevant logs, determine whether this warning is expected or a failed invariant, and ship the smallest coherent fix when action is needed.",
  );

  return lines.join("\n");
}

export function SystemNoticeMessage({
  notice,
  timestamp,
  sessionId,
  noticeKey,
}: SystemNoticeMessageProps) {
  const isError = notice.severity === "error";
  const isActionableNotice = isError || notice.errorType !== "user_stopped";
  const isDismissed = typeof notice.dismissedAt === "string" && notice.dismissedAt.length > 0;
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  // Error = red circle; Warning = amber triangle.
  const Icon = isError ? AlertCircle : AlertTriangle;
  const label = ERROR_TYPE_LABELS[notice.errorType] || (isError ? "Error" : "Warning");
  const discussion = useAgendaDiscussion();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: personasData } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/personas"],
    enabled: isActionableNotice && !isDismissed && !locallyDismissed,
  });
  const engineerId = useMemo(
    () => personasData?.find((persona) => persona.name.toLowerCase() === "engineer")?.id,
    [personasData],
  );

  const pendingKey = noticeKey || `${sessionId || "session"}-${notice.errorType}-${timestamp || "now"}`;
  const discussPending =
    discussion.isPending && discussion.variables?.pendingKey === pendingKey;

  const dismissMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId || !noticeKey) {
        throw new Error("Missing session or notice identity");
      }
      // Dismiss is the REVIEW-clearing mutation. Continue is best-effort after
      // that so a failed agent admission cannot resurrect the notice.
      await apiRequest(
        "POST",
        `/api/sessions/${sessionId}/notices/${encodeURIComponent(noticeKey)}/dismiss`,
      );
      try {
        await apiRequest("POST", `/api/sessions/${sessionId}/messages`, {
          content: CONTINUE_MESSAGE,
          clientTurnId: `notice-dismiss-${noticeKey}`.slice(0, 120),
          clientId: getClientTabId(),
        });
        return { continued: true as const };
      } catch (continueError) {
        return {
          continued: false as const,
          continueError:
            continueError instanceof Error
              ? continueError.message
              : "Failed to send continue message",
        };
      }
    },
    onMutate: async () => {
      // Hide immediately; session REVIEW/severity recompute is server-owned because
      // another undismissed notice may still require Review.
      setLocallyDismissed(true);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      if (!result.continued) {
        toast({
          title: "Notice dismissed",
          description: result.continueError || "Could not send Please continue...",
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      setLocallyDismissed(false);
      toast({
        title: "Could not dismiss notice",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleDiscuss = () => {
    if (discussion.isPending || dismissMutation.isPending) return;
    discussion.mutate({
      pendingKey,
      title: `${isError ? "Error" : "Warning"}: ${label}`.slice(0, 80),
      message: buildSystemNoticeDiscussionMessage({ notice, sessionId, timestamp }),
      clientTurnSuffix: `system-notice-${pendingKey}`.slice(0, 80),
      ...(engineerId ? { personaId: engineerId } : {}),
    });
  };

  const handleDismiss = () => {
    if (!sessionId || !noticeKey || dismissMutation.isPending || isDismissed || locallyDismissed) {
      return;
    }
    dismissMutation.mutate();
  };

  // User-stopped notices are passive. Operational warnings need a visible,
  // semantic warning treatment so their real stop reason is not lost.
  if (!isError && notice.errorType === "user_stopped") {
    return (
      <div className="w-full py-2 text-center" data-testid="system-notice-message">
        <p className="text-xs text-muted-foreground/60">
          {notice.description}{" "}
          <span className="text-muted-foreground/40">{notice.actionHint}</span>
        </p>
      </div>
    );
  }

  // Dismissed notices leave the transcript so REVIEW can clear without a second
  // residual error card. Local hide covers the optimistic path before refetch.
  if (isDismissed || locallyDismissed) {
    return null;
  }

  const tone = isError
    ? {
        shell: "border-destructive bg-destructive/5",
        icon: "text-destructive",
        label: "text-destructive",
        description: "text-muted-foreground",
        hint: "text-muted-foreground/70",
        menuLabel: "Error actions",
      }
    : {
        shell: "border-warning bg-warning/10",
        icon: "text-warning",
        label: "text-warning",
        description: "text-foreground/80",
        hint: "text-muted-foreground",
        menuLabel: "Warning actions",
      };

  const canDismiss = Boolean(sessionId && noticeKey);

  return (
    <div
      className={`w-full rounded-md border-l-2 p-3 ${tone.shell}`}
      data-testid="system-notice-message"
    >
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone.icon}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-xs font-medium ${tone.label}`}>{label}</span>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
                  aria-label={tone.menuLabel}
                  data-testid="button-system-notice-menu"
                >
                  <MoreHorizontal className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={discussPending || dismissMutation.isPending}
                  onSelect={(event) => {
                    event.preventDefault();
                    handleDiscuss();
                  }}
                  data-testid="menu-system-notice-discuss"
                >
                  {discussPending ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <MessageSquare className="mr-2 h-3.5 w-3.5" />
                  )}
                  Discuss
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <p className={`text-sm ${tone.description}`}>{notice.description}</p>
          <p className={`text-xs ${tone.hint}`}>{notice.actionHint}</p>
          <div className="flex items-center justify-end gap-2">
            {timestamp && (
              <span
                className="text-2xs text-muted-foreground/50"
                data-testid="text-system-notice-timestamp"
              >
                {formatDistanceToNow(new Date(timestamp), { addSuffix: true })}
              </span>
            )}
            {canDismiss && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-2xs text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                disabled={dismissMutation.isPending}
                onClick={handleDismiss}
                aria-label="Dismiss notice and continue"
                data-testid="button-system-notice-dismiss"
              >
                {dismissMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <X className="h-3 w-3" />
                )}
                Dismiss
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Safely parse a system_notice message content string into a SystemNotice object */
export function parseSystemNotice(content: string): SystemNotice | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.severity === "string" && typeof parsed.description === "string") {
      return parsed as SystemNotice;
    }
    return null;
  } catch {
    return null;
  }
}
