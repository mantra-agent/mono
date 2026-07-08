import { useState, useCallback, useMemo, useSyncExternalStore } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Megaphone,
  Plus,
  Check,
  X,
  Pencil,
  Trash2,
  Send,
  Loader2,
  RefreshCw,
  Calendar,
  List,
  ExternalLink,
  Clock,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  BarChart3,
  MessageCircle,
  Image,
  Scissors,
} from "lucide-react";
import { MediaGrid } from "@/components/create/media-grid";
import { StitchPanel } from "@/components/create/stitch-panel";

// --- Content types & helpers (from social.tsx) ---

interface ContentPost {
  id: string;
  platform: string;
  content: string;
  threadParts: string[] | null;
  status: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  platformPostId: string | null;
  platformUrl: string | null;
  metadata: Record<string, unknown> | null;
  rejectReason: string | null;
  retryCount: number;
  calendarEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
  { value: "failed", label: "Failed" },
  { value: "rejected", label: "Rejected" },
];

function statusBadgeVariant(status: string): string {
  switch (status) {
    case "draft": return "bg-info/10 text-info-foreground dark:bg-info/10/30 dark:text-info";
    case "scheduled": return "bg-success/10 text-success-foreground";
    case "publishing": return "bg-warning/10 text-warning-foreground";
    case "published": return "bg-success/10 text-success-foreground";
    case "failed": return "bg-error/10 text-error-foreground";
    case "rejected": return "bg-neutral/10 text-neutral-foreground";
    default: return "bg-neutral/10 text-neutral-foreground";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "draft": return "Ready to review";
    case "scheduled": return "Scheduled";
    case "publishing": return "Publishing…";
    case "published": return "Published";
    case "failed": return "Failed";
    case "rejected": return "Rejected";
    default: return status;
  }
}

function toChicagoDateStr(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function formatScheduledTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " CT";
}

function toChicagoDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const dateStr = d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const timeStr = d.toLocaleTimeString("en-GB", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit" });
  return `${dateStr}T${timeStr}`;
}

function fromChicagoDateTimeLocal(dtLocal: string): string {
  const [datePart, timePart] = dtLocal.split("T");
  if (!datePart || !timePart) return "";
  const chicagoStr = `${datePart}T${timePart}:00`;
  const testDate = new Date(chicagoStr);
  const utcStr = testDate.toLocaleString("en-US", { timeZone: "America/Chicago" });
  const chicagoTime = new Date(utcStr);
  const offset = testDate.getTime() - chicagoTime.getTime();
  return new Date(testDate.getTime() + offset).toISOString();
}

// --- Schedule Picker ---

