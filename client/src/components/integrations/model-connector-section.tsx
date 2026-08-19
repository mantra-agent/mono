import { useQuery, useMutation } from "@tanstack/react-query";
import { Bot, Zap, XCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { IntegrationTreeSection } from "@/components/integrations/integration-tree-section";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type {
  SemanticTier,
  OpenAIReasoningEffort,
  OpenAIReasoningMode,
  OpenAIReasoningSummary,
  OpenAIVerbosity,
  OpenAIServiceTier,
  ClaudeCliEffort,
  ClaudeCliThinkingMode,
  ModelConnectorProvider,
} from "@shared/model-connectors";
import { allowedGrokReasoningEfforts, SEMANTIC_TIERS } from "@shared/model-connectors";

// UI-level tier config: covers the wire format from the API where legacy string mappings
// coexist with rich per-provider objects. The canonical shared types
// (OpenAITierModelConfig, ClaudeCliTierModelConfig) are the server-side source of truth;
// this local union adds the legacy string variant for normalization.
type TierModelConfig = string | {
  model: string;
  // OpenAI fields
  reasoningEffort?: OpenAIReasoningEffort;
  reasoningMode?: OpenAIReasoningMode;
  reasoningSummary?: OpenAIReasoningSummary;
  verbosity?: OpenAIVerbosity;
  serviceTier?: OpenAIServiceTier;
  maxOutputTokens?: number;
  // Claude CLI fields
  effort?: ClaudeCliEffort;
  thinkingMode?: ClaudeCliThinkingMode;
  maxTurns?: number;
};
interface ModelConnectorDetail {
  id: number;
  provider: ModelConnectorProvider;
  label: string;
  status: string;
  sortOrder?: number;
  priorityPinned?: boolean;
  config: { kind?: "model" | "openai-models" | "claude-cli-models" | "grok-models"; tierMappings: Record<SemanticTier, TierModelConfig> };
}
interface ModelProviderDetail {
  id: string;
  models: Array<{
    id: string; name: string;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    thinkingLevel?: "extended" | "basic" | "none";
    thinkingDescription?: string;
    supportsReasoningEffort?: boolean;
  }>;
}

const MODEL_TIERS = SEMANTIC_TIERS;
const REASONING_EFFORTS: readonly OpenAIReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
const REASONING_SUMMARIES: readonly OpenAIReasoningSummary[] = ["auto", "concise", "detailed", "none"];
const VERBOSITIES: readonly OpenAIVerbosity[] = ["low", "medium", "high"];
const SERVICE_TIERS: readonly OpenAIServiceTier[] = ["auto", "default", "flex", "priority"];
const CLAUDE_EFFORT_OPTIONS = ["activity-default", "low", "medium", "high", "max"] as const;
const GROK_ACTIVITY_DEFAULT = "activity-default" as const;
const CLAUDE_THINKING_OPTIONS = ["activity-default", "adaptive", "disabled"] as const;

function tierConfigModel(value: TierModelConfig): string {
  return typeof value === "string" ? value : value.model;
}

function normalizeTierConfig(provider: ModelConnectorDetail["provider"], value: TierModelConfig): Exclude<TierModelConfig, string> {
  const model = tierConfigModel(value);
  return { ...(typeof value === "string" ? {} : value), model: model.includes("/") ? model.split("/").pop() || model : model.replace(`${provider}/`, "") };
}

function isOpenAIProvider(provider: ModelConnectorDetail["provider"]): provider is "openai" | "openai-subscription" {
  return provider === "openai" || provider === "openai-subscription";
}

function isGrokProvider(provider: ModelConnectorDetail["provider"]): provider is "grok-subscription" {
  return provider === "grok-subscription";
}

function supportedOpenAISettings(model?: ModelProviderDetail["models"][number], provider?: ModelConnectorDetail["provider"]) {
  const supportsReasoning = Boolean(model?.reasoning || model?.supportsReasoningEffort);
  const isGpt56 = Boolean(model?.id && /gpt-5\.6/i.test(model.id));
  return {
    reasoningEffort: supportsReasoning,
    reasoningMode: supportsReasoning && isGpt56 && provider === "openai",
    reasoningSummary: supportsReasoning,
    verbosity: Boolean(model?.id && /gpt-5|gpt-5\.|gpt-5-|codex/i.test(model.id)),
    serviceTier: provider === "openai",
    serviceTierOptions: SERVICE_TIERS,
    maxOutputTokens: true,
  };
}

function sanitizeOpenAITierConfig(provider: ModelConnectorDetail["provider"], config: Exclude<TierModelConfig, string>, model?: ModelProviderDetail["models"][number]): Exclude<TierModelConfig, string> {
  const supported = supportedOpenAISettings(model, provider);
  const sanitized: Exclude<TierModelConfig, string> = { model: config.model };
  if (supported.reasoningEffort && config.reasoningEffort !== undefined) sanitized.reasoningEffort = config.reasoningEffort;
  if (supported.reasoningMode && config.reasoningMode !== undefined) sanitized.reasoningMode = config.reasoningMode;
  if (supported.reasoningSummary && config.reasoningSummary !== undefined) sanitized.reasoningSummary = config.reasoningSummary;
  if (supported.verbosity && config.verbosity !== undefined) sanitized.verbosity = config.verbosity;
  if (supported.serviceTier && config.serviceTier !== undefined && supported.serviceTierOptions.includes(config.serviceTier)) sanitized.serviceTier = config.serviceTier;
  if (config.maxOutputTokens !== undefined) sanitized.maxOutputTokens = model?.maxTokens ? Math.min(config.maxOutputTokens, model.maxTokens) : config.maxOutputTokens;
  return sanitized;
}

function grokEffortOptions(modelId: string): readonly string[] {
  return [GROK_ACTIVITY_DEFAULT, ...allowedGrokReasoningEfforts(modelId)];
}

function sanitizeGrokTierConfig(config: Exclude<TierModelConfig, string>): Exclude<TierModelConfig, string> {
  const sanitized: Exclude<TierModelConfig, string> = { model: config.model };
  const allowed = allowedGrokReasoningEfforts(config.model);
  if (config.reasoningEffort !== undefined && allowed.includes(config.reasoningEffort as typeof allowed[number])) {
    sanitized.reasoningEffort = config.reasoningEffort;
  }
  return sanitized;
}

function TierSettingSelect<T extends string>({
  label, value, options, disabled, onChange,
}: {
  label: string; value: T | undefined; options: readonly T[]; disabled?: boolean; onChange: (value: T) => void;
}) {
  return (
    <ProfileTreeRow label={label} hasValue showEmpty mobileLayout="inline">
      <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger className="h-5 min-h-5 font-mono text-sm"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
      </Select>
    </ProfileTreeRow>
  );
}

function ConnectorTierTree({
  connector,
  models,
  title,
  nested = false,
  flattenHeaders = false,
  invalidateQueryKeys,
}: {
  connector: ModelConnectorDetail;
  models: ModelProviderDetail["models"];
  title: string;
  nested?: boolean;
  flattenHeaders?: boolean;
  invalidateQueryKeys?: ReadonlyArray<readonly unknown[]>;
}) {
  const { toast } = useToast();
  const isOpenAI = isOpenAIProvider(connector.provider);
  const isClaude = connector.provider === "claude-cli";
  const isAnthropic = connector.provider === "anthropic";
  const isGrok = isGrokProvider(connector.provider);
  const mutation = useMutation({
    mutationFn: async (tierMappings: Record<SemanticTier, Exclude<TierModelConfig, string> | string>) => (await apiRequest("PATCH", `/api/models/connectors/${connector.id}`, { tierMappings })).json(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/models/connectors"] });
      if (invalidateQueryKeys) {
        await Promise.all(
          invalidateQueryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey: [...queryKey] })),
        );
      }
    },
    onError: (error: Error) => toast({ title: "Model mapping failed", description: error.message, variant: "destructive" }),
  });
  const mappings = Object.fromEntries(MODEL_TIERS.map((tier) => {
    const config = normalizeTierConfig(connector.provider, connector.config.tierMappings[tier]);
    if (isGrok) return [tier, sanitizeGrokTierConfig(config)];
    if (isAnthropic || isClaude) return [tier, config];
    if (!isOpenAI) return [tier, config];
    const model = models.find((item) => item.id === config.model || `${connector.provider}/${item.id}` === config.model);
    return [tier, sanitizeOpenAITierConfig(connector.provider, config, model)];
  })) as Record<SemanticTier, Exclude<TierModelConfig, string>>;
  const updateTier = (tier: SemanticTier, patch: Partial<Exclude<TierModelConfig, string>>) => {
    const nextConfig = { ...mappings[tier], ...patch };
    if (isOpenAI) {
      const nextModel = models.find((item) => item.id === nextConfig.model || `${connector.provider}/${item.id}` === nextConfig.model);
      mutation.mutate({ ...mappings, [tier]: sanitizeOpenAITierConfig(connector.provider, nextConfig, nextModel) });
    } else if (isGrok) {
      mutation.mutate({ ...mappings, [tier]: sanitizeGrokTierConfig(nextConfig) });
    } else if (isAnthropic) {
      // Anthropic API still persists legacy string mappings. Write only the model id.
      const persist = (value: string) => value.includes("/") ? value : `${connector.provider}/${value}`;
      mutation.mutate({
        ...Object.fromEntries(MODEL_TIERS.map((item) => [item, persist(mappings[item].model)])),
        [tier]: persist(nextConfig.model),
      } as Record<SemanticTier, string>);
    } else {
      // Claude: model plus Claude-owned knobs. Do not round-trip OpenAI Responses settings.
      mutation.mutate({ ...mappings, [tier]: nextConfig });
    }
  };
  const testIdPrefix = isClaude ? "claude-cli" : isAnthropic ? "anthropic" : isGrok ? "grok-subscription" : `openai-${connector.provider}`;

  const tiers = (
        <>
        {MODEL_TIERS.map((tier) => {
          const config = mappings[tier];
          const model = models.find((item) => item.id === config.model || `${connector.provider}/${item.id}` === config.model);
          const selectedLabel = model?.name ?? config.model;
          const supported = isOpenAI ? supportedOpenAISettings(model, connector.provider) : null;
          const supportsThinking = isClaude && model?.thinkingLevel !== "none" && model !== undefined;

          return (
            <ProfileTreeRow
              key={tier}
              label={<span className="capitalize">{tier}</span>}
              icon={tier === "fast" ? <Zap className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              defaultOpen={false}
              mobileLayout="inline"
              testId={`${testIdPrefix}-${tier}-tier`}
              expandedContentClassName="space-y-0 px-0 pb-0 pl-0 text-sm"
              expandedContent={(
                <div className="space-y-0">
                  <TierSettingSelect
                    label="Model"
                    value={config.model}
                    options={models.map((item) => item.id)}
                    disabled={mutation.isPending || models.length === 0}
                    onChange={(modelId) => {
                      if (isAnthropic) {
                        updateTier(tier, { model: modelId });
                      } else if (isClaude) {
                        const nextModel = models.find((item) => item.id === modelId);
                        const nextSupportsThinking = nextModel?.thinkingLevel !== "none";
                        updateTier(tier, { model: modelId, effort: nextSupportsThinking ? config.effort : undefined, thinkingMode: nextSupportsThinking ? config.thinkingMode : "disabled" });
                      } else if (isGrok) {
                        updateTier(tier, {
                          model: modelId,
                          reasoningEffort: allowedGrokReasoningEfforts(modelId).includes(config.reasoningEffort as never)
                            ? config.reasoningEffort
                            : undefined,
                        });
                      } else {
                        const nextModel = models.find((item) => item.id === modelId);
                        const nextSupported = supportedOpenAISettings(nextModel, connector.provider);
                        updateTier(tier, {
                          model: modelId,
                          reasoningEffort: nextSupported.reasoningEffort ? (config.reasoningEffort ?? (tier === "max" ? "high" : tier === "fast" ? "minimal" : "medium")) : undefined,
                          reasoningMode: nextSupported.reasoningMode ? (config.reasoningMode ?? "standard") : undefined,
                          reasoningSummary: nextSupported.reasoningSummary ? (config.reasoningSummary ?? "auto") : undefined,
                          verbosity: nextSupported.verbosity ? (config.verbosity ?? "medium") : undefined,
                          serviceTier: nextSupported.serviceTier ? (config.serviceTier ?? "auto") : undefined,
                          maxOutputTokens: Math.min(config.maxOutputTokens ?? nextModel?.maxTokens ?? 4096, nextModel?.maxTokens ?? Number.MAX_SAFE_INTEGER),
                        });
                      }
                    }}
                  />
                  {isClaude && (
                    <>
                      <TierSettingSelect
                        label="Effort"
                        value={(config.effort ?? "activity-default") as typeof CLAUDE_EFFORT_OPTIONS[number]}
                        options={CLAUDE_EFFORT_OPTIONS}
                        disabled={mutation.isPending || !supportsThinking || config.thinkingMode === "disabled"}
                        onChange={(value) => updateTier(tier, { effort: value === "activity-default" ? undefined : value })}
                      />
                      <TierSettingSelect
                        label="Thinking"
                        value={(config.thinkingMode ?? "activity-default") as typeof CLAUDE_THINKING_OPTIONS[number]}
                        options={CLAUDE_THINKING_OPTIONS}
                        disabled={mutation.isPending || !supportsThinking}
                        onChange={(value) => updateTier(tier, { thinkingMode: value === "activity-default" ? undefined : value, effort: value === "disabled" ? undefined : config.effort })}
                      />
                      <ProfileTreeRow label="Max turns" hasValue showEmpty mobileLayout="inline">
                        <Input
                          key={`${tier}-${config.maxTurns ?? "default"}`}
                          type="number"
                          min={1}
                          max={1000}
                          defaultValue={config.maxTurns ?? ""}
                          placeholder="Activity default"
                          disabled={mutation.isPending}
                          onBlur={(event) => {
                            const raw = event.target.value.trim();
                            if (!raw) { if (config.maxTurns !== undefined) updateTier(tier, { maxTurns: undefined }); return; }
                            const value = Number.parseInt(raw, 10);
                            if (Number.isFinite(value) && value >= 1 && value <= 1000 && value !== config.maxTurns) updateTier(tier, { maxTurns: value });
                          }}
                          className="h-5 min-h-5 font-mono text-sm"
                        />
                      </ProfileTreeRow>
                      <ProfileTreeRow label="Max output" hasValue showEmpty mobileLayout="inline">
                        <Input
                          key={`${tier}-${config.maxOutputTokens ?? "default"}`}
                          type="number"
                          min={1}
                          max={32000}
                          defaultValue={config.maxOutputTokens ?? ""}
                          placeholder="Default (32000)"
                          disabled={mutation.isPending}
                          onBlur={(event) => {
                            const raw = event.target.value.trim();
                            if (!raw) { if (config.maxOutputTokens !== undefined) updateTier(tier, { maxOutputTokens: undefined }); return; }
                            const value = Number.parseInt(raw, 10);
                            if (Number.isFinite(value) && value >= 1 && value <= 32000 && value !== config.maxOutputTokens) updateTier(tier, { maxOutputTokens: Math.min(value, 32000) });
                          }}
                          className="h-5 min-h-5 font-mono text-sm"
                        />
                      </ProfileTreeRow>
                    </>
                  )}
                  {isGrok && allowedGrokReasoningEfforts(config.model).length > 0 && (
                    <TierSettingSelect
                      label="Reasoning effort"
                      value={config.reasoningEffort ?? GROK_ACTIVITY_DEFAULT}
                      options={grokEffortOptions(config.model)}
                      disabled={mutation.isPending}
                      onChange={(value) => updateTier(tier, { reasoningEffort: value === GROK_ACTIVITY_DEFAULT ? undefined : value })}
                    />
                  )}
                  {supported?.reasoningEffort && <TierSettingSelect label="Reasoning effort" value={config.reasoningEffort ?? "medium"} options={REASONING_EFFORTS} disabled={mutation.isPending} onChange={(value) => updateTier(tier, { reasoningEffort: value })} />}
                  {supported?.reasoningMode && <TierSettingSelect label="Reasoning mode" value={config.reasoningMode ?? "standard"} options={["standard", "pro"] as const} disabled={mutation.isPending} onChange={(value) => updateTier(tier, { reasoningMode: value })} />}
                  {supported?.reasoningSummary && <TierSettingSelect label="Reasoning summary" value={config.reasoningSummary ?? "auto"} options={REASONING_SUMMARIES} disabled={mutation.isPending} onChange={(value) => updateTier(tier, { reasoningSummary: value })} />}
                  {supported?.verbosity && <TierSettingSelect label="Verbosity" value={config.verbosity ?? "medium"} options={VERBOSITIES} disabled={mutation.isPending} onChange={(value) => updateTier(tier, { verbosity: value })} />}
                  {supported?.serviceTier && <TierSettingSelect label="Service tier" value={config.serviceTier ?? "auto"} options={supported.serviceTierOptions} disabled={mutation.isPending} onChange={(value) => updateTier(tier, { serviceTier: value })} />}
                  {supported?.maxOutputTokens && (
                    <ProfileTreeRow label="Max output" hasValue showEmpty mobileLayout="inline">
                      <Input type="number" min={1} max={model?.maxTokens} value={config.maxOutputTokens ?? ""} disabled={mutation.isPending} onChange={(event) => { const value = Number.parseInt(event.target.value, 10); if (Number.isFinite(value) && value > 0) updateTier(tier, { maxOutputTokens: model?.maxTokens ? Math.min(value, model.maxTokens) : value }); }} className="h-5 min-h-5 font-mono text-sm" />
                    </ProfileTreeRow>
                  )}
                </div>
              )}
            >
              <span className="truncate font-mono">{selectedLabel}</span>
            </ProfileTreeRow>
          );
        })}
        {models.length === 0 && (
          <ProfileTreeRow label="Models" icon={<Bot className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline">
            <span className="text-muted-foreground">None available</span>
          </ProfileTreeRow>
        )}
        </>
  );

  return (
    <div className="min-w-0">
      {flattenHeaders ? tiers : (
        <IntegrationTreeSection label={title} initialOpen icon={<Bot className="h-3.5 w-3.5" />} testIdPrefix={testIdPrefix} variant={nested ? "item" : "section"}>
          {tiers}
        </IntegrationTreeSection>
      )}
    </div>
  );
}

/**
 * Packageable per-connector model-mapping widget. Callers must pass the
 * Router connector instance; leftover Integrations singleton lookup is gone.
 */
export function ModelConnectorSection({
  provider,
  connector,
  title = "Models",
  nested = false,
  flattenHeaders = false,
  invalidateQueryKeys,
}: {
  provider?: ModelConnectorProvider;
  connector: ModelConnectorDetail;
  title?: string;
  nested?: boolean;
  flattenHeaders?: boolean;
  /** Extra React Query keys to invalidate after a successful tier mapping write. */
  invalidateQueryKeys?: ReadonlyArray<readonly unknown[]>;
}) {
  const { data: modelsData } = useQuery<{ providers: ModelProviderDetail[] }>({ queryKey: ["/api/models/available"] });
  const resolvedProvider = connector.provider ?? provider;
  const models = modelsData?.providers?.find((item) => item.id === resolvedProvider)?.models ?? [];
  if (
    isOpenAIProvider(connector.provider)
    || connector.provider === "claude-cli"
    || connector.provider === "anthropic"
    || isGrokProvider(connector.provider)
  ) {
    return (
      <ConnectorTierTree
        connector={connector}
        models={models}
        title={title}
        nested={nested}
        flattenHeaders={flattenHeaders}
        invalidateQueryKeys={invalidateQueryKeys}
      />
    );
  }
  return (
    <div className="min-w-0">
      <IntegrationTreeSection label={title} initialOpen icon={<Bot className="h-3.5 w-3.5" />} variant={nested ? "item" : "section"}>
        <ProfileTreeRow label="Status" icon={<XCircle className="h-3.5 w-3.5 text-muted-foreground" />} hasValue showEmpty>
          <span className="text-muted-foreground">Unsupported connector</span>
        </ProfileTreeRow>
      </IntegrationTreeSection>
    </div>
  );
}
