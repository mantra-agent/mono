// WindowEditor — category-aware window start/end selector for wellness activities
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

interface WindowEditorProps {
  activityId: number;
  category: string;
  windowStart: number | null;
  windowEnd: number | null;
  inWindow: boolean;
}

// --- Option generators per category ---

function hourOptions(): { value: number; label: string }[] {
  const opts: { value: number; label: string }[] = [];
  for (let h = 0; h <= 23; h++) {
    let label: string;
    if (h === 0) label = "12:00 AM";
    else if (h === 12) label = "12:00 PM";
    else if (h < 12) label = `${h}:00 AM`;
    else label = `${h - 12}:00 PM`;
    opts.push({ value: h, label });
  }
  return opts;
}

const DAY_OPTIONS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

function dayOfMonthOptions(): { value: number; label: string }[] {
  return Array.from({ length: 28 }, (_, i) => ({
    value: i + 1,
    label: `Day ${i + 1}`,
  }));
}

const QUARTER_MONTH_OPTIONS = [
  { value: 1, label: "Month 1" },
  { value: 2, label: "Month 2" },
  { value: 3, label: "Month 3" },
];

const MONTH_OPTIONS = [
  { value: 1, label: "Jan" },
  { value: 2, label: "Feb" },
  { value: 3, label: "Mar" },
  { value: 4, label: "Apr" },
  { value: 5, label: "May" },
  { value: 6, label: "Jun" },
  { value: 7, label: "Jul" },
  { value: 8, label: "Aug" },
  { value: 9, label: "Sep" },
  { value: 10, label: "Oct" },
  { value: 11, label: "Nov" },
  { value: 12, label: "Dec" },
];

function getOptionsForCategory(category: string): { value: number; label: string }[] {
  switch (category) {
    case "daily_practice": return hourOptions();
    case "weekly_ritual": return DAY_OPTIONS;
    case "monthly_renewal": return dayOfMonthOptions();
    case "quarterly_reset": return QUARTER_MONTH_OPTIONS;
    case "annual_checkup": return MONTH_OPTIONS;
    default: return [];
  }
}

function getDefaultsForCategory(category: string): { start: number; end: number } {
  switch (category) {
    case "daily_practice": return { start: 6, end: 22 }; // 6 AM - 10 PM
    case "weekly_ritual": return { start: 1, end: 5 }; // Mon - Fri
    case "monthly_renewal": return { start: 1, end: 15 }; // Day 1 - 15
    case "quarterly_reset": return { start: 1, end: 2 }; // Month 1 - 2
    case "annual_checkup": return { start: 1, end: 6 }; // Jan - Jun
    default: return { start: 1, end: 1 };
  }
}

export function WindowEditor({ activityId, category, windowStart, windowEnd, inWindow }: WindowEditorProps) {
  const { toast } = useToast();
  const options = getOptionsForCategory(category);
  const [localWindow, setLocalWindow] = useState({ start: windowStart, end: windowEnd });
  const hasWindow = localWindow.start != null && localWindow.end != null;

  useEffect(() => {
    setLocalWindow({ start: windowStart, end: windowEnd });
  }, [windowStart, windowEnd]);

  const saveMutation = useMutation({
    mutationFn: async (payload: { windowStart: number | null; windowEnd: number | null }) => {
      await apiRequest("PATCH", `/api/wellness/activities/${activityId}`, payload);
    },
    onSuccess: (_data, payload) => {
      setLocalWindow({ start: payload.windowStart, end: payload.windowEnd });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleChange = (field: "windowStart" | "windowEnd", value: number) => {
    const payload = {
      windowStart: field === "windowStart" ? value : localWindow.start,
      windowEnd: field === "windowEnd" ? value : localWindow.end,
    };
    saveMutation.mutate(payload);
  };

  const handleClear = () => {
    saveMutation.mutate({ windowStart: null, windowEnd: null });
  };

  const handleSetDefault = () => {
    const defaults = getDefaultsForCategory(category);
    saveMutation.mutate({ windowStart: defaults.start, windowEnd: defaults.end });
  };

  if (!hasWindow) {
    return (
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={handleSetDefault}
          disabled={saveMutation.isPending}
          className="min-h-11 whitespace-nowrap text-sm text-cta hover:text-active disabled:opacity-50"
        >
          {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Set"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <select
          className="bg-background border border-border rounded px-1.5 py-0.5 text-sm outline-none min-w-0"
          value={localWindow.start ?? ""}
          onChange={(e) => handleChange("windowStart", parseInt(e.target.value, 10))}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">to</span>
        <select
          className="bg-background border border-border rounded px-1.5 py-0.5 text-sm outline-none min-w-0"
          value={localWindow.end ?? ""}
          onChange={(e) => handleChange("windowEnd", parseInt(e.target.value, 10))}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          onClick={handleClear}
          className="text-xs text-muted-foreground hover:text-foreground ml-1"
          title="Clear window"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {inWindow ? (
          <>
            <Check className="h-3 w-3 text-success" />
            <span>In window now</span>
          </>
        ) : (
          <span>Outside window</span>
        )}
      </div>
    </div>
  );
}
