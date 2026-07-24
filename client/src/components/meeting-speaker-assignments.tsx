import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  Loader2,
  Mic2,
  Search,
  UserRound,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { createReferenceRef } from "@shared/references";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import type {
  MeetingAudioSourceMode,
  MeetingParticipant,
  MeetingRecognitionStream,
  MeetingSessionMeta,
} from "@shared/models/chat";

const log = createLogger("MeetingSpeakerAssignments");

interface SpeakerPersonOption {
  id: string;
  name: string;
  nicknames?: string[];
}

interface PersonSpeakerRow {
  id: string;
  participant?: MeetingParticipant;
  stream?: MeetingRecognitionStream;
}

function normalizedLabel(value: string | null | undefined): string {
  return value
    ?.toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() || "";
}

function speakerDisplayLabel(participant: MeetingParticipant, index?: number): string {
  return participant.providerLabel?.trim()
    || participant.label.trim()
    || `Unknown speaker${index == null ? "" : ` ${index + 1}`}`;
}

function speakerTestId(participant: MeetingParticipant): string {
  return (participant.key || speakerDisplayLabel(participant))
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function recognitionTitle(stream?: MeetingRecognitionStream): string | undefined {
  if (!stream) return undefined;
  return [stream.transportLabel, stream.provider, stream.model, stream.detail]
    .filter(Boolean)
    .join(" · ");
}

function buildPersonSpeakerRows(meeting: MeetingSessionMeta): PersonSpeakerRow[] {
  const humanStreams = meeting.recognition?.streams.filter(
    (stream) => stream.attribution !== "excluded",
  ) || [];
  const excludedTransportIds = new Set(
    meeting.recognition?.streams
      .filter((stream) => stream.attribution === "excluded")
      .map((stream) => stream.transportParticipantId) || [],
  );
  const visibleParticipants = meeting.participants.filter((participant) => {
    if (participant.transportParticipantId
      && excludedTransportIds.has(participant.transportParticipantId)) return false;
    const label = normalizedLabel(participant.providerLabel || participant.label);
    return !label.includes("mantra agent") && !label.includes("meeting bot");
  });
  return visibleParticipants.map((participant, index): PersonSpeakerRow => {
    const directStream = participant.transportParticipantId
      ? humanStreams.find(
          (stream) => stream.transportParticipantId === participant.transportParticipantId,
        )
      : undefined;
    const exactLabelStream = !directStream
      ? humanStreams.filter(
          (stream) => normalizedLabel(stream.transportLabel) === normalizedLabel(participant.label),
        )
      : [];
    const stream = directStream || (exactLabelStream.length === 1 ? exactLabelStream[0] : undefined);
    return {
      id: participant.key || participant.personId || `${participant.label}-${index}`,
      participant,
      stream,
    };
  });
}

function AudioSourcePolicyControl({
  sessionId,
  stream,
  desiredMode,
}: {
  sessionId: string;
  stream: MeetingRecognitionStream;
  desiredMode: MeetingAudioSourceMode;
}) {
  const { toast } = useToast();
  const isShared = desiredMode === "shared_room";
  const isReconfiguring = desiredMode !== stream.sourcePolicy || stream.status === "connecting";
  const failed = stream.status === "failed" || stream.status === "fallback";
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

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground",
        isShared && !failed && "text-active hover:text-active",
        failed && "text-destructive hover:text-destructive",
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
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : failed ? (
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Mic2 className="h-3.5 w-3.5 shrink-0" />
      )}
      <span>{isReconfiguring ? "Recognizing" : failed && isShared ? "Shared degraded" : isShared ? "Shared" : "Individual"}</span>
    </Button>
  );
}

