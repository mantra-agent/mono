import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight, Loader2, MessageSquare, MoreHorizontal } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SimpleAction, SimpleFeed, SimpleFeedItem } from "@shared/models/simple";
import { sourceRefToReferenceRef, sourceRefsToReferenceRefs } from "@shared/simple-references";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { SimpleCheckCircle } from "./home-check-circle";
import { SimpleTextFrame } from "./simple-text-frame";
import { useFocusSession } from "@/hooks/use-focus-session";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MeetingAgentToggle } from "./widgets/meeting-agent-toggle";

// ─── Helpers ───

function completeAction(item: SimpleFeedItem): SimpleAction | null {
  return item.actions?.find(action => action.type === "complete") ?? null;
}

const EXTERNAL_URL_PATTERN = /(https?:\/\/\S+)/gi;

type CreatedSession = { id: string };


function itemDiscussTitle(item: SimpleFeedItem): string {
  return item.title.trim().slice(0, 80) || "Simple Item";
}

function buildDiscussMessage(item: SimpleFeedItem): string {
  const refs = item.references?.length ? item.references : sourceRefsToReferenceRefs(item.sourceRefs ?? []);
  const canonicalRefs = refs.map(ref => ref.canonical);

  const parts = [
    `Let's discuss this Simple item: **${item.title}**`,
    `Type: ${item.widgetType}`,
    `Section: ${item.section}`,
  ];
  if (item.time) parts.push(`Display time: ${item.time}`);
  if (canonicalRefs.length) parts.push(`Reference${canonicalRefs.length === 1 ? "" : "s"}: ${canonicalRefs.join(" ")}`);
  return parts.join("\n");
}

function firstExternalUrl(value: string): string | null {
  return value.match(EXTERNAL_URL_PATTERN)?.[0] ?? null;
}

function isMeetingLocationItem(item: SimpleFeedItem): boolean {
  return item.widgetType === "generic" && item.payload?.kind === "meeting_location";
}

function placeNameFromAddress(address: string): string {
  return address.split(",")[0]?.trim() || address;
}

