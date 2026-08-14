// ActivityDetailView — right panel for the list/detail split
// This is a new component that shows editable properties + embeds ActivityDetailPanel for trends/history

import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Trash2, Loader2 } from "lucide-react";
import { useState, useCallback, useRef, useEffect } from "react";
import { ActivityDetailPanel } from "./activity-detail-panel";
import { WindowEditor } from "./window-editor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// --- Types (shared with calendar-content) ---

type ActivityPulse = "good" | "okay" | "danger" | "never_done";

interface ActivityWithStatus {
  id: number;
  name: string;
  benefit: string | null;
  risk: string | null;
  intervalDays: number;
  category: string;
  isDefault: boolean;
  linkedMetricType: string | null;
  greatThreshold: number | null;
  goodThreshold: number | null;
  lastCompletedAt: string | null;
  tier: string | null;
  metricValue: number | null;
  doneForCurrentPeriod: boolean;
  status: "overdue" | "due_soon" | "on_track" | "never_done";
  urgency: number;
  daysSince: number | null;
  daysUntilDue: number | null;
  pulse: ActivityPulse;
  pulsePercent: number | null;
  rollingAvgIntervalDays: number | null;
  windowSize: number;
  windowStart: number | null;
  windowEnd: number | null;
  inWindow: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  daily_practice: "Daily",
  weekly_ritual: "Weekly",
  monthly_renewal: "Monthly",
  quarterly_reset: "Quarterly",
  annual_checkup: "Annual",
};

function categoryFromInterval(days: number): string {
  if (days <= 1) return "daily_practice";
  if (days <= 7) return "weekly_ritual";
  if (days <= 30) return "monthly_renewal";
  if (days <= 90) return "quarterly_reset";
  return "annual_checkup";
}

// --- Inline editable components for detail panel ---

function DetailEditableText({
  value,
  activityId,
  field,
  placeholder,
  multiline,
}: {
  value: string;
  activityId: number;
  field: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [localValue, setLocalValue] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const saveMutation = useMutation({
    mutationFn: async (newValue: string) => {
      await apiRequest("PATCH", `/api/wellness/activities/${activityId}`, { [field]: newValue || null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
      setLocalValue(value);
    },
  });

  const commitEdit = useCallback(() => {
    setEditing(false);
    if (localValue !== value) {
      saveMutation.mutate(localValue);
    }
  }, [localValue, value]);

  if (editing) {
    if (multiline) {
      return (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          className="min-h-20 w-full resize-none"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setLocalValue(value); setEditing(false); }
          }}
        />
      );
    }
    return (
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        className="w-full"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitEdit();
          if (e.key === "Escape") { setLocalValue(value); setEditing(false); }
        }}
      />
    );
  }

  return (
    <span
      className="block w-full cursor-pointer truncate rounded px-1 py-0.5 text-right text-xs transition-colors hover:bg-muted/50"
      onClick={() => { setEditing(true); setLocalValue(value); }}
      title="Click to edit"
    >
      {value || <span className="text-muted-foreground/50 italic">{placeholder ?? "—"}</span>}
    </span>
  );
}

function DetailEditableNumber({
  value,
  activityId,
  field,
  suffix,
  currentCategory,
}: {
  value: number | null;
  activityId: number;
  field: string;
  suffix?: string;
  currentCategory?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [localValue, setLocalValue] = useState(String(value ?? ""));
  const { toast } = useToast();

  const saveMutation = useMutation({
    mutationFn: async (newValue: number | null) => {
      const payload: Record<string, any> = { [field]: newValue };
      if (field === "intervalDays" && newValue !== null) {
        payload.category = categoryFromInterval(newValue);
      }
      const res = await apiRequest("PATCH", `/api/wellness/activities/${activityId}`, payload);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      if (data?._warning) {
        toast({ title: "Window cleared", description: "Please reconfigure for the new frequency." });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
      setLocalValue(String(value ?? ""));
    },
  });

  const commitEdit = useCallback(() => {
    setEditing(false);
    const parsed = localValue ? parseInt(localValue, 10) : null;
    if (parsed !== value) {
      saveMutation.mutate(parsed);
    }
  }, [localValue, value, field]);

  if (editing) {
    return (
      <input
        className="w-48"
        type="number"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitEdit();
          if (e.key === "Escape") { setLocalValue(String(value ?? "")); setEditing(false); }
        }}
        autoFocus
      />
    );
  }

  const display = value != null ? `${value}${suffix ?? ""}` : "—";
  return (
    <span
      className="block w-full cursor-pointer truncate rounded px-1 py-0.5 text-right text-xs transition-colors hover:bg-muted/50"
      onClick={() => { setEditing(true); setLocalValue(String(value ?? "")); }}
      title="Click to edit"
    >
      {display}
    </span>
  );
}

