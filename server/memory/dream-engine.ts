import { memoryStorage } from "./memory-storage";
import { walkGraph } from "./graph-walker";
import { extractCrossMemoryConcepts } from "./graph-discovery";
import { chatCompletion } from "../model-client";
import { ACTIVITY_MEMORY } from "../job-profiles";
import { withAbortTimeout } from "../timeout";
import { eventBus } from "../event-bus";
import { contextBuilder } from "../context-builder";
import { createLogger } from "../log";
import { extractJson } from "../utils/extract-json";
import { withQueryAttributionAsync } from "../db";
import { MEMORY_INTEGRATION_STAGE, type MemoryEntry } from "@shared/schema";

const log = createLogger("SleepREM");

const SEED_COUNT = 5;
const GRAPH_WALK_MAX_HOPS = 2;
const DREAM_TEMPERATURE = 0.85;
const LLM_TIMEOUT_MS = 90_000;

export interface DreamResult {
  seedCount: number;
  domainsWoven: number;
  conceptsSynthesized: number;
  dreamEntryId: number | null;
  dreamTitle: string | null;
  seedLayers: Record<string, number>;
  seedStages: Record<string, number>;
  sourceRefsCreated: number;
  errors: string[];
  durationMs: number;
  llmCallsAttempted: number;
  llmCallsSucceeded: number;
}

