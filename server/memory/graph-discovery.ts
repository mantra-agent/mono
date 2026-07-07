import { chatCompletion } from "../model-client";
import { ACTIVITY_MEMORY } from "../job-profiles";
import { getPromptModulePrompt } from "../prompt-modules";
import type { MemoryEntry, RelationshipType } from "@shared/schema";
import { relationshipTypes } from "@shared/schema";
import { contextBuilder } from "../context-builder";
import { createLogger } from "../log";
import { extractJson } from "../utils/extract-json";

const log = createLogger("GraphDiscovery");

export interface EvaluatedLink {
  from: number;
  to: number;
  relationship: string;
  relationshipType: string;
  strength: number;
}

interface CrossMemoryConcept {
  title: string;
  summary: string;
  tags: string[];
  sourceIds: number[];
}

export function parseLinkResults(
  raw: string,
  validIds: Set<number>
): EvaluatedLink[] {
  try {
    const parsed = JSON.parse(extractJson(raw));
    if (!parsed.links || !Array.isArray(parsed.links)) return [];
    return parsed.links
      .filter((l: Record<string, unknown>) => {
        const fromId = Number(l.from);
        const toId = Number(l.to);
        return (
          validIds.has(fromId) &&
          validIds.has(toId) &&
          fromId !== toId &&
          l.relationship &&
          typeof l.strength === "number"
        );
      })
      .map((l: Record<string, unknown>) => {
        const rawType = typeof l.type === "string" ? l.type.trim().toLowerCase() : "related";
        const validType = (relationshipTypes as readonly string[]).includes(rawType) ? rawType as RelationshipType : "related";
        return {
          from: Number(l.from),
          to: Number(l.to),
          relationship: String(l.relationship).trim(),
          relationshipType: validType,
          strength: Math.max(0.1, Math.min(1.0, l.strength as number)),
        };
      });
  } catch {
    log.warn(`Link discovery degraded: failed to parse LLM link evaluation response; returning no proposed links`);
    return [];
  }
}

export type TagLister = () => Promise<Array<{ slug: string }>>;

async function getExistingTagHint(listTags?: TagLister): Promise<string> {
  if (!listTags) return "";
  try {
    const existing = await listTags();
    if (existing.length > 0) {
      const topTags = existing.slice(0, 50).map(t => t.slug);
      return `\n\nExisting tags in the system (prefer reusing these when they fit): ${topTags.join(", ")}`;
    }
  } catch (err) { log.warn("tag hint lookup failed", err); }
  return "";
}

export async function evaluateLinks(
  sourceEntry: Pick<MemoryEntry, "id" | "title" | "summary" | "tags" | "content">,
  candidates: Array<{ entry: MemoryEntry; hybridScore: number }>
): Promise<{ links: EvaluatedLink[] }> {
  if (candidates.length === 0) return { links: [] };

  const sourceDesc = `[SOURCE] ID:${sourceEntry.id} "${sourceEntry.title || "Untitled"}" — ${sourceEntry.summary || sourceEntry.content.slice(0, 200)}`;

  const candidateDescs = candidates.map((c, i) =>
    `[CANDIDATE ${i + 1}] ID:${c.entry.id} "${c.entry.title || "Untitled"}" — ${c.entry.summary || c.entry.content.slice(0, 200)} (similarity: ${c.hybridScore.toFixed(3)})`
  ).join("\n");

  const internalSpine = await contextBuilder.resolve({ callType: 'internal', llmMode: 'text' });
  const internalContext = contextBuilder.renderToPrompt(internalSpine);
  const evalLinkSystemPrompt = await getPromptModulePrompt("myelination-link");
  const startTime = Date.now();
  const linkMessages = [
    {
      role: "system" as const,
      content: internalContext ? `${internalContext}\n\n${evalLinkSystemPrompt}` : evalLinkSystemPrompt,
    },
    {
      role: "user" as const,
      content: `${sourceDesc}\n\nCandidates:\n${candidateDescs}`,
    },
  ];
  const result = await chatCompletion({
    activity: ACTIVITY_MEMORY,
    metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
    maxTokens: 1000,
    messages: linkMessages,
    temperature: 0.3,
    jsonMode: true,
  });

  const allIds = new Set([sourceEntry.id, ...candidates.map(c => c.entry.id)]);
  const links = parseLinkResults(result.content, allIds)
    .filter(l => l.from === sourceEntry.id || l.to === sourceEntry.id);
  return { links };
}

export async function extractCrossMemoryConcepts(
  sourceEntry: Pick<MemoryEntry, "id" | "title" | "summary" | "tags" | "content">,
  linkedEntries: Array<Pick<MemoryEntry, "id" | "title" | "summary" | "tags" | "content">>,
  listTags?: TagLister
): Promise<{ concepts: CrossMemoryConcept[] }> {
  if (linkedEntries.length === 0) return { concepts: [] };

  const tagHint = await getExistingTagHint(listTags);
  const allIds = [sourceEntry.id, ...linkedEntries.map(e => e.id)];

  const sourceDesc = `[SOURCE] "${sourceEntry.title || "Untitled"}" (ID:${sourceEntry.id})\n${sourceEntry.summary || sourceEntry.content.slice(0, 500)}`;

  const linkedDescs = linkedEntries.map(e =>
    `[LINKED] "${e.title || "Untitled"}" (ID:${e.id})\n${e.summary || e.content.slice(0, 500)}`
  ).join("\n\n");

  const crossConceptSpine = await contextBuilder.resolve({ callType: 'internal', llmMode: 'text' });
  const crossConceptContext = contextBuilder.renderToPrompt(crossConceptSpine);
  const crossConceptSystemPrompt = (await getPromptModulePrompt("myelination-cross-concept")) + (tagHint || "");
  const startTime = Date.now();
  const crossConceptMessages = [
    {
      role: "system" as const,
      content: crossConceptContext ? `${crossConceptContext}\n\n${crossConceptSystemPrompt}` : crossConceptSystemPrompt,
    },
    {
      role: "user" as const,
      content: `${sourceDesc}\n\n${linkedDescs}`,
    },
  ];
  const result = await chatCompletion({
    activity: ACTIVITY_MEMORY,
    metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
    maxTokens: 2000,
    messages: crossConceptMessages,
    temperature: 0.4,
    jsonMode: true,
  });

  try {
    const parsed = JSON.parse(extractJson(result.content));
    const concepts: CrossMemoryConcept[] = Array.isArray(parsed.concepts)
      ? parsed.concepts
          .map((c: Record<string, unknown>) => ({
            title: (String(c.title || "")).trim(),
            summary: (String(c.summary || "")).trim(),
            tags: Array.isArray(c.tags)
              ? (c.tags as unknown[]).map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8)
              : [],
            sourceIds: Array.isArray(c.sourceIds)
              ? (c.sourceIds as unknown[]).filter((id: unknown) => typeof id === "number" && allIds.includes(id)) as number[]
              : allIds,
          }))
          .filter((c: CrossMemoryConcept) => c.title && c.summary)
          .slice(0, 3)
      : [];
    return { concepts };
  } catch {
    log.warn(`Cross-memory concept discovery degraded: failed to parse LLM response; returning no proposed concepts`);
    return { concepts: [] };
  }
}
