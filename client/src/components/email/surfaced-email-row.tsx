import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SimpleFeedItem } from "@shared/models/simple";
import { ChevronRight, Loader2, Mail, MessageSquare, MoreHorizontal, X } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReminderPopover } from "@/components/library-reminder";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { apiRequest } from "@/lib/queryClient";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useToast } from "@/hooks/use-toast";
import { useEmailMarkDone, useEmailSnooze } from "@/hooks/use-email-thread-actions";
import { cn } from "@/lib/utils";

interface SurfacedEmailRowProps {
  item: SimpleFeedItem;
  dateLabel?: string;
}

type CreatedSession = { id: string };

function payloadString(item: SimpleFeedItem, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function payloadNumberArray(item: SimpleFeedItem, key: string): number[] {
  const value = item.payload?.[key];
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter(Number.isFinite);
}

function formatSnoozeTime(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SurfacedEmailRow({ item, dateLabel }: SurfacedEmailRowProps) {
  const queryClient = useQueryClient();
  const toast = useToast().toast;
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const sender = payloadString(item, "sender") ?? "Unknown";
  const reason = payloadString(item, "reason");
  const snippet = payloadString(item, "snippet");
  const triageTier = payloadString(item, "triageTier");
  const messageIds = useMemo(() => payloadNumberArray(item, "messageIds"), [item]);

  const sourceRef = item.sourceRefs.find(ref => ref.type === "email");
  const [accountId, providerThreadId] = (sourceRef?.id ?? "").split(":");

  const markDone = useEmailMarkDone();
  const snoozeMutation = useEmailSnooze();

  const dismiss = () => {
    if (messageIds.length === 0) {
      toast({ title: "Email identity missing", description: "This inbox item cannot be dismissed until the feed includes message IDs.", variant: "destructive" });
      return;
    }
    markDone.mutate({
      ids: messageIds,
      isDone: true,
      threadMeta: {
        providerThreadId,
        accountId,
        tier: triageTier || undefined,
        sender,
        subject: item.title,
      },
    });
  };

  const handleSnooze = (snoozedUntil: string) => {
    if (messageIds.length === 0) {
      toast({ title: "Email identity missing", description: "This inbox item cannot be snoozed until the feed includes message IDs.", variant: "destructive" });
      return;
    }
    const formatted = formatSnoozeTime(new Date(snoozedUntil));
    snoozeMutation.mutate({ ids: messageIds, snoozedUntil }, {
      onSuccess: () => {
        toast({
          title: `Snoozed until ${formatted}`,
          action: (
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs"
              onClick={() => snoozeMutation.mutate({ ids: messageIds, snoozedUntil: null })}
            >
              Undo
            </button>
          ),
        });
        setMenuOpen(false);
      },
      onError: (err: Error) => {
        toast({ title: "Snooze failed", description: err.message, variant: "destructive" });
      },
    });
  };

  const discussMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sessions", { title: item.title.slice(0, 80) || "Email" });
      const session: CreatedSession = await res.json();
      const parts = [
        `Let's discuss this email thread: **${item.title}**`,
        `From: ${sender}`,
        reason ? `Summary: ${reason}` : null,
        snippet ? `Snippet: ${snippet}` : null,
        providerThreadId ? `Thread ID: ${providerThreadId}` : null,
      ].filter(Boolean);
      await apiRequest("POST", `/api/sessions/${session.id}/messages`, { content: parts.join("\n") });
      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
      setMenuOpen(false);
    },
  });

  const pending = markDone.isPending || snoozeMutation.isPending;
  const tierIcon = triageTier === "🔴" ? "🔴" : triageTier === "🟡" ? "🟡" : triageTier === "🟢" ? "🟢" : null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn(pending && "opacity-60")}>
        <div
          className="group flex cursor-pointer items-center rounded-md py-1 transition-colors duration-200 hover:bg-accent/50"
          onClick={() => setOpen(v => !v)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setOpen(v => !v);
            }
          }}
          data-testid={`surfaced-email-row-${item.id}`}
        >
          <span className="w-14 shrink-0 whitespace-nowrap pr-1.5 text-right text-[11px] leading-tight tabular-nums text-muted-foreground">
            {dateLabel ?? ""}
          </span>
          <span className="flex w-4 shrink-0 items-center justify-center">
            <SimpleCheckCircle pending={markDone.isPending} disabled={pending || messageIds.length === 0} label={`Dismiss ${item.title} from inbox`} onClick={dismiss} />
          </span>
          <div className="relative min-w-0 flex-1 pl-2">
            <span className="inline-flex max-w-full items-center gap-1 text-sm">
              <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground">{sender}</span>
              {tierIcon && <span className="shrink-0 text-xs">{tierIcon}</span>}
              <span className="min-w-0 truncate font-medium">{item.title}</span>
            </span>
          </div>
          <CollapsibleTrigger type="button" className="ml-1 shrink-0 rounded p-0.5 hover:bg-accent/60" aria-label={`${open ? "Collapse" : "Expand"} ${item.title}`} onClick={(event) => event.stopPropagation()}>
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          </CollapsibleTrigger>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" className="ml-1 shrink-0 rounded p-0.5 opacity-0 hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100" aria-label={`Actions for ${item.title}`} onClick={(e) => e.stopPropagation()}>
                <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem disabled={discussMutation.isPending} onClick={(e) => { e.stopPropagation(); discussMutation.mutate(); }}>
                {discussMutation.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="mr-2 h-3.5 w-3.5" />}
                Discuss
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); window.location.href = "/comms"; }}>
                <Mail className="mr-2 h-3.5 w-3.5" />
                Open in Comms
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <ReminderPopover title={item.title} onSelect={handleSnooze} allowNextBoot={false} />
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); dismiss(); setMenuOpen(false); }} disabled={markDone.isPending || messageIds.length === 0}>
                <X className="mr-2 h-3.5 w-3.5" />
                Mark done
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent>
          <div className="pb-2 pl-0 pr-1.5">
            <div className="max-w-none rounded-xl rounded-bl-sm border border-primary/20 bg-card/70 px-3 py-2 text-xs leading-relaxed text-white">
              {reason && <p className="my-0"><span className="font-semibold">Summary:</span> {reason}</p>}
              {snippet && <p className="my-1"><span className="font-semibold">Preview:</span> {snippet}</p>}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
