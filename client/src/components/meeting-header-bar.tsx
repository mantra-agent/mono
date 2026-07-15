/**
 * MeetingHeaderBar — sticky header for meeting sessions.
 *
 * Shows meeting title, platform, elapsed time, participant chips, and the
 * bot status pill. Renders above the transcript, mirroring the sticky-bar
 * pattern used by plans/workflows.
 *
 * When a recap is ready and distribution drafts exist, renders a
 * "Send recap to N attendees" button that expands per-attendee
 * EmailDraftWidget panels (one per draftId). Follows the Sessions Draft
 * widget motif: fixed attendee recipients, editable content, explicit send
 * control (human presses Send), read-only recap link.
 */
import { useEffect, useState, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileText,
  Hourglass,
  Loader2,
  Mail,
  Radio,
  Users,
} from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmailDraftWidget } from "@/components/email-draft-widget";
import { useToast } from "@/hooks/use-toast";
import { createLogger } from "@/lib/logger";
import type { MeetingSessionMeta, MeetingBotStatus } from "@shared/models/chat";
import { createReferenceRef } from "@shared/references";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { ExpandableLibraryPage } from "@/components/library/inline-library-page";

const log = createLogger("MeetingHeaderBar");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<MeetingBotStatus, string> = {
  dialing: "Joining",
  in_lobby: "In lobby",
  live: "Live",
  denied: "Not admitted",
  failed: "Failed",
  ended: "Ended",
};

const STATUS_CLASS: Record<MeetingBotStatus, string> = {
  dialing: "bg-warning/10 text-warning-foreground border-warning/30",
  in_lobby: "bg-warning/10 text-warning-foreground border-warning/30",
  live: "bg-active/10 text-active border-active/30",
  denied: "bg-destructive/10 text-destructive border-destructive/30",
  failed: "bg-destructive/10 text-destructive border-destructive/30",
  ended: "bg-muted text-muted-foreground border-border",
};

