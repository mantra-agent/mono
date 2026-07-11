import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getInstanceName } from "@/lib/instance-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlignLeft,
  Check,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Flag,
  Gauge,
  User,
  Bot,
  Target,
  Tag,
  CalendarDays,
  FolderKanban,
  Package,
  BookOpen,
  FileOutput,
  Calculator,
  Trash2,
  ListTodo,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { InlineDatePicker } from "@/components/inline-date-picker";
import { ExpandedDescriptionEditor } from "@/components/expanded-description-editor";
import type { Task, Project, PriorityLevel, TaskStatus, ImpactEffort } from "@shared/models/work";
import { getDeadlineProximity } from "@shared/models/work";
import { STATUS_CONFIG } from "@/lib/task-utils";

// ─── Constants ───────────────────────────────────────────────────────

const COLOR_GREEN = "text-success dark:text-success";
const COLOR_BLUE = "text-info";
const COLOR_PURPLE = "text-cat-ai";
const COLOR_RED = "text-error dark:text-error";

const PRIORITY_OPTIONS: { value: PriorityLevel; label: string; color: string }[] = [
  { value: "high", label: "High", color: COLOR_GREEN },
  { value: "mid", label: "Medium", color: COLOR_BLUE },
  { value: "low", label: "Low", color: COLOR_PURPLE },
];

const IMPACT_OPTIONS: { value: string; label: string; color: string }[] = [
  { value: "high", label: "High", color: COLOR_GREEN },
  { value: "mid", label: "Medium", color: COLOR_BLUE },
  { value: "low", label: "Low", color: COLOR_PURPLE },
];

const EFFORT_OPTIONS: { value: string; label: string; color: string }[] = [
  { value: "low", label: "Low", color: COLOR_GREEN },
  { value: "mid", label: "Medium", color: COLOR_BLUE },
  { value: "high", label: "High", color: COLOR_RED },
];

function getColorForOption(value: string, options: { value: string; color: string }[]) {
  return options.find(o => o.value === value)?.color || "text-muted-foreground";
}

// ─── Reusable field primitives (Person profile pattern) ──────────────

/**
 * ProfileTreeRow-style row: icon + label left, value/control right,
 * optional expand chevron. Matches the Person detail view exactly.
 */
