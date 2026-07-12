// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useMemo, useRef, useEffect } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useSearch, useLocation } from "wouter";
import { useFocusContext } from "@/hooks/use-focus-context";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getInstanceName } from "@/lib/instance-config";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { InlineDatePicker } from "@/components/inline-date-picker";
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
  DialogDescription,
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
  Search as SearchIcon,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTimezone, formatDate as tzFormatDate, formatDateTime, formatDateOnly } from "@/hooks/use-timezone";
import { localDayDiff } from "@/lib/local-date";
import type { Task, Project, PriorityLevel, TaskStatus, ProjectStatus, ImpactEffort, Milestone, MilestoneStatus, ProjectNote, ProjectFile, ProjectPage } from "@shared/models/work";
import type { GoalIndexEntry } from "@shared/schema";
import { createReferenceRef, type ReferenceRef } from "@shared/references";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { STATUS_CONFIG, PROJECT_STATUS_CONFIG, groupTasksByStatus } from "@/lib/task-utils";
import { TaskWidget } from "@/components/task-widget";
import { ExpandedDescriptionEditor } from "@/components/expanded-description-editor";
import { useTaskModal } from "@/contexts/task-modal-context";

const log = createLogger("WorkPage");

type DiscussableWorkItem =
  | { type: "project"; id: number; title: string }
  | { type: "milestone"; id: number; title: string; projectId: number }
  | { type: "task"; id: number; title: string; projectId?: number | null; milestoneId?: number | null };

type CreatedSession = { id: string };

function buildWorkItemDiscussMessage(item: DiscussableWorkItem): string {
  const reference = `@${item.type}:${item.id}`;
  const context = item.type === "project"
    ? []
    : item.type === "milestone"
      ? [`Project: @project:${item.projectId}`]
      : [
          item.projectId ? `Project: @project:${item.projectId}` : null,
          item.milestoneId ? `Milestone: @milestone:${item.milestoneId}` : null,
        ].filter((line): line is string => Boolean(line));

  return [
    `Let's discuss this ${item.type}: **${item.title}**`,
    `Reference: ${reference}`,
    ...context,
  ].join("\n");
}

// Tasks are managed inline inside the Projects tree; no standalone tasks tab

const COLOR_GREEN = "text-success dark:text-success";
const COLOR_BLUE = "text-info";
const COLOR_PURPLE = "text-cat-ai";

function formatWorkDueDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function stablePartition<T>(items: T[], isTerminal: (item: T) => boolean): T[] {
  return items.filter(item => !isTerminal(item)).concat(items.filter(isTerminal));
}

function WorkCheckCircle({ checked, className, ...props }: { checked: boolean; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "h-4 w-4 rounded-full border bg-transparent inline-flex items-center justify-center transition-colors shrink-0",
        checked ? "border-success text-success" : "border-muted-foreground text-muted-foreground",
        className,
      )}
      aria-label={checked ? "Mark incomplete" : "Mark complete"}
      aria-pressed={checked}
      {...props}
    >
      {checked ? <Check className="h-3 w-3" /> : null}
    </button>
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


interface LibraryPickerPage {
  id: string;
  title: string;
  slug: string;
  oneLiner?: string;
}

function ProjectPagePickerDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (page: LibraryPickerPage) => void;
}) {
  const [query, setQuery] = useState("");
  const { data: pages } = useQuery<LibraryPickerPage[]>({
    queryKey: ["/api/info/library", "project-page-picker"],
    queryFn: async () => {
      const res = await fetch("/api/info/library", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  const filtered = (pages ?? []).filter(page => {
    const q = query.toLowerCase();
    return !q || page.title.toLowerCase().includes(q) || page.slug.toLowerCase().includes(q) || page.oneLiner?.toLowerCase().includes(q);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Page</DialogTitle>
          <DialogDescription>Link an existing Library page to this project.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <SearchIcon className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages..."
            className="pl-7 h-8 text-sm"
            autoFocus
            data-testid="input-project-page-search"
          />
        </div>
        <ScrollArea className="max-h-64">
          {filtered.map(page => (
            <button
              key={page.id}
              type="button"
              className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-accent/50 flex items-center gap-2"
              onClick={() => onSelect(page)}
              data-testid={`button-project-page-pick-${page.id}`}
            >
              <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="truncate block">{page.title}</span>
                {page.oneLiner && <span className="truncate block text-muted-foreground text-[10px]">{page.oneLiner}</span>}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-3">{query ? "No matching pages" : "No pages found"}</p>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function ProjectFileUploadDialog({
  open,
  onOpenChange,
  uploading,
  onFileSelected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  uploading: boolean;
  onFileSelected: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add File</DialogTitle>
          <DialogDescription>Upload a file and link it to this project.</DialogDescription>
        </DialogHeader>
        <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 bg-card px-4 py-6 text-center hover:bg-accent/50">
          {uploading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : <Upload className="h-5 w-5 text-muted-foreground" />}
          <span className="text-sm font-medium">{uploading ? "Uploading..." : "Choose a file"}</span>
          <span className="text-xs text-muted-foreground">The file is stored with the project.</span>
          <input type="file" className="sr-only" disabled={uploading} onChange={onFileSelected} data-testid="input-project-file-upload" />
        </label>
      </DialogContent>
    </Dialog>
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
  const urlProjectId = params.get("project");
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
    <div className="flex h-full min-w-0 max-w-full flex-col overflow-y-auto overflow-x-hidden">
      <ProjectsView selectedProjectId={urlProjectId ? Number(urlProjectId) : null} />
    </div>
  );
}

const WORK_SECTION_TITLE_CLASS = "flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider rounded-md";
const WORK_ROW_PADDING_PX = 8;
const WORK_COMPLETION_SIZE_PX = 16;
const WORK_CONNECTOR_STROKE_PX = 1;
const WORK_INDENT_STEP_PX = 24;
const WORK_MAX_INDENT_PX = 72;
const WORK_CONNECTOR_SPINE_PX = WORK_INDENT_STEP_PX - WORK_ROW_PADDING_PX - WORK_COMPLETION_SIZE_PX / 2;
const WORK_CONNECTOR_BRANCH_PX = WORK_ROW_PADDING_PX + WORK_COMPLETION_SIZE_PX / 2 - WORK_CONNECTOR_SPINE_PX;

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
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 max-w-full overflow-hidden" data-testid={testId}>
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
      <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
        <div className="mt-0 min-w-0 max-w-full space-y-0 overflow-hidden">{children}</div>
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
  onDiscuss,
  discussPending,
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
  onDiscuss: (item: DiscussableWorkItem) => void;
  discussPending: boolean;
}) {
  const { openTaskModal } = useTaskModal();
  const [editTitle, setEditTitle] = useState(task.title);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setEditTitle(task.title);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const taskDetailLines = [task.description].map(v => v?.trim()).filter(Boolean);
  const statusTextClass = isActive
    ? "text-foreground font-medium"
    : isCompleted
      ? "text-muted-foreground/45"
      : "text-muted-foreground";

  return (
    <div data-testid={`tree-node-task-${task.id}`}>
      <div
        className={cn(
          "group relative flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm cursor-pointer select-none transition-colors",
          "hover:bg-accent/70",
          statusTextClass,
          isCompleted && "line-through"
        )}
        onClick={() => openTaskModal(task.id)}
        data-testid={`card-task-${task.id}`}
      >
      <WorkCheckCircle
        checked={isCompleted}
        onClick={(event) => {
          event.stopPropagation();
          onUpdate({ status: isCompleted ? "ready" : "done" });
        }}
        data-testid={`check-task-${task.id}`}
      />
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
          className="truncate flex-1 min-w-0 rounded px-1 -mx-1 hover:bg-accent/70"
          onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
          data-testid={`text-task-title-${task.id}`}
        >
          {task.title}
        </span>
      )}

      {dueLabel ? (
        <InlineDatePicker
          value={task.deadline || ""}
          onCommit={(v) => onUpdate({ deadline: v })}
          className="shrink-0"
        >
          <span
            className="text-xs text-muted-foreground/70 tabular-nums rounded px-1 -mx-1 hover:bg-accent/70"
            data-testid={`text-task-due-date-${task.id}`}
          >
            {dueLabel}
          </span>
        </InlineDatePicker>
      ) : (
        <InlineDatePicker
          value=""
          onCommit={(v) => onUpdate({ deadline: v })}
          className="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
        >
          <span
            className="text-muted-foreground/40 rounded p-0.5 hover:bg-accent/70 hover:text-muted-foreground"
            data-testid={`button-task-set-deadline-${task.id}`}
          >
            <CalendarDays className="h-3 w-3" />
          </span>
        </InlineDatePicker>
      )}

      <div className="ml-auto flex h-6 shrink-0 items-center gap-0.5">
      <button
        type="button"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-100 transition-opacity hover:bg-accent hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
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
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-100 transition-opacity hover:bg-accent sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
            onClick={(e) => e.stopPropagation()}
            data-testid={`button-task-menu-${task.id}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            disabled={discussPending}
            onClick={(e) => {
              e.stopPropagation();
              onDiscuss({
                type: "task",
                id: task.id,
                title: task.title,
                projectId: task.projectId,
                milestoneId: task.milestoneId,
              });
            }}
            data-testid={`menu-task-discuss-${task.id}`}
          >
            {discussPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5 mr-2" />}
            Discuss
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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
      </div>
      {expanded && (
        <div className="ml-6 mr-2 border-l border-border/40 pl-2" data-testid={`tree-task-expanded-${task.id}`}>
          <TaskWidget taskId={task.id} showHeader={false} onDelete={onDelete} />
        </div>
      )}
    </div>
  );
}

function ProjectsView({ selectedProjectId }: { selectedProjectId?: number | null }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const [showCreate, setShowCreate] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [addingMilestoneProjectId, setAddingMilestoneProjectId] = useState<number | null>(null);
  const [newMilestoneName, setNewMilestoneName] = useState("");
  const [addingTaskTarget, setAddingTaskTarget] = useState<{ projectId: number; milestoneId: number } | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [pendingDeleteProject, setPendingDeleteProject] = useState<{ id: number; title: string } | null>(null);
  const [pendingDeleteTask, setPendingDeleteTask] = useState<{ id: number; title: string } | null>(null);
  const [pendingDeleteMilestone, setPendingDeleteMilestone] = useState<{ projectId: number; milestoneId: number; name: string } | null>(null);

  const { data: projects, isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects/projects"],
  });

  const { data: tasks, isLoading: tasksLoading } = useQuery<Task[]>({
    queryKey: ["/api/projects/tasks"],
  });

  const { data: peopleData } = useQuery<{ people: PersonEntry[] }>({
    queryKey: ["/api/people"],
  });

  useFocusContext(null);

  const discussMutation = useMutation({
    mutationFn: async (item: DiscussableWorkItem) => {
      const res = await apiRequest("POST", "/api/sessions", { title: item.title.trim().slice(0, 80) || item.type });
      const session: CreatedSession = await res.json();
      await apiRequest("POST", `/api/sessions/${session.id}/messages`, { content: buildWorkItemDiscussMessage(item) });
      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
    },
  });

  const discussWorkItem = (item: DiscussableWorkItem) => discussMutation.mutate(item);

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

  const deleteMilestoneMutation = useMutation({
    mutationFn: ({ projectId, milestoneId }: { projectId: number; milestoneId: number }) =>
      apiRequest("DELETE", `/api/projects/projects/${projectId}/milestones/${milestoneId}`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", variables.projectId] });
      toast({ title: "Milestone deleted" });
    },
  });

  const addProjectPageMutation = useMutation({
    mutationFn: ({ projectId, page }: { projectId: number; page: LibraryPickerPage }) =>
      apiRequest("POST", `/api/projects/projects/${projectId}/pages`, { pageId: page.id, title: page.title, slug: page.slug }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", variables.projectId] });
      toast({ title: "Page linked" });
    },
  });

  const addProjectFileMutation = useMutation({
    mutationFn: ({ projectId, file }: { projectId: number; file: { name: string; mimeType: string; objectKey: string; size: number } }) =>
      apiRequest("POST", `/api/projects/projects/${projectId}/files`, file),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects/projects", variables.projectId] });
      toast({ title: "File linked" });
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

  const uploadProjectFile = async (project: Project, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const urlRes = await apiRequest("POST", `/api/projects/projects/${project.id}/files/upload-url`);
      const { uploadURL, objectPath } = await urlRes.json();
      await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      await addProjectFileMutation.mutateAsync({
        projectId: project.id,
        file: { name: file.name, mimeType: file.type || "application/octet-stream", objectKey: objectPath, size: file.size },
      });
    } catch (err: any) {
      log.error("project file upload failed:", err);
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    }
  };


  return (
    <div className="min-h-full min-w-0 max-w-full overflow-x-hidden bg-background px-2 py-3 @sm:px-4 @sm:py-4">
      <div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-3 overflow-hidden">
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
          <div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-1 overflow-hidden">
            {groupedProjects.map(group => (
              <CollapsibleWorkSection
                key={group.status}
                label={group.label}
                defaultOpen={group.status === "active" || group.status === "planning" || group.projects.some(project => project.id === selectedProjectId)}
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
                    selected={selectedProjectId === project.id}
                    onOpenProject={() => setLocation(`/projects?project=${project.id}`)}
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
                    onDeleteMilestone={(milestone) => setPendingDeleteMilestone({ projectId: project.id, milestoneId: milestone.id, name: milestone.name })}
                    onUpdateProject={(data) => updateProjectMutation.mutate({ id: project.id, data })}
                    onUpdateMilestone={(milestoneId, data) => updateMilestoneMutation.mutate({ projectId: project.id, milestoneId, data })}
                    onDiscuss={discussWorkItem}
                    discussPending={discussMutation.isPending}
                    onAddProjectPage={(targetProject, page) => addProjectPageMutation.mutate({ projectId: targetProject.id, page })}
                    onUploadProjectFile={uploadProjectFile}
                    people={peopleData?.people ?? []}
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

      <AlertDialog open={!!pendingDeleteMilestone} onOpenChange={(open) => { if (!open) setPendingDeleteMilestone(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete milestone</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{pendingDeleteMilestone?.name}". Existing tasks stay on the project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-project-milestone">Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const pending = pendingDeleteMilestone;
                setPendingDeleteMilestone(null);
                if (pending) deleteMilestoneMutation.mutate({ projectId: pending.projectId, milestoneId: pending.milestoneId });
              }}
              data-testid="button-confirm-delete-project-milestone"
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

function WorkTreeConnector({ continues = false }: { continues?: boolean }) {
  const spineStyle = {
    left: WORK_CONNECTOR_SPINE_PX,
    width: WORK_CONNECTOR_STROKE_PX,
  };
  const branchStyle = {
    left: WORK_CONNECTOR_SPINE_PX,
    width: WORK_CONNECTOR_BRANCH_PX,
    height: WORK_CONNECTOR_STROKE_PX,
  };

  return (
    <div className="relative w-4 shrink-0 self-stretch" aria-hidden="true">
      <div
        className={cn("absolute top-0 bg-border", continues ? "bottom-0" : "bottom-1/2")}
        style={spineStyle}
      />
      <div className="absolute top-1/2 bg-border" style={branchStyle} />
    </div>
  );
}


function projectPageReference(page: ProjectPage): ReferenceRef {
  const pageId = page.slug || page.id;
  return createReferenceRef({
    type: "page",
    id: pageId,
    metadata: {
      label: page.title,
      href: `/info#library?page=${encodeURIComponent(pageId)}`,
    },
  });
}

function projectFileReference(file: ProjectFile): ReferenceRef {
  const objectPath = file.objectKey.startsWith("/objects/") ? file.objectKey : `/objects/${file.objectKey}`;
  return createReferenceRef({
    type: "file",
    id: objectPath,
    metadata: {
      label: file.name,
      href: `/objects/${file.objectKey.replace(/^\/objects\//, "")}?name=${encodeURIComponent(file.name)}`,
    },
  });
}

function resolveProjectPersonReference(value: string, people: PersonEntry[]): ReferenceRef | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const person = people.find(p => p.id === trimmed) || people.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
  if (!person) return null;
  return createReferenceRef({
    type: "person",
    id: person.id,
    metadata: { label: person.name },
  });
}

function ProjectReferenceChipRow({ project, people }: { project: Project; people: PersonEntry[] }) {
  const pageRefs = (project.pages || []).map(projectPageReference);
  const fileRefs = (project.files || []).map(projectFileReference);
  const personRefs = (project.people || [])
    .map(value => resolveProjectPersonReference(value, people))
    .filter((ref): ref is ReferenceRef => Boolean(ref));
  const unresolvedPeople = (project.people || []).filter(value => !resolveProjectPersonReference(value, people));
  const hasLinks = pageRefs.length > 0 || fileRefs.length > 0 || personRefs.length > 0 || unresolvedPeople.length > 0;

  if (!hasLinks) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`project-links-row-${project.id}`}>
      {[...pageRefs, ...fileRefs, ...personRefs].map(ref => (
        <ReferenceRenderer key={ref.canonical} refValue={ref} surface="simple-row" className="max-w-[14rem]" />
      ))}
      {unresolvedPeople.map(person => (
        <span
          key={person}
          className="inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-2 py-1 text-xs leading-tight text-muted-foreground"
          title={person}
        >
          <Users className="h-3 w-3 shrink-0" />
          <span className="truncate">{person}</span>
        </span>
      ))}
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
  onDeleteMilestone,
  onUpdateProject,
  onUpdateMilestone,
  onDiscuss,
  discussPending,
  onAddProjectPage,
  onUploadProjectFile,
  people,
  selected,
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
  onDeleteMilestone: (milestone: Milestone) => void;
  onUpdateProject: (data: any) => void;
  onUpdateMilestone: (milestoneId: number, data: Partial<Milestone>) => void;
  onDiscuss: (item: DiscussableWorkItem) => void;
  discussPending: boolean;
  onAddProjectPage: (project: Project, page: LibraryPickerPage) => void;
  onUploadProjectFile: (project: Project, event: React.ChangeEvent<HTMLInputElement>) => void;
  people: PersonEntry[];
  selected?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedMilestones, setExpandedMilestones] = useState<Record<number, boolean>>({});
  const [editingProjectTitle, setEditingProjectTitle] = useState(false);
  const [projectTitleDraft, setProjectTitleDraft] = useState(project.title);
  const [pagePickerOpen, setPagePickerOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [editingMilestoneId, setEditingMilestoneId] = useState<number | null>(null);
  const [milestoneNameDraft, setMilestoneNameDraft] = useState("");
  useEffect(() => {
    if (!editingProjectTitle) setProjectTitleDraft(project.title);
  }, [editingProjectTitle, project.title]);

  useEffect(() => {
    if (selected) setExpanded(true);
  }, [selected]);

  const saveProjectTitle = () => {
    const nextTitle = projectTitleDraft.trim();
    if (nextTitle && nextTitle !== project.title) onUpdateProject({ title: nextTitle });
    setEditingProjectTitle(false);
  };

  const projectDueLabel = formatWorkDueDate(project.dueDate);
  const isActive = project.status === "active";
  const isAddingMilestone = addingMilestoneProjectId === project.id;
  const sortedMilestones = stablePartition(project.milestones || [], milestone => milestone.status === "completed");
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
  const sortedUnassignedTasks = stablePartition(unassignedTasks, task => task.status === "done");
  const hasProjectLinks = (project.pages?.length || 0) > 0 || (project.files?.length || 0) > 0 || (project.people?.length || 0) > 0;
  const hasChildren = true;
  const isMilestoneExpanded = (milestone: Milestone) =>
    expandedMilestones[milestone.id] ?? milestone.status === "active";
  const toggleMilestoneExpanded = (milestone: Milestone) => {
    setExpandedMilestones(prev => ({ ...prev, [milestone.id]: !isMilestoneExpanded(milestone) }));
  };
  const depth = 0;
  const indentPx = Math.min(depth * WORK_INDENT_STEP_PX, WORK_MAX_INDENT_PX);

  return (
    <div className="min-w-0 max-w-full overflow-hidden" data-testid={`tree-node-project-${project.id}`}>
      <ProjectPagePickerDialog
        open={pagePickerOpen}
        onOpenChange={setPagePickerOpen}
        onSelect={(page) => {
          onAddProjectPage(project, page);
          setPagePickerOpen(false);
        }}
      />
      <ProjectFileUploadDialog
        open={filePickerOpen}
        onOpenChange={setFilePickerOpen}
        uploading={false}
        onFileSelected={(event) => {
          onUploadProjectFile(project, event);
          setFilePickerOpen(false);
        }}
      />
      <div className="flex min-w-0 max-w-full items-stretch overflow-hidden" style={{ paddingLeft: indentPx }}>
        <div className="flex-1 min-w-0 relative overflow-hidden">
          <div
            className={cn(
              "group relative flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm cursor-pointer select-none transition-colors",
              "hover:bg-accent/70",
              isActive ? "text-foreground font-medium" : "text-muted-foreground"
            )}
            onClick={onOpenProject}
            data-testid={`card-project-${project.id}`}
          >
            <FolderKanban className="h-3.5 w-3.5 shrink-0" data-testid={`icon-project-${project.id}`} />
            {editingProjectTitle ? (
              <Input
                value={projectTitleDraft}
                onChange={e => setProjectTitleDraft(e.target.value)}
                onBlur={saveProjectTitle}
                onKeyDown={e => {
                  if (e.key === "Enter") saveProjectTitle();
                  if (e.key === "Escape") { setProjectTitleDraft(project.title); setEditingProjectTitle(false); }
                }}
                onClick={e => e.stopPropagation()}
                className="h-7 flex-1 bg-transparent text-sm"
                autoFocus
                data-testid={`input-project-title-${project.id}`}
              />
            ) : (
              <span
                className="truncate flex-1 min-w-0 rounded px-1 -mx-1 hover:bg-accent/70"
                onClick={(e) => {
                  e.stopPropagation();
                  setProjectTitleDraft(project.title);
                  setEditingProjectTitle(true);
                }}
                data-testid={`text-project-title-${project.id}`}
              >
                {project.title}
              </span>
            )}
            {projectDueLabel ? (
              <InlineDatePicker
                value={project.dueDate || ""}
                onCommit={(v) => onUpdateProject({ dueDate: v })}
                className="shrink-0"
              >
                <span
                  className="text-xs text-muted-foreground/70 tabular-nums rounded px-1 -mx-1 hover:bg-accent/70"
                  data-testid={`text-project-due-date-${project.id}`}
                >
                  {projectDueLabel}
                </span>
              </InlineDatePicker>
            ) : (
              <InlineDatePicker
                value=""
                onCommit={(v) => onUpdateProject({ dueDate: v })}
                className="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
              >
                <span
                  className="text-muted-foreground/40 rounded p-0.5 hover:bg-accent/70 hover:text-muted-foreground"
                  data-testid={`button-project-set-due-date-${project.id}`}
                >
                  <CalendarDays className="h-3 w-3" />
                </span>
              </InlineDatePicker>
            )}
            <div className="z-10 ml-auto flex h-6 shrink-0 items-center gap-0.5 pl-1">
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
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-100 transition-colors transition-opacity hover:bg-accent hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                    data-testid={`button-project-menu-${project.id}`}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={discussPending}
                    onClick={(e) => { e.stopPropagation(); onDiscuss({ type: "project", id: project.id, title: project.title }); }}
                    data-testid={`menu-project-discuss-${project.id}`}
                  >
                    {discussPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5 mr-2" />}
                    Discuss
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger data-testid={`menu-project-goal-${project.id}`}>
                      <Target className="h-3.5 w-3.5 mr-2" />
                      Goal
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-64 p-2">
                      <GoalSelector goalId={project.goalId} onChange={(goalId) => onUpdateProject({ goalId })} />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
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
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger data-testid={`menu-project-tags-${project.id}`}>
                      <Tag className="h-3.5 w-3.5 mr-2" />
                      Tags
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-40">
                      <TagMenuItems selectedTags={project.tags} onChange={(tags) => onUpdateProject({ tags })} />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger data-testid={`menu-project-owner-${project.id}`}>
                      {project.owner === "me" ? <User className="h-3.5 w-3.5 mr-2" /> : <Bot className="h-3.5 w-3.5 mr-2" />}
                      Owner
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onUpdateProject({ owner: "me" }); }} data-testid={`menu-project-owner-me-${project.id}`}>
                        <User className="h-3.5 w-3.5 mr-2" />
                        <span className={cn(project.owner === "me" && "font-medium")}>Me</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onUpdateProject({ owner: "agent" }); }} data-testid={`menu-project-owner-agent-${project.id}`}>
                        <Bot className="h-3.5 w-3.5 mr-2" />
                        <span className={cn(project.owner === "agent" && "font-medium")}>{getInstanceName()}</span>
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setProjectTitleDraft(project.title);
                      setEditingProjectTitle(true);
                    }}
                    data-testid={`menu-project-rename-${project.id}`}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    Rename
                  </DropdownMenuItem>
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
                    onClick={(e) => { e.stopPropagation(); setPagePickerOpen(true); }}
                    data-testid={`menu-project-add-page-${project.id}`}
                  >
                    <FileText className="h-3.5 w-3.5 mr-2" />
                    Add Page
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger data-testid={`menu-project-add-people-${project.id}`}>
                      <Users className="h-3.5 w-3.5 mr-2" />
                      Add People
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-64 p-2">
                      <PeopleSelector selected={project.people} onChange={(people) => onUpdateProject({ people })} />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); setFilePickerOpen(true); }}
                    data-testid={`menu-project-add-file-${project.id}`}
                  >
                    <FileIcon className="h-3.5 w-3.5 mr-2" />
                    Add File
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
          <div className="flex min-w-0 items-stretch" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX, WORK_MAX_INDENT_PX) }}>
              <WorkTreeConnector continues={sortedMilestones.length > 0 || isAddingMilestone || sortedUnassignedTasks.length > 0} />
              <div className="flex-1 min-w-0 px-2 py-1.5">
                <div className="space-y-2 rounded-md border border-border/30 bg-card/40 p-2" data-testid={`project-expanded-summary-${project.id}`}>
                  <ExpandedDescriptionEditor
                    value={project.description}
                    onSave={(description) => onUpdateProject({ description })}
                    placeholder="Add a project description..."
                    testIdPrefix={`project-description-${project.id}`}
                  />
                  <ProjectReferenceChipRow project={project} people={people} />
                </div>
              </div>
            </div>
          {sortedMilestones.map((milestone, milestoneIndex) => {
            const milestoneTasks = stablePartition(tasksByMilestone.get(milestone.id) || [], task => task.status === "done");
            const isAddingTask = addingTaskTarget?.projectId === project.id && addingTaskTarget.milestoneId === milestone.id;
            const milestoneExpanded = isMilestoneExpanded(milestone);
            const milestoneDueLabel = formatWorkDueDate(milestone.dueDate);
            const milestoneCompleted = milestone.status === "completed";
            return (
              <div key={milestone.id} className="space-y-0">
                <div className="flex min-w-0 max-w-full items-stretch overflow-hidden" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX, WORK_MAX_INDENT_PX) }}>
                  <WorkTreeConnector continues={milestoneIndex < sortedMilestones.length - 1 || isAddingMilestone || sortedUnassignedTasks.length > 0} />
                  <div className="flex-1 min-w-0 relative overflow-hidden">
                    <div className="group relative flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm select-none transition-colors hover:bg-accent/70" data-testid={`tree-node-milestone-${milestone.id}`}>
                      <WorkCheckCircle
                        checked={milestoneCompleted}
                        onClick={(event) => {
                          event.stopPropagation();
                          onUpdateMilestone(milestone.id, { status: milestoneCompleted ? "planned" : "completed" });
                        }}
                        data-testid={`check-tree-milestone-${milestone.id}`}
                      />
                      <Flag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {editingMilestoneId === milestone.id ? (
                        <Input
                          value={milestoneNameDraft}
                          onChange={e => setMilestoneNameDraft(e.target.value)}
                          onBlur={() => {
                            const nextName = milestoneNameDraft.trim();
                            if (nextName && nextName !== milestone.name) onUpdateMilestone(milestone.id, { name: nextName });
                            setEditingMilestoneId(null);
                          }}
                          onKeyDown={e => {
                            if (e.key === "Enter") {
                              const nextName = milestoneNameDraft.trim();
                              if (nextName && nextName !== milestone.name) onUpdateMilestone(milestone.id, { name: nextName });
                              setEditingMilestoneId(null);
                            }
                            if (e.key === "Escape") setEditingMilestoneId(null);
                          }}
                          onClick={e => e.stopPropagation()}
                          className="h-7 flex-1 bg-transparent text-sm"
                          autoFocus
                          data-testid={`input-tree-milestone-name-${milestone.id}`}
                        />
                      ) : (
                        <span
                          className={cn("truncate flex-1 min-w-0 rounded px-1 -mx-1 hover:bg-accent/70", milestoneCompleted && "line-through text-muted-foreground")}
                          onClick={(e) => {
                            e.stopPropagation();
                            setMilestoneNameDraft(milestone.name);
                            setEditingMilestoneId(milestone.id);
                          }}
                          data-testid={`text-tree-milestone-name-${milestone.id}`}
                        >
                          {milestone.name}
                        </span>
                      )}
                      {milestoneDueLabel ? (
                        <InlineDatePicker
                          value={milestone.dueDate || ""}
                          onCommit={(v) => onUpdateMilestone(milestone.id, { dueDate: v })}
                          className="shrink-0"
                        >
                          <span
                            className="text-xs text-muted-foreground/70 tabular-nums rounded px-1 -mx-1 hover:bg-accent/70"
                            data-testid={`text-tree-milestone-due-date-${milestone.id}`}
                          >
                            {milestoneDueLabel}
                          </span>
                        </InlineDatePicker>
                      ) : (
                        <InlineDatePicker
                          value=""
                          onCommit={(v) => onUpdateMilestone(milestone.id, { dueDate: v })}
                          className="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                        >
                          <span
                            className="text-muted-foreground/40 rounded p-0.5 hover:bg-accent/70 hover:text-muted-foreground"
                            data-testid={`button-tree-milestone-set-due-${milestone.id}`}
                          >
                            <CalendarDays className="h-3 w-3" />
                          </span>
                        </InlineDatePicker>
                      )}
                      <div className="z-10 ml-auto flex h-6 shrink-0 items-center gap-0.5 pl-1">
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
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-100 transition-colors transition-opacity hover:bg-accent hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={(e) => e.stopPropagation()}
                              data-testid={`button-tree-milestone-menu-${milestone.id}`}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={discussPending}
                              onClick={(e) => {
                                e.stopPropagation();
                                onDiscuss({ type: "milestone", id: milestone.id, title: milestone.name, projectId: project.id });
                              }}
                              data-testid={`menu-tree-milestone-discuss-${milestone.id}`}
                            >
                              {discussPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5 mr-2" />}
                              Discuss
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
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
                                setMilestoneNameDraft(milestone.name);
                                setEditingMilestoneId(milestone.id);
                              }}
                              data-testid={`menu-tree-milestone-rename-${milestone.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5 mr-2" />
                              Rename
                            </DropdownMenuItem>
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
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-error-foreground"
                              onClick={(e) => { e.stopPropagation(); onDeleteMilestone(milestone); }}
                              data-testid={`menu-tree-milestone-delete-${milestone.id}`}
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
                {isAddingTask && (
                  <div className="flex min-w-0 items-stretch" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX * 2, WORK_MAX_INDENT_PX) }}>
                    <WorkTreeConnector continues={milestoneTasks.length > 0} />
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
                {milestoneExpanded && milestoneTasks.map((task, taskIndex) => (
                  <div key={task.id} className="flex min-w-0 max-w-full items-stretch overflow-hidden" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX * 2, WORK_MAX_INDENT_PX) }}>
                    <WorkTreeConnector continues={taskIndex < milestoneTasks.length - 1} />
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
                        onDiscuss={onDiscuss}
                        discussPending={discussPending}
                      />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          {isAddingMilestone && (
            <div className="flex min-w-0 items-stretch" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX, WORK_MAX_INDENT_PX) }}>
              <WorkTreeConnector continues={sortedUnassignedTasks.length > 0} />
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
          {sortedUnassignedTasks.map((task, taskIndex) => (
            <div key={task.id} className="flex min-w-0 items-stretch" style={{ paddingLeft: Math.min(WORK_INDENT_STEP_PX, WORK_MAX_INDENT_PX) }}>
              <WorkTreeConnector continues={taskIndex < sortedUnassignedTasks.length - 1} />
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
                  onDiscuss={onDiscuss}
                  discussPending={discussPending}
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
