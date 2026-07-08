// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useEffect, useRef, useMemo } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useIsMobile } from "@/hooks/use-mobile";
import { getInstanceName, isAgentType } from "@/lib/instance-config";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import type {
  Schedule,
  ScheduleFrequency,
  DayOfWeek,
  TimerType,
  TimerRunStatus,
  TimerRun,
  TimerWithNextRun,
} from "@shared/models/timers";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Play,
  Pause,
  Clock,
  Bot,
  User,
  Settings,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  AlertCircle,
  SkipForward,
  ExternalLink,
  Timer,
  Zap,
  TrendingUp,
  X,
  Cpu,
  Download,
  Upload,
  MoreVertical,
  Bell,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";

const log = createLogger("Timers");

type TimerItem = TimerWithNextRun;


const DAYS: { value: DayOfWeek; label: string; short: string }[] = [
  { value: "mon", label: "Monday", short: "Mon" },
  { value: "tue", label: "Tuesday", short: "Tue" },
  { value: "wed", label: "Wednesday", short: "Wed" },
  { value: "thu", label: "Thursday", short: "Thu" },
  { value: "fri", label: "Friday", short: "Fri" },
  { value: "sat", label: "Saturday", short: "Sat" },
  { value: "sun", label: "Sunday", short: "Sun" },
];

const TYPE_META: Record<TimerType, { label: string; icon: typeof Bot; color: string }> = {
  agent: { label: getInstanceName(), icon: Bot, color: "text-info" },
  system: { label: "System", icon: Settings, color: "text-warning" },
  me: { label: "Me", icon: User, color: "text-success" },
  skill: { label: "Skill", icon: Cpu, color: "text-cat-ai" },
  reminder: { label: "Reminder", icon: Bell, color: "text-cat-event" },
};

const STATUS_META: Record<TimerRunStatus, { label: string; icon: typeof CheckCircle2; color: string }> = {
  pending: { label: "Pending", icon: Clock, color: "text-muted-foreground" },
  running: { label: "Running", icon: Loader2, color: "text-info" },
  success: { label: "Success", icon: CheckCircle2, color: "text-success" },
  error: { label: "Error", icon: AlertCircle, color: "text-error" },
  skipped: { label: "Skipped", icon: SkipForward, color: "text-muted-foreground" },
  deferred: { label: "Deferred", icon: Clock, color: "text-warning" },
  degraded: { label: "Degraded", icon: AlertCircle, color: "text-warning" },
};

function generateScheduleId(): string {
  return "s-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function humanizeSchedule(schedule: Schedule): string {
  switch (schedule.frequency) {
    case "every_x_minutes":
      return `Every ${schedule.interval || 30} min`;
    case "every_x_hours":
      return `Every ${schedule.interval || 1}h`;
    case "daily":
      return `Daily at ${schedule.timeOfDay || "09:00"}`;
    case "weekly": {
      const days = (schedule.daysOfWeek || ["mon"]).map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(", ");
      return `${days} at ${schedule.timeOfDay || "09:00"}`;
    }
    case "monthly":
      return `Monthly, day ${schedule.dayOfMonth || 1} at ${schedule.timeOfDay || "09:00"}`;
    case "quarterly":
      return `Quarterly at ${schedule.timeOfDay || "09:00"}`;
    case "annually":
      return `Annually, day ${schedule.dayOfYear || 1} at ${schedule.timeOfDay || "09:00"}`;
    case "once": {
      if (!schedule.fireAt) return "Once (no time set)";
      const d = new Date(schedule.fireAt);
      return `Once at ${d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}`;
    }
    case "custom":
      return schedule.cronExpression || "Custom";
    default:
      return "Unknown";
  }
}

