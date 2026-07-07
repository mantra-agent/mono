import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Heart, Loader2, Trash2, Check } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";

interface GratitudeEntry {
  id: number;
  content: string;
  date: string;
  createdAt: string;
  updatedAt: string;
}

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
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

const CHAR_LIMIT = 5000;
const CHAR_WARNING = 4500;
const PAGE_SIZE = 30;

export function GratitudeContent() {
  const todayStr = formatLocalDate(new Date());
  const [content, setContent] = useState("");
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [offset, setOffset] = useState(0);
  const [allEntries, setAllEntries] = useState<GratitudeEntry[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();

  const { data: entries, isLoading } = useQuery<GratitudeEntry[]>({
    queryKey: ["/api/wellness/gratitude", offset],
    queryFn: async () => {
      const res = await fetch(`/api/wellness/gratitude?limit=${PAGE_SIZE}&offset=${offset}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load entries");
      return res.json();
    },
  });

  useEffect(() => {
    if (entries) {
      if (offset === 0) {
        setAllEntries(entries);
      } else {
        setAllEntries(prev => {
          const existingDates = new Set(prev.map(e => e.date));
          const newOnes = entries.filter(e => !existingDates.has(e.date));
          return [...prev, ...newOnes];
        });
      }
    }
  }, [entries, offset]);

  useEffect(() => {
    if (allEntries.length > 0) {
      const todayEntry = allEntries.find(e => e.date === todayStr);
      if (todayEntry) {
        setContent(todayEntry.content);
      }
    }
  }, [allEntries.length > 0 && allEntries[0]?.date]);

  useEffect(() => {
    if (!isLoading && allEntries.length === 0 && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isLoading, allEntries.length]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/wellness/gratitude", { content, date: todayStr });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/gratitude"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs"] });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
      toast({ title: "Gratitude entry saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (date: string) => {
      await apiRequest("DELETE", `/api/wellness/gratitude/${date}`);
    },
    onSuccess: (_data, date) => {
      setAllEntries(prev => prev.filter(e => e.date !== date));
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/gratitude"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs"] });
      if (date === todayStr) setContent("");
      toast({ title: "Deleted", description: "Entry removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleLoadMore = useCallback(() => {
    setOffset(prev => prev + PAGE_SIZE);
  }, []);

  const todayEntry = allEntries.find(e => e.date === todayStr);
  const pastEntries = allEntries.filter(e => e.date !== todayStr);
  const hasMore = entries?.length === PAGE_SIZE;

  if (isLoading && offset === 0) {
    return (
      <div className="p-3 @sm:p-6 space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-10 w-24" />
      </div>
    );
  }

  const isEmpty = allEntries.length === 0 && !content.trim();

  return (
    <div className="p-3 @sm:p-6 space-y-6">
      <div>
        <h2 data-testid="text-gratitude-date" className="text-sm font-medium text-muted-foreground mb-3">
          {formatDisplayDate(todayStr)} — {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
        </h2>

        {isEmpty && (
          <div data-testid="text-gratitude-empty" className="flex flex-col items-center text-center gap-3 py-6 mb-4">
            <Heart className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="font-medium">Start your gratitude practice</p>
              <p className="text-sm text-muted-foreground mt-1">
                Take a moment to reflect on what you're grateful for today.
              </p>
            </div>
          </div>
        )}

        <div className="relative">
          <textarea
            ref={textareaRef}
            data-testid="input-gratitude"
            className="w-full min-h-[120px] @sm:min-h-[150px] p-3 rounded-lg border bg-background text-sm resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="What are you grateful for today?"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={CHAR_LIMIT}
          />
          {content.length >= CHAR_WARNING && (
            <span
              data-testid="text-char-count"
              className={`absolute bottom-2 right-2 text-xs ${content.length >= CHAR_LIMIT ? "text-destructive" : "text-muted-foreground"}`}
            >
              {content.length}/{CHAR_LIMIT}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-3">
          <Button
            data-testid="button-save-gratitude"
            onClick={() => saveMutation.mutate()}
            disabled={!content.trim() || saveMutation.isPending || content.length > CHAR_LIMIT}
            className="min-w-[80px]"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : savedSuccess ? (
              <Check className="h-4 w-4 mr-1 text-success" />
            ) : null}
            {savedSuccess ? "Saved" : todayEntry ? "Update" : "Save"}
          </Button>
          {todayEntry && (
            <span className="text-xs text-muted-foreground">
              Last saved {new Date(todayEntry.updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>

      {pastEntries.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Past Entries</h3>
          <div className="space-y-2">
            {pastEntries.map((entry) => (
              <Card key={entry.id} data-testid={`card-gratitude-${entry.date}`} className="group relative">
                <CardContent className="py-3 px-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p data-testid={`text-date-${entry.date}`} className="text-xs font-medium text-muted-foreground mb-1">
                        {formatDisplayDate(entry.date)}
                      </p>
                      <p data-testid={`text-content-${entry.date}`} className="text-sm whitespace-pre-wrap break-words">
                        {entry.content}
                      </p>
                    </div>
                    <Button
                      data-testid={`button-delete-${entry.date}`}
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-destructive @sm:opacity-0 @sm:group-hover:opacity-100 transition-opacity"
                      onClick={() => deleteMutation.mutate(entry.date)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {hasMore && (
            <Button
              data-testid="button-load-more"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={handleLoadMore}
              disabled={isLoading}
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
