import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, Loader2, Search, UserRound } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { MeetingParticipant } from "@shared/models/chat";

const log = createLogger("MeetingSpeakerAssignments");

interface SpeakerPersonOption {
  id: string;
  name: string;
  nicknames?: string[];
}

function speakerDisplayLabel(participant: MeetingParticipant, index?: number): string {
  return participant.label.trim() || `Unknown speaker${index == null ? "" : ` ${index + 1}`}`;
}

function speakerTestId(participant: MeetingParticipant): string {
  return (participant.key || speakerDisplayLabel(participant))
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function SpeakerAssignment({
  participant,
  sessionId,
  people,
}: {
  participant: MeetingParticipant;
  sessionId: string;
  people: SpeakerPersonOption[];
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
    <div className="flex min-w-0 items-center gap-2" data-testid={`speaker-assignment-${testId}`}>
      <span className="w-20 shrink-0 truncate text-xs font-medium text-foreground">
        {speakerDisplayLabel(participant)}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-7 min-w-0 max-w-56 justify-start gap-1.5 px-2 text-xs",
              !participant.personId && "text-muted-foreground",
            )}
            disabled={assignment.isPending}
            data-testid={`button-assign-${testId}`}
          >
            {assignment.isPending ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            ) : (
              <UserRound className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate">
              {assignedPerson?.name || (participant.personId ? "Assigned Person" : "Unassigned")}
            </span>
            <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" align="start">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search people"
              className="h-8 pl-7 text-xs"
              autoFocus
              data-testid={`input-search-${testId}`}
            />
          </div>
          <div className="mt-1 max-h-52 overflow-y-auto scrollbar-thin">
            <button
              type="button"
              className={cn(
                "flex w-full items-center rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
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
                  "flex w-full items-center rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
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
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                No people found
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function MeetingSpeakerAssignments({
  participants,
  sessionId,
}: {
  participants: MeetingParticipant[];
  sessionId: string;
}) {
  const anonymousSpeakers = participants.filter(
    (participant) => participant.source === "machine_diarization" && !!participant.key,
  );
  const { data } = useQuery<{ people: SpeakerPersonOption[] }>({
    queryKey: ["/api/people"],
    enabled: anonymousSpeakers.length > 0,
  });
  if (anonymousSpeakers.length === 0) return null;

  return (
    <div className="border-t border-border/20 px-4 py-2" data-testid="meeting-speaker-assignments">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">Speakers</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {anonymousSpeakers.map((participant, index) => (
          <SpeakerAssignment
            key={participant.key}
            participant={{ ...participant, label: speakerDisplayLabel(participant, index) }}
            sessionId={sessionId}
            people={data?.people || []}
          />
        ))}
      </div>
    </div>
  );
}
