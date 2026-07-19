import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Calendar,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  FileText,
  Link,
  Loader2,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  Send,
  Trash2,
} from "lucide-react";
import type { Issue, IssueNote, IssueStatus } from "@shared/schema";

const STATUS_ORDER: IssueStatus[] = ["open", "in_progress", "in_review", "resolved"];
const STATUS_LABELS: Record<IssueStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  in_review: "In Review",
  resolved: "Resolved",
};

function StatusIcon({ status }: { status: IssueStatus }) {
  if (status === "resolved") return <CircleCheck className="h-3.5 w-3.5 text-success" />;
  if (status === "in_review") return <CircleDashed className="h-3.5 w-3.5 text-info" />;
  if (status === "in_progress") return <CircleDot className="h-3.5 w-3.5 text-warning" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />;
}

function formatIssueDate(value: Date | string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function IssueNotes({ issue }: { issue: Issue }) {
  const [content, setContent] = useState("");
  const { toast } = useToast();
  const notes = Array.isArray(issue.notes) ? issue.notes as IssueNote[] : [];
  const addNote = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/issues/${issue.id}/notes`, {
        author: "user",
        content: content.trim(),
      });
      return response.json();
    },
    onSuccess: () => {
      setContent("");
      queryClient.invalidateQueries({ queryKey: ["/api/issues", issue.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to add note", description: error.message, variant: "destructive" });
    },
  });

  return (
    <ProfileDetailSection title="Notes" count={notes.length} collapsedContent={notes[notes.length - 1]?.content ? (
      <p className="line-clamp-2 whitespace-pre-wrap text-[14px] leading-tight text-white/80">
        {notes[notes.length - 1].content}
      </p>
    ) : undefined} testId="section-issue-notes">
      <div className="overflow-hidden rounded-md border border-border/20">
        {notes.map((note) => (
          <ProfileTreeRow
            key={note.id}
            label={formatIssueDate(note.timestamp)}
            icon={<MessageSquare className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            expandedContent={(
              <div className="rounded-xl rounded-bl-sm border border-primary/20 bg-card/70 px-3 py-2 text-[14px] leading-tight text-white">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content}</ReactMarkdown>
              </div>
            )}
            expandedContentClassName="px-2 pb-2 pl-2"
            mobileLayout="inline"
            testId={`issue-note-${note.id}`}
          >
            <span className="truncate text-muted-foreground">{note.content}</span>
          </ProfileTreeRow>
        ))}
        <div className="flex items-end gap-2 border-t border-border/20 p-2">
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Add a note..."
            className="min-h-16 resize-none text-sm"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && content.trim()) {
                event.preventDefault();
                addNote.mutate();
              }
            }}
            data-testid="input-inline-issue-note"
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => addNote.mutate()}
            disabled={!content.trim() || addNote.isPending}
            aria-label="Add note"
            data-testid="button-add-inline-issue-note"
          >
            {addNote.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </ProfileDetailSection>
  );
}

export function IssueInlineProfile({ issueId, onDeleted }: { issueId: number; onDeleted?: () => void }) {
  const { toast } = useToast();
  const { data: issue, isLoading } = useQuery<Issue>({
    queryKey: ["/api/issues", issueId],
    queryFn: async () => {
      const response = await fetch(`/api/issues/${issueId}`);
      if (!response.ok) throw new Error(`Failed to fetch issue: ${response.statusText}`);
      return response.json();
    },
  });
  const { data: issueList } = useQuery<{ issues: Issue[] }>({
    queryKey: ["/api/issues", "profile-dependencies"],
    queryFn: async () => {
      const response = await fetch("/api/issues?lightweight=true");
      if (!response.ok) throw new Error(`Failed to fetch issues: ${response.statusText}`);
      return response.json();
    },
  });

  const updateIssue = useMutation({
    mutationFn: async (updates: Partial<Issue>) => {
      const response = await apiRequest("PATCH", `/api/issues/${issueId}`, updates);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/issues", issueId] });
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update issue", description: error.message, variant: "destructive" });
    },
  });

  const deleteIssue = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("DELETE", `/api/issues/${issueId}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["/api/issues", issueId] });
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
      onDeleted?.();
      toast({ title: "Issue deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete issue", description: error.message, variant: "destructive" });
    },
  });

  const dependencyIssues = useMemo(() => {
    const ids = issue?.dependencies || [];
    return (issueList?.issues || []).filter((candidate) => ids.includes(candidate.id));
  }, [issue?.dependencies, issueList?.issues]);

  if (isLoading) {
    return <div className="space-y-2 py-2"><Skeleton className="h-7 w-48" /><Skeleton className="h-24 w-full" /></div>;
  }
  if (!issue) return <p className="py-2 text-sm text-muted-foreground">Issue not found.</p>;

  const status = issue.status as IssueStatus;

  return (
    <div className="space-y-6 py-2" data-testid={`issue-inline-profile-${issue.id}`}>
      <div className="space-y-0">
        <ProfileDetailSection
          title={<span className="block truncate text-xs font-bold uppercase leading-none tracking-wider text-muted-foreground">{issue.title}</span>}
          headerAction={(
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  aria-label="Issue actions"
                >
                  <MoreHorizontal className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => deleteIssue.mutate()}
                  disabled={deleteIssue.isPending}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          collapsedContent={issue.description ? (
            <p className="whitespace-pre-wrap text-[14px] leading-tight text-white/80" data-testid="inline-issue-summary">
              {issue.description}
            </p>
          ) : undefined}
          testId="section-issue-profile"
        >
          <div className="overflow-hidden rounded-md border border-border/20">
            {issue.description ? (
              <ProfileTreeRow label="Description" icon={<FileText className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline">
                <span className="line-clamp-2 whitespace-pre-wrap text-muted-foreground">{issue.description}</span>
              </ProfileTreeRow>
            ) : null}
            <ProfileTreeRow label="Status" icon={<StatusIcon status={status} />} hasValue showEmpty mobileLayout="inline">
              <Select value={status} onValueChange={(value) => updateIssue.mutate({ status: value })}>
                <SelectTrigger className="w-48" data-testid="select-inline-issue-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUS_ORDER.map((value) => <SelectItem key={value} value={value}>{STATUS_LABELS[value]}</SelectItem>)}
                </SelectContent>
              </Select>
            </ProfileTreeRow>
            <ProfileTreeRow label="Created" icon={<Calendar className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline">
              <span className="truncate text-muted-foreground">{formatIssueDate(issue.createdAt)}</span>
            </ProfileTreeRow>
            {issue.page ? (
              <ProfileTreeRow label="Page" icon={<MapPin className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline">
                <span className="truncate font-mono text-muted-foreground">{issue.page}</span>
              </ProfileTreeRow>
            ) : null}
          </div>
        </ProfileDetailSection>

        {issue.spec ? (
          <ProfileDetailSection title="Spec" collapsedContent={<p className="line-clamp-2 text-[14px] leading-tight text-white/80">{issue.spec}</p>} testId="section-issue-spec">
            <div className="overflow-hidden rounded-md border border-border/20 bg-card/70 px-3 py-2 text-sm prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.spec}</ReactMarkdown>
            </div>
          </ProfileDetailSection>
        ) : null}

        {issue.screenshot ? (
          <ProfileDetailSection title="Screenshot" testId="section-issue-screenshot">
            <div className="overflow-hidden rounded-md border border-border/20 p-2">
              <img src={issue.screenshot} alt="Issue screenshot" className="max-w-full rounded-md" />
            </div>
          </ProfileDetailSection>
        ) : null}

        {issue.logs ? (
          <ProfileDetailSection title="Logs" collapsedContent={<p className="truncate font-mono text-xs text-white/80">{issue.logs}</p>} testId="section-issue-logs">
            <pre className="max-h-64 overflow-auto rounded-md border border-border/20 bg-muted p-3 font-mono text-xs">{issue.logs}</pre>
          </ProfileDetailSection>
        ) : null}

        <ProfileDetailSection title="Dependencies" count={dependencyIssues.length} testId="section-issue-dependencies">
          <div className="overflow-hidden rounded-md border border-border/20">
            {dependencyIssues.length > 0 ? dependencyIssues.map((dependency) => (
              <ProfileTreeRow
                key={dependency.id}
                label={`#${dependency.id}`}
                icon={<Link className="h-3.5 w-3.5" />}
                hasValue
                showEmpty
                mobileLayout="inline"
              >
                <span className="truncate text-muted-foreground">{dependency.title}</span>
              </ProfileTreeRow>
            )) : <p className="px-2 py-1.5 text-sm text-muted-foreground">No dependencies linked.</p>}
          </div>
        </ProfileDetailSection>

        <IssueNotes issue={issue} />
      </div>
    </div>
  );
}
