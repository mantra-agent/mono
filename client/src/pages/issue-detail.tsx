import { useState, useRef } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useFocusContext } from "@/hooks/use-focus-context";
import { getInstanceName } from "@/lib/instance-config";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ArrowLeft,
  Circle,
  CircleCheck,
  CircleDot,
  CircleDashed,
  Loader2,
  Trash2,
  Send,
  FileText,
  Image as ImageIcon,
  ScrollText,
  Lightbulb,
  Plus,
  X,
  Link,
  Paperclip,
  User,
  Bot,
  ArrowRight,
  MessageSquare,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Issue, IssueStatus, IssueNote } from "@shared/schema";

const STATUS_ORDER: IssueStatus[] = ["open", "in_progress", "in_review", "resolved"];

const STATUS_LABELS: Record<IssueStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  in_review: "In Review",
  resolved: "Resolved",
};

const STATUS_COLORS: Record<IssueStatus, string> = {
  open: "text-muted-foreground/50",
  in_progress: "text-warning",
  in_review: "text-info",
  resolved: "text-success",
};

function StatusIcon({ status, className }: { status: IssueStatus; className?: string }) {
  const color = STATUS_COLORS[status] || "text-muted-foreground/50";
  switch (status) {
    case "resolved":
      return <CircleCheck className={`${className} ${color}`} />;
    case "in_review":
      return <CircleDashed className={`${className} ${color}`} />;
    case "in_progress":
      return <CircleDot className={`${className} ${color}`} />;
    default:
      return <Circle className={`${className} ${color}`} />;
  }
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}


