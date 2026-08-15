import { useMemo, useState, type FocusEvent } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Calendar,
  Flag,
  Link2,
  Loader2,
  Network,
  Plus,
  StickyNote,
  Tag,
  Target,
  User,
  Vault as VaultIcon,
} from "lucide-react";
import type { Goal, GoalIndexEntry, GoalStatus } from "@shared/schema";
import { goalHorizons, goalStatuses, HORIZON_LABELS } from "@shared/schema";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { UniversalTagPicker } from "@/components/universal-tag-picker";
import { ReferencePicker } from "@/components/references/reference-picker";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { GoalRelationshipsRow } from "@/components/goal-relationships-row";
import { BlockedByRow } from "@/components/blocked-by-row";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { createLogger } from "@/lib/logger";
import { useVaults } from "@/hooks/use-vaults";

const log = createLogger("GoalInlineDetails");

const STATUS_LABELS: Record<GoalStatus, string> = {
  active: "Active",
  on_track: "On Track",
  at_risk: "At Risk",
  achieved: "Achieved",
  blocked: "Blocked",
  dormant: "Dormant",
};

interface RelatedMeeting {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
}

interface LinkedProject {
  id: number;
  title: string;
  status: string;
  goalId: string | null;
}

interface GoalInlineDetailsProps {
  goalId: string;
}

function invalidateGoal(goalId: string) {
  queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId] });
  queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
  queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
}

function commitTextInput(
  event: FocusEvent<HTMLInputElement>,
  currentValue: string,
  onCommit: (value: string) => void,
) {
  const value = event.currentTarget.value.trim();
  if (value && value !== currentValue) onCommit(value);
  else event.currentTarget.value = currentValue;
}

