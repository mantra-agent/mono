import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { matchesSearchTokens } from "@/lib/local-search";
import {
  FileText,
  Send,
  Trash2,
  RefreshCw,
  Edit3,
  Save,
  X,
  AlertTriangle,
  CheckCircle,
  Loader2,
  User,
  Mail,
  MoreHorizontal,
} from "lucide-react";

interface EmailDraft {
  id: number;
  accountId: string;
  toAddress: string;
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  status: string;
  personId?: string;
  sourceEmailId?: number;
  gmailDraftId?: string;
  gmailError?: string;
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof CheckCircle }> = {
  pending_review: { label: "Pending Review", color: "bg-info/15 text-info-foreground dark:text-info border-info/30", icon: Edit3 },
  draft: { label: "Draft", color: "bg-info/15 text-info-foreground dark:text-info border-info/30", icon: Edit3 },
  sent: { label: "Sent", color: "bg-success/15 text-success-foreground border-success/30", icon: CheckCircle },
  send_failed: { label: "Failed", color: "bg-error/15 text-error-foreground border-error/30", icon: AlertTriangle },
  creating_gmail_draft: { label: "Creating...", color: "bg-warning/15 text-warning-foreground border-warning/30", icon: Loader2 },
  gmail_draft_failed: { label: "Draft Failed", color: "bg-error/15 text-error-foreground border-error/30", icon: AlertTriangle },
};

function StatusChip({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || { label: status, color: "bg-muted text-muted-foreground", icon: FileText };
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={`text-xs px-1.5 py-0 gap-1 ${config.color}`} data-testid={`badge-status-${status}`}>
      <Icon className="h-2.5 w-2.5" />
      {config.label}
    </Badge>
  );
}

