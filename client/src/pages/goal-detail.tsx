// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useMemo, useRef, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useFocusContext } from "@/hooks/use-focus-context";
import { usePageHeader } from "@/hooks/use-page-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Goal, GoalIndexEntry, GoalStatus } from "@shared/schema";
import { HORIZON_LABELS, goalHorizons, goalStatuses } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Pencil, Check, X, Calendar, Target, Link2, Plus, Loader2, StickyNote, Activity, Sparkles, Trash2, Tag, Network } from "lucide-react";
import { UniversalTagPicker } from "@/components/universal-tag-picker";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { useMentionAutocomplete } from "@/hooks/use-mention-autocomplete";
import { MentionPopover } from "@/components/mention-popover";

const log = createLogger("GoalDetail");

const STATUS_LABELS: Record<GoalStatus, string> = {
  active: "Active",
  on_track: "On Track",
  at_risk: "At Risk",
  achieved: "Achieved",
  blocked: "Blocked",
  dormant: "Dormant",
};

const STATUS_DOT_COLORS: Record<GoalStatus, string> = {
  active: "bg-info",
  on_track: "bg-success",
  at_risk: "bg-warning",
  achieved: "bg-success",
  blocked: "bg-error",
  dormant: "bg-neutral",
};


function InlineEdit({ value, onSave, type = "text", placeholder, enableMentions = false }: { value: string; onSave: (v: string) => void; type?: "text" | "textarea"; placeholder?: string; enableMentions?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [cursorPos, setCursorPos] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const mention = useMentionAutocomplete({
    value: draft,
    cursorPosition: cursorPos,
    onChange: (newValue, newCursor) => {
      setDraft(newValue);
      setCursorPos(newCursor);
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(newCursor, newCursor);
      });
    },
  });

  const handleSave = useCallback(() => {
    if (enableMentions && mention.trigger) return;
    onSave(draft);
    setEditing(false);
  }, [draft, onSave, enableMentions, mention.trigger]);

  const handleCancel = useCallback(() => {
    setDraft(value);
    setEditing(false);
  }, [value]);

  if (!editing) {
    return (
      <div className="group flex items-start gap-2 cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => { setDraft(value); setCursorPos(value.length); setEditing(true); }} data-testid="inline-edit-trigger">
        {type === "textarea" ? (
          <p className="text-sm whitespace-pre-wrap flex-1">{value || <span className="text-muted-foreground italic">{placeholder || "Click to add..."}</span>}</p>
        ) : (
          <span className="text-sm flex-1">
            {value ? <InlineReferenceText text={value} /> : <span className="text-muted-foreground italic">{placeholder || "Click to add..."}</span>}
          </span>
        )}
        <Pencil className="h-3.5 w-3.5 text-muted-foreground invisible group-hover:visible shrink-0 mt-0.5" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {type === "textarea" ? (
        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus data-testid="inline-edit-textarea" />
      ) : (
        <div className="relative">
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              const pos = e.target.selectionStart ?? e.target.value.length;
              setCursorPos(pos);
              if (enableMentions) mention.handleInputChange(e.target.value, pos);
            }}
            onKeyDown={(e) => {
              if (enableMentions && mention.handleKeyDown(e)) return;
              if (e.key === "Enter") { e.preventDefault(); handleSave(); }
              if (e.key === "Escape") { e.preventDefault(); handleCancel(); }
            }}
            autoFocus
            data-testid="inline-edit-input"
          />
          {enableMentions && (
            <MentionPopover
              trigger={mention.trigger}
              suggestions={mention.suggestions}
              isLoading={mention.isLoading}
              activeIndex={mention.activeIndex}
              onSelect={mention.insertSuggestion}
              onHover={mention.setActiveIndex}
              testIdSuffix="-inline-edit"
            />
          )}
        </div>
      )}
      <div className="flex items-center gap-1">
        <Button size="sm" onClick={handleSave} data-testid="button-inline-save">
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" onClick={handleCancel} data-testid="button-inline-cancel">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default function GoalDetail() {
  const [, params] = useRoute("/goals/:id");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const goalId = params?.id || "";

  const [newNote, setNewNote] = useState("");
  const [showParentPicker, setShowParentPicker] = useState(false);
  const [parentSearch, setParentSearch] = useState("");
  const [confirmReplaceParent, setConfirmReplaceParent] = useState<string | null>(null);

  const { data: goal, isLoading } = useQuery<Goal>({
    queryKey: ["/api/life-goals", goalId],
    enabled: !!goalId,
  });

  useFocusContext(goalId ? { entity: { type: "goal", id: goalId, label: goal?.shortName } } : null);
  usePageHeader({ title: goal?.shortName || "Goal" });

  const { data: allGoalsData } = useQuery<{ goals: GoalIndexEntry[] }>({
    queryKey: ["/api/life-goals"],
  });

  const { data: relatedMeetings } = useQuery<{ events: Array<{ id: string; summary: string; start: { dateTime?: string; date?: string }; attendees?: Array<{ email: string; displayName?: string }> }> }>({
    queryKey: ["/api/calendar/related", goal?.shortName || ""],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/related?q=${encodeURIComponent(goal?.shortName || "")}`, { credentials: "include" });
      if (!res.ok) return { events: [] };
      return res.json();
    },
    enabled: !!goal?.shortName,
  });

  const updateMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/life-goals/${goalId}`, updates);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      toast({ title: "Goal updated" });
    },
    onError: (err: Error) => {
      log.error("update failed:", err);
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/life-goals/${goalId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      toast({ title: "Goal deleted" });
      navigate("/goals");
    },
    onError: (err: Error) => {
      log.error("delete failed:", err);
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const res = await apiRequest("POST", `/api/life-goals/${goalId}/notes`, { content });
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId] });
      setNewNote("");
      toast({ title: "Note added" });
    },
    onError: (err: Error) => {
      log.error("add note failed:", err);
      toast({ title: "Failed to add note", description: err.message, variant: "destructive" });
    },
  });

  const setParentMutation = useMutation({
    mutationFn: async (parentId: string | null) => {
      if (parentId === null) {
        const res = await apiRequest("POST", `/api/life-goals/${goalId}/unlink-parent`, {});
        return await res.json();
      } else {
        const res = await apiRequest("POST", `/api/life-goals/${goalId}/set-parent`, { parentId });
        return await res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      setShowParentPicker(false);
      setConfirmReplaceParent(null);
      toast({ title: "Parent goal updated" });
    },
    onError: (err: Error) => {
      log.error("set parent failed:", err);
      toast({ title: "Failed to update parent", description: err.message, variant: "destructive" });
    },
  });

  const replaceParentMutation = useMutation({
    mutationFn: async (newParentId: string) => {
      await apiRequest("POST", `/api/life-goals/${goalId}/unlink-parent`, {});
      const setRes = await apiRequest("POST", `/api/life-goals/${goalId}/set-parent`, { parentId: newParentId });
      return await setRes.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      setShowParentPicker(false);
      setConfirmReplaceParent(null);
      toast({ title: "Parent goal replaced" });
    },
    onError: (err: Error) => {
      log.error("replace parent failed:", err);
      toast({ title: "Failed to replace parent", description: err.message, variant: "destructive" });
    },
  });

  const { data: allProjects = [] } = useQuery<Array<{ id: number; title: string; status: string; goalId: string | null }>>({
    queryKey: ["/api/projects"],
  });

  const linkedProjects = useMemo(() => {
    return allProjects.filter(p => p.goalId === goalId);
  }, [allProjects, goalId]);

  const [deleteOpen, setDeleteOpen] = useState(false);

  const availableParents = useMemo(() => {
    if (!allGoalsData?.goals || !goal) return [];
    const filtered = allGoalsData.goals.filter(g => g.id !== goalId);
    if (!parentSearch.trim()) return filtered;
    const q = parentSearch.toLowerCase();
    return filtered.filter(g => g.shortName.toLowerCase().includes(q) || (g.tags || []).some(t => t.toLowerCase().includes(q)));
  }, [allGoalsData, goal, goalId, parentSearch]);

  const handleSetParent = (newParentId: string) => {
    if (!goal) return;
    if (goal.parentId && goal.parentId !== newParentId) {
      setConfirmReplaceParent(newParentId);
    } else {
      setParentMutation.mutate(newParentId);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!goal) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <p className="text-muted-foreground">Goal not found</p>
        <Button variant="ghost" onClick={() => navigate("/goals")} data-testid="button-back-not-found">
          <ArrowLeft className="h-4 w-4" />
          Back to Goals
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-4 border-b flex-wrap">
        <Button variant="ghost" size="icon" onClick={() => navigate("/goals")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <InlineEdit
            value={goal.shortName}
            onSave={(v) => updateMutation.mutate({ shortName: v })}
            enableMentions
          />
        </div>
        <div className="flex items-center gap-1">
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" data-testid="button-delete-goal">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete goal?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete "{goal.shortName}" and all its notes and activity history. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <Button
                  variant="destructive"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  data-testid="button-confirm-delete-goal"
                >
                  {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 @lg:grid-cols-3 gap-4">
          <div className="@lg:col-span-2 space-y-4">
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Target className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Description</span>
              </div>
              <InlineEdit
                value={goal.description}
                onSave={(v) => updateMutation.mutate({ description: v })}
                type="textarea"
              />
            </Card>

            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <StickyNote className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Notes</span>
              </div>
              <div className="space-y-3 mb-4">
                {[...goal.notes].reverse().map((note) => (
                  <div key={note.id} className="text-sm border-b pb-2 last:border-b-0" data-testid={`note-${note.id}`}>
                    <p className="whitespace-pre-wrap">{note.content}</p>
                    <span className="text-xs text-muted-foreground mt-1 block">
                      {new Date(note.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
                {goal.notes.length === 0 && (
                  <p className="text-sm text-muted-foreground">No notes yet.</p>
                )}
              </div>
              <div className="flex gap-2">
                <Textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  className="flex-1"
                  data-testid="input-new-note"
                />
                <Button
                  onClick={() => addNoteMutation.mutate(newNote)}
                  disabled={!newNote.trim() || addNoteMutation.isPending}
                  data-testid="button-add-note"
                >
                  {addNoteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                </Button>
              </div>
            </Card>

            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Activity</span>
              </div>
              <div className="space-y-2">
                {[...goal.activities].reverse().map((act) => (
                  <div key={act.id} className="text-sm border-b pb-2 last:border-b-0" data-testid={`activity-${act.id}`}>
                    <span className="font-medium">{act.action}</span>
                    {act.detail && <span className="text-muted-foreground ml-1">{act.detail}</span>}
                    <span className="text-xs text-muted-foreground block mt-0.5">
                      {new Date(act.timestamp).toLocaleString()}
                    </span>
                  </div>
                ))}
                {goal.activities.length === 0 && (
                  <p className="text-sm text-muted-foreground">No activity yet.</p>
                )}
              </div>
            </Card>
          </div>

          <div className="space-y-4">
            <Card className="p-4 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Metadata</span>
              </div>

              <div>
                <span className="text-xs text-muted-foreground block mb-1">Horizon</span>
                <Select
                  value={goal.horizon}
                  onValueChange={(v) => updateMutation.mutate({ horizon: v })}
                >
                  <SelectTrigger data-testid="select-horizon">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {goalHorizons.map(h => (
                      <SelectItem key={h} value={h}>{HORIZON_LABELS[h]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <span className="text-xs text-muted-foreground block mb-1">Status</span>
                <Select
                  value={goal.status || "active"}
                  onValueChange={(v) => updateMutation.mutate({ status: v })}
                >
                  <SelectTrigger data-testid="select-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {goalStatuses.map(s => (
                      <SelectItem key={s} value={s}>
                        <span className="flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${STATUS_DOT_COLORS[s]}`} />
                          {STATUS_LABELS[s]}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <span className="text-xs text-muted-foreground block mb-1">Owner</span>
                <InlineEdit
                  value={goal.owner}
                  onSave={(v) => updateMutation.mutate({ owner: v })}
                />
              </div>
            </Card>

            <Card className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Tag className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Tags</span>
              </div>
              <UniversalTagPicker
                tags={goal.tags}
                onChange={(newTags) => updateMutation.mutate({ tags: newTags })}
                placeholder="Add tag..."
                data-testid="picker-goal-tags"
              />
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <Network className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Parent Goal</span>
                </div>
                <div className="flex items-center gap-1">
                  {goal.parentId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setParentMutation.mutate(null)}
                      disabled={setParentMutation.isPending}
                      data-testid="button-unlink-parent"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowParentPicker(!showParentPicker)}
                    data-testid="button-set-parent"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mb-2">
                {goal.parentId ? (
                  (() => {
                    const parentGoal = allGoalsData?.goals?.find(g => g.id === goal.parentId);
                    return (
                      <Badge
                        variant="secondary"
                        className="gap-1 cursor-pointer"
                        onClick={() => navigate(`/goals/${goal.parentId}`)}
                        data-testid="badge-parent-goal"
                      >
                        <InlineReferenceText text={parentGoal?.shortName || goal.parentId} className="truncate" />
                      </Badge>
                    );
                  })()
                ) : (
                  <p className="text-sm text-muted-foreground">No parent goal.</p>
                )}
              </div>
              {showParentPicker && (
                <div className="border rounded-md p-2 space-y-1.5" data-testid="parent-picker">
                  <Input
                    value={parentSearch}
                    onChange={(e) => setParentSearch(e.target.value)}
                    placeholder="Search goals..."
                    className="h-8 text-sm"
                    autoFocus
                    data-testid="input-parent-search"
                  />
                  <div className="max-h-40 overflow-y-auto space-y-0.5">
                    {availableParents.length === 0 && (
                      <p className="text-xs text-muted-foreground py-2 text-center">No matching goals.</p>
                    )}
                    {availableParents.map(g => (
                      <div
                        key={g.id}
                        className="flex items-center gap-2 text-sm rounded-md p-1.5 cursor-pointer hover-elevate"
                        onClick={() => { handleSetParent(g.id); setParentSearch(""); }}
                        data-testid={`parent-option-${g.id}`}
                      >
                        <InlineReferenceText text={g.shortName} className="flex-1 truncate" />
                        <span className="inline-flex items-center bg-cat-event/15 text-cat-event-foreground border border-cat-event/30 rounded-sm text-xs font-medium px-2 py-0.5">{HORIZON_LABELS[g.horizon]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {confirmReplaceParent && (
                <AlertDialog open={!!confirmReplaceParent} onOpenChange={() => setConfirmReplaceParent(null)}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Replace parent goal?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This goal already has a parent. This will unlink the current parent and set the new one.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <Button
                        onClick={() => {
                          if (confirmReplaceParent) replaceParentMutation.mutate(confirmReplaceParent);
                        }}
                        disabled={replaceParentMutation.isPending}
                        data-testid="button-confirm-replace-parent"
                      >
                        {replaceParentMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Replace"}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </Card>

            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Link2 className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Linked Projects</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {linkedProjects.map(p => (
                  <span key={p.id} className="inline-flex items-center gap-1 bg-cat-channel/15 text-cat-channel-foreground border border-cat-channel/30 rounded-sm text-xs font-medium px-2 py-0.5 cursor-pointer" data-testid={`badge-project-${p.id}`} onClick={() => navigate(`/projects/${p.id}`)}>
                    {p.title}
                  </span>
                ))}
                {linkedProjects.length === 0 && (
                  <p className="text-sm text-muted-foreground">No linked projects. Link a project by setting its goal on the project page.</p>
                )}
              </div>
            </Card>

            {(relatedMeetings?.events?.length || 0) > 0 && (
              <Card className="p-4" data-testid="card-related-meetings">
                <div className="flex items-center gap-2 mb-3">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Related Meetings</span>
                  <span className="text-xs text-muted-foreground ml-auto">{relatedMeetings!.events.length}</span>
                </div>
                <div className="space-y-1.5">
                  {relatedMeetings!.events.slice(0, 5).map(e => {
                    const time = e.start?.dateTime
                      ? new Date(e.start.dateTime).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                      : e.start?.date || "";
                    return (
                      <div key={e.id} className="flex items-center gap-2 text-xs py-1" data-testid={`related-meeting-${e.id}`}>
                        <span className="text-muted-foreground shrink-0 w-14">{time}</span>
                        <span className="truncate flex-1">{e.summary}</span>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
