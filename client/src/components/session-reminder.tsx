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

interface SessionReminderMenuItemProps {
  sessionId: string;
  sessionTitle?: string | null;
  onOpenChange?: (open: boolean) => void;
  onReminderSet?: (sessionId: string) => void;
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
  const now = Date.now();
  const diff = d.getTime() - now;

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
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildReminderToastTitle(sessionId: string, timeLabel: string): string {
  return `Reminder set for @session:${sessionId} ${timeLabel}`;
}

interface SetReminderInput {
  fireAt?: string;
  nextBoot?: boolean;
  nextBuild?: boolean;
  toastTimeLabel: string;
}

export function SessionReminderPopover({ sessionId, sessionTitle, onOpenChange, onReminderSet }: SessionReminderMenuItemProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customDate, setCustomDate] = useState<Date | undefined>();
  const [customTime, setCustomTime] = useState("09:00");

  const { data: reminder, isLoading } = useQuery<ReminderState>({
    queryKey: ["/api/sessions", sessionId, "reminder"],
    enabled: open,
  });

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const setReminderMutation = useMutation({
    mutationFn: async ({ toastTimeLabel: _toastTimeLabel, ...payload }: SetReminderInput) => {
      await apiRequest("POST", `/api/sessions/${sessionId}/reminder`, payload);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId, "reminder"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      toast({ title: buildReminderToastTitle(sessionId, variables.toastTimeLabel) });
      setOpen(false);
      setShowCustom(false);
      onReminderSet?.(sessionId);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to set reminder", description: error.message, variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/sessions/${sessionId}/reminder`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId, "reminder"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      toast({ title: "Reminder cancelled" });
      setOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to cancel reminder", description: error.message, variant: "destructive" });
    },
  });

  const handlePreset = (getTime: () => number, label: string) => {
    setReminderMutation.mutate({ fireAt: new Date(getTime()).toISOString(), toastTimeLabel: label });
  };

  const handleNextBuild = () => {
    setReminderMutation.mutate({ nextBuild: true, toastTimeLabel: "Next Build" });
  };

  const handleCustomSubmit = () => {
    if (!customDate || !customTime) return;
    const [hours, minutes] = customTime.split(":").map(Number);
    const dt = new Date(customDate);
    dt.setHours(hours, minutes, 0, 0);
    if (isNaN(dt.getTime()) || dt.getTime() <= Date.now()) {
      toast({ title: "Please select a future date and time", variant: "destructive" });
      return;
    }
    setReminderMutation.mutate({ fireAt: dt.toISOString(), toastTimeLabel: formatToastDateTime(dt) });
  };

  const renderNextBuildOption = () => (
    <button
      className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent transition-colors flex items-center gap-2"
      onClick={(e) => {
        e.stopPropagation();
        handleNextBuild();
      }}
      disabled={isPending}
      data-testid="button-preset-next-build"
    >
      <Hammer className="h-3 w-3" />
      Next build
    </button>
  );

  const renderPresetOptions = () => (
    <>
      {getPresetOptions().map((opt) => (
        <button
          key={opt.label}
          className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            handlePreset(opt.getTime, opt.label);
          }}
          disabled={isPending}
          data-testid={`button-preset-${opt.label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {opt.label}
        </button>
      ))}
    </>
  );

  const renderCustomOption = () => (
    <div className="space-y-2">
      <button
        className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent transition-colors flex items-center gap-2"
        onClick={(e) => {
          e.stopPropagation();
          setShowCustom(!showCustom);
        }}
        disabled={isPending}
        data-testid="button-preset-custom"
      >
        <CalendarIcon className="h-3 w-3" />
        Custom
      </button>
      {showCustom && (
        <div
          className="space-y-2 rounded-md border bg-background p-2"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Calendar
            mode="single"
            selected={customDate}
            onSelect={setCustomDate}
            disabled={{ before: new Date() }}
            initialFocus
            className="p-0"
            classNames={{
              months: "flex flex-col",
              month: "space-y-2",
              caption: "flex justify-center pt-1 relative items-center",
              table: "w-full border-collapse",
              row: "flex w-full mt-1",
              cell: "h-7 w-7 text-center text-xs p-0 relative",
              head_cell: "text-muted-foreground rounded-md w-7 font-normal text-[0.7rem]",
              day: "h-7 w-7 p-0 font-normal text-xs aria-selected:opacity-100",
            }}
            data-testid="calendar-reminder-date"
          />
          <div className="flex items-center gap-2">
            <Input
              type="time"
              value={customTime}
              onChange={(e) => setCustomTime(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="h-8 text-xs"
              data-testid="input-reminder-time"
            />
            <Button
              size="sm"
              className="text-xs"
              onClick={(e) => {
                e.stopPropagation();
                handleCustomSubmit();
              }}
              disabled={isPending || !customDate || !customTime}
              data-testid="button-set-custom-reminder"
            >
              <Check className="h-3 w-3 mr-1" />
              Set
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  const isPending = setReminderMutation.isPending || cancelMutation.isPending;

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger
        data-testid={`menuitem-reminder-${sessionId}`}
      >
        <Clock className="h-3.5 w-3.5 mr-2" />
        Reminder
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64 p-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-4 text-sm text-muted-foreground" data-testid="reminder-loading">
            Loading...
          </div>
        ) : reminder?.active && (reminder.fireAt || reminder.nextBoot || reminder.nextBuild) ? (
          <div className="space-y-2">
            <div className="text-sm font-medium px-2 pt-1" data-testid="reminder-active-label">
              Reminder set
            </div>
            <div className="text-xs text-muted-foreground px-2" data-testid="reminder-active-time">
              {reminder.nextBuild ? "Fires next time a new build boots" : reminder.nextBoot ? "Fires next time the app starts" : `Fires ${formatReminderTime(reminder.fireAt!)}`}
            </div>
            <div className="flex gap-1 px-2 pb-1">
              <Button
                size="sm"
                variant="outline"
                className="flex-1 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowCustom(false);
                  cancelMutation.mutate();
                }}
                disabled={isPending}
                data-testid="button-cancel-reminder"
              >
                <X className="h-3 w-3 mr-1" />
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowCustom(!showCustom);
                }}
                disabled={isPending}
                data-testid="button-reschedule-reminder"
              >
                <Clock className="h-3 w-3 mr-1" />
                Reschedule
              </Button>
            </div>
            {showCustom && (
              <div className="border-t pt-2 space-y-1">
                {renderNextBuildOption()}
                {renderPresetOptions()}
                {renderCustomOption()}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {renderNextBuildOption()}
            {renderPresetOptions()}
            {renderCustomOption()}
          </div>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
