import { useState, useMemo, useEffect, useCallback, useRef, type TouchEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Mail,
  MailOpen,
  RefreshCw,
  AlertTriangle,
  Plus,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  ShieldCheck,
  Sparkles,
  CheckCircle2,
  Eye,
  PenLine,
  FileText,
  Loader2,
  History,
  Calendar,
  MoreHorizontal,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { usePageHeader } from "@/hooks/use-page-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import DraftsView from "./people-drafts";
import { useFocusSession } from "@/hooks/use-focus-session";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { ReminderPopover } from "@/components/library-reminder";
import { useEmailMarkDone, useEmailSnooze } from "@/hooks/use-email-thread-actions";
import type { EmailMessage, EmailEnrichment, EmailDismissal } from "@shared/schema";

type EmailHealthStatus = "healthy" | "stale" | "degraded" | "failed";

const PULL_THRESHOLD = 64;
const MAX_PULL_DISTANCE = 96;

function nearestScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return document.scrollingElement as HTMLElement | null;
}

function invalidateEmailQueries() {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const first = query.queryKey[0];
      return typeof first === "string" && (first.startsWith("/api/email") || first.startsWith("/api/email-drafts"));
    },
  });
}

interface SyncAccount {
  accountId: string;
  email?: string;
  label?: string;
  lastSyncAt: string | null;
  lastGoodAt?: string | null;
  lastAttemptAt?: string | null;
  messagesCached: number;
  healthy: boolean;
  stale?: boolean;
  status?: EmailHealthStatus;
  currentError?: string | null;
  error: string | null;
  orphaned?: boolean;
}

interface SyncStatusResponse {
  status?: EmailHealthStatus;
  currentError?: string | null;
  accounts: SyncAccount[];
  orphanedAccounts?: SyncAccount[];
}


