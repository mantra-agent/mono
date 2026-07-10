import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePageHeader } from "@/hooks/use-page-header";
import { Radio, Loader2, Trash2, MoreHorizontal, FileText, Brain, Globe, Shield, Moon, Compass, MessageSquare, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Thought {
  id: string;
  text: string;
  occurredAt: string;
}

type ThoughtType = "MIRROR" | "WORLD MODEL" | "TACTICAL LOOP" | "OBSERVE" | "STRATEGIC" | "REFLECTION" | "MEDITATE" | "ENGAGE" | "DREAM" | "IDENTITY" | "INTROSPECT" | "WORLD" | "SELF" | "US" | "PATTERN" | "GAP" | "CHANGE" | "CONNECTION" | "OPPORTUNITY" | "UNKNOWN";

interface ParsedThought {
  type: ThoughtType;
  timestamp: string;
  body: string;
}

const typeThemes: Record<string, { border: string; badge: string; badgeText: string; icon: typeof Radio; label: string }> = {
  "MIRROR": {
    border: "border-l-info/60",
    badge: "bg-info/10 text-info-foreground",
    badgeText: "Belief",
    icon: Globe,
    label: "BELIEF",
  },
  "WORLD MODEL": {
    border: "border-l-info/60",
    badge: "bg-info/10 text-info-foreground",
    badgeText: "Belief",
    icon: Globe,
    label: "BELIEF",
  },
  "OBSERVE": {
    border: "border-l-success/60",
    badge: "bg-success/10 text-success-foreground",
    badgeText: "Observe",
    icon: Compass,
    label: "OBSERVE",
  },
  "TACTICAL LOOP": {
    border: "border-l-success/60",
    badge: "bg-success/10 text-success-foreground",
    badgeText: "Observe",
    icon: Compass,
    label: "OBSERVE",
  },
  "STRATEGIC": {
    border: "border-l-cat-ai/60",
    badge: "bg-cat-ai/10 text-cat-ai-foreground",
    badgeText: "Strategic",
    icon: Sparkles,
    label: "STRATEGIC",
  },
  "MEDITATE": {
    border: "border-l-warning/60",
    badge: "bg-warning/10 text-warning-foreground",
    badgeText: "Meditate",
    icon: Brain,
    label: "MEDITATE",
  },
  "REFLECTION": {
    border: "border-l-warning/60",
    badge: "bg-warning/10 text-warning-foreground",
    badgeText: "Meditate",
    icon: Brain,
    label: "MEDITATE",
  },
  "ENGAGE": {
    border: "border-l-cat-growth/60",
    badge: "bg-cat-growth/10 text-cat-growth-foreground",
    badgeText: "Engage",
    icon: MessageSquare,
    label: "ENGAGE",
  },
  "DREAM": {
    border: "border-l-cat-ai/60",
    badge: "bg-cat-ai/10 text-cat-ai-foreground",
    badgeText: "Dream",
    icon: Moon,
    label: "DREAM",
  },
  "INTROSPECT": {
    border: "border-l-cat-alert/60",
    badge: "bg-cat-alert/10 text-cat-alert-foreground",
    badgeText: "Introspect",
    icon: Shield,
    label: "INTROSPECT",
  },
  "IDENTITY": {
    border: "border-l-cat-alert/60",
    badge: "bg-cat-alert/10 text-cat-alert-foreground",
    badgeText: "Introspect",
    icon: Shield,
    label: "INTROSPECT",
  },
  "WORLD": {
    border: "border-l-info/60",
    badge: "bg-info/10 text-info-foreground",
    badgeText: "World",
    icon: Globe,
    label: "WORLD",
  },
  "SELF": {
    border: "border-l-cat-alert/60",
    badge: "bg-cat-alert/10 text-cat-alert-foreground",
    badgeText: "Self",
    icon: Shield,
    label: "SELF",
  },
  "US": {
    border: "border-l-cat-growth/60",
    badge: "bg-cat-growth/10 text-cat-growth-foreground",
    badgeText: "Us",
    icon: MessageSquare,
    label: "US",
  },
  "PATTERN": {
    border: "border-l-info/60",
    badge: "bg-info/10 text-info-foreground",
    badgeText: "Pattern",
    icon: Compass,
    label: "PATTERN",
  },
  "GAP": {
    border: "border-l-warning/60",
    badge: "bg-warning/10 text-warning-foreground",
    badgeText: "Gap",
    icon: Radio,
    label: "GAP",
  },
  "CHANGE": {
    border: "border-l-cat-event/60",
    badge: "bg-cat-event/10 text-cat-event-foreground",
    badgeText: "Change",
    icon: Sparkles,
    label: "CHANGE",
  },
  "CONNECTION": {
    border: "border-l-cat-ai/60",
    badge: "bg-cat-ai/10 text-cat-ai-foreground",
    badgeText: "Connection",
    icon: Globe,
    label: "CONNECTION",
  },
  "OPPORTUNITY": {
    border: "border-l-success/60",
    badge: "bg-success/10 text-success-foreground",
    badgeText: "Opportunity",
    icon: Compass,
    label: "OPPORTUNITY",
  },
  "UNKNOWN": {
    border: "border-l-muted-foreground/30",
    badge: "bg-muted text-muted-foreground",
    badgeText: "Thought",
    icon: Radio,
    label: "UNKNOWN",
  },
};

const HEADER_RE = /^\[([A-Z\s]+)\s*[—–-]\s*(.+?)\]\s*$/;

function stripThoughtTags(text: string): string {
  return text.replace(/^\s*<thought>\s*\n?/, "").replace(/\n?\s*<\/thought>\s*$/, "");
}

function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function parseThought(text: string): ParsedThought {
  const cleaned = stripThoughtTags(text);
  const lines = cleaned.split("\n");
  const firstLine = (lines[0] || "").trim();
  const match = firstLine.match(HEADER_RE);

  if (match) {
    const rawType = match[1].trim();
    const timestamp = match[2].trim();
    const body = lines.slice(1).join("\n").trim();
    const knownType = rawType in typeThemes ? rawType as ThoughtType : "UNKNOWN";
    return { type: knownType, timestamp, body };
  }

  return { type: "UNKNOWN", timestamp: "", body: cleaned.trim() };
}

function stripStructuralTags(text: string): string {
  return text
    .replace(/<\/?(?:entry|turn|concept|link|claim|evidence)(?:\s[^>]*)?>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function preserveNewlines(text: string): string {
  return text.replace(/\n/g, "  \n");
}

function ThoughtMarkdown({ body, className }: { body: string; className?: string }) {
  if (!body) return null;
  const cleaned = stripStructuralTags(unescapeHtmlEntities(body));
  return (
    <div className={cn("text-sm text-foreground/90 leading-relaxed prose prose-sm dark:prose-invert max-w-none break-words overflow-hidden prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:text-foreground prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1 prose-pre:overflow-x-auto prose-code:break-all", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{preserveNewlines(cleaned)}</ReactMarkdown>
    </div>
  );
}


function splitIntrospectEntries(body: string): string[] {
  const cleaned = stripStructuralTags(unescapeHtmlEntities(body));
  const lines = cleaned.split("\n");
  const entries: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const isEntryStart = /^\[(high|medium|low)\]\s/i.test(line) || /^Self-model update:\s/i.test(line);
    if (isEntryStart && current.length > 0) {
      entries.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    const trimmed = current.join("\n").trim();
    if (trimmed) entries.push(trimmed);
  }
  return entries.length > 0 ? entries : [body];
}

function BeliefBody({ body }: { body: string }) {
  return <ThoughtMarkdown body={body} />;
}

function IntrospectBody({ body }: { body: string }) {
  return <ThoughtMarkdown body={body} />;
}

function BodyLines({ body }: { body: string }) {
  return <ThoughtMarkdown body={body} />;
}

function ThoughtBody({ parsed }: { parsed: ParsedThought }) {
  if (parsed.type === "MIRROR" || parsed.type === "WORLD MODEL") {
    return <BeliefBody body={parsed.body} />;
  }
  if (parsed.type === "INTROSPECT" || parsed.type === "IDENTITY") {
    return <IntrospectBody body={parsed.body} />;
  }
  return <BodyLines body={parsed.body} />;
}

const ACTIVE_MAX_AGE_MS = 25 * 60 * 1000;

function isActive(thought: Thought): boolean {
  return Date.now() - new Date(thought.occurredAt).getTime() < ACTIVE_MAX_AGE_MS;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function absoluteTime(iso: string, tz?: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(tz ? { timeZone: tz } : {}),
  };
  return d.toLocaleDateString("en-US", opts);
}

function ThoughtCard({ thought, active, onDelete, onViewContext, timezone, bodyOverride }: {
  thought: Thought;
  active: boolean;
  onDelete: (id: string) => void;
  onViewContext: (id: string) => void;
  timezone?: string;
  bodyOverride?: string;
}) {
  const parsed = parseThought(thought.text);
  if (bodyOverride !== undefined) {
    parsed.body = bodyOverride;
  }
  const theme = typeThemes[parsed.type] || typeThemes["UNKNOWN"];
  const IconComponent = theme.icon;

  return (
    <div
      className={cn(
        "group relative rounded-md border border-l-[3px] p-4 transition-colors bg-card min-w-0",
        theme.border,
        active
          ? "border-t-border/50 border-r-border/50 border-b-border/50"
          : "border-t-border/40 border-r-border/40 border-b-border/40 opacity-80"
      )}
      data-testid={`thought-card-${thought.id}`}
    >
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        {active && (
          <>
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-info" />
            </span>
            <span className="text-xs font-medium uppercase tracking-wider text-primary/70 mr-1" data-testid="thought-live-badge">
              live
            </span>
          </>
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-accent text-muted-foreground/40 hover:text-foreground"
              data-testid={`button-thought-menu-${thought.id}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => onViewContext(thought.id)}
              data-testid={`button-thought-context-${thought.id}`}
            >
              <FileText className="h-3.5 w-3.5 mr-2" />
              Context
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDelete(thought.id)}
              data-testid={`button-delete-thought-${thought.id}`}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-start gap-3">
        <IconComponent className={cn(
          "h-4 w-4 mt-0.5 shrink-0",
          active ? "text-foreground/70" : "text-muted-foreground/50"
        )} />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <Badge variant="secondary" className={cn("text-xs px-1.5 py-0 no-default-hover-elevate no-default-active-elevate", theme.badge)} data-testid={`thought-type-${thought.id}`}>
              {theme.badgeText}
            </Badge>
            <span className={cn(
              "text-xs",
              active ? "text-muted-foreground font-medium" : "text-muted-foreground/60"
            )} data-testid={`thought-time-${thought.id}`}>
              {active ? relativeTime(thought.occurredAt) : absoluteTime(thought.occurredAt, timezone)}
            </span>
          </div>
          <div className="pr-6 overflow-hidden" data-testid={`thought-text-${thought.id}`}>
            <ThoughtBody parsed={parsed} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ContextDialog({ thoughtId, open, onOpenChange }: {
  thoughtId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading } = useQuery<{ id: string; context: string | null; hasContext: boolean }>({
    queryKey: ["/api/observations", thoughtId, "context"],
    queryFn: async () => {
      const res = await fetch(`/api/observations/${thoughtId}/context`);
      if (!res.ok) throw new Error("Failed to fetch context");
      return res.json();
    },
    enabled: !!thoughtId && open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col overflow-hidden" data-testid="thought-context-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">Thought Context</DialogTitle>
          <DialogDescription className="sr-only">Full system prompt context sent to the LLM for this thought</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data?.hasContext ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No context saved for this thought. Context is only captured for thoughts fired after this feature was added.
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto rounded-md bg-muted/30">
            <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono text-muted-foreground p-4" data-testid="thought-context-content">
              {data.context}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function ObservationsPage({ embedded }: { embedded?: boolean } = {}) {
  usePageHeader({ title: "Thoughts", skip: !!embedded });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [contextThoughtId, setContextThoughtId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);

  const { data: tzData } = useQuery<{ timezone: string }>({
    queryKey: ["/api/settings/timezone"],
  });

  const { data, isLoading } = useQuery<{ thoughts: Thought[]; total: number }>({
    queryKey: ["/api/observations?limit=100"],
    refetchInterval: 30000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/observations/${id}`);
    },
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/observations?limit=100"] });
      const prev = queryClient.getQueryData<{ thoughts: Thought[]; total: number }>(["/api/observations?limit=100"]);
      if (prev) {
        queryClient.setQueryData(["/api/observations?limit=100"], {
          thoughts: prev.thoughts.filter(t => t.id !== id),
          total: prev.total - 1,
        });
      }
      return { prev };
    },
    onError: (_err, _id, context) => {
      if (context?.prev) {
        queryClient.setQueryData(["/api/observations?limit=100"], context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/observations?limit=100"] });
      queryClient.invalidateQueries({ queryKey: ["/api/observations/active"] });
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", "/api/observations");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/observations?limit=100"] });
      queryClient.invalidateQueries({ queryKey: ["/api/observations/active"] });
    },
  });

  const items = data?.thoughts || [];

  function expandThoughts(list: Thought[]): { thought: Thought; bodyOverride?: string; subKey?: string }[] {
    const result: { thought: Thought; bodyOverride?: string; subKey?: string }[] = [];
    for (const t of list) {
      const parsed = parseThought(t.text);
      const rawMatch = stripThoughtTags(t.text).split("\n")[0]?.trim().match(HEADER_RE);
      const rawType = rawMatch ? rawMatch[1].trim() : "";
      if (rawType === "THOUGHT" || rawType === "CHAT THINKING") continue;
      if (parsed.type === "INTROSPECT" || parsed.type === "IDENTITY") {
        const entries = splitIntrospectEntries(parsed.body);
        if (entries.length > 1) {
          entries.forEach((entry, i) => result.push({ thought: t, bodyOverride: entry, subKey: `${i}` }));
        } else {
          result.push({ thought: t });
        }
      } else {
        result.push({ thought: t });
      }
    }
    return result;
  }

  const activeThoughts = expandThoughts(items.filter(isActive));
  const olderThoughts = expandThoughts(items.filter(t => !isActive(t)));
  const displayCount = activeThoughts.length + olderThoughts.length;
  const tz = tzData?.timezone;

  const handleViewContext = (id: string) => {
    setContextThoughtId(id);
    setContextOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="thoughts-loading">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const actionBar = (
    <div className="flex items-center justify-end gap-1 mb-1">
      {displayCount > 0 && (
        <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground/60 gap-1.5"
                data-testid="button-clear-all-thoughts"
              >
                <Trash2 className="h-3 w-3" />
                Clear all
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear all thoughts?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all {displayCount} thought{displayCount !== 1 ? "s" : ""} from the archive. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-cancel-clear-all">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteAllMutation.mutate()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid="button-confirm-clear-all"
                >
                  {deleteAllMutation.isPending ? "Clearing..." : "Clear all"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
      )}
    </div>
  );

  if (displayCount === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-4 space-y-3" data-testid="thoughts-empty">
        {actionBar}
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No observations yet.</div>
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4 space-y-3" data-testid="thoughts-list">
        {actionBar}

        {activeThoughts.map(({ thought: t, bodyOverride, subKey }) => (
          <ThoughtCard key={subKey ? `${t.id}-${subKey}` : t.id} thought={t} active onDelete={(id) => deleteMutation.mutate(id)} onViewContext={handleViewContext} timezone={tz} bodyOverride={bodyOverride} />
        ))}

        {activeThoughts.length > 0 && olderThoughts.length > 0 && (
          <div className="flex items-center gap-3 py-2" data-testid="thoughts-divider">
            <div className="flex-1 h-px bg-border/60" />
            <span className="text-xs uppercase tracking-wider text-muted-foreground/40 font-medium">
              older thoughts
            </span>
            <div className="flex-1 h-px bg-border/60" />
          </div>
        )}

        {olderThoughts.map(({ thought: t, bodyOverride, subKey }) => (
          <ThoughtCard key={subKey ? `${t.id}-${subKey}` : t.id} thought={t} active={false} onDelete={(id) => deleteMutation.mutate(id)} onViewContext={handleViewContext} timezone={tz} bodyOverride={bodyOverride} />
        ))}
      </div>

      <ContextDialog thoughtId={contextThoughtId} open={contextOpen} onOpenChange={setContextOpen} />
    </>
  );
}