function SchedulePicker({
  value,
  onChange,
  suggestedTimes,
  label,
  helpText,
  testIdPrefix,
}: {
  value: string;
  onChange: (val: string) => void;
  suggestedTimes?: string[];
  label?: string;
  helpText?: string;
  testIdPrefix: string;
}) {
  const displayValue = value ? toChicagoDateTimeLocal(value) : "";
  const datePart = displayValue ? displayValue.slice(0, 10) : "";
  const timePart = displayValue ? displayValue.slice(11, 16) : "";

  const handleDateChange = (newDate: string) => {
    if (!newDate) { onChange(""); return; }
    const time = timePart || "09:00";
    onChange(fromChicagoDateTimeLocal(`${newDate}T${time}`));
  };

  const handleTimeChange = (newTime: string) => {
    if (!newTime) return;
    const date = datePart || toChicagoDateStr(new Date());
    onChange(fromChicagoDateTimeLocal(`${date}T${newTime}`));
  };

  return (
    <div className="space-y-2">
      {label && <label className="text-sm font-medium text-foreground">{label}</label>}
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <input
            type="date"
            value={datePart}
            onChange={(e) => handleDateChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`${testIdPrefix}-date`}
          />
        </div>
        <div className="flex-shrink-0">
          <input
            type="time"
            value={timePart}
            onChange={(e) => handleTimeChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`${testIdPrefix}-time`}
          />
        </div>
        <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">CT</span>
      </div>
      {value && (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatScheduledTime(value)}
          </p>
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-xs text-muted-foreground hover:text-foreground underline"
            data-testid={`${testIdPrefix}-clear`}
          >
            Clear
          </button>
        </div>
      )}
      {!value && helpText && (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      )}
      {suggestedTimes && suggestedTimes.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Suggested optimal times:</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestedTimes.slice(0, 4).map((time) => (
              <button
                key={time}
                type="button"
                onClick={() => onChange(time)}
                className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                  value === time
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-input bg-background hover:bg-accent text-foreground"
                }`}
                data-testid={`${testIdPrefix}-suggest-${time}`}
              >
                {formatScheduledTime(time)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Content Tab ---

function ContentTab() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editPost, setEditPost] = useState<ContentPost | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editThreadParts, setEditThreadParts] = useState<string[] | null>(null);
  const [editScheduledAt, setEditScheduledAt] = useState<string>("");
  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [approveSchedules, setApproveSchedules] = useState<Array<{ id: string; scheduledAt: string }>>([]);
  const [showNewPostDialog, setShowNewPostDialog] = useState(false);
  const [newPostContent, setNewPostContent] = useState("");
  const [newPostScheduledAt, setNewPostScheduledAt] = useState("");
  const [rejectPostId, setRejectPostId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  const [calendarWeekStart, setCalendarWeekStart] = useState(() => {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now);
    monday.setDate(diff);
    monday.setHours(0, 0, 0, 0);
    return monday;
  });
  const { toast } = useToast();

  const postsQuery = useQuery<ContentPost[]>({
    queryKey: ["/api/content", statusFilter !== "all" ? `?status=${statusFilter}` : ""],
  });

  const suggestionsQuery = useQuery<{ times: string[] }>({
    queryKey: ["/api/content/suggestions", `?count=${selectedIds.size || 7}`],
    enabled: showApproveDialog || showNewPostDialog || !!editPost,
  });

  const createMutation = useMutation({
    mutationFn: async (data: { content: string; platform?: string }) => {
      const res = await apiRequest("POST", "/api/content", data);
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/content"] });
      setShowNewPostDialog(false);
      setNewPostContent("");
      setNewPostScheduledAt("");
      toast({ title: (variables as any).scheduledAt ? "Post scheduled" : "Draft created" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: string } & Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/content/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/content"] });
      setEditPost(null);
      toast({ title: "Post updated" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/content/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/content"] });
      toast({ title: "Post deleted" });
    },
  });

  const batchApproveMutation = useMutation({
    mutationFn: async (items: Array<{ id: string; scheduledAt: string }>) => {
      const res = await apiRequest("POST", "/api/content/batch-approve", { items });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/content"] });
      setShowApproveDialog(false);
      setSelectedIds(new Set());
      setApproveSchedules([]);
      toast({ title: "Posts approved and scheduled" });
    },
  });

  const manualPublishMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/content/${id}/publish`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/content"] });
      toast({ title: "Post published" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const res = await apiRequest("PATCH", `/api/content/${id}`, {
        status: "rejected",
        rejectReason: reason || null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/content"] });
      setRejectPostId(null);
      setRejectReason("");
      toast({ title: "Post rejected" });
    },
  });

  const posts = postsQuery.data || [];

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openApproveDialog = useCallback(() => {
    const selected = posts.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0) return;
    setApproveSchedules(selected.map((p) => ({ id: p.id, scheduledAt: "" })));
    setShowApproveDialog(true);
  }, [posts, selectedIds]);

  const handleApproveWithTimes = useCallback(() => {
    const times = suggestionsQuery.data?.times || [];
    const items = approveSchedules.map((item, i) => ({
      id: item.id,
      scheduledAt: item.scheduledAt || times[i] || new Date(Date.now() + (i + 1) * 4 * 60 * 60 * 1000).toISOString(),
    }));
    batchApproveMutation.mutate(items);
  }, [approveSchedules, suggestionsQuery.data, batchApproveMutation]);

  const openEditSheet = useCallback((post: ContentPost) => {
    setEditPost(post);
    setEditContent(post.content);
    setEditThreadParts(post.threadParts);
    setEditScheduledAt(post.scheduledAt || "");
  }, []);

  const saveEdit = useCallback(() => {
    if (!editPost) return;
    const updates: Record<string, unknown> = {
      id: editPost.id,
      content: editContent,
      threadParts: editThreadParts,
    };
    if (editScheduledAt) {
      updates.scheduledAt = editScheduledAt;
      if (editPost.status === "draft") {
        updates.status = "scheduled";
      }
    } else if (editPost.scheduledAt && !editScheduledAt) {
      updates.scheduledAt = null;
      if (editPost.status === "scheduled") {
        updates.status = "draft";
      }
    }
    updateMutation.mutate(updates as { id: string });
  }, [editPost, editContent, editThreadParts, editScheduledAt, updateMutation]);

  const charCount = editContent.length;
  const isOverLimit = charCount > 280 && (!editThreadParts || editThreadParts.length <= 1);

  const calendarDays = useMemo(() => {
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(calendarWeekStart);
      day.setDate(day.getDate() + i);
      days.push(day);
    }
    return days;
  }, [calendarWeekStart]);

  const postsByDay = useMemo(() => {
    const map = new Map<string, ContentPost[]>();
    for (const post of posts) {
      const dateStr = post.scheduledAt
        ? toChicagoDateStr(post.scheduledAt)
        : toChicagoDateStr(post.createdAt);
      const existing = map.get(dateStr) || [];
      existing.push(post);
      map.set(dateStr, existing);
    }
    return map;
  }, [posts]);

  if (postsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="loading-content">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={statusFilter === f.value ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter(f.value)}
              data-testid={`filter-${f.value}`}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border rounded-md">
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="sm"
              className="rounded-r-none"
              onClick={() => setViewMode("list")}
              data-testid="view-list"
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "calendar" ? "secondary" : "ghost"}
              size="sm"
              className="rounded-l-none"
              onClick={() => setViewMode("calendar")}
              data-testid="view-calendar"
            >
              <Calendar className="h-4 w-4" />
            </Button>
          </div>
          <Button size="sm" onClick={() => setShowNewPostDialog(true)} data-testid="button-new-post">
            <Plus className="h-4 w-4 mr-1" /> New Post
          </Button>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 p-3 bg-accent/50 rounded-lg border" data-testid="batch-action-bar">
          <span className="text-sm font-medium" data-testid="text-selected-count">{selectedIds.size} selected</span>
          <Button size="sm" onClick={openApproveDialog} data-testid="button-approve-selected">
            <Check className="h-4 w-4 mr-1" /> Approve Selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelectedIds(new Set())}
            data-testid="button-clear-selection"
          >
            <X className="h-4 w-4 mr-1" /> Clear
          </Button>
        </div>
      )}

      {viewMode === "list" ? (
        posts.length === 0 ? (
          <EmptyState onNewPost={() => setShowNewPostDialog(true)} />
        ) : (
          <div className="space-y-2">
            {posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                isSelected={selectedIds.has(post.id)}
                onToggleSelect={() => toggleSelect(post.id)}
                onEdit={() => openEditSheet(post)}
                onReject={() => setRejectPostId(post.id)}
                onDelete={() => deleteMutation.mutate(post.id)}
                onPublish={() => manualPublishMutation.mutate(post.id)}
                onRetry={() => updateMutation.mutate({ id: post.id, status: "scheduled", scheduledAt: new Date().toISOString() })}
                isPublishing={manualPublishMutation.isPending}
              />
            ))}
          </div>
        )
      ) : (
        <CalendarView
          days={calendarDays}
          postsByDay={postsByDay}
          onPrevWeek={() => {
            const prev = new Date(calendarWeekStart);
            prev.setDate(prev.getDate() - 7);
            setCalendarWeekStart(prev);
          }}
          onNextWeek={() => {
            const next = new Date(calendarWeekStart);
            next.setDate(next.getDate() + 7);
            setCalendarWeekStart(next);
          }}
          onPostClick={openEditSheet}
          weekStart={calendarWeekStart}
        />
      )}

      <Dialog open={showNewPostDialog} onOpenChange={setShowNewPostDialog}>
        <DialogContent data-testid="dialog-new-post">
          <DialogHeader>
            <DialogTitle>New Post</DialogTitle>
          </DialogHeader>
          <Textarea
            value={newPostContent}
            onChange={(e) => setNewPostContent(e.target.value)}
            placeholder="What's on your mind?"
            className="min-h-[120px]"
            data-testid="input-new-post-content"
          />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{newPostContent.length}/280</span>
            {newPostContent.length > 280 && (
              <span className="text-warning flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Consider using a thread
              </span>
            )}
          </div>
          <SchedulePicker
            value={newPostScheduledAt}
            onChange={setNewPostScheduledAt}
            suggestedTimes={suggestionsQuery.data?.times}
            label="Schedule (optional)"
            helpText="Leave empty to save as draft"
            testIdPrefix="new-post-schedule"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewPostDialog(false)} data-testid="button-cancel-new-post">Cancel</Button>
            <Button
              onClick={() => {
                const payload: Record<string, unknown> = { content: newPostContent };
                if (newPostScheduledAt) {
                  payload.scheduledAt = newPostScheduledAt;
                  payload.status = "scheduled";
                }
                createMutation.mutate(payload as { content: string });
              }}
              disabled={!newPostContent.trim() || createMutation.isPending}
              data-testid="button-save-draft"
            >
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {newPostScheduledAt ? "Schedule Post" : "Save as Draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={!!editPost} onOpenChange={(open) => !open && setEditPost(null)}>
        <SheetContent className="sm:max-w-lg" data-testid="sheet-edit-post">
          <SheetHeader>
            <SheetTitle>Edit Post</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 mt-4">
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[160px]"
              data-testid="input-edit-content"
            />
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span className={isOverLimit ? "text-error font-medium" : ""}>
                {charCount}/280
              </span>
              {isOverLimit && (
                <span className="text-error flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Exceeds single tweet limit
                </span>
              )}
            </div>
            {editPost && (
              <div className="space-y-4 text-sm">
                <div className="text-muted-foreground">Status: {statusLabel(editPost.status)}</div>
                {(editPost.status === "draft" || editPost.status === "scheduled") && (
                  <SchedulePicker
                    value={editScheduledAt}
                    onChange={setEditScheduledAt}
                    suggestedTimes={suggestionsQuery.data?.times}
                    label="Scheduled Time"
                    helpText="Set a date and time to schedule this post"
                    testIdPrefix="edit-schedule"
                  />
                )}
                {editPost.status !== "draft" && editPost.status !== "scheduled" && editPost.scheduledAt && (
                  <div className="text-muted-foreground">Scheduled: {formatScheduledTime(editPost.scheduledAt)}</div>
                )}
                {editPost.platformUrl && (
                  <a
                    href={editPost.platformUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-primary hover:underline"
                    data-testid="link-tweet-url"
                  >
                    View on X <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setEditPost(null)} data-testid="button-cancel-edit">Cancel</Button>
              <Button onClick={saveEdit} disabled={updateMutation.isPending} data-testid="button-save-edit">
                {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Save
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
        <DialogContent className="max-w-2xl" data-testid="dialog-approve">
          <DialogHeader>
            <DialogTitle>Approve & Schedule Posts</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-[400px] overflow-y-auto">
            {approveSchedules.map((item, i) => {
              const post = posts.find((p) => p.id === item.id);
              const suggestedTime = suggestionsQuery.data?.times?.[i];
              return (
                <div key={item.id} className="p-3 border rounded-lg space-y-2" data-testid={`approve-item-${item.id}`}>
                  <p className="text-sm truncate">{post?.content || item.id}</p>
                  <SchedulePicker
                    value={item.scheduledAt || suggestedTime || ""}
                    onChange={(val) => {
                      const next = [...approveSchedules];
                      next[i] = { ...next[i], scheduledAt: val };
                      setApproveSchedules(next);
                    }}
                    testIdPrefix={`approve-schedule-${i}`}
                  />
                </div>
              );
            })}
          </div>
          {suggestionsQuery.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading suggested times…
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApproveDialog(false)} data-testid="button-cancel-approve">Cancel</Button>
            <Button
              onClick={handleApproveWithTimes}
              disabled={batchApproveMutation.isPending}
              data-testid="button-confirm-approve"
            >
              {batchApproveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Check className="h-4 w-4 mr-1" />}
              Approve {approveSchedules.length} Posts
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!rejectPostId} onOpenChange={(open) => !open && setRejectPostId(null)}>
        <AlertDialogContent data-testid="dialog-reject">
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Post</AlertDialogTitle>
            <AlertDialogDescription>
              Provide an optional reason so Agent can improve future drafts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Optional reason…"
            className="min-h-[80px]"
            data-testid="input-reject-reason"
          />
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-reject">Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => rejectPostId && rejectMutation.mutate({ id: rejectPostId, reason: rejectReason })}
              disabled={rejectMutation.isPending}
              data-testid="button-confirm-reject"
            >
              Reject
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// --- Post Card ---

function PostCard({
  post,
  isSelected,
  onToggleSelect,
  onEdit,
  onReject,
  onDelete,
  onPublish,
  onRetry,
  isPublishing,
}: {
  post: ContentPost;
  isSelected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onReject: () => void;
  onDelete: () => void;
  onPublish: () => void;
  onRetry: () => void;
  isPublishing: boolean;
}) {
  const isDraft = post.status === "draft";
  const isScheduled = post.status === "scheduled";
  const isPublished = post.status === "published";
  const isFailed = post.status === "failed";
  const isRejected = post.status === "rejected";

  return (
    <Card className="p-4" data-testid={`card-post-${post.id}`}>
      <div className="flex items-start gap-3">
        {(isDraft || isScheduled) && (
          <Checkbox
            checked={isSelected}
            onCheckedChange={onToggleSelect}
            className="mt-1"
            data-testid={`checkbox-select-${post.id}`}
          />
        )}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={`text-xs ${statusBadgeVariant(post.status)}`} data-testid={`badge-status-${post.id}`}>
              {statusLabel(post.status)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {post.platform === "x" ? "𝕏" : post.platform}
            </span>
            {post.scheduledAt && !isPublished && (
              <span className="text-xs text-muted-foreground flex items-center gap-1" data-testid={`text-scheduled-${post.id}`}>
                <Clock className="h-3 w-3" />
                {formatScheduledTime(post.scheduledAt)}
              </span>
            )}
            {isPublished && post.publishedAt && (
              <span className="text-xs text-muted-foreground" data-testid={`text-published-${post.id}`}>
                Published {formatScheduledTime(post.publishedAt)}
              </span>
            )}
          </div>
          <p className="text-sm leading-relaxed whitespace-pre-wrap" data-testid={`text-content-${post.id}`}>
            {post.content}
          </p>
          {post.threadParts && post.threadParts.length > 1 && (
            <p className="text-xs text-muted-foreground">{post.threadParts.length}-part thread</p>
          )}
          {isFailed && post.metadata && (post.metadata as any).lastError && (
            <div className="flex items-center gap-1 text-xs text-error" data-testid={`text-error-${post.id}`}>
              <AlertTriangle className="h-3 w-3" />
              {String((post.metadata as any).lastError)}
            </div>
          )}
          {isRejected && post.rejectReason && (
            <p className="text-xs text-muted-foreground italic" data-testid={`text-reject-reason-${post.id}`}>
              Reason: {post.rejectReason}
            </p>
          )}
          {isPublished && post.platformUrl && (
            <a
              href={post.platformUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline flex items-center gap-1"
              data-testid={`link-platform-url-${post.id}`}
            >
              View on X <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {(isDraft || isScheduled) && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} data-testid={`button-edit-${post.id}`}>
              <Pencil className="h-4 w-4" />
            </Button>
          )}
          {isDraft && (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-primary" onClick={onPublish} disabled={isPublishing} data-testid={`button-publish-${post.id}`}>
              <Send className="h-4 w-4" />
            </Button>
          )}
          {(isDraft || isScheduled) && (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onReject} data-testid={`button-reject-${post.id}`}>
              <X className="h-4 w-4" />
            </Button>
          )}
          {isFailed && (
            <Button variant="ghost" size="sm" onClick={onRetry} data-testid={`button-retry-${post.id}`}>
              <RefreshCw className="h-4 w-4 mr-1" /> Retry
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={onDelete} data-testid={`button-delete-${post.id}`}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

// --- Calendar View ---

function CalendarView({
  days,
  postsByDay,
  onPrevWeek,
  onNextWeek,
  onPostClick,
  weekStart,
}: {
  days: Date[];
  postsByDay: Map<string, ContentPost[]>;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onPostClick: (post: ContentPost) => void;
  weekStart: Date;
}) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onPrevWeek} data-testid="button-prev-week">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">
          {weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} –{" "}
          {weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        </span>
        <Button variant="ghost" size="sm" onClick={onNextWeek} data-testid="button-next-week">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((day) => {
          const dateStr = toChicagoDateStr(day);
          const dayPosts = postsByDay.get(dateStr) || [];
          const isToday = dateStr === toChicagoDateStr(new Date());

          return (
            <div
              key={dateStr}
              className={`border rounded-lg p-2 min-h-[120px] ${isToday ? "border-primary bg-primary/5" : ""}`}
              data-testid={`calendar-day-${dateStr}`}
            >
              <div className="text-xs font-medium text-muted-foreground mb-1">
                {day.toLocaleDateString("en-US", { weekday: "short" })}
                <span className={`ml-1 ${isToday ? "text-primary font-bold" : ""}`}>
                  {day.getDate()}
                </span>
              </div>
              <div className="space-y-1">
                {dayPosts.map((post) => (
                  <button
                    key={post.id}
                    className={`w-full text-left rounded px-1.5 py-0.5 text-xs truncate cursor-pointer hover:opacity-80 ${statusBadgeVariant(post.status)}`}
                    onClick={() => onPostClick(post)}
                    data-testid={`calendar-post-${post.id}`}
                  >
                    {post.content.slice(0, 30)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Empty & Coming Soon states ---

function EmptyState({ onNewPost }: { onNewPost: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center" data-testid="empty-state">
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
        <Megaphone className="h-6 w-6 text-primary" />
      </div>
      <h3 className="text-lg font-semibold mb-2">Your content pipeline is ready</h3>
      <p className="text-sm text-muted-foreground max-w-md mb-6">
        Agent drafts posts from your manifesto and voice standard. They queue here for your review. Approve with a single click, and they publish automatically at optimal times.
      </p>
      <div className="flex gap-3">
        <Button onClick={onNewPost} data-testid="button-create-first-post">
          <Plus className="h-4 w-4 mr-1" /> Create a Post
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mt-4">
        Or ask Agent to draft posts from your manifesto
      </p>
    </div>
  );
}

function ComingSoonTab({ title, icon: Icon }: { title: string; icon: typeof BarChart3 }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center" data-testid={`coming-soon-${title.toLowerCase()}`}>
      <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground">Coming soon</p>
    </div>
  );
}

// --- Tab navigation ---

const TABS = [
  { value: "content", label: "Content", icon: <Megaphone className="h-3.5 w-3.5" />, testId: "tab-content" },
  { value: "engagement", label: "Engagement", icon: <MessageCircle className="h-3.5 w-3.5" />, testId: "tab-engagement" },
  { value: "analytics", label: "Analytics", icon: <BarChart3 className="h-3.5 w-3.5" />, testId: "tab-analytics" },
  { value: "media", label: "Media", icon: <Image className="h-3.5 w-3.5" />, testId: "tab-create-media" },
  { value: "stitch", label: "Stitch", icon: <Scissors className="h-3.5 w-3.5" />, testId: "tab-create-stitch" },
] as const;

const VALID_TABS = TABS.map(t => t.value) as readonly string[];
type CreateTab = typeof TABS[number]["value"];

function useHashTab(): [CreateTab, (t: string) => void] {
  const getHash = useCallback(() => window.location.hash.replace(/^#/, "") || "content", []);
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("hashchange", cb);
    return () => window.removeEventListener("hashchange", cb);
  }, []);
  const raw = useSyncExternalStore(subscribe, getHash, getHash);
  const tab = (VALID_TABS.includes(raw) ? raw : "content") as CreateTab;
  const setTab = useCallback((t: string) => { window.location.hash = t; }, []);
  return [tab, setTab];
}

// --- Page Component ---

export default function CreatePage() {
  const [tab, setTab] = useHashTab();
  const tabs = useMemo(() => TABS.map(t => ({ ...t })), []);
  usePageHeader({ title: "Create", tabs, activeTab: tab, onTabChange: setTab });

  return (
    <div className="flex flex-col">
      {tab === "content" && <div className="p-4 @md:p-6"><ContentTab /></div>}
      {tab === "engagement" && <div className="p-4 @md:p-6"><ComingSoonTab title="Engagement" icon={MessageCircle} /></div>}
      {tab === "analytics" && <div className="p-4 @md:p-6"><ComingSoonTab title="Analytics" icon={BarChart3} /></div>}
      {tab === "media" && <MediaGrid />}
      {tab === "stitch" && <StitchPanel />}
    </div>
  );
}
