import { useState, type ReactNode } from "react";
import { ChevronDown, Loader2, MessageSquare, MoreHorizontal } from "lucide-react";
import type { SimpleFeedItem } from "@shared/models/simple";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { sourceRefsToReferenceRefs } from "@shared/simple-references";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useFocusSession } from "@/hooks/use-focus-session";
import { cn } from "@/lib/utils";

type CreatedSession = { id: string };

interface SimpleCardProps {
  item: SimpleFeedItem;
  meta?: ReactNode;
  children?: ReactNode;
}

export function SimpleCard({ item, meta, children }: SimpleCardProps) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const hasResolvedReferences = Boolean(item.references?.length);
  const hasFallbackSourceRefs = Boolean(!hasResolvedReferences && item.sourceRefs?.length);
  const hasDetail = Boolean(children) || hasFallbackSourceRefs || Boolean(item.actions?.length);
  const discussMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sessions", { title: item.title.slice(0, 80) || "Simple Item" });
      const session: CreatedSession = await res.json();
      await apiRequest("POST", `/api/sessions/${session.id}/messages`, {
        content: [`Let's discuss this Simple item: **${item.title}**`, `Type: ${item.widgetType}`, `Section: ${item.section}`].join("\n"),
      });
      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
    },
  });

  return (
    <div className="rounded-xl border border-card-border bg-card/80 transition-colors hover:bg-card">
      <div
        className={cn("flex w-full items-center justify-between gap-3 px-4 py-3 text-left", hasDetail && "cursor-pointer")}
        onClick={() => hasDetail && setOpen(value => !value)}
        onKeyDown={(event) => {
          if (!hasDetail) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(value => !value);
          }
        }}
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        aria-expanded={hasDetail ? open : undefined}
      >
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-base font-medium", item.status === "completed" && "text-neutral line-through decoration-neutral/60")}>{item.title}</div>
          {meta && <div className="mt-2 flex flex-wrap items-center gap-1.5">{meta}</div>}
        </div>
        <span className="ml-1 flex w-5 shrink-0 items-center justify-center">
          {hasDetail ? <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} /> : null}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <span
              role="button"
              tabIndex={0}
              className="flex w-5 shrink-0 items-center justify-center rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              aria-label={`Actions for ${item.title}`}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              disabled={discussMutation.isPending}
              onClick={(event) => {
                event.stopPropagation();
                discussMutation.mutate();
              }}
            >
              {discussMutation.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="mr-2 h-3.5 w-3.5" />}
              Discuss
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {hasResolvedReferences ? (
        <div className="flex flex-wrap gap-1.5 px-4 pb-3">
          {item.references!.map(ref => (
            <ReferenceRenderer key={ref.canonical} refValue={ref} surface="simple-row" />
          ))}
        </div>
      ) : null}
      {open && hasDetail && (
        <div className="border-t border-border/60 px-4 pb-4 pt-3 text-sm text-muted-foreground">
          {children}
          {hasFallbackSourceRefs ? (
            <div className={cn("flex flex-wrap gap-1.5", children && "mt-4")}>
              {item.sourceRefs.map(ref => (
                <Badge key={`${ref.type}-${ref.id}`} variant="outline" className="rounded-sm text-[10px]">
                  {ref.label || ref.id}
                </Badge>
              ))}
            </div>
          ) : null}
          {item.actions?.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {item.actions.map(action => action.href ? (
                <Button key={action.id} asChild variant="outline" size="sm">
                  <a href={action.href}>{action.label}</a>
                </Button>
              ) : (
                <Badge key={action.id} variant="outline" className="rounded-sm">{action.label}</Badge>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
