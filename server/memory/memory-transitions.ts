import { memoryStorage, computeContentHash } from "./memory-storage";
import { chatCompletion } from "../model-client";
import { ACTIVITY_MEMORY } from "../job-profiles";
import { getPromptModulePrompt } from "../prompt-modules";
import type { MemoryEntry } from "@shared/schema";
import { contextBuilder } from "../context-builder";
import { createLogger } from "../log";
import { extractJson } from "../utils/extract-json";
import { sql } from "drizzle-orm";

const log = createLogger("MemoryTransitions");

export const MEMORY_THRESHOLDS = {
  SHORT_TERM_MAX: 50,
  MID_TERM_MAX: 30,
  SHORT_ENTRIES_IN_CONTEXT: 15,
  MID_ENTRIES_IN_CONTEXT: 10,
  CONTEXT_TOKEN_BUDGET: 2000,
  COMPRESSION_GROUP_SIZE: 20,
};

const SHORT_TERM_THRESHOLD = MEMORY_THRESHOLDS.SHORT_TERM_MAX;
const MID_TERM_THRESHOLD = MEMORY_THRESHOLDS.MID_TERM_MAX;

export async function checkThresholds(): Promise<{ shortCount: number; midCount: number; shouldCompressShort: boolean; shouldConsolidateMid: boolean }> {
  const stats = await memoryStorage.getStats();
  return {
    shortCount: stats.short,
    midCount: stats.mid,
    shouldCompressShort: stats.short >= SHORT_TERM_THRESHOLD,
    shouldConsolidateMid: stats.mid >= MID_TERM_THRESHOLD,
  };
}

const MERGE_CANDIDATE_THRESHOLD = 0.2;