function humanizeNextRun(nextRunAt: string): string {
  const diff = new Date(nextRunAt).getTime() - Date.now();
  if (diff <= 0) return "Now";
  if (diff < 60000) return "< 1 min";
  if (diff < 3600000) {
    const mins = Math.ceil(diff / 60000);
    return `${mins}m`;
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    const mins = Math.ceil((diff % 3600000) / 60000);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(diff / 86400000);
  return `${days}d`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function ScheduleEditor({ schedules, onChange }: { schedules: Schedule[]; onChange: (s: Schedule[]) => void }) {
  const addSchedule = () => {
    onChange([...schedules, { id: generateScheduleId(), frequency: "daily", timeOfDay: "09:00" }]);
  };

  const updateSchedule = (idx: number, updates: Partial<Schedule>) => {
    const updated = [...schedules];
    updated[idx] = { ...updated[idx], ...updates };
    onChange(updated);
  };

  const removeSchedule = (idx: number) => {
    onChange(schedules.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Schedules</Label>
        <Button variant="ghost" size="sm" onClick={addSchedule} data-testid="button-add-schedule">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add
        </Button>
      </div>

      {schedules.length === 0 && (
        <p className="text-sm text-muted-foreground py-2">No schedules yet. Add one to define when this runs.</p>
      )}

      {schedules.map((schedule, idx) => (
        <Card key={schedule.id} className="border-dashed">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Select
                value={schedule.frequency}
                onValueChange={(v) => updateSchedule(idx, { frequency: v as ScheduleFrequency })}
              >
                <SelectTrigger className="flex-1 h-8 text-sm" data-testid={`select-frequency-${idx}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="every_x_minutes">Every X Minutes</SelectItem>
                  <SelectItem value="every_x_hours">Every X Hours</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="annually">Annually</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => removeSchedule(idx)} data-testid={`button-remove-schedule-${idx}`}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            {(schedule.frequency === "every_x_minutes" || schedule.frequency === "every_x_hours") && (
              <div className="flex items-center gap-2">
                <Label className="text-xs shrink-0">Every</Label>
                <Input
                  type="number"
                  min={1}
                  className="h-7 text-sm w-20"
                  value={schedule.interval || (schedule.frequency === "every_x_minutes" ? 30 : 1)}
                  onChange={(e) => updateSchedule(idx, { interval: parseInt(e.target.value, 10) || 1 })}
                  data-testid={`input-interval-${idx}`}
                />
                <span className="text-xs text-muted-foreground">
                  {schedule.frequency === "every_x_minutes" ? "minutes" : "hours"}
                </span>
              </div>
            )}

            {["daily", "weekly", "monthly", "quarterly", "annually"].includes(schedule.frequency) && (
              <div className="flex items-center gap-2">
                <Label className="text-xs shrink-0">Time</Label>
                <Input
                  type="time"
                  className="h-7 text-sm w-28"
                  value={schedule.timeOfDay || "09:00"}
                  onChange={(e) => updateSchedule(idx, { timeOfDay: e.target.value })}
                  data-testid={`input-time-${idx}`}
                />
              </div>
            )}

            {schedule.frequency === "weekly" && (
              <div className="flex flex-wrap gap-1">
                {DAYS.map((day) => {
                  const selected = (schedule.daysOfWeek || []).includes(day.value);
                  return (
                    <button
                      key={day.value}
                      className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                        selected
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-transparent text-muted-foreground border-border hover:border-primary/50"
                      }`}
                      onClick={() => {
                        const current = schedule.daysOfWeek || [];
                        const updated = selected
                          ? current.filter((d) => d !== day.value)
                          : [...current, day.value];
                        updateSchedule(idx, { daysOfWeek: updated.length > 0 ? updated : ["mon"] });
                      }}
                      data-testid={`button-day-${day.value}-${idx}`}
                    >
                      {day.short}
                    </button>
                  );
                })}
              </div>
            )}

            {schedule.frequency === "monthly" && (
              <div className="flex items-center gap-2">
                <Label className="text-xs shrink-0">Day of month</Label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  className="h-7 text-sm w-16"
                  value={schedule.dayOfMonth || 1}
                  onChange={(e) => updateSchedule(idx, { dayOfMonth: parseInt(e.target.value, 10) || 1 })}
                  data-testid={`input-day-of-month-${idx}`}
                />
              </div>
            )}

            {schedule.frequency === "annually" && (
              <div className="flex items-center gap-2">
                <Label className="text-xs shrink-0">Day of year</Label>
                <Input
                  type="number"
                  min={1}
                  max={366}
                  className="h-7 text-sm w-16"
                  value={schedule.dayOfYear || 1}
                  onChange={(e) => updateSchedule(idx, { dayOfYear: parseInt(e.target.value, 10) || 1 })}
                  data-testid={`input-day-of-year-${idx}`}
                />
              </div>
            )}

            {schedule.frequency === "custom" && (
              <div className="flex items-center gap-2">
                <Label className="text-xs shrink-0">Cron</Label>
                <Input
                  className="h-7 text-sm flex-1"
                  placeholder="0 9 * * *"
                  value={schedule.cronExpression || ""}
                  onChange={(e) => updateSchedule(idx, { cronExpression: e.target.value })}
                  data-testid={`input-cron-${idx}`}
                />
              </div>
            )}

            <div className="text-xs text-muted-foreground">{humanizeSchedule(schedule)}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function RunHistoryItem({ run }: { run: TimerRun }) {
  const meta = STATUS_META[run.status] || STATUS_META.pending;
  const Icon = meta.icon;
  const [, navigate] = useLocation();

  const hasLink = !!run.sessionId;

  const handleClick = () => {
    if (run.sessionId) {
      navigate(`/session?c=${encodeURIComponent(run.sessionId)}`);
    }
  };

  return (
    <div
      className={`flex items-center gap-2 py-1.5 px-2 rounded-md text-sm transition-colors ${hasLink ? "cursor-pointer hover:bg-muted" : "hover:bg-muted/50"}`}
      onClick={hasLink ? handleClick : undefined}
      role={hasLink ? "button" : undefined}
      tabIndex={hasLink ? 0 : undefined}
      onKeyDown={hasLink ? (e) => { if (e.key === "Enter" || e.key === " ") handleClick(); } : undefined}
      data-testid={`run-${run.id}`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.color} ${run.status === "running" ? "animate-spin" : ""}`} />
      <span className="text-muted-foreground text-xs shrink-0">
        {new Date(run.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}
      </span>
      {run.durationMs !== undefined && (
        <span className="text-xs text-muted-foreground">{formatDuration(run.durationMs)}</span>
      )}
      <Badge variant={run.trigger === "manual" ? "outline" : "secondary"} className="text-xs px-1 py-0 h-4">
        {run.trigger === "manual" ? "manual" : "auto"}
      </Badge>
      {run.error && (
        <span className="text-xs text-error truncate flex-1" title={run.error}>{run.error}</span>
      )}
      <div className="flex-1" />
      {hasLink && (
        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
      )}
    </div>
  );
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function TimerActions({
  timer,
  onToggle,
  onExport,
  onRunNow,
  onEdit,
  onDelete,
  globalPaused,
}: {
  timer: TimerItem;
  onToggle: (enabled: boolean) => void;
  onExport: () => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
  globalPaused: boolean;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div className="flex items-center gap-1 shrink-0">
        <Switch
          checked={timer.enabled}
          onCheckedChange={onToggle}
          className="scale-90"
          data-testid={`switch-enabled-${timer.id}`}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-11 w-11" data-testid={`button-timer-menu-${timer.id}`}>
              <MoreVertical className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onRunNow} disabled={globalPaused} data-testid={`menu-run-now-${timer.id}`}>
              <Zap className="h-3.5 w-3.5 mr-2" /> Run Now
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onEdit} data-testid={`menu-edit-${timer.id}`}>
              <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onExport} data-testid={`menu-export-${timer.id}`}>
              <Download className="h-3.5 w-3.5 mr-2" /> Export
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} className="text-destructive" data-testid={`menu-delete-${timer.id}`}>
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 shrink-0">
      <Switch
        checked={timer.enabled}
        onCheckedChange={onToggle}
        className="scale-75"
        data-testid={`switch-enabled-${timer.id}`}
      />
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onExport} title="Export" data-testid={`button-export-${timer.id}`}>
        <Download className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRunNow} disabled={globalPaused} data-testid={`button-run-now-${timer.id}`}>
        <Zap className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} data-testid={`button-edit-${timer.id}`}>
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onDelete} data-testid={`button-delete-${timer.id}`}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function TimerCard({
  timer,
  onEdit,
  onDelete,
  onToggle,
  onRunNow,
  onExport,
  globalPaused,
  skillNameMap,
}: {
  timer: TimerItem;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onExport: () => void;
  skillNameMap: Record<string, string>;
  globalPaused: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const typeMeta = TYPE_META[timer.type] || TYPE_META.agent;
  const TypeIcon = typeMeta.icon;
  const [, setNow] = useState(Date.now());

  useEffect(() => {
    if (!timer.nextRunAt) return;
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, [timer.nextRunAt]);

  const schedulesSummary = timer.schedules.map(humanizeSchedule).join(" · ") || "No schedule";

  const skillLabel = timer.type === "skill" && timer.skillId
    ? (skillNameMap[timer.skillId] || timer.skillId)
    : null;

  return (
    <Card className={`group transition-all duration-150 ${!timer.enabled || globalPaused ? "opacity-60" : ""}`} data-testid={`card-timer-${timer.id}`}>
      <CardContent className="p-3 @sm:p-4">
        <div className="flex items-start gap-2 @sm:gap-3">
          <button className="mt-0.5 shrink-0 text-muted-foreground" onClick={() => setExpanded(!expanded)} data-testid={`button-expand-${timer.id}`}>
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 @sm:gap-2 mb-1 flex-wrap">
              <TypeIcon className={`h-4 w-4 shrink-0 ${typeMeta.color}`} />
              <span className="font-medium text-sm truncate max-w-[150px] @sm:max-w-none" data-testid={`text-name-${timer.id}`}>{timer.name}</span>
              <span className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5">{typeMeta.label}</span>
              {skillLabel && (
                <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 text-cat-ai border-cat-ai/30 max-w-[120px] @sm:max-w-[200px] truncate">{skillLabel}</Badge>
              )}
            </div>

            <div className="flex items-center gap-2 @sm:gap-3 text-xs text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1 min-w-0">
                <Clock className="h-3 w-3 shrink-0" />
                <span className="truncate">{schedulesSummary}</span>
              </span>
              {timer.nextRunAt && timer.enabled && !globalPaused && (
                <span className="flex items-center gap-1">
                  <Timer className="h-3 w-3 shrink-0" />
                  {humanizeNextRun(timer.nextRunAt)}
                </span>
              )}
            </div>

            {timer.stats && timer.stats.totalRuns > 0 && (
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                {timer.stats.successCount > 0 && (
                  <span className="flex items-center gap-0.5 text-xs text-success">
                    <CheckCircle2 className="h-3 w-3" />{timer.stats.successCount}
                  </span>
                )}
                {timer.stats.errorCount > 0 && (
                  <span className="flex items-center gap-0.5 text-xs text-error">
                    <AlertCircle className="h-3 w-3" />{timer.stats.errorCount}
                  </span>
                )}
                {timer.stats.avgDurationMs > 0 && (
                  <span className="text-xs text-muted-foreground">avg {formatDuration(timer.stats.avgDurationMs)}</span>
                )}
                {timer.stats.currentStreak > 1 && (
                  <Badge variant={timer.stats.streakType === "success" ? "default" : "destructive"} className="text-xs px-1 py-0 h-4">
                    <TrendingUp className="h-2.5 w-2.5 mr-0.5" />
                    {timer.stats.currentStreak}x {timer.stats.streakType}
                  </Badge>
                )}
              </div>
            )}
          </div>

          <TimerActions
            timer={timer}
            onToggle={onToggle}
            onExport={onExport}
            onRunNow={onRunNow}
            onEdit={onEdit}
            onDelete={onDelete}
            globalPaused={globalPaused}
          />
        </div>

        {expanded && (
          <div className="mt-3 pl-3 @sm:pl-7 space-y-3">
            {timer.type === "skill" && timer.skillId && (
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Skill</Label>
                <span className="text-xs font-mono bg-muted/50 rounded px-2 py-1 break-all" data-testid={`text-skillid-${timer.id}`}>{timer.skillId}</span>
              </div>
            )}

            {timer.prompt && timer.type !== "skill" && (
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Prompt</Label>
                <pre className="text-xs bg-muted/50 rounded-md p-2 whitespace-pre-wrap max-h-32 overflow-y-auto" data-testid={`text-prompt-${timer.id}`}>
                  {timer.prompt}
                </pre>
              </div>
            )}

            {timer.description && (
              <p className="text-xs text-muted-foreground">{timer.description}</p>
            )}

            {timer.recentRuns && timer.recentRuns.length > 0 && (
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Recent Runs</Label>
                <div className="space-y-0.5 max-h-40 overflow-y-auto">
                  {timer.recentRuns.map((run) => (
                    <RunHistoryItem key={run.id} run={run} />
                  ))}
                </div>
              </div>
            )}

            {(!timer.recentRuns || timer.recentRuns.length === 0) && (
              <p className="text-xs text-muted-foreground italic">No runs yet</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CreateEditDialog({
  open,
  onOpenChange,
  editingTimer,
  skills,
  skillsLoading,
  skillSlugToId,
  skillNameMap,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingTimer: TimerItem | null;
  skills: { id: string; name: string }[];
  skillsLoading: boolean;
  skillSlugToId: Record<string, string>;
  skillNameMap: Record<string, string>;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<TimerType>("agent");
  const [prompt, setPrompt] = useState("");
  const [skillId, setSkillId] = useState("");
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
  const [fireAt, setFireAt] = useState("");

  const resolveSkillId = (raw: string) => {
    if (!raw) return "";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw;
    return skillSlugToId[raw] || raw;
  };

  useEffect(() => {
    if (editingTimer) {
      setName(editingTimer.name);
      setDescription(editingTimer.description);
      setType(editingTimer.type as TimerType);
      setPrompt(editingTimer.prompt);
      setSkillId(resolveSkillId(editingTimer.skillId || ""));
      setSchedules(editingTimer.schedules);
      setEnabled(editingTimer.enabled);
      setTimezone(editingTimer.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
      const onceSchedule = editingTimer.schedules.find(s => s.frequency === "once");
      if (onceSchedule?.fireAt) {
        const d = new Date(onceSchedule.fireAt);
        const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        setFireAt(local);
      } else {
        setFireAt("");
      }
    } else {
      setName("");
      setDescription("");
      setType("agent");
      setPrompt("");
      setSkillId("");
      setSchedules([{ id: generateScheduleId(), frequency: "daily", timeOfDay: "09:00" }]);
      setEnabled(true);
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
      setFireAt("");
    }
  }, [editingTimer, open]);

  useEffect(() => {
    if (editingTimer && skillId && Object.keys(skillSlugToId).length > 0) {
      const resolved = resolveSkillId(skillId);
      if (resolved !== skillId) {
        setSkillId(resolved);
      }
    }
  }, [skillSlugToId]);

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/timers", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/timers"] });
      onOpenChange(false);
      toast({ title: "Timer created" });
    },
    onError: (err: any) => {
      log.error("create failed:", err);
      toast({ title: "Failed to create", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("PATCH", `/api/timers/${editingTimer!.id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/timers"] });
      onOpenChange(false);
      toast({ title: "Timer updated" });
    },
    onError: (err: any) => {
      log.error("update failed:", err);
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    if (type === "skill" && !skillId.trim()) {
      toast({ title: "Skill ID is required for skill timers", variant: "destructive" });
      return;
    }
    if (type === "reminder" && !fireAt) {
      toast({ title: "Date/time is required for reminders", variant: "destructive" });
      return;
    }
    let finalSchedules = schedules;
    if (type === "reminder") {
      finalSchedules = [{ id: schedules[0]?.id || generateScheduleId(), frequency: "once" as const, fireAt: new Date(fireAt).toISOString() }];
    }
    const data: any = { name: name.trim(), description, type, schedules: finalSchedules, enabled, timezone };
    if (type === "skill") {
      const originalSkillId = editingTimer?.skillId || "";
      const originalIsSlug = originalSkillId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(originalSkillId);
      if (originalIsSlug && skillSlugToId[originalSkillId] === skillId.trim()) {
        data.skillId = originalSkillId;
      } else {
        data.skillId = skillId.trim();
      }
      data.prompt = "";
    } else {
      data.prompt = prompt;
    }
    if (editingTimer) {
      updateMutation.mutate(data);
    } else {
      createMutation.mutate(data);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingTimer ? (editingTimer.type === "reminder" ? "Edit Reminder" : "Edit Timer") : (type === "reminder" ? "New Reminder" : "New Timer")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div>
            <Label className="text-sm">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Daily standup review"
              className="mt-1"
              data-testid="input-timer-name"
            />
          </div>

          <div>
            <Label className="text-sm">Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="mt-1"
              data-testid="input-timer-description"
            />
          </div>

          <div>
            <Label className="text-sm">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as TimerType)}>
              <SelectTrigger className="mt-1" data-testid="select-timer-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">{getInstanceName()} — AI agent executes prompt</SelectItem>
                <SelectItem value="system">System — System-level function</SelectItem>
                <SelectItem value="me">Me — Personal reminder</SelectItem>
                <SelectItem value="skill">Skill — Run a skill directly</SelectItem>
                <SelectItem value="reminder">Reminder — One-time scheduled action</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {type === "skill" ? (
            <div>
              <Label className="text-sm">Skill</Label>
              <Select value={skillId} onValueChange={setSkillId}>
                <SelectTrigger className="mt-1" data-testid="select-timer-skill">
                  <SelectValue placeholder={skillsLoading ? "Loading skills..." : "Select a skill..."} />
                </SelectTrigger>
                <SelectContent>
                  {skillsLoading ? (
                    <div className="flex items-center justify-center py-2">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : skills.length === 0 ? (
                    <div className="text-xs text-muted-foreground text-center py-2">No skills found</div>
                  ) : (
                    <>
                      {skillId && !skills.some((s) => s.id === skillId) && (
                        <SelectItem key={skillId} value={skillId} data-testid={`select-skill-${skillId}`}>
                          {skillNameMap[skillId] || skillId}
                        </SelectItem>
                      )}
                      {skills.map((s) => (
                        <SelectItem key={s.id} value={s.id} data-testid={`select-skill-${s.id}`}>{s.name}</SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">The skill will be executed via the Act Engine when this timer fires.</p>
            </div>
          ) : (
            <div>
              <Label className="text-sm">Prompt</Label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={type === "reminder" ? `What should ${getInstanceName()} do when this reminder fires?` : isAgentType(type) ? `What should ${getInstanceName()} do when this runs?` : "Notes or instructions for this timer"}
                className="mt-1 min-h-[100px] text-sm font-mono"
                data-testid="textarea-timer-prompt"
              />
            </div>
          )}

          {type === "reminder" ? (
            <div>
              <Label className="text-sm">Fire At</Label>
              <Input
                type="datetime-local"
                value={fireAt}
                onChange={(e) => setFireAt(e.target.value)}
                className="mt-1"
                data-testid="input-reminder-fire-at"
              />
              <p className="text-xs text-muted-foreground mt-1">The reminder will fire once at this date and time, then auto-disable.</p>
            </div>
          ) : (
            <ScheduleEditor schedules={schedules} onChange={setSchedules} />
          )}

          <div>
            <Label className="text-sm">Timezone</Label>
            <Input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/New_York"
              className="mt-1"
              data-testid="input-timer-timezone"
            />
            <p className="text-xs text-muted-foreground mt-1">IANA timezone (auto-detected from your browser)</p>
          </div>

          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} data-testid="switch-timer-enabled" />
            <Label className="text-sm">Enabled</Label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel">Cancel</Button>
            <Button onClick={handleSubmit} disabled={isPending} data-testid="button-save">
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingTimer ? "Save Changes" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TimersContent({ embedded }: { embedded?: boolean } = {}) {
  usePageHeader({ title: "Timers", skip: !!embedded });
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTimer, setEditingTimer] = useState<TimerItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TimerItem | null>(null);
  const [runNowTarget, setRunNowTarget] = useState<TimerItem | null>(null);

  const { data, isLoading } = useQuery<{ timers: TimerItem[]; globalPaused: boolean }>({
    queryKey: ["/api/timers"],
    refetchInterval: 10000,
  });

  const { data: allSkills = [], isLoading: skillsLoading } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/skills"],
    queryFn: async () => {
      const res = await fetch("/api/skills", { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
  });

  const toSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  const { skillNameMap, skillSlugToId } = useMemo(() => {
    const nameMap: Record<string, string> = {};
    const slugToId: Record<string, string> = {};
    for (const s of allSkills) {
      nameMap[s.id] = s.name;
      const slug = toSlug(s.name);
      if (slug) {
        nameMap[slug] = s.name;
        slugToId[slug] = s.id;
      }
    }
    return { skillNameMap: nameMap, skillSlugToId: slugToId };
  }, [allSkills]);

  const allTimers = data?.timers || [];
  const globalPaused = data?.globalPaused || false;
  const timers = allTimers.filter(t => t.type !== "reminder");
  const reminders = allTimers.filter(t => t.type === "reminder");

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await apiRequest("PATCH", `/api/timers/${id}`, { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/timers"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/timers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/timers"] });
      setDeleteTarget(null);
      toast({ title: "Timer deleted" });
    },
    onError: (err: any) => {
      log.error("delete failed:", err);
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  const runNowMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/timers/${id}/run`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/timers"] });
      setRunNowTarget(null);
      toast({ title: "Run started" });
    },
    onError: (err: any) => {
      log.error("run failed:", err);
      toast({ title: "Failed to run", description: err.message, variant: "destructive" });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: async (pause: boolean) => {
      await apiRequest("POST", `/api/timers/scheduler/${pause ? "pause" : "resume"}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/timers"] });
    },
  });

  const handleExportAll = async () => {
    try {
      const res = await fetch("/api/timers/export");
      if (!res.ok) throw new Error("Export failed");
      const data = await res.json();
      downloadJson(data, `timers-export-${new Date().toISOString().slice(0, 10)}.json`);
      toast({ title: `Exported ${data.length} timers` });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const res = await apiRequest("POST", "/api/timers/import", json);
        const body = await res.json();
        const resultList = (body.results || []) as { action: string }[];
        const created = resultList.filter(r => r.action === "created").length;
        const updated = resultList.filter(r => r.action === "updated").length;
        const errors = resultList.filter(r => r.action === "error").length;
        queryClient.invalidateQueries({ queryKey: ["/api/timers"] });
        toast({ title: `Import complete: ${created} created, ${updated} updated${errors ? `, ${errors} errors` : ""}` });
      } catch {
        toast({ title: "Import failed", variant: "destructive" });
      }
    };
    input.click();
  };

  if (isLoading) {
    return (
      <div className="p-4 @sm:p-6 space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="p-4 @sm:p-6 space-y-4 overflow-x-hidden">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          {!embedded && <h1 className="text-lg font-semibold" data-testid="text-page-title">Timers</h1>}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={globalPaused ? "default" : "outline"}
            size="sm"
            onClick={() => pauseMutation.mutate(!globalPaused)}
            disabled={pauseMutation.isPending}
            data-testid="button-global-pause"
          >
            {globalPaused ? <Play className="h-3.5 w-3.5 mr-1.5" /> : <Pause className="h-3.5 w-3.5 mr-1.5" />}
            {globalPaused ? "Resume All" : "Pause All"}
          </Button>
          {isMobile ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" data-testid="button-more-actions">
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleExportAll} data-testid="menu-export-all-timers">
                  <Download className="h-3.5 w-3.5 mr-2" /> Export All
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleImport} data-testid="menu-import-timers">
                  <Upload className="h-3.5 w-3.5 mr-2" /> Import
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={handleExportAll} data-testid="button-export-all-timers">
                <Download className="h-3.5 w-3.5 mr-1.5" /> Export All
              </Button>
              <Button size="sm" variant="outline" onClick={handleImport} data-testid="button-import-timers">
                <Upload className="h-3.5 w-3.5 mr-1.5" /> Import
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => { setEditingTimer(null); setDialogOpen(true); }} data-testid="button-create">
            <Plus className="h-3.5 w-3.5 mr-1.5" /> New
          </Button>
        </div>
      </div>

      {globalPaused && (
        <div className="bg-warning/10 border border-warning/20 rounded-lg p-3 flex items-center gap-2 text-sm text-warning-foreground" data-testid="banner-global-paused">
          <Pause className="h-4 w-4 shrink-0" />
          All scheduled timers are paused. Click Resume All to re-enable.
        </div>
      )}

      <h2 className="text-md font-semibold flex items-center gap-2" data-testid="text-timers-heading">
        <Clock className="h-4 w-4 text-info" />
        Timers
      </h2>

      {timers.length === 0 && !isLoading && (
        <Card>
          <CardContent className="p-8 text-center">
            <Bot className="h-6 w-6 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-3">No timers yet. Create one to have Agent perform actions on a schedule.</p>
            <Button size="sm" onClick={() => { setEditingTimer(null); setDialogOpen(true); }} data-testid="button-create-empty">
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Create First Timer
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {timers.map((timer) => (
          <TimerCard
            key={timer.id}
            timer={timer}
            globalPaused={globalPaused}
            skillNameMap={skillNameMap}
            onEdit={() => { setEditingTimer(timer); setDialogOpen(true); }}
            onDelete={() => setDeleteTarget(timer)}
            onToggle={(enabled) => toggleMutation.mutate({ id: timer.id, enabled })}
            onRunNow={() => setRunNowTarget(timer)}
            onExport={async () => {
              try {
                const res = await fetch(`/api/timers/${timer.id}/export`);
                if (!res.ok) throw new Error("Export failed");
                const data = await res.json();
                downloadJson(data, `timer-${timer.name.replace(/\s+/g, "-").toLowerCase()}.json`);
                toast({ title: `Exported "${timer.name}"` });
              } catch {
                toast({ title: "Export failed", variant: "destructive" });
              }
            }}
          />
        ))}
      </div>

      <div className="pt-4">
        <h2 className="text-md font-semibold mb-3 flex items-center gap-2" data-testid="text-reminders-heading">
          <Bell className="h-4 w-4 text-cat-event" />
          Reminders
        </h2>

        {reminders.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center">
              <Bell className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
              <p className="text-sm text-muted-foreground" data-testid="text-reminders-empty">No reminders set</p>
            </CardContent>
          </Card>
        )}

        <div className="space-y-2">
          {reminders.map((timer) => (
            <TimerCard
              key={timer.id}
              timer={timer}
              globalPaused={globalPaused}
              skillNameMap={skillNameMap}
              onEdit={() => { setEditingTimer(timer); setDialogOpen(true); }}
              onDelete={() => setDeleteTarget(timer)}
              onToggle={(enabled) => toggleMutation.mutate({ id: timer.id, enabled })}
              onRunNow={() => setRunNowTarget(timer)}
              onExport={async () => {
                try {
                  const res = await fetch(`/api/timers/${timer.id}/export`);
                  if (!res.ok) throw new Error("Export failed");
                  const data = await res.json();
                  downloadJson(data, `timer-${timer.name.replace(/\s+/g, "-").toLowerCase()}.json`);
                  toast({ title: `Exported "${timer.name}"` });
                } catch {
                  toast({ title: "Export failed", variant: "destructive" });
                }
              }}
            />
          ))}
        </div>
      </div>

      <CreateEditDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingTimer={editingTimer}
        skills={allSkills}
        skillsLoading={skillsLoading}
        skillSlugToId={skillSlugToId}
        skillNameMap={skillNameMap}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Timer</AlertDialogTitle>
            <AlertDialogDescription>
              Delete "{deleteTarget?.name}"? This will also remove all run history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!runNowTarget} onOpenChange={(open) => !open && setRunNowTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run Now</AlertDialogTitle>
            <AlertDialogDescription>
              Execute "{runNowTarget?.name}" immediately? This will create a new run just like a scheduled execution.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-run">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => runNowTarget && runNowMutation.mutate(runNowTarget.id)}
              data-testid="button-confirm-run"
            >
              {runNowMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Run Now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function TimersPage() {
  return <TimersContent />;
}
