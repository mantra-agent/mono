// ActivityDetailView — right panel for the list/detail split
// This is a new component that shows editable properties + embeds ActivityDetailPanel for trends/history

import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Trash2, Loader2 } from "lucide-react";
import { useState, useCallback, useRef, useEffect } from "react";
import { ActivityDetailPanel } from "./activity-detail-panel";
import { WindowEditor } from "./window-editor";

// --- Types (shared with calendar-content) ---

type ActivityPulse = "good" | "okay" | "danger" | "never_done";

interface ActivityWithStatus {
  id: number;
  name: string;
  benefit: string | null;
  risk: string | null;
  estimatedMinutes: number | null;
  estimatedCost: number | null;
  intervalDays: number;
  requirements: string | null;
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
          className="bg-transparent border border-border rounded px-2 py-1 outline-none text-sm w-full min-h-[60px] resize-y"
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
        className="bg-transparent border border-border rounded px-2 py-1 outline-none text-sm w-full"
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
      className="cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5 -mx-1 transition-colors text-sm"
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
    const parsed = localValue ? (field === "estimatedCost" ? parseFloat(localValue) : parseInt(localValue, 10)) : null;
    if (parsed !== value) {
      saveMutation.mutate(parsed);
    }
  }, [localValue, value, field]);

  if (editing) {
    return (
      <input
        className="bg-transparent border border-border rounded px-2 py-1 outline-none text-sm w-20"
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
      className="cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5 -mx-1 transition-colors text-sm"
      onClick={() => { setEditing(true); setLocalValue(String(value ?? "")); }}
      title="Click to edit"
    >
      {display}
    </span>
  );
}

// --- Property row ---

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground w-24 shrink-0 pt-0.5">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
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

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/wellness/activities/${activity.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/pulse-buckets"] });
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
        {/* Header */}
        <div className="p-4 border-b">
          <div className="flex items-center gap-2">
            <DetailEditableText
              value={activity.name}
              activityId={activity.id}
              field="name"
              placeholder="Activity name"
            />
            <Badge variant="outline" className="shrink-0 text-xs">
              {CATEGORY_LABELS[activity.category] ?? activity.category}
            </Badge>
          </div>
        </div>

        {/* Properties */}
        <div className="p-4 border-b space-y-0">
          <PropRow label="Benefit">
            <DetailEditableText
              value={activity.benefit ?? ""}
              activityId={activity.id}
              field="benefit"
              placeholder="Why this matters"
              multiline
            />
          </PropRow>
          <PropRow label="Risk">
            <DetailEditableText
              value={activity.risk ?? ""}
              activityId={activity.id}
              field="risk"
              placeholder="Risk if skipped"
              multiline
            />
          </PropRow>
          <PropRow label="Frequency">
            <DetailEditableNumber
              value={activity.intervalDays}
              activityId={activity.id}
              field="intervalDays"
              suffix=" days"
              currentCategory={activity.category}
            />
          </PropRow>
          <PropRow label="Est. time">
            <DetailEditableNumber
              value={activity.estimatedMinutes}
              activityId={activity.id}
              field="estimatedMinutes"
              suffix=" min"
            />
          </PropRow>
          <PropRow label="Est. cost">
            <DetailEditableNumber
              value={activity.estimatedCost}
              activityId={activity.id}
              field="estimatedCost"
              suffix=""
            />
          </PropRow>
          <PropRow label="Requirements">
            <DetailEditableText
              value={activity.requirements ?? ""}
              activityId={activity.id}
              field="requirements"
              placeholder="Equipment, prerequisites"
            />
          </PropRow>
          {activity.linkedMetricType && (
            <PropRow label="Linked metric">
              <span className="text-sm text-muted-foreground">
                {activity.linkedMetricType}
                {activity.goodThreshold != null && ` · Good ≥${activity.goodThreshold}`}
                {activity.greatThreshold != null && ` · Great ≥${activity.greatThreshold}`}
              </span>
            </PropRow>
          )}

          <PropRow label="Window">
            <WindowEditor
              activityId={activity.id}
              category={activity.category}
              windowStart={activity.windowStart}
              windowEnd={activity.windowEnd}
              inWindow={activity.inWindow}
            />
          </PropRow>
        </div>

        {/* Trends & History */}
        <div className="p-4">
          <h4 className="text-sm font-medium mb-2">Trends & History</h4>
          <ActivityDetailPanel
            activityId={activity.id}
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
            onClick={() => {
              toast({
                title: `Delete "${activity.name}"?`,
                description: "This cannot be undone.",
                action: (
                  <Button variant="destructive" size="sm" onClick={() => deleteMutation.mutate()}>
                    Delete
                  </Button>
                ),
              });
            }}
          >
            {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}
            Delete activity
          </Button>
        </div>
      </div>
    </div>
  );
}
