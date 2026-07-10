import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SectionPlanArtifact, SimpleFeed, SimpleFeedItem, SimpleFeedSection } from "@shared/models/simple";
import type { LibraryPage, LibraryPageFull } from "@/pages/library/types";
import { dynamicSectionLabel } from "@shared/models/simple";
import { SimpleWidgetRenderer } from "./home-widget-renderer";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LibraryReminderPopover } from "@/components/library-reminder";
import { ChevronRight, FileText, Loader2, MessageSquare, MoreHorizontal, Plus, X } from "lucide-react";
import { useFocusSession } from "@/hooks/use-focus-session";
import { apiRequest } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { createReferenceRef } from "@shared/references";
import { SurfacedPersonRow, surfacedDateLabel } from "@/components/people/surfaced-person-row";
import { SurfacedNewsRow } from "@/components/news/surfaced-news-row";
import { SurfacedEmailRow } from "@/components/email/surfaced-email-row";
import { SimpleCheckCircle } from "./home-check-circle";
import { SimpleTextFrame } from "./simple-text-frame";

const log = createLogger("SimpleFeed");


type CreatedSession = { id: string };

/** Sections that default to closed to keep the Home feed anchored on nearer horizons. */
const DEFAULT_CLOSED_SECTIONS = new Set([
  "earlier",
  "this_month",
  "next_month",
  "this_quarter",
  "next_quarter",
  "this_year",
  "next_year",
  "three_years",
  "lifetime",
  "snoozed",
]);

export function SimpleFeedView({ feed }: { feed: SimpleFeed }) {
  const now = useMemo(() => new Date(feed.generatedAt), [feed.generatedAt]);
  const peopleInboxItems = useMemo(() => feed.sections.find(s => s.section === "inbox")?.items.filter(item => item.widgetType === "person") ?? [], [feed.sections]);
  const newsInboxItems = useMemo(() => feed.sections.find(s => s.section === "inbox")?.items.filter(item => item.payload?.kind === "news_signal") ?? [], [feed.sections]);
  const emailInboxItems = useMemo(() => feed.sections.find(s => s.section === "inbox")?.items.filter(item => item.payload?.kind === "email_review") ?? [], [feed.sections]);
  const peopleSnoozedItems = useMemo(() => feed.sections.find(s => s.section === "snoozed")?.items.filter(item => item.widgetType === "person") ?? [], [feed.sections]);
  const feedSections = useMemo(() => feed.sections
    .filter(s => s.section !== "done" && s.section !== "inbox" && s.section !== "snoozed")
    .map(section => ({ ...section, items: section.items.filter(item => item.widgetType !== "person" && item.payload?.kind !== "news_signal" && item.payload?.kind !== "email_review") }))
    .filter(section => section.items.length > 0 || section.planArtifact !== undefined), [feed.sections]);
  const degradedMessage = useMemo(() => {
    if (!feed.degraded) return null;
    const errors = feed.errors?.filter(error => error.message.trim().length > 0) ?? [];
    if (errors.length === 0) return "Simple is using a partial feed: no error detail was provided.";
    return `Simple is using a partial feed: ${errors.map(error => `${error.source}: ${error.message}`).join("; ")}`;
  }, [feed.degraded, feed.errors]);

  return (
    <div className="flex w-full flex-col gap-1 px-2 py-2 @sm:px-4">
      {degradedMessage && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
          {degradedMessage}
        </div>
      )}
      <LibrarySurfaceInbox peopleItems={peopleInboxItems} newsItems={newsInboxItems} emailItems={emailInboxItems} />
      {feedSections.map(section => (
        <SimpleSectionGroup
          key={section.section}
          section={section}
          now={now}
          timezone={feed.timezone}
        />
      ))}
      <LibrarySurfaceSnoozed peopleItems={peopleSnoozedItems} />
      {feed.sections.filter(s => s.section === "done").map(section => (
        <SimpleSectionGroup
          key={section.section}
          section={section}
          now={now}
          timezone={feed.timezone}
        />
      ))}
    </div>
  );
}