function CommsErrorState({ title, message }: { title: string; message: string }) {
  return (
    <div className="h-full flex items-center justify-center p-6" data-testid="comms-error-state">
      <div className="max-w-sm rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-center">
        <AlertTriangle className="h-5 w-5 mx-auto mb-2 text-destructive" />
        <div className="text-sm font-medium text-destructive">{title}</div>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

function formatAge(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

const TRIAGE_COLORS: Record<string, string> = {
  "🔴": "bg-warning/15 text-warning-foreground border-warning/30",
  "🟡": "bg-success/15 text-success-foreground border-success/30",
  "🟢": "bg-success/15 text-success-foreground border-success/30",
  "📋": "bg-info/15 text-info-foreground dark:text-info border-info/30",
  "🗑️": "bg-muted text-muted-foreground border-muted",
};

const TRIAGE_LABELS: Record<string, string> = {
  "🔴": "Urgent",
  "🟡": "Important",
  "🟢": "Visibility",
  "📋": "FYI",
  "🗑️": "Noise",
};

const TRIAGE_PRIORITY: Record<string, number> = {
  "🔴": 0,
  "🟡": 1,
  "🟢": 2,
  "📋": 3,
  "🗑️": 4,
};

function TriageIcon({ tier, className }: { tier: string; className?: string }) {
  const cn = className || "h-3 w-3";
  switch (tier) {
    case "🔴": return <Clock className={cn} />;
    case "🟡": return <AlertTriangle className={cn} />;
    case "🟢": return <Eye className={cn} />;
    case "📋": return <span className={cn}>📋</span>;
    case "🗑️": return <span className={cn}>🗑️</span>;
    default: return <span className={cn}>{tier}</span>;
  }
}

function TriageBadge({ tier, prominent }: { tier: string; prominent?: boolean }) {
  const colorClass = TRIAGE_COLORS[tier] || "bg-muted text-muted-foreground";
  const label = TRIAGE_LABELS[tier] || tier;
  return (
    <Badge
      variant="outline"
      className={`${prominent ? "text-xs px-2 py-0.5" : "text-xs px-1.5 py-0"} ${colorClass} gap-1 inline-flex items-center`}
      data-testid={`badge-triage-${tier}`}
    >
      <TriageIcon tier={tier} className={prominent ? "h-3.5 w-3.5" : "h-3 w-3"} />
      {label}
    </Badge>
  );
}

function parseSender(fromAddress: string | null | undefined): string {
  if (!fromAddress) return "Unknown";
  if (fromAddress.includes("<")) {
    return fromAddress.split("<")[0].trim().replace(/"/g, "") || fromAddress;
  }
  return fromAddress;
}

/** Extract bare email from a fromAddress like "Name <email@example.com>" */
function extractEmail(fromAddress: string | null | undefined): string | null {
  if (!fromAddress) return null;
  const match = fromAddress.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : fromAddress.includes("@") ? fromAddress.toLowerCase().trim() : null;
}

/** Hook to get email→person mapping for inline person references */
function useEmailPersonMap() {
  const { data } = useQuery<{ emailMap: Record<string, { id: string; name: string }> }>({
    queryKey: ["/api/people/email-map"],
    staleTime: 5 * 60 * 1000,
  });
  return data?.emailMap || {};
}

/** Renders a sender as a person reference chip when matched, plain text otherwise */
function SenderName({ fromAddress, className }: { fromAddress: string | null | undefined; className?: string }) {
  const emailMap = useEmailPersonMap();
  const email = extractEmail(fromAddress);
  const person = email ? emailMap[email] : null;
  if (person) {
    return <ReferenceRenderer refValue={{ type: "person", id: person.id, canonical: `@person:${person.id}` }} surface="chat-inline" className={className} />;
  }
  return <span className={className}>{parseSender(fromAddress)}</span>;
}

interface ThreadGroup {
  threadId: string;
  messages: EmailMessage[];
  latestMessage: EmailMessage;
  unreadCount: number;
  triageTier: string | null;
  triageReason: string | null;
}

function groupByThread(messages: EmailMessage[]): ThreadGroup[] {
  const map = new Map<string, EmailMessage[]>();
  for (const msg of messages) {
    const tid = msg.providerThreadId || msg.providerMessageId;
    if (!map.has(tid)) map.set(tid, []);
    map.get(tid)!.push(msg);
  }
  const groups: ThreadGroup[] = [];
  for (const [threadId, msgs] of map) {
    msgs.sort((a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime());
    const latest = msgs[msgs.length - 1];
    const unreadCount = msgs.filter(m => !m.isRead).length;
    const triaged = msgs.find(m => m.triageTier);
    groups.push({
      threadId,
      messages: msgs,
      latestMessage: latest,
      unreadCount,
      triageTier: triaged?.triageTier || null,
      triageReason: triaged?.triageReason || null,
    });
  }
  groups.sort((a, b) => new Date(b.latestMessage.date || 0).getTime() - new Date(a.latestMessage.date || 0).getTime());
  return groups;
}

function formatSnoozeTime(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function MessageBodyView({ message }: { message: EmailMessage }) {
  const [expanded, setExpanded] = useState(false);
  const body = message.bodyText || message.bodyHtml || "";
  const preview = body.slice(0, 200);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger asChild>
        <button
          className="w-full text-left flex items-start gap-2 p-2 rounded hover:bg-muted/50 transition-colors"
          data-testid={`button-expand-message-${message.id}`}
        >
          <div className="shrink-0">
            {message.isRead ? (
              <MailOpen className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <Mail className="h-3.5 w-3.5 text-primary" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={`text-xs truncate ${!message.isRead ? "font-semibold" : "text-muted-foreground"}`}>
                <SenderName fromAddress={message.fromAddress} />
              </span>
              <span className="text-xs text-muted-foreground shrink-0">
                {formatAge(message.date?.toString())}
              </span>
            </div>
            {!expanded && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">{message.snippet || preview}</p>
            )}
          </div>
          <div className="shrink-0 mt-0.5">
            {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className="ml-7 mr-2 mb-2 p-3 bg-muted/30 rounded text-xs whitespace-pre-wrap max-h-96 overflow-y-auto"
          data-testid={`text-message-body-${message.id}`}
        >
          {body || "(no content)"}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface DraftInfo {
  id: string;
  subject: string;
  status: string;
  threadId?: string | null;
  createdAt: string;
}

function EnrichmentDisplay({ enrichment }: { enrichment: EmailEnrichment }) {
  return (
    <div className="space-y-1.5" data-testid="enrichment-display">
      {enrichment.summary && (
        <p className="text-xs text-foreground leading-relaxed" data-testid="text-enrichment-summary">
          {enrichment.summary}
        </p>
      )}
      {enrichment.decisions && enrichment.decisions.length > 0 && (
        <div className="space-y-0.5" data-testid="enrichment-decisions">
          {enrichment.decisions.map((d, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs text-warning-foreground bg-warning/10 rounded px-2 py-1 min-w-0">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{d}</span>
            </div>
          ))}
        </div>
      )}
      {enrichment.actions && enrichment.actions.length > 0 && (
        <div className="space-y-0.5" data-testid="enrichment-actions">
          {enrichment.actions.map((a, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 min-w-0">
              <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{a}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EnrichButton({ threadId, onEnriched }: { threadId: string; onEnriched?: () => void }) {
  const { toast } = useToast();
  const enrichMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/email/enrich-thread`, { threadId });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to enrich thread");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email/enrichments"] });
      onEnriched?.();
    },
    onError: (err: Error) => {
      toast({ title: "Enrichment failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs text-muted-foreground hover:text-primary"
      onClick={(e) => { e.stopPropagation(); enrichMutation.mutate(); }}
      disabled={enrichMutation.isPending}
      data-testid={`button-enrich-${threadId}`}
    >
      {enrichMutation.isPending ? (
        <>
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          Enriching...
        </>
      ) : (
        <>
          <Sparkles className="h-3 w-3 mr-1" />
          Enrich
        </>
      )}
    </Button>
  );
}


interface EmailReferenceProps {
  thread: ThreadGroup;
  accountLabel?: string;
  enrichment?: EmailEnrichment;
  linkedDrafts?: DraftInfo[];
  showEnrichment?: boolean;
  showDoneButton?: boolean;
  showInboxIndicators?: boolean;
  onDraftClick?: () => void;
  onViewDraft?: () => void;
  onSnooze?: (ids: number[], snoozedUntil: string) => void;
  onHover?: (ids: number[] | null) => void;
}

function EmailReference({
  thread,
  accountLabel,
  enrichment,
  linkedDrafts,
  showEnrichment,
  showDoneButton,
  showInboxIndicators,
  onDraftClick,
  onViewDraft,
  onSnooze,
  onHover,
}: EmailReferenceProps) {
  const [expanded, setExpanded] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const { latestMessage, messages, unreadCount, triageTier, triageReason } = thread;
  const sender = parseSender(latestMessage.fromAddress);
  const hasUnread = unreadCount > 0;
  const markDone = useEmailMarkDone();
  const isTriaged = messages.some(m => m.triageStatus === "triaged");
  const isDone = messages.some(m => m.isDone);
  const title = latestMessage.subject || "(no subject)";

  const stopTrigger = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <div
      className="group min-w-0 overflow-hidden"
      data-testid={`email-reference-${thread.threadId}`}
      onMouseEnter={() => onHover?.(messages.map(m => m.id))}
      onMouseLeave={() => onHover?.(null)}
    >
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div
          className={`group/row relative flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 pr-16 transition-colors hover:bg-accent/70 hover:text-foreground ${expanded ? "bg-accent text-foreground" : ""}`}
          data-testid={`row-email-reference-${thread.threadId}`}
        >
          <CollapsibleTrigger asChild>
            <button
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              data-testid={`button-email-reference-${thread.threadId}`}
            >
              <span className="shrink-0">
                {hasUnread ? <Mail className="h-3.5 w-3.5 text-foreground" /> : <MailOpen className="h-3.5 w-3.5 text-muted-foreground" />}
              </span>
              <span className={`min-w-0 flex-1 truncate text-sm ${hasUnread ? "font-medium text-foreground" : "text-muted-foreground"}`} data-testid={`text-email-ref-title-${thread.threadId}`}>
                {title}
              </span>
              {messages.length > 1 && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{messages.length}</span>}
            </button>
          </CollapsibleTrigger>
          <CollapsibleTrigger asChild>
            <button className="absolute right-8 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground" data-testid={`button-expand-${thread.threadId}`}>
              <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
            </button>
          </CollapsibleTrigger>
          {showDoneButton && (
            <DropdownMenu modal={false} open={actionsOpen} onOpenChange={setActionsOpen}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 p-0 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100" onClick={stopTrigger} data-testid={`button-email-ref-actions-${thread.threadId}`}>
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onDraftClick && (
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDraftClick(); }} data-testid={`menu-draft-${thread.threadId}`}>
                    <PenLine className="h-4 w-4 mr-2" /> Draft
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); markDone.mutate({ ids: messages.map(m => m.id), isDone: true, threadMeta: { providerThreadId: thread.threadId, accountId: latestMessage.accountId, tier: triageTier || undefined, sender: latestMessage.fromAddress || undefined, subject: latestMessage.subject || undefined } }); }} disabled={markDone.isPending} data-testid={`menu-done-${thread.threadId}`}>
                  <CheckCircle2 className="h-4 w-4 mr-2" /> Mark done
                </DropdownMenuItem>
                {onSnooze && (
                  <>
                    <DropdownMenuSeparator />
                    <ReminderPopover
                      title={title}
                      onSelect={(fireAt) => onSnooze(messages.map(m => m.id), fireAt)}
                      allowNextBuild={false}
                    />
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <CollapsibleContent>
          <div className="ml-6 space-y-2 border-l border-border/40 px-2 pb-3 pt-1" data-testid={`email-reference-expanded-${thread.threadId}`}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-muted-foreground">
              <span className="min-w-0 max-w-full truncate"><SenderName fromAddress={latestMessage.fromAddress} /></span>
              <span>·</span>
              <span>{formatAge(latestMessage.date?.toString())}</span>
              {triageTier && (
                <Tooltip>
                  <TooltipTrigger asChild><span className="shrink-0"><TriageBadge tier={triageTier} /></span></TooltipTrigger>
                  {triageReason && <TooltipContent>{triageReason}</TooltipContent>}
                </Tooltip>
              )}
              {accountLabel && <span className="uppercase tracking-wide">{accountLabel}</span>}
              {showInboxIndicators && isTriaged && <span className="uppercase tracking-wide">Triaged</span>}
              {showInboxIndicators && isDone && <span className="uppercase tracking-wide text-success">Done</span>}
            </div>
            {linkedDrafts && linkedDrafts.length > 0 && (
              <div className="space-y-1" data-testid={`drafts-linked-${thread.threadId}`}>
                {linkedDrafts.map((draft) => (
                  <button key={draft.id} className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent/50" onClick={() => onViewDraft?.()} data-testid={`row-linked-draft-${draft.id}`}>
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">Draft: {draft.subject || "(no subject)"}</span>
                    <span className="shrink-0 uppercase tracking-wide">{draft.status === "pending_review" ? "Review" : draft.status}</span>
                  </button>
                ))}
              </div>
            )}
            {showEnrichment && enrichment && <EnrichmentDisplay enrichment={enrichment} />}
            {showEnrichment && !enrichment && <EnrichButton threadId={thread.threadId} />}
            <div className="rounded-md bg-muted/30 p-2 text-xs text-muted-foreground">
              <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate"><SenderName fromAddress={latestMessage.fromAddress} /></span>
                <span className="shrink-0">{latestMessage.date ? new Date(latestMessage.date).toLocaleString() : ""}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-foreground/90">{latestMessage.bodyText || latestMessage.snippet || "(no content)"}</p>
            </div>
            {messages.length > 1 && (
              <div className="space-y-1">
                {messages.slice(0, -1).map((msg) => <MessageBodyView key={msg.id} message={msg} />)}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function CommsSection({
  id,
  title,
  defaultOpen,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`section-${id}`}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground" data-testid={`button-section-${id}`}>
          <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          <span>{title}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pl-3 min-w-0 overflow-hidden" data-testid={`content-section-${id}`}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ThreadRow(props: {
  thread: ThreadGroup;
  accountLabel?: string;
  onHover?: (ids: number[] | null) => void;
  showDoneButton?: boolean;
  showInboxIndicators?: boolean;
  linkedDrafts?: DraftInfo[];
  onDraftClick?: () => void;
  onViewDraft?: () => void;
  enrichment?: EmailEnrichment;
  showEnrichment?: boolean;
  onSnooze?: (ids: number[], snoozedUntil: string) => void;
}) {
  return <EmailReference {...props} />;
}

function ListSkeleton() {
  return (
    <div className="space-y-0" data-testid="comms-skeleton">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-start gap-2 px-2 py-1.5 rounded-md">
          <Skeleton className="h-4 w-4 mt-0.5" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-3 w-6" />
        </div>
      ))}
    </div>
  );
}

function NoAccountsCta() {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center" data-testid="comms-no-accounts">
      <Mail className="h-12 w-12 text-muted-foreground/30 mb-4" />
      <h3 className="text-lg font-medium mb-2">No Gmail accounts connected</h3>
      <p className="text-sm text-muted-foreground mb-4 max-w-sm">
        Connect a Gmail account to see your inbox here. Agent can triage and draft replies for you.
      </p>
      <Button
        variant="default"
        onClick={() => window.open("/api/gmail/oauth/start", "_blank")}
        data-testid="button-connect-gmail"
      >
        <Plus className="h-4 w-4 mr-2" />
        Connect Gmail Account
      </Button>
    </div>
  );
}

function InboxTab({ onHover }: { onHover: (ids: number[] | null) => void }) {
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [isSyncing, setIsSyncing] = useState(false);

  const syncStatusQuery = useQuery<SyncStatusResponse>({
    queryKey: ["/api/email/sync-status"],
    refetchInterval: 30000,
  });

  const accounts = (syncStatusQuery.data?.accounts || []).filter(account => !account.orphaned);
  const orphanedAccounts = syncStatusQuery.data?.orphanedAccounts || [];
  const hasAccounts = accounts.length > 0;

  const queryParams = new URLSearchParams({
    limit: "100",
    triageStatus: "untriaged",
    isDone: "false",
  });
  if (accountFilter !== "all") queryParams.set("accountId", accountFilter);

  const messagesQuery = useQuery<{ messages: EmailMessage[]; total: number }>({
    queryKey: ["/api/email/messages", "inbox", accountFilter],
    queryFn: async () => {
      const res = await fetch(`/api/email/messages?${queryParams.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch messages");
      return res.json();
    },
    enabled: hasAccounts,
    refetchInterval: 60000,
  });

  const messages = messagesQuery.data?.messages || [];
  const threads = useMemo(() => groupByThread(messages), [messages]);

  const accountLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) map.set(a.accountId, a.label || a.email);
    return map;
  }, [accounts]);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await apiRequest("POST", "/api/email/sync");
      messagesQuery.refetch();
      syncStatusQuery.refetch();
    } finally {
      setIsSyncing(false);
    }
  };

  if (syncStatusQuery.isError) {
    return <CommsErrorState title="Inbox status failed" message="Comms could not load Gmail sync status. The inbox may be unavailable until this route recovers." />;
  }

  if (!hasAccounts && !syncStatusQuery.isLoading) {
    if (orphanedAccounts.length > 0) {
      return <CommsErrorState title="Orphaned email cache" message="Disconnected Gmail account data is still present. Cleanup must remove the stale account-scoped cache before Inbox can be trusted." />;
    }
    return <NoAccountsCta />;
  }

  if (messagesQuery.isError) {
    return <CommsErrorState title="Inbox failed to load" message="The Inbox tab could not fetch untriaged cached email. This is a Comms route failure, not an empty inbox." />;
  }

  return (
    <div className="h-full flex flex-col min-w-0" data-testid="inbox-tab">
      <div className="p-3 border-b space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          {accounts.length > 1 && (
            <Select value={accountFilter} onValueChange={setAccountFilter}>
              <SelectTrigger className="w-36 h-8 text-xs" data-testid="select-account-filter">
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.accountId} value={a.accountId}>
                    {a.label || a.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {accounts.map((a) => (
            <div
              key={a.accountId}
              className={`flex items-center gap-1.5 text-xs min-w-0 max-w-full ${a.healthy ? "text-success-foreground" : "text-warning-foreground"}`}
              data-testid={`status-account-${a.accountId}`}
            >
              {a.healthy ? <CheckCircle className="h-3 w-3 shrink-0" /> : <AlertTriangle className="h-3 w-3 shrink-0" />}
              <span className="truncate min-w-0">{a.label || a.email}</span>
            </div>
          ))}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 ml-auto"
                onClick={handleSync}
                disabled={isSyncing || messagesQuery.isFetching}
                data-testid="button-refresh-inbox"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isSyncing || messagesQuery.isFetching ? "animate-spin" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Sync & refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {messagesQuery.isLoading || syncStatusQuery.isLoading ? (
          <ListSkeleton />
        ) : threads.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="inbox-empty">
            No inbox messages yet.
          </div>
        ) : (
          <div data-testid="inbox-thread-list">
            {threads.map((thread) => (
              <ThreadRow
                key={thread.threadId}
                thread={thread}
                accountLabel={accounts.length > 1 ? accountLabelMap.get(thread.latestMessage.accountId) : undefined}
                onHover={onHover}
                showInboxIndicators
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TriageMessageRow({ message, onHover }: { message: EmailMessage; onHover: (ids: number[] | null) => void }) {
  return (
    <div
      className="flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-accent/70 transition-colors"
      data-testid={`row-triage-${message.id}`}
      onMouseEnter={() => onHover([message.id])}
      onMouseLeave={() => onHover(null)}
    >
      <div className="mt-0.5">
        <Clock className="h-4 w-4 text-warning" />
      </div>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate min-w-0" data-testid={`text-sender-triage-${message.id}`}>
            <SenderName fromAddress={message.fromAddress} />
          </span>
          {message.accountId && (
            <span className="bg-cat-channel/15 text-cat-channel-foreground border border-cat-channel/30 rounded-sm text-xs font-medium px-2 py-0.5 shrink-0 max-w-[120px] truncate">
              {message.accountId}
            </span>
          )}
        </div>
        <p className="text-sm text-foreground truncate" data-testid={`text-subject-triage-${message.id}`}>
          {message.subject || "(no subject)"}
        </p>
        <p className="text-xs text-muted-foreground truncate" data-testid={`text-snippet-triage-${message.id}`}>
          {message.snippet}
        </p>
      </div>
      <div className="shrink-0 text-xs text-muted-foreground mt-0.5" data-testid={`text-age-triage-${message.id}`}>
        {formatAge(message.date?.toString())}
      </div>
    </div>
  );
}

function TriageTab({ onHover }: { onHover: (ids: number[] | null) => void }) {
  const { toast } = useToast();
  const PAGE_SIZE = 200;
  const [page, setPage] = useState(0);
  const offset = page * PAGE_SIZE;

  const messagesQuery = useQuery<{ messages: EmailMessage[]; total: number }>({
    queryKey: ["/api/email/messages", "triaged-not-enriched", page],
    queryFn: async () => {
      const res = await fetch(`/api/email/messages?triageStatus=triaged&isDone=false&enriched=false&limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error("Failed to fetch triage queue");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const triageStatusQuery = useQuery<TriageStatus>({
    queryKey: ["/api/email/triage-status"],
    queryFn: async () => {
      const res = await fetch("/api/email/triage-status");
      if (!res.ok) throw new Error("Failed to fetch triage status");
      return res.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === "running" ? 1500 : 10000;
    },
  });

  const triageStatus = triageStatusQuery.data;
  const isTriageRunning = triageStatus?.status === "running";
  const prevStatusRef = useRef<string | undefined>();
  const prevProcessedRef = useRef<number>(0);

  useEffect(() => {
    if (!isTriageRunning) return;
    const currentProcessed = triageStatus?.processed ?? 0;
    if (currentProcessed > prevProcessedRef.current) {
      prevProcessedRef.current = currentProcessed;
      queryClient.invalidateQueries({ queryKey: ["/api/email/messages"] });
    }
  }, [isTriageRunning, triageStatus?.processed]);

  useEffect(() => {
    const prev = prevStatusRef.current;
    const current = triageStatus?.status;
    prevStatusRef.current = current;

    if (prev === "running" && current === "completed") {
      prevProcessedRef.current = 0;
      toast({
        title: "Pipeline pass complete",
        description: `Classified ${triageStatus?.triaged} of ${triageStatus?.total} emails.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/email/messages"] });
    } else if (prev === "running" && current === "error") {
      prevProcessedRef.current = 0;
      toast({
        title: "Pipeline pass failed",
        description: triageStatus?.error || "Unknown error",
        variant: "destructive",
      });
    }
  }, [triageStatus?.status]);

  const triageMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/email/triage-run");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email/triage-status"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Pipeline pass failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const messages = messagesQuery.data?.messages || [];
  const total = messagesQuery.data?.total || 0;
  const filtered = useMemo(() => messages.filter(m => !m.isDone), [messages]);

  const grouped = useMemo(() => {
    const red: EmailMessage[] = [];
    const yellow: EmailMessage[] = [];
    const green: EmailMessage[] = [];
    const other: EmailMessage[] = [];

    for (const msg of filtered) {
      const tier = msg.triageTier;
      if (tier === "🔴") red.push(msg);
      else if (tier === "🟡") yellow.push(msg);
      else if (tier === "🟢") green.push(msg);
      else other.push(msg);
    }

    const byDate = (a: EmailMessage, b: EmailMessage) =>
      new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();

    red.sort(byDate);
    yellow.sort(byDate);
    green.sort(byDate);
    other.sort(byDate);

    return [...red, ...yellow, ...green, ...other];
  }, [filtered]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (page >= totalPages && totalPages > 0) {
      setPage(totalPages - 1);
    }
  }, [totalPages, page]);

  const displayStart = offset + 1;
  const displayEnd = Math.min(offset + filtered.length, total);

  const progressPercent = useMemo(() => {
    if (!triageStatus || triageStatus.status !== "running" || triageStatus.total === 0) return 0;
    return Math.round((triageStatus.processed / triageStatus.total) * 100);
  }, [triageStatus]);

  if (messagesQuery.isLoading) return <ListSkeleton />;
  if (messagesQuery.isError || triageStatusQuery.isError) {
    return <CommsErrorState title="Pipeline queue failed to load" message="The Triage tab could not load its enrichment queue or pipeline status. This is a Comms route failure, not an empty queue." />;
  }

  return (
    <div className="h-full flex flex-col min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 @sm:px-4 py-2 border-b shrink-0">
        <span className="text-xs @sm:text-sm text-muted-foreground min-w-0 break-words" data-testid="text-untriaged-count">
          {total > filtered.length
            ? `Displaying ${displayStart}–${displayEnd} of ${total.toLocaleString()} emails awaiting enrichment`
            : `${filtered.length} email${filtered.length !== 1 ? "s" : ""} awaiting enrichment`}
        </span>
        <Button
          size="sm"
          variant="default"
          className="shrink-0"
          onClick={() => triageMutation.mutate()}
          disabled={isTriageRunning || triageMutation.isPending}
          data-testid="button-run-triage"
        >
          {isTriageRunning ? (
            <>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Run Pipeline
            </>
          )}
        </Button>
      </div>

      {isTriageRunning && (
        <div className="px-4 py-3 border-b space-y-1.5 shrink-0" data-testid="triage-progress">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Processing email pipeline…</span>
            <span data-testid="text-triage-progress">
              {triageStatus.processed} / {triageStatus.total} processed ({progressPercent}%)
            </span>
          </div>
          <Progress value={progressPercent} className="h-2" data-testid="progress-triage" />
          <div className="flex items-center justify-between text-xs text-muted-foreground/80" data-testid="text-triage-perf">
            <span>
              {triageStatus.workersInFlight ?? 0} workers in flight
              {triageStatus.passes ? ` · pass ${triageStatus.passes}` : ""}
            </span>
            <span>
              {triageStatus.avgPerEmailMs ? `${triageStatus.avgPerEmailMs}ms / email` : "warming up…"}
              {triageStatus.remaining ? ` · ${triageStatus.remaining} left in pass` : ""}
            </span>
          </div>
        </div>
      )}

      {grouped.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 px-4 text-center flex-1" data-testid="triage-empty">
          <ShieldCheck className="h-12 w-12 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium mb-2">All caught up</h3>
          <p className="text-sm text-muted-foreground">Nothing waiting on enrichment.</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div data-testid="triage-message-list">
            {grouped.map((msg) => (
              <TriageMessageRow key={msg.id} message={msg} onHover={onHover} />
            ))}
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 px-2 @sm:px-4 py-2 border-t shrink-0" data-testid="triage-pagination">
          <Button
            size="sm"
            variant="outline"
            className="px-2 @sm:px-3 shrink-0"
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            data-testid="button-prev-page"
          >
            <ChevronLeft className="h-3.5 w-3.5 @sm:mr-1" />
            <span className="hidden @sm:inline">Previous</span>
          </Button>
          <span className="text-xs text-muted-foreground truncate min-w-0 text-center" data-testid="text-page-info">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="px-2 @sm:px-3 shrink-0"
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            data-testid="button-next-page"
          >
            <span className="hidden @sm:inline">Next</span>
            <ChevronRight className="h-3.5 w-3.5 @sm:ml-1" />
          </Button>
        </div>
      )}
    </div>
  );
}

interface TimerRunSummary {
  id: string;
  status: string;
  startedAt: string;
}
interface TimerWithRuns {
  id: string;
  type: string;
  skillId?: string;
  name: string;
  nextRunAt?: string;
  recentRuns?: TimerRunSummary[];
  lastRun?: TimerRunSummary;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

interface TriageStatus {
  status: string;
  lastTriageError: { message: string; timestamp: number } | null;
  processed: number;
  total: number;
  triaged: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  workersInFlight?: number;
  avgPerEmailMs?: number;
  remaining?: number;
  passes?: number;
}

interface EmailPipelineStatus {
  status?: EmailHealthStatus;
  stage?: string;
  currentError?: string | null;
  triage: TriageStatus;
  counts: {
    untriaged: number;
    awaitingEnrichment: number;
    reviewReady: number;
  };
  lastSyncAt: string | null;
  lastTriageAt: string | null;
  lastEnrichmentAt: string | null;
}

function TriageErrorBanner() {
  const [dismissed, setDismissed] = useState(false);
  const { data: triageStatus } = useQuery<TriageStatus>({
    queryKey: ["/api/email/triage-status"],
    refetchInterval: 60_000,
  });

  const err = triageStatus?.lastTriageError;
  if (!err || dismissed) return null;

  // Only show if error is within the last hour
  const ageMs = Date.now() - err.timestamp;
  if (ageMs > 60 * 60 * 1000) return null;

  const ageLabel = (() => {
    const mins = Math.floor(ageMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  })();

  return (
    <div
      className="flex items-start gap-3 px-4 py-3 bg-destructive/10 border-b border-destructive/20"
      data-testid="triage-error-banner"
    >
      <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-destructive">Email pipeline classification error</p>
        <p className="text-xs text-muted-foreground break-words">
          {err.message} — {ageLabel}
        </p>
        <p className="text-xs text-muted-foreground">
          Affected emails were defaulted to 🟢 Acknowledge instead of being auto-dismissed.
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs text-muted-foreground shrink-0"
        onClick={() => setDismissed(true)}
        data-testid="button-dismiss-triage-error"
      >
        Dismiss
      </Button>
    </div>
  );
}


function CommsHealthBanner() {
  const { data, isError } = useQuery<SyncStatusResponse>({
    queryKey: ["/api/email/sync-status"],
    refetchInterval: 60_000,
  });

  if (isError) {
    return (
      <div className="flex items-start gap-3 px-4 py-3 bg-destructive/10 border-b border-destructive/20" data-testid="comms-health-banner">
        <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-destructive">Comms status unavailable</p>
          <p className="text-xs text-muted-foreground">Could not load Gmail sync status. Tab counts may be stale until this route recovers.</p>
        </div>
      </div>
    );
  }

  const accounts = data?.accounts ?? [];
  const orphanedAccounts = accounts.filter(account => account.orphaned);
  if (orphanedAccounts.length > 0) {
    return (
      <div className="flex items-start gap-3 px-4 py-3 bg-destructive/10 border-b border-destructive/20" data-testid="comms-health-banner">
        <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-destructive">Disconnected Gmail cache remains</p>
          <p className="text-xs text-muted-foreground break-words">
            Orphaned email cache account{orphanedAccounts.length === 1 ? "" : "s"}: {orphanedAccounts.map(account => account.accountId).join(", ")}. Cleanup must remove this account-scoped Comms state.
          </p>
        </div>
      </div>
    );
  }

  const nonHealthyAccounts = accounts.filter(account => !account.healthy);
  if (nonHealthyAccounts.length === 0) return null;

  const status: EmailHealthStatus = data?.status
    || (nonHealthyAccounts.some(account => account.status === "failed" || account.currentError || account.error) ? "failed"
      : nonHealthyAccounts.some(account => account.status === "degraded") ? "degraded"
        : "stale");
  const isFailure = status === "failed";
  const title = status === "stale"
    ? "Gmail sync stale"
    : status === "degraded"
      ? "Gmail sync degraded"
      : "Gmail sync failed";
  const description = nonHealthyAccounts.map(account => {
    const lastGood = account.lastGoodAt || account.lastSyncAt;
    const detail = account.currentError || account.error;
    if (detail) return `${account.accountId}: ${detail}`;
    if (account.status === "stale" || account.stale || status === "stale") {
      return `${account.accountId}: last successful sync ${lastGood ? formatRelativeTime(lastGood) : "never"}`;
    }
    return account.accountId;
  }).join("; ");

  return (
    <div className={`flex items-start gap-3 px-4 py-3 border-b ${isFailure ? "bg-destructive/10 border-destructive/20" : "bg-warning/10 border-warning/20"}`} data-testid="comms-health-banner">
      <AlertTriangle className={`h-4 w-4 shrink-0 mt-0.5 ${isFailure ? "text-destructive" : "text-warning"}`} />
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className={`text-sm font-medium ${isFailure ? "text-destructive" : "text-warning"}`}>{title}</p>
        <p className="text-xs text-muted-foreground break-words">{description}</p>
      </div>
    </div>
  );
}

function EmailPipelineStatusBadge() {
  const { data } = useQuery<EmailPipelineStatus>({
    queryKey: ["/api/email/pipeline-status"],
    queryFn: async () => {
      const res = await fetch("/api/email/pipeline-status");
      if (!res.ok) throw new Error("Failed to load email pipeline status");
      return res.json();
    },
    refetchInterval: 60000,
  });

  if (!data) return null;

  const lastEvents = [
    data.lastTriageAt ? { label: "triage", at: data.lastTriageAt } : null,
    data.lastEnrichmentAt ? { label: "enrichment", at: data.lastEnrichmentAt } : null,
    data.lastSyncAt ? { label: "sync", at: data.lastSyncAt } : null,
  ].filter(Boolean) as Array<{ label: string; at: string }>;
  const latest = lastEvents.reduce<{ label: string; at: string } | null>((best, item) => {
    if (!best) return item;
    return new Date(item.at).getTime() > new Date(best.at).getTime() ? item : best;
  }, null);

  const triageRunning = data.triage.status === "running";
  const pipelineStatus = data.status || "healthy";
  const stale = pipelineStatus === "stale";
  const failed = pipelineStatus === "failed";
  const lastLabel = triageRunning ? "running" : latest ? formatRelativeTime(latest.at) : "never";

  const tooltip = [
    `Email pipeline: ${triageRunning ? "running" : pipelineStatus}`,
    `Last sync: ${data.lastSyncAt ? new Date(data.lastSyncAt).toLocaleString() : "never"}`,
    `Last triage pass: ${data.lastTriageAt ? new Date(data.lastTriageAt).toLocaleString() : "never"}`,
    `Last enrichment: ${data.lastEnrichmentAt ? new Date(data.lastEnrichmentAt).toLocaleString() : "never"}`,
    `Untriaged: ${data.counts.untriaged}`,
    `Awaiting enrichment: ${data.counts.awaitingEnrichment}`,
    `Review-ready: ${data.counts.reviewReady}`,
  ].join("\n");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md ${failed ? "text-destructive" : stale ? "text-warning" : "text-muted-foreground"}`}
          data-testid="badge-email-pipeline-status"
        >
          {triageRunning ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Clock className="h-3 w-3" />}
          <span>Email pipeline {lastLabel}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs whitespace-pre-line">{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function ReviewTab({ onHover, onSwitchTab }: { onHover: (ids: number[] | null) => void; onSwitchTab: (tab: string) => void }) {
  const { toast } = useToast();
  const snoozeMutation = useEmailSnooze();

  const handleSnooze = useCallback((ids: number[], snoozedUntil: string) => {
    const formatted = formatSnoozeTime(new Date(snoozedUntil));
    snoozeMutation.mutate({ ids, snoozedUntil }, {
      onSuccess: () => {
        toast({
          title: `Snoozed until ${formatted}`,
          action: (
            <Button
              variant="outline"
              size="sm"
              onClick={() => snoozeMutation.mutate({ ids, snoozedUntil: null })}
            >
              Undo
            </Button>
          ),
        });
      },
      onError: (err: Error) => {
        toast({ title: "Snooze failed", description: err.message, variant: "destructive" });
      },
    });
  }, [snoozeMutation, toast]);
  const messagesQuery = useQuery<{ messages: EmailMessage[]; total: number }>({
    queryKey: ["/api/email/messages", "review"],
    queryFn: async () => {
      const res = await fetch("/api/email/messages?triageStatus=triaged&enriched=true&excludeDismissed=true&limit=200");
      if (!res.ok) throw new Error("Failed to fetch review messages");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const syncStatusQuery = useQuery<SyncStatusResponse>({
    queryKey: ["/api/email/sync-status"],
  });

  const accounts = (syncStatusQuery.data?.accounts || []).filter(account => !account.orphaned);
  const messages = messagesQuery.data?.messages || [];
  const threads = useMemo(() => {
    const grouped = groupByThread(messages);
    grouped.sort((a, b) => {
      const aPriority = TRIAGE_PRIORITY[a.triageTier || ""] ?? 99;
      const bPriority = TRIAGE_PRIORITY[b.triageTier || ""] ?? 99;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return new Date(b.latestMessage.date || 0).getTime() - new Date(a.latestMessage.date || 0).getTime();
    });
    return grouped;
  }, [messages]);

  const threadIds = useMemo(() => threads.map(t => t.threadId), [threads]);

  const enrichmentsQuery = useQuery<{ enrichments: EmailEnrichment[] }>({
    queryKey: ["/api/email/enrichments", threadIds],
    queryFn: async () => {
      if (threadIds.length === 0) return { enrichments: [] };
      const res = await fetch(`/api/email/enrichments?threadIds=${threadIds.join(",")}`);
      if (!res.ok) throw new Error("Failed to fetch enrichments");
      return res.json();
    },
    enabled: threadIds.length > 0,
    refetchInterval: 30000,
  });

  const enrichmentMap = useMemo(() => {
    const map = new Map<string, EmailEnrichment>();
    const enrichments = enrichmentsQuery.data?.enrichments || [];
    for (const e of enrichments) {
      map.set(e.providerThreadId, e);
    }
    return map;
  }, [enrichmentsQuery.data]);

  const draftsQuery = useQuery<{ drafts: DraftInfo[] }>({
    queryKey: ["/api/email-drafts/by-thread-ids", threadIds],
    queryFn: async () => {
      if (threadIds.length === 0) return { drafts: [] };
      const res = await apiRequest("POST", "/api/email-drafts/by-thread-ids", { threadIds });
      if (!res.ok) throw new Error("Failed to fetch linked drafts");
      return res.json();
    },
    enabled: threadIds.length > 0,
    refetchInterval: 30000,
  });

  const draftsByThreadId = useMemo(() => {
    const map = new Map<string, DraftInfo[]>();
    const drafts = draftsQuery.data?.drafts || [];
    for (const d of drafts) {
      if (d.threadId) {
        if (!map.has(d.threadId)) map.set(d.threadId, []);
        map.get(d.threadId)!.push(d);
      }
    }
    return map;
  }, [draftsQuery.data]);

  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();

  const draftSessionMutation = useMutation({
    mutationFn: async (thread: ThreadGroup) => {
      // Resolve the true newest message in the thread regardless of triage or
      // enrichment status — the Review tab only holds triaged+enriched
      // messages, so thread.latestMessage can be stale when a newer message
      // has arrived but not yet been triaged.
      let msg = thread.latestMessage;
      try {
        const params = new URLSearchParams({
          threadId: thread.threadId,
          accountId: thread.latestMessage.accountId,
          includeSnoozed: "true",
          limit: "1",
        });
        const freshRes = await fetch(`/api/email/messages?${params.toString()}`);
        if (freshRes.ok) {
          const fresh: { messages: EmailMessage[] } = await freshRes.json();
          if (fresh.messages?.[0]) msg = fresh.messages[0];
        }
      } catch {
        // Fall back to the Review tab's view of the thread.
      }
      const sender = parseSender(msg.fromAddress);
      const subject = msg.subject || "(no subject)";
      const titleText = `Draft: ${subject}`.slice(0, 80);

      const res = await apiRequest("POST", "/api/sessions", { title: titleText });
      const session: { id: string } = await res.json();

      const seedParts = [
        `Draft a reply to this email thread.`,
        ``,
        `**From:** ${msg.fromAddress || "Unknown"}`,
        `**Subject:** ${subject}`,
        `**Thread ID:** ${thread.threadId}`,
        `**Account:** ${msg.accountId}`,
        `**Provider Message ID:** ${msg.providerMessageId}`,
        msg.toAddresses ? `**To:** ${msg.toAddresses}` : null,
        msg.ccAddresses ? `**CC:** ${msg.ccAddresses}` : null,
        ``,
        `**Latest message from ${sender}:**`,
        `> ${(msg.bodyText || msg.snippet || "(no content)").slice(0, 2000)}`,
        ``,
        `---`,
        ``,
        `Draft a reply and IMMEDIATELY create a Gmail draft using the \`gmail\` tool's \`draft\` action with:`,
        `- **to:** ${msg.fromAddress || ""}`,
        `- **subject:** Re: ${subject}`,
        `- **account:** ${msg.accountId}`,
        `- **body:** the reply text`,
        `- **thread_id:** ${thread.threadId}`,
        ``,
        `Do NOT wait for approval before creating the draft. Create it immediately.`,
        `After creating the draft, include an \`@email_draft:<draftId>\` reference in your response so Ray can click through to it.`,
      ].filter(Boolean);

      await apiRequest("POST", `/api/sessions/${session.id}/messages`, {
        content: seedParts.join("\n"),
      });

      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to start draft", description: err.message, variant: "destructive" });
    },
  });

  const accountLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) map.set(a.accountId, a.label || a.email);
    return map;
  }, [accounts]);

  if (messagesQuery.isLoading) return <ListSkeleton />;
  if (messagesQuery.isError || syncStatusQuery.isError || enrichmentsQuery.isError || draftsQuery.isError) {
    return <CommsErrorState title="Review failed to load" message="The Review tab could not fetch messages, sync status, enrichments, or linked drafts." />;
  }

  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center" data-testid="review-empty">
        <Sparkles className="h-12 w-12 text-muted-foreground/30 mb-4" />
        <h3 className="text-lg font-medium mb-2">Nothing needs attention</h3>
        <p className="text-sm text-muted-foreground">No actionable triaged emails right now.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div data-testid="review-thread-list">
        {threads.map((thread) => {
          const threadDrafts = draftsByThreadId.get(thread.threadId) ?? [];
          return (
            <ThreadRow
              key={thread.threadId}
              thread={thread}
              accountLabel={accounts.length > 1 ? accountLabelMap.get(thread.latestMessage.accountId) : undefined}
              onHover={onHover}
              showDoneButton
              linkedDrafts={threadDrafts}
              onDraftClick={() => draftSessionMutation.mutate(thread)}
              onViewDraft={() => onSwitchTab("drafts")}
              enrichment={enrichmentMap.get(thread.threadId)}
              showEnrichment
              onSnooze={handleSnooze}
            />
          );
        })}
      </div>
    </div>
  );
}

function HistoryTab() {
  const today = new Date();
  const recentStart = new Date(today);
  recentStart.setDate(recentStart.getDate() - 14);
  const todayStr = today.toISOString().split("T")[0];
  const recentStartStr = recentStart.toISOString().split("T")[0];
  const [startDate, setStartDate] = useState(recentStartStr);
  const [endDate, setEndDate] = useState(todayStr);
  const [actionType, setActionType] = useState("all");

  const historyQuery = useQuery<{ history: EmailDismissal[] }>({
    queryKey: ["/api/email/history", startDate, endDate, actionType],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", new Date(startDate).toISOString());
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        params.set("endDate", end.toISOString());
      }
      if (actionType && actionType !== "all") params.set("type", actionType);
      const res = await fetch(`/api/email/history?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch history");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const history = historyQuery.data?.history || [];

  const dismissedByLabel: Record<string, string> = {
    auto: "Auto-dismissed",
    auto_enrich: "AI-dismissed",
    manual: "Marked done",
  };

  const dismissedByColor: Record<string, string> = {
    auto: "bg-info/15 text-info-foreground dark:text-info border-info/30",
    auto_enrich: "bg-cat-ai/15 text-cat-ai-foreground border-cat-ai/30",
    manual: "bg-success/15 text-success-foreground border-success/30",
  };

  return (
    <div className="h-full flex flex-col" data-testid="history-tab">
      <div className="p-3 border-b space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-8 w-36 text-xs"
              data-testid="input-history-start-date"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="h-8 w-36 text-xs"
              data-testid="input-history-end-date"
            />
          </div>
          <Select value={actionType} onValueChange={setActionType}>
            <SelectTrigger className="w-36 h-8 text-xs" data-testid="select-history-type">
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              <SelectItem value="auto">Auto-dismissed</SelectItem>
              <SelectItem value="auto_enrich">AI-dismissed</SelectItem>
              <SelectItem value="manual">Marked done</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {historyQuery.isLoading ? (
        <ListSkeleton />
      ) : historyQuery.isError ? (
        <CommsErrorState title="History failed to load" message="The History tab could not fetch completed Comms actions." />
      ) : history.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 px-4 text-center flex-1" data-testid="history-empty">
          <History className="h-12 w-12 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium mb-2">No history</h3>
          <p className="text-sm text-muted-foreground">No email actions found for this period.</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div data-testid="history-list">
            {history.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-3 p-3 border-b hover:bg-muted/20 transition-colors"
                data-testid={`row-history-${item.id}`}
              >
                <div className="shrink-0">
                  {item.dismissedBy === "manual" ? (
                    <CheckCircle2 className="h-4 w-4 text-success" />
                  ) : (
                    <Sparkles className="h-4 w-4 text-info" />
                  )}
                </div>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <Badge
                      variant="outline"
                      className={`text-xs px-1.5 py-0 shrink-0 ${dismissedByColor[item.dismissedBy] || "bg-muted text-muted-foreground"}`}
                      data-testid={`badge-action-type-${item.id}`}
                    >
                      {dismissedByLabel[item.dismissedBy] || item.dismissedBy}
                    </Badge>
                    {item.tier && <TriageBadge tier={item.tier} />}
                    <span className="text-xs text-muted-foreground truncate min-w-0 max-w-full" data-testid={`text-history-sender-${item.id}`}>
                      {item.sender ? <SenderName fromAddress={item.sender} /> : "Unknown"}
                    </span>
                  </div>
                  <p className="text-sm truncate" data-testid={`text-history-subject-${item.id}`}>
                    {item.subject || "(no subject)"}
                  </p>
                  {item.reason && (
                    <p className="text-xs text-muted-foreground line-clamp-2 break-words" data-testid={`text-history-reason-${item.id}`}>
                      {item.reason}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-xs text-muted-foreground" data-testid={`text-history-time-${item.id}`}>
                  {item.dismissedAt ? formatAge(new Date(item.dismissedAt).toISOString()) : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CommsPage() {
  const hoveredIdsRef = useRef<number[] | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const hasRefreshedOnOpenRef = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);
  const markDone = useEmailMarkDone();

  const refreshMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/email/sync");
      await invalidateEmailQueries();
    },
  });

  const refreshEmail = useCallback(() => {
    if (!refreshMutation.isPending) refreshMutation.mutate();
  }, [refreshMutation]);

  const atScrollTop = useCallback((target?: HTMLElement | null) => {
    const scrollContainer = nearestScrollContainer(target || rootRef.current);
    return (scrollContainer?.scrollTop ?? 0) <= 0;
  }, []);

  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : rootRef.current;
    touchStartYRef.current = atScrollTop(target) ? event.touches[0]?.clientY ?? null : null;
  }, [atScrollTop]);

  const handleTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const startY = touchStartYRef.current;
    const target = event.target instanceof HTMLElement ? event.target : rootRef.current;
    if (startY == null || !atScrollTop(target)) return;

    const currentY = event.touches[0]?.clientY ?? startY;
    const delta = currentY - startY;
    if (delta <= 0) {
      setPullDistance(0);
      return;
    }

    setPullDistance(Math.min(MAX_PULL_DISTANCE, delta * 0.45));
  }, [atScrollTop]);

  const handleTouchEnd = useCallback(() => {
    if (pullDistance >= PULL_THRESHOLD) refreshEmail();
    touchStartYRef.current = null;
    setPullDistance(0);
  }, [pullDistance, refreshEmail]);

  const refreshLabel = refreshMutation.isPending ? "Refreshing…" : pullDistance >= PULL_THRESHOLD ? "Release to refresh" : "Pull to refresh";

  const handleHover = useCallback((ids: number[] | null) => {
    hoveredIdsRef.current = ids;
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "e" && !e.repeat && hoveredIdsRef.current !== null && hoveredIdsRef.current.length > 0) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        markDone.mutate({ ids: hoveredIdsRef.current, isDone: true });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [markDone]);

  useEffect(() => {
    if (hasRefreshedOnOpenRef.current) return;
    hasRefreshedOnOpenRef.current = true;
    refreshEmail();
  }, [refreshEmail]);

  const headerStatus = useMemo(() => <EmailPipelineStatusBadge />, []);

  usePageHeader({
    title: "Email",
    customContent: headerStatus,
  });

  return (
    <div
      ref={rootRef}
      className="h-full flex flex-col min-w-0 overflow-x-hidden touch-pan-y overscroll-y-contain"
      data-testid="comms-page"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div
        className="flex items-center justify-center gap-2 overflow-hidden text-xs text-muted-foreground transition-[height,opacity] duration-200"
        style={{ height: Math.max(pullDistance, refreshMutation.isPending ? 32 : 0), opacity: pullDistance > 8 || refreshMutation.isPending ? 1 : 0 }}
        aria-live="polite"
        data-testid="email-pull-refresh-indicator"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
        {refreshLabel}
      </div>
      <CommsHealthBanner />
      <TriageErrorBanner />
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="space-y-1 p-2 min-w-0" data-testid="comms-primary-view">
          <CommsSection id="review" title="Review" defaultOpen>
            <div className="max-h-[calc(100vh-13rem)] overflow-y-auto overflow-x-hidden rounded-md border border-border/20" data-testid="section-panel-review">
              <ReviewTab onHover={handleHover} onSwitchTab={() => undefined} />
            </div>
          </CommsSection>
          <CommsSection id="triage" title="Triage">
            <div className="max-h-[420px] overflow-y-auto overflow-x-hidden rounded-md border border-border/20" data-testid="section-panel-triage">
              <TriageTab onHover={handleHover} />
            </div>
          </CommsSection>
          <CommsSection id="inbox" title="Inbox">
            <div className="max-h-[420px] overflow-y-auto overflow-x-hidden rounded-md border border-border/20" data-testid="section-panel-inbox">
              <InboxTab onHover={handleHover} />
            </div>
          </CommsSection>
          <CommsSection id="drafts" title="Drafts">
            <div className="max-h-[420px] overflow-y-auto overflow-x-hidden rounded-md border border-border/20" data-testid="section-panel-drafts">
              <DraftsView />
            </div>
          </CommsSection>
          <CommsSection id="history" title="History">
            <div className="max-h-[420px] overflow-y-auto overflow-x-hidden rounded-md border border-border/20" data-testid="section-panel-history">
              <HistoryTab />
            </div>
          </CommsSection>
        </div>
      </div>
    </div>
  );
}
