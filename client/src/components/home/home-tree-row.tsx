import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight, Loader2, MessageSquare, MoreHorizontal, Plus, Trash2, User } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SimpleAction, SimpleFeed, SimpleFeedItem } from "@shared/models/simple";
import { createReferenceRef, type ReferenceRef } from "@shared/references";
import type { MeetingAttendeePromotion } from "@shared/meeting-feed-items";
import { simpleItemContainsReference, simpleItemReferenceRefs, sourceRefToReferenceRef } from "@shared/simple-references";
import { buildSimpleDiscussMessage, simpleDiscussPersonaName, simpleDiscussTitle } from "@/lib/simple-discuss";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { SimpleCheckCircle } from "./home-check-circle";
import { SimpleTextFrame, SIMPLE_TEXT_FRAME_CLASS } from "./simple-text-frame";
import { useFocusSession } from "@/hooks/use-focus-session";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MeetingAgentToggle } from "./widgets/meeting-agent-toggle";
import { InlineLibraryPageEditor } from "@/components/library/inline-library-page";
import { useUiInteraction, useUiInteractionResource } from "@/hooks/use-ui-interaction";

type BuildExpandContentResponse = {
  kind: "version_history" | "main_merges" | "empty";
  content: string;
  empty?: string;
};

function buildEnvironmentId(item: SimpleFeedItem): number | null {
  if (item.payload?.kind !== "build_deployment") return null;
  // Collectors emit platformEnvironmentId; accept environmentId as alias so the
  // expander gate cannot silently miss the id when one side renames the field.
  const raw = item.payload?.platformEnvironmentId ?? item.payload?.environmentId;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return null;
}

function BuildExpandFrame({ environmentId, enabled }: { environmentId: number; enabled: boolean }) {
  const { data, isLoading, isError } = useQuery<BuildExpandContentResponse>({
    queryKey: ["/api/platforms/environments", environmentId, "build-expand-content"],
    enabled: enabled && environmentId > 0,
  });

  return (
    <SimpleTextFrame
      content={data?.content}
      loading={isLoading}
      error={isError ? "Build details could not be loaded." : null}
      empty={data?.empty ?? "No version history or merges to main yet."}
    />
  );
}

// ─── Helpers ───

function completeAction(item: SimpleFeedItem): SimpleAction | null {
  return item.actions?.find(action => action.type === "complete") ?? null;
}

const EXTERNAL_URL_PATTERN = /(https?:\/\/\S+)/gi;

type CreatedSession = { id: string };


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
  return simpleItemReferenceRefs(item)[0] ?? null;
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

function attendeePromotion(item: SimpleFeedItem): MeetingAttendeePromotion | null {
  if (item.payload?.kind !== "meeting_attendee" || item.payload?.personId) return null;
  const promotion = item.payload?.promotion;
  if (!promotion || typeof promotion !== "object" || Array.isArray(promotion)) return null;
  const value = promotion as Record<string, unknown>;
  if (typeof value.eventId !== "string" || typeof value.accountId !== "string" || typeof value.calendarId !== "string") return null;
  return { eventId: value.eventId, accountId: value.accountId, calendarId: value.calendarId };
}

function expandedContent(item: SimpleFeedItem, hasPerson: boolean): string | null {
  const kind = item.payload?.kind;

  if (kind === "meeting_attendee") {
    if (!hasPerson) return null;
    const parts: string[] = [];
    const lastInteraction = stringPayload(item, "lastInteractionContext");
    const summary = stringPayload(item, "profileSummary");
    parts.push(`**Last interaction**\n${lastInteraction ?? "No interaction recorded."}`);
    parts.push(`**Summary**\n${summary ?? "No profile summary available."}`);
    return parts.join("\n\n");
  }

  if (kind === "meeting_record") {
    return stringPayload(item, "meetingSummary");
  }

  if (kind === "meeting_artifact") {
    return stringPayload(item, "artifactSummary") ?? stringPayload(item, "artifactOneLiner");
  }

  return null;
}

