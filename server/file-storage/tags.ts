import type { Principal } from "../principal";
import type {
  CreateTagInput,
  EntityType,
  Tag,
  TagIndex,
  TagWithUsage,
  UpdateTagInput,
} from "@shared/schema";
import { normalizeTagLabel, normalizeTagSlug, tagService } from "../tag-service";

export { normalizeTagLabel, normalizeTagSlug };

/**
 * Compatibility facade for existing callers. PostgreSQL through TagService is the
 * only authority; this module intentionally performs no JSON reads or writes.
 */
export const tagRegistry = {
  getIndex(principal?: Principal): Promise<TagIndex> {
    return tagService.getIndex(principal);
  },

  listTags(principal?: Principal): Promise<TagWithUsage[]> {
    return tagService.listTags(principal);
  },

  getTag(slug: string, principal?: Principal): Promise<TagWithUsage | null> {
    return tagService.getTag(slug, principal);
  },

  createTag(input: CreateTagInput, principal?: Principal): Promise<Tag> {
    return tagService.createTag(input, principal);
  },

  updateTag(slug: string, input: UpdateTagInput, principal?: Principal): Promise<Tag | null> {
    return tagService.updateTag(slug, input, principal);
  },

  deleteTag(slug: string, principal?: Principal): Promise<boolean> {
    return tagService.deleteTag(slug, principal);
  },

  resolveTagSlug(input: string, principal?: Principal): Promise<string | null> {
    return tagService.resolveTagSlug(input, principal);
  },

  ensureTag(input: string, principal?: Principal): Promise<string> {
    return tagService.ensureTag(input, principal);
  },

  assignTag(
    tagSlug: string,
    entityType: EntityType | string,
    entityId: string,
    entityTitle: string,
    principal?: Principal,
  ): Promise<void> {
    return tagService.assignTag(tagSlug, entityType, entityId, entityTitle, principal);
  },

  unassignTag(tagSlug: string, entityType: EntityType | string, entityId: string, principal?: Principal): Promise<void> {
    return tagService.unassignTag(tagSlug, entityType, entityId, principal);
  },

  removeEntity(entityType: EntityType | string, entityId: string, principal?: Principal): Promise<void> {
    return tagService.removeEntity(entityType, entityId, principal);
  },

  removeEntityTags(entityType: EntityType | string, entityId: string, principal?: Principal): Promise<void> {
    return tagService.removeEntity(entityType, entityId, principal);
  },

  syncEntityTags(
    entityType: EntityType | string,
    entityId: string,
    entityTitle: string,
    tags: string[],
    principal?: Principal,
  ): Promise<string[]> {
    return tagService.replaceEntityTags(entityType, entityId, entityTitle, tags, principal);
  },

  setEntityTags(
    entityType: EntityType | string,
    entityId: string,
    entityTitle: string,
    tags: string[],
    principal?: Principal,
  ): Promise<string[]> {
    return tagService.replaceEntityTags(entityType, entityId, entityTitle, tags, principal);
  },

  removeRetiredEntityTypeUsages(entityType: string, principal?: Principal): Promise<void> {
    return tagService.removeRetiredEntityTypeUsages(entityType, principal);
  },

  async rebuildFromEntities(
    entities: Array<{ entityType: EntityType; entityId: string; entityTitle: string; tags: string[] }>,
    principal?: Principal,
  ): Promise<TagIndex> {
    for (const entity of entities) {
      await tagService.replaceEntityTags(
        entity.entityType,
        entity.entityId,
        entity.entityTitle,
        entity.tags,
        principal,
      );
    }
    return tagService.getIndex(principal);
  },

  replaceEntityTags(
    entityType: EntityType,
    entityId: string,
    entityTitle: string,
    tags: string[],
    principal?: Principal,
  ): Promise<string[]> {
    return tagService.replaceEntityTags(entityType, entityId, entityTitle, tags, principal);
  },

  mergeTags(sourceSlug: string, targetSlug: string, principal?: Principal): Promise<Tag | null> {
    return tagService.mergeTags(sourceSlug, targetSlug, principal);
  },
};
