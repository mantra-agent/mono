import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SimpleFeedItem } from "@shared/models/simple";
import type { LibraryPage } from "@/pages/library/types";
import { createReferenceRef } from "@shared/references";
import { ChevronRight, Loader2, MessageSquare, MoreHorizontal, X } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { apiRequest } from "@/lib/queryClient";
import { useFocusSession } from "@/hooks/use-focus-session";
import { ReminderPopover } from "@/components/library-reminder";
import { cn } from "@/lib/utils";

type CreatedSession = { id: string };

interface SurfacedPersonRowProps {
  item: SimpleFeedItem;
  onSurfaceChange?: () => void;
  dateLabel?: string;
}

function formatSurfacedDate(value?: string | Date | null): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

export function surfacedDateLabel(item: SimpleFeedItem | LibraryPage): string {
  if ("payload" in item) {
    const value = typeof item.payload?.inboxAddedAt === "string" ? item.payload.inboxAddedAt : item.anchorTime ?? item.actionTime;
    return item.time || formatSurfacedDate(value);
  }
  return formatSurfacedDate(item.updatedAt ?? item.createdAt);
}

function personPayloadString(item: SimpleFeedItem, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function personIdFromItem(item: SimpleFeedItem): string | null {
  return item.sourceRefs.find(ref => ref.type === "person")?.id ?? null;
}

function isCloseConnection(item: SimpleFeedItem): boolean {
  const cabinetLevel = personPayloadString(item, "cabinetLevel")?.toLowerCase();
  return cabinetLevel === "family" || cabinetLevel === "cabinet";
}

export function SurfacedPersonRow({ item, onSurfaceChange, dateLabel }: SurfacedPersonRowProps) {
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const personId = personIdFromItem(item);
  const firstSourceRef = item.sourceRefs[0];
  const reference = item.references?.[0] ?? (firstSourceRef ? createReferenceRef({
    type: "person",
    id: firstSourceRef.id,
    metadata: { label: item.title, href: firstSourceRef.href },
  }) : null);
  const surfaceTier = personPayloadString(item, "surfaceTier");
  const reason = personPayloadString(item, "followUpReason") ?? personPayloadString(item, "reason");
  const rowVerb = surfaceTier === "follow_up" ? "Follow-up" : isCloseConnection(item) ? "Check-in" : "Reconnect";

  const reasonKey = personPayloadString(item, "reasonKey");
  const lastInteractionContext = personPayloadString(item, "lastInteractionContext");
  const missingContext = item.payload?.missingLastInteractionContext === true;
  const snoozedUntil = personPayloadString(item, "snoozedUntil");

  const surfaceMutation = useMutation({
    mutationFn: async (body: { action: "dismiss" | "snooze"; reasonKey?: string | null; snoozedUntil?: string }) => {
      if (!personId) throw new Error("Missing person id");
      await apiRequest("PATCH", `/api/home/people/${personId}/surface`, body);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
      onSurfaceChange?.();
    },
  });

  const discussMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sessions", { title: item.title.slice(0, 80) || "Person" });
      const session: CreatedSession = await res.json();
      const parts = [`Let's discuss this Simple item: **${item.title}**`, "Type: person", `Reason: ${reason || "No reason provided."}`];
      if (personId) parts.push(`Reference: @person:${personId}`);
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

  const pending = surfaceMutation.isPending;
  const dismiss = () => surfaceMutation.mutate({ action: "dismiss", reasonKey });
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
          data-testid={`surfaced-person-row-${personId ?? item.id}`}
        >
          <span className="w-14 shrink-0 text-right pr-1.5 text-[11px] leading-tight tabular-nums text-muted-foreground whitespace-nowrap">
            {snoozedUntil ? "SNOOZED" : dateLabel ?? ""}
          </span>
          <span className="w-4 shrink-0 flex items-center justify-center">
            <SimpleCheckCircle
              pending={pending}
              disabled={pending || !personId}
              label={`Dismiss ${item.title} from inbox`}
              onClick={dismiss}
            />
          </span>
          <div className="relative min-w-0 flex-1 pl-2">
            <span className="inline-flex max-w-full items-center gap-0.5 text-sm" onClick={(e) => e.stopPropagation()}>
              <span className="shrink-0 text-muted-foreground">{rowVerb} with</span>
              {reference ? <ReferenceRenderer refValue={reference} surface="simple-row" className="mx-0" /> : <span className="truncate font-medium">{item.title}</span>}

            </span>
          </div>
          <CollapsibleTrigger
            type="button"
            className="ml-1 p-0.5 shrink-0 rounded opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
            aria-label={`${open ? "Collapse" : "Expand"} ${item.title}`}
            onClick={(event) => event.stopPropagation()}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          </CollapsibleTrigger>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="ml-1 p-0.5 shrink-0 rounded opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                aria-label={`Actions for ${item.title}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem disabled={discussMutation.isPending} onClick={(e) => { e.stopPropagation(); discussMutation.mutate(); }}>
                {discussMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5 mr-2" />}
                Discuss
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {personId && reasonKey && (
                <ReminderPopover
                  title={item.title}
                  postUrl={`/api/home/people/${personId}/surface`}
                  postMethod="PATCH"
                  buildPayload={({ fireAt }) => ({
                    action: "snooze",
                    reasonKey,
                    snoozedUntil: fireAt,
                  })}
                  invalidateKeys={[["/api/home/feed"]]}
                  allowNextBuild={false}
                  onReminderSet={() => setMenuOpen(false)}
                />
              )}
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
              <p className="my-0"><span className="font-semibold">Reason:</span> {reason || "Missing follow-up reason."}</p>
              <p className="my-1"><span className="font-semibold">Last interaction:</span> {lastInteractionContext || "Missing last-interaction context."}</p>
              {missingContext && <p className="my-0 italic text-muted-foreground">Open People to add interaction context.</p>}
              {snoozedUntil && <p className="my-1 text-muted-foreground">Snoozed until {new Date(snoozedUntil).toLocaleString()}</p>}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
