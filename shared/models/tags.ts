import { z } from "zod";

export const entityTypeEnum = z.enum(["goal", "task", "project", "principle", "issue", "person"]);
export type EntityType = z.infer<typeof entityTypeEnum>;

export interface Tag {
  slug: string;
  label: string;
  aliases: string[];
  description: string;
  color: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TagUsageEntry {
  entityType: EntityType;
  entityId: string;
  entityTitle: string;
}

export interface TagWithUsage extends Tag {
  usages: TagUsageEntry[];
}

export interface CoOccurrenceEdge {
  source: string;
  target: string;
  weight: number;
}

export interface TagIndex {
  tags: Record<string, Tag>;
  usages: Record<string, TagUsageEntry[]>;
  coOccurrences: CoOccurrenceEdge[];
  lastRebuilt: string;
}

export const createTagSchema = z.object({
  label: z.string().min(1).max(80),
  description: z.string().default(""),
  color: z.string().nullable().default(null),
  aliases: z.array(z.string()).default([]),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  description: z.string().optional(),
  color: z.string().nullable().optional(),
  aliases: z.array(z.string()).optional(),
});
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export const mergeTagsSchema = z.object({
  sourceSlug: z.string().min(1),
  targetSlug: z.string().min(1),
});
export type MergeTagsInput = z.infer<typeof mergeTagsSchema>;

export function normalizeTagSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizeTagLabel(raw: string): string {
  return raw.trim().toLowerCase();
}
