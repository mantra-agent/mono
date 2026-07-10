/**
 * MeetingHeaderBar — sticky header for meeting sessions.
 *
 * Shows meeting title, platform, elapsed time, participant chips, and the
 * bot status pill. Renders above the transcript, mirroring the sticky-bar
 * pattern used by plans/workflows.
 */
import { useEffect, useState } from "react";
import { AlertCircle, FileText, Hourglass, Loader2, Radio, Users } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { MeetingSessionMeta, MeetingBotStatus } from "@shared/models/chat";

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

export function MeetingHeaderBar({
  meeting,
  sessionTitle,
}: {
  meeting: MeetingSessionMeta;
  sessionTitle?: string;
}) {
  const elapsed = useElapsed(meeting.startedAt, meeting.endedAt);
  const isLive = meeting.botStatus === "live";
  const banner = STATUS_BANNER[meeting.botStatus];

  return (
    <div className="border-b border-border bg-card/60">
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
          {meeting.participants.map((p) => (
            <span
              key={p.label}
              className={cn(
                "inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs",
                p.personId ? "text-foreground" : "text-muted-foreground",
              )}
              title={p.personId ? `Known person: ${p.label}` : p.label}
              data-testid={`chip-participant-${p.label.replace(/\s+/g, "-").toLowerCase()}`}
            >
              {p.label}
            </span>
          ))}
        </div>
      )}
    </div>
    {meeting.recap?.status === "generating" && (
      <div
        className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground"
        data-testid="banner-meeting-recap-generating"
      >
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        <span>Generating recap…</span>
      </div>
    )}
    {meeting.recap?.status === "ready" && meeting.recap.pageSlug && (
      <div
        className="flex flex-wrap items-center gap-2 px-4 py-2"
        data-testid="card-meeting-recap-ready"
      >
        <Link
          href={`/info#library?page=${encodeURIComponent(meeting.recap.pageSlug)}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium hover-elevate"
          data-testid="link-meeting-recap-page"
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span>Recap ready</span>
          {meeting.recap.pageTitle && (
            <span className="text-muted-foreground truncate max-w-[16rem]">
              {meeting.recap.pageTitle}
            </span>
          )}
        </Link>
        {(meeting.recap.interactionsLogged ?? 0) > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
            data-testid="chip-meeting-recap-interactions"
          >
            <Users className="h-3 w-3 shrink-0" />
            {meeting.recap.interactionsLogged} interaction
            {meeting.recap.interactionsLogged === 1 ? "" : "s"} logged
          </span>
        )}
      </div>
    )}
    {meeting.recap?.status === "failed" && (
      <div
        className="flex items-center gap-2 px-4 py-1.5 text-xs text-destructive bg-destructive/10"
        data-testid="banner-meeting-recap-failed"
      >
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span>
          Recap failed{meeting.recap.error ? `: ${meeting.recap.error}` : ""}
        </span>
      </div>
    )}
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