function DraftRow({
  draft,
  isSelected,
  onSelect,
  onDiscard,
}: {
  draft: EmailDraft;
  isSelected: boolean;
  onSelect: () => void;
  onDiscard: () => void;
}) {
  const age = new Date(draft.updatedAt).toLocaleDateString();
  const canEdit = draft.status !== "sent";
  return (
    <div
      className={`group/row relative flex items-start gap-3 p-3 border-b cursor-pointer transition-colors ${isSelected ? "bg-primary/10 border-l-2 border-l-primary" : "hover:bg-muted/50"}`}
      onClick={onSelect}
      data-testid={`row-draft-${draft.id}`}
    >
      <Mail className="h-4 w-4 mt-0.5 text-muted-foreground" />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="text-sm font-medium truncate min-w-0 max-w-full" data-testid={`text-recipient-${draft.id}`}>
            {draft.toAddress}
          </span>
          <StatusChip status={draft.status} />
        </div>
        <p className="text-sm text-muted-foreground truncate" data-testid={`text-draft-subject-${draft.id}`}>
          {draft.subject || "(no subject)"}
        </p>
        {draft.personId && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <User className="h-2.5 w-2.5" />
            <span data-testid={`text-person-${draft.id}`}>Linked contact</span>
          </div>
        )}
      </div>
      <span className="text-xs text-muted-foreground shrink-0">{age}</span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="absolute right-1 top-3 h-6 w-6 p-0 opacity-0 group-hover/row:opacity-100 focus:opacity-100"
            onClick={(e) => e.stopPropagation()}
            data-testid={`button-draft-actions-${draft.id}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <DropdownMenuItem disabled className="opacity-50" data-testid={`menu-send-${draft.id}`}>
                  <Send className="h-4 w-4 mr-2" /> Send
                </DropdownMenuItem>
              </div>
            </TooltipTrigger>
            <TooltipContent>Coming soon</TooltipContent>
          </Tooltip>
          {canEdit && (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={(e) => { e.stopPropagation(); onDiscard(); }}
              data-testid={`menu-discard-${draft.id}`}
            >
              <Trash2 className="h-4 w-4 mr-2" /> Discard
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function getBodyText(draft: EmailDraft): string {
  return draft.bodyText || draft.bodyHtml || "";
}

function DraftDetailPane({
  draft,
  onClose,
}: {
  draft: EmailDraft;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [editSubject, setEditSubject] = useState(draft.subject);
  const [editBody, setEditBody] = useState(getBodyText(draft));
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/email-drafts/${draft.id}`, {
        subject: editSubject,
        bodyText: editBody,
        bodyHtml: editBody,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-drafts"] });
      setIsEditing(false);
      toast({ title: "Draft saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/email-drafts/${draft.id}/send`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-drafts"] });
      toast({ title: "Email sent successfully" });
      onClose();
    },
    onError: (err: Error) => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-drafts"] });
      toast({ title: "Send failed", description: err.message, variant: "destructive" });
    },
  });

  const discardMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/email-drafts/${draft.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-drafts"] });
      toast({ title: "Draft discarded" });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const retryMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/email-drafts/${draft.id}`, {
        status: "pending_review",
        gmailError: null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-drafts"] });
      toast({ title: "Draft reset for retry" });
    },
    onError: (err: Error) => {
      toast({ title: "Retry failed", description: err.message, variant: "destructive" });
    },
  });

  const canSend = draft.status === "pending_review" || draft.status === "draft" || draft.status === "send_failed";
  const canEdit = draft.status !== "sent";

  return (
    <Card className="h-full flex flex-col" data-testid="draft-detail-pane">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Draft Details</CardTitle>
          <Button size="icon" variant="ghost" onClick={onClose} data-testid="button-close-draft">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-4 overflow-y-auto">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">To</label>
          <p className="text-sm" data-testid="text-detail-recipient">{draft.toAddress}</p>
        </div>

        {draft.accountId && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Account</label>
            <p className="text-sm" data-testid="text-detail-account">{draft.accountId}</p>
          </div>
        )}

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Status</label>
          <div><StatusChip status={draft.status} /></div>
        </div>

        {draft.gmailError && (
          <div className="flex items-start gap-2 text-xs text-error-foreground bg-error/10 rounded p-2" data-testid="text-draft-error">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{draft.gmailError}</span>
          </div>
        )}

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Subject</label>
          {isEditing ? (
            <Input
              value={editSubject}
              onChange={(e) => setEditSubject(e.target.value)}
              className="text-sm"
              data-testid="input-edit-subject"
            />
          ) : (
            <p className="text-sm" data-testid="text-detail-subject">{draft.subject}</p>
          )}
        </div>

        <div className="space-y-1 flex-1">
          <label className="text-xs font-medium text-muted-foreground">Body</label>
          {isEditing ? (
            <Textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              className="text-sm min-h-[200px] flex-1"
              data-testid="input-edit-body"
            />
          ) : (
            <div
              className="text-sm whitespace-pre-wrap bg-muted/30 rounded p-3 min-h-[120px] max-h-[300px] overflow-y-auto"
              data-testid="text-detail-body"
            >
              {getBodyText(draft)}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-2 border-t flex-wrap">
          {isEditing ? (
            <>
              <Button
                size="sm"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                data-testid="button-save-draft"
              >
                {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditSubject(draft.subject);
                  setEditBody(getBodyText(draft));
                  setIsEditing(false);
                }}
                data-testid="button-cancel-edit"
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              {canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setIsEditing(true)}
                  data-testid="button-edit-draft"
                >
                  <Edit3 className="h-3.5 w-3.5 mr-1" />
                  Edit
                </Button>
              )}
              {canSend && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => setShowSendConfirm(true)}
                  disabled={sendMutation.isPending}
                  data-testid="button-send-draft"
                >
                  {sendMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />}
                  Send
                </Button>
              )}
              {(draft.status === "send_failed" || draft.status === "gmail_draft_failed") && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => retryMutation.mutate()}
                  disabled={retryMutation.isPending}
                  data-testid="button-retry-draft"
                >
                  <RefreshCw className={`h-3.5 w-3.5 mr-1 ${retryMutation.isPending ? "animate-spin" : ""}`} />
                  Retry
                </Button>
              )}
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setShowDiscardConfirm(true)}
                  data-testid="button-discard-draft"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Discard
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>

      <AlertDialog open={showSendConfirm} onOpenChange={setShowSendConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this email?</AlertDialogTitle>
            <AlertDialogDescription>
              This will send the email to <strong>{draft.toAddress}</strong> with subject "<strong>{draft.subject}</strong>". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-send">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => sendMutation.mutate()}
              data-testid="button-confirm-send"
            >
              Send Email
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showDiscardConfirm} onOpenChange={setShowDiscardConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this draft. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-discard">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => discardMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-discard"
            >
              Discard Draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function DraftsSkeleton() {
  return (
    <div className="space-y-0" data-testid="drafts-skeleton">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 p-3 border-b">
          <Skeleton className="h-4 w-4 mt-0.5" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3.5 w-56" />
          </div>
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

interface DraftsViewProps {
  searchTokens?: string[];
}

export default function DraftsView({ searchTokens = [] }: DraftsViewProps) {
  const { toast } = useToast();
  const [selectedDraftId, setSelectedDraftId] = useState<number | null>(null);
  const [discardTarget, setDiscardTarget] = useState<EmailDraft | null>(null);

  const draftsQuery = useQuery<{ drafts: EmailDraft[] }>({
    queryKey: ["/api/email-drafts"],
    refetchInterval: 15000,
  });

  const discardMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/email-drafts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-drafts"] });
      toast({ title: "Draft discarded" });
      if (discardTarget && selectedDraftId === discardTarget.id) setSelectedDraftId(null);
      setDiscardTarget(null);
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
      setDiscardTarget(null);
    },
  });

  const drafts = draftsQuery.data?.drafts || [];
  const filteredDrafts = drafts.filter((draft) => matchesSearchTokens(searchTokens, [
    draft.toAddress,
    draft.subject,
    draft.bodyText,
    draft.bodyHtml,
    draft.accountId,
    draft.status,
  ]));
  const selectedDraft = filteredDrafts.find((draft) => draft.id === selectedDraftId);

  if (draftsQuery.isLoading) {
    return (
      <div className="h-full" data-testid="drafts-view">
        <DraftsSkeleton />
      </div>
    );
  }

  if (filteredDrafts.length === 0) {
    return (
      <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="drafts-view">
        {searchTokens.length > 0 ? "No drafts match your search." : "No drafts yet."}
      </div>
    );
  }

  return (
    <div className="h-full flex" data-testid="drafts-view">
      <div className={`w-full ${selectedDraft ? "@md:w-72" : ""} shrink-0 ${selectedDraft ? "border-r hidden @md:block" : ""}`}>
        <ScrollArea className="h-full">
          {filteredDrafts.map((draft) => (
            <DraftRow
              key={draft.id}
              draft={draft}
              isSelected={draft.id === selectedDraftId}
              onSelect={() => setSelectedDraftId(draft.id === selectedDraftId ? null : draft.id)}
              onDiscard={() => setDiscardTarget(draft)}
            />
          ))}
        </ScrollArea>
      </div>
      {selectedDraft && (
        <div className="flex-1 min-w-0 p-4">
          <DraftDetailPane
            key={selectedDraft.id}
            draft={selectedDraft}
            onClose={() => setSelectedDraftId(null)}
          />
        </div>
      )}
      <AlertDialog open={!!discardTarget} onOpenChange={(open) => { if (!open) setDiscardTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the draft to <strong>{discardTarget?.toAddress}</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => discardTarget && discardMutation.mutate(discardTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard Draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
