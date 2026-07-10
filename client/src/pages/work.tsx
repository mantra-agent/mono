// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useMemo, useRef, useEffect } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useSearch, useLocation } from "wouter";
import { useFocusContext } from "@/hooks/use-focus-context";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getInstanceName } from "@/lib/instance-config";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
  Check,
  Plus,
  ChevronDown,
  ChevronRight,
  Loader2,
  FolderKanban,

  Calendar,
  Tag,
  User,
  Bot,
  Send,
  Trash2,
  X,
  Target,
  Gauge,
  Flag,
  GripVertical,
  MessageSquare,
  MoreHorizontal,
  ArrowUpFromLine,
  Link2,
  StickyNote,
  Pencil,
  FileText,
  Image,
  Upload,
  FileIcon,
  Users,
  Download,
  Monitor,
  ListTodo,
  Package,
  CalendarDays,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useTimezone, formatDate as tzFormatDate, formatDateTime, formatDateOnly } from "@/hooks/use-timezone";
import { localDayDiff } from "@/lib/local-date";
import type { Task, Project, PriorityLevel, TaskStatus, ProjectStatus, ImpactEffort, Milestone, MilestoneStatus, ProjectNote, ProjectFile } from "@shared/models/work";
import type { GoalIndexEntry } from "@shared/schema";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { STATUS_CONFIG, PROJECT_STATUS_CONFIG, groupTasksByStatus } from "@/lib/task-utils";
import { TaskWidget } from "@/components/task-widget";
import { useTaskModal } from "@/contexts/task-modal-context";

const log = createLogger("WorkPage");

// Tasks are managed within project detail views; no standalone tasks tab

const COLOR_GREEN = "text-success dark:text-success";
const COLOR_BLUE = "text-info";
const COLOR_PURPLE = "text-cat-ai";

function formatWorkDueDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function WorkCheckCircle({ checked, className, ...props }: { checked: boolean; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "h-4 w-4 rounded-full border bg-transparent inline-flex items-center justify-center transition-colors shrink-0",
        checked ? "border-success text-success" : "border-muted-foreground text-muted-foreground",
        className,
      )}
      aria-hidden="true"
      {...props}
    >
      {checked ? <Check className="h-3 w-3" /> : null}
    </span>
  );
}
const COLOR_RED = "text-error dark:text-error";

const PRIORITY_OPTIONS: { value: PriorityLevel; label: string; color: string }[] = [
  { value: "high", label: "High", color: COLOR_GREEN },
  { value: "mid", label: "Medium", color: COLOR_BLUE },
  { value: "low", label: "Low", color: COLOR_PURPLE },
];

const IMPACT_OPTIONS: { value: ImpactEffort; label: string; color: string }[] = [
  { value: "high", label: "High Impact", color: COLOR_GREEN },
  { value: "mid", label: "Medium Impact", color: COLOR_BLUE },
  { value: "low", label: "Low Impact", color: COLOR_PURPLE },
];

const EFFORT_OPTIONS: { value: ImpactEffort; label: string; color: string }[] = [
  { value: "low", label: "Low Effort", color: COLOR_GREEN },
  { value: "mid", label: "Medium Effort", color: COLOR_BLUE },
  { value: "high", label: "High Effort", color: COLOR_RED },
];

function getColorForOption(value: string, options: { value: string; color: string }[]) {
  return options.find(o => o.value === value)?.color || "text-muted-foreground";
}

