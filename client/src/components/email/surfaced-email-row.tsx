import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SimpleFeedItem } from "@shared/models/simple";
import { CalendarClock, ChevronRight, Clock, Loader2, Mail, MessageSquare, MoreHorizontal, X } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { SIMPLE_TEXT_FRAME_CLASS } from "@/components/home/simple-text-frame";
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

function reminderPresets() {
  return [
    { label: "In 15 minutes", at: () => Date.now() + 15 * 60 * 1000 },
    { label: "In 1 hour", at: () => Date.now() + 60 * 60 * 1000 },
    { label: "In 3 hours", at: () => Date.now() + 3 * 60 * 60 * 1000 },
    { label: "Tomorrow morning", at: () => { const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); return date.getTime(); } },
    { label: "In two days", at: () => { const date = new Date(); date.setDate(date.getDate() + 2); date.setHours(9, 0, 0, 0); return date.getTime(); } },
    { label: "Next week", at: () => { const date = new Date(); date.setDate(date.getDate() + 7); date.setHours(9, 0, 0, 0); return date.getTime(); } },
    { label: "In two weeks", at: () => { const date = new Date(); date.setDate(date.getDate() + 14); date.setHours(9, 0, 0, 0); return date.getTime(); } },
    { label: "Next month", at: () => { const date = new Date(); date.setMonth(date.getMonth() + 1); date.setHours(9, 0, 0, 0); return date.getTime(); } },
  ];
}

export function SurfacedEmailRow({ item, dateLabel }: SurfacedEmailRowProps) {
  const queryClient = useQueryClient();
  const toast = useToast().toast;
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const sender = payloadString(item, "sender") ?? "Unknown";
  const senderReference = item.references?.find(ref => ref.type === "person") ?? null;
  const reason = payloadString(item, "reason");
  const snippet = payloadString(item, "snippet");
  const summary = reason ?? snippet;
  const fullMessage = payloadString(item, "fullMessage");
  // Kept for dismiss metadata only — no longer rendered as a traffic-light icon.
  const triageTier = payloadString(item, "triageTier");
  const messageIds = useMemo(() => payloadNumberArray(item, "messageIds"), [item]);
  const sourceRef = item.sourceRefs.find(ref => ref.type === "email");
  const [accountId, providerThreadId] = (sourceRef?.id ?? "").split(":");
  const emailHref = sourceRef?.href
    || (accountId && providerThreadId
      ? `/comms?thread=${encodeURIComponent(`${accountId}:${providerThreadId}`)}`
      : "/comms");
  const primaryAction = payloadString(item, "primaryAction") === "invite" ? "invite" : "reply";
  const actionLabel = payloadString(item, "actionLabel") ?? (primaryAction === "invite" ? "Invite" : "Reply");
  const actionReference = item.references?.find(ref => ref.type === "email_thread") ?? null;

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
      const res = await apiRequest("POST", "/api/sessions", { title: item.title.slice(0, 80) || "Email", personaName: "Strategist" });
      const session: CreatedSession = await res.json();
      const emailThreadRef = sourceRef?.id ? `@email_thread:${sourceRef.id}` : null;
      const latestMessageId = messageIds[0];
      const emailMessageRef = latestMessageId ? `@email_message:${latestMessageId}` : null;
      const personRef = senderReference?.id ? `@person:${senderReference.id}` : null;
      const parts = [
        `Let's discuss this email thread: **${item.title}**`,
        "",
        "Load the relevant context from previous interactions, projects, goals, and memories for the person and email thread.",
        primaryAction === "invite"
          ? "Discuss and handle the calendar invitation using its available context. Do not draft an email reply or imply RSVP authority; identify the appropriate next step and ask a clarifying question only if a consequential choice remains."
          : "Use the draft tool to draft a reply that both addresses the open question in the email thread and moves forward our goals, unless there are any ambiguities about what the draft should include, in which case first ask clarifying question(s) using the question tool.",
        "",
        emailThreadRef ? `Email thread: ${emailThreadRef}` : null,
        emailMessageRef ? `Latest message: ${emailMessageRef}` : null,
        personRef ? `Person: ${personRef}` : null,
        `From: ${sender}`,
        reason ? `Summary: ${reason}` : null,
        snippet ? `Snippet: ${snippet}` : null,
        `Open email: ${emailHref}`,
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
          <span className="w-14 shrink-0 whitespace-pre-line pr-1.5 text-right text-[11px] leading-tight tabular-nums text-muted-foreground">
            {dateLabel ?? ""}
          </span>
          <span className="flex w-4 shrink-0 items-center justify-center">
            <SimpleCheckCircle pending={markDone.isPending} disabled={pending || messageIds.length === 0} label={`Dismiss ${item.title} from inbox`} onClick={dismiss} />
          </span>
          <div className="relative min-w-0 flex-1 pl-2">
            <span className="inline-flex max-w-full items-center gap-1 text-xs">
              {actionReference ? (
                <span className="inline-flex min-w-0 items-center" onClick={(e) => e.stopPropagation()}>
                  <ReferenceRenderer refValue={actionReference} surface="simple-row" className="mx-0" />
                </span>
              ) : (
                <span className="shrink-0 text-muted-foreground">{actionLabel}</span>
              )}
              <span className="shrink-0 text-muted-foreground">from</span>
              {senderReference ? (
                <span className="inline-flex min-w-0 items-center" onClick={(e) => e.stopPropagation()}>
                  <ReferenceRenderer refValue={senderReference} surface="simple-row" className="mx-0" />
                </span>
              ) : (
                <span className="min-w-0 truncate font-medium">{sender}</span>
              )}
            </span>
          </div>
          <CollapsibleTrigger type="button" className="ml-1 shrink-0 rounded p-0.5 hover:bg-accent/60" aria-label={`${open ? "Collapse" : "Expand"} ${item.title}`} onClick={(event) => event.stopPropagation()}>
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          </CollapsibleTrigger>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button type="button" className="ml-1 shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={`Actions for ${item.title}`} onClick={(event) => event.stopPropagation()}>
                <MoreHorizontal className="mx-auto h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className={discussMutation.isPending ? "[&_svg]:animate-spin" : undefined}
                disabled={discussMutation.isPending}
                onClick={() => discussMutation.mutate()}
              >
                {discussMutation.isPending ? <Loader2 /> : <MessageSquare />}
                Discuss
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { window.location.href = emailHref; }}>
                <Mail />
                Open in Comms
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={snoozeMutation.isPending}>
                  <Clock />
                  Reminder
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {reminderPresets().map((preset) => (
                    <DropdownMenuItem key={preset.label} onClick={() => handleSnooze(new Date(preset.at()).toISOString())}>
                      <CalendarClock />
                      {preset.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={dismiss} disabled={markDone.isPending || messageIds.length === 0}>
                <X />
                Mark done
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent>
          <div className="space-y-2 pb-2 pl-0 pr-1.5">
            {summary && (
              <div className={cn(SIMPLE_TEXT_FRAME_CLASS, "!text-muted-foreground [&_*]:!text-muted-foreground")}>
                <p>{summary}</p>
              </div>
            )}
            {fullMessage && (
              <div className={SIMPLE_TEXT_FRAME_CLASS}>
                <p className="whitespace-pre-wrap break-words">{fullMessage}</p>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
