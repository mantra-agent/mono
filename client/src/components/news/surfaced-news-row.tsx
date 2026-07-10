import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SimpleFeedItem } from "@shared/models/simple";
import { Bookmark, ChevronRight, ExternalLink, Loader2, MessageSquare, MoreHorizontal, X } from "lucide-react";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
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

function payloadStrings(item: SimpleFeedItem, key: string): string[] {
  const value = item.payload?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : [];
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
  const summary = payloadString(item, "summary");
  const reason = payloadString(item, "reason");
  const originalTitle = payloadString(item, "originalTitle");
  const matchedTopics = payloadStrings(item, "matchedTopics");
  const reference = item.references?.[0] ?? null;

  const statusMutation = useMutation({
    mutationFn: async (status: "dismissed" | "saved") => {
      if (!signalId) throw new Error("Missing news signal id");
      await apiRequest("PATCH", `/api/landscape/signals/${signalId}/status`, { status });
    },
    onSettled: () => {
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
        summary ? `Summary: ${summary}` : null,
        reason ? `Analysis: ${reason}` : null,
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
          <div className="relative min-w-0 flex-1 pl-2" onClick={(event) => event.stopPropagation()}>
            {reference ? (
              <ReferenceRenderer refValue={reference} surface="simple-row" className="mx-0 max-w-full text-sm font-medium" />
            ) : (
              <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
            )}
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
            <div className="rounded-md border border-border/40 bg-card/40 p-3 text-sm">
              {summary && <p className="text-foreground">{summary}</p>}
              {reason && <p className={cn("text-muted-foreground", summary && "mt-2")}>{reason}</p>}
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {originalTitle && <div className="font-medium text-foreground/80">{originalTitle}</div>}
                {matchedTopics.length > 0 && <div>Topics: {matchedTopics.join(", ")}</div>}
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
