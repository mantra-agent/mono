// Use createLogger for logging ONLY
import type { Express } from "express";
import { executorManager } from "../executor-manager";
import * as modelRegistry from "../model-registry";
import { createLogger } from "../log";
import { getSecretSync } from "../secrets-store";

const log = createLogger("InferenceRoutes");
import { getConfig, initProfiles, setTierModel, setTierThinkingBudget, setTierThinking, setActivityRouting, TIER_META, ACTIVITY_META, BUILTIN_ACTIVITY_IDS, getAllActivities, addCustomActivity, updateActivityMeta, removeCustomActivity, getModelForActivity, getModelProfilesVersion, invalidateModelProfilesCache, ACTIVITY_CHAT, ACTIVITY_MEMORY, ACTIVITY_STRATEGY, type TierId, type ActivityId, type RoutingTier, type ThinkingTierConfig } from "../job-profiles";
import { thinkingBudgetToTier, tierToThinkingBudget } from "../thinking-config";
import { join } from "path";
import { z } from "zod";
import { storage } from "../storage";
import { chatFileStorage } from "../chat-file-storage";
import { pool } from "../db";
import { getSetting, setSetting } from "../system-settings";
import { runWithPrincipal } from "../principal-context";
import { createNamedSystemPrincipal } from "../principal";
import { listModelConnectors, reorderModelConnectors, updateModelConnector } from "../model-connectors";
import { modelTierMappingsSchema } from "@shared/model-connectors";

const INFERENCE_DEBUG_KEY = "system.inference_debug";

const EMBED_MODELS = new Set(["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002", "all-MiniLM-L6-v2"]);

const EMBED_PATTERNS = ["embed", "minilm", "e5-", "bge-", "gte-"];

function isEmbedModel(model: string): boolean {
  const bare = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  if (EMBED_MODELS.has(model) || EMBED_MODELS.has(bare)) return true;
  const lower = bare.toLowerCase();
  return EMBED_PATTERNS.some(p => lower.includes(p));
}

/**
 * Build a Map from model string → tier ID, including subscription/CLI model aliases
 * from the model registry. Resolves versioned model names (e.g. claude-opus-4-6-sub)
 * back to their configured tier (e.g. max → claude-opus-sub).
 */
function buildTierModelMap(config: ReturnType<typeof getConfig>): Map<string, string> {
  const tierModelMap = new Map<string, string>();

  // Step 1: Direct config mapping
  for (const t of TIER_META) {
    const m = config.tiers[t.id]?.model;
    if (!m) continue;
    tierModelMap.set(m, t.id);
    const bare = m.includes("/") ? m.split("/").slice(1).join("/") : m;
    if (bare !== m) tierModelMap.set(bare, t.id);
  }

  // Step 2: Register subscription/CLI model aliases from model registry
  const subModels = modelRegistry.getSubscriptionModels();

  // Sort tiers by specificity (longest base prefix first) so versioned variants
  // match the most specific tier, not a generic parent
  const tiersBySpecificity = TIER_META
    .filter(t => config.tiers[t.id]?.model)
    .map(t => {
      const m = config.tiers[t.id]!.model!;
      const bare = m.includes("/") ? m.split("/").slice(1).join("/") : m;
      return { tierId: t.id, bare, basePrefix: bare.replace(/-sub$/, "") };
    })
    .sort((a, b) => b.basePrefix.length - a.basePrefix.length);

  for (const { tierId, bare, basePrefix } of tiersBySpecificity) {
    const baseInfo = modelRegistry.getModel(bare);
    if (!baseInfo) continue;

    // Register codexModelId if present (OpenAI subscription models)
    if (baseInfo.codexModelId && !tierModelMap.has(baseInfo.codexModelId)) {
      tierModelMap.set(baseInfo.codexModelId, tierId);
    }

    // Find variant models in the same provider family by prefix match
    for (const { registryKey, info } of subModels) {
      if (tierModelMap.has(registryKey)) continue;
      if (info.provider !== baseInfo.provider) continue;
      const variantBase = registryKey.replace(/-sub$/, "");
      if (variantBase === basePrefix || variantBase.startsWith(basePrefix + "-")) {
        tierModelMap.set(registryKey, tierId);
        if (info.codexModelId && !tierModelMap.has(info.codexModelId)) {
          tierModelMap.set(info.codexModelId, tierId);
        }
      }
    }
  }

  return tierModelMap;
}

/**
 * Resolve the tier for an inference call by checking the activity routing first
 * (profile → config.routing), then falling back to model-based lookup.
 *
 * Multiple tiers can share the same model (e.g. Max and Advocate both use opus),
 * so model→tier is ambiguous. The profile (activity UUID) is the authoritative signal.
 */
function metadataObject(metadata: unknown): Record<string, unknown> | undefined {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : undefined;
}

function metadataRouting(metadata: unknown): Record<string, unknown> | undefined {
  const meta = metadataObject(metadata);
  const routing = meta?.routing;
  return routing && typeof routing === "object" && !Array.isArray(routing)
    ? routing as Record<string, unknown>
    : undefined;
}

function configuredTierForActivity(metadata: unknown, config: ReturnType<typeof getConfig>): string | undefined {
  const meta = metadataObject(metadata);
  const rawActivity = typeof meta?.activity === "string" ? meta.activity : undefined;
  if (!rawActivity) return undefined;
  const tier = config.routing[rawActivity];
  return tier && tier !== "auto" ? tier : undefined;
}

