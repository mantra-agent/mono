import type {
  Tag,
  TagIndex,
  TagUsageEntry,
  TagWithUsage,
  CoOccurrenceEdge,
  CreateTagInput,
  UpdateTagInput,
  EntityType,
} from "@shared/schema";
import { normalizeTagSlug, normalizeTagLabel } from "@shared/schema";
import { getSetting, setSetting } from "../system-settings";

const TAGS_SETTING_KEY = "system.tags.index";

function emptyIndex(): TagIndex {
  return { tags: {}, usages: {}, coOccurrences: [], lastRebuilt: new Date().toISOString() };
}

async function loadIndex(): Promise<TagIndex> {
  try {
    const data = await getSetting<TagIndex>(TAGS_SETTING_KEY);
    if (!data) return emptyIndex();
    if (!data.tags) data.tags = {};
    if (!data.usages) data.usages = {};
    if (!data.coOccurrences) data.coOccurrences = [];
    return data;
  } catch {
    return emptyIndex();
  }
}

async function saveIndex(index: TagIndex): Promise<void> {
  await setSetting(TAGS_SETTING_KEY, index);
}

function buildCoOccurrences(usages: Record<string, TagUsageEntry[]>): CoOccurrenceEdge[] {
  const entityTags = new Map<string, string[]>();
  for (const [slug, entries] of Object.entries(usages)) {
    for (const entry of entries) {
      const key = `${entry.entityType}:${entry.entityId}`;
      const existing = entityTags.get(key) || [];
      existing.push(slug);
      entityTags.set(key, existing);
    }
  }

  const pairCounts = new Map<string, number>();
  const allEntries = Array.from(entityTags.values());
  for (const tags of allEntries) {
    if (tags.length < 2) continue;
    const sorted = Array.from(new Set(tags)).sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}||${sorted[j]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  const edges: CoOccurrenceEdge[] = [];
  const pairEntries = Array.from(pairCounts.entries());
  for (const [key, weight] of pairEntries) {
    const [source, target] = key.split("||");
    edges.push({ source, target, weight });
  }
  return edges.sort((a, b) => b.weight - a.weight);
}

export const tagRegistry = {
  async getIndex(): Promise<TagIndex> {
    return loadIndex();
  },

  async listTags(): Promise<Tag[]> {
    const index = await loadIndex();
    return Object.values(index.tags).sort((a, b) => b.usageCount - a.usageCount);
  },

  async getTag(slug: string): Promise<TagWithUsage | null> {
    const index = await loadIndex();
    const tag = index.tags[slug];
    if (!tag) return null;
    return { ...tag, usages: index.usages[slug] || [] };
  },

  async getTagByLabel(label: string): Promise<Tag | null> {
    const slug = normalizeTagSlug(label);
    const index = await loadIndex();
    if (index.tags[slug]) return index.tags[slug];
    for (const tag of Object.values(index.tags)) {
      if (tag.label === normalizeTagLabel(label)) return tag;
      if (tag.aliases.some(a => normalizeTagSlug(a) === slug)) return tag;
    }
    return null;
  },

  async createTag(input: CreateTagInput): Promise<Tag> {
    const index = await loadIndex();
    const slug = normalizeTagSlug(input.label);
    if (!slug) throw new Error("Invalid tag label");
    if (index.tags[slug]) return index.tags[slug];

    const now = new Date().toISOString();
    const tag: Tag = {
      slug,
      label: normalizeTagLabel(input.label),
      aliases: (input.aliases || []).map(a => normalizeTagLabel(a)),
      description: input.description || "",
      color: input.color || null,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    index.tags[slug] = tag;
    index.usages[slug] = [];
    await saveIndex(index);
    return tag;
  },

  async updateTag(slug: string, input: UpdateTagInput): Promise<Tag | null> {
    const index = await loadIndex();
    const tag = index.tags[slug];
    if (!tag) return null;

    if (input.label !== undefined) tag.label = normalizeTagLabel(input.label);
    if (input.description !== undefined) tag.description = input.description;
    if (input.color !== undefined) tag.color = input.color;
    if (input.aliases !== undefined) tag.aliases = input.aliases.map(a => normalizeTagLabel(a));
    tag.updatedAt = new Date().toISOString();

    index.tags[slug] = tag;
    await saveIndex(index);
    return tag;
  },

  async deleteTag(slug: string): Promise<boolean> {
    const index = await loadIndex();
    if (!index.tags[slug]) return false;
    delete index.tags[slug];
    delete index.usages[slug];
    index.coOccurrences = index.coOccurrences.filter(e => e.source !== slug && e.target !== slug);
    await saveIndex(index);
    return true;
  },

  async mergeTags(sourceSlug: string, targetSlug: string): Promise<Tag | null> {
    const index = await loadIndex();
    const sourceTag = index.tags[sourceSlug];
    const targetTag = index.tags[targetSlug];
    if (!sourceTag || !targetTag) return null;

    if (!targetTag.aliases.includes(sourceTag.label)) {
      targetTag.aliases.push(sourceTag.label);
    }
    for (const alias of sourceTag.aliases) {
      if (!targetTag.aliases.includes(alias)) {
        targetTag.aliases.push(alias);
      }
    }

    const sourceUsages = index.usages[sourceSlug] || [];
    const targetUsages = index.usages[targetSlug] || [];
    const existingKeys = new Set(targetUsages.map(u => `${u.entityType}:${u.entityId}`));
    for (const usage of sourceUsages) {
      const key = `${usage.entityType}:${usage.entityId}`;
      if (!existingKeys.has(key)) {
        targetUsages.push(usage);
      }
    }
    index.usages[targetSlug] = targetUsages;
    targetTag.usageCount = targetUsages.length;
    targetTag.updatedAt = new Date().toISOString();
    index.tags[targetSlug] = targetTag;

    delete index.tags[sourceSlug];
    delete index.usages[sourceSlug];
    index.coOccurrences = buildCoOccurrences(index.usages);
    await saveIndex(index);
    return targetTag;
  },

  async ensureTag(label: string): Promise<string> {
    const slug = normalizeTagSlug(label);
    if (!slug) return "";
    const index = await loadIndex();
    if (index.tags[slug]) return slug;

    for (const tag of Object.values(index.tags)) {
      if (tag.aliases.some(a => normalizeTagSlug(a) === slug)) return tag.slug;
    }

    const now = new Date().toISOString();
    index.tags[slug] = {
      slug,
      label: normalizeTagLabel(label),
      aliases: [],
      description: "",
      color: null,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    index.usages[slug] = [];
    await saveIndex(index);
    return slug;
  },

  async setEntityTags(
    entityType: EntityType,
    entityId: string,
    entityTitle: string,
    tagSlugs: string[],
  ): Promise<void> {
    const index = await loadIndex();

    for (const [slug, entries] of Object.entries(index.usages)) {
      const before = entries.length;
      index.usages[slug] = entries.filter(
        e => !(e.entityType === entityType && e.entityId === entityId),
      );
      if (index.usages[slug].length !== before && index.tags[slug]) {
        index.tags[slug].usageCount = index.usages[slug].length;
      }
    }

    for (const slug of tagSlugs) {
      if (!index.tags[slug]) continue;
      if (!index.usages[slug]) index.usages[slug] = [];
      index.usages[slug].push({ entityType, entityId, entityTitle });
      index.tags[slug].usageCount = index.usages[slug].length;
    }

    index.coOccurrences = buildCoOccurrences(index.usages);
    await saveIndex(index);
  },

  async removeRetiredEntityTypeUsages(entityType: string): Promise<void> {
    const index = await loadIndex();
    let changed = false;
    for (const [slug, entries] of Object.entries(index.usages)) {
      const filtered = entries.filter((entry) => String(entry.entityType) !== entityType);
      if (filtered.length === entries.length) continue;
      changed = true;
      index.usages[slug] = filtered;
      if (index.tags[slug]) index.tags[slug].usageCount = filtered.length;
    }
    if (changed) {
      index.coOccurrences = buildCoOccurrences(index.usages);
      await saveIndex(index);
    }
  },

  async removeEntityUsages(entityType: EntityType, entityId: string): Promise<void> {
    const index = await loadIndex();
    let changed = false;
    for (const [slug, entries] of Object.entries(index.usages)) {
      const before = entries.length;
      index.usages[slug] = entries.filter(
        e => !(e.entityType === entityType && e.entityId === entityId),
      );
      if (index.usages[slug].length !== before) {
        changed = true;
        if (index.tags[slug]) {
          index.tags[slug].usageCount = index.usages[slug].length;
        }
      }
    }
    if (changed) {
      index.coOccurrences = buildCoOccurrences(index.usages);
      await saveIndex(index);
    }
  },

  async rebuildFromEntities(entities: Array<{
    entityType: EntityType;
    entityId: string;
    entityTitle: string;
    tags: string[];
  }>): Promise<TagIndex> {
    const index: TagIndex = { tags: {}, usages: {}, coOccurrences: [], lastRebuilt: new Date().toISOString() };

    for (const entity of entities) {
      for (const rawTag of entity.tags) {
        const slug = normalizeTagSlug(rawTag);
        if (!slug) continue;

        if (!index.tags[slug]) {
          const now = new Date().toISOString();
          index.tags[slug] = {
            slug,
            label: normalizeTagLabel(rawTag),
            aliases: [],
            description: "",
            color: null,
            usageCount: 0,
            createdAt: now,
            updatedAt: now,
          };
          index.usages[slug] = [];
        }

        index.usages[slug].push({
          entityType: entity.entityType,
          entityId: entity.entityId,
          entityTitle: entity.entityTitle,
        });
      }
    }

    for (const slug of Object.keys(index.tags)) {
      index.tags[slug].usageCount = (index.usages[slug] || []).length;
    }

    index.coOccurrences = buildCoOccurrences(index.usages);
    await saveIndex(index);
    return index;
  },

  async syncEntityTags(
    entityType: EntityType,
    entityId: string,
    entityTitle: string,
    tagSlugs: string[],
  ): Promise<void> {
    const index = await loadIndex();
    const now = new Date().toISOString();
    for (const slug of Object.keys(index.usages)) {
      index.usages[slug] = (index.usages[slug] || []).filter(
        (u) => !(u.entityType === entityType && u.entityId === entityId)
      );
      if (index.tags[slug]) {
        index.tags[slug].usageCount = index.usages[slug].length;
      }
    }
    for (const raw of tagSlugs) {
      const slug = normalizeTagSlug(raw);
      if (!slug) continue;
      if (!index.tags[slug]) {
        index.tags[slug] = {
          slug,
          label: normalizeTagLabel(raw),
          aliases: [],
          description: "",
          color: null,
          usageCount: 0,
          createdAt: now,
          updatedAt: now,
        };
      }
      if (!index.usages[slug]) index.usages[slug] = [];
      index.usages[slug].push({ entityType, entityId, entityTitle });
      index.tags[slug].usageCount = index.usages[slug].length;
    }
    index.coOccurrences = buildCoOccurrences(index.usages);
    await saveIndex(index);
  },

  async removeEntityTags(entityType: EntityType, entityId: string): Promise<void> {
    const index = await loadIndex();
    for (const slug of Object.keys(index.usages)) {
      index.usages[slug] = (index.usages[slug] || []).filter(
        (u) => !(u.entityType === entityType && u.entityId === entityId)
      );
      if (index.tags[slug]) {
        index.tags[slug].usageCount = index.usages[slug].length;
      }
    }
    index.coOccurrences = buildCoOccurrences(index.usages);
    await saveIndex(index);
  },

  async findDuplicates(threshold = 0.7): Promise<Array<{ a: string; b: string; similarity: number }>> {
    const index = await loadIndex();
    const slugs = Object.keys(index.tags);
    const results: Array<{ a: string; b: string; similarity: number }> = [];

    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        const a = slugs[i];
        const b = slugs[j];
        const sim = Math.max(
          levenshteinSimilarity(a, b),
          substringMatch(a, b),
        );
        if (sim >= threshold) {
          results.push({ a, b, similarity: sim });
        }
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  },
};

function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function substringMatch(a: string, b: string): number {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  return 0;
}