function PersonAssignmentControl({
  participant,
  sessionId,
  people,
  speakerLabel,
}: {
  participant: MeetingParticipant;
  sessionId: string;
  people: SpeakerPersonOption[];
  speakerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { toast } = useToast();
  const assignedPerson = people.find((person) => person.id === participant.personId);
  const normalizedSearch = search.trim().toLowerCase();
  const options = useMemo(() => people
    .filter((person) => !normalizedSearch || [person.name, ...(person.nicknames || [])]
      .some((value) => value.toLowerCase().includes(normalizedSearch)))
    .slice(0, 8), [people, normalizedSearch]);
  const testId = speakerTestId(participant);

  const assignment = useMutation({
    mutationFn: async (personId: string | null) => {
      const response = await apiRequest(
        "PATCH",
        `/api/meetings/${encodeURIComponent(sessionId)}/speaker-person`,
        { speakerKey: participant.key, personId },
      );
      return response.json();
    },
    onSuccess: () => {
      setOpen(false);
      setSearch("");
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
    },
    onError: (error: Error) => {
      log.error("Speaker assignment failed", {
        sessionId,
        speakerKey: participant.key,
        error,
      });
      toast({
        title: "Speaker assignment failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-5 min-h-5 max-w-full min-w-0 justify-start rounded-md border border-transparent px-1.5 py-0 text-xs font-normal shadow-none",
            open && "border-input bg-muted/50",
            !participant.personId && "text-muted-foreground",
          )}
          disabled={assignment.isPending}
          aria-expanded={open}
          data-testid={`button-assign-${testId}`}
        >
          {assignment.isPending ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : assignedPerson && participant.personId ? (
            <ReferenceRenderer
              refValue={createReferenceRef({
                type: "person",
                id: participant.personId,
                metadata: { label: assignedPerson.name, href: `/people/${participant.personId}` },
              })}
              surface="chat-inline"
              className="mx-0 max-w-full pointer-events-none"
            />
          ) : (
            <>
              <UserRound className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{speakerLabel}</span>
            </>
          )}
          {open && <ChevronDown className="ml-1 h-3 w-3 shrink-0 text-muted-foreground" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search people"
            className="h-9 pl-8 text-sm"
            autoFocus
            data-testid={`input-search-${testId}`}
          />
        </div>
        <div className="mt-1 max-h-52 overflow-y-auto scrollbar-thin">
          <button
            type="button"
            className={cn(
              "flex min-h-10 w-full items-center rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
              !participant.personId && "font-medium text-foreground",
            )}
            onClick={() => assignment.mutate(null)}
            disabled={assignment.isPending}
            data-testid={`option-unassigned-${testId}`}
          >
            Unassigned
          </button>
          {options.map((person) => (
            <button
              key={person.id}
              type="button"
              className={cn(
                "flex min-h-10 w-full items-center rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                participant.personId === person.id && "font-medium text-foreground",
              )}
              onClick={() => assignment.mutate(person.id)}
              disabled={assignment.isPending}
              data-testid={`option-speaker-person-${person.id}`}
            >
              <span className="truncate">{person.name}</span>
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-2 py-3 text-sm text-muted-foreground">
              No people found
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ExpectedPerson({ participant }: { participant: MeetingParticipant }) {
  if (participant.personId) {
    return (
      <div className="flex min-h-8 min-w-0 items-center px-2 py-1.5">
        <ReferenceRenderer
          refValue={createReferenceRef({
            type: "person",
            id: participant.personId,
            metadata: { label: participant.label, href: `/people/${participant.personId}` },
          })}
          surface="simple-row"
          className="max-w-full"
        />
      </div>
    );
  }
  return (
    <div className="flex min-h-8 items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
      <UserRound className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{participant.label}</span>
    </div>
  );
}

function SpeakerState({
  participant,
  stream,
}: {
  participant: MeetingParticipant;
  stream?: MeetingRecognitionStream;
}) {
  const failed = stream?.status === "failed" || stream?.status === "fallback";
  const active = stream?.status === "active";
  return (
    <div
      className="flex min-h-8 min-w-0 items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
      title={recognitionTitle(stream)}
    >
      <Mic2 className={cn(
        "h-3.5 w-3.5 shrink-0",
        active && "text-active",
        failed && "text-destructive",
      )} />
      <span className="truncate">{participant.key ? speakerDisplayLabel(participant) : "No speaker detected"}</span>
    </div>
  );
}

export function MeetingSpeakerAssignments({
  meeting,
  sessionId,
}: {
  meeting: MeetingSessionMeta;
  sessionId: string;
}) {
  const rows = useMemo(() => buildPersonSpeakerRows(meeting), [meeting]);
  const assignableSpeakers = rows
    .map((row) => row.participant)
    .filter((participant): participant is MeetingParticipant => !!participant?.key);
  const { data } = useQuery<{ people: SpeakerPersonOption[] }>({
    queryKey: ["/api/people"],
    enabled: assignableSpeakers.length > 0,
  });
  const hasArtifactChildren = Boolean(
    meeting.agendaPage
    || meeting.agenda
    || (meeting.recap?.status === "ready" && meeting.recap.pageId && meeting.recap.pageSlug),
  );
  if (rows.length === 0) return null;

  return (
    <div className="border-t border-border/20" data-testid="meeting-speaker-assignments">
      {rows.map((row, index) => {
        const participant = row.participant;
        const hasStableSpeaker = !!participant?.key;
        const continues = index < rows.length - 1 || hasArtifactChildren;
        return (
          <HierarchyTreeRow key={row.id} continues={continues}>
            <div
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center",
                continues && "border-b border-border/20",
              )}
              data-testid={`person-speaker-row-${row.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`}
            >
              <div className="min-w-0 border-r border-border/10">
                {hasStableSpeaker && participant ? (
                  <div className="flex min-h-8 min-w-0 items-center px-2 py-1.5">
                    <PersonAssignmentControl
                      participant={participant}
                      sessionId={sessionId}
                      people={data?.people || []}
                      speakerLabel={speakerDisplayLabel(participant)}
                    />
                  </div>
                ) : participant ? (
                  <ExpectedPerson participant={participant} />
                ) : (
                  <div className="flex min-h-8 items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                    <UserRound className="h-3.5 w-3.5 shrink-0" />
                    <span>Unresolved person</span>
                  </div>
                )}
              </div>
              {participant ? (
                <SpeakerState participant={participant} stream={row.stream} />
              ) : null}
              {meeting.botStatus === "live" && row.stream ? (
                <div className="flex items-center px-1 sm:pr-2">
                  <AudioSourcePolicyControl
                    sessionId={sessionId}
                    stream={row.stream}
                    desiredMode={meeting.audioSourcePolicies?.[row.stream.streamKey]?.mode || row.stream.sourcePolicy}
                  />
                </div>
              ) : null}
            </div>
          </HierarchyTreeRow>
        );
      })}
    </div>
  );
}
