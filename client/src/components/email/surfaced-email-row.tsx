import { useState } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { SimpleFeed, SimpleFeedItem } from "@shared/models/simple";
import { ChevronRight, Loader2, Mail, MessageSquare, MoreHorizontal, X } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { apiRequest } from "@/lib/queryClient";
import { useFocusSession } from "@/hooks/use-focus-session";
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

function removeFeedItem(feed: SimpleFeed | undefined, itemId: string): SimpleFeed | undefined {
  if (!feed) return feed;
  let removed = false;
  const sections = feed.sections.map(section => {
    const items = section.items.filter(item => {
      const keep = item.id !== itemId;
      if (!keep) removed = true;
      return keep;
    });
    return items === section.items ? section : { ...section, items };
  });
  return removed ? { ...feed, sections } : feed;
}

function restoreQueries(queryClient: ReturnType<typeof useQueryClient>, snapshots?: Array<{ queryKey: QueryKey; data: unknown }>) {
  snapshots?.forEach(snapshot => queryClient.setQueryData(snapshot.queryKey, snapshot.data));
}

export function SurfacedEmailRow({ item, dateLabel }: SurfacedEmailRowProps) {
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const sender = payloadString(item, "sender") ?? "Unknown";
  const reason = payloadString(item, "reason");
  const snippet = payloadString(item, "snippet");
  const triageTier = payloadString(item, "triageTier");

  // Extract thread identity from sourceRef id (format: "accountId:providerThreadId")
  const sourceRef = item.sourceRefs.find(ref => ref.type === "email");
  const [accountId, providerThreadId] = (sourceRef?.id ?? "").split(":");

  const dismissMutation = useMutation({
    mutationFn: async () => {
      if (!providerThreadId || !accountId) throw new Error("Missing email thread identity");
      await apiRequest("POST", "/api/email/history/record", {
        providerThreadId,
        accountId,
        subject: item.title,
        dismissedBy: "simple_inbox",
      });
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/home/feed"] });
      await queryClient.cancelQueries({ queryKey: ["/api/simple/feed"] });

      const queryCache = queryClient.getQueryCache();
      const feedQueries = [
        ...queryCache.findAll({ queryKey: ["/api/home/feed"] }),
        ...queryCache.findAll({ queryKey: ["/api/simple/feed"] }),
      ];
      const snapshots = feedQueries.map(query => ({ queryKey: query.queryKey, data: query.state.data }));
      feedQueries.forEach(query => {
        queryClient.setQueryData<SimpleFeed>(query.queryKey, old => removeFeedItem(old, item.id));
      });
      return { snapshots };
    },
    onError: (_error, _variables, context) => {
      restoreQueries(queryClient, context?.snapshots);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/simple/feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/email/messages"] });
    },
  });

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

  const pending = dismissMutation.isPending;
  const dismiss = () => dismissMutation.mutate();

  const tierIcon = triageTier === "🔴" ? "🔴" : triageTier === "🟡" ? "🟡" : triageTier === "🟢" ? "🟢" : null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn(pending && "opacity-60")}>
        <div
          className="group flex cursor-pointer items-center py-1 transition-colors duration-200 hover:bg-accent/50 rounded-md"
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
          <span className="w-14 shrink-0 text-right pr-1.5 text-[11px] leading-tight tabular-nums text-muted-foreground whitespace-nowrap">
            {dateLabel ?? ""}
          </span>
          <span className="w-4 shrink-0 flex items-center justify-center">
            <SimpleCheckCircle pending={pending} disabled={pending || !providerThreadId} label={`Dismiss ${item.title} from inbox`} onClick={dismiss} />
          </span>
          <div className="relative min-w-0 flex-1 pl-2">
            <span className="inline-flex max-w-full items-center gap-1 text-sm">
              <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground">{sender}</span>
              {tierIcon && <span className="shrink-0 text-xs">{tierIcon}</span>}
              <span className="min-w-0 truncate font-medium">{item.title}</span>
            </span>
          </div>
          <CollapsibleTrigger type="button" className="ml-1 p-0.5 shrink-0 rounded hover:bg-accent/60" aria-label={`${open ? "Collapse" : "Expand"} ${item.title}`} onClick={(event) => event.stopPropagation()}>
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          </CollapsibleTrigger>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button type="button" className="ml-1 p-0.5 shrink-0 rounded hover:bg-accent/60" aria-label={`Actions for ${item.title}`} onClick={(e) => e.stopPropagation()}>
                <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem disabled={discussMutation.isPending} onClick={(e) => { e.stopPropagation(); discussMutation.mutate(); }}>
                {discussMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5 mr-2" />}
                Discuss
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); window.location.href = "/comms"; }}>
                <Mail className="h-3.5 w-3.5 mr-2" />
                Open in Comms
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); dismiss(); setMenuOpen(false); }}>
                <X className="h-3.5 w-3.5 mr-2" />
                Dismiss
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