function TaskFieldRow({
  icon: Icon,
  label,
  children,
  expandedContent,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
  expandedContent?: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const canExpand = Boolean(expandedContent);

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId}>
      <div className="group last:border-b-0">
        <div className="group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left select-none transition-colors hover:bg-accent/70">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
            <span className="flex items-center justify-center shrink-0 text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">{label}</span>
          </div>
          <div
            className={cn(
              "flex min-w-0 w-28 shrink-0 items-center justify-end text-right text-xs leading-none",
              "[&_input]:h-5 [&_input]:w-28 [&_input]:bg-muted/50 [&_input]:px-1.5 [&_input]:py-0 [&_input]:text-right [&_input]:text-xs [&_input]:leading-none",
              "[&_input[type=date]]:[color-scheme:dark] [&_input[type=date]::-webkit-calendar-picker-indicator]:h-3 [&_input[type=date]::-webkit-calendar-picker-indicator]:w-3 [&_input[type=date]::-webkit-calendar-picker-indicator]:opacity-60 [&_input[type=date]::-webkit-calendar-picker-indicator]:invert",
              "[&_[role=combobox]]:h-5 [&_[role=combobox]]:w-28 [&_[role=combobox]]:justify-end [&_[role=combobox]]:bg-muted/50 [&_[role=combobox]]:px-1.5 [&_[role=combobox]]:py-0 [&_[role=combobox]]:text-right [&_[role=combobox]]:text-xs [&_[role=combobox]>span]:text-right",
              "[&_button]:h-5 [&_button]:px-1.5 [&_button]:text-xs",
            )}
          >
            {children}
          </div>
          {canExpand ? (
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0 rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
                aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
              >
                <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
              </Button>
            </CollapsibleTrigger>
          ) : (
            <span className="h-5 w-5 shrink-0" />
          )}
        </div>
        {canExpand && (
          <CollapsibleContent>
            <div className="px-2 pb-2 pl-8 text-xs leading-relaxed text-foreground">
              {expandedContent}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

/** Editable text field: click to edit, blur to save. */
function EditableText({
  value,
  onSave,
  placeholder,
  multiline,
  testId,
}: {
  value: string;
  onSave: (val: string) => void;
  placeholder: string;
  multiline?: boolean;
  testId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    if (editing) {
      if (multiline) textareaRef.current?.focus();
      else inputRef.current?.focus();
    }
  }, [editing, multiline]);

  const save = () => {
    const trimmed = draft.trim();
    if (trimmed !== value) onSave(trimmed);
    setEditing(false);
  };

  if (editing) {
    if (multiline) {
      return (
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={e => { if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
          className="text-sm min-h-[60px]"
          data-testid={testId}
        />
      );
    }
    return (
      <Input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className="text-sm"
        data-testid={testId}
      />
    );
  }

  return (
    <div
      className={cn(
        "cursor-pointer rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors min-h-[32px]",
        !value && "text-muted-foreground/50"
      )}
      onClick={() => setEditing(true)}
      data-testid={testId}
    >
      <span className="text-sm whitespace-pre-wrap">{value || placeholder}</span>
    </div>
  );
}

/** Inline tag picker matching Person profile style */
function InlineTagPicker({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newTag, setNewTag] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);

  const addTag = () => {
    const trimmed = newTag.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setNewTag("");
    setAdding(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map(tag => (
        <Badge
          key={tag}
          variant="outline"
          className="text-[10px] cursor-pointer hover:bg-destructive/20 hover:text-destructive-foreground"
          onClick={() => onChange(tags.filter(t => t !== tag))}
        >
          {tag} ×
        </Badge>
      ))}
      {adding ? (
        <Input
          ref={inputRef}
          value={newTag}
          onChange={e => setNewTag(e.target.value)}
          onBlur={addTag}
          onKeyDown={e => {
            if (e.key === "Enter") addTag();
            if (e.key === "Escape") { setNewTag(""); setAdding(false); }
          }}
          className="h-5 w-20 bg-muted/50 px-1.5 text-[10px]"
          placeholder="tag"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="text-[10px] text-muted-foreground/60 hover:text-foreground"
        >
          + add
        </button>
      )}
    </div>
  );
}

/** Deadline picker with proximity label */
function DeadlineField({
  value,
  onSave,
}: {
  value: string;
  onSave: (val: string | null) => void;
}) {
  const dlProx = getDeadlineProximity(value || null);
  const dlColor = dlProx?.urgency === "overdue" ? "text-error" :
    dlProx?.urgency === "urgent" ? "text-warning" :
    dlProx?.urgency === "soon" ? "text-warning" : "";

  return (
    <div className="flex items-center gap-1.5">
      <InlineDatePicker
        value={value}
        onCommit={(v) => { if (v !== (value || null)) onSave(v); }}
        testId="picker-task-widget-deadline"
      >
        <span
          className={cn(
            "h-5 rounded bg-muted/50 px-1.5 text-xs leading-5 hover:bg-accent/70",
            dlColor,
            !value && "text-muted-foreground/60",
          )}
        >
          {value || "Set date"}
        </span>
      </InlineDatePicker>
      {dlProx && (
        <span className={cn("text-[10px] whitespace-nowrap", dlColor)}>
          {dlProx.label}
        </span>
      )}
    </div>
  );
}

// ─── TaskWidget ──────────────────────────────────────────────────────

export interface TaskWidgetProps {
  taskId: number;
  /** Whether to show the expanded detail fields initially */
  defaultExpanded?: boolean;
  /**
   * Render the widget header (editable title + status badge + menu).
   * Pass false when the host surface (e.g. an expanded tree row) already
   * renders the title and actions — the widget then shows detail fields only.
   */
  showHeader?: boolean;
  /** Called when the task is deleted */
  onDelete?: () => void;
}

/**
 * Reusable task detail widget following the Person profile inline pattern.
 *
 * Collapsed: title + status badge
 * Expanded: all detail fields rendered flat using Person-profile-style
 * editable rows (no subgroup headers).
 */
export function TaskWidget({ taskId, defaultExpanded = false, showHeader = true, onDelete }: TaskWidgetProps) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(defaultExpanded);

  const { data: task, isLoading } = useQuery<Task>({
    queryKey: ["/api/projects/tasks", taskId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/tasks/${taskId}`);
      if (!res.ok) throw new Error("Failed to load task");
      return res.json();
    },
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects/projects"],
  });

  const projectMap = useMemo(() => {
    const map = new Map<number, Project>();
    projects?.forEach(p => map.set(p.id, p));
    return map;
  }, [projects]);

  const updateMutation = useMutation({
    mutationFn: (data: Partial<Task>) => apiRequest("PATCH", `/api/projects/tasks/${taskId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/tasks", taskId] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/todo"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update task", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/projects/tasks/${taskId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/todo"] });
      toast({ title: "Task deleted" });
      onDelete?.();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete task", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !task) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const project = task.projectId ? projectMap.get(task.projectId) : undefined;
  const milestone = project?.milestones?.find(m => m.id === task.milestoneId);
  const statusCfg = STATUS_CONFIG[task.status];

  const textFieldRows = [
    { icon: AlignLeft, label: "Description", field: "description" as const, value: task.description, placeholder: "Add a description..." },
    { icon: BookOpen, label: "Context", field: "context" as const, value: task.context, placeholder: "Background info, links, or references..." },
    { icon: FileOutput, label: "Output", field: "output" as const, value: task.output, placeholder: "Result or output once completed..." },
  ];

  return (
    <div className="w-full" data-testid={`task-widget-${taskId}`}>
      {/* Header: editable title + status badge + menu (hidden when host renders its own) */}
      {showHeader && (
        <div className="flex items-start gap-2 px-2 py-1.5">
          <ListTodo className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <EditableText
              value={task.title}
              onSave={(val) => { if (val) updateMutation.mutate({ title: val }); }}
              placeholder="Task title"
              testId={`input-task-widget-title-${taskId}`}
            />
          </div>
          <Badge
            variant="outline"
            className={cn("shrink-0 text-[10px] mt-0.5", statusCfg.className)}
          >
            {statusCfg.label}
          </Badge>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0 rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
                data-testid={`button-task-widget-menu-${taskId}`}
              >
                <MoreHorizontal className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Package className="h-3.5 w-3.5 mr-2" />
                  Status
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {(["on_hold", "ready", "active", "done"] as TaskStatus[]).map(s => (
                    <DropdownMenuItem key={s} onClick={() => updateMutation.mutate({ status: s })}>
                      {task.status === s ? <Check className="h-3.5 w-3.5 mr-2" /> : <span className="w-3.5 mr-2" />}
                      {STATUS_CONFIG[s].label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-error-foreground"
                onClick={() => deleteMutation.mutate()}
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0 rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
            onClick={() => setExpanded(v => !v)}
            aria-label={expanded ? "Collapse task details" : "Expand task details"}
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
          </Button>
        </div>
      )}

      {/* Detail fields — flat, Person-profile-style rows */}
      {(!showHeader || expanded) && (
        <div className="space-y-0.5 pb-2" data-testid={`task-widget-expanded-${taskId}`}>
          <TaskFieldRow icon={Flag} label="Status" testId="row-task-status">
            <Select value={task.status} onValueChange={(v) => updateMutation.mutate({ status: v as TaskStatus })}>
              <SelectTrigger className="h-5 text-xs w-auto min-w-[80px]" data-testid="select-task-widget-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="on_hold">On Hold</SelectItem>
                <SelectItem value="ready">Ready</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="done">Done</SelectItem>
              </SelectContent>
            </Select>
          </TaskFieldRow>

          <TaskFieldRow icon={Flag} label="Priority" testId="row-task-priority">
            <Select value={task.priority} onValueChange={(v) => updateMutation.mutate({ priority: v as PriorityLevel })}>
              <SelectTrigger className={cn("h-5 text-xs w-auto min-w-[80px]", getColorForOption(task.priority, PRIORITY_OPTIONS))} data-testid="select-task-widget-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <span className={opt.color}>{opt.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TaskFieldRow>

          <TaskFieldRow icon={task.owner === "me" ? User : Bot} label="Owner" testId="row-task-owner">
            <Select value={task.owner} onValueChange={(v) => updateMutation.mutate({ owner: v as "me" | "agent" })}>
              <SelectTrigger className="h-5 text-xs w-auto min-w-[80px]" data-testid="select-task-widget-owner">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Me</SelectItem>
                <SelectItem value="agent">{getInstanceName()}</SelectItem>
              </SelectContent>
            </Select>
          </TaskFieldRow>

          <TaskFieldRow icon={Target} label="Impact" testId="row-task-impact">
            <Select value={task.impact as string} onValueChange={(v) => updateMutation.mutate({ impact: v as ImpactEffort })}>
              <SelectTrigger className={cn("h-5 text-xs w-auto min-w-[80px]", getColorForOption(task.impact as string, IMPACT_OPTIONS))} data-testid="select-task-widget-impact">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {IMPACT_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <span className={opt.color}>{opt.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TaskFieldRow>

          <TaskFieldRow icon={Gauge} label="Effort" testId="row-task-effort">
            <Select value={task.effort as string} onValueChange={(v) => updateMutation.mutate({ effort: v as ImpactEffort })}>
              <SelectTrigger className={cn("h-5 text-xs w-auto min-w-[80px]", getColorForOption(task.effort as string, EFFORT_OPTIONS))} data-testid="select-task-widget-effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFORT_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <span className={opt.color}>{opt.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TaskFieldRow>

          <TaskFieldRow icon={CalendarDays} label="Deadline" testId="row-task-deadline">
            <DeadlineField
              value={task.deadline ?? ""}
              onSave={(val) => updateMutation.mutate({ deadline: val } as Partial<Task>)}
            />
          </TaskFieldRow>

          <TaskFieldRow icon={FolderKanban} label="Project" testId="row-task-project">
            <Select
              value={task.projectId ? String(task.projectId) : "none"}
              onValueChange={(v) => updateMutation.mutate({ projectId: v === "none" ? null : parseInt(v, 10) })}
            >
              <SelectTrigger className="h-5 text-xs w-auto min-w-[80px] max-w-[160px]" data-testid="select-task-widget-project">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {projects?.filter(p => p.status !== "completed").map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TaskFieldRow>

          {project && project.milestones && project.milestones.length > 0 && (
            <TaskFieldRow icon={Target} label="Milestone" testId="row-task-milestone">
              <Select
                value={task.milestoneId ? String(task.milestoneId) : "none"}
                onValueChange={(v) => updateMutation.mutate({ milestoneId: v === "none" ? null : parseInt(v, 10) } as Partial<Task>)}
              >
                <SelectTrigger className="h-5 text-xs w-auto min-w-[80px] max-w-[160px]" data-testid="select-task-widget-milestone">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {project.milestones.map(m => (
                    <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </TaskFieldRow>
          )}

          <TaskFieldRow icon={Tag} label="Tags" testId="row-task-tags">
            <InlineTagPicker
              tags={task.tags}
              onChange={(tags) => updateMutation.mutate({ tags })}
            />
          </TaskFieldRow>

          {task.owner === "agent" && (
            <TaskFieldRow icon={Calculator} label="Token Est." testId="row-task-token-estimate">
              <span className="text-xs text-muted-foreground">
                {task.tokenEstimate != null ? `${task.tokenEstimate.toLocaleString()} tok` : "—"}
              </span>
            </TaskFieldRow>
          )}

          {textFieldRows.map(({ icon: Icon, label, field, value, placeholder }) => (
            <TaskFieldRow key={field} icon={Icon} label={label} testId={`row-task-${field}`}
              expandedContent={
                field === "description" ? (
                  <ExpandedDescriptionEditor
                    value={value}
                    onSave={(val) => updateMutation.mutate({ [field]: val })}
                    placeholder={placeholder}
                    testIdPrefix={`task-description-${taskId}`}
                  />
                ) : (
                  <EditableText
                    value={value}
                    onSave={(val) => updateMutation.mutate({ [field]: val })}
                    placeholder={placeholder}
                    multiline
                    testId={`input-task-widget-${field}-${taskId}`}
                  />
                )
              }
            >
              <span className="text-xs text-muted-foreground truncate max-w-[160px]">
                {value ? value.slice(0, 40) + (value.length > 40 ? "…" : "") : "—"}
              </span>
            </TaskFieldRow>
          ))}
        </div>
      )}
    </div>
  );
}