export async function tryMergeWithExistingMid(
  newEntry: MemoryEntry
): Promise<{ merged: boolean; targetId?: number; title?: string }> {
  if (newEntry.layer !== "mid") return { merged: false };
  if (newEntry.source === "conversation") return { merged: false };
  const newTags = newEntry.tags || [];
  if (newTags.length === 0) return { merged: false };

  const rawCandidates = await memoryStorage.findSimilarEntries(newEntry.id, 5, {
    layers: ["mid"],
    skipLinkedFilter: true,
  });

  if (rawCandidates.length === 0) {
    log.log(`merge-on-promote: no similar mid-term candidates for #${newEntry.id} "${newEntry.title || '?'}"`);
    return { merged: false };
  }

  const best = rawCandidates[0];
  log.log(`merge-on-promote: top candidate #${best.entry.id} "${best.entry.title || '?'}" (hybrid=${best.hybridScore.toFixed(3)}, tag=${best.tagSim.toFixed(3)}, emb=${best.embeddingSim.toFixed(3)}, title=${best.titleSim.toFixed(1)}) for new #${newEntry.id} "${newEntry.title || '?'}"`);

  if (best.hybridScore < MERGE_CANDIDATE_THRESHOLD) {
    log.log(`merge-on-promote: best score ${best.hybridScore.toFixed(3)} below threshold ${MERGE_CANDIDATE_THRESHOLD} for #${newEntry.id}`);
    return { merged: false };
  }

  try {
    const mergeSpine = await contextBuilder.resolve({ callType: 'internal', llmMode: 'text' });
    const mergeContext = contextBuilder.renderToPrompt(mergeSpine);
    const mergeSystemPrompt = await getPromptModulePrompt("myelination-mid-merge");
    const mergeMessages = [
      {
        role: "system" as const,
        content: mergeContext ? `${mergeContext}\n\n${mergeSystemPrompt}` : mergeSystemPrompt,
      },
      {
        role: "user" as const,
        content: `Entry A (existing #${best.entry.id}):
Title: ${best.entry.title || "Untitled"}
Summary: ${best.entry.summary || best.entry.content}
Tags: ${(best.entry.tags || []).join(", ")}

Entry B (new #${newEntry.id}):
Title: ${newEntry.title || "Untitled"}
Summary: ${newEntry.summary || newEntry.content}
Tags: ${newTags.join(", ")}

Should these be merged or kept separate?`,
      },
    ];
    const result = await chatCompletion({
      activity: ACTIVITY_MEMORY,
      metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
      maxTokens: 1000,
      messages: mergeMessages,
    temperature: 0.2,
      jsonMode: true,
    });

    const parsed = JSON.parse(extractJson(result.content));

    if (parsed.action === "merge") {
      log.log(`merge-on-promote: LLM decided to merge #${newEntry.id} into #${best.entry.id} — title="${parsed.title}"`);

      let mergedContent: string;
      try {
        const consolidateSpine = await contextBuilder.resolve({ callType: 'internal', llmMode: 'text' });
        const consolidateContext = contextBuilder.renderToPrompt(consolidateSpine);
        const consolidateSystemPrompt = await getPromptModulePrompt("myelination-mid-merge-consolidate");
        const consolidateStart = Date.now();
        const consolidateMessages = [
          {
            role: "system" as const,
            content: consolidateContext ? `${consolidateContext}\n\n${consolidateSystemPrompt}` : consolidateSystemPrompt,
          },
          {
            role: "user" as const,
            content: `Entry A:\n${best.entry.content}\n\nEntry B:\n${newEntry.content}`,
          },
        ];
        const consolidateResult = await chatCompletion({
          activity: ACTIVITY_MEMORY,
          metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
          maxTokens: 4000,
          messages: consolidateMessages,
    temperature: 0.2,
        });
        mergedContent = consolidateResult.content.trim();
        log.log(`merge-on-promote: consolidated content (${mergedContent.length} chars) from ${best.entry.content.length} + ${newEntry.content.length} chars`);
      } catch (consolidateErr: unknown) {
        const errMsg = consolidateErr instanceof Error ? consolidateErr.message : String(consolidateErr);
        log.error(`merge-on-promote: consolidation failed, falling back to append: ${errMsg}`);
        mergedContent = `${best.entry.content}\n\n---\n\n${newEntry.content}`;
      }

      const mergedHash = computeContentHash(mergedContent);

      const { generateTitleSummaryTags } = await import("./memory-enrichment");
      const { title: newTitle, oneLiner: mergeOneLiner, summary: newSummary, tags: newMergedTags } = await generateTitleSummaryTags({
        content: mergedContent,
        source: best.entry.source,
        title: undefined,
      });

      const { db } = await import("../db");
      const { memoryEntries, memoryContentBlocks, memoryLinks, memoryEvents: memoryEventsTable } = await import("@shared/schema");
      const { eq, or } = await import("drizzle-orm");

      await db.transaction(async (tx) => {
        const freshTarget = await tx
          .select({ id: memoryEntries.id })
          .from(memoryEntries)
          .where(eq(memoryEntries.id, best.entry.id))
          .limit(1);
        if (freshTarget.length === 0) {
          log.log(`merge-on-promote: target #${best.entry.id} no longer exists — aborting merge`);
          return;
        }

        const existingBlocks = await tx
          .select({ maxOrd: sql`COALESCE(MAX(ordinal), -1)` })
          .from(memoryContentBlocks)
          .where(eq(memoryContentBlocks.entryId, best.entry.id));
        const startOrd = (Number(existingBlocks[0]?.maxOrd) ?? -1) + 1;

        await tx.insert(memoryContentBlocks).values({
          entryId: best.entry.id,
          content: best.entry.content,
          role: "original",
          ordinal: startOrd,
        });
        await tx.insert(memoryContentBlocks).values({
          entryId: best.entry.id,
          content: newEntry.content,
          role: "merged",
          ordinal: startOrd + 1,
        });

        const setData: Record<string, unknown> = {
          content: mergedContent,
          summary: newSummary,
          contentHash: mergedHash,
          processedAt: new Date(),
        };
        if (newTitle) setData.title = newTitle;
        if (mergeOneLiner) setData.oneLiner = mergeOneLiner;
        if (newMergedTags && newMergedTags.length > 0) setData.tags = newMergedTags;

        await tx.update(memoryEntries)
          .set(setData)
          .where(eq(memoryEntries.id, best.entry.id));

        const existingLinks = await tx.select().from(memoryLinks)
          .where(or(eq(memoryLinks.fromId, best.entry.id), eq(memoryLinks.toId, best.entry.id)));
        const existingPairs = new Set(existingLinks.map(l => `${l.fromId}-${l.toId}`));

        const linksFrom = await tx.select().from(memoryLinks).where(eq(memoryLinks.fromId, newEntry.id));
        const linksTo = await tx.select().from(memoryLinks).where(eq(memoryLinks.toId, newEntry.id));

        for (const link of linksFrom) {
          const newFrom = best.entry.id;
          const newTo = link.toId === newEntry.id ? best.entry.id : link.toId;
          if (newFrom === newTo) continue;
          if (existingPairs.has(`${newFrom}-${newTo}`)) continue;
          await tx.update(memoryLinks).set({ fromId: newFrom }).where(eq(memoryLinks.id, link.id));
          existingPairs.add(`${newFrom}-${newTo}`);
        }
        for (const link of linksTo) {
          const newTo = best.entry.id;
          const newFrom = link.fromId === newEntry.id ? best.entry.id : link.fromId;
          if (newFrom === newTo) continue;
          if (existingPairs.has(`${newFrom}-${newTo}`)) continue;
          await tx.update(memoryLinks).set({ toId: newTo }).where(eq(memoryLinks.id, link.id));
          existingPairs.add(`${newFrom}-${newTo}`);
        }

        await tx.insert(memoryEventsTable).values({
          entryId: best.entry.id,
          eventType: "merged",
          details: { mergedFrom: newEntry.id, mergedTitle: newEntry.title },
        });

        await tx.insert(memoryEventsTable).values({
          entryId: newEntry.id,
          eventType: "deleted",
          details: {},
        });
        await tx.delete(memoryEntries).where(eq(memoryEntries.id, newEntry.id));
      });

      log.log(`merge-on-promote: merged #${newEntry.id} into #${best.entry.id} (links transferred), deleted #${newEntry.id}, final title="${newTitle}"`);
      return { merged: true, targetId: best.entry.id, title: newTitle };
    } else {
      log.log(`merge-on-promote: LLM decided to keep #${newEntry.id} separate from #${best.entry.id}`);
      return { merged: false };
    }
  } catch (err: unknown) {
    const errDetail = err instanceof Error ? (err.stack || err.message) : String(err);
    log.error(`merge-on-promote: error during merge decision: ${errDetail}`);
    return { merged: false };
  }
}
