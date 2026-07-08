import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Brain,
  AlertTriangle,
  Settings,
  Crown,
  Gauge,
  Zap,
  Sparkles,
  Plus,
  Trash2,
  Loader2,
  MessageSquare,
  Bot,
  Eye,
  Target,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";

const log = createLogger("ModelTab");

interface ModelInfo {
  id: string;
  name: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevel: "extended" | "basic" | "none";
  thinkingDescription: string;
}

interface ProviderInfo {
  id: string;
  name: string;
  models: ModelInfo[];
}

interface ModelsResponse {
  providers: ProviderInfo[];
  currentModel: string;
}

interface TierInfo {
  id: string;
  label: string;
  description: string;
  model: string | null;
  thinkingBudget: number;
}

interface RoutingInfo {
  id: string;
  label: string;
  description: string;
  tier: string;
  isBuiltin?: boolean;
}

interface TiersResponse {
  tiers: TierInfo[];
  routing: RoutingInfo[];
}

function formatCostPerMillion(cost: number): string {
  if (cost === 0) return "free";
  return `$${(cost * 1_000_000).toFixed(2)}/M`;
}

const TIER_ICONS: Record<string, typeof Brain> = {
  max: Crown,
  high: Brain,
  balanced: Gauge,
  fast: Zap,
};

const ACTIVITY_ICONS: Record<string, typeof Brain> = {
  "c7a1e3b4-5d2f-4a89-b6e0-1f8c9d2e3a4b": MessageSquare,
  "d8b2f4c5-6e3a-4b90-c7f1-2a9d0e3f4b5c": Bot,
  "f0d4b6e7-8a5c-4d12-e9b3-4c1f2a5b6d7e": Sparkles,
  "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d": Settings,
  "a1e5c7f8-9b6d-4e23-f0c4-5d2a3b6c7e8f": Brain,
  "b2f6d8a9-0c7e-4f34-a1d5-6e3b4c7d8f0a": Eye,
  "c3a7e9b0-1d8f-4a45-b2e6-7f4c5d8e9a1b": Target,
};

const TIER_OPTIONS = [
  { value: "max", label: "Max" },
  { value: "high", label: "High" },
  { value: "balanced", label: "Balanced" },
  { value: "fast", label: "Fast" },
  { value: "auto", label: "Auto" },
];


function InlineEditLabel({ value, onSave, disabled, testId }: { value: string; onSave: (v: string) => void; disabled?: boolean; testId?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft.trim() && draft.trim() !== value) onSave(draft); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { if (draft.trim() && draft.trim() !== value) onSave(draft); setEditing(false); }
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className="h-7 text-sm font-medium px-1.5"
        disabled={disabled}
        data-testid={testId ? `input-edit-${testId}` : undefined}
      />
    );
  }

  return (
    <span
      className="text-sm font-medium cursor-text hover:text-foreground/80"
      onClick={() => { setDraft(value); setEditing(true); }}
      data-testid={testId ? `text-${testId}` : undefined}
    >
      {value}
    </span>
  );
}

function findModelInfo(modelFull: string | null, providers: ProviderInfo[]): { provider: ProviderInfo; model: ModelInfo } | null {
  if (!modelFull) return null;
  const parts = modelFull.split("/");
  const providerId = parts.length >= 2 ? parts[0] : "";
  const modelId = parts.length >= 2 ? parts.slice(1).join("/") : modelFull;
  for (const p of providers) {
    const m = p.models.find(m => m.id === modelId && p.id === providerId);
    if (m) return { provider: p, model: m };
  }
  return null;
}

