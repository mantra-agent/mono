import { db } from "../db";
import { principleRevisions, principles } from "@shared/schema";
import { buildTagGuidance } from "@shared/tag-taxonomy";
import { and, eq, sql } from "drizzle-orm";
import { chatCompletion } from "../model-client";
import { ACTIVITY_WORK } from "../job-profiles";
import { tagService } from "../tag-service";
import { contextBuilder } from "../context-builder";
import { generateId } from "./utils";
import { createLogger } from "../log";
import { gateProposedTags } from "../tag-proposal";
import { TTLCache } from "../utils/ttl-cache";
import { principalCacheKey } from "./base";
import { requireCurrentUserPrincipal } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
  type ScopeColumns,
} from "../scoped-storage";

export interface Principle {
  id: string;
  currentRevisionId: string;
  revisionNumber: number;
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

Also extract 2-5 semantic tags.

Finally, identify any existing principles that are related (complementary, tension, or prerequisite relationships).

Respond in JSON format:
{
  "title": "Short principle name (2-5 words)",
  "layer1": "The single sentence principle.",
  "layer2": "Expanded context with reasoning, examples, and boundaries.",
  "autoTags": ["tag1", "tag2"],
  "relatedIds": ["id1", "id2"]
}`;

async function getPrincipleTagGuidance(): Promise<string> {
  try {
    const existingTags = await tagService.listTags();
    return buildTagGuidance(existingTags.map((tag) => tag.name));
  } catch (error) {
    log.warn("Failed to load existing tags for principle guidance", error);
    return buildTagGuidance([]);
  }
}

const currentPrincipleProjection = {
  id: principles.id,
  currentRevisionId: principleRevisions.id,
  revisionNumber: principleRevisions.revisionNumber,
  title: principleRevisions.title,
  layer1: principleRevisions.layer1,
  layer2: principleRevisions.layer2,
  autoTags: principles.autoTags,
  manualTags: principles.manualTags,
  relatedIds: principles.relatedIds,
  createdAt: principles.createdAt,
  updatedAt: principles.updatedAt,
};

type CurrentPrincipleRow = {
  id: string;
  currentRevisionId: string;
  revisionNumber: number;
  title: string;
  layer1: string;
  layer2: string;
  autoTags: unknown;
  manualTags: unknown;
  relatedIds: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function currentRevisionJoin() {
  return and(
    eq(principleRevisions.id, principles.currentRevisionId),
    eq(principleRevisions.principleId, principles.id),
  );
}

function rowToPrinciple(row: CurrentPrincipleRow): Principle {
  return {
    id: row.id,
    currentRevisionId: row.currentRevisionId,
    revisionNumber: row.revisionNumber,
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
    const principal = requireCurrentUserPrincipal();
    return this._principlesCache.getOrFetch(principalCacheKey("principles"), async () => {
      const rows = await db.select(currentPrincipleProjection)
        .from(principles)
        .innerJoin(principleRevisions, currentRevisionJoin())
        .where(combineWithVisibleScope(principal, principlesScopeColumns));
      const result = rows.map(rowToPrinciple);
      result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      log.log(`getPrinciples count=${result.length}`);
      return result;
    });
  }

  async getPrinciple(id: string): Promise<Principle | null> {
    const principal = requireCurrentUserPrincipal();
    const rows = await db.select(currentPrincipleProjection)
      .from(principles)
      .innerJoin(principleRevisions, currentRevisionJoin())
      .where(combineWithVisibleScope(principal, principlesScopeColumns, eq(principles.id, id)))
      .limit(1);
    if (rows.length === 0) {
      log.log(`getPrinciple id=${id} not-found`);
      return null;
    }
    log.log(`getPrinciple id=${id} found`);
    return rowToPrinciple(rows[0]);
  }

  /**
   * Resolve a caller-supplied principle identity to the visible current principle.
   * Accepts current revision id, principle id, or any historical revision id owned
   * by a visible principle. Returns null when nothing visible matches.
   */
  async resolvePrincipleFromAnyId(id: string): Promise<Principle | null> {
    const trimmed = id.trim();
    if (!trimmed) return null;
    const principal = requireCurrentUserPrincipal();
    // Fast path: current revision or principle id via the ordinary list join.
    const currentMatch = await db.select(currentPrincipleProjection)
      .from(principles)
      .innerJoin(principleRevisions, currentRevisionJoin())
      .where(combineWithVisibleScope(
        principal,
        principlesScopeColumns,
        sql`(${principles.id} = ${trimmed} OR ${principleRevisions.id} = ${trimmed})`,
      ))
      .limit(1);
    if (currentMatch.length > 0) return rowToPrinciple(currentMatch[0]);

    // Historical revision → heal to that principle's current projection.
    const [historical] = await db.select({ principleId: principleRevisions.principleId })
      .from(principleRevisions)
      .innerJoin(principles, and(
        eq(principles.id, principleRevisions.principleId),
        combineWithVisibleScope(principal, principlesScopeColumns),
      ))
      .where(eq(principleRevisions.id, trimmed))
      .limit(1);
    if (!historical) {
      log.log(`resolvePrincipleFromAnyId id=${trimmed} not-found`);
      return null;
    }
    return this.getPrinciple(historical.principleId);
  }

  async createPrinciple(input: {
    title: string;
    layer1: string;
    layer2: string;
    autoTags?: string[];
    manualTags?: string[];
    relatedIds?: string[];
  }): Promise<Principle> {
    const principal = requireCurrentUserPrincipal();
    const now = new Date();
    const id = generateId();
    const currentRevisionId = generateId("prrev_");
    const ownership = ownedInsertValues(principal, principlesScopeColumns);

    await db.transaction(async (tx) => {
      await tx.insert(principles).values({
        id,
        title: input.title,
        layer1: input.layer1,
        layer2: input.layer2,
        autoTags: input.autoTags || [],
        manualTags: input.manualTags || [],
        relatedIds: input.relatedIds || [],
        currentRevisionId,
        ...ownership,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(principleRevisions).values({
        id: currentRevisionId,
        principleId: id,
        revisionNumber: 1,
        title: input.title,
        layer1: input.layer1,
        layer2: input.layer2,
        ...ownership,
        createdAt: now,
      });
    });

    const allTags = [...(input.autoTags || []), ...(input.manualTags || [])];
    tagService.replaceEntityTags("principle", id, input.title, allTags).catch(err => log.warn(`tag sync failed`, err));

    log.log(`createPrinciple id=${id} revision=${currentRevisionId} title="${input.title}"`);
    this.invalidateCache();
    const created = await this.getPrinciple(id);
    if (!created) throw new Error(`Created principle ${id} could not be loaded`);
    return created;
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

    const principal = requireCurrentUserPrincipal();
    const now = new Date();
    const [identity] = await db.select({
      currentRevisionId: principles.currentRevisionId,
    }).from(principles)
      .where(combineWithWritableScope(principal, principlesScopeColumns, eq(principles.id, id)))
      .limit(1);
    const current = identity ? await this.getPrinciple(id) : null;
    if (!identity || !current) {
      log.log(`updatePrinciple id=${id} not-writable`);
      return null;
    }

    const contentChanged = updates.title !== undefined || updates.layer1 !== undefined || updates.layer2 !== undefined;
    const nextRevisionId = contentChanged ? generateId("prrev_") : current.currentRevisionId;
    const nextTitle = updates.title ?? current.title;
    const nextLayer1 = updates.layer1 ?? current.layer1;
    const nextLayer2 = updates.layer2 ?? current.layer2;

    await db.transaction(async (tx) => {
      const setValues: Record<string, unknown> = { updatedAt: now };
      if (updates.title !== undefined) setValues.title = updates.title;
      if (updates.layer1 !== undefined) setValues.layer1 = updates.layer1;
      if (updates.layer2 !== undefined) setValues.layer2 = updates.layer2;
      if (updates.autoTags !== undefined) setValues.autoTags = updates.autoTags;
      if (updates.manualTags !== undefined) setValues.manualTags = updates.manualTags;
      if (updates.relatedIds !== undefined) setValues.relatedIds = updates.relatedIds;

      if (contentChanged) {
        const [revision] = await tx.insert(principleRevisions).select(
          tx.select({
            id: sql<string>`${nextRevisionId}`,
            principleId: principles.id,
            revisionNumber: sql<number>`${current.revisionNumber + 1}`,
            title: sql<string>`${nextTitle}`,
            layer1: sql<string>`${nextLayer1}`,
            layer2: sql<string>`${nextLayer2}`,
            scope: principles.scope,
            ownerUserId: principles.ownerUserId,
            accountId: principles.accountId,
            createdAt: sql<Date>`${now}`,
          }).from(principles).where(combineWithWritableScope(principal, principlesScopeColumns, and(
            eq(principles.id, id),
            eq(principles.currentRevisionId, current.currentRevisionId),
          )))
        ).returning({ id: principleRevisions.id });
        if (!revision) {
          throw new Error(`Principle ${id} changed during update`);
        }
        setValues.currentRevisionId = nextRevisionId;
      }

      const updated = await tx.update(principles)
        .set(setValues)
        .where(combineWithWritableScope(principal, principlesScopeColumns, and(
          eq(principles.id, id),
          eq(principles.currentRevisionId, current.currentRevisionId),
        )))
        .returning({ id: principles.id });
      if (updated.length === 0) throw new Error(`Principle changed concurrently or is not writable: ${id}`);
    });

    this.invalidateCache();
    const merged = await this.getPrinciple(id);
    if (!merged) throw new Error(`Updated principle ${id} could not be loaded`);
    const allTags = [...merged.autoTags, ...merged.manualTags];
    tagService.replaceEntityTags("principle", id, merged.title, allTags).catch(err => log.warn(`tag sync failed`, err));

    log.log(`updatePrinciple id=${id} revision=${merged.currentRevisionId} fields=${Object.keys(updates).join(",")}`);
    return merged;
  }

  async deletePrinciple(id: string): Promise<boolean> {
    const principal = requireCurrentUserPrincipal();
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

    tagService.removeEntity("principle", id).catch(err => log.warn(`tag removal failed`, err));

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

    const tagGuidance = await getPrincipleTagGuidance();
    const systemPrompt = `${PRINCIPLE_FORGE_PROMPT}\n\n${tagGuidance}` +
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
      autoTags: gateProposedTags(parsed.autoTags).tags,
      relatedIds: (parsed.relatedIds || []).filter((rid: string) =>
        existingPrinciples.some((p) => p.id === rid)
      ),
      relatedTitles,
    };
  }

}

export const filePrincipleStorage = new FilePrincipleStorage();