// ─── Editable description (task + goal rows) ───

interface DescriptionTarget {
  /** REST endpoint that accepts a PATCH { description } for this entity. */
  endpoint: string;
  /** Current description value carried in the feed payload. */
  value: string;
}

/**
 * Resolve the editable-description save target for a task or goal feed item.
 * Returns null for every other kind so no other row gets an editor.
 */
function descriptionTarget(item: SimpleFeedItem): DescriptionTarget | null {
  const kind = item.payload?.kind;
  const value = typeof item.payload?.description === "string" ? item.payload.description : "";
  if (kind === "task") {
    const ref = item.sourceRefs?.[0];
    const taskId = ref?.type === "task" ? ref.id : null;
    if (!taskId) return null;
    return { endpoint: `/api/projects/tasks/${encodeURIComponent(taskId)}`, value };
  }
  if (kind === "goal") {
    const goalId = typeof item.payload?.goalId === "string" ? item.payload.goalId : null;
    if (!goalId) return null;
    return { endpoint: `/api/life-goals/${encodeURIComponent(goalId)}`, value };
  }
  return null;
}

/**
 * Inline, editable description rendered in the same styled frame as expanded
 * feed content. Saving requires non-empty text: task descriptions are protected
 * (empty is a no-op) and goal descriptions reject empty server-side, so the Save
 * control mirrors the wellness entry editor and disables on empty input.
 */
function InlineDescriptionEditor({ target }: { target: DescriptionTarget }) {
  const [value, setValue] = useState(target.value);
  const [dirty, setDirty] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Adopt refreshed feed values only while the user has no pending local edit.
  useEffect(() => {
    if (!dirty) setValue(target.value);
  }, [target.value, dirty]);

  // Hug actual content height: reset then grow to scrollHeight on every value change.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value]);

  const save = useMutation({
    mutationFn: async () => {
      const trimmed = value.trim();
      if (!trimmed) throw new Error("Description cannot be empty");
      await apiRequest("PATCH", target.endpoint, { description: trimmed });
    },
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
    },
    onError: (error) => {
      toast({
        title: "Could not save description",
        description: error instanceof Error ? error.message : "The description was not saved.",
        variant: "destructive",
      });
    },
  });

  return (
    <div className={cn(SIMPLE_TEXT_FRAME_CLASS, "flex flex-col gap-2")}>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => { setValue(event.target.value); setDirty(true); }}
        placeholder="Add a description…"
        maxLength={5000}
        rows={1}
        className="min-h-0 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-xs leading-relaxed md:text-xs text-white shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      {dirty ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => { setValue(target.value); setDirty(false); }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!value.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ─── Tree Row ───

interface SimpleTreeRowProps {
  item: SimpleFeedItem;
  depth?: number;
  /** Embedded rows reuse Simple's reference, expander, content, and tree styling without feed-only rails. */
  layout?: "feed" | "embedded";
  /** Content to render in the title area. Falls back to reference link or item.title. */
  children?: ReactNode;
  /** Page-owned destructive action. Omitted on surfaces that do not own deletion. */
  onDelete?: (item: SimpleFeedItem) => void;
  /** When equal to this row's item id, auto-expand the row and scroll it into view (deep-link entry). */
  autoExpandItemId?: string | null;
}

const INDENT_PX = 24;
const CONNECTOR_CLASS = "border-muted-foreground/50";