function mapsSearchHref(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function primaryReference(item: SimpleFeedItem) {
  // Generic child rows can be source-grounded without wanting a visible reference link.
  // Only render explicit references for generic rows; typed widgets may still derive
  // their primary reference from sourceRefs.
  if (item.widgetType === "generic") return item.references?.[0] ?? null;
  return item.references?.[0] ?? (item.sourceRefs?.[0] ? sourceRefToReferenceRef(item.sourceRefs[0]) : null);
}

function markItemDone(feed: SimpleFeed | undefined, itemId: string): SimpleFeed | undefined {
  if (!feed) return feed;
  let completedItem: SimpleFeedItem | null = null;
  const sections = feed.sections
    .map(section => ({
      ...section,
      items: section.items.filter(item => {
        if (item.id !== itemId) return true;
        completedItem = {
          ...item,
          section: "done",
          status: "completed",
          completedAt: new Date().toISOString(),
        };
        return false;
      }),
    }))
    .filter(section => section.items.length > 0);

  if (!completedItem) return feed;

  const doneSection = sections.find(section => section.section === "done");
  if (doneSection) {
    doneSection.items = [completedItem, ...doneSection.items];
  } else {
    sections.push({ section: "done", items: [completedItem] });
  }

  return { ...feed, sections };
}

type EntryKind = "learning" | "gratitude" | "reflection";

function wellnessEntryKind(item: SimpleFeedItem): EntryKind | null {
  if (item.sourceRefs?.[0]?.type !== "wellness") return null;
  const name = String(item.sourceRefs[0]?.label ?? item.title).trim().toLowerCase();
  if (name === "learning") return "learning";
  if (name === "gratitude") return "gratitude";
  if (name === "reflection") return "reflection";
  return null;
}

function entryCopy(kind: EntryKind) {
  if (kind === "learning") {
    return { title: "What did you learn today?", label: "Learning", placeholder: "Today I learned…", endpoint: "/api/wellness/learning" };
  }
  if (kind === "reflection") {
    return { title: "What do you want to reflect on today?", label: "Reflection", placeholder: "Today I noticed…", endpoint: "/api/wellness/reflection" };
  }
  return { title: "What are you grateful for today?", label: "Gratitude", placeholder: "I’m grateful for…", endpoint: "/api/wellness/gratitude" };
}


function stringPayload(item: SimpleFeedItem, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function expandedContent(item: SimpleFeedItem): string | null {
  const kind = item.payload?.kind;

  if (kind === "meeting_attendee") {
    const parts: string[] = [];
    const lastInteraction = stringPayload(item, "lastInteractionContext");
    const summary = stringPayload(item, "profileSummary");
    parts.push(`**Last interaction**\n${lastInteraction ?? "No interaction recorded."}`);
    parts.push(`**Summary**\n${summary ?? "No profile summary available."}`);
    return parts.join("\n\n");
  }

  if (kind === "meeting_artifact") {
    return stringPayload(item, "artifactSummary") ?? stringPayload(item, "artifactOneLiner");
  }

  return null;
}

// ─── Tree Row ───

interface SimpleTreeRowProps {
  item: SimpleFeedItem;
  depth?: number;
  /** Embedded rows reuse Simple's reference, expander, content, and tree styling without feed-only rails. */
  layout?: "feed" | "embedded";
  /** Content to render in the title area. Falls back to reference link or item.title. */
  children?: ReactNode;
}

const INDENT_PX = 24;
const CONNECTOR_CLASS = "border-muted-foreground/50";

export function SimpleTreeRow({ item, depth = 0, layout = "feed", children }: SimpleTreeRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [entryContent, setEntryContent] = useState("");
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const action = completeAction(item);
  const reference = primaryReference(item);
  const inlineExpandedContent = expandedContent(item);
  const hasChildren = Boolean(item.children?.length);
  const canExpand = hasChildren || Boolean(inlineExpandedContent);
  const entryKind = wellnessEntryKind(item);
  const entryUi = useMemo(() => entryKind ? entryCopy(entryKind) : null, [entryKind]);

  const mutation = useMutation({
    mutationFn: async (content?: string) => {
      if (entryUi) {
        if (!content?.trim()) throw new Error(`${entryUi.label} content is required`);
        await apiRequest("POST", entryUi.endpoint, { content: content.trim() });
        return;
      }

      if (!action) throw new Error("No completion action available");
      await apiRequest("POST", `/api/home/items/${encodeURIComponent(item.id)}/complete`, {
        actionId: action.id,
        sourceType: action.sourceRef?.type ?? item.sourceRefs?.[0]?.type,
        payload: action.payload ?? {},
      });
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/home/feed"] });
      queryClient.setQueriesData<SimpleFeed>({ queryKey: ["/api/home/feed"] }, old => markItemDone(old, item.id));
    },
    onSuccess: () => {
      setEntryOpen(false);
      setEntryContent("");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
      if (entryUi) {
        queryClient.invalidateQueries({ queryKey: [entryUi.endpoint] });
        queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs"] });
      }
    },
  });

  const discussMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sessions", { title: itemDiscussTitle(item) });
      const session: CreatedSession = await res.json();
      await apiRequest("POST", `/api/sessions/${session.id}/messages`, { content: buildDiscussMessage(item) });
      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
    },
  });

  const completed = item.status === "completed" || mutation.isSuccess;
  const disabled = (!action && !entryUi) || mutation.isPending || completed;
  const showCheckCircle = completed || item.completable || item.widgetType === "meeting";
  const embedded = layout === "embedded";

  const titleHref = firstExternalUrl(item.title);
  const mapHref = isMeetingLocationItem(item) ? mapsSearchHref(item.title) : null;
  const displayTitle = mapHref ? placeNameFromAddress(item.title) : item.title;

  const toggleExpanded = () => {
    if (!canExpand) return;
    setExpanded(v => !v);
  };

  const requestCompletion = () => {
    if (entryUi) {
      setEntryOpen(true);
      return;
    }
    mutation.mutate(undefined);
  };

  const submitEntry = (event: FormEvent) => {
    event.preventDefault();
    if (!entryContent.trim() || mutation.isPending) return;
    mutation.mutate(entryContent);
  };

  const shouldIgnoreRowToggle = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest('a, button, input, textarea, select, [role="checkbox"]'));
  };

  // Default content: reference link, styled address/map link, styled external link, or plain title.
  const defaultContent = reference ? (
    <span>
      <ReferenceRenderer refValue={reference} surface="simple-row" className={completed ? "text-neutral hover:text-neutral" : undefined} />
    </span>
  ) : mapHref || titleHref ? (
    <a
      href={mapHref ?? titleHref ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex max-w-full truncate text-xs font-medium text-cta underline-offset-2 transition-colors hover:text-active hover:underline",
        completed && "text-neutral hover:text-neutral line-through",
      )}
      title={item.title}
    >
      {displayTitle}
    </a>
  ) : (
    <InlineReferenceText
      text={displayTitle}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 truncate text-xs font-medium transition-all duration-200",
        completed ? "text-neutral line-through" : "text-muted-foreground",
      )}
    />
  );

  return (
    <>
      <div
        className={cn(
          "group flex items-center py-1 transition-colors duration-200",
          !item.completable && "hover:bg-accent/50 rounded-md",
          canExpand && "cursor-pointer",
        )}
        style={{ paddingLeft: `${embedded ? 0 : depth * INDENT_PX}px` }}
        onClick={(event) => {
          if (shouldIgnoreRowToggle(event.target)) return;
          toggleExpanded();
        }}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        onKeyDown={(event) => {
          if (!canExpand) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleExpanded();
          }
        }}
      >
        {!embedded && (
          <>
            {/* Time column */}
            <span className="w-14 shrink-0 whitespace-pre-line text-right pr-1.5 text-[11px] leading-tight tabular-nums text-muted-foreground">
              {item.time ?? ""}
            </span>

            {/* Checkbox column (always rendered for vertical alignment) */}
            <span className="w-4 shrink-0 flex items-center justify-center">
              {item.payload?.needsDate && !completed ? (
                <SimpleCheckCircle variant="caution" tooltip="Missing Due Date" />
              ) : showCheckCircle ? (
                <SimpleCheckCircle
                  checked={completed}
                  pending={mutation.isPending}
                  disabled={disabled}
                  interactive={item.completable && !completed}
                  label={`Complete ${item.title}`}
                  onClick={requestCompletion}
                />
              ) : null}
            </span>
          </>
        )}

        {/* Content area */}
        <div
          className="relative min-w-0 flex-1 pl-0.5"
          onClick={reference ? (event) => event.stopPropagation() : undefined}
        >
          {/* Hierarchy connector lines (for nested items) —
              Vertical line at parent's checkbox center (1 indent = 24px back → -32px from content edge).
              Horizontal line goes from parent center toward child check-circle left edge.
              Width = 12px so the L connector ends just at the circle border (anti-alias safe). */}
          {depth > 0 && (
            <span
              className="pointer-events-none absolute inset-y-0"
              style={embedded ? { left: "-12px", width: "12px" } : { left: "-32px", width: "12px" }}
              aria-hidden="true"
            >
              <span className={cn("absolute left-0 top-0 bottom-1/2 border-l", CONNECTOR_CLASS)} />
              <span className={cn("absolute left-0 top-1/2 w-full border-t", CONNECTOR_CLASS)} />
            </span>
          )}
          {children ?? defaultContent}
        </div>

        {/* Right control rail: agent toggle (meetings), expander, then overflow. */}
        {!embedded && item.widgetType === "meeting" && <MeetingAgentToggle item={item} />}
        <span className="ml-1 flex w-5 shrink-0 items-center justify-center">
          {canExpand ? (
            <button
              type="button"
              className="rounded p-0.5 hover:bg-accent/60"
              onClick={(e) => { e.stopPropagation(); toggleExpanded(); }}
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")} />
            </button>
          ) : null}
        </span>
        {!embedded && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-5 shrink-0 items-center justify-center rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                aria-label={`Actions for ${item.title}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                disabled={discussMutation.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  discussMutation.mutate();
                }}
              >
                {discussMutation.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="mr-2 h-3.5 w-3.5" />}
                Discuss
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Expanded content */}
      {expanded && inlineExpandedContent && (
        <div className="pb-2 pl-0 pr-1.5">
          <SimpleTextFrame content={inlineExpandedContent} />
        </div>
      )}

      {/* Expanded children */}
      {expanded && hasChildren && (
        <div>
          {item.children!.map(child => (
            <SimpleTreeRow key={child.id} item={child} depth={depth + 1} layout={layout} />
          ))}
        </div>
      )}

      {entryUi ? (
        <Dialog open={entryOpen} onOpenChange={(open) => {
          if (!open && !mutation.isPending) {
            setEntryOpen(false);
            setEntryContent("");
          } else {
            setEntryOpen(open);
          }
        }}>
          <DialogContent className="sm:max-w-md">
            <form onSubmit={submitEntry} className="space-y-4">
              <DialogHeader>
                <DialogTitle>{entryUi.title}</DialogTitle>
                <DialogDescription>Save today’s {entryUi.label.toLowerCase()} entry to complete this activity.</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor={`${item.id}-entry`}>{entryUi.label}</Label>
                <Textarea
                  id={`${item.id}-entry`}
                  value={entryContent}
                  onChange={(event) => setEntryContent(event.target.value)}
                  placeholder={entryUi.placeholder}
                  maxLength={5000}
                  autoFocus
                  className="min-h-28 resize-none"
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={mutation.isPending}
                  onClick={() => {
                    setEntryOpen(false);
                    setEntryContent("");
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!entryContent.trim() || mutation.isPending}>
                  {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