function SimpleSectionGroup({
  section,
  now,
  timezone,
}: {
  section: SimpleFeedSection;
  now: Date;
  timezone: string;
}) {
  const { section: sectionKey, items, planArtifact, planSkillName, planCadence } = section;
  const [open, setOpen] = useState(!DEFAULT_CLOSED_SECTIONS.has(sectionKey));
  const hasPlanRow = planArtifact !== undefined;

  return (
    <section className="scroll-mt-6">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-2 py-1 text-xs font-bold text-muted-foreground uppercase tracking-wider hover-elevate rounded-md">
          <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          {dynamicSectionLabel(sectionKey, now, timezone)}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-0">
            {hasPlanRow && (
              <PlanArtifactRow
                artifact={planArtifact}
                skillName={planSkillName ?? null}
                cadence={planCadence ?? null}
                sectionLabel={dynamicSectionLabel(sectionKey, now, timezone)}
              />
            )}
            {items.map(item => <SimpleWidgetRenderer key={item.id} item={item} />)}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

const PLAN_LABEL: Record<string, string> = {
  "daily": "Daily Plan",
  "weekly": "Weekly Plan",
  "monthly": "Monthly Plan",
  "quarterly": "Quarterly Plan",
};

function PlanArtifactRow({
  artifact,
  skillName,
  cadence,
  sectionLabel,
}: {
  artifact: SectionPlanArtifact | null;
  skillName: string | null;
  cadence: "daily" | "weekly" | "monthly" | "quarterly" | null;
  sectionLabel: string;
}) {
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const [running, setRunning] = useState(false);

  const triggerSkill = useCallback(async () => {
    if (!skillName || running) return;
    setRunning(true);
    try {
      const res = await apiRequest("POST", "/api/home/run-plan-skill", { skillName, cadence });
      const data = await res.json();
      if (data.success && data.sessionId) {
        setSessionForRoute(route, data.sessionId);
        setWidgetOpen(true);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
    } catch (err) {
      log.error(`Failed to start plan skill: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }, [skillName, cadence, running, queryClient, route, setSessionForRoute, setWidgetOpen]);

  const planLabel = cadence ? PLAN_LABEL[cadence] ?? `${sectionLabel} Plan` : `${sectionLabel} Plan`;

  if (artifact) {
    return (
      <SurfacedLibraryRow
        page={planArtifactToLibraryPage(artifact)}
        icon={<FileText className="h-3 w-3 text-muted-foreground" />}
      />
    );
  }

  // No artifact — show "Generate plan" action
  if (!skillName) return null;

  return (
    <button
      type="button"
      onClick={triggerSkill}
      disabled={running}
      className="flex items-center py-1 rounded-md w-full text-left group hover:bg-accent/50 transition-colors"
    >
      <span className="w-14 shrink-0 text-right pr-1.5 text-[11px] leading-tight tabular-nums text-muted-foreground" />
      <span className="w-4 shrink-0 flex items-center justify-center">
        {running
          ? <Loader2 className="h-3 w-3 animate-spin text-foreground" />
          : <Plus className="h-3 w-3 text-foreground" />}
      </span>
      <span className="min-w-0 flex-1 pl-0.5 text-sm text-foreground">
        {running ? `Creating ${planLabel}…` : `New ${planLabel}`}
      </span>
    </button>
  );
}


function planArtifactToLibraryPage(artifact: SectionPlanArtifact): LibraryPage {
  const now = new Date().toISOString();
  return {
    id: artifact.pageId,
    pageId: 0,
    title: artifact.title,
    slug: artifact.pageSlug || artifact.pageId,
    parentId: null,
    tags: [],
    emoji: null,
    oneLiner: null,
    summary: null,
    createdAt: now,
    updatedAt: now,
  };
}

function activeSurfacedPages(pages: LibraryPage[], nowMs: number): LibraryPage[] {
  return pages
    .filter(page => page.surface === true && page.surfaceUntil && new Date(page.surfaceUntil).getTime() > nowMs && page.surfaceSection !== "snoozed")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function snoozedSurfacedPages(pages: LibraryPage[], nowMs: number): LibraryPage[] {
  return pages
    .filter(page => page.surface === true && page.surfaceUntil && new Date(page.surfaceUntil).getTime() > nowMs && page.surfaceSection === "snoozed")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function inboxSortTime(item: SimpleFeedItem | LibraryPage): number {
  if ("payload" in item) {
    const value = typeof item.payload?.inboxAddedAt === "string" ? item.payload.inboxAddedAt : item.anchorTime ?? item.actionTime;
    const time = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(time) ? time : 0;
  }
  const value = item.updatedAt ?? item.createdAt;
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : 0;
}

type MixedInboxItem = { kind: "person"; item: SimpleFeedItem } | { kind: "news"; item: SimpleFeedItem } | { kind: "email"; item: SimpleFeedItem } | { kind: "page"; page: LibraryPage };

function LibrarySurfaceInbox({ peopleItems, newsItems, emailItems }: { peopleItems: SimpleFeedItem[]; newsItems: SimpleFeedItem[]; emailItems: SimpleFeedItem[] }) {
  const queryClient = useQueryClient();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { data: pages = [] } = useQuery<LibraryPage[]>({
    queryKey: ["/api/info/library"],
  });
  const surfacedPages = useMemo(() => activeSurfacedPages(pages, nowMs), [pages, nowMs]);
  const inboxItems = useMemo<MixedInboxItem[]>(() => [
    ...peopleItems.map(item => ({ kind: "person" as const, item })),
    ...newsItems.map(item => ({ kind: "news" as const, item })),
    ...emailItems.map(item => ({ kind: "email" as const, item })),
    ...surfacedPages.map(page => ({ kind: "page" as const, page })),
  ].sort((a, b) => inboxSortTime(b.kind === "page" ? b.page : b.item) - inboxSortTime(a.kind === "page" ? a.page : a.item)), [peopleItems, newsItems, emailItems, surfacedPages]);

  useEffect(() => {
    const activeUntilTimes = pages
      .filter(page => page.surface === true && page.surfaceUntil)
      .map(page => new Date(page.surfaceUntil!).getTime())
      .filter(time => Number.isFinite(time) && time > nowMs);
    if (activeUntilTimes.length === 0) return;

    const nextExpiryMs = Math.min(...activeUntilTimes);
    const delayMs = Math.max(1_000, Math.min(nextExpiryMs - nowMs + 250, 60_000));
    const timeout = window.setTimeout(() => {
      setNowMs(Date.now());
      queryClient.invalidateQueries({ queryKey: ["/api/info/library"] });
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [pages, nowMs, queryClient]);

  const dismissMutation = useMutation({
    mutationFn: async (pageId: string) => {
      await apiRequest("PATCH", `/api/info/library/${pageId}/surface`, { surface: false });
    },
    onMutate: async (pageId: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/info/library"] });
      const previous = queryClient.getQueryData<LibraryPage[]>(["/api/info/library"]);
      queryClient.setQueryData<LibraryPage[]>(["/api/info/library"], old =>
        old?.map(page => page.id === pageId ? { ...page, surface: false, surfaceUntil: null, surfaceReason: null, surfaceSection: null } : page),
      );
      return { previous };
    },
    onError: (_error, _pageId, context) => {
      if (context?.previous) queryClient.setQueryData(["/api/info/library"], context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/info/library"] });
      queryClient.invalidateQueries({ queryKey: ["/api/info/library/tree"] });
    },
  });

  const [open, setOpen] = useState(true);

  if (surfacedPages.length === 0 && peopleItems.length === 0 && newsItems.length === 0 && emailItems.length === 0) return null;

  return (
    <section className="scroll-mt-6">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-bold uppercase tracking-wider text-muted-foreground hover-elevate">
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
          INBOX
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-0">
            {inboxItems.map(entry => entry.kind === "person" ? (
              <SurfacedPersonRow key={entry.item.id} item={entry.item} dateLabel={surfacedDateLabel(entry.item)} />
            ) : entry.kind === "news" ? (
              <SurfacedNewsRow key={entry.item.id} item={entry.item} dateLabel={surfacedDateLabel(entry.item)} />
            ) : entry.kind === "email" ? (
              <SurfacedEmailRow key={entry.item.id} item={entry.item} dateLabel={surfacedDateLabel(entry.item)} />
            ) : (
              <SurfacedLibraryRow
                key={entry.page.id}
                page={entry.page}
                dateLabel={surfacedDateLabel(entry.page)}
                dismissing={dismissMutation.isPending && dismissMutation.variables === entry.page.id}
                onDismiss={() => dismissMutation.mutate(entry.page.id)}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function LibrarySurfaceSnoozed({ peopleItems }: { peopleItems: SimpleFeedItem[] }) {
  const queryClient = useQueryClient();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { data: pages = [] } = useQuery<LibraryPage[]>({
    queryKey: ["/api/info/library"],
  });
  const snoozed = useMemo(() => snoozedSurfacedPages(pages, nowMs), [pages, nowMs]);
  const [expanded, setExpanded] = useState(false);

  const dismissMutation = useMutation({
    mutationFn: async (pageId: string) => {
      await apiRequest("PATCH", `/api/info/library/${pageId}/surface`, { surface: false });
    },
    onMutate: async (pageId: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/info/library"] });
      const previous = queryClient.getQueryData<LibraryPage[]>(["/api/info/library"]);
      queryClient.setQueryData<LibraryPage[]>(["/api/info/library"], old =>
        old?.map(page => page.id === pageId ? { ...page, surface: false, surfaceUntil: null, surfaceReason: null, surfaceSection: null } : page),
      );
      return { previous };
    },
    onError: (_error, _pageId, context) => {
      if (context?.previous) queryClient.setQueryData(["/api/info/library"], context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/info/library"] });
      queryClient.invalidateQueries({ queryKey: ["/api/info/library/tree"] });
    },
  });

  const hasItems = snoozed.length > 0 || peopleItems.length > 0;

  if (!hasItems) return null;

  return (
    <section className="scroll-mt-6">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")} />
        Snoozed
      </button>
      {expanded && (
        <div className="mt-0">
          {peopleItems.map(item => <SurfacedPersonRow key={item.id} item={item} dateLabel={surfacedDateLabel(item)} />)}
          {snoozed.map(page => (
            <SurfacedLibraryRow
              key={page.id}
              page={page}
              dismissing={dismissMutation.isPending && dismissMutation.variables === page.id}
              onDismiss={() => dismissMutation.mutate(page.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SurfacedLibraryRow({
  page,
  dateLabel,
  dismissing = false,
  onDismiss,
  icon,
}: {
  page: LibraryPage;
  dateLabel?: string;
  dismissing?: boolean;
  onDismiss?: () => void;
  icon?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const pageRef = useMemo(() => createReferenceRef({
    type: "page",
    id: page.slug || page.id,
    metadata: {
      label: page.title,
      href: `/info#library?page=${encodeURIComponent(page.slug || page.id)}`,
    },
  }), [page.id, page.slug, page.title]);

  const { data: pageContent, isLoading, isError } = useQuery<LibraryPageFull>({
    queryKey: ["/api/info/library", page.id],
    enabled: open,
  });

  const discussMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sessions", { title: page.title.slice(0, 80) || "Library Item" });
      const session: CreatedSession = await res.json();
      await apiRequest("POST", `/api/sessions/${session.id}/messages`, {
        content: [`Let's discuss this Simple item: **${page.title}**`, `Type: library_page`, `Reference: @page:${page.slug || page.id}`].join("\n"),
      });
      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
      setMenuOpen(false);
    },
  });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn(dismissing && "opacity-60")}>
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
        >
          <span className="w-14 shrink-0 text-right pr-1.5 text-[11px] leading-tight tabular-nums text-muted-foreground whitespace-nowrap">
            {dateLabel ?? ""}
          </span>

          <span className="w-4 shrink-0 flex items-center justify-center">
            {onDismiss ? (
              <SimpleCheckCircle
                pending={dismissing}
                disabled={dismissing}
                label={`Dismiss ${page.title} from inbox`}
                onClick={onDismiss}
              />
            ) : icon ?? <FileText className="h-3 w-3 text-muted-foreground" />}
          </span>

          <div className="relative min-w-0 flex-1 pl-0.5">
            <span className="inline-flex max-w-full" onClick={(e) => e.stopPropagation()}>
              <ReferenceRenderer refValue={pageRef} surface="simple-row" />
            </span>
          </div>

          <CollapsibleTrigger
            type="button"
            className="ml-1 p-0.5 shrink-0 rounded opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
            aria-label={`${open ? "Collapse" : "Expand"} ${page.title}`}
            onClick={(event) => event.stopPropagation()}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          </CollapsibleTrigger>

          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="ml-1 p-0.5 shrink-0 rounded opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                aria-label={`Actions for ${page.title}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                disabled={discussMutation.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  discussMutation.mutate();
                }}
              >
                {discussMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5 mr-2" />}
                Discuss
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <LibraryReminderPopover
                pageId={page.id}
                pageTitle={page.title}
                onReminderSet={() => setMenuOpen(false)}
              />
              {onDismiss && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismiss();
                      setMenuOpen(false);
                    }}
                  >
                    <X className="h-3.5 w-3.5 mr-2" />
                    Dismiss
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <CollapsibleContent>
          <div className="pb-2 pl-0 pr-1.5">
            <div onClick={(event) => event.stopPropagation()}>
              <SimpleTextFrame
                content={pageContent?.plainTextContent}
                loading={isLoading}
                error={isError ? "This page could not be loaded." : null}
              />
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );

}