export function SimpleTreeRow({ item, depth = 0, layout = "feed", children, onDelete, autoExpandItemId }: SimpleTreeRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [entryContent, setEntryContent] = useState("");
  const [promotedReference, setPromotedReference] = useState<ReferenceRef | null>(null);
  const [promotedSummary, setPromotedSummary] = useState<string | null>(null);
  const [promotedInteraction, setPromotedInteraction] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { guidedResource } = useUiInteraction();
  const ownGuidedResource = guidedResource && simpleItemReferenceRefs(item).some((ref) => ref.canonical === guidedResource)
    ? guidedResource
    : null;
  const guidedDescendant = Boolean(guidedResource && simpleItemContainsReference(item, guidedResource));
  const resourceRef = useUiInteractionResource(ownGuidedResource);
  const { toast } = useToast();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const action = completeAction(item);
  const reference = promotedReference ?? primaryReference(item);
  const promotion = attendeePromotion(item);
  const attendeeHasPerson = Boolean(reference?.type === "person");
  const expandedItem = promotedReference ? {
    ...item,
    payload: {
      ...item.payload,
      personId: promotedReference.id,
      profileSummary: promotedSummary,
      lastInteractionContext: promotedInteraction,
    },
  } : item;
  const inlineExpandedContent = expandedContent(expandedItem, attendeeHasPerson);
  const isAgendaPage = item.payload?.kind === "meeting_artifact" && item.payload?.artifactKind === "agenda";
  const agendaPageId = isAgendaPage && typeof item.payload?.pageId === "string" ? item.payload.pageId : null;
  const agendaPageSlug = isAgendaPage && typeof item.payload?.slug === "string" ? item.payload.slug : null;
  const buildEnvId = buildEnvironmentId(item);
  const hasChildren = Boolean(item.children?.length);
  const descTarget = descriptionTarget(item);
  const hasDescription = Boolean(descTarget?.value.trim());
  const canExpand = hasChildren || Boolean(inlineExpandedContent) || Boolean(agendaPageId && agendaPageSlug) || buildEnvId != null || hasDescription;
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
      // Session-review clear mutates Session Menu REVIEW producers too.
      if (item.payload?.kind === "session_review") {
        queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      }
      if (entryUi) {
        queryClient.invalidateQueries({ queryKey: [entryUi.endpoint] });
        queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs"] });
      }
    },
  });

  const promoteMutation = useMutation({
    mutationFn: async () => {
      if (!promotion) throw new Error("Attendee promotion is unavailable");
      const email = stringPayload(item, "email");
      if (!email) throw new Error("Attendee email is missing");
      const res = await apiRequest(
        "POST",
        `/api/calendar/events/${encodeURIComponent(promotion.eventId)}/attendees/promote`,
        {
          accountId: promotion.accountId,
          calendarId: promotion.calendarId,
          email,
        },
      );
      return res.json() as Promise<{
        person: {
          id: string;
          name: string;
          profileSummary: string | null;
          lastInteractionContext: string | null;
        };
      }>;
    },
    onSuccess: ({ person }) => {
      setPromotedReference(createReferenceRef({
        type: "person",
        id: person.id,
        metadata: { label: person.name, href: `/people/${person.id}` },
      }));
      setPromotedSummary(person.profileSummary);
      setPromotedInteraction(person.lastInteractionContext);
      toast({ title: `${person.name} added to People` });
    },
    onError: error => {
      toast({
        title: "Could not add profile",
        description: error instanceof Error ? error.message : "The attendee profile was not created.",
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      queryClient.invalidateQueries({ queryKey: ["/api/people/email-map"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/metadata"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/events"] });
    },
  });

  const discussMutation = useMutation({
    mutationFn: async () => {
      const personaName = simpleDiscussPersonaName(item);
      const res = await apiRequest("POST", "/api/sessions", {
        title: simpleDiscussTitle(item),
        ...(personaName ? { personaName } : {}),
      });
      const session: CreatedSession = await res.json();
      await apiRequest("POST", `/api/sessions/${session.id}/messages`, { content: buildSimpleDiscussMessage(item) });
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
  const isMeetingRecord = item.payload?.kind === "meeting_record";
  const showCheckCircle = !isMeetingRecord && (completed || item.completable || item.widgetType === "meeting");
  const embedded = layout === "embedded";

  const titleHref = firstExternalUrl(item.title);
  const mapHref = isMeetingLocationItem(item) ? mapsSearchHref(item.title) : null;
  const displayTitle = mapHref ? placeNameFromAddress(item.title) : item.title;
  // Guidance reveals the complete path to the canonical resource without
  // rewriting ordinary row disclosure. The user's activation still crosses the
  // native row/link behavior; when the guide ends, only explicit user state
  // remains.
  const displayedExpanded = expanded || (guidedDescendant && canExpand);

  const rowRef = useRef<HTMLDivElement>(null);
  const autoExpandHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoExpandItemId || autoExpandItemId !== item.id || !canExpand) return;
    if (autoExpandHandledRef.current === autoExpandItemId) return;
    autoExpandHandledRef.current = autoExpandItemId;
    setExpanded(true);
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [autoExpandItemId, item.id, canExpand]);

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
  ) : promotion ? (
    <button
      type="button"
      disabled={promoteMutation.isPending}
      onClick={event => {
        event.stopPropagation();
        promoteMutation.mutate();
      }}
      className="mx-1 inline-flex max-w-full items-center gap-1 whitespace-nowrap text-xs font-medium leading-tight text-cta underline-offset-4 transition-colors hover:text-active disabled:text-muted-foreground"
      title={promoteMutation.isError ? (promoteMutation.error instanceof Error ? promoteMutation.error.message : "Profile creation failed") : `Add ${displayTitle} to People`}
      data-testid={`promote-attendee-${item.id}`}
    >
      {promoteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : (
        <span className="inline-flex shrink-0 items-center gap-0.5" aria-hidden="true">
          <Plus className="h-3 w-3 stroke-[2.5]" />
          <User className="h-3.5 w-3.5" />
        </span>
      )}
      <span className="min-w-0 truncate border-b border-current leading-[inherit]">{displayTitle}</span>
    </button>
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
      <div ref={resourceRef}>
      <div
        ref={rowRef}
        className={cn(
          "group flex items-center py-1 rounded-md transition-colors duration-200 hover:bg-accent/50",
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

            {/* Checkbox column is reserved only for objects with completion semantics. */}
            {!isMeetingRecord && (
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
            )}
          </>
        )}

        {/* Content area */}
        <div
          className="relative min-w-0 flex-1 pl-0.5"
          onClick={reference || promotion ? (event) => event.stopPropagation() : undefined}
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
              aria-label={displayedExpanded ? "Collapse" : "Expand"}
            >
              <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", displayedExpanded && "rotate-90")} />
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
              {onDelete ? (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(item);
                  }}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Delete
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Expanded content */}
      {displayedExpanded && agendaPageId && agendaPageSlug ? (
        <div className="pb-2 pl-0 pr-1.5">
          <InlineLibraryPageEditor page={{ id: agendaPageId, title: item.title, slug: agendaPageSlug }} />
        </div>
      ) : displayedExpanded && buildEnvId != null ? (
        <div className="pb-2 pl-0 pr-1.5">
          <BuildExpandFrame environmentId={buildEnvId} enabled={displayedExpanded} />
        </div>
      ) : displayedExpanded && inlineExpandedContent ? (
        <div className="pb-2 pl-0 pr-1.5">
          <SimpleTextFrame content={inlineExpandedContent} />
        </div>
      ) : null}

      {/* Editable description for task/goal rows — sits above nested children. */}
      {displayedExpanded && descTarget ? (
        <div className="pb-2 pl-0 pr-1.5">
          <InlineDescriptionEditor target={descTarget} />
        </div>
      ) : null}

      {/* Expanded children */}
      {displayedExpanded && hasChildren && (
        <div>
          {item.children!.map(child => (
            <SimpleTreeRow key={child.id} item={child} depth={depth + 1} layout={layout} />
          ))}
        </div>
      )}
      </div>

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