export default function ModelTab() {
  const { toast } = useToast();

  const { data: modelsData, isLoading: modelsLoading } = useQuery<ModelsResponse>({
    queryKey: ["/api/models/available"],
  });

  const { data: tiersData, isLoading: tiersLoading } = useQuery<TiersResponse>({
    queryKey: ["/api/models/tiers"],
  });

  const updateTierMutation = useMutation({
    mutationFn: async ({ tierId, model }: { tierId: string; model: string }) => {
      const res = await apiRequest("POST", "/api/models/tiers", { tierId, model });
      return res.json();
    },
    onMutate: async ({ tierId, model }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/models/tiers"] });
      const previous = queryClient.getQueryData<TiersResponse>(["/api/models/tiers"]);
      if (previous) {
        queryClient.setQueryData<TiersResponse>(["/api/models/tiers"], {
          ...previous,
          tiers: previous.tiers.map(t => t.id === tierId ? { ...t, model } : t),
        });
      }
      return { previous };
    },
    onSuccess: (data) => {
      const prev = queryClient.getQueryData<TiersResponse>(["/api/models/tiers"]);
      if (prev && data?.tiers) {
        queryClient.setQueryData<TiersResponse>(["/api/models/tiers"], {
          ...prev,
          tiers: data.tiers,
        });
      }
    },
    onError: (err: Error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/models/tiers"], context.previous);
      }
      log.error("model update failed:", err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateThinkingBudgetMutation = useMutation({
    mutationFn: async ({ tierId, thinkingBudget }: { tierId: string; thinkingBudget: number }) => {
      const res = await apiRequest("PATCH", "/api/models/tiers/thinking-budget", { tierId, thinkingBudget });
      return res.json();
    },
    onMutate: async ({ tierId, thinkingBudget }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/models/tiers"] });
      const previous = queryClient.getQueryData<TiersResponse>(["/api/models/tiers"]);
      if (previous) {
        queryClient.setQueryData<TiersResponse>(["/api/models/tiers"], {
          ...previous,
          tiers: previous.tiers.map(t => t.id === tierId ? { ...t, thinkingBudget } : t),
        });
      }
      return { previous };
    },
    onSuccess: (data) => {
      const prev = queryClient.getQueryData<TiersResponse>(["/api/models/tiers"]);
      if (prev && data?.tiers) {
        queryClient.setQueryData<TiersResponse>(["/api/models/tiers"], {
          ...prev,
          tiers: data.tiers,
        });
      }
    },
    onError: (err: Error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/models/tiers"], context.previous);
      }
      log.error("thinking budget update failed:", err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateRoutingMutation = useMutation({
    mutationFn: async ({ activityId, tier }: { activityId: string; tier: string }) => {
      const res = await apiRequest("POST", "/api/models/routing", { activityId, tier });
      return res.json();
    },
    onMutate: async ({ activityId, tier }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/models/tiers"] });
      const previous = queryClient.getQueryData<TiersResponse>(["/api/models/tiers"]);
      if (previous) {
        queryClient.setQueryData<TiersResponse>(["/api/models/tiers"], {
          ...previous,
          routing: previous.routing.map(r => r.id === activityId ? { ...r, tier } : r),
        });
      }
      return { previous };
    },
    onSuccess: (data) => {
      const prev = queryClient.getQueryData<TiersResponse>(["/api/models/tiers"]);
      if (prev && data?.routing) {
        queryClient.setQueryData<TiersResponse>(["/api/models/tiers"], {
          ...prev,
          routing: data.routing,
        });
      }
    },
    onError: (err: Error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/models/tiers"], context.previous);
      }
      log.error("routing update failed:", err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const addActivityMutation = useMutation({
    mutationFn: async ({ id, label, description }: { id: string; label: string; description: string }) => {
      const res = await apiRequest("POST", "/api/models/activities", { id, label, description });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/models/tiers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/models/activities"] });
      toast({ title: "Activity type added" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const editActivityMutation = useMutation({
    mutationFn: async ({ id, label, description }: { id: string; label: string; description: string }) => {
      const res = await apiRequest("PATCH", `/api/models/activities/${id}`, { label, description });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/models/tiers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/models/activities"] });
      toast({ title: "Activity updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteActivityMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/models/activities/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/models/tiers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/models/activities"] });
      toast({ title: "Activity type removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const [addActivityOpen, setAddActivityOpen] = useState(false);
  const [newActivityId, setNewActivityId] = useState("");
  const [newActivityLabel, setNewActivityLabel] = useState("");


  const [deleteActivityTarget, setDeleteActivityTarget] = useState<string | null>(null);

  const providers = modelsData?.providers || [];
  const tiers = tiersData?.tiers || [];
  const routing = tiersData?.routing || [];
  const isLoading = modelsLoading || tiersLoading;

  if (isLoading) {
    return (
      <div className="space-y-4 p-4 @sm:p-6 w-full">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="p-4 space-y-3">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-9 w-full" />
            </Card>
        ))}
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="p-4 @sm:p-6 w-full">
        <Card className="border-dashed py-8">
            <div className="flex flex-col items-center gap-3 text-center">
              <AlertTriangle className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No model providers detected. Connect an OpenAI or Claude subscription, or add ANTHROPIC_API_KEY / OPENAI_API_KEY in Secrets to see available models.
              </p>
            </div>
          </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 @sm:p-6 w-full min-w-0">
      <div className="space-y-3 min-w-0">
        <div className="flex flex-col @sm:flex-row @sm:items-center @sm:justify-between gap-2">
          <h3 className="text-sm font-semibold min-w-0">Activity Routing</h3>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs self-start @sm:self-auto shrink-0"
            onClick={() => { setAddActivityOpen(true); setNewActivityId(""); setNewActivityLabel(""); }}
            data-testid="button-add-activity"
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Activity Type
          </Button>
        </div>

        <div className="grid gap-2">
              {routing.map((activity) => {
                const Icon = ACTIVITY_ICONS[activity.id] || Settings;
                return (
                  <Card key={activity.id} className="py-3 px-3 @sm:px-4 overflow-hidden" data-testid={`routing-row-${activity.id}`}>
                    <div className="flex flex-wrap @sm:flex-nowrap items-center gap-3 min-w-0">
                      <div className="shrink-0 h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center">
                        <Icon className="h-4 w-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1 @sm:flex-none @sm:w-28 @sm:shrink-0">
                        <InlineEditLabel
                          value={activity.label}
                          onSave={(val) => editActivityMutation.mutate({ id: activity.id, label: val.trim(), description: activity.description })}
                          disabled={editActivityMutation.isPending}
                          testId={`label-${activity.id}`}
                        />
                      </div>
                      <div className="basis-full @sm:basis-auto flex-1 min-w-0 order-last @sm:order-none">
                        <Select
                          value={activity.tier}
                          onValueChange={(val) => updateRoutingMutation.mutate({ activityId: activity.id, tier: val })}
                          disabled={updateRoutingMutation.isPending}
                        >
                          <SelectTrigger
                            className="w-full text-xs"
                            data-testid={`select-routing-${activity.id}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TIER_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                <span className="flex items-center gap-1.5">
                                  {opt.value === "auto" ? (
                                    <Sparkles className="h-3 w-3" />
                                  ) : (
                                    (() => { const TIcon = TIER_ICONS[opt.value] || Brain; return <TIcon className="h-3 w-3" />; })()
                                  )}
                                  {opt.label}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {!activity.isBuiltin && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
                          onClick={() => setDeleteActivityTarget(activity.id)}
                          data-testid={`button-delete-activity-${activity.id}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
      </div>

      <div className="space-y-3 min-w-0">
        <h3 className="text-sm font-semibold">Tiers</h3>

        <div className="grid gap-2">
          {tiers.map((tier) => {
            const Icon = TIER_ICONS[tier.id] || Brain;
            const modelInfo = findModelInfo(tier.model, providers);
            return (
              <Card key={tier.id} className="py-3 px-3 @sm:px-4 overflow-hidden" data-testid={`tier-card-${tier.id}`}>
                  <div className="flex flex-wrap @sm:flex-nowrap items-center gap-3 min-w-0">
                    <div className="shrink-0 h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1 @sm:flex-none @sm:w-20 @sm:shrink-0">
                      <h4 className="text-sm font-medium" data-testid={`text-tier-label-${tier.id}`}>
                        {tier.label}
                      </h4>
                    </div>
                    <div className="basis-full @sm:basis-auto flex-1 min-w-0 order-last @sm:order-none">
                      <Select
                        value={tier.model || ""}
                        onValueChange={(val) => updateTierMutation.mutate({ tierId: tier.id, model: val })}
                        disabled={updateTierMutation.isPending}
                      >
                        <SelectTrigger
                          className="w-full font-mono text-xs"
                          data-testid={`select-tier-model-${tier.id}`}
                        >
                          <span className="truncate">{modelInfo?.model.name || "Select model"}</span>
                        </SelectTrigger>
                        <SelectContent>
                          {providers.map((provider) =>
                            provider.models.map((model) => (
                              <SelectItem
                                key={`${provider.id}/${model.id}`}
                                value={`${provider.id}/${model.id}`}
                                data-testid={`option-tier-${tier.id}-${provider.id}-${model.id}`}
                              >
                                <span className="flex items-center gap-2">
                                  <span>{model.name}</span>
                                  <span className="text-muted-foreground">({provider.name})</span>
                                </span>
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    {modelInfo && (
                      <div className="hidden @md:flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                        <span>In: {formatCostPerMillion(modelInfo.model.cost.input)}</span>
                        <span>Out: {formatCostPerMillion(modelInfo.model.cost.output)}</span>
                        {modelInfo.model.thinkingLevel === "extended" ? (
                          <Select
                            value={String(tier.thinkingBudget || 0)}
                            onValueChange={(val) => updateThinkingBudgetMutation.mutate({ tierId: tier.id, thinkingBudget: Number(val) })}
                            disabled={updateThinkingBudgetMutation.isPending}
                          >
                            <SelectTrigger
                              className={`h-5 w-auto min-w-0 px-1.5 text-xs gap-0.5 border-none ${tier.thinkingBudget ? "bg-cat-ai/15 text-cat-ai-foreground" : "bg-muted text-muted-foreground"}`}
                              data-testid={`select-thinking-budget-${tier.id}`}
                            >
                              <Brain className="h-2.5 w-2.5 shrink-0" />
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="0" data-testid={`thinking-off-${tier.id}`}>Off</SelectItem>
                              <SelectItem value="4096" data-testid={`thinking-light-${tier.id}`}>Light (4K)</SelectItem>
                              <SelectItem value="8192" data-testid={`thinking-standard-${tier.id}`}>Standard (8K)</SelectItem>
                              <SelectItem value="16384" data-testid={`thinking-deep-${tier.id}`}>Deep (16K)</SelectItem>
                              <SelectItem value="32768" data-testid={`thinking-max-${tier.id}`}>Maximum (32K)</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : modelInfo.model.thinkingLevel === "basic" ? (
                          <Badge variant="secondary" className="text-xs gap-0.5 no-default-active-elevate opacity-50">
                            <Brain className="h-2.5 w-2.5" />
                            basic
                          </Badge>
                        ) : null}
                      </div>
                    )}
                  </div>
              </Card>
            );
          })}
        </div>
      </div>

      <Dialog open={addActivityOpen} onOpenChange={setAddActivityOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Activity Type</DialogTitle>
            <DialogDescription>
              Create a custom activity type for model routing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">ID</label>
              <Input
                value={newActivityId}
                onChange={(e) => setNewActivityId(e.target.value)}
                placeholder="e.g. research"
                className="h-8 text-sm mt-1"
                data-testid="input-new-activity-id"
              />
              <p className="text-xs text-muted-foreground mt-1">Lowercase, underscores allowed</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Label</label>
              <Input
                value={newActivityLabel}
                onChange={(e) => setNewActivityLabel(e.target.value)}
                placeholder="e.g. Research"
                className="h-8 text-sm mt-1"
                data-testid="input-new-activity-label"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setAddActivityOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={!newActivityId.trim() || !newActivityLabel.trim() || addActivityMutation.isPending}
              onClick={() => {
                addActivityMutation.mutate(
                  { id: newActivityId.trim(), label: newActivityLabel.trim(), description: "" },
                  { onSuccess: () => setAddActivityOpen(false) }
                );
              }}
              data-testid="button-confirm-add-activity"
            >
              {addActivityMutation.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteActivityTarget} onOpenChange={(open) => { if (!open) setDeleteActivityTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Activity Type</DialogTitle>
            <DialogDescription>
              Remove "{deleteActivityTarget}" and its routing configuration? Prompts using this activity will fall back to the default tier.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeleteActivityTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteActivityMutation.isPending}
              onClick={() => {
                if (!deleteActivityTarget) return;
                deleteActivityMutation.mutate(deleteActivityTarget, {
                  onSuccess: () => setDeleteActivityTarget(null),
                });
              }}
              data-testid="button-confirm-delete-activity"
            >
              {deleteActivityMutation.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
