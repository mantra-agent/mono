import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bug, Circle, CircleCheck, CircleDashed, CircleDot, MessageSquare, MoreHorizontal, Plus, Search } from "lucide-react";
import { IssueInlineProfile } from "@/components/issue-inline-profile";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { openIssueCaptureDialog } from "@/components/issue-capture";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgendaDiscussion } from "@/hooks/use-agenda-discussion";
import { cn } from "@/lib/utils";
import { queryClient } from "@/lib/queryClient";

interface Issue {
  id: string;
  title: string;
  description: string;
  reproSteps?: string;
  status: "open" | "in_progress" | "in_review" | "resolved";
  createdAt?: string;
}

interface ErrorAggregate {
  fingerprint: string;
  error_class: string;
  error_code: string | null;
  source_file: string | null;
  source_line: number | null;
  source_site: string | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

interface PersonaOption { id: number; name: string }

const statusLabel = { open: "Open", in_progress: "In progress", in_review: "In review", resolved: "Resolved" } as const;
const nextStatus = { open: "in_progress", in_progress: "in_review", in_review: "resolved", resolved: "open" } as const;

function StatusIcon({ status, className }: { status: Issue["status"]; className?: string }) {
  if (status === "resolved") return <CircleCheck className={cn(className, "text-success")} />;
  if (status === "in_review") return <CircleDashed className={cn(className, "text-info")} />;
  if (status === "in_progress") return <CircleDot className={cn(className, "text-warning")} />;
  return <Circle className={cn(className, "text-muted-foreground")} />;
}

function RowMenu({ onDiscuss }: { onDiscuss: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="More actions" onClick={(event) => event.stopPropagation()}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onDiscuss}><MessageSquare className="mr-2 h-4 w-4" />Discuss</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IssueRow({ issue, onCycleStatus, onDiscuss }: { issue: Issue; onCycleStatus: (id: string, status: Issue["status"]) => void; onDiscuss: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const details: ReactNode = expanded ? <div className="px-8 pb-3"><IssueInlineProfile issueId={issue.id} /></div> : null;
  return (
    <>
      <ProfileTreeRow
        depth={0}
        icon={
          <Tooltip><TooltipTrigger asChild><button type="button" onClick={(event) => { event.stopPropagation(); onCycleStatus(issue.id, nextStatus[issue.status]); }} aria-label={`Move to ${statusLabel[nextStatus[issue.status]]}`}><StatusIcon status={issue.status} className="h-4 w-4" /></button></TooltipTrigger><TooltipContent>{statusLabel[issue.status]}</TooltipContent></Tooltip>
        }
        title={issue.title}
        subtitle={issue.description}
        isOpen={expanded}
        onToggle={() => setExpanded((value) => !value)}
        menuContent={<RowMenu onDiscuss={onDiscuss} />}
      />
      {details}
    </>
  );
}

function TreeSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section className="overflow-hidden rounded-lg border bg-card"><div className="flex items-center gap-2 border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><span>{title}</span><span className="tabular-nums">{count}</span></div><div>{children}</div></section>;
}

function ErrorRow({ error, onDiscuss }: { error: ErrorAggregate; onDiscuss: () => void }) {
  const source = error.source_file ? `${error.source_file}${error.source_line ? `:${error.source_line}` : ""}` : "Source unavailable";
  return <ProfileTreeRow depth={0} icon={<AlertTriangle className="h-4 w-4 text-destructive" />} title={error.error_class} subtitle={`${error.occurrence_count} occurrence${error.occurrence_count === 1 ? "" : "s"} · ${source}`} menuContent={<RowMenu onDiscuss={onDiscuss} />} />;
}

export function IssuesTab() {
  const [search, setSearch] = useState("");
  const discussion = useAgendaDiscussion();
  const { data: personasData } = useQuery<PersonaOption[]>({ queryKey: ["/api/personas"] });
  const personas = Array.isArray(personasData) ? personasData : [];
  const engineerId = personas.find((persona) => persona.name.toLowerCase() === "engineer")?.id;
  // /api/issues returns { issues: Issue[] }, not a bare array — match issue-detail / issue-inline-profile.
  const { data: issuesData, isLoading } = useQuery<{ issues: Issue[] }>({
    queryKey: ["/api/issues", "open"],
    queryFn: async () => {
      const response = await fetch("/api/issues?lightweight=true&exclude_status=resolved");
      if (!response.ok) throw new Error("Failed to fetch issues");
      return response.json();
    },
  });
  const issues = Array.isArray(issuesData?.issues) ? issuesData.issues : [];
  const { data: errorsData } = useQuery<ErrorAggregate[]>({
    queryKey: ["/api/issues/errors/recent"],
    queryFn: async () => {
      const response = await fetch("/api/issues/errors/recent?limit=25");
      if (!response.ok) throw new Error("Failed to fetch recent errors");
      return response.json();
    },
  });
  const errors = Array.isArray(errorsData) ? errorsData : [];
  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: Issue["status"] }) => {
      const response = await fetch(`/api/issues/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error("Failed to update issue");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
  });
  const normalized = search.trim().toLowerCase();
  const filteredIssues = useMemo(
    () =>
      issues.filter(
        (issue) =>
          !normalized ||
          `${issue.title} ${issue.description} ${issue.reproSteps ?? ""}`
            .toLowerCase()
            .includes(normalized),
      ),
    [issues, normalized],
  );
  const filteredErrors = useMemo(
    () =>
      errors.filter(
        (error) =>
          !normalized ||
          `${error.error_class} ${error.error_code ?? ""} ${error.source_file ?? ""} ${error.source_line ?? ""}`
            .toLowerCase()
            .includes(normalized),
      ),
    [errors, normalized],
  );
  const discuss = (title: string, message: string, suffix: string) =>
    discussion.mutate({ title, message, clientTurnSuffix: suffix, personaId: engineerId });

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search issues and errors..." className="pl-9" /></div>
        <Button onClick={openIssueCaptureDialog}><Plus className="mr-2 h-4 w-4" />New Issue</Button>
      </div>
      <TreeSection title="Errors" count={filteredErrors.length}>
        {filteredErrors.length ? filteredErrors.map((error) => <ErrorRow key={error.fingerprint} error={error} onDiscuss={() => discuss(`Error: ${error.error_class}`, `Investigate this privacy-safe error aggregate:\n\n- Error: ${error.error_class}\n- Code: ${error.error_code ?? "Unavailable"}\n- Count: ${error.occurrence_count}\n- Source: ${error.source_file ?? "Unavailable"}${error.source_line ? `:${error.source_line}` : ""}\n- Fingerprint: ${error.fingerprint}`, `error-${error.fingerprint}`)} />) : <div className="px-8 py-3 text-sm text-muted-foreground">No recent errors.</div>}
      </TreeSection>
      <TreeSection title="Open" count={filteredIssues.length}>
        {isLoading ? <div className="px-8 py-3 text-sm text-muted-foreground">Loading issues…</div> : filteredIssues.length ? filteredIssues.map((issue) => <IssueRow key={issue.id} issue={issue} onCycleStatus={(id, status) => updateStatus.mutate({ id, status })} onDiscuss={() => discuss(`Issue: ${issue.title}`, `Discuss and resolve @issue:${issue.id}.\n\n${issue.description}${issue.reproSteps ? `\n\nReproduction steps:\n${issue.reproSteps}` : ""}`, `issue-${issue.id}`)} />) : <div className="px-8 py-3 text-sm text-muted-foreground">No open issues.</div>}
      </TreeSection>
    </div>
  );
}

export default IssuesTab;
