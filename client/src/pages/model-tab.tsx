import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCircle2, Circle, Route, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ModelConnector {
  id: number;
  provider: "anthropic" | "openai" | "openai-subscription" | "claude-cli";
  label: string;
  status: string;
  sortOrder: number;
  credentialRef: string | null;
  lastVerifiedAt: string | null;
  config: { kind: "model"; tierMappings: Record<"max" | "high" | "balanced" | "fast", string> };
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

export default function ModelTab() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<ConnectorsResponse>({ queryKey: ["/api/models/connectors"] });
  const { data: evidence } = useQuery<CallsResponse>({ queryKey: ["/api/inference/calls?limit=20"] });
  const connectors = data?.connectors ?? [];

  const updateMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: "active" | "inactive" }) => (await apiRequest("PATCH", `/api/models/connectors/${id}`, { status })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/models/connectors"] }),
    onError: (error: Error) => toast({ title: "Connector update failed", description: error.message, variant: "destructive" }),
  });
  const reorderMutation = useMutation({
    mutationFn: async (ids: number[]) => (await apiRequest("PUT", "/api/models/connectors/order", { ids })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/models/connectors"] }),
    onError: (error: Error) => toast({ title: "Priority update failed", description: error.message, variant: "destructive" }),
  });

  const routedCalls = useMemo(() => (evidence?.calls ?? []).filter((call) => call.metadata?.routing?.connectorId).slice(0, 8), [evidence]);
  const move = (index: number, direction: -1 | 1) => {
    const next = [...connectors];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    reorderMutation.mutate(next.map((connector) => connector.id));
  };

  if (isLoading) return <div className="space-y-4 p-4 @sm:p-6">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;

  return <div className="space-y-6 p-4 @sm:p-6 w-full min-w-0">
    <Card className="overflow-hidden min-w-0">
      <CardHeader><CardTitle className="text-lg">Connector priority</CardTitle></CardHeader>
      <CardContent className="p-0">
        {connectors.length === 0 ? <div className="px-4 py-3 text-sm text-muted-foreground">No model connectors configured.</div> : connectors.map((connector, index) => {
          const ready = connector.status === "active" && !!connector.credentialRef;
          return <div key={connector.id} className="flex min-h-14 items-center gap-3 border-t border-border/20 px-4 py-2" data-testid={`connector-priority-${connector.id}`}>
            <span className="w-5 shrink-0 text-sm font-medium text-muted-foreground">{index + 1}</span>
            {ready ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : connector.status === "active" ? <TriangleAlert className="h-4 w-4 shrink-0 text-warning" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{connector.label}</div>
              <div className="truncate text-xs text-muted-foreground">{connector.provider} · {connector.credentialRef ? `verified ${timeAgo(connector.lastVerifiedAt)}` : "credential missing"}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={index === 0 || reorderMutation.isPending} onClick={() => move(index, -1)} aria-label={`Raise ${connector.label}`}><ArrowUp className="h-4 w-4" /></Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={index === connectors.length - 1 || reorderMutation.isPending} onClick={() => move(index, 1)} aria-label={`Lower ${connector.label}`}><ArrowDown className="h-4 w-4" /></Button>
              <Switch checked={connector.status === "active"} disabled={updateMutation.isPending} onCheckedChange={(checked) => updateMutation.mutate({ id: connector.id, status: checked ? "active" : "inactive" })} aria-label={`Enable ${connector.label}`} />
            </div>
          </div>;
        })}
      </CardContent>
    </Card>

    <Card className="overflow-hidden min-w-0">
      <CardHeader className="flex-row items-center justify-between gap-3"><CardTitle className="text-lg">Recent routing</CardTitle><Badge variant="outline">{evidence?.total ?? 0} calls</Badge></CardHeader>
      <CardContent className="p-0">
        {routedCalls.length === 0 ? <div className="px-4 py-3 text-sm text-muted-foreground">No connector routing evidence yet.</div> : routedCalls.map((call) => {
          const routing = call.metadata!.routing!;
          return <div key={call.id} className="flex items-center gap-3 border-t border-border/20 px-4 py-2.5">
            <Route className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{routing.connectorLabel || routing.connectorProvider}</div><div className="truncate text-xs text-muted-foreground">{routing.requestedTier || call.tier || "balanced"} → {routing.resolvedModel || call.model}</div></div>
            <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(call.timestamp)}</span>
          </div>;
        })}
      </CardContent>
    </Card>
  </div>;
}