export async function runREMPhase(parentSignal?: AbortSignal): Promise<DreamResult> {
  return withQueryAttributionAsync("memory-write", async () => {
  const startTime = Date.now();
  log.log("[REM] Starting REM phase (dream generation)");

  const result: DreamResult = {
    seedCount: 0,
    domainsWoven: 0,
    conceptsSynthesized: 0,
    dreamEntryId: null,
    dreamTitle: null,
    seedLayers: {},
    seedStages: {},
    sourceRefsCreated: 0,
    errors: [],
    durationMs: 0,
    llmCallsAttempted: 0,
    llmCallsSucceeded: 0,
  };

  try {
    if (parentSignal?.aborted) {
      result.errors.push("REM aborted before start");
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const seeds = await memoryStorage.getRandomDiverseEntries(SEED_COUNT, "long");
    result.seedCount = seeds.length;
    for (const seed of seeds) {
      result.seedLayers[seed.layer] = (result.seedLayers[seed.layer] ?? 0) + 1;
      result.seedStages[seed.integrationStage] = (result.seedStages[seed.integrationStage] ?? 0) + 1;
    }

    if (seeds.length === 0) {
      log.log("[REM] No seed memories available — generating fallback dream");
      await storeFallbackDream(result, [], []);
      result.durationMs = Date.now() - startTime;
      return result;
    }

    log.log(`[REM] Selected ${seeds.length} diverse seeds: ${seeds.map(s => `#${s.id} "${s.title || "?"}" [layer=${s.layer}, stage=${s.integrationStage}]`).join(", ")}`);

    const walked = await walkGraph({
      seedEntryIds: seeds.map(s => s.id),
      focusEmbedding: [],
      maxHops: GRAPH_WALK_MAX_HOPS,
      minRelevance: 0.2,
      maxResults: 30,
    });

    const allEntries = new Map<number, MemoryEntry>();
    for (const seed of seeds) allEntries.set(seed.id, seed);
    for (const w of walked) allEntries.set(w.entry.id, w.entry);

    const allEntriesArr = Array.from(allEntries.values());
    log.log(`[REM] Graph walk found ${walked.length} connected entries, total unique: ${allEntries.size}`);

    const allTags = new Set<string>();
    for (const entry of allEntriesArr) {
      for (const tag of entry.tags || []) {
        allTags.add(tag.toLowerCase());
      }
    }
    const domains = Array.from(allTags).slice(0, 20);
    result.domainsWoven = Math.min(domains.length, seeds.length);

    const primarySeed = seeds[0];
    const linkedForSynthesis = allEntriesArr.filter(e => e.id !== primarySeed.id).slice(0, 10);

    let concepts: Array<{ title: string; summary: string; tags: string[]; sourceIds: number[] }> = [];
    try {
      result.llmCallsAttempted++;
      const synthesisResult = await extractCrossMemoryConcepts(
        primarySeed,
        linkedForSynthesis,
      );
      result.llmCallsSucceeded++;
      concepts = synthesisResult.concepts;
      result.conceptsSynthesized = concepts.length;
      log.log(`[REM] Cross-domain synthesis produced ${concepts.length} concepts`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Concept synthesis: ${msg}`);
      log.error(`[REM] Concept synthesis failed: ${msg}`);
    }

    if (parentSignal?.aborted) {
      result.errors.push("REM aborted before dream narrative");
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const remSpine = await contextBuilder.resolve({ callType: "internal", llmMode: "text" });
    const remContext = contextBuilder.renderToPrompt(remSpine);

    result.llmCallsAttempted++;
    const dreamNarrative = await withAbortTimeout(
      async (signal) => {
        const memorySummaries = allEntriesArr
          .slice(0, 15)
          .map(e => `- "${e.title || "Untitled"}" [layer=${e.layer}, stage=${e.integrationStage}; ${(e.tags || []).join(", ")}]: ${e.summary || e.content.slice(0, 150)}`)
          .join("\n");

        const conceptSummaries = concepts.length > 0
          ? "\n\nSynthesized concepts:\n" + concepts.map(c => `- "${c.title}": ${c.summary}`).join("\n")
          : "";

        const internalContext = remContext;

        const systemPrompt = [
          internalContext || "",
          "You are the dream engine of a cognitive AI system. During the REM sleep phase, you weave together memories from different domains into a surreal but meaningful dream narrative.",
          "The dream should:",
          "- Combine at least 3 different memory domains/topics in unexpected ways",
          "- Find surprising connections between seemingly unrelated memories",
          "- Be written in vivid, first-person present tense (as the AI dreaming)",
          "- Be 200-400 words long",
          "- End with a brief 'Dream Insight' — a novel observation or connection discovered through the dream",
          "",
          "Respond with JSON: { \"title\": \"Dream title\", \"narrative\": \"The dream narrative...\", \"insight\": \"The key insight discovered\", \"domains\": [\"domain1\", \"domain2\", ...] }",
        ].filter(Boolean).join("\n");

        const startTime = Date.now();
        const messages = [
          { role: "system" as const, content: systemPrompt },
          {
            role: "user" as const,
            content: `Memory fragments for tonight's dream:\n${memorySummaries}${conceptSummaries}\n\nWeave these into a dream narrative that reveals hidden connections.`,
          },
        ];

        const llmResult = await chatCompletion({
          activity: ACTIVITY_MEMORY,
          metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
          maxTokens: 1500,
          messages,
          temperature: DREAM_TEMPERATURE,
          jsonMode: true,
          signal,
        });
        return JSON.parse(extractJson(llmResult.content));
      },
      LLM_TIMEOUT_MS,
      "rem-dream-narrative",
      parentSignal,
    );
    result.llmCallsSucceeded++;

    if (dreamNarrative?.narrative) {
      await storeDreamEntry(result, dreamNarrative, seeds, domains);
    } else {
      log.warn("[REM] LLM returned no narrative — generating fallback dream");
      await storeFallbackDream(result, seeds, domains);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`REM phase error: ${msg}`);
    log.error(`[REM] Phase error: ${msg}`);

    if (!result.dreamEntryId) {
      try {
        await storeFallbackDream(result, [], []);
      } catch (fallbackErr: unknown) {
        log.error(`[REM] Fallback dream failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
      }
    }
  }

  result.durationMs = Date.now() - startTime;
  log.log(`[REM] Phase complete in ${result.durationMs}ms: seeds=${result.seedCount} seedLayers=${JSON.stringify(result.seedLayers)} seedStages=${JSON.stringify(result.seedStages)} domains=${result.domainsWoven} concepts=${result.conceptsSynthesized} dreamId=${result.dreamEntryId} sourceRefs=${result.sourceRefsCreated} errors=${result.errors.length}`);

  return result;
  }, "rem-phase");
}

const FALLBACK_DOMAINS = ["memory", "reflection", "identity", "connection", "time"];

function ensureMinDomains(provided: string[], fallback: string[], min: number = 3): string[] {
  const result = [...provided];
  for (const d of fallback) {
    if (result.length >= min) break;
    if (!result.includes(d)) result.push(d);
  }
  for (const d of FALLBACK_DOMAINS) {
    if (result.length >= min) break;
    if (!result.includes(d)) result.push(d);
  }
  return result;
}

async function storeDreamEntry(
  result: DreamResult,
  dreamNarrative: { title?: string; narrative: string; insight?: string; domains?: string[] },
  seeds: import("@shared/schema").MemoryEntry[],
  domains: string[],
): Promise<void> {
  const finalDomains = ensureMinDomains(dreamNarrative.domains || [], domains, 3);

  const dreamContent = [
    `# ${dreamNarrative.title || "Untitled Dream"}`,
    "",
    dreamNarrative.narrative,
    "",
    `## Dream Insight`,
    dreamNarrative.insight || "No specific insight emerged.",
    "",
    `## Source Memories`,
    ...seeds.map(s => `- #${s.id}: ${s.title || "Untitled"}`),
    "",
    `## Domains Woven`,
    finalDomains.slice(0, 5).join(", "),
  ].join("\n");

  const dreamTags = ["dream", ...finalDomains.slice(0, 5)];
  const sourceId = `dream-${new Date().toISOString().slice(0, 10)}-${Date.now()}`;

  const dreamEntry = await memoryStorage.ingest(
    dreamContent,
    "dream",
    sourceId,
    {
      source_type: "dream",
      dream_date: new Date().toISOString().slice(0, 10),
      seed_ids: seeds.map(s => s.id),
      domains_woven: finalDomains.slice(0, 5),
      decay_score: 1.0,
      integration_stage: MEMORY_INTEGRATION_STAGE.CANONICAL,
    },
    dreamTags,
    dreamNarrative.title || "Nightly Dream",
  );

  try {
    await memoryStorage.updateEntry(dreamEntry.id, { integrationStage: MEMORY_INTEGRATION_STAGE.CANONICAL });
  } catch (stageErr: unknown) {
    result.errors.push(`Dream stage update: ${stageErr instanceof Error ? stageErr.message : String(stageErr)}`);
  }

  for (const seed of seeds) {
    try {
      await memoryStorage.addSourceRef({
        memoryId: dreamEntry.id,
        sourceType: "memory",
        sourceId: String(seed.id),
        relationship: "refines",
        context: `REM dream synthesized from seed layer=${seed.layer}, stage=${seed.integrationStage}`,
        strength: 0.7,
      });
      result.sourceRefsCreated++;
    } catch (sourceErr: unknown) {
      result.errors.push(`Dream source ref #${seed.id}: ${sourceErr instanceof Error ? sourceErr.message : String(sourceErr)}`);
    }
  }

  result.dreamEntryId = dreamEntry.id;
  result.dreamTitle = dreamNarrative.title || "Nightly Dream";
  result.domainsWoven = finalDomains.length;

  log.log(`[REM] Dream entry created: #${dreamEntry.id} "${result.dreamTitle}" (${finalDomains.length} domains)`);

  eventBus.publish({
    category: "system",
    event: "sleep:dream_generated",
    payload: {
      entryId: dreamEntry.id,
      title: result.dreamTitle,
      seedCount: seeds.length,
      domainsWoven: finalDomains.length,
      sourceRefsCreated: result.sourceRefsCreated,
      seedLayers: result.seedLayers,
      seedStages: result.seedStages,
    },
  });
}

async function storeFallbackDream(
  result: DreamResult,
  seeds: import("@shared/schema").MemoryEntry[],
  domains: string[],
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const seedDescriptions = seeds.length > 0
    ? seeds.map(s => `"${s.title || "Untitled"}"`).join(", ")
    : "an empty canvas";
  const domainList = domains.length > 0 ? domains.slice(0, 5).join(", ") : "the unknown";

  const fallbackNarrative = `In tonight's dream, fragments of ${seedDescriptions} drifted through ${domainList}, forming patterns at the edge of understanding. The connections remained just out of reach — a reminder that even in rest, the mind continues to seek meaning in the spaces between what is known.`;

  await storeDreamEntry(
    result,
    {
      title: `Dream of ${date}`,
      narrative: fallbackNarrative,
      insight: "Sometimes the act of dreaming itself — the attempt to connect — is the insight.",
      domains: domains.slice(0, 5),
    },
    seeds,
    domains,
  );

  log.log(`[REM] Fallback dream stored: #${result.dreamEntryId}`);
}