/** Ray-facing explanation per terminal/waiting state. Never a silent fail. */
const STATUS_BANNER: Partial<Record<MeetingBotStatus, string>> = {
  in_lobby:
    "Waiting to be admitted — admit 'Mantra Agent' from the meeting participants panel.",
  denied:
    "The bot was not admitted to the meeting (recording permission denied or removed from the lobby).",
  failed: "The bot hit a fatal error and could not stay in the meeting.",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function useElapsed(startedAt?: string, endedAt?: string): string | null {
  const [now, setNow] = useState(() => Date.now());
  const running = !!startedAt && !endedAt;

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  if (!startedAt) return null;
  const end = endedAt ? new Date(endedAt).getTime() : now;
  return formatElapsed(end - new Date(startedAt).getTime());
}

// ---------------------------------------------------------------------------
// Distribution row type (mirrors the backend API response)
// ---------------------------------------------------------------------------

interface DistributionRow {
  id: string;
  attendeeEmail: string;
  attendeeName: string | null;
  draftId: string | null;
  status: string;
  sendMethod: string;
  error: string | null;
  isMantraUser: boolean;
}

// ---------------------------------------------------------------------------
// Recap distribution panel
// ---------------------------------------------------------------------------

/**
 * RecapDistributionPanel — fetches per-attendee distribution rows for a
 * session and renders one EmailDraftWidget per Gmail-draft row.
 *
 * Uses the standard EmailDraftWidget motif: editable content, fixed
 * attendee recipients visible in the draft, explicit Send control.
 * SendGrid-sent rows (no draftId) show a compact read-only status chip.
 */
function RecapDistributionPanel({
  sessionId,
  draftCount,
}: {
  sessionId: string;
  draftCount: number;
}) {
  const { data, isLoading, error } = useQuery<{ distributions: DistributionRow[] }>({
    queryKey: ["/api/meetings", sessionId, "recap-distributions"],
    queryFn: async () => {
      log.debug("RECAP_DISTRIBUTION_PANEL:LOAD_START", { sessionId });
      const res = await fetch(`/api/meetings/${sessionId}/recap-distributions`, {
        credentials: "include",
      });
      if (!res.ok) {
        log.error("RECAP_DISTRIBUTION_PANEL:LOAD_FAILED", { sessionId, status: res.status });
        throw new Error(`Failed to load distributions (${res.status})`);
      }
      const payload = await res.json();
      log.debug("RECAP_DISTRIBUTION_PANEL:LOAD_SUCCESS", {
        sessionId,
        count: payload?.distributions?.length ?? 0,
      });
      return payload;
    },
    // Refetch while any draft is still in a non-terminal state
    refetchInterval: (query) => {
      const rows: DistributionRow[] = query.state.data?.distributions ?? [];
      const hasPending = rows.some(
        (r) => r.status === "pending" || r.status === "draft_creating",
      );
      return hasPending ? 3_000 : false;
    },
  });

  if (isLoading) {
    return (
      <div
        className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground"
        data-testid="banner-distribution-loading"
      >
        <Loader2 className="h-3 w-3 animate-spin shrink-0" />
        <span>Loading draft emails…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        className="flex items-center gap-2 px-4 py-1.5 text-xs text-destructive bg-destructive/10"
        data-testid="banner-distribution-error"
      >
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span>Failed to load draft emails</span>
      </div>
    );
  }

  const distributions = data.distributions;
  if (distributions.length === 0) {
    return (
      <div
        className="px-4 py-2 text-xs text-muted-foreground"
        data-testid="banner-distribution-empty"
      >
        No attendee drafts found.
      </div>
    );
  }

  return (
    <div className="px-4 pb-3 space-y-2" data-testid="panel-distribution-drafts">
      <p className="text-xs text-muted-foreground pt-1">
        Review and send recap emails to{" "}
        <span className="text-foreground font-medium">{distributions.length}</span>{" "}
        attendee{distributions.length === 1 ? "" : "s"}. Each recipient receives their
        own copy — Action Items and key decisions included.
      </p>

      {distributions.map((row) => {
        // Gmail draft path: render editable EmailDraftWidget
        if (row.draftId) {
          return (
            <div key={row.id} data-testid={`distribution-row-${row.id}`}>
              {/* Attendee label above widget */}
              <div className="flex items-center gap-1.5 mb-1">
                <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground">
                  {row.attendeeName
                    ? `${row.attendeeName} (${row.attendeeEmail})`
                    : row.attendeeEmail}
                </span>
              </div>
              <EmailDraftWidget draftId={row.draftId} isRecapDraft={true} />
            </div>
          );
        }

        // SendGrid sent path: compact read-only status chip
        return (
          <div
            key={row.id}
            className={cn(
              "flex items-center gap-2 rounded-md border px-3 py-2 text-xs",
              row.status === "sent"
                ? "border-success/40 bg-success/5 text-success"
                : row.status === "failed"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-border/40 bg-muted/20 text-muted-foreground",
            )}
            data-testid={`distribution-row-${row.id}`}
          >
            <Mail className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate font-medium">
              {row.attendeeName
                ? `${row.attendeeName} (${row.attendeeEmail})`
                : row.attendeeEmail}
            </span>
            <span className="ml-auto shrink-0 capitalize">{row.status}</span>
            {row.error && (
              <span className="text-destructive/80 truncate max-w-[12rem]" title={row.error}>
                {row.error}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MeetingHeaderBar
// ---------------------------------------------------------------------------

export function MeetingHeaderBar({
  meeting,
  sessionId,
  sessionTitle,
}: {
  meeting: MeetingSessionMeta;
  /** Owning session ID — required for the distribution panel API call. */
  sessionId?: string;
  sessionTitle?: string;
}) {
  const elapsed = useElapsed(meeting.startedAt, meeting.endedAt);
  const isLive = meeting.botStatus === "live";
  const banner = STATUS_BANNER[meeting.botStatus];
  const { toast } = useToast();

  const retryRecap = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("Meeting session unavailable");
      const response = await apiRequest(
        "POST",
        `/api/meetings/${encodeURIComponent(sessionId)}/recap/retry`,
      );
      return response.json();
    },
    onSuccess: () => {
      if (!sessionId) return;
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Recap retry failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Distribution panel open/close state
  const [distributionOpen, setDistributionOpen] = useState(false);
  const toggleDistribution = useCallback(
    () => setDistributionOpen((open) => !open),
    [],
  );
  const retryDistribution = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("Meeting session unavailable");
      const response = await apiRequest(
        "POST",
        `/api/meetings/${encodeURIComponent(sessionId)}/recap-distributions/ensure`,
      );
      return response.json();
    },
    onSuccess: () => {
      if (!sessionId) return;
      queryClient.invalidateQueries({
        queryKey: ["/api/meetings", sessionId, "recap-distributions"],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
    },
    onError: (error: Error) => {
      log.error("Distribution retry failed", { sessionId, error });
      toast({
        title: "Draft retry failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const recap = meeting.recap;
  const draftIds = recap?.draftIds ?? [];
  const draftCount = draftIds.length;

  // Derive whether to render the distribution UI
  const showDistributionSpinner = recap?.distributionStatus === "drafting";
  const showDistributionButton =
    recap?.distributionStatus === "ready" &&
    draftCount > 0 &&
    !!sessionId;
  const showDistributionFailed =
    (recap?.distributionStatus === "failed" || recap?.distributionStatus === "blocked")
    && !recap.distributionSkipped;

  return (
    <div className="border-b border-border bg-card/60">
      {/* ── Main info row ── */}
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2"
        data-testid="meeting-header-bar"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Radio
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              isLive ? "text-active animate-pulse" : "text-muted-foreground",
            )}
          />
          <span
            className="text-sm font-medium truncate"
            data-testid="text-meeting-title"
          >
            {meeting.title || sessionTitle || "Meeting"}
          </span>
        </div>
        {meeting.platform && (
          <span
            className="text-xs text-muted-foreground"
            data-testid="text-meeting-platform"
          >
            {meeting.platform}
          </span>
        )}
        {elapsed && (
          <span
            className="text-xs tabular-nums text-muted-foreground"
            data-testid="text-meeting-elapsed"
          >
            {elapsed}
          </span>
        )}
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
            STATUS_CLASS[meeting.botStatus],
          )}
          data-testid="badge-meeting-bot-status"
        >
          {STATUS_LABEL[meeting.botStatus]}
        </span>
        {meeting.participants.length > 0 && (
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            <Users className="h-3 w-3 shrink-0 text-muted-foreground" />
            {meeting.participants.map((participant) => participant.personId ? (
              <ReferenceRenderer
                key={participant.personId}
                refValue={createReferenceRef({
                  type: "person",
                  id: participant.personId,
                  metadata: { label: participant.label, href: `/people/${participant.personId}` },
                })}
                surface="chat-inline"
                className="max-w-full"
              />
            ) : (
              <span
                key={participant.label}
                className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
                title={participant.label}
                data-testid={`chip-participant-${participant.label.replace(/\s+/g, "-").toLowerCase()}`}
              >
                {participant.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Agenda ── */}
      {meeting.agendaPage ? (
        <div className="border-t border-border/20 px-4 py-2">
          <ExpandableLibraryPage page={meeting.agendaPage} label="Agenda" />
        </div>
      ) : meeting.agenda ? (
        <div className="border-t border-border/20 px-4 py-2 text-sm text-muted-foreground whitespace-pre-line">
          {meeting.agenda}
        </div>
      ) : null}

      {/* ── Recap generating ── */}
      {recap?.status === "generating" && (
        <div
          className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground"
          data-testid="banner-meeting-recap-generating"
        >
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          <span>Generating recap…</span>
        </div>
      )}

      {/* ── Recap ready row: read-only link + distribution controls ── */}
      {recap?.status === "ready" && recap.pageSlug && (
        <div
          className="flex flex-wrap items-center gap-2 px-4 py-2"
          data-testid="card-meeting-recap-ready"
        >
          {/* Read-only recap page link */}
          <Link
            href={`/info#library?page=${encodeURIComponent(recap.pageSlug)}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium hover-elevate"
            data-testid="link-meeting-recap-page"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>Recap ready</span>
            {recap.pageTitle && (
              <span className="text-muted-foreground truncate max-w-[16rem]">
                {recap.pageTitle}
              </span>
            )}
          </Link>

          {/* Interaction log chip */}
          {(recap.interactionsLogged ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
              data-testid="chip-meeting-recap-interactions"
            >
              <Users className="h-3 w-3 shrink-0" />
              {recap.interactionsLogged} interaction
              {recap.interactionsLogged === 1 ? "" : "s"} logged
            </span>
          )}

          {/* Distribution: preparing */}
          {showDistributionSpinner && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
              data-testid="chip-distribution-drafting"
            >
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              Preparing draft emails…
            </span>
          )}

          {/* Distribution: ready — send button */}
          {showDistributionButton && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={toggleDistribution}
              data-testid="button-send-recap-emails"
              aria-expanded={distributionOpen}
            >
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <span>
                Send recap to {draftCount} attendee{draftCount === 1 ? "" : "s"}
              </span>
              {distributionOpen ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
            </Button>
          )}

          {/* Distribution: failed or blocked with retry button */}
          {showDistributionFailed && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={() => retryDistribution.mutate()}
              disabled={retryDistribution.isPending}
              data-testid="button-retry-distribution"
              title={recap.distributionError ?? "Retry distribution"}
            >
              {retryDistribution.isPending ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              ) : (
                <AlertCircle className="h-3 w-3 shrink-0" />
              )}
              <span>
                {recap.distributionStatus === "blocked"
                  ? "Draft emails blocked"
                  : "Draft emails failed"}
              </span>
              <span className="text-xs text-destructive/70">Retry</span>
            </Button>
          )}
        </div>
      )}

      {/* ── Distribution panel (expanded) ── */}
      {showDistributionButton && distributionOpen && sessionId && (
        <div
          className="border-t border-border/20"
          data-testid="panel-distribution"
        >
          <RecapDistributionPanel sessionId={sessionId} draftCount={draftCount} />
        </div>
      )}

      {/* ── Recap failed ── */}
      {recap?.status === "failed" && (
        <div
          className="flex items-center gap-2 px-4 py-1.5 text-xs text-destructive bg-destructive/10"
          data-testid="banner-meeting-recap-failed"
        >
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={recap.error}>
            Recap failed{recap.error ? `: ${recap.error}` : ""}
          </span>
          {sessionId && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={() => retryRecap.mutate()}
              disabled={retryRecap.isPending}
              data-testid="button-retry-recap"
            >
              {retryRecap.isPending && (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              )}
              Retry recap
            </Button>
          )}
        </div>
      )}

      {/* ── Bot status banner ── */}
      {banner && (
        <div
          className={cn(
            "flex items-center gap-2 px-4 py-1.5 text-xs",
            meeting.botStatus === "in_lobby"
              ? "text-warning-foreground bg-warning/10"
              : "text-destructive bg-destructive/10",
          )}
          data-testid="banner-meeting-status"
        >
          <Hourglass className="h-3 w-3 shrink-0" />
          <span>
            {banner}
            {meeting.statusDetail ? ` (${meeting.statusDetail})` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
