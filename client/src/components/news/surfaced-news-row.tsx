import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SimpleFeedItem } from "@shared/models/simple";
import { Bookmark, ChevronRight, ExternalLink, Loader2, MessageSquare, MoreHorizontal, Newspaper, X } from "lucide-react";
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

interface SurfacedNewsRowProps {
  item: SimpleFeedItem;
  dateLabel?: string;
}

type CreatedSession = { id: string };

function payloadString(item: SimpleFeedItem, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function newsSignalId(item: SimpleFeedItem): string | null {
  const value = payloadString(item, "signalId");
  return value ?? item.sourceRefs.find(ref => ref.type === "news")?.id ?? null;
}

export function SurfacedNewsRow({ item, dateLabel }: SurfacedNewsRowProps) {
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const signalId = newsSignalId(item);
  const url = payloadString(item, "url") ?? item.sourceRefs[0]?.href ?? null;
  const sourceLabel = payloadString(item, "sourceLabel") ?? "News";
  const reason = payloadString(item, "reason");
  const snippet = payloadString(item, "snippet");

  const statusMutation = useMutation({
    mutationFn: async (status: "dismissed" | "saved") => {
      if (!signalId) throw new Error("Missing news signal id");
      await apiRequest("PATCH", `/api/landscape/signals/${signalId}/status`, { status });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/simple/feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/landscape/signals"] });
    },
  });

  const discussMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sessions", { title: item.title.slice(0, 80) || "News" });
      const session: CreatedSession = await res.json();
      const parts = [
        `Let's discuss this Simple inbox news item: **${item.title}**`,
        `Source: ${sourceLabel}`,
        reason ? `Reason: ${reason}` : null,
        snippet ? `Snippet: ${snippet}` : null,
        url ? `URL: ${url}` : null,
        signalId ? `News signal ID: ${signalId}` : null,
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

  const pending = statusMutation.isPending;
  const dismiss = () => statusMutation.mutate("dismissed");
  const save = () => statusMutation.mutate("saved");
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
          data-testid={`surfaced-news-row-${signalId ?? item.id}`}
        >
          <span className="w-14 shrink-0 text-right pr-1.5 text-[11px] leading-tight tabular-nums text-muted-foreground whitespace-nowrap">
            {dateLabel ?? ""}
          </span>
          <span className="w-4 shrink-0 flex items-center justify-center">
            <SimpleCheckCircle pending={pending} disabled={pending || !signalId} label={`Dismiss ${item.title} from inbox`} onClick={dismiss} />
          </span>
          <div className="relative min-w-0 flex-1 pl-2">
            <span className="inline-flex max-w-full items-center gap-1 text-sm">
              <Newspaper className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground">News</span>
              <span className="min-w-0 truncate font-medium">{item.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{sourceLabel}</span>
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
              {url && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); window.open(url, "_blank", "noopener,noreferrer"); setMenuOpen(false); }}>
                  <ExternalLink className="h-3.5 w-3.5 mr-2" />
                  Open source
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!signalId} onClick={(e) => { e.stopPropagation(); save(); setMenuOpen(false); }}>
                <Bookmark className="h-3.5 w-3.5 mr-2" />
                Save
              </DropdownMenuItem>
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
              {reason && <p className="my-0"><span className="font-semibold">Why surfaced:</span> {reason}</p>}
              {snippet && <p className="my-1"><span className="font-semibold">Snippet:</span> {snippet}</p>}
              {url && <a href={url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-primary hover:underline">Open source <ExternalLink className="h-3 w-3" /></a>}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
