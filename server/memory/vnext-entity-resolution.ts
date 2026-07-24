import { createLogger } from "../log";
import type { ClaimCandidate } from "./vnext-claim-extraction";

const log = createLogger("MemoryVnextEntityResolution");

export interface ResolvedVnextEntityMention {
  entityType: string;
  entityId: string;
}

/**
 * Canonical set of entity types a vNext claim mention can resolve and link to.
 * Single source of truth shared by extraction, lifecycle mention parsing, and
 * resolution. These must not diverge: if a consumer omits a type, mentions of
 * that type are silently dropped and never become entity links.
 */
export const VNEXT_LINKABLE_ENTITY_TYPES = ["person", "company", "project", "goal"] as const;
export type VnextLinkableEntityType = (typeof VNEXT_LINKABLE_ENTITY_TYPES)[number];
export function isVnextLinkableEntityType(value: unknown): value is VnextLinkableEntityType {
  return typeof value === "string" && (VNEXT_LINKABLE_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Resolve vNext claim entity mentions against People, Companies, Projects, and Goals.
 * Returns only high-confidence, unambiguous matches so lifecycle linking fails closed.
 */
export async function resolveVnextEntityMentions(
  mentions: ClaimCandidate["entityMentions"],
): Promise<ResolvedVnextEntityMention[]> {
  if (mentions.length === 0) return [];

  const resolved: ResolvedVnextEntityMention[] = [];

  for (const mention of mentions) {
    try {
      if (mention.entityType === "person") {
        const { peopleStorage } = await import("../people-storage");
        const results = await peopleStorage.searchPeople(mention.name);
        const mentionLower = mention.name.toLowerCase().trim();
        const firstNameMatches = results.filter((result) =>
          result.name.toLowerCase().split(/\s+/)[0] === mentionLower,
        );
        const startsWithMatches = firstNameMatches.length > 0
          ? firstNameMatches
          : results.filter((result) => result.name.toLowerCase().startsWith(mentionLower));
        const candidates = startsWithMatches.length > 0 ? startsWithMatches : results;
        if (candidates.length === 1) {
          resolved.push({ entityType: "person", entityId: candidates[0].id });
        }
      } else if (mention.entityType === "company") {
        const { companyStorage } = await import("../company-storage");
        const match = await companyStorage.resolve(mention.name);
        if (match && match.name.toLowerCase() === mention.name.toLowerCase().trim()) {
          resolved.push({ entityType: "company", entityId: match.id });
        }
      } else if (mention.entityType === "project") {
        const { fileProjectStorage } = await import("../file-storage/projects");
        const projects = await fileProjectStorage.getProjects();
        const match = projects.find(
          (project) => project.title.toLowerCase() === mention.name.toLowerCase(),
        );
        if (match) {
          resolved.push({ entityType: "project", entityId: String(match.id) });
        }
      } else if (mention.entityType === "goal") {
        const { goalStorage } = await import("../goal-storage");
        const goals = await goalStorage.listGoals({ search: mention.name, includeDormant: true });
        if (goals.length === 1) {
          resolved.push({ entityType: "goal", entityId: goals[0].id });
        }
      }
    } catch (err: unknown) {
      log.debug(JSON.stringify({
        event: "memory.vnext.entity_resolution_failed",
        mention: mention.name,
        entityType: mention.entityType,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  return resolved;
}