function AttributePicker({
  value,
  options,
  onChange,
  testId,
  icon: Icon,
}: {
  value: string;
  options: { value: string; label: string; color: string }[];
  onChange: (val: string) => void;
  testId: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const currentColor = getColorForOption(value, options);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={currentColor}
          data-testid={testId}
        >
          <Icon className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-1" align="start" sideOffset={4}>
        <div className="flex flex-col gap-0.5">
          {options.map(opt => (
            <Button
              key={opt.value}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "justify-start gap-2 w-full",
                value === opt.value && "bg-muted"
              )}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              data-testid={`${testId}-option-${opt.value}`}
            >
              <Icon className={cn("h-3.5 w-3.5", opt.color)} />
              <span className="text-xs font-medium">{opt.label}</span>
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function OwnerPicker({
  value,
  onChange,
  testId,
}: {
  value: string;
  onChange: (val: string) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const owners = [
    { value: "me", label: "Me", icon: User },
    { value: "agent", label: getInstanceName(), icon: Bot },
  ];

  const currentIcon = value === "me" ? User : Bot;
  const CurrentIcon = currentIcon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="text-muted-foreground"
          data-testid={testId}
        >
          <CurrentIcon className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-1" align="start" sideOffset={4}>
        <div className="flex flex-col gap-0.5">
          {owners.map(o => (
            <Button
              key={o.value}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "justify-start gap-2 w-full",
                value === o.value && "bg-muted"
              )}
              onClick={() => { onChange(o.value); setOpen(false); }}
              data-testid={`${testId}-option-${o.value}`}
            >
              <o.icon className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">{o.label}</span>
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface PersonEntry {
  id: string;
  name: string;
}

function PeopleSelector({ selected, onChange }: { selected: string[]; onChange: (people: string[]) => void }) {
  const [search, setSearch] = useState("");
  const { data: peopleData } = useQuery<{ people: PersonEntry[] }>({
    queryKey: ["/api/people"],
  });
  const allPeople = peopleData?.people ?? [];

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return allPeople
      .filter(p => p.name.toLowerCase().includes(q))
      .filter(p => !selected.includes(p.name))
      .slice(0, 8);
  }, [allPeople, search, selected]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs gap-1" data-testid="button-add-person">
          <Users className="h-3 w-3" />
          <Plus className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-2 space-y-1" align="start">
        <Input
          placeholder="Search people..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && search.trim()) {
              const name = search.trim();
              if (!selected.includes(name)) {
                onChange([...selected, name]);
              }
              setSearch("");
            }
          }}
          className="h-7 text-xs"
          autoFocus
          data-testid="input-search-person"
        />
        {filtered.length > 0 && (
          <div className="max-h-[160px] overflow-y-auto space-y-0.5">
            {filtered.map(p => (
              <button
                key={p.id}
                type="button"
                className="w-full text-left px-2 py-1 text-xs rounded hover:bg-accent transition-colors truncate"
                onClick={() => {
                  onChange([...selected, p.name]);
                  setSearch("");
                }}
                data-testid={`option-person-${p.id}`}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        {search.trim() && filtered.length === 0 && (
          <p className="text-xs text-muted-foreground px-2 py-1">Press Enter to add "{search.trim()}"</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function GoalSelector({ goalId, onChange }: { goalId: string | null; onChange: (goalId: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: goalsData } = useQuery<{ goals: GoalIndexEntry[] }>({
    queryKey: ["/api/life-goals"],
  });
  const allGoals = goalsData?.goals ?? [];

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return allGoals
      .filter(g => g.shortName.toLowerCase().includes(q))
      .slice(0, 10);
  }, [allGoals, search]);

  const selectedGoal = allGoals.find(g => g.id === goalId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-1" data-testid="button-goal-selector">
          <Target className="h-3 w-3" />
          {selectedGoal ? selectedGoal.shortName : "Link goal"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-2 space-y-1" align="start">
        <Input
          placeholder="Search goals..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-7 text-xs"
          autoFocus
          data-testid="input-search-goal"
        />
        <div className="max-h-[200px] overflow-y-auto space-y-0.5">
          {goalId && (
            <button
              type="button"
              className="w-full text-left px-2 py-1 text-xs rounded hover:bg-accent transition-colors text-muted-foreground"
              onClick={() => { onChange(null); setOpen(false); setSearch(""); }}
              data-testid="option-goal-clear"
            >
              <X className="h-3 w-3 inline mr-1" />
              Clear goal
            </button>
          )}
          {filtered.map(g => (
            <button
              key={g.id}
              type="button"
              className={cn(
                "w-full text-left px-2 py-1 text-xs rounded hover:bg-accent transition-colors truncate",
                g.id === goalId && "bg-accent"
              )}
              onClick={() => { onChange(g.id); setOpen(false); setSearch(""); }}
              data-testid={`option-goal-${g.id}`}
            >
              {g.id === goalId && <Check className="h-3 w-3 inline mr-1" />}
              {g.shortName}
            </button>
          ))}
          {filtered.length === 0 && search.trim() && (
            <p className="text-xs text-muted-foreground px-2 py-1">No goals found</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TagMenuItems({
  selectedTags,
  onChange,
}: {
  selectedTags: string[];
  onChange: (tags: string[]) => void;
}) {
  const { data: allTags } = useQuery<string[]>({
    queryKey: ["/api/projects/tags"],
  });
  const mergedTags = Array.from(new Set([...(allTags || []), ...selectedTags])).sort();
  const toggleTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      onChange(selectedTags.filter(t => t !== tag));
    } else {
      onChange([...selectedTags, tag]);
    }
  };
  if (mergedTags.length === 0) {
    return <DropdownMenuItem disabled>No tags yet</DropdownMenuItem>;
  }
  return (
    <>
      {mergedTags.map(tag => (
        <DropdownMenuItem key={tag} onClick={(e) => { e.preventDefault(); toggleTag(tag); }}>
          <Check className={cn("h-3.5 w-3.5 mr-2", selectedTags.includes(tag) ? "opacity-100" : "opacity-0")} />
          {tag}
        </DropdownMenuItem>
      ))}
    </>
  );
}

function TagPicker({
  selectedTags,
  onChange,
  testId,
}: {
  selectedTags: string[];
  onChange: (tags: string[]) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [newTagInput, setNewTagInput] = useState("");

  const { data: allTags } = useQuery<string[]>({
    queryKey: ["/api/projects/tags"],
  });

  const availableTags = allTags || [];

  const toggleTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      onChange(selectedTags.filter(t => t !== tag));
    } else {
      onChange([...selectedTags, tag]);
    }
  };

  const addNewTag = () => {
    const tag = newTagInput.trim().toLowerCase();
    if (tag && !selectedTags.includes(tag)) {
      onChange([...selectedTags, tag]);
      setNewTagInput("");
      queryClient.invalidateQueries({ queryKey: ["/api/projects/tags"] });
    }
  };

  const mergedTags = Array.from(new Set([...availableTags, ...selectedTags])).sort();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="flex items-center gap-1 cursor-pointer" data-testid={testId}>
          {selectedTags.length > 0 ? (
            selectedTags.slice(0, 2).map(tag => (
              <Badge key={tag} variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate">
                {tag}
              </Badge>
            ))
          ) : (
            <Button type="button" size="icon" variant="ghost" className="text-muted-foreground/50">
              <Tag className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-2" align="start" sideOffset={4}>
        <div className="flex flex-col gap-1">
          <form
            onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); addNewTag(); }}
            className="flex items-center gap-1"
          >
            <Input
              value={newTagInput}
              onChange={(e) => setNewTagInput(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="New tag..."
              className="text-xs flex-1"
              data-testid={`${testId}-input`}
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              disabled={!newTagInput.trim()}
              data-testid={`${testId}-add`}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </form>
          {mergedTags.length > 0 && (
            <div className="flex flex-col gap-0.5 mt-1 max-h-32 overflow-y-auto">
              {mergedTags.map(tag => (
                <Button
                  key={tag}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-start gap-2 w-full"
                  onClick={() => toggleTag(tag)}
                  data-testid={`${testId}-tag-${tag}`}
                >
                  <Check className={cn("h-3.5 w-3.5", selectedTags.includes(tag) ? "opacity-100" : "opacity-0")} />
                  <span className="text-xs">{tag}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatRelativeDate(dateStr: string | null, timezone: string, isCompleted?: boolean): string {
  if (!dateStr) return "";
  // Date-only strings ("YYYY-MM-DD") get pinned to local midday so they parse
  // as the intended local calendar day regardless of the browser's offset.
  const normalized = dateStr.length === 10 ? `${dateStr}T12:00:00` : dateStr;
  // localDayDiff returns past-positive days; negate so future deadlines are positive.
  const diffDays = -localDayDiff(normalized);
  if (diffDays < 0) {
    if (isCompleted) return formatDateOnly(dateStr, timezone, { month: "short", day: "numeric" });
    return `${Math.abs(diffDays)}d overdue`;
  }
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays <= 7) return `${diffDays}d`;
  return formatDateOnly(dateStr, timezone, { month: "short", day: "numeric" });
}

function ConfirmDeleteProjectDialog({
  projectTitle,
  onConfirm,
  children,
}: {
  projectTitle: string;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete "{projectTitle}" and remove it from all linked tasks. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-delete-project">Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(false);
              setTimeout(onConfirm, 0);
            }}
            data-testid="button-confirm-delete-project"
          >
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function ProjectsPage() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const urlTaskId = params.get("task");
  const { openTaskModal } = useTaskModal();

  usePageHeader({
    title: "Projects",
  });

  // If navigated with ?task=<id>, open modal and clear the param
  useEffect(() => {
    if (urlTaskId) {
      const parsed = Number(urlTaskId);
      if (Number.isFinite(parsed)) {
        openTaskModal(parsed);
      }
    }
  }, [urlTaskId, openTaskModal]);

  return (
    <div className="flex flex-col h-full overflow-y-auto overflow-x-hidden">
      <ProjectsView />
    </div>
  );
}

const WORK_SECTION_TITLE_CLASS = "flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider rounded-md";
const WORK_INDENT_STEP_PX = 24;
const WORK_MAX_INDENT_PX = 72;

function WorkSectionTitle({ children }: { children: React.ReactNode }) {
  return <div className={WORK_SECTION_TITLE_CLASS}>{children}</div>;
}
function WorkNewRow({ children, onClick, testId }: { children: React.ReactNode; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-cta hover:text-cta/80 hover:bg-accent/70 rounded-md transition-colors"
      data-testid={testId}
    >
      <Plus className="h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </button>
  );
}

function CollapsibleWorkSection({
  label,
  defaultOpen,
  children,
  testId,
}: {
  label: string;
  defaultOpen: boolean;
  children: React.ReactNode;
  testId: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover-elevate rounded-md"
          data-testid={`button-toggle-${testId}`}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span>{label}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-0 mt-0">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}


function TaskRow({
  task,
  project,
  isEditing,
  onStartEdit,
  onStopEdit,
  onUpdate,
  onDelete,
  projects,
  isDone,
  hideProjectAssign,
}: {
  task: Task;
  project?: Project;
  isEditing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onUpdate: (data: any) => void;
  onDelete: () => void;
  projects: Project[];
  isDone?: boolean;
  hideProjectAssign?: boolean;
}) {
  const { openTaskModal } = useTaskModal();
  const [editTitle, setEditTitle] = useState(task.title);
  const [expanded, setExpanded] = useState(false);
  const [editingDeadline, setEditingDeadline] = useState(false);
  const [deadlineDraft, setDeadlineDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSaveTitle = () => {
    if (editTitle.trim() && editTitle !== task.title) {
      onUpdate({ title: editTitle.trim() });
    }
    onStopEdit();
  };

  const availableProjects = projects?.filter(p => p.status !== "completed") || [];

  const isCompleted = task.status === "done" || isDone;
  const isActive = task.status === "active" && !isCompleted;
  const dueLabel = formatWorkDueDate(task.deadline);
  const taskDetailLines = [task.description, task.deliverable, task.context, task.output].map(v => v?.trim()).filter(Boolean);
  const statusTextClass = isActive
    ? "text-foreground font-medium"
    : isCompleted
      ? "text-muted-foreground/45"
      : "text-muted-foreground";

  return (
    <div data-testid={`tree-node-task-${task.id}`}>
      <div
        className={cn(
          "group relative flex items-center gap-2 rounded-md px-2 py-1.5 pr-16 text-sm w-full text-left cursor-pointer select-none transition-colors overflow-hidden",
          "hover:bg-accent/70",
          statusTextClass,
          isCompleted && "line-through"
        )}
        onClick={() => openTaskModal(task.id)}
        data-testid={`card-task-${task.id}`}
      >
      <WorkCheckCircle checked={isCompleted} data-testid={`check-task-${task.id}`} />
      <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" data-testid={`icon-task-${task.id}`} />

      {isEditing ? (
        <Input
          ref={inputRef}
          value={editTitle}
          onChange={e => setEditTitle(e.target.value)}
          onBlur={handleSaveTitle}
          onKeyDown={e => { if (e.key === "Enter") handleSaveTitle(); if (e.key === "Escape") onStopEdit(); }}
          onClick={(e) => e.stopPropagation()}
          className="h-7 flex-1 bg-transparent text-sm"
          data-testid={`input-edit-task-title-${task.id}`}
        />
      ) : (
        <span
          className="truncate flex-1 min-w-0"
          data-testid={`text-task-title-${task.id}`}
        >
          {task.title}
        </span>
      )}

      {editingDeadline ? (
        <Input
          type="date"
          value={deadlineDraft}
          onChange={e => setDeadlineDraft(e.target.value)}
          onBlur={() => {
            onUpdate({ deadline: deadlineDraft || null });
            setEditingDeadline(false);
          }}
          onKeyDown={e => {
            if (e.key === "Enter") { onUpdate({ deadline: deadlineDraft || null }); setEditingDeadline(false); }
            if (e.key === "Escape") setEditingDeadline(false);
          }}
          onClick={e => e.stopPropagation()}
          className="h-6 text-xs w-32 shrink-0"
          autoFocus
          data-testid={`input-task-deadline-${task.id}`}
        />
      ) : dueLabel ? (
        <span
          className="shrink-0 text-xs text-muted-foreground/70 tabular-nums cursor-pointer rounded px-1 -mx-1 hover:bg-accent/70"
          onClick={e => { e.stopPropagation(); setDeadlineDraft(task.deadline || ""); setEditingDeadline(true); }}
          data-testid={`text-task-due-date-${task.id}`}
        >
          {dueLabel}
        </span>
      ) : (
        <button
          type="button"
          className="shrink-0 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 hover:bg-accent/70 hover:text-muted-foreground"
          onClick={e => { e.stopPropagation(); setDeadlineDraft(""); setEditingDeadline(true); }}
          data-testid={`button-task-set-deadline-${task.id}`}
        >
          <CalendarDays className="h-3 w-3" />
        </button>
      )}

      <button
        type="button"
        className="absolute right-7 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
        onClick={(e) => { e.stopPropagation(); setExpanded(value => !value); }}
        aria-label={expanded ? "Collapse task" : "Expand task"}
        data-testid={`button-task-twisty-${task.id}`}
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
      </button>

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center h-6 w-6 rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-accent"
            onClick={(e) => e.stopPropagation()}
            data-testid={`button-task-menu-${task.id}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid={`menu-task-status-${task.id}`}>
              <Package className="h-3.5 w-3.5 mr-2" />
              Status
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {(["on_hold", "ready", "active", "done"] as TaskStatus[]).map(status => (
                <DropdownMenuItem
                  key={status}
                  onClick={(e) => { e.stopPropagation(); onUpdate({ status }); }}
                  data-testid={`menu-task-status-${status}-${task.id}`}
                >
                  {task.status === status ? <Check className="h-3.5 w-3.5 mr-2" /> : <span className="w-3.5 mr-2" />}
                  {STATUS_CONFIG[status].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
            data-testid={`menu-task-rename-${task.id}`}
          >
            <Pencil className="h-3.5 w-3.5 mr-2" />
            Rename
          </DropdownMenuItem>
          {!hideProjectAssign && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid={`menu-task-assign-${task.id}`}>
                <Link2 className="h-3.5 w-3.5 mr-2" />
                Assign to Project
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {task.projectId && (
                  <DropdownMenuItem onClick={() => onUpdate({ projectId: null })} data-testid={`menu-task-unassign-${task.id}`}>
                    <X className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                    Unassign
                  </DropdownMenuItem>
                )}
                {availableProjects.length === 0 && !task.projectId && (
                  <DropdownMenuItem disabled>No active projects</DropdownMenuItem>
                )}
                {availableProjects.map(p => (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => onUpdate({ projectId: p.id })}
                    data-testid={`menu-task-assign-project-${p.id}`}
                  >
                    <FolderKanban className="h-3.5 w-3.5 mr-2" />
                    {p.title}
                    {task.projectId === p.id && <Check className="h-3 w-3 ml-auto" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {task.owner === "me" ? <User className="h-3.5 w-3.5 mr-2" /> : <Bot className="h-3.5 w-3.5 mr-2" />}
              Owner
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => onUpdate({ owner: "me" })}>
                <User className="h-3.5 w-3.5 mr-2" />
                <span className={cn(task.owner === "me" && "font-medium")}>Me</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onUpdate({ owner: "agent" })}>
                <Bot className="h-3.5 w-3.5 mr-2" />
                <span className={cn(task.owner === "agent" && "font-medium")}>{getInstanceName()}</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid={`menu-task-tags-mobile-${task.id}`}>
              <Tag className="h-3.5 w-3.5 mr-2" />
              Tags
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40">
              <TagMenuItems
                selectedTags={task.tags}
                onChange={(tags) => onUpdate({ tags })}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid={`menu-task-priority-${task.id}`}>
              <Flag className={cn("h-3.5 w-3.5 mr-2", getColorForOption(task.priority, PRIORITY_OPTIONS))} />
              Priority
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {PRIORITY_OPTIONS.map(opt => (
                <DropdownMenuItem key={opt.value} onClick={() => onUpdate({ priority: opt.value })}>
                  <Flag className={cn("h-3.5 w-3.5 mr-2", opt.color)} />
                  {opt.label}
                  {task.priority === opt.value && <Check className="h-3 w-3 ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid={`menu-task-impact-${task.id}`}>
              <Target className={cn("h-3.5 w-3.5 mr-2", getColorForOption(task.impact as string, IMPACT_OPTIONS))} />
              Impact
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {IMPACT_OPTIONS.map(opt => (
                <DropdownMenuItem key={opt.value} onClick={() => onUpdate({ impact: opt.value })}>
                  <Target className={cn("h-3.5 w-3.5 mr-2", opt.color)} />
                  {opt.label}
                  {task.impact === opt.value && <Check className="h-3 w-3 ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid={`menu-task-effort-${task.id}`}>
              <Gauge className={cn("h-3.5 w-3.5 mr-2", getColorForOption(task.effort as string, EFFORT_OPTIONS))} />
              Effort
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {EFFORT_OPTIONS.map(opt => (
                <DropdownMenuItem key={opt.value} onClick={() => onUpdate({ effort: opt.value })}>
                  <Gauge className={cn("h-3.5 w-3.5 mr-2", opt.color)} />
                  {opt.label}
                  {task.effort === opt.value && <Check className="h-3 w-3 ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-error-foreground"
            onClick={onDelete}
            data-testid={`menu-task-delete-${task.id}`}
          >
            <Trash2 className="h-3.5 w-3.5 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
      {expanded && (
        <div className="ml-6 mr-2 border-l border-border/40 pl-2" data-testid={`tree-task-expanded-${task.id}`}>
          <TaskWidget taskId={task.id} defaultExpanded onDelete={onDelete} />
        </div>
      )}
    </div>
  );
}

function ProjectsView() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [showCreate, setShowCreate] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [addingMilestoneProjectId, setAddingMilestoneProjectId] = useState<number | null>(null);
  const [newMilestoneName, setNewMilestoneName] = useState("");
  const [addingTaskTarget, setAddingTaskTarget] = useState<{ projectId: number; milestoneId: number } | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [pendingDeleteProject, setPendingDeleteProject] = useState<{ id: number; title: string } | null>(null);
  const [pendingDeleteTask, setPendingDeleteTask] = useState<{ id: number; title: string } | null>(null);

  const { data: projects, isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects/projects"],
  });

  const { data: tasks, isLoading: tasksLoading } = useQuery<Task[]>({
    queryKey: ["/api/projects/tasks"],
  });

  useFocusContext(null);

  const updateProjectMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PATCH", `/api/projects/projects/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/projects/projects/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
      toast({ title: "Project deleted" });
    },
  });

  const updateTaskMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PATCH", `/api/projects/tasks/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/todo"] });
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/projects/tasks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/todo"] });
      toast({ title: "Task deleted" });
    },
  });

  const createMilestoneMutation = useMutation({
    mutationFn: ({ projectId, name }: { projectId: number; name: string }) =>
      apiRequest("POST", `/api/projects/projects/${projectId}/milestones`, { name }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", variables.projectId] });
      setAddingMilestoneProjectId(null);
      setNewMilestoneName("");
    },
  });

  const updateMilestoneMutation = useMutation({
    mutationFn: ({ projectId, milestoneId, data }: { projectId: number; milestoneId: number; data: Partial<Milestone> }) =>
      apiRequest("PATCH", `/api/projects/projects/${projectId}/milestones/${milestoneId}`, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", variables.projectId] });
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: (data: { title: string; projectId: number; milestoneId: number }) => apiRequest("POST", "/api/projects/tasks", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/todo"] });
      setAddingTaskTarget(null);
      setNewTaskTitle("");
    },
  });

  if (isLoading || tasksLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const tasksByProject = new Map<number, Task[]>();
  (tasks || []).forEach(task => {
    if (!task.projectId) return;
    const bucket = tasksByProject.get(task.projectId) || [];
    bucket.push(task);
    tasksByProject.set(task.projectId, bucket);
  });
  tasksByProject.forEach(bucket => {
    bucket.sort((a, b) => {
      const statusOrder: Record<string, number> = { active: 0, ready: 1, on_hold: 2, done: 3 };
      const statusDelta = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
      if (statusDelta !== 0) return statusDelta;
      return a.title.localeCompare(b.title);
    });
  });

  const activeProjects = projects?.filter(p => p.status !== "completed") || [];

  const statusOrder: ProjectStatus[] = ["idea", "planning", "active", "on_hold", "completed"];
  const groupedProjects = statusOrder.map(status => ({
    status,
    label: PROJECT_STATUS_CONFIG[status].label,
    projects: (projects || [])
      .filter(p => p.status === status)
      .sort((a, b) => {
        const aDone = a.milestones.filter(m => m.status === "completed").length;
        const bDone = b.milestones.filter(m => m.status === "completed").length;
        const aTotal = a.milestones.length || 1;
        const bTotal = b.milestones.length || 1;
        return (aDone / aTotal) - (bDone / bTotal);
      }),
  })).filter(g => g.projects.length > 0);

  const startAddMilestone = (projectId: number) => {
    setAddingTaskTarget(null);
    setNewTaskTitle("");
    setAddingMilestoneProjectId(projectId);
    setNewMilestoneName("");
  };

  const saveMilestone = () => {
    if (!addingMilestoneProjectId || !newMilestoneName.trim()) return;
    createMilestoneMutation.mutate({ projectId: addingMilestoneProjectId, name: newMilestoneName.trim() });
  };

  const startAddTask = (projectId: number, milestoneId: number) => {
    setAddingMilestoneProjectId(null);
    setNewMilestoneName("");
    setAddingTaskTarget({ projectId, milestoneId });
    setNewTaskTitle("");
  };

  const saveTask = () => {
    if (!addingTaskTarget || !newTaskTitle.trim()) return;
    createTaskMutation.mutate({ ...addingTaskTarget, title: newTaskTitle.trim() });
  };

  return (
    <div className="min-h-full bg-background px-2 py-3 @sm:px-4 @sm:py-4">
      <div className="grid gap-3">
        <WorkNewRow onClick={() => setShowCreate(true)} testId="button-create-project">
          New Project
        </WorkNewRow>

        {showCreate && <CreateProjectForm onClose={() => setShowCreate(false)} />}

        {(!projects || projects.length === 0) && !showCreate && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-border/30 bg-card py-12 px-4 text-center">
            <FolderKanban className="h-6 w-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">No projects yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Create one to organize your work.</p>
          </div>
        )}

        {groupedProjects.length > 0 && (
          <div className="grid gap-1">
            {groupedProjects.map(group => (
              <CollapsibleWorkSection
                key={group.status}
                label={group.label}
                defaultOpen={group.status === "active" || group.status === "planning"}
                testId={`section-projects-${group.status}`}
              >
                {group.projects.map(project => (
                  <ProjectTreeNode
                    key={project.id}
                    project={project}
                    tasks={tasksByProject.get(project.id) || []}
                    projects={activeProjects}
                    editingTaskId={editingTaskId}
                    onStartTaskEdit={setEditingTaskId}
                    onStopTaskEdit={() => setEditingTaskId(null)}
                    onUpdateTask={(id, data) => updateTaskMutation.mutate({ id, data })}
                    onDeleteTask={(task) => setPendingDeleteTask({ id: task.id, title: task.title })}
                    onOpenProject={() => setLocation(`/projects/${project.id}`)}
                    addingMilestoneProjectId={addingMilestoneProjectId}
                    newMilestoneName={newMilestoneName}
                    onNewMilestoneNameChange={setNewMilestoneName}
                    onStartAddMilestone={startAddMilestone}
                    onSaveMilestone={saveMilestone}
                    onCancelAddMilestone={() => { setAddingMilestoneProjectId(null); setNewMilestoneName(""); }}
                    addingTaskTarget={addingTaskTarget}
                    newTaskTitle={newTaskTitle}
                    onNewTaskTitleChange={setNewTaskTitle}
                    onStartAddTask={startAddTask}
                    onSaveTask={saveTask}
                    onCancelAddTask={() => { setAddingTaskTarget(null); setNewTaskTitle(""); }}
                    onDeleteProject={() => setPendingDeleteProject({ id: project.id, title: project.title })}
                    onUpdateProject={(data) => updateProjectMutation.mutate({ id: project.id, data })}
                    onUpdateMilestone={(milestoneId, data) => updateMilestoneMutation.mutate({ projectId: project.id, milestoneId, data })}
                  />
                ))}
              </CollapsibleWorkSection>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={!!pendingDeleteProject} onOpenChange={(open) => { if (!open) setPendingDeleteProject(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{pendingDeleteProject?.title}" and all its data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-project">Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const id = pendingDeleteProject?.id;
                setPendingDeleteProject(null);
                if (id) deleteMutation.mutate(id);
              }}
              data-testid="button-confirm-delete-project"
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingDeleteTask} onOpenChange={(open) => { if (!open) setPendingDeleteTask(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete task</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{pendingDeleteTask?.title}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-project-task">Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const id = pendingDeleteTask?.id;
                setPendingDeleteTask(null);
                if (id) deleteTaskMutation.mutate(id);
              }}
              data-testid="button-confirm-delete-project-task"
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MilestoneBar({ milestones }: { milestones: Project["milestones"] }) {
  if (!milestones || milestones.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5" data-testid="milestone-bar">
      {milestones.map((m, i) => (
        <div
          key={m.id || i}
          className={cn(
            "h-1.5 flex-1 rounded-full transition-colors",
            m.status === "completed" ? "bg-success" :
            m.status === "active" ? "bg-info dark:bg-info" :
            "bg-muted"
          )}
          title={`${m.name}: ${m.status}`}
          data-testid={`milestone-segment-${i}`}
        />
      ))}
    </div>
  );
}

function WorkTreeIndent({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <div className="shrink-0 w-5 self-stretch relative mr-1" aria-hidden="true">
      <div className="absolute left-1/2 top-0 bottom-1/2 -translate-x-px border-l border-border" />
      <div className="absolute left-1/2 top-1/2 right-0 border-t border-border" />
    </div>
  );
}

function ProjectTreeNode({
  project,
  tasks,
  projects,
  editingTaskId,
  onStartTaskEdit,
  onStopTaskEdit,
  onUpdateTask,
  onDeleteTask,
  onOpenProject,
  addingMilestoneProjectId,
  newMilestoneName,
  onNewMilestoneNameChange,
  onStartAddMilestone,
  onSaveMilestone,
  onCancelAddMilestone,
  addingTaskTarget,
  newTaskTitle,
  onNewTaskTitleChange,
  onStartAddTask,
  onSaveTask,
  onCancelAddTask,
  onDeleteProject,
  onUpdateProject,
  onUpdateMilestone,
}: {
  project: Project;
  tasks: Task[];
  projects: Project[];
  editingTaskId: number | null;
  onStartTaskEdit: (id: number) => void;
  onStopTaskEdit: () => void;
  onUpdateTask: (id: number, data: any) => void;
  onDeleteTask: (task: Task) => void;
  onOpenProject: () => void;
  addingMilestoneProjectId: number | null;
  newMilestoneName: string;
  onNewMilestoneNameChange: (value: string) => void;
  onStartAddMilestone: (projectId: number) => void;
  onSaveMilestone: () => void;
  onCancelAddMilestone: () => void;
  addingTaskTarget: { projectId: number; milestoneId: number } | null;
  newTaskTitle: string;
  onNewTaskTitleChange: (value: string) => void;
  onStartAddTask: (projectId: number, milestoneId: number) => void;
  onSaveTask: () => void;
  onCancelAddTask: () => void;
  onDeleteProject: () => void;
  onUpdateProject: (data: any) => void;
  onUpdateMilestone: (milestoneId: number, data: Partial<Milestone>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedMilestones, setExpandedMilestones] = useState<Record<number, boolean>>({});
  const [editingProjectDue, setEditingProjectDue] = useState(false);
  const [projectDueDraft, setProjectDueDraft] = useState("");
  const [editingMilestoneDueId, setEditingMilestoneDueId] = useState<number | null>(null);
  const [milestoneDueDraft, setMilestoneDueDraft] = useState("");
  const projectDueLabel = formatWorkDueDate(project.dueDate);
  const isActive = project.status === "active";
  const isAddingMilestone = addingMilestoneProjectId === project.id;
  const sortedMilestones = [...(project.milestones || [])].sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
  const tasksByMilestone = new Map<number, Task[]>();
  const unassignedTasks: Task[] = [];
  tasks.forEach(task => {
    if (task.milestoneId) {
      const bucket = tasksByMilestone.get(task.milestoneId) || [];
      bucket.push(task);
      tasksByMilestone.set(task.milestoneId, bucket);
      return;
    }
    unassignedTasks.push(task);
  });
  const hasChildren = sortedMilestones.length > 0 || unassignedTasks.length > 0 || isAddingMilestone;
  const isMilestoneExpanded = (milestone: Milestone) =>
    expandedMilestones[milestone.id] ?? milestone.status === "active";
  const toggleMilestoneExpanded = (milestone: Milestone) => {
    setExpandedMilestones(prev => ({ ...prev, [milestone.id]: !isMilestoneExpanded(milestone) }));
  };
  const depth = 0;
  const indentPx = Math.min(depth * WORK_INDENT_STEP_PX, WORK_MAX_INDENT_PX);

  return (
    <div className="min-w-0" data-testid={`tree-node-project-${project.id}`}>
      <div className="flex min-w-0 items-stretch" style={{ paddingLeft: indentPx }}>
        <div className="flex-1 min-w-0 relative overflow-hidden">
          <div
            className={cn(
              "group relative flex items-center gap-2 rounded-md px-2 py-1.5 pr-16 text-sm w-full text-left cursor-pointer select-none transition-colors overflow-hidden",
              "hover:bg-accent/70",
              isActive ? "text-foreground font-medium" : "text-muted-foreground"
            )}
            onClick={onOpenProject}
            data-testid={`card-project-${project.id}`}
          >
            <FolderKanban className="h-3.5 w-3.5 shrink-0" data-testid={`icon-project-${project.id}`} />
            <span className="truncate flex-1 min-w-0" data-testid={`text-project-title-${project.id}`}>
              {project.title}
            </span>
            {editingProjectDue ? (
              <Input
                type="date"
                value={projectDueDraft}
                onChange={e => setProjectDueDraft(e.target.value)}
                onBlur={() => {
                  onUpdateProject({ dueDate: projectDueDraft || null });
                  setEditingProjectDue(false);
                }}
                onKeyDown={e => {
                  if (e.key === "Enter") { onUpdateProject({ dueDate: projectDueDraft || null }); setEditingProjectDue(false); }
                  if (e.key === "Escape") setEditingProjectDue(false);
                }}
                onClick={e => e.stopPropagation()}
                className="h-6 text-xs w-32 shrink-0"
                autoFocus
                data-testid={`input-project-due-date-${project.id}`}
              />
            ) : projectDueLabel ? (
              <span
                className="shrink-0 text-xs text-muted-foreground/70 tabular-nums cursor-pointer rounded px-1 -mx-1 hover:bg-accent/70"
                onClick={e => { e.stopPropagation(); setProjectDueDraft(project.dueDate || ""); setEditingProjectDue(true); }}
                data-testid={`text-project-due-date-${project.id}`}
              >
                {projectDueLabel}
              </span>
            ) : (
              <button
                type="button"
                className="shrink-0 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 hover:bg-accent/70 hover:text-muted-foreground"
                onClick={e => { e.stopPropagation(); setProjectDueDraft(""); setEditingProjectDue(true); }}
                data-testid={`button-project-set-due-date-${project.id}`}
              >
                <CalendarDays className="h-3 w-3" />
              </button>
            )}
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex h-6 items-center gap-0.5 pl-1 z-10">
              {hasChildren && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded(value => !value);
                  }}
                  className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors"
                  aria-label={expanded ? "Collapse project tasks" : "Expand project tasks"}
                  data-testid={`button-project-twisty-${project.id}`}
                >
                  <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
                </button>
              )}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground/70 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground hover:bg-accent transition-opacity transition-colors"
                    onClick={(e) => e.stopPropagation()}
                    data-testid={`button-project-menu-${project.id}`}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger data-testid={`menu-project-status-${project.id}`}>
                      <Package className="h-3.5 w-3.5 mr-2" />
                      Status
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {(Object.entries(PROJECT_STATUS_CONFIG) as [ProjectStatus, { label: string }][]).map(([status, cfg]) => (
                        <DropdownMenuItem
                          key={status}
                          onClick={(e) => {
                            e.stopPropagation();
                            onUpdateProject({ status });
                          }}
                          data-testid={`menu-project-status-${status}-${project.id}`}
                        >
                          {project.status === status && <Check className="h-3.5 w-3.5 mr-2" />}
                          {project.status !== status && <span className="w-3.5 mr-2" />}
                          {cfg.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartAddMilestone(project.id);
                      setExpanded(true);
                    }}
                    data-testid={`menu-project-add-milestone-${project.id}`}
                  >
                    <Plus className="h-3.5 w-3.5 mr-2" />
                    Add Milestone
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-error-foreground"
                    onClick={onDeleteProject}
                    data-testid={`menu-project-delete-${project.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>
      {expanded && hasChildren && (
        <div className="space-y-0 mt-0" data-testid={`tree-children-project-${project.id}`}>
          {sortedMilestones.map(milestone => {
            const milestoneTasks = tasksByMilestone.get(milestone.id) || [];
            const isAddingTask = addingTaskTarget?.projectId === project.id && addingTaskTarget.milestoneId === milestone.id;
            const milestoneExpanded = isMilestoneExpanded(milestone);
            const milestoneDueLabel = formatWorkDueDate(milestone.dueDate);
            const milestoneCompleted = milestone.status === "completed";
            return (
              <div key={milestone.id} className="space-y-0">
                <div className="flex min-w-0 items-stretch" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX, WORK_MAX_INDENT_PX) }}>
                  <WorkTreeIndent depth={1} />
                  <div className="flex-1 min-w-0 relative overflow-hidden">
                    <div className="group relative flex items-center gap-2 rounded-md px-2 py-1.5 pr-16 text-sm w-full text-left select-none transition-colors overflow-hidden hover:bg-accent/70" data-testid={`tree-node-milestone-${milestone.id}`}>
                      <WorkCheckCircle checked={milestoneCompleted} data-testid={`check-tree-milestone-${milestone.id}`} />
                      <Flag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className={cn("truncate flex-1 min-w-0", milestoneCompleted && "line-through text-muted-foreground")} data-testid={`text-tree-milestone-name-${milestone.id}`}>
                        {milestone.name}
                      </span>
                      {editingMilestoneDueId === milestone.id ? (
                        <Input
                          type="date"
                          value={milestoneDueDraft}
                          onChange={e => setMilestoneDueDraft(e.target.value)}
                          onBlur={() => {
                            onUpdateMilestone(milestone.id, { dueDate: milestoneDueDraft || null });
                            setEditingMilestoneDueId(null);
                          }}
                          onKeyDown={e => {
                            if (e.key === "Enter") { onUpdateMilestone(milestone.id, { dueDate: milestoneDueDraft || null }); setEditingMilestoneDueId(null); }
                            if (e.key === "Escape") setEditingMilestoneDueId(null);
                          }}
                          onClick={e => e.stopPropagation()}
                          className="h-6 text-xs w-32 shrink-0"
                          autoFocus
                          data-testid={`input-tree-milestone-due-${milestone.id}`}
                        />
                      ) : milestoneDueLabel ? (
                        <span
                          className="shrink-0 text-xs text-muted-foreground/70 tabular-nums cursor-pointer rounded px-1 -mx-1 hover:bg-accent/70"
                          onClick={e => { e.stopPropagation(); setMilestoneDueDraft(milestone.dueDate || ""); setEditingMilestoneDueId(milestone.id); }}
                          data-testid={`text-tree-milestone-due-date-${milestone.id}`}
                        >
                          {milestoneDueLabel}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="shrink-0 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 hover:bg-accent/70 hover:text-muted-foreground"
                          onClick={e => { e.stopPropagation(); setMilestoneDueDraft(""); setEditingMilestoneDueId(milestone.id); }}
                          data-testid={`button-tree-milestone-set-due-${milestone.id}`}
                        >
                          <CalendarDays className="h-3 w-3" />
                        </button>
                      )}
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex h-6 items-center gap-0.5 pl-1 z-10">
                        {milestoneTasks.length > 0 && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); toggleMilestoneExpanded(milestone); }}
                            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors"
                            aria-label={milestoneExpanded ? "Collapse milestone tasks" : "Expand milestone tasks"}
                            data-testid={`button-tree-milestone-twisty-${milestone.id}`}
                          >
                            <ChevronRight className={cn("h-3 w-3 transition-transform", milestoneExpanded && "rotate-90")} />
                          </button>
                        )}
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground/70 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground hover:bg-accent transition-opacity transition-colors"
                              onClick={(e) => e.stopPropagation()}
                              data-testid={`button-tree-milestone-menu-${milestone.id}`}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger data-testid={`menu-tree-milestone-status-${milestone.id}`}>
                                <Package className="h-3.5 w-3.5 mr-2" />
                                Status
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                {(["planned", "active", "completed"] as MilestoneStatus[]).map(status => (
                                  <DropdownMenuItem
                                    key={status}
                                    onClick={(e) => { e.stopPropagation(); onUpdateMilestone(milestone.id, { status }); }}
                                    data-testid={`menu-tree-milestone-status-${status}-${milestone.id}`}
                                  >
                                    {milestone.status === status ? <Check className="h-3.5 w-3.5 mr-2" /> : <span className="w-3.5 mr-2" />}
                                    {status.charAt(0).toUpperCase() + status.slice(1)}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                onStartAddTask(project.id, milestone.id);
                                setExpandedMilestones(prev => ({ ...prev, [milestone.id]: true }));
                              }}
                              data-testid={`menu-tree-milestone-add-task-${milestone.id}`}
                            >
                              <Plus className="h-3.5 w-3.5 mr-2" />
                              Add Task
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </div>
                </div>
                {isAddingTask && (
                  <div className="flex min-w-0 items-stretch" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX * 2, WORK_MAX_INDENT_PX) }}>
                    <WorkTreeIndent depth={1} />
                    <div className="flex-1 min-w-0 flex items-center gap-2 py-1 pr-2">
                      <Input
                        value={newTaskTitle}
                        onChange={e => onNewTaskTitleChange(e.target.value)}
                        placeholder="Task name"
                        className="h-7 text-xs flex-1"
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === "Enter") onSaveTask();
                          if (e.key === "Escape") onCancelAddTask();
                        }}
                        data-testid={`input-tree-new-task-${milestone.id}`}
                      />
                      <Button size="sm" onClick={onSaveTask} disabled={!newTaskTitle.trim()} data-testid={`button-tree-save-task-${milestone.id}`}>Add</Button>
                      <Button size="sm" variant="ghost" onClick={onCancelAddTask}>Cancel</Button>
                    </div>
                  </div>
                )}
                {milestoneExpanded && milestoneTasks.map(task => (
                  <div key={task.id} className="flex min-w-0 items-stretch" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX * 2, WORK_MAX_INDENT_PX) }}>
                    <WorkTreeIndent depth={1} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <TaskRow
                        task={task}
                        project={project}
                        isEditing={editingTaskId === task.id}
                        onStartEdit={() => onStartTaskEdit(task.id)}
                        onStopEdit={onStopTaskEdit}
                        onUpdate={(data) => onUpdateTask(task.id, data)}
                        onDelete={() => onDeleteTask(task)}
                        projects={projects}
                        isDone={task.status === "done"}
                        hideProjectAssign
                      />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          {isAddingMilestone && (
            <div className="flex min-w-0 items-stretch" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX, WORK_MAX_INDENT_PX) }}>
              <WorkTreeIndent depth={1} />
              <div className="flex-1 min-w-0 flex items-center gap-2 py-1 pr-2">
                <Input
                  value={newMilestoneName}
                  onChange={e => onNewMilestoneNameChange(e.target.value)}
                  placeholder="Milestone name"
                  className="h-7 text-xs flex-1"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") onSaveMilestone();
                    if (e.key === "Escape") onCancelAddMilestone();
                  }}
                  data-testid={`input-tree-new-milestone-${project.id}`}
                />
                <Button size="sm" onClick={onSaveMilestone} disabled={!newMilestoneName.trim()} data-testid={`button-tree-save-milestone-${project.id}`}>Add</Button>
                <Button size="sm" variant="ghost" onClick={onCancelAddMilestone}>Cancel</Button>
              </div>
            </div>
          )}
          {unassignedTasks.map(task => (
            <div key={task.id} className="flex min-w-0 items-stretch" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX, WORK_MAX_INDENT_PX) }}>
              <WorkTreeIndent depth={1} />
              <div className="flex-1 min-w-0 relative overflow-hidden">
                <TaskRow
                  task={task}
                  project={project}
                  isEditing={editingTaskId === task.id}
                  onStartEdit={() => onStartTaskEdit(task.id)}
                  onStopEdit={onStopTaskEdit}
                  onUpdate={(data) => onUpdateTask(task.id, data)}
                  onDelete={() => onDeleteTask(task)}
                  projects={projects}
                  isDone={task.status === "done"}
                  hideProjectAssign
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateProjectForm({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<PriorityLevel>("mid");
  const [owner, setOwner] = useState<"me" | "agent">("me");
  const [dueDate, setDueDate] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [spec, setSpec] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/projects/projects", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
      toast({ title: "Project created" });
      onClose();
    },
    onError: (err: any) => {
      log.error("create project failed:", err);
      toast({ title: "Failed to create project", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const tags = tagsInput.split(",").map(t => t.trim()).filter(Boolean);
    createMutation.mutate({
      title: title.trim(),
      priority,
      owner,
      dueDate: dueDate || null,
      tags,
      spec,
    });
  };

  return (
    <Card className="p-4 space-y-3" data-testid="form-create-project">
      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          ref={titleRef}
          placeholder="Project name"
          value={title}
          onChange={e => setTitle(e.target.value)}
          data-testid="input-project-title"
        />

        <div className="flex items-center gap-2 flex-wrap">
          <Select value={priority} onValueChange={(v) => setPriority(v as PriorityLevel)}>
            <SelectTrigger className="w-24 h-8 text-xs" data-testid="select-project-priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="mid">Mid</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>

          <Select value={owner} onValueChange={(v) => setOwner(v as "me" | "agent")}>
            <SelectTrigger className="w-24 h-8 text-xs" data-testid="select-project-owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="me">Me</SelectItem>
              <SelectItem value="agent">{getInstanceName()}</SelectItem>
            </SelectContent>
          </Select>

          <Input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            className="w-36 h-8 text-xs"
            data-testid="input-project-due-date"
          />
        </div>

        <Input
          placeholder="Tags (comma separated)"
          value={tagsInput}
          onChange={e => setTagsInput(e.target.value)}
          className="h-8 text-xs"
          data-testid="input-project-tags"
        />

        <Textarea
          placeholder="Project spec — define it clearly and unambiguously..."
          value={spec}
          onChange={e => setSpec(e.target.value)}
          className="text-xs min-h-[80px]"
          data-testid="textarea-project-spec"
        />

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} data-testid="button-cancel-project">
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!title.trim() || createMutation.isPending} data-testid="button-save-project">
            {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create"}
          </Button>
        </div>
      </form>
    </Card>
  );
}


export function ProjectDetail({
  projectId,
  onBack,
  initialShowAddMilestone = false,
}: {
  projectId: number;
  onBack: () => void;
  initialShowAddMilestone?: boolean;
}) {
  const { timezone } = useTimezone();
  const { toast } = useToast();
  const [activityInput, setActivityInput] = useState("");
  const [editingSpec, setEditingSpec] = useState(false);
  const [specDraft, setSpecDraft] = useState("");
  const [showAddMilestone, setShowAddMilestone] = useState(initialShowAddMilestone);
  const [milestoneName, setMilestoneName] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingMilestoneId, setEditingMilestoneId] = useState<number | null>(null);
  const [milestoneNameDraft, setMilestoneNameDraft] = useState("");
  const [pendingDeleteMilestone, setPendingDeleteMilestone] = useState<{ id: number; name: string } | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [pendingDeleteTask, setPendingDeleteTask] = useState<{ id: number; title: string } | null>(null);
  const [addingTaskToMilestoneId, setAddingTaskToMilestoneId] = useState<number | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [editingMilestoneDueId, setEditingMilestoneDueId] = useState<number | null>(null);
  const [milestoneDueDraft, setMilestoneDueDraft] = useState("");
  const [milestoneTasksExpanded, setMilestoneTasksExpanded] = useState<Record<string, boolean>>({});
  const [expandedMilestones, setExpandedMilestones] = useState<Record<number, boolean>>({});
  const [addingNote, setAddingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteDraft, setEditingNoteDraft] = useState("");
  const [uploadingFile, setUploadingFile] = useState(false);
  const [editingDueDate, setEditingDueDate] = useState(false);
  const [dueDateDraft, setDueDateDraft] = useState("");

  const { data: project, isLoading } = useQuery<Project>({
    queryKey: ["/api/projects/projects", projectId],
  });

  const { data: tasks } = useQuery<Task[]>({
    queryKey: ["/api/projects/tasks"],
  });

  const projectTasks = useMemo(() => {
    return tasks?.filter(t => t.projectId === projectId) || [];
  }, [tasks, projectId]);

  const tasksByMilestone = useMemo(() => {
    const unassigned: Task[] = [];
    const byMilestone: Record<number, Task[]> = {};
    const milestoneNameMap = new Map<string, number>();
    (project?.milestones || []).forEach(m => milestoneNameMap.set(m.name.toLowerCase(), m.id));

    projectTasks.forEach(task => {
      const resolvedId = task.milestoneId;
      if (resolvedId) {
        if (!byMilestone[resolvedId]) byMilestone[resolvedId] = [];
        byMilestone[resolvedId].push(task);
      } else {
        unassigned.push(task);
      }
    });

    return { unassigned, byMilestone };
  }, [projectTasks, project?.milestones]);

  const sortedMilestones = useMemo(() => {
    if (!project) return [];
    return [...(project.milestones || [])].sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;
      return (a.order ?? 0) - (b.order ?? 0);
    });
  }, [project]);

  const currentMilestoneId = useMemo(() => {
    const active = sortedMilestones.find(m => m.status === "active");
    if (active) return active.id;
    const planned = sortedMilestones.find(m => m.status === "planned");
    if (planned) return planned.id;
    return sortedMilestones[0]?.id ?? null;
  }, [sortedMilestones]);

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PATCH", `/api/projects/projects/${projectId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", projectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
    },
  });

  const addMilestoneMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", `/api/projects/projects/${projectId}/milestones`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", projectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
      setMilestoneName("");
      setShowAddMilestone(false);
    },
  });

  const updateMilestoneMutation = useMutation({
    mutationFn: ({ milestoneId, data }: { milestoneId: number; data: any }) =>
      apiRequest("PATCH", `/api/projects/projects/${projectId}/milestones/${milestoneId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", projectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
    },
  });

  const removeMilestoneMutation = useMutation({
    mutationFn: (milestoneId: number) =>
      apiRequest("DELETE", `/api/projects/projects/${projectId}/milestones/${milestoneId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", projectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
    },
  });

  const activityMutation = useMutation({
    mutationFn: (message: string) => apiRequest("POST", `/api/projects/projects/${projectId}/activity`, { message, author: "me" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", projectId] });
      setActivityInput("");
    },
  });

  const deleteProjectMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/projects/projects/${projectId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
      toast({ title: "Project deleted" });
      onBack();
    },
  });

  const taskUpdateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PATCH", `/api/projects/tasks/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/tasks"] });
    },
  });

  const taskDeleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/projects/tasks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/tasks"] });
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/projects/tasks", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/tasks"] });
      setNewTaskTitle("");
      setAddingTaskToMilestoneId(null);
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: (content: string) => apiRequest("POST", `/api/projects/projects/${projectId}/notes`, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", projectId] });
      setNoteDraft("");
      setAddingNote(false);
    },
  });

  const updateNoteMutation = useMutation({
    mutationFn: ({ noteId, content }: { noteId: string; content: string }) =>
      apiRequest("PATCH", `/api/projects/projects/${projectId}/notes/${noteId}`, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", projectId] });
      setEditingNoteId(null);
      setEditingNoteDraft("");
    },
  });

  const removeNoteMutation = useMutation({
    mutationFn: (noteId: string) => apiRequest("DELETE", `/api/projects/projects/${projectId}/notes/${noteId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", projectId] });
    },
  });

  const addFileMutation = useMutation({
    mutationFn: (data: { name: string; mimeType: string; objectKey: string; size: number }) =>
      apiRequest("POST", `/api/projects/projects/${projectId}/files`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", projectId] });
      setUploadingFile(false);
    },
  });

  const removeFileMutation = useMutation({
    mutationFn: (fileId: string) => apiRequest("DELETE", `/api/projects/projects/${projectId}/files/${fileId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", projectId] });
    },
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFile(true);
    try {
      const urlRes = await apiRequest("POST", `/api/projects/projects/${projectId}/files/upload-url`);
      const { uploadURL, objectPath } = await urlRes.json();
      await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      await addFileMutation.mutateAsync({ name: file.name, mimeType: file.type, objectKey: objectPath, size: file.size });
    } catch (err: any) {
      log.error("file upload failed:", err);
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
      setUploadingFile(false);
    }
  };

  const { data: allProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects/projects"],
  });

  if (isLoading || !project) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const handleSaveSpec = () => {
    updateMutation.mutate({ spec: specDraft });
    setEditingSpec(false);
  };

  const handleAddMilestone = () => {
    if (!milestoneName.trim()) return;
    addMilestoneMutation.mutate({
      name: milestoneName.trim(),
    });
  };

  const toggleMilestoneCompleted = (milestone: Milestone) => {
    const next = milestone.status === "completed" ? "planned" : "completed";
    updateMilestoneMutation.mutate({ milestoneId: milestone.id, data: { status: next } });
  };

  const isMilestoneExpanded = (mId: number) => {
    if (mId in expandedMilestones) return expandedMilestones[mId];
    return mId === currentMilestoneId;
  };

  const toggleMilestoneExpanded = (mId: number) => {
    setExpandedMilestones(prev => ({ ...prev, [mId]: !isMilestoneExpanded(mId) }));
  };

  const toggleMilestoneSection = (key: string) => {
    setMilestoneTasksExpanded(prev => {
      const parts = key.split("-");
      const statusKey = parts[parts.length - 1];
      const defaultOpen = statusKey === "ready" || statusKey === "active";
      const current = key in prev ? prev[key] : defaultOpen;
      return { ...prev, [key]: !current };
    });
  };

  const renderGroupedTasks = (tasks: Task[], keyPrefix: string) => {
    const grouped = groupTasksByStatus(tasks);
    const sections: { key: string; label: string; tasks: Task[]; isDone?: boolean }[] = [
      { key: "ready", label: "Ready", tasks: grouped.ready },
      { key: "active", label: "Active", tasks: grouped.active },
      { key: "on_hold", label: "On Hold", tasks: grouped.on_hold },
      { key: "done", label: "Done", tasks: grouped.done, isDone: true },
    ];
    return sections.filter(s => s.tasks.length > 0).map(section => {
      const expandKey = `${keyPrefix}-${section.key}`;
      const defaultOpen = section.key === "ready" || section.key === "active";
      const isExpanded = expandKey in milestoneTasksExpanded ? milestoneTasksExpanded[expandKey] : defaultOpen;
      return (
        <Collapsible key={section.key} open={isExpanded} onOpenChange={() => toggleMilestoneSection(expandKey)}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 text-xs text-muted-foreground py-1 hover-elevate rounded-md px-2 w-full"
              data-testid={`button-toggle-${expandKey}`}
            >
              {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <span>{section.label} ({section.tasks.length})</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-0 mt-0">
            {section.tasks.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                project={undefined}
                isEditing={editingTaskId === task.id}
                onStartEdit={() => setEditingTaskId(task.id)}
                onStopEdit={() => setEditingTaskId(null)}
                onUpdate={(data) => taskUpdateMutation.mutate({ id: task.id, data })}
                onDelete={() => setPendingDeleteTask({ id: task.id, title: task.title })}
                projects={allProjects || []}
                isDone={section.isDone}
                hideProjectAssign
              />
            ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      );
    });
  };

  return (
    <div className="p-4 space-y-4 w-full">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="button-back-projects">
          <ChevronRight className="h-3.5 w-3.5 rotate-180" />
          Back
        </Button>
      </div>

      <div className="space-y-2">
        {editingTitle ? (
          <Input
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                if (titleDraft.trim() && titleDraft.trim() !== project.title) {
                  updateMutation.mutate({ title: titleDraft.trim() });
                }
                setEditingTitle(false);
              }
              if (e.key === "Escape") setEditingTitle(false);
            }}
            onBlur={() => {
              if (titleDraft.trim() && titleDraft.trim() !== project.title) {
                updateMutation.mutate({ title: titleDraft.trim() });
              }
              setEditingTitle(false);
            }}
            className="text-lg font-semibold h-auto py-0.5"
            autoFocus
            data-testid="input-project-detail-title"
          />
        ) : (
          <h2
            className="text-lg font-semibold cursor-pointer rounded-md px-1 -mx-1 hover-elevate"
            onClick={() => { setTitleDraft(project.title); setEditingTitle(true); }}
            data-testid="text-project-detail-title"
          >
            {project.title}
          </h2>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <Select
            value={project.status}
            onValueChange={(v) => updateMutation.mutate({ status: v as any })}
          >
            <SelectTrigger
              className={cn("h-7 w-auto min-w-[100px] text-xs gap-1 border-none", PROJECT_STATUS_CONFIG[project.status].className)}
              data-testid="select-project-detail-status"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["idea", "planning", "active", "on_hold", "completed"] as ProjectStatus[]).map(s => (
                <SelectItem key={s} value={s} data-testid={`option-status-${s}`}>
                  {PROJECT_STATUS_CONFIG[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AttributePicker
            value={project.priority}
            options={PRIORITY_OPTIONS}
            onChange={(v) => updateMutation.mutate({ priority: v })}
            testId="attr-project-detail-priority"
            icon={Flag}
          />
          <OwnerPicker
            value={project.owner}
            onChange={(v) => updateMutation.mutate({ owner: v })}
            testId="badge-project-detail-owner"
          />
          {editingDueDate ? (
            <Input
              type="date"
              value={dueDateDraft}
              onChange={e => setDueDateDraft(e.target.value)}
              onBlur={() => {
                updateMutation.mutate({ dueDate: dueDateDraft || null });
                setEditingDueDate(false);
              }}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  updateMutation.mutate({ dueDate: dueDateDraft || null });
                  setEditingDueDate(false);
                }
                if (e.key === "Escape") setEditingDueDate(false);
              }}
              className="h-7 text-xs w-32 shrink-0"
              autoFocus
              data-testid="input-project-due-date"
            />
          ) : project.dueDate ? (
            <Badge
              variant="outline"
              className="text-xs gap-1 cursor-pointer"
              onClick={() => { setDueDateDraft(project.dueDate || ""); setEditingDueDate(true); }}
              data-testid="badge-project-due-date"
            >
              <Calendar className="h-3 w-3" />
              {formatRelativeDate(project.dueDate, timezone, project.status === "completed")}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-xs gap-1 cursor-pointer text-muted-foreground/50"
              onClick={() => { setDueDateDraft(""); setEditingDueDate(true); }}
              data-testid="badge-project-set-due-date"
            >
              <Calendar className="h-3 w-3" />
              Set due date
            </Badge>
          )}
          {project.requiresReview && (
            <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate">Review required</Badge>
          )}
          {project.people && project.people.length > 0 && project.people.map(p => (
            <Badge
              key={p}
              variant="outline"
              className="text-xs gap-1 no-default-hover-elevate no-default-active-elevate cursor-pointer"
              onClick={() => updateMutation.mutate({ people: project.people.filter(x => x !== p) })}
              data-testid={`badge-project-person-${p}`}
            >
              <Users className="h-3 w-3" />
              {p}
              <X className="h-2.5 w-2.5 ml-0.5" />
            </Badge>
          ))}
          <PeopleSelector
            selected={project.people || []}
            onChange={(people) => updateMutation.mutate({ people })}
          />
          <GoalSelector
            goalId={project.goalId}
            onChange={(goalId) => updateMutation.mutate({ goalId })}
          />
        </div>
      </div>

      <Card className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Spec</span>
        </div>
        {editingSpec ? (
          <div className="space-y-2">
            <Textarea
              value={specDraft}
              onChange={e => setSpecDraft(e.target.value)}
              className="text-sm min-h-[400px] font-mono"
              autoFocus
              data-testid="textarea-edit-spec"
            />
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditingSpec(false)}>Cancel</Button>
              <Button size="sm" onClick={handleSaveSpec} data-testid="button-save-spec">Save</Button>
            </div>
          </div>
        ) : (
          <div
            className="cursor-pointer rounded-md p-2 -m-1 hover-elevate transition-colors min-h-[40px]"
            onClick={() => { setSpecDraft(project.spec); setEditingSpec(true); }}
            data-testid="text-project-spec"
          >
            {project.spec ? (
              <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-sm prose-headings:font-semibold prose-p:text-sm prose-p:text-muted-foreground prose-li:text-sm prose-li:text-muted-foreground">
                <ReactMarkdown>{project.spec}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground/50 italic">Click to add a spec...</p>
            )}
          </div>
        )}
      </Card>

      <Card className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Milestones</span>
          <Button size="icon" variant="ghost" onClick={() => setShowAddMilestone(true)} data-testid="button-add-milestone">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <MilestoneBar milestones={sortedMilestones} />
        {sortedMilestones.map((m) => {
          const milestoneExpanded = isMilestoneExpanded(m.id);
          const milestoneTasks = tasksByMilestone.byMilestone[m.id] || [];
          const taskCount = milestoneTasks.length;
          return (
          <Collapsible key={m.id} open={milestoneExpanded} onOpenChange={() => toggleMilestoneExpanded(m.id)}>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm">
                <CollapsibleTrigger asChild>
                  <button type="button" className="shrink-0" data-testid={`button-toggle-milestone-${m.id}`}>
                    {milestoneExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                </CollapsibleTrigger>
                <button
                  type="button"
                  onClick={() => toggleMilestoneCompleted(m)}
                  className={cn(
                    "h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors",
                    m.status === "completed" ? "border-success bg-success/20" :
                    "border-muted-foreground/30"
                  )}
                  data-testid={`button-milestone-status-${m.id}`}
                >
                  {m.status === "completed" && <Check className="h-2.5 w-2.5 text-success-foreground" />}
                </button>
                {editingMilestoneId === m.id ? (
                  <Input
                    value={milestoneNameDraft}
                    onChange={e => setMilestoneNameDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        if (milestoneNameDraft.trim() && milestoneNameDraft.trim() !== m.name) {
                          updateMilestoneMutation.mutate({ milestoneId: m.id, data: { name: milestoneNameDraft.trim() } });
                        }
                        setEditingMilestoneId(null);
                      }
                      if (e.key === "Escape") setEditingMilestoneId(null);
                    }}
                    onBlur={() => {
                      if (milestoneNameDraft.trim() && milestoneNameDraft.trim() !== m.name) {
                        updateMilestoneMutation.mutate({ milestoneId: m.id, data: { name: milestoneNameDraft.trim() } });
                      }
                      setEditingMilestoneId(null);
                    }}
                    className="flex-1 min-w-0 h-auto py-0 text-sm"
                    autoFocus
                    data-testid={`input-milestone-name-${m.id}`}
                  />
                ) : (
                  <span
                    className={cn("flex-1 min-w-0 truncate cursor-pointer rounded px-1 -mx-1 hover-elevate", m.status === "completed" && "line-through text-muted-foreground")}
                    onClick={() => { setMilestoneNameDraft(m.name); setEditingMilestoneId(m.id); }}
                    data-testid={`text-milestone-name-${m.id}`}
                  >
                    {m.name}
                  </span>
                )}
                {!milestoneExpanded && taskCount > 0 && (
                  <span className="text-xs text-muted-foreground/60 shrink-0">{taskCount}</span>
                )}
                {editingMilestoneDueId === m.id ? (
                  <Input
                    type="date"
                    value={milestoneDueDraft}
                    onChange={e => setMilestoneDueDraft(e.target.value)}
                    onBlur={() => {
                      updateMilestoneMutation.mutate({ milestoneId: m.id, data: { dueDate: milestoneDueDraft || null } });
                      setEditingMilestoneDueId(null);
                    }}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        updateMilestoneMutation.mutate({ milestoneId: m.id, data: { dueDate: milestoneDueDraft || null } });
                        setEditingMilestoneDueId(null);
                      }
                      if (e.key === "Escape") setEditingMilestoneDueId(null);
                    }}
                    className="h-7 text-xs w-32 shrink-0"
                    autoFocus
                    data-testid={`input-milestone-due-${m.id}`}
                  />
                ) : (
                  <span
                    className="text-xs text-muted-foreground flex items-center gap-1 shrink-0 cursor-pointer rounded px-1 hover-elevate"
                    onClick={() => { setMilestoneDueDraft(m.dueDate || ""); setEditingMilestoneDueId(m.id); }}
                    data-testid={`text-milestone-due-${m.id}`}
                  >
                    <Calendar className="h-3 w-3" />
                    {m.dueDate ? formatDateOnly(m.dueDate, timezone, { month: "short", day: "numeric" }) : "Set date"}
                  </span>
                )}
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={(e) => e.stopPropagation()}
                      data-testid={`button-milestone-menu-${m.id}`}
                    >
                      <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        setAddingTaskToMilestoneId(m.id);
                        setNewTaskTitle("");
                        if (!milestoneExpanded) toggleMilestoneExpanded(m.id);
                      }}
                      data-testid={`menu-milestone-add-task-${m.id}`}
                    >
                      <Plus className="h-3.5 w-3.5 mr-2" />
                      Add Task
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-error-foreground"
                      onClick={() => setPendingDeleteMilestone({ id: m.id, name: m.name })}
                      data-testid={`menu-milestone-delete-${m.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <CollapsibleContent>
                {addingTaskToMilestoneId === m.id && (
                  <div className="@sm:ml-6 flex items-center gap-2">
                    <Input
                      value={newTaskTitle}
                      onChange={e => setNewTaskTitle(e.target.value)}
                      placeholder="New task..."
                      className="h-7 text-sm flex-1"
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === "Enter" && newTaskTitle.trim()) {
                          createTaskMutation.mutate({ title: newTaskTitle.trim(), projectId, milestoneId: m.id });
                        }
                        if (e.key === "Escape") { setAddingTaskToMilestoneId(null); setNewTaskTitle(""); }
                      }}
                      data-testid={`input-new-task-milestone-${m.id}`}
                    />
                    <Button size="sm" disabled={!newTaskTitle.trim()} onClick={() => createTaskMutation.mutate({ title: newTaskTitle.trim(), projectId, milestoneId: m.id })} data-testid={`button-save-task-milestone-${m.id}`}>
                      Add
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setAddingTaskToMilestoneId(null); setNewTaskTitle(""); }}>Cancel</Button>
                  </div>
                )}
                {milestoneTasks.length > 0 && (
                  <div className="@sm:ml-6 space-y-1">
                    {renderGroupedTasks(milestoneTasks, `m-${m.id}`)}
                  </div>
                )}
              </CollapsibleContent>
            </div>
          </Collapsible>
          );
        })}
        {showAddMilestone && (
          <div className="flex items-center gap-2">
            <Input
              placeholder="Milestone name"
              value={milestoneName}
              onChange={e => setMilestoneName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleAddMilestone(); if (e.key === "Escape") { setShowAddMilestone(false); setMilestoneName(""); } }}
              className="h-7 text-xs flex-1"
              autoFocus
              data-testid="input-milestone-name"
            />
            <Button size="sm" onClick={handleAddMilestone} disabled={!milestoneName.trim()} data-testid="button-save-milestone">
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowAddMilestone(false); setMilestoneName(""); }}>Cancel</Button>
          </div>
        )}
        {(project.milestones || []).length === 0 && !showAddMilestone && (
          <p className="text-xs text-muted-foreground">No milestones yet.</p>
        )}
      </Card>

      {tasksByMilestone.unassigned.length > 0 && (
        <Card className="p-3 space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Unassigned Tasks ({tasksByMilestone.unassigned.length})</span>
          {renderGroupedTasks(tasksByMilestone.unassigned, "unassigned")}
        </Card>
      )}

      {projectTasks.length === 0 && (
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">No tasks linked to this project.</p>
        </Card>
      )}

      <Card className="p-3 space-y-3" data-testid="section-notes">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <StickyNote className="h-3.5 w-3.5" />
            Notes {project.notes.length > 0 && `(${project.notes.length})`}
          </span>
          {!addingNote && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => { setAddingNote(true); setNoteDraft(""); }} data-testid="button-add-note">
              <Plus className="h-3 w-3 mr-1" />
              Add
            </Button>
          )}
        </div>

        {addingNote && (
          <div className="space-y-2" data-testid="note-editor-new">
            <Textarea
              value={noteDraft}
              onChange={e => setNoteDraft(e.target.value)}
              placeholder="Write a note (markdown supported)..."
              className="text-sm min-h-[80px] resize-y"
              autoFocus
              data-testid="textarea-new-note"
            />
            <div className="flex items-center gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => { setAddingNote(false); setNoteDraft(""); }}>Cancel</Button>
              <Button size="sm" disabled={!noteDraft.trim() || addNoteMutation.isPending} onClick={() => addNoteMutation.mutate(noteDraft.trim())} data-testid="button-save-note">
                {addNoteMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Save
              </Button>
            </div>
          </div>
        )}

        {project.notes.length === 0 && !addingNote && (
          <p className="text-xs text-muted-foreground">No notes yet.</p>
        )}

        <div className="space-y-2">
          {project.notes.map(note => (
            <div key={note.id} className="group rounded-lg border border-border/50 p-3" data-testid={`note-${note.id}`}>
              {editingNoteId === note.id ? (
                <div className="space-y-2">
                  <Textarea
                    value={editingNoteDraft}
                    onChange={e => setEditingNoteDraft(e.target.value)}
                    className="text-sm min-h-[80px] resize-y"
                    autoFocus
                    data-testid={`textarea-edit-note-${note.id}`}
                  />
                  <div className="flex items-center gap-2 justify-end">
                    <Button size="sm" variant="ghost" onClick={() => { setEditingNoteId(null); setEditingNoteDraft(""); }}>Cancel</Button>
                    <Button size="sm" disabled={!editingNoteDraft.trim() || updateNoteMutation.isPending} onClick={() => updateNoteMutation.mutate({ noteId: note.id, content: editingNoteDraft.trim() })} data-testid={`button-update-note-${note.id}`}>
                      {updateNoteMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="prose prose-sm dark:prose-invert max-w-none text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                    <ReactMarkdown>{note.content}</ReactMarkdown>
                  </div>
                  <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-border/30">
                    <span className="text-xs text-muted-foreground/60">
                      {formatDateTime(note.createdAt, timezone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => { setEditingNoteId(note.id); setEditingNoteDraft(note.content); }} data-testid={`button-edit-note-${note.id}`}>
                        <Pencil className="h-3 w-3 text-muted-foreground" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => removeNoteMutation.mutate(note.id)} data-testid={`button-delete-note-${note.id}`}>
                        <Trash2 className="h-3 w-3 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-3 space-y-3" data-testid="section-files">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            Files {project.files.length > 0 && `(${project.files.length})`}
          </span>
          <label>
            <input type="file" className="hidden" onChange={handleFileUpload} disabled={uploadingFile} data-testid="input-file-upload" />
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" asChild disabled={uploadingFile}>
              <span>
                {uploadingFile ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Upload className="h-3 w-3 mr-1" />}
                Upload
              </span>
            </Button>
          </label>
        </div>

        {project.files.length === 0 && (
          <p className="text-xs text-muted-foreground">No files yet.</p>
        )}

        {project.files.length > 0 && (
          <div className="grid grid-cols-3 @sm:grid-cols-4 @md:grid-cols-5 gap-2">
            {project.files.map(file => {
              const isImage = file.mimeType.startsWith("image/");
              return (
                <div key={file.id} className="group relative rounded-lg border border-border/50 overflow-hidden" data-testid={`file-${file.id}`}>
                  <div className="aspect-square flex items-center justify-center bg-muted/30">
                    {isImage ? (
                      <img
                        src={`/objects/${file.objectKey.replace(/^\/objects\//, "")}?name=${encodeURIComponent(file.name)}`}
                        alt={file.name}
                        className="w-full h-full object-cover"
                        data-testid={`file-preview-${file.id}`}
                      />
                    ) : (
                      <FileIcon className="h-8 w-8 text-muted-foreground/50" />
                    )}
                  </div>
                  <div className="px-1.5 py-1 border-t border-border/30">
                    <p className="text-xs text-muted-foreground truncate" title={file.name}>{file.name}</p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="absolute top-1 right-1 h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity bg-background/80"
                        data-testid={`button-file-menu-${file.id}`}
                      >
                        <MoreHorizontal className="h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <a
                          href={`/objects/${file.objectKey.replace(/^\/objects\//, "")}?name=${encodeURIComponent(file.name)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          download={file.name}
                          data-testid={`button-download-file-${file.id}`}
                        >
                          <Download className="h-3.5 w-3.5 mr-2" />
                          Download
                        </a>
                      </DropdownMenuItem>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <DropdownMenuItem
                            className="text-destructive"
                            onSelect={(e) => e.preventDefault()}
                            data-testid={`button-delete-file-${file.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete file</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently delete "{file.name}". This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel data-testid={`button-cancel-delete-file-${file.id}`}>Cancel</AlertDialogCancel>
                            <Button
                              variant="destructive"
                              onClick={() => removeFileMutation.mutate(file.id)}
                              data-testid={`button-confirm-delete-file-${file.id}`}
                            >
                              Delete
                            </Button>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="p-3 space-y-3">
        <span className="text-xs font-medium text-muted-foreground">Activity</span>

        <div className="space-y-2 max-h-64 overflow-y-auto">
          {project.activity.length === 0 && (
            <p className="text-xs text-muted-foreground">No activity yet.</p>
          )}
          {project.activity.map((entry, i) => (
            <div
              key={i}
              className={cn(
                "flex gap-2",
                entry.author === "agent" ? "flex-row" : "flex-row-reverse"
              )}
              data-testid={`activity-entry-${i}`}
            >
              <div className="shrink-0 mt-0.5">
                {entry.author === "agent" ? (
                  <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center">
                    <Bot className="h-3 w-3 text-muted-foreground" />
                  </div>
                ) : (
                  <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center">
                    <User className="h-3 w-3 text-muted-foreground" />
                  </div>
                )}
              </div>
              <div className={cn(
                "rounded-lg px-3 py-1.5 text-xs max-w-[80%]",
                entry.author === "agent"
                  ? "bg-muted text-foreground"
                  : "bg-primary/10 text-foreground"
              )}>
                <p className="whitespace-pre-wrap">{entry.message}</p>
                <span className="text-xs text-muted-foreground/60 mt-1 block">
                  {formatDateTime(entry.timestamp, timezone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
            </div>
          ))}
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); if (activityInput.trim()) activityMutation.mutate(activityInput.trim()); }}
          className="flex items-center gap-2"
        >
          <Input
            placeholder="Leave a note..."
            value={activityInput}
            onChange={e => setActivityInput(e.target.value)}
            className="flex-1 h-8 text-xs"
            data-testid="input-activity-message"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!activityInput.trim() || activityMutation.isPending}
            data-testid="button-send-activity"
          >
            {activityMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </form>
      </Card>

      <div className="flex justify-end pt-2">
        <ConfirmDeleteProjectDialog projectTitle={project.title} onConfirm={() => deleteProjectMutation.mutate()}>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            data-testid="button-delete-project"
          >
            <Trash2 className="h-3 w-3 mr-1" />
            Delete project
          </Button>
        </ConfirmDeleteProjectDialog>
      </div>

      <AlertDialog open={!!pendingDeleteMilestone} onOpenChange={(open) => { if (!open) setPendingDeleteMilestone(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete milestone</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{pendingDeleteMilestone?.name}". Tasks assigned to it will become unassigned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-milestone">Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const id = pendingDeleteMilestone?.id;
                setPendingDeleteMilestone(null);
                if (id) removeMilestoneMutation.mutate(id);
              }}
              data-testid="button-confirm-delete-milestone"
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingDeleteTask} onOpenChange={(open) => { if (!open) setPendingDeleteTask(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete task</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{pendingDeleteTask?.title}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-project-task">Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const id = pendingDeleteTask?.id;
                setPendingDeleteTask(null);
                if (id) taskDeleteMutation.mutate(id);
              }}
              data-testid="button-confirm-delete-project-task"
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