// --- Main detail view ---

export function ActivityDetailView({
  activity,
  onBack,
  onDelete,
}: {
  activity: ActivityWithStatus;
  onBack: () => void;
  onDelete: (id: number) => void;
}) {
  const { toast } = useToast();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/wellness/activities/${activity.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/pulse-buckets"] });
      setShowDeleteDialog(false);
      toast({ title: "Activity deleted" });
      onDelete(activity.id);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="flex flex-col h-full">
      {/* Mobile back button */}
      <div className="flex items-center gap-2 p-2 border-b @md:hidden">
        <Button size="icon" variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium truncate">{activity.name}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Properties */}
        <div className="border-b p-4">
          <div className="overflow-hidden rounded-md border border-border/20">
            <ProfileTreeRow label="Name" hasValue={Boolean(activity.name)} showEmpty mobileLayout="inline" testId="row-wellness-name">
              <DetailEditableText value={activity.name} activityId={activity.id} field="name" placeholder="Activity name" />
            </ProfileTreeRow>
            <ProfileTreeRow label="Benefit" hasValue={Boolean(activity.benefit)} showEmpty mobileLayout="inline" testId="row-wellness-benefit">
              <DetailEditableText value={activity.benefit ?? ""} activityId={activity.id} field="benefit" placeholder="Why this matters" multiline />
            </ProfileTreeRow>
            <ProfileTreeRow label="Risk" hasValue={Boolean(activity.risk)} showEmpty mobileLayout="inline" testId="row-wellness-risk">
              <DetailEditableText value={activity.risk ?? ""} activityId={activity.id} field="risk" placeholder="Risk if skipped" multiline />
            </ProfileTreeRow>
            <ProfileTreeRow label="Frequency" hasValue showEmpty mobileLayout="inline" testId="row-wellness-frequency">
              <div className="flex min-w-0 items-center justify-end gap-2">
                <DetailEditableNumber value={activity.intervalDays} activityId={activity.id} field="intervalDays" suffix=" days" currentCategory={activity.category} />
                <Badge variant="outline" className="shrink-0 text-xs">{CATEGORY_LABELS[activity.category] ?? activity.category}</Badge>
              </div>
            </ProfileTreeRow>
            {activity.linkedMetricType && (
              <ProfileTreeRow label="Linked metric" hasValue showEmpty mobileLayout="inline" testId="row-wellness-linked-metric">
                <span className="truncate text-muted-foreground">
                  {activity.linkedMetricType}
                  {activity.goodThreshold != null && ` · Good ≥${activity.goodThreshold}`}
                  {activity.greatThreshold != null && ` · Great ≥${activity.greatThreshold}`}
                </span>
              </ProfileTreeRow>
            )}
            <ProfileTreeRow label="Window" hasValue showEmpty mobileLayout="inline" testId="row-wellness-window">
              <WindowEditor activityId={activity.id} category={activity.category} windowStart={activity.windowStart} windowEnd={activity.windowEnd} inWindow={activity.inWindow} />
            </ProfileTreeRow>
          </div>
        </div>

        <div className="p-4">
          <ActivityDetailPanel
            activityId={activity.id}
            intervalDays={activity.intervalDays}
            metricInfo={{
              linkedMetricType: activity.linkedMetricType,
              goodThreshold: activity.goodThreshold,
              greatThreshold: activity.greatThreshold,
            }}
          />
        </div>

        {/* Delete */}
        <div className="p-4 border-t">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={deleteMutation.isPending}
            onClick={() => setShowDeleteDialog(true)}
          >
            {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}
            Delete activity
          </Button>
          <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete "{activity.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes the activity and its history. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={deleteMutation.isPending}
                  onClick={(e) => {
                    e.preventDefault();
                    deleteMutation.mutate();
                  }}
                >
                  {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}
