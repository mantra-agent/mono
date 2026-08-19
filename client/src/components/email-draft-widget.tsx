import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";
import {
  PenLine,
  Send,
  X,
  ChevronDown,
  ChevronRight,
  Check,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RecapRecipientSelector,
  type RecapRecipientSelection,
} from "@/components/recap-recipient-selector";
import { isValidReferenceIdentifier } from "@shared/references";

const log = createLogger("EmailDraftWidget");

type CodedError = Error & { code: string };

/** Status-specific load codes so missing/stale drafts are not one opaque ERRORS identity. */
function loadFailureCode(status: number): string {
  if (status === 400) return "LOAD_HTTP_400";
  if (status === 401) return "LOAD_HTTP_401";
  if (status === 403) return "LOAD_HTTP_403";
  if (status === 404) return "LOAD_HTTP_404";
  if (status >= 500) return "LOAD_HTTP_500";
  return "LOAD_HTTP";
}

/** 4xx on GET draft is missing/stale/unauthorized input — UI shows failure, ERRORS must not page. */
function isInputLoadStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

function codedLoadError(message: string, code: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmailDraft {
  id: string;
  gmailAccountId: string | null;
  purpose: "ordinary" | "meeting_recap";
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyFormat: "text" | "markdown";
  threadId: string | null;
  inReplyTo: string | null;
  status: "draft" | "sending" | "sent" | "discarded";
  sentMessageId: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ThreadMessage {
  id: number;
  providerMessageId: string;
  fromAddress: string | null;
  toAddresses: string | null;
  ccAddresses: string | null;
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  date: string | null;
  direction: string | null;
}

interface GmailAccount {
  id: string;
  email: string;
  label: string;
  healthy?: boolean;
  scopes?: { hasSend?: boolean };
}

type EmailDraftRecipientMode =
  | { mode: "freeform" }
  | { mode: "recap_person"; selected: RecapRecipientSelection | null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSentAt(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatThreadDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Editable recipients field
// ---------------------------------------------------------------------------

function RecipientField({
  label,
  values,
  onChange,
  disabled,
}: {
  label: string;
  values: string[];
  onChange: (newValues: string[]) => void;
  disabled: boolean;
}) {
  const [inputValue, setInputValue] = useState("");

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if ((e.key === "Enter" || e.key === "," || e.key === "Tab") && inputValue.trim()) {
        e.preventDefault();
        const email = inputValue.trim().replace(/,$/g, "");
        if (email && !values.includes(email)) {
          onChange([...values, email]);
        }
        setInputValue("");
      } else if (e.key === "Backspace" && !inputValue && values.length > 0) {
        onChange(values.slice(0, -1));
      }
    },
    [inputValue, values, onChange],
  );

  const handleBlur = useCallback(() => {
    const email = inputValue.trim().replace(/,$/g, "");
    if (email && !values.includes(email)) {
      onChange([...values, email]);
    }
    setInputValue("");
  }, [inputValue, values, onChange]);

  const removeRecipient = useCallback(
    (index: number) => {
      onChange(values.filter((_, i) => i !== index));
    },
    [values, onChange],
  );

  return (
    <div className="flex items-start gap-2 min-h-[28px]">
      <span className="text-xs text-muted-foreground w-8 pt-1 shrink-0">{label}</span>
      <div className="flex flex-wrap gap-1 flex-1 min-w-0">
        {values.map((email, i) => (
          <span
            key={`${email}-${i}`}
            className="inline-flex max-w-full items-center gap-0.5 rounded-sm bg-muted px-1.5 py-0.5 text-xs"
          >
            <span className="min-w-0 break-all whitespace-normal">{email}</span>
            {!disabled && (
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => removeRecipient(i)}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={values.length === 0 ? "Add recipient..." : ""}
            className="flex-1 min-w-[100px] bg-transparent text-xs outline-none py-0.5 placeholder:text-muted-foreground/50"
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread history
// ---------------------------------------------------------------------------

function ThreadHistory({ messages }: { messages: ThreadMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  if (messages.length === 0) return null;

  return (
    <div className="border-t border-border/40">
      <button
        type="button"
        className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{messages.length} prior message{messages.length !== 1 ? "s" : ""}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          {messages.map((msg) => (
            <div key={msg.id} className="text-xs border-l-2 border-border/30 pl-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="font-medium text-foreground/80">{msg.fromAddress || "Unknown"}</span>
                {msg.date && <span>{formatThreadDate(msg.date)}</span>}
              </div>
              <div className="mt-0.5 text-muted-foreground whitespace-pre-wrap line-clamp-4">
                {msg.bodyText || msg.snippet || "(no content)"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------

export function EmailDraftWidget({ draftId }: { draftId: string }) {
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [sentExpanded, setSentExpanded] = useState(false);
  const [recapRecipientState, setRecapRecipientState] = useState({ pending: false, failed: false });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local edit state — initialized from server, patches sent on change
  const [localEdits, setLocalEdits] = useState<Partial<EmailDraft>>({});

  const hasValidDraftId = isValidReferenceIdentifier("email_draft", draftId);
  const { data, isLoading, error } = useQuery<{
    draft: EmailDraft;
    recipientMode: EmailDraftRecipientMode;
    threadMessages: ThreadMessage[];
  }>({
    queryKey: ["/api/email-drafts", draftId],
    enabled: hasValidDraftId,
    queryFn: async () => {
      log.debug("EMAIL_DRAFT_WIDGET:LOAD_START", { draftId });
      const res = await fetch(`/api/email-drafts/${draftId}`, { credentials: "include" });
      if (!res.ok) {
        const code = loadFailureCode(res.status);
        const failure = codedLoadError(`Failed to load draft (${res.status})`, code);
        // Server GET returns 404 for missing/invisible drafts — input, not a producer defect.
        if (isInputLoadStatus(res.status)) {
          log.warn("EMAIL_DRAFT_WIDGET:LOAD_INPUT", { draftId, status: res.status, code });
        } else {
          log.error("EMAIL_DRAFT_WIDGET:LOAD_FAILED", { draftId, status: res.status, code }, failure);
        }
        throw failure;
      }
      const payload = await res.json();
      log.debug("EMAIL_DRAFT_WIDGET:LOAD_SUCCESS", {
        draftId,
        status: payload?.draft?.status ?? null,
        recipientCount: Array.isArray(payload?.draft?.to) ? payload.draft.to.length : null,
        threadMessageCount: Array.isArray(payload?.threadMessages) ? payload.threadMessages.length : null,
      });
      return payload;
    },
    refetchInterval: (query) =>
      query.state.data?.draft?.status === "draft" || query.state.data?.draft?.status === "sending"
        ? 3_000
        : false,
  });

  const draft = data?.draft;
  const recipientMode = data?.recipientMode ?? { mode: "freeform" as const };
  const threadMessages = data?.threadMessages ?? [];

  // Initialize showCc/showBcc from existing data
  useEffect(() => {
    if (draft) {
      if (draft.cc.length > 0) setShowCc(true);
      if (draft.bcc.length > 0) setShowBcc(true);
    }
  }, [draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Gmail accounts for From selector
  const { data: accountsData } = useQuery<{
    accounts: GmailAccount[];
  }>({
    queryKey: ["/api/gmail/accounts"],
    enabled: !!draft && draft.status === "draft",
  });

  const accounts = useMemo(
    () => (accountsData?.accounts ?? []).filter(
      (account) => account.healthy !== false && account.scopes?.hasSend !== false,
    ),
    [accountsData?.accounts],
  );

  // Merged view: local edits overlay the server state
  const merged = useMemo(() => {
    if (!draft) return null;
    return { ...draft, ...localEdits };
  }, [draft, localEdits]);

  // Patch mutation — debounced
  const patchMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/email-drafts/${draftId}`, patch);
      return res.json();
    },
    onSuccess: (result, patch) => {
      queryClient.setQueryData(["/api/email-drafts", draftId], (old: any) =>
        old ? { ...old, draft: result.draft } : old,
      );
      setLocalEdits((current) => {
        const remaining = { ...current };
        for (const [field, value] of Object.entries(patch)) {
          if (remaining[field as keyof EmailDraft] === value) {
            delete remaining[field as keyof EmailDraft];
          }
        }
        return remaining;
      });
    },
  });

  const debouncedPatch = useCallback(
    (field: string, value: unknown) => {
      setRecapRecipientState(state => state.failed ? { ...state, failed: false } : state);
      setLocalEdits((prev) => ({ ...prev, [field]: value }));
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        patchMutation.mutate({ [field]: value });
      }, 500);
    },
    [patchMutation],
  );

  // Immediate patch (no debounce) for select changes
  const immediatePatch = useCallback(
    (field: string, value: unknown) => {
      setLocalEdits((prev) => ({ ...prev, [field]: value }));
      patchMutation.mutate({ [field]: value });
    },
    [patchMutation],
  );

  // Send mutation
  const sendMutation = useMutation({
    mutationFn: async () => {
      // Flush any pending debounced edits first
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
        if (Object.keys(localEdits).length > 0) {
          await apiRequest("PATCH", `/api/email-drafts/${draftId}`, localEdits);
        }
      }
      const res = await apiRequest("POST", `/api/email-drafts/${draftId}/send`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-drafts", draftId] });
      // Sent mail lands in the thread list and Home Inbox — same keys thread actions refresh.
      queryClient.invalidateQueries({ queryKey: ["/api/email/messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
      setLocalEdits({});
    },
  });

  // Discard mutation
  const discardMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/email-drafts/${draftId}/discard`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-drafts", draftId] });
      setLocalEdits({});
    },
  });

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Streamed reference text may contain an email_draft prefix before its UUID
  // is complete. Keep the widget inert until the canonical identifier exists.
  if (!hasValidDraftId) return null;

  // ---------------------------------------------------------------------------
  // Loading / Error
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="border rounded-md border-border/60 bg-muted/20 my-1">
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Loading draft...</span>
        </div>
      </div>
    );
  }

  if (error || !draft || !merged) {
    return (
      <div className="border rounded-md border-destructive/50 bg-destructive/10 my-1">
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          <span>Failed to load email draft</span>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Provider delivery in progress
  // ---------------------------------------------------------------------------

  if (draft.status === "sending") {
    return (
      <div className="border rounded-md border-border/60 bg-muted/20 my-1">
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-active" />
          <span>Sending email…</span>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Terminal: Sent
  // ---------------------------------------------------------------------------

  if (draft.status === "sent") {
    return (
      <div className="border rounded-md border-success/40 bg-success/5 my-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-success/10"
          onClick={() => setSentExpanded((expanded) => !expanded)}
          aria-expanded={sentExpanded}
        >
          <Check className="h-3.5 w-3.5 text-success shrink-0" />
          <div className="flex-1 min-w-0 text-sm">
            <span className="text-success font-medium">Sent</span>
            {draft.sentAt && (
              <span className="text-muted-foreground ml-2">
                {formatSentAt(draft.sentAt)}
              </span>
            )}
          </div>
          {sentExpanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
        </button>
        <div className="px-3 pb-2 space-y-1.5">
          {!sentExpanded && (
            <>
              <div className="text-xs text-muted-foreground break-words">
                To: {draft.to.join(", ")}
              </div>
              <div className="text-xs font-medium truncate">{draft.subject}</div>
            </>
          )}
          {sentExpanded && (
            <div className="space-y-1.5 border-t border-border/30 pt-2">
              <div className="text-xs text-muted-foreground break-words">
                To: {draft.to.join(", ") || "(none)"}
              </div>
              {draft.cc.length > 0 && (
                <div className="text-xs text-muted-foreground break-words">
                  CC: {draft.cc.join(", ")}
                </div>
              )}
              {draft.bcc.length > 0 && (
                <div className="text-xs text-muted-foreground break-words">
                  BCC: {draft.bcc.join(", ")}
                </div>
              )}
              <div className="text-xs font-medium break-words">Subject: {draft.subject}</div>
              <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                {draft.body || "(empty body)"}
              </div>
              {draft.sentMessageId && (
                <div className="text-xs text-muted-foreground/60 break-all">
                  ID: {draft.sentMessageId}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Terminal: Discarded
  // ---------------------------------------------------------------------------

  if (draft.status === "discarded") {
    return (
      <div className="border rounded-md border-border/30 bg-muted/10 my-1 opacity-60">
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
          <X className="h-3.5 w-3.5 shrink-0" />
          <span>Email draft discarded</span>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Active draft
  // ---------------------------------------------------------------------------

  const isSending = sendMutation.isPending;
  const isDiscarding = discardMutation.isPending;
  const isBusy = isSending || isDiscarding || recapRecipientState.pending;
  const fromAccount = accounts.find((a) => a.id === merged.gmailAccountId);
  const hasAvailableSender = accounts.length > 0 && !!fromAccount;

  return (
    <div className="border rounded-md border-border/60 bg-muted/20 my-1">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40">
        <PenLine className="h-3.5 w-3.5 text-cta shrink-0" />
        <span className="text-sm font-medium flex-1">Email Draft</span>
        {patchMutation.isPending && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Fields */}
      <div className="px-3 py-2 space-y-1.5">
        {/* From */}
        {accounts.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-8 shrink-0">From</span>
            <Select
              value={merged.gmailAccountId || ""}
              onValueChange={(val) => immediatePatch("gmailAccountId", val)}
              disabled={isBusy}
            >
              <SelectTrigger className="h-7 text-xs flex-1">
                <SelectValue placeholder="Select account">
                  {fromAccount?.email || merged.gmailAccountId || "Select account"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {accounts.map((acc) => (
                  <SelectItem key={acc.id} value={acc.id} className="text-xs">
                    {acc.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-xs text-destructive">
            <span className="w-8 shrink-0 text-muted-foreground">From</span>
            <span>No Gmail account is currently available for sending.</span>
          </div>
        )}

        {/* Recipients */}
        {recipientMode.mode === "recap_person" ? (
          <RecapRecipientSelector
            draftId={draftId}
            selected={recipientMode.selected}
            disabled={isBusy}
            onMutationStateChange={setRecapRecipientState}
          />
        ) : (
          <>
            <RecipientField
              label="To"
              values={merged.to}
              onChange={(val) => immediatePatch("to", val)}
              disabled={isBusy}
            />

            {!showCc && !showBcc && (
              <div className="flex gap-2 pl-10">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowCc(true)}
                >
                  CC
                </button>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowBcc(true)}
                >
                  BCC
                </button>
              </div>
            )}

            {showCc && (
              <RecipientField
                label="CC"
                values={merged.cc}
                onChange={(val) => immediatePatch("cc", val)}
                disabled={isBusy}
              />
            )}

            {showBcc && (
              <RecipientField
                label="BCC"
                values={merged.bcc}
                onChange={(val) => immediatePatch("bcc", val)}
                disabled={isBusy}
              />
            )}
          </>
        )}

        {/* Subject */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-8 shrink-0">Subj</span>
          <input
            type="text"
            value={merged.subject}
            onChange={(e) => debouncedPatch("subject", e.target.value)}
            disabled={isBusy}
            className="flex-1 bg-transparent text-sm outline-none border-b border-transparent focus:border-border/40 py-0.5"
            placeholder="Subject"
          />
        </div>

        {/* Body */}
        <div className="mt-2">
          <textarea
            value={merged.body}
            onChange={(e) => debouncedPatch("body", e.target.value)}
            disabled={isBusy}
            rows={Math.max(3, merged.body.split("\n").length)}
            className="w-full bg-transparent text-sm outline-none resize-none border border-border/30 rounded-sm p-2 focus:border-border/60"
            placeholder="Compose your message..."
          />
        </div>
      </div>

      {/* Thread history */}
      <ThreadHistory messages={threadMessages} />

      {/* Actions */}
      <div className="sticky bottom-0 z-10 flex items-center gap-2 border-t border-border/40 bg-card px-3 py-2">
        <Button
          size="sm"
          onClick={() => sendMutation.mutate()}
          disabled={
            isBusy
            || merged.to.length === 0
            || !hasAvailableSender
            || (recipientMode.mode === "recap_person" && (!recipientMode.selected || recapRecipientState.failed))
          }
          className="gap-1.5"
        >
          {isSending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          {isSending ? "Sending..." : "Send"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => discardMutation.mutate()}
          disabled={isBusy}
          className="text-muted-foreground"
        >
          {isDiscarding ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
          Cancel
        </Button>
        {(sendMutation.isError || recapRecipientState.failed) && (
          <span className="text-xs text-destructive ml-auto">
            {sendMutation.isError
              ? (sendMutation.error as Error).message || "Send failed"
              : "Repair the recap recipient before sending"}
          </span>
        )}
      </div>
    </div>
  );
}
