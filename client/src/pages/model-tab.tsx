import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, Route, TriangleAlert } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { IntegrationTreeSection } from "@/components/integrations/integration-tree-section";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { HIERARCHY_TREE_STACK_CLASS } from "@/components/hierarchy-section-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type SemanticTier = "max" | "high" | "balanced" | "fast";
type TierModelConfig = string | { model: string; reasoningEffort?: string; reasoningMode?: string; reasoningSummary?: string; verbosity?: string; serviceTier?: string; maxOutputTokens?: number };
interface ModelConnector {
  id: number;
  provider: "anthropic" | "openai" | "openai-subscription" | "claude-cli" | "grok-subscription";
  label: string;
  status: string;
  sortOrder: number;
  /** Explicit pin: pinned connectors sort ahead of unpinned peers. */
  priorityPinned?: boolean;
  credentialRef: string | null;
  lastVerifiedAt: string | null;
  config: { kind: "model" | "openai-models" | "claude-cli-models" | "grok-models"; tierMappings: Record<SemanticTier, TierModelConfig> };
}
interface ConnectorsResponse { connectors: ModelConnector[] }
interface InferenceCall { id: number; timestamp: string; model: string; status?: string; tier?: string; metadata?: { routing?: { connectorId?: number; connectorLabel?: string; connectorProvider?: string; requestedTier?: string; resolvedModel?: string; attempts?: unknown[] } } }
interface CallsResponse { calls: InferenceCall[]; total: number }

function timeAgo(value: string | null): string {
  if (!value) return "Never verified";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export default function ModelsPage() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<ConnectorsResponse>({ queryKey: ["/api/models/connectors"] });
  const { data: evidence } = useQuery<CallsResponse>({ queryKey: ["/api/inference/calls?limit=20"] });
  const connectors = data?.connectors ?? [];

  const updateMutation = useMutation({
    mutationFn: async ({ id, status, priorityPinned }: { id: number; status?: "active" | "inactive"; priorityPinned?: boolean }) =>
      (await apiRequest("PATCH", `/api/models/connectors/${id}`, {
        ...(status !== undefined ? { status } : {}),
        ...(priorityPinned !== undefined ? { priorityPinned } : {}),
      })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/models/connectors"] }),
    onError: (error: Error) => toast({ title: "Connector update failed", description: error.message, variant: "destructive" }),
  });
  const reorderMutation = useMutation({
    mutationFn: async (ids: number[]) => (await apiRequest("PUT", "/api/models/connectors/order", { ids })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/models/connectors"] }),
    onError: (error: Error) => toast({ title: "Priority update failed", description: error.message, variant: "destructive" }),
  });

  const routedCalls = useMemo(() => (evidence?.calls ?? []).filter((call) => call.metadata?.routing?.connectorId).slice(0, 8), [evidence]);
  // Moves stay inside the pin cohort so pin remains the hard priority discriminant.
  const move = (index: number, direction: -1 | 1) => {
    const current = connectors[index];
    if (!current) return;
    const target = index + direction;
    if (target < 0 || target >= connectors.length) return;
    if (!!connectors[target]?.priorityPinned !== !!current.priorityPinned) return;
    const next = [...connectors];
    [next[index], next[target]] = [next[target], next[index]];
    reorderMutation.mutate(next.map((connector) => connector.id));
  };

  if (isLoading) return <div className="space-y-4 p-4 @sm:p-6">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;

  return (
    <div className="w-full min-w-0 p-4 @sm:p-6">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <IntegrationTreeSection label="Connector priority" initialOpen icon={<Route className="h-3.5 w-3.5" />} testIdPrefix="connector-priority">
          {connectors.length === 0 ? (
            <ProfileTreeRow label="Connectors" icon={<Circle className="h-3.5 w-3.5" />} hasValue showEmpty>
              <span className="text-muted-foreground">None configured</span>
            </ProfileTreeRow>
          ) : connectors.map((connector, index) => {
            const ready = connector.status === "active" && !!connector.credentialRef;
            const pinned = connector.priorityPinned === true;
            const canRaise = index > 0 && !!connectors[index - 1]?.priorityPinned === pinned;
            const canLower = index < connectors.length - 1 && !!connectors[index + 1]?.priorityPinned === pinned;
            return (
              <ProfileTreeRow
                key={connector.id}
                label={connector.label}
                icon={ready ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : connector.status === "active" ? <TriangleAlert className="h-3.5 w-3.5 text-warning" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" />}
                hasValue
                showEmpty
                testId={`connector-priority-${connector.id}`}
                actionContent={(
                  <Switch
                    checked={connector.status === "active"}
                    disabled={updateMutation.isPending}
                    onCheckedChange={(checked) => updateMutation.mutate({ id: connector.id, status: checked ? "active" : "inactive" })}
                    aria-label={`Enable ${connector.label}`}
                  />
                )}
                menuContent={(
                  <>
                    <DropdownMenuItem
                      disabled={updateMutation.isPending}
                      onClick={() => updateMutation.mutate({ id: connector.id, priorityPinned: !pinned })}
                      data-testid={`connector-pin-${connector.id}`}
                    >
                      {pinned ? "Unpin" : "Pin"}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!canRaise || reorderMutation.isPending} onClick={() => move(index, -1)}>
                      Raise
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!canLower || reorderMutation.isPending} onClick={() => move(index, 1)}>
                      Lower
                    </DropdownMenuItem>
                  </>
                )}
              >
                <span className="truncate text-muted-foreground">
                  {index + 1}. {connector.provider}
                  {pinned ? " · Pinned" : ""}
                  {" · "}
                  {connector.credentialRef ? `verified ${timeAgo(connector.lastVerifiedAt)}` : "credential missing"}
                </span>
              </ProfileTreeRow>
            );
          })}
        </IntegrationTreeSection>

        <IntegrationTreeSection
          label="Recent routing"
          initialOpen
          icon={<Route className="h-3.5 w-3.5" />}
          testIdPrefix="recent-routing"
          actions={<span className="pr-2 text-xs text-muted-foreground">{evidence?.total ?? 0} calls</span>}
        >
          {routedCalls.length === 0 ? (
            <ProfileTreeRow label="Calls" icon={<Route className="h-3.5 w-3.5" />} hasValue showEmpty>
              <span className="text-muted-foreground">No routing evidence yet</span>
            </ProfileTreeRow>
          ) : routedCalls.map((call) => {
            const routing = call.metadata!.routing!;
            return (
              <ProfileTreeRow
                key={call.id}
                label={routing.connectorLabel || routing.connectorProvider || "Connector"}
                icon={<Route className="h-3.5 w-3.5" />}
                hasValue
                showEmpty
              >
                <span className="truncate text-muted-foreground">
                  {routing.requestedTier || call.tier || "balanced"} → {routing.resolvedModel || call.model}
                  {" · "}
                  {timeAgo(call.timestamp)}
                </span>
              </ProfileTreeRow>
            );
          })}
        </IntegrationTreeSection>
      </div>
    </div>
  );
}