function displayLabelForId(id: string): string {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function resolveTier(
  profile: string | null | undefined,
  model: string,
  config: ReturnType<typeof getConfig>,
  tierModelMap: Map<string, string>,
  promptActivityMap: Map<string, string>,
  metadata?: unknown,
): string {
  const meta = metadataObject(metadata);
  const metaTier = typeof meta?.tier === "string" ? meta.tier : undefined;
  const routing = metadataRouting(metadata);
  const routingTier = typeof routing?.tier === "string" ? routing.tier : undefined;
  const explicitOverride = profile === "explicit-override" || metaTier === "explicit-override" || routingTier === "explicit-override";

  if (explicitOverride) {
    return configuredTierForActivity(metadata, config) || "explicit-override";
  }

  if (metaTier) return metaTier;
  if (routingTier) return routingTier;

  if (profile) {
    // Profile is typically an activity UUID — check routing directly
    const routedTier = config.routing[profile];
    if (routedTier && routedTier !== "auto") return routedTier;
    // Skill profiles map through promptActivityMap to an activity UUID
    const activityId = promptActivityMap.get(profile) || promptActivityMap.get(profile.split(":")[0]);
    if (activityId) {
      const actTier = config.routing[activityId];
      if (actTier && actTier !== "auto") return actTier;
    }
  }
  // Fallback to model-based lookup (ambiguous when tiers share models, but best effort)
  return tierModelMap.get(model) || (isEmbedModel(model) ? "embed" : "unknown");
}

/**
 * Compute the `since` Date for a given period string, with optional timezone
 * awareness for "today" (defaults to server time when tz is not provided).
 */
function computeSince(period: string | undefined, tz?: string): Date | undefined {
  if (!period || period === "all") return undefined;
  if (period === "1h") return new Date(Date.now() - 60 * 60 * 1000);
  if (period === "7d") { const d = new Date(); d.setDate(d.getDate() - 7); return d; }
  if (period === "30d") { const d = new Date(); d.setDate(d.getDate() - 30); return d; }
  if (period === "today") {
    if (tz) {
      try {
        // Get today's date in the target timezone
        const now = new Date();
        const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
        const dateStr = dateFmt.format(now); // "2026-06-03"
        const [y, m, d] = dateStr.split("-").map(Number);

        // Use noon UTC as reference point to compute tz offset (avoids DST midnight edge cases)
        const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
        const parts = timeFmt.formatToParts(noonUtc);
        const h = parseInt(parts.find(p => p.type === "hour")?.value || "12");
        const min = parseInt(parts.find(p => p.type === "minute")?.value || "0");
        const offsetMin = (h * 60 + min) - 720;

        // midnight in target tz expressed as UTC
        return new Date(Date.UTC(y, m - 1, d, 0, -offsetMin, 0));
      } catch {
        // Invalid timezone — fall through to server-local
      }
    }
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  return undefined;
}

async function buildSkillMaps(): Promise<{ promptActivityMap: Map<string, string>; promptNameMap: Map<string, string> }> {
  const allSkills = await storage.getSkills();
  const promptActivityMap = new Map<string, string>();
  const promptNameMap = new Map<string, string>();
  for (const s of allSkills) {
    const colonId = s.name.replace(/-/g, ":");
    promptActivityMap.set(s.name, s.activity || s.category || "unknown");
    promptActivityMap.set(colonId, s.activity || s.category || "unknown");
    if (s.name) {
      promptNameMap.set(s.name, s.name);
      promptNameMap.set(colonId, s.name);
    }
  }
  return { promptActivityMap, promptNameMap };
}

export async function registerInferenceRoutes(app: Express, serverStartTime: Date) {
  app.get("/api/performance/summary", async (req, res) => {
    try {
      const period = req.query.period as string || "all";
      const since = computeSince(period);
      const summary = await storage.getApiCallSummary(since);
      const byModel = await storage.getApiCallsByModel(since);
      const byDay = await storage.getApiCallsByDay(since);
      const byHour = await storage.getApiCallsByHour(since);
      const byModelByDay = await storage.getApiCallsByModelByDay(since);
      const byModelByHour = await storage.getApiCallsByModelByHour(since);
      const byProfile = await storage.getApiCallsByProfile(since);

      const config = await executorManager.readConfig();
      const modelPrimary = config?.agents?.defaults?.model?.primary || config?.agents?.defaults?.model || "unknown";

      res.json({ summary, byModel, byDay, byHour, byModelByDay, byModelByHour, byProfile, currentModel: modelPrimary });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/performance/tools", async (_req, res) => {
    try {
      const { getToolStats } = await import("../file-storage/tool-stats");
      const tools = getToolStats();
      res.json({ tools });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/performance/calls", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;
      const calls = await storage.getApiCalls(limit, offset);
      const total = await storage.getTotalApiCallCount();
      res.json({ calls, total, limit, offset });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/performance/calls/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const call = await storage.getApiCall(id);
      if (!call) return res.status(404).json({ error: "API call not found" });
      res.json(call);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inference/calls", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const offset = parseInt(req.query.offset as string) || 0;
      const status = req.query.status as string || "all";
      const periodParam = req.query.period as string || undefined;
      const profileFilter = req.query.profile as string | undefined;
      const modelFilter = req.query.model as string | undefined;
      const tz = req.query.tz as string || undefined;

      const since = computeSince(periodParam, tz);

      await initProfiles();
      const config = getConfig();
      const tierModelMap = buildTierModelMap(config);

      const { promptActivityMap, promptNameMap } = await buildSkillMaps();

      const profileDisplayFallback: Record<string, string> = {
        deep_work: "Chat",
        embedding: "Embeddings",
        prioritize: "Prioritize",
        strategic_loop: "Prioritize",
        voice: "Voice",
        chat: "Chat",
        meta_cognition: "Meta-Cognition",
        strategy: "Strategy",
      };

      const profileActivityFallback: Record<string, string> = {};
      for (const a of getAllActivities()) {
        profileActivityFallback[a.id] = a.label;
      }
      profileActivityFallback["deep_work"] = profileActivityFallback[ACTIVITY_CHAT] || "Communication";
      profileActivityFallback["embedding"] = profileActivityFallback[ACTIVITY_MEMORY] || "Memory";
      profileActivityFallback["prioritize"] = profileActivityFallback[ACTIVITY_STRATEGY] || "Strategy";
      profileActivityFallback["strategic_loop"] = profileActivityFallback[ACTIVITY_STRATEGY] || "Strategy";
      profileActivityFallback["voice"] = profileActivityFallback[ACTIVITY_CHAT] || "Communication";

      function resolvePromptName(profile: string): string {
        if (promptNameMap.has(profile)) return promptNameMap.get(profile)!;
        const prefix = profile.split(":")[0];
        if (promptNameMap.has(prefix)) return promptNameMap.get(prefix)!;
        if (profileActivityFallback[profile]) return profileActivityFallback[profile];
        if (profileActivityFallback[prefix]) return profileActivityFallback[prefix];
        if (profileDisplayFallback[profile]) return profileDisplayFallback[profile];
        if (profileDisplayFallback[prefix]) return profileDisplayFallback[prefix];
        return profile.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      }

      function resolveActivityType(profile: string): string {
        let activityId: string | undefined;
        if (promptActivityMap.has(profile)) activityId = promptActivityMap.get(profile)!;
        else {
          const prefix = profile.split(":")[0];
          if (promptActivityMap.has(prefix)) activityId = promptActivityMap.get(prefix)!;
        }
        if (activityId && profileActivityFallback[activityId]) return profileActivityFallback[activityId];
        if (profileActivityFallback[profile]) return profileActivityFallback[profile];
        const prefix = profile.split(":")[0];
        if (profileActivityFallback[prefix]) return profileActivityFallback[prefix];
        return activityId || profile || "unknown";
      }

      let allCalls = await storage.getApiCalls(2000, 0, since);
      const aggregateSummary = await storage.getApiCallSummary(since);

      if (profileFilter) {
        allCalls = allCalls.filter(c => c.profile === profileFilter);
      }
      if (modelFilter) {
        allCalls = allCalls.filter(c => c.model === modelFilter);
      }

      if (status === "complete") {
        allCalls = allCalls.filter(c => {
          const ts = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
          return ts.getTime() >= serverStartTime.getTime();
        });
      } else if (status === "past") {
        allCalls = allCalls.filter(c => {
          const ts = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
          return ts.getTime() < serverStartTime.getTime();
        });
      }

      const total = allCalls.length;
      const sliced = allCalls.slice(offset, offset + limit);

      const enriched = sliced.map(call => {
        const tier = resolveTier(call.profile, call.model, config, tierModelMap, promptActivityMap, call.metadata);
        const profile = call.profile || "unknown";
        const activityType = resolveActivityType(profile);
        const promptName = resolvePromptName(profile);
        const meta = metadataObject(call.metadata);
        return {
          ...call,
          timestamp: call.timestamp instanceof Date ? call.timestamp.toISOString() : call.timestamp,
          tier,
          activityType,
          promptName,
          runId: typeof meta?.runId === "string" ? meta.runId : null,
          requestContent: null as string | null,
          responseContent: null as string | null,
        };
      });

      const sessionKeys = new Set<string>();
      for (const c of enriched) {
        if (c.sessionKey) sessionKeys.add(c.sessionKey);
      }
      const sessionLabels: Record<string, string> = {};
      if (sessionKeys.size > 0) {
        try {
          const convs = await chatFileStorage.getAllSessions();
          for (const conv of convs) {
            const convSessionKey = conv.sessionKey || `dashboard:${conv.id}`;
            if (sessionKeys.has(convSessionKey) && conv.title && !sessionLabels[convSessionKey]) {
              sessionLabels[convSessionKey] = conv.title;
            }
            if (conv.voiceSessionId) {
              const voiceKey = `voice:${conv.voiceSessionId}`;
              if (sessionKeys.has(voiceKey) && conv.title && !sessionLabels[voiceKey]) {
                sessionLabels[voiceKey] = conv.title;
              }
            }
          }
        } catch {}
      }

      res.json({
        calls: enriched,
        total,
        limit,
        offset,
        serverStartTime: serverStartTime.toISOString(),
        sessionLabels,
        aggregateTotalCalls: aggregateSummary.totalCalls,
        aggregateTotalCost: aggregateSummary.totalCost,
        aggregateTotalInputTokens: aggregateSummary.totalInputTokens,
        aggregateTotalOutputTokens: aggregateSummary.totalOutputTokens,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inference/calls/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const call = await storage.getApiCall(id);
      if (!call) return res.status(404).json({ error: "Inference call not found" });

      await initProfiles();
      const config = getConfig();
      const tierModelMap = buildTierModelMap(config);

      const { promptActivityMap, promptNameMap } = await buildSkillMaps();

      const profileDisplayFallback: Record<string, string> = {
        deep_work: "Chat",
        embedding: "Embeddings",
        prioritize: "Prioritize",
        strategic_loop: "Prioritize",
        voice: "Voice",
        chat: "Chat",
        meta_cognition: "Meta-Cognition",
        strategy: "Strategy",
      };

      const profileActivityFallback: Record<string, string> = {};
      for (const a of getAllActivities()) {
        profileActivityFallback[a.id] = a.label;
      }
      profileActivityFallback["deep_work"] = profileActivityFallback[ACTIVITY_CHAT] || "Communication";
      profileActivityFallback["embedding"] = profileActivityFallback[ACTIVITY_MEMORY] || "Memory";
      profileActivityFallback["prioritize"] = profileActivityFallback[ACTIVITY_STRATEGY] || "Strategy";
      profileActivityFallback["strategic_loop"] = profileActivityFallback[ACTIVITY_STRATEGY] || "Strategy";
      profileActivityFallback["voice"] = profileActivityFallback[ACTIVITY_CHAT] || "Communication";

      function resolvePromptName(profile: string): string {
        if (promptNameMap.has(profile)) return promptNameMap.get(profile)!;
        const prefix = profile.split(":")[0];
        if (promptNameMap.has(prefix)) return promptNameMap.get(prefix)!;
        if (profileActivityFallback[profile]) return profileActivityFallback[profile];
        if (profileActivityFallback[prefix]) return profileActivityFallback[prefix];
        if (profileDisplayFallback[profile]) return profileDisplayFallback[profile];
        if (profileDisplayFallback[prefix]) return profileDisplayFallback[prefix];
        return profile.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      }

      const tier = resolveTier(call.profile, call.model, config, tierModelMap, promptActivityMap, call.metadata);
      const profile = call.profile || "unknown";
      const rawActivity = promptActivityMap.get(profile) || promptActivityMap.get(profile.split(":")[0]);
      const activityType = (rawActivity && profileActivityFallback[rawActivity]) || profileActivityFallback[profile] || profileActivityFallback[profile.split(":")[0]] || rawActivity || profile;
      const promptName = resolvePromptName(profile);

      res.json({
        ...call,
        timestamp: call.timestamp instanceof Date ? call.timestamp.toISOString() : call.timestamp,
        tier,
        activityType,
        promptName,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inference/active", async (_req, res) => {
    try {
      const { agentExecutor } = await import("../agent-executor");
      const runs = agentExecutor.getActiveRuns();
      res.json({ activeCount: runs.length, runs });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inference/summary", async (req, res) => {
    try {
      const period = req.query.period as string || "all";
      const groupBy = req.query.groupBy as string || "model";
      const tz = req.query.tz as string || undefined;

      const since = computeSince(period, tz);

      const summary = await storage.getApiCallSummary(since);
      const byModel = await storage.getApiCallsByModel(since);
      const byDay = await storage.getApiCallsByDay(since, tz);
      const byHour = await storage.getApiCallsByHour(since, tz);
      const byProfile = await storage.getApiCallsByProfile(since);

      await initProfiles();
      const config = getConfig();
      const tierModelMap = buildTierModelMap(config);

      const { promptActivityMap, promptNameMap } = await buildSkillMaps();

      const profileDisplayFallback: Record<string, string> = {
        deep_work: "Chat",
        embedding: "Embeddings",
        prioritize: "Prioritize",
        strategic_loop: "Prioritize",
        voice: "Voice",
        chat: "Chat",
        meta_cognition: "Meta-Cognition",
        strategy: "Strategy",
      };

      const profileActivityFallback: Record<string, string> = {};
      for (const a of getAllActivities()) {
        profileActivityFallback[a.id] = a.label;
      }
      profileActivityFallback["deep_work"] = profileActivityFallback[ACTIVITY_CHAT] || "Communication";
      profileActivityFallback["embedding"] = profileActivityFallback[ACTIVITY_MEMORY] || "Memory";
      profileActivityFallback["prioritize"] = profileActivityFallback[ACTIVITY_STRATEGY] || "Strategy";
      profileActivityFallback["strategic_loop"] = profileActivityFallback[ACTIVITY_STRATEGY] || "Strategy";
      profileActivityFallback["voice"] = profileActivityFallback[ACTIVITY_CHAT] || "Communication";

      function resolvePromptName(profile: string): string {
        if (promptNameMap.has(profile)) return promptNameMap.get(profile)!;
        const prefix = profile.split(":")[0];
        if (promptNameMap.has(prefix)) return promptNameMap.get(prefix)!;
        if (profileActivityFallback[profile]) return profileActivityFallback[profile];
        if (profileActivityFallback[prefix]) return profileActivityFallback[prefix];
        if (profileDisplayFallback[profile]) return profileDisplayFallback[profile];
        if (profileDisplayFallback[prefix]) return profileDisplayFallback[prefix];
        return profile.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      }

      function resolveActivity(profile: string): string {
        let activityId: string | undefined;
        if (promptActivityMap.has(profile)) activityId = promptActivityMap.get(profile)!;
        else {
          const prefix = profile.split(":")[0];
          if (promptActivityMap.has(prefix)) activityId = promptActivityMap.get(prefix)!;
        }
        if (activityId && profileActivityFallback[activityId]) return profileActivityFallback[activityId];
        if (profileActivityFallback[profile]) return profileActivityFallback[profile];
        const prefix = profile.split(":")[0];
        if (profileActivityFallback[prefix]) return profileActivityFallback[prefix];
        return activityId || profile || "unknown";
      }

      type TimeBucket = { date?: string; hour?: string; model: string; cost: number; tokens: number; inputTokens: number; outputTokens: number };
      let byModelByDay: TimeBucket[] = (await storage.getApiCallsByModelByDay(since, tz)) as TimeBucket[];
      let byModelByHour: TimeBucket[] = (await storage.getApiCallsByModelByHour(since, tz)) as TimeBucket[];

      // Convert a UTC timestamp to date/hour strings in the user's timezone
      function toLocalDateHour(ts: Date): { date: string; hour: string } {
        if (tz) {
          const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', hour12: false,
          }).formatToParts(ts);
          const y = parts.find(p => p.type === 'year')!.value;
          const m = parts.find(p => p.type === 'month')!.value;
          const d = parts.find(p => p.type === 'day')!.value;
          let h = parts.find(p => p.type === 'hour')!.value.padStart(2, '0');
          if (h === '24') h = '00';
          return { date: `${y}-${m}-${d}`, hour: `${y}-${m}-${d} ${h}:00` };
        }
        return { date: ts.toISOString().slice(0, 10), hour: ts.toISOString().slice(0, 13) + ':00' };
      }

      if (groupBy === "tier") {
        // Fetch individual calls to get profile for proper tier resolution via resolveTier()
        // (model-based lookup is ambiguous when tiers share models)
        const allCalls = await storage.getApiCalls(100000, 0);
        const filteredCalls = since ? allCalls.filter(c => {
          const ts = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
          return ts.getTime() >= since!.getTime();
        }) : allCalls;

        const dayMap = new Map<string, TimeBucket>();
        const hourMap = new Map<string, TimeBucket>();
        for (const c of filteredCalls) {
          const ts = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
          const tier = resolveTier(c.profile, c.model, config, tierModelMap, promptActivityMap, c.metadata);
          const { date, hour } = toLocalDateHour(ts);
          const dayKey = `${date}|${tier}`;
          const hourKey = `${hour}|${tier}`;
          const cTokens = c.totalTokens || 0;
          const cInput = c.inputTokens || 0;
          const cOutput = c.outputTokens || 0;
          const dEntry = dayMap.get(dayKey);
          if (dEntry) { dEntry.cost += c.costTotal || 0; dEntry.tokens += cTokens; dEntry.inputTokens += cInput; dEntry.outputTokens += cOutput; }
          else dayMap.set(dayKey, { date, model: tier, cost: c.costTotal || 0, tokens: cTokens, inputTokens: cInput, outputTokens: cOutput });
          const hEntry = hourMap.get(hourKey);
          if (hEntry) { hEntry.cost += c.costTotal || 0; hEntry.tokens += cTokens; hEntry.inputTokens += cInput; hEntry.outputTokens += cOutput; }
          else hourMap.set(hourKey, { hour, model: tier, cost: c.costTotal || 0, tokens: cTokens, inputTokens: cInput, outputTokens: cOutput });
        }
        byModelByDay = Array.from(dayMap.values());
        byModelByHour = Array.from(hourMap.values());
      } else if (groupBy === "activity") {
        const allCalls = await storage.getApiCalls(10000, 0);
        const filteredCalls = since ? allCalls.filter(c => {
          const ts = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
          return ts.getTime() >= since!.getTime();
        }) : allCalls;

        const dayMap = new Map<string, TimeBucket>();
        const hourMap = new Map<string, TimeBucket>();
        for (const c of filteredCalls) {
          const ts = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
          const profile = c.profile || "unknown";
          const activity = resolveActivity(profile);
          const { date, hour } = toLocalDateHour(ts);
          const dayKey = `${date}|${activity}`;
          const hourKey = `${hour}|${activity}`;
          const cTokens = c.totalTokens || 0;
          const cInput = c.inputTokens || 0;
          const cOutput = c.outputTokens || 0;
          const dEntry = dayMap.get(dayKey);
          if (dEntry) { dEntry.cost += c.costTotal || 0; dEntry.tokens += cTokens; dEntry.inputTokens += cInput; dEntry.outputTokens += cOutput; }
          else dayMap.set(dayKey, { date, model: activity, cost: c.costTotal || 0, tokens: cTokens, inputTokens: cInput, outputTokens: cOutput });
          const hEntry = hourMap.get(hourKey);
          if (hEntry) { hEntry.cost += c.costTotal || 0; hEntry.tokens += cTokens; hEntry.inputTokens += cInput; hEntry.outputTokens += cOutput; }
          else hourMap.set(hourKey, { hour, model: activity, cost: c.costTotal || 0, tokens: cTokens, inputTokens: cInput, outputTokens: cOutput });
        }
        byModelByDay = Array.from(dayMap.values());
        byModelByHour = Array.from(hourMap.values());
      } else if (groupBy === "prompt") {
        const allCalls = await storage.getApiCalls(10000, 0);
        const filteredCalls = since ? allCalls.filter(c => {
          const ts = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
          return ts.getTime() >= since!.getTime();
        }) : allCalls;

        const dayMap = new Map<string, TimeBucket>();
        const hourMap = new Map<string, TimeBucket>();
        for (const c of filteredCalls) {
          const ts = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
          const promptLabel = resolvePromptName(c.profile || "unknown");
          const { date, hour } = toLocalDateHour(ts);
          const dayKey = `${date}|${promptLabel}`;
          const hourKey = `${hour}|${promptLabel}`;
          const cTokens = c.totalTokens || 0;
          const cInput = c.inputTokens || 0;
          const cOutput = c.outputTokens || 0;
          const dEntry = dayMap.get(dayKey);
          if (dEntry) { dEntry.cost += c.costTotal || 0; dEntry.tokens += cTokens; dEntry.inputTokens += cInput; dEntry.outputTokens += cOutput; }
          else dayMap.set(dayKey, { date, model: promptLabel, cost: c.costTotal || 0, tokens: cTokens, inputTokens: cInput, outputTokens: cOutput });
          const hEntry = hourMap.get(hourKey);
          if (hEntry) { hEntry.cost += c.costTotal || 0; hEntry.tokens += cTokens; hEntry.inputTokens += cInput; hEntry.outputTokens += cOutput; }
          else hourMap.set(hourKey, { hour, model: promptLabel, cost: c.costTotal || 0, tokens: cTokens, inputTokens: cInput, outputTokens: cOutput });
        }
        byModelByDay = Array.from(dayMap.values());
        byModelByHour = Array.from(hourMap.values());
      }

      const resolvedByProfileRaw = byProfile.map(p => ({
        ...p,
        name: resolvePromptName(p.profile),
      }));
      const mergedProfileMap = new Map<string, { profile: string; name: string; calls: number; cost: number; tokens: number }>();
      for (const p of resolvedByProfileRaw) {
        const existing = mergedProfileMap.get(p.name);
        if (existing) {
          existing.calls += p.calls;
          existing.cost += p.cost;
          existing.tokens += p.tokens;
        } else {
          mergedProfileMap.set(p.name, { ...p });
        }
      }
      const resolvedByProfile = Array.from(mergedProfileMap.values());

      const modelPrimary = (await executorManager.readConfig())?.agents?.defaults?.model?.primary || "unknown";

      res.json({ summary, byModel, byDay, byHour, byModelByDay, byModelByHour, byProfile: resolvedByProfile, currentModel: modelPrimary, groupBy });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inference/summary/hierarchy", async (req, res) => {
    try {
      const period = req.query.period as string || "all";
      const tz = req.query.tz as string || undefined;

      const since = computeSince(period, tz);

      await initProfiles();
      const config = getConfig();
      const tierModelMap = buildTierModelMap(config);
      const tierLabelMap: Record<string, string> = {};
      for (const t of TIER_META) {
        tierLabelMap[t.id] = t.label;
      }
      tierLabelMap["embed"] = "Embed";
      tierLabelMap["explicit-override"] = "Explicit Override";
      tierLabelMap["unknown"] = "Unknown";

      const { promptActivityMap, promptNameMap } = await buildSkillMaps();

      const profileDisplayFallback: Record<string, string> = {
        deep_work: "Chat", embedding: "Embeddings", prioritize: "Prioritize",
        strategic_loop: "Prioritize", voice: "Voice", chat: "Chat",
        meta_cognition: "Meta-Cognition", strategy: "Strategy",
      };

      const profileActivityFallback: Record<string, string> = {};
      for (const a of getAllActivities()) {
        profileActivityFallback[a.id] = a.label;
      }
      profileActivityFallback["deep_work"] = profileActivityFallback[ACTIVITY_CHAT] || "Communication";
      profileActivityFallback["embedding"] = profileActivityFallback[ACTIVITY_MEMORY] || "Memory";
      profileActivityFallback["prioritize"] = profileActivityFallback[ACTIVITY_STRATEGY] || "Strategy";
      profileActivityFallback["strategic_loop"] = profileActivityFallback[ACTIVITY_STRATEGY] || "Strategy";
      profileActivityFallback["voice"] = profileActivityFallback[ACTIVITY_CHAT] || "Communication";

      function resolvePromptName(profile: string): string {
        if (promptNameMap.has(profile)) return promptNameMap.get(profile)!;
        const prefix = profile.split(":")[0];
        if (promptNameMap.has(prefix)) return promptNameMap.get(prefix)!;
        if (profileActivityFallback[profile]) return profileActivityFallback[profile];
        if (profileActivityFallback[prefix]) return profileActivityFallback[prefix];
        if (profileDisplayFallback[profile]) return profileDisplayFallback[profile];
        if (profileDisplayFallback[prefix]) return profileDisplayFallback[prefix];
        return profile.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      }

      function resolveActivity(profile: string, metadata?: unknown): string {
        const meta = metadataObject(metadata);
        const metaActivity = typeof meta?.activity === "string" ? meta.activity : undefined;
        if (metaActivity && profileActivityFallback[metaActivity]) return profileActivityFallback[metaActivity];

        let activityId: string | undefined;
        if (promptActivityMap.has(profile)) activityId = promptActivityMap.get(profile)!;
        else {
          const prefix = profile.split(":")[0];
          if (promptActivityMap.has(prefix)) activityId = promptActivityMap.get(prefix)!;
        }
        if (activityId && profileActivityFallback[activityId]) return profileActivityFallback[activityId];
        if (profileActivityFallback[profile]) return profileActivityFallback[profile];
        const prefix = profile.split(":")[0];
        if (profileActivityFallback[prefix]) return profileActivityFallback[prefix];
        return activityId || profile || "unknown";
      }

      function resolvePromptNameForCall(profile: string, metadata?: unknown): string {
        const meta = metadataObject(metadata);
        const source = typeof meta?.source === "string" ? meta.source : undefined;
        if (profile === "explicit-override") return source ? displayLabelForId(source) : "Explicit Override";
        return resolvePromptName(profile);
      }

      const filteredCalls = await storage.getApiCalls(100000, 0, since);

      interface CallBucket { id: number; timestamp: string; provider: string; model: string; profile: string | null; inputTokens: number; outputTokens: number; totalTokens: number; costTotal: number; durationMs: number | null; runId: string | null; }
      interface SessionBucket { sessionKey: string; sessionId: number | null; cost: number; calls: number; inputTokens: number; outputTokens: number; callsList: CallBucket[]; }
      interface PromptBucket { prompt: string; cost: number; calls: number; inputTokens: number; outputTokens: number; sessions: Map<string, SessionBucket>; }
      interface ActivityBucket { activity: string; cost: number; calls: number; inputTokens: number; outputTokens: number; prompts: Map<string, PromptBucket>; }
      interface TierBucket { tier: string; tierLabel: string; cost: number; calls: number; inputTokens: number; outputTokens: number; activities: Map<string, ActivityBucket>; }

      const tierMap = new Map<string, TierBucket>();
      const totals = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };

      for (const c of filteredCalls) {
        const tier = resolveTier(c.profile, c.model, config, tierModelMap, promptActivityMap, c.metadata);
        const profile = c.profile || "unknown";
        const activity = resolveActivity(profile, c.metadata);
        const prompt = resolvePromptNameForCall(profile, c.metadata);
        const cost = c.costTotal || 0;
        const inp = c.inputTokens || 0;
        const out = c.outputTokens || 0;

        totals.cost += cost;
        totals.calls += 1;
        totals.inputTokens += inp;
        totals.outputTokens += out;

        if (!tierMap.has(tier)) {
          tierMap.set(tier, { tier, tierLabel: tierLabelMap[tier] || tier, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, activities: new Map() });
        }
        const tb = tierMap.get(tier)!;
        tb.cost += cost;
        tb.calls += 1;
        tb.inputTokens += inp;
        tb.outputTokens += out;

        if (!tb.activities.has(activity)) {
          tb.activities.set(activity, { activity, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, prompts: new Map() });
        }
        const ab = tb.activities.get(activity)!;
        ab.cost += cost;
        ab.calls += 1;
        ab.inputTokens += inp;
        ab.outputTokens += out;

        if (!ab.prompts.has(prompt)) {
          ab.prompts.set(prompt, { prompt, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, sessions: new Map() });
        }
        const pb = ab.prompts.get(prompt)!;
        pb.cost += cost;
        pb.calls += 1;
        pb.inputTokens += inp;
        pb.outputTokens += out;

        const meta = metadataObject(c.metadata);
        const chatSessionId = typeof meta?.sessionId === "string" ? meta.sessionId : undefined;
        const rawSessionKey = c.sessionKey || "unknown";
        const sessionKey = chatSessionId || rawSessionKey;
        if (!pb.sessions.has(sessionKey)) {
          pb.sessions.set(sessionKey, { sessionKey, sessionId: c.sessionId ?? null, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, callsList: [] });
        }
        const sb = pb.sessions.get(sessionKey)!;
        sb.cost += cost;
        sb.calls += 1;
        sb.inputTokens += inp;
        sb.outputTokens += out;
        sb.callsList.push({
          id: c.id,
          timestamp: c.timestamp instanceof Date ? c.timestamp.toISOString() : new Date(c.timestamp).toISOString(),
          provider: c.provider,
          model: c.model,
          profile: c.profile,
          inputTokens: inp,
          outputTokens: out,
          totalTokens: c.totalTokens || inp + out,
          costTotal: cost,
          durationMs: c.durationMs ?? null,
          runId: typeof meta?.runId === "string" ? meta.runId : null,
        });
      }

      // Resolve session titles in bulk via chat file storage
      const allSessionKeys = new Set<string>();
      for (const tb of tierMap.values()) {
        for (const ab of tb.activities.values()) {
          for (const pb of ab.prompts.values()) {
            for (const sb of pb.sessions.values()) {
              if (sb.sessionKey && sb.sessionKey !== "unknown") allSessionKeys.add(sb.sessionKey);
            }
          }
        }
      }
      const sessionInfoMap = new Map<string, { title: string; chatSessionId: string }>();
      if (allSessionKeys.size > 0) {
        try {
          const convs = await chatFileStorage.getAllSessions();
          for (const conv of convs) {
            if (allSessionKeys.has(conv.id) && conv.title && !sessionInfoMap.has(conv.id)) {
              sessionInfoMap.set(conv.id, { title: conv.title, chatSessionId: conv.id });
            }
            const convSessionKey = conv.sessionKey || `dashboard:${conv.id}`;
            // First-write-wins: getAllSessions() returns newest first,
            // so the most recent session title takes precedence for shared keys.
            // This is only a fallback for legacy rows that lack metadata.sessionId.
            if (allSessionKeys.has(convSessionKey) && conv.title && !sessionInfoMap.has(convSessionKey)) {
              sessionInfoMap.set(convSessionKey, { title: conv.title, chatSessionId: conv.id });
            }
            if (conv.voiceSessionId) {
              const voiceKey = `voice:${conv.voiceSessionId}`;
              if (allSessionKeys.has(voiceKey) && conv.title && !sessionInfoMap.has(voiceKey)) {
                sessionInfoMap.set(voiceKey, { title: conv.title, chatSessionId: conv.id });
              }
            }
          }
        } catch { /* session title resolution is best-effort */ }
      }

      const tierOrder = ["max", "high", "balanced", "fast", "explicit-override", "embed", "unknown"];
      const tierRank = (tier: string) => {
        const idx = tierOrder.indexOf(tier);
        return idx === -1 ? tierOrder.length : idx;
      };
      const hierarchy = Array.from(tierMap.values())
        .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))
        .map(t => ({
          tier: t.tier,
          tierLabel: t.tierLabel,
          cost: t.cost,
          calls: t.calls,
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          activities: Array.from(t.activities.values())
            .sort((a, b) => b.cost - a.cost)
            .map(a => ({
              activity: a.activity,
              cost: a.cost,
              calls: a.calls,
              inputTokens: a.inputTokens,
              outputTokens: a.outputTokens,
              prompts: Array.from(a.prompts.values())
                .sort((x, y) => y.cost - x.cost)
                .map(p => ({
                  prompt: p.prompt,
                  cost: p.cost,
                  calls: p.calls,
                  inputTokens: p.inputTokens,
                  outputTokens: p.outputTokens,
                  sessions: Array.from(p.sessions.values())
                    .sort((x, y) => (y.inputTokens + y.outputTokens) - (x.inputTokens + x.outputTokens))
                    .map(s => {
                      const info = sessionInfoMap.get(s.sessionKey);
                      return {
                        sessionKey: s.sessionKey,
                        sessionId: s.sessionId,
                        sessionTitle: info?.title ?? null,
                        chatSessionId: info?.chatSessionId ?? null,
                        cost: s.cost,
                        calls: s.calls,
                        inputTokens: s.inputTokens,
                        outputTokens: s.outputTokens,
                        inferenceCalls: s.callsList
                          .sort((x, y) => new Date(x.timestamp).getTime() - new Date(y.timestamp).getTime()),
                      };
                    }),
                })),
            })),
        }));

      res.json({ hierarchy, totals });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/models/connectors", async (_req, res) => {
    try {
      res.json({ connectors: await listModelConnectors() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/models/connectors/:id", async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid connector id" });
      const body = z.object({
        status: z.enum(["active", "inactive"]).optional(),
        tierMappings: modelTierMappingsSchema.optional(),
      }).parse(req.body);
      const connector = await updateModelConnector(id, body);
      if (!connector) return res.status(404).json({ error: "Model connector not found" });
      res.json({ connector });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.put("/api/models/connectors/order", async (req, res) => {
    try {
      const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1) }).parse(req.body);
      res.json({ connectors: await reorderModelConnectors(ids) });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/models/available", async (_req, res) => {
    try {
      const config = await executorManager.readConfig();

      const providers: Array<{
        id: string;
        name: string;
        models: Array<{
          id: string;
          name: string;
          cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
          contextWindow: number;
          maxTokens: number;
          reasoning: boolean;
          thinkingLevel: "extended" | "basic" | "none";
          thinkingDescription: string;
        }>;
      }> = [];

      const configProviders = config?.models?.providers;
      if (configProviders && typeof configProviders === "object") {
        for (const [providerId, provider] of Object.entries(configProviders as Record<string, any>)) {
          if (!provider?.models || !Array.isArray(provider.models)) continue;
          providers.push({
            id: providerId,
            name: providerId.charAt(0).toUpperCase() + providerId.slice(1),
            models: provider.models.map((m: any) => {
              const thinking = modelRegistry.getThinkingInfo(m.id);
              return {
                id: m.id,
                name: m.name || modelRegistry.getModelName(m.id),
                cost: m.cost?.input != null ? {
                  input: m.cost.input,
                  output: m.cost?.output || 0,
                  cacheRead: m.cost?.cacheRead || 0,
                  cacheWrite: m.cost?.cacheWrite || 0,
                } : modelRegistry.getModelCost(m.id),
                contextWindow: m.contextWindow || modelRegistry.getContextWindow(m.id),
                maxTokens: m.maxTokens || modelRegistry.getMaxOutputTokens(m.id),
                reasoning: m.reasoning || false,
                thinkingLevel: thinking.level,
                thinkingDescription: thinking.description,
                supportsReasoningEffort: thinking.selectableEffort === true,
              };
            }),
          });
        }
      }

      if (providers.length === 0) {
        const anthropicKey = getSecretSync("ANTHROPIC_API_KEY");
        const openaiKey = getSecretSync("OPENAI_API_KEY");
        const defaultProviders = modelRegistry.getDefaultProviderModels();

        if (anthropicKey) {
          const ap = defaultProviders.find(p => p.id === "anthropic");
          if (ap) providers.push(ap);
        }

        if (openaiKey) {
          const op = defaultProviders.find(p => p.id === "openai");
          if (op) providers.push(op);
        }
      }

      // Add OpenAI Subscription models if account is connected.
      // Subscription accounts are system-wide integrations. Use the same system-principal
      // visibility path as /api/openai-subscription/status so user ownership predicates
      // do not hide the configured subscription from this admin model setup page.
      try {
        const { getAccount } = await import("../connected-accounts");
        const openaiSubAccount = await runWithPrincipal(createNamedSystemPrincipal("openai-subscription-check"), () =>
          getAccount("openai-subscription-primary")
        );
        if (openaiSubAccount) {
          const subModels = modelRegistry.getSubscriptionModels()
            .filter(({ info }) => info.provider === "openai-subscription");
          if (subModels.length > 0 && !providers.some(p => p.id === "openai-subscription")) {
            providers.push({
              id: "openai-subscription",
              name: "OpenAI Subscription",
              models: subModels.map(({ info }) => ({
                id: info.id,
                name: info.name,
                cost: info.cost,
                contextWindow: info.contextWindow,
                maxTokens: info.maxOutputTokens,
                reasoning: info.reasoning,
                thinkingLevel: info.thinking.level,
                thinkingDescription: info.thinking.description,
                supportsReasoningEffort: info.thinking.selectableEffort === true,
              })),
            });
          }
        }
      } catch { /* subscription account not available */ }

      if (getSecretSync("CLAUDE_CODE_OAUTH_TOKEN")) {
        const cliSubModels = modelRegistry.getSubscriptionModels()
          .filter(({ info }) => info.provider === "claude-cli");
        if (cliSubModels.length > 0) {
          providers.push({
            id: "claude-cli",
            name: "Claude Subscription",
            models: cliSubModels.map(({ info }) => ({
              id: info.id,
              name: info.name,
              cost: info.cost,
              contextWindow: info.contextWindow,
              maxTokens: info.maxOutputTokens,
              reasoning: info.reasoning,
              thinkingLevel: info.thinking.level,
              thinkingDescription: info.thinking.description,
              supportsReasoningEffort: info.thinking.selectableEffort === true,
            })),
          });
        }
      }

      const currentModel = config?.agents?.defaults?.model?.primary
        || (typeof config?.agents?.defaults?.model === "string" ? config.agents.defaults.model : null)
        || "unknown";

      await initProfiles();
      const tierConfig = getConfig();
      res.json({
        providers,
        currentModel,
        tiers: TIER_META.map(t => ({
          ...t,
          model: tierConfig.tiers[t.id]?.model || null,
        })),
        routing: ACTIVITY_META.map(a => ({
          ...a,
          tier: tierConfig.routing[a.id],
        })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const setModelSchema = z.object({
    provider: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
    model: z.string().min(1).regex(/^[a-zA-Z0-9_.\-/]+$/),
  });

  app.post("/api/models/select", async (req, res) => {
    try {
      const parsed = setModelSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Provider and model are required" });
      }
      const { provider, model } = parsed.data;
      const modelPrimary = `${provider}/${model}`;

      await setTierModel("high", modelPrimary);

      const status = await executorManager.getStatus();
      if (status.status === "running") {
        try { await executorManager.restart(); } catch (err) { log.warn("executor restart after model change failed", err); }
      }

      res.json({ message: `Model set to ${modelPrimary}`, model: modelPrimary });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/models/tiers", async (_req, res) => {
    try {
      await initProfiles();
      const config = getConfig();
      const allActivities = getAllActivities();
      res.json({
        tiers: TIER_META.map(t => {
          const tc = config.tiers[t.id];
          const thinking = tc?.thinking ?? thinkingBudgetToTier(tc?.thinkingBudget);
          return {
            ...t,
            model: tc?.model || null,
            thinkingBudget: tierToThinkingBudget(thinking),
            thinking,
          };
        }),
        routingConfig: getModelProfilesVersion(),
        routing: allActivities.map(a => ({
          ...a,
          tier: config.routing[a.id] || "balanced",
          isBuiltin: BUILTIN_ACTIVITY_IDS.includes(a.id),
        })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const thinkingTierSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("disabled") }),
    z.object({ type: z.literal("enabled"), budgetTokens: z.number().int().min(1).max(128000) }),
    z.object({ type: z.literal("adaptive"), effort: z.enum(["low", "medium", "high", "max"]).optional() }),
  ]);

  const setTierSchema = z.object({
    tierId: z.enum(["max", "high", "balanced", "fast"]),
    model: z.string().min(1),
    thinkingBudget: z.number().int().min(0).optional(),
    thinking: thinkingTierSchema.optional(),
  });

  const buildTiersResponse = () => {
    const config = getConfig();
    return TIER_META.map(t => {
      const tc = config.tiers[t.id];
      const thinking = tc?.thinking ?? thinkingBudgetToTier(tc?.thinkingBudget);
      return {
        ...t,
        model: tc?.model || null,
        thinkingBudget: tierToThinkingBudget(thinking),
        thinking,
      };
    });
  };

  app.post("/api/models/tiers", async (req, res) => {
    try {
      await initProfiles();
      const parsed = setTierSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Valid tierId (max, high, balanced, fast, advocate, advisary) and model are required" });
      }
      const thinkingArg: ThinkingTierConfig | number | undefined =
        parsed.data.thinking ?? parsed.data.thinkingBudget;
      await setTierModel(parsed.data.tierId, parsed.data.model, thinkingArg);
      invalidateModelProfilesCache("models-tier-update");
      await initProfiles();
      res.json({ message: `${parsed.data.tierId} tier updated`, tiers: buildTiersResponse(), routingConfig: getModelProfilesVersion() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const setThinkingBudgetSchema = z.object({
    tierId: z.enum(["max", "high", "balanced", "fast"]),
    thinkingBudget: z.number().int().min(0).max(128000).optional(),
    thinking: thinkingTierSchema.optional(),
  }).refine((d) => d.thinkingBudget !== undefined || d.thinking !== undefined, {
    message: "Provide either `thinking` or `thinkingBudget`",
  });

  app.patch("/api/models/tiers/thinking-budget", async (req, res) => {
    try {
      await initProfiles();
      const parsed = setThinkingBudgetSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Provide tierId and either `thinking` or `thinkingBudget` (0-128000)" });
      }
      if (parsed.data.thinking) {
        await setTierThinking(parsed.data.tierId, parsed.data.thinking);
      } else if (parsed.data.thinkingBudget !== undefined) {
        await setTierThinkingBudget(parsed.data.tierId, parsed.data.thinkingBudget);
      }
      invalidateModelProfilesCache("models-tier-thinking-update");
      await initProfiles();
      res.json({ message: `${parsed.data.tierId} thinking config updated`, tiers: buildTiersResponse(), routingConfig: getModelProfilesVersion() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const setRoutingSchema = z.object({
    activityId: z.string().min(1),
    tier: z.enum(["max", "high", "balanced", "fast", "auto"]),
  });

  app.post("/api/models/routing", async (req, res) => {
    try {
      await initProfiles();
      const parsed = setRoutingSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Valid activityId and tier are required" });
      }
      await setActivityRouting(parsed.data.activityId as ActivityId, parsed.data.tier as RoutingTier);
      invalidateModelProfilesCache("models-routing-update");
      await initProfiles();
      const config = getConfig();
      const allActivities = getAllActivities();
      res.json({
        message: `${parsed.data.activityId} routing updated`,
        routing: allActivities.map(a => ({
          ...a,
          tier: config.routing[a.id] || "balanced",
          isBuiltin: BUILTIN_ACTIVITY_IDS.includes(a.id),
        })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/models/activities", async (_req, res) => {
    try {
      await initProfiles();
      const allActivities = getAllActivities();
      const config = getConfig();
      res.json(allActivities.map(a => {
        const tier = config.routing[a.id] || "balanced";
        const modelId = getModelForActivity(a.id as any);
        return {
          ...a,
          tier,
          isBuiltin: BUILTIN_ACTIVITY_IDS.includes(a.id),
          model: modelId,
          contextWindow: modelRegistry.getContextWindow(modelId),
          maxOutputTokens: modelRegistry.getMaxOutputTokens(modelId),
        };
      }));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/models/activities", async (req, res) => {
    try {
      const { id, label, description } = req.body;
      if (!id || !label) return res.status(400).json({ error: "id and label are required" });
      const cleanId = id.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      await addCustomActivity(cleanId, label, description || "");
      invalidateModelProfilesCache("models-activity-create");
      await initProfiles();
      res.json({ success: true, id: cleanId, routingConfig: getModelProfilesVersion() });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/models/activities/:id", async (req, res) => {
    try {
      const { label, description } = req.body;
      if (!label) return res.status(400).json({ error: "label is required" });
      await updateActivityMeta(req.params.id, label, description || "");
      invalidateModelProfilesCache("models-activity-update");
      await initProfiles();
      res.json({ success: true, routingConfig: getModelProfilesVersion() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/models/activities/:id", async (req, res) => {
    try {
      await removeCustomActivity(req.params.id);
      invalidateModelProfilesCache("models-activity-delete");
      await initProfiles();
      res.json({ success: true, routingConfig: getModelProfilesVersion() });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Inference debug setting — controls whether full request/response content is stored to S3
  app.get("/api/settings/inference-debug", async (_req, res) => {
    try {
      const enabled = await getSetting<boolean>(INFERENCE_DEBUG_KEY);
      res.json({ enabled: enabled ?? false });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/settings/inference-debug", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }
      await setSetting(INFERENCE_DEBUG_KEY, enabled);
      log.log(`Inference debug ${enabled ? "enabled" : "disabled"}`);
      res.json({ enabled });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

}
