import { useMutation, useQuery } from "@tanstack/react-query";
import { Network, X } from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { ReferencePicker, type ReferencePickerValue } from "@/components/references/reference-picker";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface BlockingEdge {
  linkId: string;
  sourceAddress: string;
  targetAddress: string;
}

interface BlockingPage {
  edges?: BlockingEdge[];
}

const WORK_REFERENCE_TYPES = ["goal", "project", "milestone", "task"] as const;

export function BlockedByRow({ sourceAddress, testId }: { sourceAddress: string; testId?: string }) {
  const { toast } = useToast();
  const queryKey = ["/api/blocking-graph/blockers", sourceAddress];
  const { data } = useQuery<BlockingPage>({
    queryKey,
    queryFn: async () => {
      const response = await fetch(`/api/blocking-graph/blockers?sourceAddress=${encodeURIComponent(sourceAddress)}`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load blockers");
      return response.json();
    },
  });
  const edges = data?.edges ?? [];
  const values: ReferencePickerValue[] = edges.map((edge) => {
    const [type, id] = edge.targetAddress.slice(1).split(":");
    return { type: type as ReferencePickerValue["type"], id, label: edge.targetAddress };
  });
  const add = useMutation({
    mutationFn: async (targetAddress: string) => {
      await apiRequest("POST", "/api/blocking-graph/blocked-by", {
        sourceAddress,
        targetAddress,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: () => toast({ title: "Could not add blocker", variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (edge: BlockingEdge) => {
      await apiRequest("DELETE", `/api/blocking-graph/blocked-by/${edge.linkId}?sourceAddress=${encodeURIComponent(sourceAddress)}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: () => toast({ title: "Could not remove blocker", variant: "destructive" }),
  });

  return (
    <ProfileTreeRow
      label="Blocked by"
      icon={<Network className="h-3.5 w-3.5" />}
      hasValue={edges.length > 0}
      showEmpty
      mobileLayout="inline"
      expandedContent={(
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {edges.map((edge) => (
              <span key={edge.linkId} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/30 bg-accent/40 px-1.5 py-0.5 text-sm">
                <InlineReferenceText text={edge.targetAddress} />
                <button type="button" className="text-muted-foreground hover:text-destructive" aria-label={`Remove blocker ${edge.targetAddress}`} onClick={() => remove.mutate(edge)}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <ReferencePicker
            value={[]}
            types={[...WORK_REFERENCE_TYPES]}
            mode="single"
            variant="inline"
            dense
            placeholder="Add blocker…"
            excludeIds={[sourceAddress.split(":").at(-1) ?? ""]}
            onChange={(next) => {
              const selected = next[0];
              if (selected) add.mutate(`@${selected.type}:${selected.id}`);
            }}
            disabled={add.isPending}
            testId={testId ? `${testId}-picker` : undefined}
          />
        </div>
      )}
      expandedContentClassName="px-0 pb-2 pl-0"
      testId={testId}
    >
      <span className="text-muted-foreground">{edges.length || "Add"}</span>
    </ProfileTreeRow>
  );
}
