import { useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, Plus } from "lucide-react";
import type { SimpleFeedItem } from "@shared/models/simple";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { SimpleWidgetRenderer } from "@/components/home/home-widget-renderer";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { usePageHeader } from "@/hooks/use-page-header";
import { useNativeMeetingTranscription } from "@/hooks/use-native-meeting-transcription";
import { apiRequest } from "@/lib/queryClient";
import type { SessionDeletionResult } from "@/lib/session-deletion";
import { cn } from "@/lib/utils";

interface MeetingCounts {
  completedMeetingCount: number;
  completedMeetingsWithNotesCount: number;
  transcriptFragmentCount: number;
  recapReadyCount: number;
}

interface MeetingsResponse {
  items: SimpleFeedItem[];
  total: number;
  counts: MeetingCounts;
}

type MeetingSectionId = "active" | "this-week" | "this-month" | "earlier";

interface MeetingSectionDefinition {
  id: MeetingSectionId;
  label: string;
  defaultOpen: boolean;
  lifecycle: "active" | "completed";
  startAfter?: string;
  startBefore?: string;
}

interface MeetingSectionProps {
  section: MeetingSectionDefinition;
  query: string;
  forceOpen: boolean;
  onDelete: (item: SimpleFeedItem) => void;
  autoExpandItemId: string | null;
}

function meetingRecordsEndpoint(section: MeetingSectionDefinition, query: string): string {
  const params = new URLSearchParams({
    limit: "100",
    lifecycle: section.lifecycle,
  });
  if (section.lifecycle === "active") params.set("includeActive", "true");
  if (section.startAfter) params.set("startAfter", section.startAfter);
  if (section.startBefore) params.set("startBefore", section.startBefore);
  if (query) params.set("query", query);
  return `/api/meetings/records?${params.toString()}`;
}

function MeetingSection({ section, query, forceOpen, onDelete, autoExpandItemId }: MeetingSectionProps) {
  const [open, setOpen] = useState(section.defaultOpen);
  const shouldFetch = open || forceOpen;
  const endpoint = meetingRecordsEndpoint(section, query);
  const { data, isLoading, error } = useQuery<MeetingsResponse>({
    queryKey: [endpoint],
    enabled: shouldFetch,
  });

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
        data-testid={`button-meeting-group-${section.id}`}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {section.label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {error ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">Unable to load meetings.</div>
        ) : isLoading || !data ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading meetings…</div>
        ) : data.items.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No meetings.</div>
        ) : (
          <div className="min-w-0">
            {data.items.map((item) => (
              <SimpleWidgetRenderer key={item.id} item={item} onDelete={onDelete} autoExpandItemId={autoExpandItemId} />
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function meetingIdFromItem(item: SimpleFeedItem): string | null {
  const meetingId = item.payload?.meetingId;
  return typeof meetingId === "string" && meetingId.trim() ? meetingId : null;
}

export default function MeetingsPage() {
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SimpleFeedItem | null>(null);
  usePageHeader({ title: "Meetings" });
  const routeSearch = useSearch();
  const targetMeetingId = useMemo(
    () => new URLSearchParams(routeSearch).get("meeting")?.trim() || null,
    [routeSearch],
  );
  const autoExpandItemId = targetMeetingId ? `meeting-${targetMeetingId}` : null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const nativeTranscription = useNativeMeetingTranscription();
  const query = search.trim();
  const sections = useMemo<MeetingSectionDefinition[]>(() => {
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(now.getDate() - 7);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return [
      { id: "active", label: "Active", defaultOpen: false, lifecycle: "active" },
      { id: "this-week", label: "This Week", defaultOpen: true, lifecycle: "completed", startAfter: weekAgo.toISOString() },
      {
        id: "this-month",
        label: "This Month",
        defaultOpen: false,
        lifecycle: "completed",
        startAfter: monthStart.toISOString(),
        startBefore: weekAgo.toISOString(),
      },
      { id: "earlier", label: "Earlier", defaultOpen: false, lifecycle: "completed", startBefore: monthStart.toISOString() },
    ];
  }, []);

  const deleteMutation = useMutation({
    mutationFn: async (item: SimpleFeedItem) => {
      const meetingId = meetingIdFromItem(item);
      if (!meetingId) throw new Error("Meeting identity is unavailable");
      const response = await apiRequest("DELETE", `/api/meetings/records/${encodeURIComponent(meetingId)}`);
      const result = await response.json() as SessionDeletionResult;
      if (nativeTranscription.activeSessionId === meetingId) {
        nativeTranscription.stopLocalCapture(meetingId);
      }
      return result;
    },
    onSuccess: () => {
      setDeleteTarget(null);
      queryClient.invalidateQueries({
        predicate: cachedQuery => String(cachedQuery.queryKey[0] ?? "").startsWith("/api/meetings/records?"),
      });
    },
    onError: error => {
      toast({
        title: "Could not delete meeting",
        description: error instanceof Error ? error.message : "The meeting was not deleted.",
        variant: "destructive",
      });
    },
  });

  return (
    <div className="flex h-full w-full flex-col bg-background" data-testid="meetings-page">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS}>
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-meetings"
            clearTestId="button-clear-meeting-search"
            ariaLabel="Search completed meetings"
          />
          <button
            type="button"
            onClick={() => void nativeTranscription.start()}
            disabled={nativeTranscription.isStarting}
            className={HIERARCHY_PRIMARY_ACTION_CLASS}
            data-testid="button-new-transcription"
          >
            {nativeTranscription.isStarting
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              : <Plus className="h-3.5 w-3.5 shrink-0" />}
            <span>{nativeTranscription.isStarting ? "Starting…" : "New Transcription"}</span>
          </button>

          {sections.map(section => (
            <MeetingSection
              key={section.id}
              section={section}
              query={query}
              forceOpen={Boolean(query) || Boolean(targetMeetingId)}
              onDelete={setDeleteTarget}
              autoExpandItemId={autoExpandItemId}
            />
          ))}
        </div>
      </div>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete meeting?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete “{deleteTarget?.title}” and its transcript? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget);
              }}
              data-testid="button-confirm-delete-meeting"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
