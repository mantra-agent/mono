import { db } from "../db";
import { principles } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { chatCompletion } from "../model-client";
import { ACTIVITY_WORK } from "../job-profiles";
import { tagRegistry } from "./tags";
import { contextBuilder } from "../context-builder";
import { generateId } from "./utils";
import { createLogger } from "../log";
import { TTLCache } from "../utils/ttl-cache";
import { principalCacheKey } from "./base";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
  type ScopeColumns,
} from "../scoped-storage";

export interface Principle {
  id: string;
  title: string;
  layer1: string;
  layer2: string;
  autoTags: string[];
  manualTags: string[];
  relatedIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PrincipleIndex {
  principles: Array<{
    id: string;
    title: string;
    layer1: string;
    tags: string[];
    relatedIds: string[];
    updatedAt: string;
  }>;
  lastUpdated: string;
}

const log = createLogger("StorePrinciples");

const principlesScopeColumns: ScopeColumns = {
  scope: principles.scope,
  ownerUserId: principles.ownerUserId,
  accountId: principles.accountId,
};

const PRINCIPLE_FORGE_PROMPT = `You are a principle architect. The user will provide raw thoughts, ideas, or principles. Your job is to distill them into a precisely structured principle with two layers:

Layer 1: A single, crisp, memorable sentence that captures the essence. This should be actionable and clear enough to guide decisions on its own.

Style guide: Layer 1 should follow the pattern of existing principles — an imperative verb phrase as the title (e.g., "Compound Yourself", "Hold Outcomes Loosely", "Face Reality, Release Resistance") and a single sentence that a person could use as a decision rule in the moment. Avoid academic or passive framing. The test: would someone tattoo this on their forearm?

Layer 2: 2-4 paragraphs of expanded context that explain the reasoning, provide examples, define boundaries, and help someone deeply evaluate how this principle applies in ambiguous situations.

Also extract 2-5 semantic tags that capture the domains this principle touches (e.g., "design", "decision-making", "communication", "engineering", "leadership").

Finally, identify any existing principles that are related (complementary, tension, or prerequisite relationships).

Respond in JSON format:
{
  "title": "Short principle name (2-5 words)",
  "layer1": "The single sentence principle.",
  "layer2": "Expanded context with reasoning, examples, and boundaries.",
  "autoTags": ["tag1", "tag2"],
  "relatedIds": ["id1", "id2"]
}`;

function rowToPrinciple(row: typeof principles.$inferSelect): Principle {
  return {
    id: row.id,
    title: row.title,
    layer1: row.layer1,
    layer2: row.layer2,
    autoTags: (row.autoTags as string[]) || [],
    manualTags: (row.manualTags as string[]) || [],
    relatedIds: (row.relatedIds as string[]) || [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildIndex(items: Principle[]): PrincipleIndex {
  return {
    principles: items
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((p) => ({
        id: p.id,
        title: p.title,
        layer1: p.layer1,
        tags: Array.from(new Set([...p.autoTags, ...p.manualTags])),
        relatedIds: p.relatedIds,
        updatedAt: p.updatedAt,
      })),
    lastUpdated: new Date().toISOString(),
  };
}


export class FilePrincipleStorage {
  private readonly _principlesCache = new TTLCache<Principle[]>("Principles", 60_000);

  private invalidateCache(): void {
    this._principlesCache.invalidateAll();
  }

  async getPrinciples(): Promise<Principle[]> {
    const principal = getCurrentPrincipalOrSystem();
    return this._principlesCache.getOrFetch(principalCacheKey("principles"), async () => {
      const rows = await db.select().from(principles)
        .where(combineWithVisibleScope(principal, principlesScopeColumns));
      const result = rows.map(rowToPrinciple);
      result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      log.log(`getPrinciples count=${result.length}`);
      return result;
    });
  }

  async getPrinciple(id: string): Promise<Principle | null> {
    const principal = getCurrentPrincipalOrSystem();
    const rows = await db.select().from(principles)
      .where(combineWithVisibleScope(principal, principlesScopeColumns, eq(principles.id, id)))
      .limit(1);
    if (rows.length === 0) {
      log.log(`getPrinciple id=${id} not-found`);
      return null;
    }
    log.log(`getPrinciple id=${id} found`);
    return rowToPrinciple(rows[0]);
  }

  async createPrinciple(input: {
    title: string;
    layer1: string;
    layer2: string;
    autoTags?: string[];
    manualTags?: string[];
    relatedIds?: string[];
  }): Promise<Principle> {
    const principal = getCurrentPrincipalOrSystem();
    const now = new Date();
    const id = generateId();

    const [row] = await db.insert(principles).values({
      id,
      title: input.title,
      layer1: input.layer1,
      layer2: input.layer2,
      autoTags: input.autoTags || [],
      manualTags: input.manualTags || [],
      relatedIds: input.relatedIds || [],
      ...ownedInsertValues(principal, principlesScopeColumns),
      createdAt: now,
      updatedAt: now,
    }).returning();

    const allTags = [...(input.autoTags || []), ...(input.manualTags || [])];
    tagRegistry.syncEntityTags("principle", id, input.title, allTags).catch(err => log.warn(`tag sync failed`, err));

    log.log(`createPrinciple id=${id} title="${input.title}"`);
    this.invalidateCache();
    return rowToPrinciple(row);
  }

  async updatePrinciple(
    id: string,
    updates: Partial<Omit<Principle, "id" | "createdAt">>
  ): Promise<Principle | null> {
    const existing = await this.getPrinciple(id);
    if (!existing) {
      log.log(`updatePrinciple id=${id} not-found`);
      return null;
    }

    const principal = getCurrentPrincipalOrSystem();
    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.title !== undefined) setValues.title = updates.title;
    if (updates.layer1 !== undefined) setValues.layer1 = updates.layer1;
    if (updates.layer2 !== undefined) setValues.layer2 = updates.layer2;
    if (updates.autoTags !== undefined) setValues.autoTags = updates.autoTags;
    if (updates.manualTags !== undefined) setValues.manualTags = updates.manualTags;
    if (updates.relatedIds !== undefined) setValues.relatedIds = updates.relatedIds;

    const [row] = await db.update(principles).set(setValues)
      .where(combineWithWritableScope(principal, principlesScopeColumns, eq(principles.id, id)))
      .returning();

    if (!row) {
      log.log(`updatePrinciple id=${id} not-writable`);
      return null;
    }

    const merged = rowToPrinciple(row);
    const allTags = [...merged.autoTags, ...merged.manualTags];
    tagRegistry.syncEntityTags("principle", id, merged.title, allTags).catch(err => log.warn(`tag sync failed`, err));

    log.log(`updatePrinciple id=${id} fields=${Object.keys(updates).join(",")}`);
    this.invalidateCache();
    return merged;
  }

  async deletePrinciple(id: string): Promise<boolean> {
    const principal = getCurrentPrincipalOrSystem();
    const result = await db.delete(principles)
      .where(combineWithWritableScope(principal, principlesScopeColumns, eq(principles.id, id)));
    const deleted = (result.rowCount ?? 0) > 0;
    if (!deleted) {
      log.log(`deletePrinciple id=${id} not-found`);
      return false;
    }
    this.invalidateCache();

    // Remove this id from relatedIds of other principles (scoped to visible)
    const all = await this.getPrinciples();
    for (const p of all) {
      if (p.relatedIds.includes(id)) {
        const newRelated = p.relatedIds.filter((r) => r !== id);
        await db.update(principles).set({
          relatedIds: newRelated,
          updatedAt: new Date(),
        }).where(combineWithWritableScope(principal, principlesScopeColumns, eq(principles.id, p.id)));
      }
    }

    tagRegistry.removeEntityTags("principle", id).catch(err => log.warn(`tag removal failed`, err));

    this.invalidateCache();
    log.log(`deletePrinciple id=${id} success`);
    return true;
  }

  async getIndex(): Promise<PrincipleIndex> {
    const all = await this.getPrinciples();
    return buildIndex(all);
  }

  async getAllLayer1(): Promise<Array<{ id: string; title: string; layer1: string; tags: string[] }>> {
    const index = await this.getIndex();
    return index.principles.map((p) => ({
      id: p.id,
      title: p.title,
      layer1: p.layer1,
      tags: p.tags,
    }));
  }

  async getDeepDive(tags: string[]): Promise<Principle[]> {
    const all = await this.getPrinciples();
    if (tags.length === 0) return all;
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    return all.filter((p) => {
      const allTags = [...p.autoTags, ...p.manualTags].map((t) => t.toLowerCase());
      return allTags.some((t) => tagSet.has(t));
    });
  }

  async forge(rawInput: string): Promise<{
    title: string;
    layer1: string;
    layer2: string;
    autoTags: string[];
    relatedIds: string[];
    relatedTitles: string[];
  }> {
    const existingPrinciples = await this.getPrinciples();
    const existingContext = existingPrinciples
      .map((p) => `- [${p.id}] "${p.title}": ${p.layer1}`)
      .join("\n");

    const systemPrompt = PRINCIPLE_FORGE_PROMPT +
      (existingPrinciples.length > 0 ? `\n\nExisting principles:\n${existingContext}\n` : "");

    const forgeSpine = await contextBuilder.resolve({ callType: 'world', llmMode: 'text' });
    const forgeSpineContext = contextBuilder.renderToPrompt(forgeSpine);
    const forgeMessages = [
      { role: "system" as const, content: forgeSpineContext ? `${forgeSpineContext}\n\n${systemPrompt}` : systemPrompt },
      { role: "user" as const, content: rawInput },
    ];
    const result = await chatCompletion({
      activity: ACTIVITY_WORK,
      maxTokens: 4000,
      messages: forgeMessages,
      jsonMode: true,
      metadata: { source: "principles-forge", activity: ACTIVITY_WORK },
    });

    const content = result.content || "{}";
    const parsed = JSON.parse(content);

    const relatedTitles = (parsed.relatedIds || [])
      .map((rid: string) => {
        const found = existingPrinciples.find((p) => p.id === rid);
        return found ? found.title : null;
      })
      .filter(Boolean);

    log.log(`forge title="${parsed.title || "Untitled Principle"}" autoTags=${(parsed.autoTags || []).length} relatedIds=${(parsed.relatedIds || []).length}`);
    return {
      title: parsed.title || "Untitled Principle",
      layer1: parsed.layer1 || "",
      layer2: parsed.layer2 || "",
      autoTags: parsed.autoTags || [],
      relatedIds: (parsed.relatedIds || []).filter((rid: string) =>
        existingPrinciples.some((p) => p.id === rid)
      ),
      relatedTitles,
    };
  }

}

export const filePrincipleStorage = new FilePrincipleStorage();
