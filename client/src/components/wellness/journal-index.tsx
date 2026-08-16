import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

export type JournalKind = "gratitude" | "reflection";

interface JournalEntry {
  id: number;
  content: string;
  date: string;
  createdAt: string;
  updatedAt: string;
}

const JOURNAL_COPY: Record<JournalKind, { placeholder: string; savedLabel: string }> = {
  gratitude: {
    placeholder: "What are you grateful for today?",
    savedLabel: "Gratitude entry saved",
  },
  reflection: {
    placeholder: "What do you want to reflect on today?",
    savedLabel: "Reflection entry saved",
  },
};

function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const todayStr = formatLocalDate(today);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = formatLocalDate(yesterday);

  if (dateStr === todayStr) return "Today";
  if (dateStr === yesterdayStr) return "Yesterday";

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

function truncateContent(content: string, max = 96): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function invalidateJournal(kind: JournalKind) {
  queryClient.invalidateQueries({ queryKey: [`/api/wellness/${kind}`] });
  queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
  queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs"] });
}

export function JournalIndex({ kind }: { kind: JournalKind }) {
  const todayStr = useMemo(() => formatLocalDate(new Date()), []);
  const copy = JOURNAL_COPY[kind];
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [content, setContent] = useState("");
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const { data: entries = [], isLoading, error, refetch } = useQuery<JournalEntry[]>({
    queryKey: [`/api/wellness/${kind}`, "index"],
    queryFn: async () => {
      const res = await fetch(`/api/wellness/${kind}?limit=200&offset=0`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load entries");
      return res.json();
    },
  });

  useEffect(() => {
    const todayEntry = entries.find((entry) => entry.date === todayStr);
    if (todayEntry) setContent(todayEntry.content);
  }, [entries, todayStr]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/wellness/${kind}`, { content, date: todayStr });
    },
    onSuccess: () => {
      invalidateJournal(kind);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
      toast({ title: copy.savedLabel });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (date: string) => {
      await apiRequest("DELETE", `/api/wellness/${kind}/${date}`);
    },
    onSuccess: (_data, date) => {
      invalidateJournal(kind);
      if (date === todayStr) {
        setContent("");
        setOpenId(null);
      }
      toast({ title: "Deleted", description: "Entry removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return entries;
    return entries.filter(
      (entry) =>
        entry.content.toLowerCase().includes(query) ||
        entry.date.includes(query) ||
        formatDisplayDate(entry.date).toLowerCase().includes(query),
    );
  }, [entries, query]);

  const todayEntry = filtered.find((entry) => entry.date === todayStr) ?? null;
  const pastEntries = filtered
    .filter((entry) => entry.date !== todayStr)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="h-full w-full overflow-y-auto bg-background" data-testid={`journal-index-${kind}`}>
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySearchInput
          value={search}
          onChange={setSearch}
          inputTestId={`input-search-${kind}`}
          clearTestId={`button-clear-${kind}-search`}
          ariaLabel={`Search ${kind}`}
        />

        <div className="space-y-2 px-2 py-1.5">
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={copy.placeholder}
            maxLength={5000}
            className="min-h-[88px] resize-y text-sm"
            data-testid={`input-${kind}-today`}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => saveMutation.mutate()}
              disabled={!content.trim() || saveMutation.isPending}
              data-testid={`button-save-${kind}`}
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : savedSuccess ? (
                <Check className="mr-1 h-3 w-3 text-success" />
              ) : null}
              {savedSuccess ? "Saved" : todayEntry ? "Update" : "Save"}
            </Button>
            {todayEntry ? (
              <span className="text-xs text-muted-foreground">
                Last saved{" "}
                {new Date(todayEntry.updatedAt).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            ) : null}
          </div>
        </div>

        {isLoading ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            Entries unavailable.{" "}
            <button type="button" className="text-cta" onClick={() => void refetch()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            <JournalSection
              label="Today"
              emptyLabel="No entry for today."
              items={todayEntry ? [todayEntry] : []}
              openId={openId}
              setOpenId={setOpenId}
              onDelete={(date) => deleteMutation.mutate(date)}
              deletePending={deleteMutation.isPending}
            />
            <JournalSection
              label="Past"
              emptyLabel="No past entries."
              items={pastEntries}
              openId={openId}
              setOpenId={setOpenId}
              onDelete={(date) => deleteMutation.mutate(date)}
              deletePending={deleteMutation.isPending}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function JournalSection({
  label,
  emptyLabel,
  items,
  openId,
  setOpenId,
  onDelete,
  deletePending,
}: {
  label: string;
  emptyLabel: string;
  items: JournalEntry[];
  openId: number | null;
  setOpenId: (id: number | null) => void;
  onDelete: (date: string) => void;
  deletePending: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label} · {items.length}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {items.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">{emptyLabel}</div>
        ) : (
          items.map((entry) => {
            const expanded = openId === entry.id;
            return (
              <div key={entry.id}>
                <div
                  className={cn(HIERARCHY_SESSION_ROW_CLASS, "group")}
                  data-testid={`row-journal-${entry.date}`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setOpenId(expanded ? null : entry.id)}
                  >
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-90",
                      )}
                    />
                    <span className="w-[88px] shrink-0 text-xs font-medium text-muted-foreground">
                      {formatDisplayDate(entry.date)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {truncateContent(entry.content)}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Actions for ${formatDisplayDate(entry.date)}`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        disabled={deletePending}
                        onClick={() => onDelete(entry.date)}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {expanded ? (
                  <div className="ml-6 border-l border-border/40 px-3 py-2 text-sm whitespace-pre-wrap break-words text-foreground">
                    {entry.content}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
