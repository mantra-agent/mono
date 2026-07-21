/**
 * MeetingHeaderBar — sticky header for meeting sessions.
 *
 * Shows the referenced meeting title, elapsed time, participant references,
 * and linked Agenda/Recap pages. Bot status is encoded on the title icon.
 * Renders above the transcript, mirroring the sticky-bar pattern used by plans/workflows.
 * The header owns meeting identity, transport controls, speaker assignment,
 * and recap status. Email composition renders in the Session transcript through
 * the canonical inline draft widget path.
 */
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  AlertCircle,
  Ear,
  Hourglass,
  Mic2,
  Loader2,
  LogOut,
  Mail,
  Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { createLogger } from "@/lib/logger";
import type { MeetingRecognitionStream, MeetingSessionMeta, MeetingBotStatus } from "@shared/models/chat";
import { createReferenceRef } from "@shared/references";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { ExpandableLibraryPage } from "@/components/library/inline-library-page";
import { MeetingSpeakerAssignments } from "@/components/meeting-speaker-assignments";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";

const log = createLogger("MeetingHeaderBar");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ray-facing explanation per terminal/waiting state. Never a silent fail. */
const STATUS_BANNER: Partial<Record<MeetingBotStatus, string>> = {
  leaving: "Mantra is leaving the meeting. Waiting for Recall to confirm departure.",
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

function formatRecognitionStreamSummary(stream: NonNullable<MeetingSessionMeta["recognition"]>["streams"][number]): string {
  const segments = [
    stream.transportLabel || `Stream ${stream.transportParticipantId}`,
    stream.sourcePolicy === "shared_room"
      ? "Shared room"
      : stream.attribution === "excluded"
        ? "Excluded"
        : "Participant",
    stream.status === "excluded"
      ? "Excluded"
      : stream.status.charAt(0).toUpperCase() + stream.status.slice(1),
  ];

  return segments.filter((segment, index) => (
    segments.findIndex((candidate) => candidate.toLowerCase() === segment.toLowerCase()) === index
  )).join(" · ");
}

function AudioSourcePolicyControl({
  sessionId,
  stream,
  desiredMode,
}: {
  sessionId: string;
  stream: MeetingRecognitionStream;
  desiredMode: MeetingRecognitionStream["sourcePolicy"];
}) {
  const { toast } = useToast();
  const isShared = desiredMode === "shared_room";
  const isReconfiguring = desiredMode !== stream.sourcePolicy || stream.status === "connecting";
  const mutation = useMutation({
    mutationFn: async () => {
      const mutationId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await apiRequest(
        "PATCH",
        `/api/meetings/${encodeURIComponent(sessionId)}/audio-source-policy`,
        {
          sourceKey: stream.streamKey,
          mode: isShared ? "participant_streams" : "shared_room",
          mutationId,
        },
      );
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
    },
    onError: (error: Error) => {
      log.error("Audio source policy toggle failed", {
        sessionId,
        sourceKey: stream.streamKey,
        error,
      });
      toast({
        title: "Audio source update failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  const failed = stream.status === "failed" || stream.status === "fallback";

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        "h-7 shrink-0 gap-1.5 px-2 text-xs",
        isShared && !failed && "border-active/40 text-active hover:text-active",
        failed && "border-destructive/30 text-destructive hover:text-destructive",
      )}
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      aria-pressed={isShared}
      aria-label={`${isShared ? "Stop" : "Start"} shared-room recognition for ${stream.transportLabel || "this audio source"}`}
      title={stream.detail || (isShared
        ? "Treat future speech from this source as one participant"
        : "Separate future speakers sharing this source")}
      data-testid={`button-toggle-shared-source-${stream.transportParticipantId}`}
    >
      {mutation.isPending || isReconfiguring ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : failed ? (
        <AlertCircle className="h-3 w-3 shrink-0" />
      ) : (
        <Mic2 className="h-3 w-3 shrink-0" />
      )}
      <span>{isReconfiguring ? "Recognizing" : failed && isShared ? "Shared degraded" : isShared ? "Shared" : "Individual"}</span>
    </Button>
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
  /** Owning session ID for meeting controls and recap retry actions. */
  sessionId?: string;
  sessionTitle?: string;
}) {
  const elapsed = useElapsed(meeting.startedAt, meeting.endedAt);
  const isLive = meeting.botStatus === "live";
  const isTransportActive = isLive || meeting.botStatus === "leaving";
  const departureMeaningful = ["dialing", "in_lobby", "live", "leaving"].includes(meeting.botStatus);
  const title = meeting.title || sessionTitle || "Meeting";
  const meetingReference = meeting.calendarAccountId && meeting.calendarId && meeting.providerEventId
    ? createReferenceRef({
        type: "meeting",
        id: [meeting.calendarAccountId, meeting.calendarId, meeting.providerEventId]
          .map(encodeURIComponent)
          .join("~"),
        metadata: {
          label: title,
          href: `/schedule/${encodeURIComponent(meeting.providerEventId)}?calendarId=${encodeURIComponent(meeting.calendarId)}&accountId=${encodeURIComponent(meeting.calendarAccountId)}`,
        },
      })
    : null;
  const banner = STATUS_BANNER[meeting.botStatus];
  const { toast } = useToast();

  const isListenOnly = meeting.participationPolicy === "listen_only";
  const toggleListenMode = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("Meeting session unavailable");
      const response = await apiRequest(
        "PATCH",
        `/api/meetings/${encodeURIComponent(sessionId)}/participation-policy`,
        { participationPolicy: isListenOnly ? "auto" : "listen_only" },
      );
      return response.json();
    },
    onSuccess: () => {
      if (!sessionId) return;
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
    },
    onError: (error: Error) => {
      log.error("Listen mode toggle failed", { sessionId, error });
      toast({
        title: "Listen mode update failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const leaveMeeting = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("Meeting session unavailable");
      const response = await apiRequest(
        "POST",
        `/api/meetings/${encodeURIComponent(sessionId)}/leave`,
      );
      return response.json();
    },
    onSuccess: () => {
      if (!sessionId) return;
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
    },
    onError: (error: Error) => {
      log.error("Meeting leave failed", { sessionId, error });
      toast({
        title: "Could not leave meeting",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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
  const showDistributionSpinner = recap?.distributionStatus === "drafting";
  const showDistributionFailed =
    (recap?.distributionStatus === "failed" || recap?.distributionStatus === "blocked")
    && !recap.distributionSkipped;
  const visibleParticipants = meeting.participants.filter(
    (participant) => participant.source !== "machine_diarization",
  );
  const eligibleAudioStreams = (meeting.recognition?.streams || []).filter(
    (stream) => stream.attribution !== "excluded",
  );

  return (
    <div className="border-b border-border bg-card/60">
      {/* ── Main info row ── */}
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2"
        data-testid="meeting-header-bar"
      >
        <div className="flex min-w-0 items-center" data-testid="text-meeting-title">
          {meetingReference ? (
            <ReferenceRenderer
              refValue={meetingReference}
              surface="card"
              IconOverride={Radio}
              className={isTransportActive ? "min-w-0 !text-active hover:!text-active" : "min-w-0 !text-muted-foreground hover:!text-muted-foreground"}
              iconClassName={isTransportActive ? "text-active animate-pulse" : "text-muted-foreground"}
            />
          ) : (
            <span className={cn("inline-flex min-w-0 items-center gap-1 text-sm font-medium", isTransportActive ? "text-active" : "text-muted-foreground")}>
              <Radio className={cn("h-3.5 w-3.5 shrink-0", isTransportActive && "animate-pulse")} />
              <span className="truncate">{title}</span>
            </span>
          )}
        </div>
        {elapsed && (
          <span
            className="text-xs tabular-nums text-muted-foreground"
            data-testid="text-meeting-elapsed"
          >
            {elapsed}
          </span>
        )}
        {sessionId && (isLive || departureMeaningful) && (
          <div className="ml-auto flex items-center gap-1.5">
            {isLive && (
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-6 gap-1.5 px-2 text-xs",
                  isListenOnly && "border-active/40 text-active hover:text-active",
                )}
                onClick={() => toggleListenMode.mutate()}
                disabled={toggleListenMode.isPending || leaveMeeting.isPending}
                data-testid="button-toggle-listen-mode"
                title={
                  isListenOnly
                    ? "Mantra is listening only — click to let it speak again"
                    : "Mute Mantra for this meeting — it keeps transcribing and will still build the recap"
                }
                aria-pressed={isListenOnly}
              >
                {toggleListenMode.isPending ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                ) : (
                  <Ear className="h-3 w-3 shrink-0" />
                )}
                <span>{isListenOnly ? "Listen mode on" : "Listen mode"}</span>
              </Button>
            )}
            {departureMeaningful && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1.5 border-destructive/30 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => leaveMeeting.mutate()}
                disabled={leaveMeeting.isPending || meeting.botStatus === "leaving"}
                data-testid="button-leave-meeting"
                title="Remove Mantra Agent from this meeting"
              >
                {leaveMeeting.isPending || meeting.botStatus === "leaving" ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                ) : (
                  <LogOut className="h-3 w-3 shrink-0" />
                )}
                <span>{leaveMeeting.isPending || meeting.botStatus === "leaving" ? "Leaving…" : "Leave"}</span>
              </Button>
            )}
          </div>
        )}
      </div>

      {visibleParticipants.length > 0 && (
        <div className="pb-2 pr-4" data-testid="meeting-participant-tree">
          {visibleParticipants.map((participant, index) => (
            <HierarchyTreeRow
              key={participant.key || participant.personId || `${participant.label}-${index}`}
              continues={index < visibleParticipants.length - 1}
            >
              <div
                className="flex min-h-7 min-w-0 items-center px-2 py-1"
                data-testid={`participant-${participant.label.replace(/\s+/g, "-").toLowerCase()}`}
              >
                {participant.personId ? (
                  <ReferenceRenderer
                    refValue={createReferenceRef({
                      type: "person",
                      id: participant.personId,
                      metadata: { label: participant.label, href: `/people/${participant.personId}` },
                    })}
                    surface="simple-row"
                    className="max-w-full"
                  />
                ) : (
                  <span className="truncate text-sm text-muted-foreground" title={participant.label}>
                    {participant.label}
                  </span>
                )}
              </div>
            </HierarchyTreeRow>
          ))}
        </div>
      )}

      {sessionId && isLive && eligibleAudioStreams.length > 0 && (
        <div className="border-t border-border/20" data-testid="meeting-audio-source-policies">
          {eligibleAudioStreams.map((stream, index) => (
            <HierarchyTreeRow
              key={stream.streamKey}
              continues={index < eligibleAudioStreams.length - 1}
            >
              <div className="flex min-h-11 min-w-0 items-center gap-2 px-2 py-1">
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {stream.transportLabel || `Audio source ${stream.transportParticipantId}`}
                </span>
                <AudioSourcePolicyControl
                  sessionId={sessionId}
                  stream={stream}
                  desiredMode={meeting.audioSourcePolicies?.[stream.streamKey]?.mode || stream.sourcePolicy}
                />
              </div>
            </HierarchyTreeRow>
          ))}
        </div>
      )}

      {sessionId && (
        <MeetingSpeakerAssignments
          participants={meeting.participants}
          sessionId={sessionId}
        />
      )}

      {meeting.recognition && (
        meeting.recognition.status === "degraded" || meeting.recognition.streams.length > 0
      ) && (
        <div
          className="flex flex-wrap items-center gap-1.5 border-t border-border/20 px-4 py-1.5"
          data-testid="meeting-recognition-state"
        >
          {meeting.recognition.status === "degraded" && (
            <div
              className="flex w-full items-start gap-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
              data-testid="banner-meeting-recognition-degraded"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{meeting.recognition.detail || meeting.sttStatusDetail || "Speaker recognition is degraded."}</span>
            </div>
          )}
          {meeting.recognition.streams.map((stream) => (
            <span
              key={stream.streamKey}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                stream.status === "failed" || stream.status === "fallback"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : stream.status === "active"
                    ? "border-active/30 bg-active/5 text-active"
                    : "border-border bg-muted/50 text-muted-foreground",
              )}
              title={[stream.transportLabel, stream.provider, stream.model, stream.detail].filter(Boolean).join(" · ")}
              data-testid={`chip-recognition-stream-${stream.transportParticipantId}`}
            >
              {stream.status === "connecting" ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              ) : stream.status === "failed" || stream.status === "fallback" ? (
                <AlertCircle className="h-3 w-3 shrink-0" />
              ) : (
                <Radio className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate">{formatRecognitionStreamSummary(stream)}</span>
            </span>
          ))}
        </div>
      )}

      {/* ── Agenda ── */}
      {meeting.agendaPage ? (
        <div className="border-t border-border/20 px-4 py-2">
          <ExpandableLibraryPage page={meeting.agendaPage} />
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

      {/* ── Recap ready row: expandable page + distribution controls ── */}
      {recap?.status === "ready" && recap.pageId && recap.pageSlug && (
        <div
          className="px-4 py-2"
          data-testid="card-meeting-recap-ready"
        >
          <ExpandableLibraryPage
            page={{
              id: recap.pageId,
              slug: recap.pageSlug,
              title: recap.pageTitle || "Meeting Recap",
            }}
            readOnly
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
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

          {/* Distribution: skipped — absence of drafts is never silent */}
          {recap.distributionStatus === "ready" && recap.distributionSkipped && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
              data-testid="chip-distribution-skipped"
            >
              <Mail className="h-3 w-3 shrink-0" />
              No recipients resolved — no drafts created
            </span>
          )}
          </div>
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
              : meeting.botStatus === "leaving"
                ? "text-muted-foreground bg-muted/20"
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