export function GoalInlineDetails({ goalId }: GoalInlineDetailsProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { vaults, visibleVaultIds } = useVaults();
  const visibleVaults = useMemo(
    () => vaults.filter((vault) => visibleVaultIds.includes(vault.id)),
    [vaults, visibleVaultIds],
  );
  const [newNote, setNewNote] = useState("");

  const { data: goal, isLoading, isError } = useQuery<Goal>({
    queryKey: ["/api/life-goals", goalId],
  });

  const { data: allGoalsData } = useQuery<{ goals: GoalIndexEntry[] }>({
    queryKey: ["/api/life-goals"],
  });

  const { data: allProjects = [] } = useQuery<LinkedProject[]>({
    queryKey: ["/api/projects"],
    enabled: Boolean(goal),
  });

  const { data: relatedMeetings } = useQuery<{ events: RelatedMeeting[] }>({
    queryKey: ["/api/calendar/related", goal?.shortName || ""],
    queryFn: async () => {
      const response = await fetch(`/api/calendar/related?q=${encodeURIComponent(goal?.shortName || "")}`, {
        credentials: "include",
      });
      if (!response.ok) return { events: [] };
      return response.json();
    },
    enabled: Boolean(goal?.shortName),
  });

  const updateMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      const response = await apiRequest("PATCH", `/api/life-goals/${goalId}`, updates);
      return response.json();
    },
    onSuccess: () => invalidateGoal(goalId),
    onError: (error: Error) => {
      log.error("Goal update failed", { goalId, errorType: error.name });
      toast({ title: "Goal update failed", variant: "destructive" });
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const response = await apiRequest("POST", `/api/life-goals/${goalId}/notes`, { content });
      return response.json();
    },
    onSuccess: () => {
      invalidateGoal(goalId);
      setNewNote("");
    },
    onError: (error: Error) => {
      log.error("Goal note creation failed", { goalId, errorType: error.name });
      toast({ title: "Note could not be added", variant: "destructive" });
    },
  });

  const parentMutation = useMutation({
    mutationFn: async (parentId: string) => {
      if (parentId === (goal?.parentId || "none")) return null;
      const response = await apiRequest(
        "PATCH",
        `/api/life-goals/${goalId}`,
        { parentId: parentId === "none" ? null : parentId },
      );
      return response.json();
    },
    onSuccess: () => invalidateGoal(goalId),
    onError: (error: Error) => {
      log.error("Goal parent update failed", { goalId, errorType: error.name });
      invalidateGoal(goalId);
      toast({ title: "Parent goal could not be updated", variant: "destructive" });
    },
  });

  const linkedProjects = useMemo(
    () => allProjects.filter((project) => project.goalId === goalId),
    [allProjects, goalId],
  );
  const parentValue = useMemo(() => {
    if (!goal?.parentId) return [];
    const parent = allGoalsData?.goals?.find((candidate) => candidate.id === goal.parentId);
    return [
      {
        type: "goal" as const,
        id: goal.parentId,
        label: parent?.shortName || goal.parentId,
      },
    ];
  }, [allGoalsData?.goals, goal?.parentId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4" data-testid={`goal-inline-loading-${goalId}`}>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !goal) {
    return <div className="px-2 py-1.5 text-sm text-muted-foreground">Goal details unavailable.</div>;
  }

  return (
    <div className="overflow-hidden rounded-md border border-border/20" data-testid={`goal-inline-details-${goalId}`}>
      <ProfileTreeRow
        label="Description"
        icon={<Target className="h-3.5 w-3.5" />}
        hasValue={Boolean(goal.description)}
        showEmpty
        mobileLayout="inline"
        expandedContent={(
          <Textarea
            key={goal.description}
            defaultValue={goal.description}
            placeholder="Description"
            onBlur={(event) => {
              const value = event.currentTarget.value.trim();
              if (value && value !== goal.description) updateMutation.mutate({ description: value });
              else event.currentTarget.value = goal.description;
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = goal.description;
                event.currentTarget.blur();
              }
            }}
            className="min-h-20 w-full resize-none"
            data-testid={`input-goal-description-${goalId}`}
          />
        )}
        expandedContentClassName="px-2 pb-2 pl-2"
        testId={`row-goal-description-${goalId}`}
      >
        <span className="block w-full truncate text-muted-foreground">{goal.description || "Add"}</span>
      </ProfileTreeRow>

      <ProfileTreeRow label="Vault" icon={<VaultIcon className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId={`row-goal-vault-${goalId}`}>
        <Select value={goal.vaultId} onValueChange={(vaultId) => updateMutation.mutate({ vaultId })} disabled={updateMutation.isPending}>
          <SelectTrigger className="h-7 border-0 bg-transparent px-0 text-sm shadow-none focus:ring-0" data-testid={`select-goal-vault-${goalId}`}>
            <SelectValue placeholder="Choose Vault" />
          </SelectTrigger>
          <SelectContent>
            {visibleVaults.map((vault) => <SelectItem key={vault.id} value={vault.id}>{vault.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </ProfileTreeRow>

      <ProfileTreeRow label="Horizon" icon={<Flag className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId={`row-goal-horizon-${goalId}`}>
        <Select value={goal.horizon} onValueChange={(horizon) => updateMutation.mutate({ horizon })}>
          <SelectTrigger className="w-48" data-testid={`select-goal-horizon-${goalId}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {goalHorizons.map((horizon) => <SelectItem key={horizon} value={horizon}>{HORIZON_LABELS[horizon]}</SelectItem>)}
          </SelectContent>
        </Select>
      </ProfileTreeRow>

      <ProfileTreeRow label="Status" icon={<Activity className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId={`row-goal-status-${goalId}`}>
        <Select value={goal.status} onValueChange={(status) => updateMutation.mutate({ status })}>
          <SelectTrigger className="w-48" data-testid={`select-goal-status-${goalId}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {goalStatuses.map((status) => <SelectItem key={status} value={status}>{STATUS_LABELS[status]}</SelectItem>)}
          </SelectContent>
        </Select>
      </ProfileTreeRow>

      <ProfileTreeRow label="Target" icon={<Calendar className="h-3.5 w-3.5" />} hasValue={Boolean(goal.targetDate)} showEmpty mobileLayout="inline" testId={`row-goal-target-${goalId}`}>
        <Input
          key={goal.targetDate || "no-target"}
          type="date"
          defaultValue={goal.targetDate || ""}
          onBlur={(event) => {
            const value = event.currentTarget.value;
            if (value !== (goal.targetDate || "")) updateMutation.mutate({ targetDate: value || null });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = goal.targetDate || "";
              event.currentTarget.blur();
            }
          }}
          data-testid={`input-goal-target-${goalId}`}
        />
      </ProfileTreeRow>

      <ProfileTreeRow label="Owner" icon={<User className="h-3.5 w-3.5" />} hasValue={Boolean(goal.owner)} showEmpty mobileLayout="inline" testId={`row-goal-owner-${goalId}`}>
        <Input
          key={goal.owner}
          defaultValue={goal.owner}
          placeholder="Owner"
          onBlur={(event) => commitTextInput(event, goal.owner, (owner) => updateMutation.mutate({ owner }))}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = goal.owner;
              event.currentTarget.blur();
            }
          }}
          data-testid={`input-goal-owner-${goalId}`}
        />
      </ProfileTreeRow>

      <ProfileTreeRow label="Tags" icon={<Tag className="h-3.5 w-3.5" />} hasValue={goal.tags.length > 0} showEmpty mobileLayout="inline" testId={`row-goal-tags-${goalId}`}>
        <UniversalTagPicker
          tags={goal.tags}
          onChange={(tags) => updateMutation.mutate({ tags })}
          placeholder="Add tag"
          data-testid={`picker-goal-tags-${goalId}`}
        />
      </ProfileTreeRow>

      <ProfileTreeRow label="Parent" icon={<Network className="h-3.5 w-3.5" />} hasValue={Boolean(goal.parentId)} showEmpty mobileLayout="inline" testId={`row-goal-parent-${goalId}`}>
        <ReferencePicker
          mode="single"
          types={["goal"]}
          value={parentValue}
          excludeIds={[goalId]}
          onChange={(next) => {
            const pick = next[0];
            parentMutation.mutate(pick?.id ?? "none");
          }}
          placeholder="Search parent goal…"
          dense
          testId={`picker-goal-parent-${goalId}`}
        />
      </ProfileTreeRow>

      <ProfileTreeRow
        label="Notes"
        icon={<StickyNote className="h-3.5 w-3.5" />}
        hasValue={goal.notes.length > 0}
        showEmpty
        mobileLayout="inline"
        expandedContent={(
          <div className="space-y-2">
            {[...goal.notes].reverse().map((note) => (
              <div key={note.id} className="border-b border-border/20 pb-2 last:border-b-0" data-testid={`goal-note-${note.id}`}>
                <p className="whitespace-pre-wrap text-sm">{note.content}</p>
                <span className="text-xs text-muted-foreground">{new Date(note.createdAt).toLocaleString()}</span>
              </div>
            ))}
            <div className="flex items-end gap-2">
              <Textarea value={newNote} onChange={(event) => setNewNote(event.currentTarget.value)} placeholder="Add a note" className="min-h-16 flex-1 resize-none" data-testid={`input-goal-note-${goalId}`} />
              <Button size="icon" variant="ghost" onClick={() => addNoteMutation.mutate(newNote.trim())} disabled={!newNote.trim() || addNoteMutation.isPending} aria-label="Add note" data-testid={`button-add-goal-note-${goalId}`}>
                {addNoteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        )}
        expandedContentClassName="px-2 pb-2 pl-2"
        testId={`row-goal-notes-${goalId}`}
      >
        <span className="text-muted-foreground">{goal.notes.length ? `${goal.notes.length} ${goal.notes.length === 1 ? "note" : "notes"}` : "Add"}</span>
      </ProfileTreeRow>

      <ProfileTreeRow
        label="Activity"
        icon={<Activity className="h-3.5 w-3.5" />}
        hasValue={goal.activities.length > 0}
        showEmpty
        mobileLayout="inline"
        expandedContent={(
          <div className="space-y-2">
            {[...goal.activities].reverse().map((activity) => (
              <div key={activity.id} className="border-b border-border/20 pb-2 last:border-b-0" data-testid={`goal-activity-${activity.id}`}>
                <p className="text-sm"><span className="font-medium">{activity.action}</span>{activity.detail ? ` · ${activity.detail}` : ""}</p>
                <span className="text-xs text-muted-foreground">{new Date(activity.timestamp).toLocaleString()}</span>
              </div>
            ))}
            {goal.activities.length === 0 && <p className="text-sm text-muted-foreground">No activity yet.</p>}
          </div>
        )}
        expandedContentClassName="px-2 pb-2 pl-2"
        testId={`row-goal-activity-${goalId}`}
      >
        <span className="text-muted-foreground">{goal.activities.length || "None"}</span>
      </ProfileTreeRow>

      <GoalRelationshipsRow goalId={goalId} />
      <BlockedByRow sourceAddress={`@goal:${goalId}`} testId={`row-goal-blocked-by-${goalId}`} />

      <ProfileTreeRow
        label="Projects"
        icon={<Link2 className="h-3.5 w-3.5" />}
        hasValue={linkedProjects.length > 0}
        showEmpty
        mobileLayout="inline"
        expandedContent={(
          <div className="space-y-1">
            {linkedProjects.map((project) => (
              <button key={project.id} type="button" className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-cta hover:bg-accent/70" onClick={() => setLocation(`/projects?project=${project.id}`)}>
                {project.title}
              </button>
            ))}
            {linkedProjects.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No linked projects.</p>}
          </div>
        )}
        expandedContentClassName="px-0 pb-1 pl-0"
        testId={`row-goal-projects-${goalId}`}
      >
        <span className="text-muted-foreground">{linkedProjects.length || "None"}</span>
      </ProfileTreeRow>

      {(relatedMeetings?.events.length || 0) > 0 && (
        <ProfileTreeRow
          label="Meetings"
          icon={<Calendar className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          expandedContent={(
            <div className="space-y-1">
              {relatedMeetings?.events.slice(0, 5).map((meeting) => {
                const date = meeting.start.dateTime
                  ? new Date(meeting.start.dateTime).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                  : meeting.start.date || "";
                return (
                  <div key={meeting.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
                    <span className="w-14 shrink-0 text-xs text-muted-foreground">{date}</span>
                    <InlineReferenceText text={meeting.summary} className="truncate" />
                  </div>
                );
              })}
            </div>
          )}
          expandedContentClassName="px-0 pb-1 pl-0"
          testId={`row-goal-meetings-${goalId}`}
        >
          <span className="text-muted-foreground">{relatedMeetings?.events.length}</span>
        </ProfileTreeRow>
      )}
    </div>
  );
}
