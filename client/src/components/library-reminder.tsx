import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { CalendarIcon, Clock, X, Check, Hammer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";

interface ReminderState {
  active: boolean;
  timerId?: string;
  fireAt?: string | null;
  nextBoot?: boolean;
  nextBuild?: boolean;
}

interface ReminderPopoverProps {
  title?: string | null;
  queryKey?: unknown[];
  getUrl?: string;
  postUrl?: string;
  postMethod?: "POST" | "PATCH";
  deleteUrl?: string;
  buildPayload?: (input: { fireAt?: string; nextBuild?: boolean }) => Record<string, unknown>;
  invalidateKeys?: unknown[][];
  allowNextBuild?: boolean;
  onOpenChange?: (open: boolean) => void;
  onReminderSet?: () => void;
  /** When provided, bypasses internal mutation and calls this with the selected ISO date string instead. */
  onSelect?: (fireAt: string) => void;
}

interface LibraryReminderPopoverProps {
  pageId: string;
  pageTitle?: string | null;
  onOpenChange?: (open: boolean) => void;
  onReminderSet?: () => void;
}

function getPresetOptions() {
  return [
    { label: "In 15 minutes", getTime: () => Date.now() + 15 * 60 * 1000 },
    { label: "In 1 hour", getTime: () => Date.now() + 60 * 60 * 1000 },
    { label: "In 3 hours", getTime: () => Date.now() + 3 * 60 * 60 * 1000 },
    { label: "Tomorrow morning", getTime: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }},
    { label: "In Two Days", getTime: () => {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }},
    { label: "Next Week", getTime: () => {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }},
    { label: "In Two Weeks", getTime: () => {
      const d = new Date();
      d.setDate(d.getDate() + 14);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }},
    { label: "Next Month", getTime: () => {
      const d = new Date();
      d.setMonth(d.getMonth() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }},
  ];
}

function formatReminderTime(fireAt: string): string {
  const d = new Date(fireAt);
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return "any moment";
  if (diff < 60 * 1000) return "less than a minute";
  if (diff < 60 * 60 * 1000) {
    const mins = Math.round(diff / 60000);
    return `in ${mins} minute${mins !== 1 ? "s" : ""}`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const hrs = Math.round(diff / 3600000);
    return `in ${hrs} hour${hrs !== 1 ? "s" : ""}`;
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatToastDateTime(date: Date): string {
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function buildReminderToastTitle(title: string | null | undefined, timeLabel: string): string {
  const reminderName = title?.trim() || "this item";
  return `Reminder set '${reminderName}' ${timeLabel}`;
}

interface SetReminderInput {
  fireAt?: string;
  nextBuild?: boolean;
  toastTimeLabel: string;
}

export function ReminderPopover({ title, queryKey, getUrl, postUrl, postMethod = "POST", deleteUrl, buildPayload, invalidateKeys = [], allowNextBuild = true, onOpenChange, onReminderSet, onSelect }: ReminderPopoverProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customDate, setCustomDate] = useState<Date | undefined>();
  const [customTime, setCustomTime] = useState("09:00");

  const { data: reminder, isLoading } = useQuery<ReminderState>({
    queryKey: queryKey ?? [postUrl, "reminder"],
    enabled: open && Boolean(getUrl),
    queryFn: async () => {
      const res = await apiRequest("GET", getUrl!);
      return await res.json();
    },
  });

  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

  const setReminderMutation = useMutation({
    mutationFn: async ({ toastTimeLabel: _toastTimeLabel, ...input }: SetReminderInput) => {
      const payload = buildPayload ? buildPayload(input) : input;
      await apiRequest(postMethod, postUrl, payload);
    },
    onSuccess: (_data, variables) => {
      for (const key of invalidateKeys) queryClient.invalidateQueries({ queryKey: key });
      if (queryKey) queryClient.invalidateQueries({ queryKey });
      toast({ title: buildReminderToastTitle(title, variables.toastTimeLabel) });
      setOpen(false);
      setShowCustom(false);
      onReminderSet?.();
    },
    onError: (error: Error) => toast({ title: "Failed to set reminder", description: error.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!deleteUrl) throw new Error("This reminder cannot be cancelled here");
      await apiRequest("DELETE", deleteUrl);
    },
    onSuccess: () => {
      for (const key of invalidateKeys) queryClient.invalidateQueries({ queryKey: key });
      if (queryKey) queryClient.invalidateQueries({ queryKey });
      toast({ title: "Reminder cancelled" });
      setOpen(false);
    },
    onError: (error: Error) => toast({ title: "Failed to cancel reminder", description: error.message, variant: "destructive" }),
  });

  const handlePreset = (getTime: () => number, label: string) => {
    const fireAt = new Date(getTime()).toISOString();
    if (onSelect) { onSelect(fireAt); setOpen(false); onReminderSet?.(); return; }
    setReminderMutation.mutate({ fireAt, toastTimeLabel: label });
  };
  const handleNextBuild = () => setReminderMutation.mutate({ nextBuild: true, toastTimeLabel: "Next Build" });

  const handleCustomSubmit = () => {
    if (!customDate || !customTime) return;
    const [hours, minutes] = customTime.split(":").map(Number);
    const dt = new Date(customDate);
    dt.setHours(hours, minutes, 0, 0);
    if (isNaN(dt.getTime()) || dt.getTime() <= Date.now()) {
      toast({ title: "Please select a future date and time", variant: "destructive" });
      return;
    }
    const fireAt = dt.toISOString();
    if (onSelect) { onSelect(fireAt); setOpen(false); setShowCustom(false); onReminderSet?.(); return; }
    setReminderMutation.mutate({ fireAt, toastTimeLabel: formatToastDateTime(dt) });
  };

  const isPending = setReminderMutation.isPending || cancelMutation.isPending;

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger>
        <Clock className="h-3.5 w-3.5 mr-2" />
        Reminder
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64 p-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-4 text-sm text-muted-foreground">Loading...</div>
        ) : deleteUrl && reminder?.active && (reminder.fireAt || reminder.nextBoot || reminder.nextBuild) ? (
          <div className="space-y-2">
            <div className="text-sm font-medium px-2 pt-1">Reminder set</div>
            <div className="text-xs text-muted-foreground px-2">
              {reminder.nextBuild ? "Will remind on next new build" : reminder.nextBoot ? "Will remind on next boot" : reminder.fireAt ? `Coming back ${formatReminderTime(reminder.fireAt)}` : "Active"}
            </div>
            <button className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-destructive/10 text-destructive transition-colors flex items-center gap-2" onClick={(e) => { e.stopPropagation(); cancelMutation.mutate(); }} disabled={isPending}>
              <X className="h-3 w-3" />
              Cancel reminder
            </button>
          </div>
        ) : (
          <div className="space-y-0.5">
            {getPresetOptions().map(opt => (
              <button key={opt.label} className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent transition-colors" onClick={(e) => { e.stopPropagation(); handlePreset(opt.getTime, opt.label); }} disabled={isPending}>
                {opt.label}
              </button>
            ))}
            <div className="border-t border-border/30 my-1" />
            {allowNextBuild && (
              <button className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent transition-colors flex items-center gap-2" onClick={(e) => { e.stopPropagation(); handleNextBuild(); }} disabled={isPending}>
                <Hammer className="h-3 w-3" />
                Next build
              </button>
            )}
            <div className="space-y-2">
              <button className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent transition-colors flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setShowCustom(!showCustom); }} disabled={isPending}>
                <CalendarIcon className="h-3 w-3" />
                Custom
              </button>
              {showCustom && (
                <div className="space-y-2 rounded-md border bg-background p-2" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                  <Calendar mode="single" selected={customDate} onSelect={setCustomDate} disabled={{ before: new Date() }} initialFocus className="p-0" />
                  <div className="flex items-center gap-2">
                    <Input type="time" value={customTime} onChange={(e) => setCustomTime(e.target.value)} onClick={(e) => e.stopPropagation()} className="h-8 text-xs" />
                    <Button size="sm" className="text-xs" onClick={(e) => { e.stopPropagation(); handleCustomSubmit(); }} disabled={isPending || !customDate || !customTime}>
                      <Check className="h-3 w-3 mr-1" />
                      Set
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function LibraryReminderPopover({ pageId, pageTitle, onOpenChange, onReminderSet }: LibraryReminderPopoverProps) {
  return (
    <ReminderPopover
      title={pageTitle}
      queryKey={["/api/info/library", pageId, "reminder"]}
      getUrl={`/api/info/library/${pageId}/reminder`}
      postUrl={`/api/info/library/${pageId}/reminder`}
      deleteUrl={`/api/info/library/${pageId}/reminder`}
      invalidateKeys={[["/api/info/library"]]}
      onOpenChange={onOpenChange}
      onReminderSet={onReminderSet}
    />
  );
}