function formatNoteTime(ts: string) {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

function NoteItem({ note }: { note: IssueNote }) {
  const isUser = note.author === "user";
  const isStatusChange = !!note.statusChange;

  if (isStatusChange && note.statusChange) {
    return (
      <div className="flex items-center gap-2 py-1.5 px-3" data-testid={`note-${note.id}`}>
        <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground">
          Status changed from <span className="font-medium">{STATUS_LABELS[note.statusChange.from as IssueStatus] || note.statusChange.from}</span> to <span className="font-medium">{STATUS_LABELS[note.statusChange.to as IssueStatus] || note.statusChange.to}</span>
        </span>
        <span className="text-xs text-muted-foreground/60 ml-auto shrink-0">{formatNoteTime(note.timestamp)}</span>
      </div>
    );
  }

  return (
    <div className={`flex gap-2.5 py-2 px-3 ${isUser ? "bg-muted/30" : ""}`} data-testid={`note-${note.id}`}>
      <div className={`h-6 w-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${isUser ? "bg-info/15" : "bg-success/15"}`}>
        {isUser ? <User className="h-3 w-3 text-info" /> : <Bot className="h-3 w-3 text-success" />}
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{isUser ? "You" : getInstanceName()}</span>
          <span className="text-xs text-muted-foreground/60">{formatNoteTime(note.timestamp)}</span>
        </div>
        <div className="text-sm prose prose-sm dark:prose-invert max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-p:my-1 prose-strong:text-foreground prose-code:text-foreground prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-muted prose-pre:text-foreground prose-a:text-info prose-ul:my-1 prose-ol:my-1 prose-li:my-0">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content}</ReactMarkdown>
        </div>
        {note.attachments && note.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1">
            {note.attachments.map((att, i) => {
              const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(att.url);
              return isImage ? (
                <a key={i} href={att.url} target="_blank" rel="noopener noreferrer" className="block">
                  <img src={att.url} alt={att.name} className="max-w-[200px] rounded-md border" />
                </a>
              ) : (
                <a key={i} href={att.url} target="_blank" rel="noopener noreferrer" className="text-xs text-info underline flex items-center gap-1">
                  <Paperclip className="h-3 w-3" /> {att.name}
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function NotesThread({ issue, onAddNote, isUploading, handleFileUpload, feedbackFileRef }: {
  issue: Issue;
  onAddNote: any;
  isUploading: boolean;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  feedbackFileRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [noteText, setNoteText] = useState("");
  const [noteFiles, setNoteFiles] = useState<{ name: string; url: string }[]>([]);

  const notes: IssueNote[] = Array.isArray((issue as any).notes) ? (issue as any).notes : [];

  const handleSend = () => {
    if (!noteText.trim() && noteFiles.length === 0) return;
    (onAddNote as any).mutate({
      author: "user",
      content: noteText.trim(),
      attachments: noteFiles.length > 0 ? noteFiles : undefined,
    });
    setNoteText("");
    setNoteFiles([]);
  };

  const uploadFile = async (file: File) => {
    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    try {
      const res = await apiRequest("POST", "/api/issues/attachments", {
        data: dataUrl,
        filename: file.name,
        mimeType: file.type,
      });
      const result = await res.json();
      setNoteFiles(prev => [...prev, { name: file.name, url: result.url }]);
    } catch {}
  };

  const wrappedFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      await uploadFile(file);
    }
    if (feedbackFileRef.current) feedbackFileRef.current.value = "";
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const ext = file.type.split("/")[1] || "png";
          const named = new File([file], `pasted-image-${Date.now()}.${ext}`, { type: file.type });
          await uploadFile(named);
        }
        return;
      }
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
          <MessageSquare className="h-3.5 w-3.5" />
          Notes
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {notes.length > 0 && (
          <div className="divide-y" data-testid="notes-thread">
            {notes.map((note) => (
              <NoteItem key={note.id} note={note} />
            ))}
          </div>
        )}
        {notes.length === 0 && (
          <p className="text-xs text-muted-foreground px-4 py-3">No notes yet.</p>
        )}
        <div className="border-t p-3">
          {noteFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {noteFiles.map((f, i) => {
                const isImg = /\.(png|jpg|jpeg|gif|webp)$/i.test(f.url);
                return isImg ? (
                  <div key={i} className="relative group" data-testid={`badge-note-file-${i}`}>
                    <img src={f.url} alt={f.name} className="h-16 rounded-md border object-cover" />
                    <button
                      onClick={() => setNoteFiles(prev => prev.filter((_, idx) => idx !== i))}
                      className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center invisible group-hover:visible"
                      data-testid={`button-remove-note-file-${i}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <Badge key={i} variant="secondary" className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5 gap-1" data-testid={`badge-note-file-${i}`}>
                    <Paperclip className="h-3 w-3" />
                    <span className="max-w-[150px] truncate">{f.name}</span>
                    <button
                      onClick={() => setNoteFiles(prev => prev.filter((_, idx) => idx !== i))}
                      className="ml-1"
                      data-testid={`button-remove-note-file-${i}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                );
              })}
            </div>
          )}
          <div className="flex gap-2">
            <Textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Add a note... (paste images with Ctrl+V)"
              className="resize-none text-sm min-h-[60px]"
              data-testid="input-note"
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <div className="flex flex-col gap-1">
              <input
                ref={feedbackFileRef as any}
                type="file"
                multiple
                className="hidden"
                onChange={wrappedFileUpload}
                data-testid="input-note-file"
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => feedbackFileRef.current?.click()}
                disabled={isUploading}
                data-testid="button-attach-note-file"
              >
                {isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={handleSend}
                disabled={(!noteText.trim() && noteFiles.length === 0) || (onAddNote as any).isPending}
                data-testid="button-send-note"
              >
                {(onAddNote as any).isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Cmd+Enter to send</p>
        </div>
      </CardContent>
    </Card>
  );
}

function IssueDetail({ issue, allIssues }: { issue: Issue; allIssues: Issue[] }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [isUploading, setIsUploading] = useState(false);
  const feedbackFileRef = useRef<HTMLInputElement>(null);

  const updateMutation = useMutation({
    mutationFn: async (updates: Record<string, any>) => {
      const res = await apiRequest("PATCH", `/api/issues/${issue.id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: async (note: { author: string; content: string; attachments?: { name: string; url: string }[] }) => {
      const res = await apiRequest("POST", `/api/issues/${issue.id}/notes`, note);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add note", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/issues/${issue.id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Issue deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
      setLocation("/build?tab=issues");
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const handleStatusChange = (newStatus: string) => {
    updateMutation.mutate({ status: newStatus });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        const reader = new FileReader();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const res = await apiRequest("POST", "/api/issues/attachments", {
          data: dataUrl,
          filename: file.name,
          mimeType: file.type,
        });
        await res.json();
      }
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
      if (feedbackFileRef.current) feedbackFileRef.current.value = "";
    }
  };

  const currentStatus = issue.status as IssueStatus;
  const currentDeps: number[] = (issue as any).dependencies || [];
  const depIssues = currentDeps.length > 0
    ? allIssues.filter((i) => currentDeps.includes(i.id))
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/build?tab=issues")}
          className="@md:hidden"
          data-testid="button-back-to-issues"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground font-mono">#{issue.id}</span>
        <div className="ml-auto">
          <Select value={currentStatus} onValueChange={handleStatusChange}>
            <SelectTrigger className="w-[140px]" data-testid="select-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_ORDER.map((s) => (
                <SelectItem key={s} value={s} data-testid={`option-status-${s}`}>
                  <div className="flex items-center gap-1.5">
                    <StatusIcon status={s} className="h-3.5 w-3.5" />
                    {STATUS_LABELS[s]}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <h1 className="text-lg font-semibold" data-testid="text-issue-title">{issue.title}</h1>
        {issue.createdAt && (
          <p className="text-xs text-muted-foreground" data-testid="text-issue-date">
            {formatDate(issue.createdAt.toString())}
            {issue.page && <span className="ml-2 font-mono">on {issue.page}</span>}
          </p>
        )}
      </div>

      {issue.description && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
              <FileText className="h-3.5 w-3.5" />
              Description
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap" data-testid="text-issue-description">{issue.description}</p>
          </CardContent>
        </Card>
      )}

      {issue.screenshot && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
              <ImageIcon className="h-3.5 w-3.5" />
              Screenshot
            </CardTitle>
          </CardHeader>
          <CardContent>
            <img
              src={issue.screenshot}
              alt="Issue screenshot"
              className="max-w-full rounded-md border"
              data-testid="img-issue-screenshot"
            />
          </CardContent>
        </Card>
      )}

      {issue.spec && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium flex items-center gap-1.5 text-info">
              <Lightbulb className="h-3.5 w-3.5" />
              Spec
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm prose prose-sm dark:prose-invert max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-strong:text-foreground prose-code:text-foreground prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-muted prose-pre:text-foreground prose-a:text-info prose-table:text-foreground/90 prose-th:text-foreground prose-td:text-foreground/80 prose-th:border-border prose-td:border-border prose-hr:border-border" data-testid="text-issue-spec">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.spec}</ReactMarkdown>
            </div>
          </CardContent>
        </Card>
      )}

      {issue.logs && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
              <ScrollText className="h-3.5 w-3.5" />
              Logs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="p-3 bg-muted rounded-md text-xs overflow-auto max-h-48 font-mono" data-testid="text-issue-logs">
              {issue.logs}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
            <Link className="h-3.5 w-3.5" />
            Dependencies
            <Popover>
              <PopoverTrigger asChild>
                <Button size="icon" variant="ghost" className="h-6 w-6 ml-auto" data-testid="button-add-dependency">
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-2" align="end">
                <p className="text-xs font-medium text-muted-foreground mb-2 px-1">Select dependencies</p>
                <ScrollArea className="max-h-64">
                  <div className="space-y-0.5">
                    {allIssues
                      .filter((i) => i.id !== issue.id && i.status !== "resolved")
                      .map((candidate) => {
                        const isSelected = currentDeps.includes(candidate.id);
                        return (
                          <button
                            key={candidate.id}
                            onClick={() => {
                              const newDeps = isSelected
                                ? currentDeps.filter((d) => d !== candidate.id)
                                : [...currentDeps, candidate.id];
                              updateMutation.mutate({ dependencies: newDeps });
                            }}
                            className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${
                              isSelected ? "bg-primary/10" : "hover-elevate"
                            }`}
                            data-testid={`dep-option-${candidate.id}`}
                          >
                            <StatusIcon status={candidate.status as IssueStatus} className="h-3.5 w-3.5 shrink-0" />
                            <span className="text-muted-foreground font-mono text-xs shrink-0">#{candidate.id}</span>
                            <span className="truncate">{candidate.title}</span>
                            {isSelected && <CircleCheck className="h-3.5 w-3.5 text-primary shrink-0 ml-auto" />}
                          </button>
                        );
                      })}
                  </div>
                </ScrollArea>
              </PopoverContent>
            </Popover>
          </CardTitle>
        </CardHeader>
        {depIssues.length > 0 && (
          <CardContent>
            <div className="space-y-1">
              {depIssues.map((dep) => (
                <div key={dep.id} className="flex items-center gap-2 group">
                  <button
                    onClick={() => setLocation(`/issues/${dep.id}`)}
                    className="flex items-center gap-2 flex-1 text-left px-2 py-1.5 rounded-md text-sm hover-elevate min-w-0"
                    data-testid={`link-dep-${dep.id}`}
                  >
                    <StatusIcon status={dep.status as IssueStatus} className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-muted-foreground font-mono text-xs shrink-0">#{dep.id}</span>
                    <span className="truncate">{dep.title}</span>
                  </button>
                  <button
                    onClick={() => {
                      const newDeps = currentDeps.filter((d) => d !== dep.id);
                      updateMutation.mutate({ dependencies: newDeps });
                    }}
                    className="invisible group-hover:visible shrink-0 p-0.5 rounded hover-elevate"
                    data-testid={`button-remove-dep-${dep.id}`}
                  >
                    <X className="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>
              ))}
            </div>
          </CardContent>
        )}
        {depIssues.length === 0 && (
          <CardContent>
            <p className="text-xs text-muted-foreground">No dependencies linked.</p>
          </CardContent>
        )}
      </Card>

      <NotesThread issue={issue} onAddNote={addNoteMutation} isUploading={isUploading} handleFileUpload={handleFileUpload} feedbackFileRef={feedbackFileRef} />

      <div className="flex justify-end pt-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => deleteMutation.mutate()}
          disabled={deleteMutation.isPending}
          className="text-destructive"
          data-testid="button-delete-issue"
        >
          {deleteMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          )}
          Delete Issue
        </Button>
      </div>
    </div>
  );
}

export default function IssueDetailPage() {
  usePageHeader({ title: "Issues" });
  const [, params] = useRoute("/issues/:id");
  const [, setLocation] = useLocation();
  const issueId = params?.id ? parseInt(params.id, 10) : null;

  const { data: listData, isLoading: listLoading } = useQuery<{ issues: Issue[] }>({
    queryKey: ["/api/issues", "active"],
    queryFn: async () => {
      const res = await fetch("/api/issues?lightweight=true&exclude_status=resolved");
      if (!res.ok) throw new Error(`Failed to fetch issues: ${res.statusText}`);
      return res.json();
    },
  });

  const { data: issueData, isLoading: issueLoading } = useQuery<Issue>({
    queryKey: ["/api/issues", issueId],
    queryFn: async () => {
      const res = await fetch(`/api/issues/${issueId}`);
      if (!res.ok) throw new Error(`Failed to fetch issue: ${res.statusText}`);
      return res.json();
    },
    enabled: issueId !== null,
  });

  const allIssues = listData?.issues || [];
  const issue = issueData;
  const isLoading = listLoading || issueLoading;

  useFocusContext(
    issueId !== null ? { entity: { type: "issue", id: String(issueId), label: issue?.title } } : null
  );

  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!issue) {
    return (
      <div className="p-4">
        <Button variant="ghost" onClick={() => setLocation("/build?tab=issues")} data-testid="button-back-to-issues">
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to Issues
        </Button>
        <div className="mt-8 text-center text-muted-foreground" data-testid="text-issue-not-found">Issue not found.</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="p-4">
        <IssueDetail issue={issue} allIssues={allIssues} />
      </div>
    </div>
  );
}
