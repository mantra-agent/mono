import { createLogger } from "../log";
import type { ClaimCandidate } from "./vnext-claim-extraction";

const log = createLogger("MemoryVnextEntityResolution");

export const VNEXT_LINKABLE_ENTITY_TYPES = ["person", "company", "project", "goal"] as const;
export type VnextLinkableEntityType = (typeof VNEXT_LINKABLE_ENTITY_TYPES)[number];

export function isVnextLinkableEntityType(value: unknown): value is VnextLinkableEntityType {
  return typeof value === "string" && (VNEXT_LINKABLE_ENTITY_TYPES as readonly string[]).includes(value);
}

export type VnextEntityResolution =
  | {
      status: "resolved";
      mention: { name: string; entityType: VnextLinkableEntityType };
      entityId: string;
      matchedBy: "canonical_name" | "alias" | "unique_name";
      matchedValue: string;
    }
  | {
      status: "unresolved";
      mention: { name: string; entityType: VnextLinkableEntityType };
    }
  | {
      status: "ambiguous";
      mention: { name: string; entityType: VnextLinkableEntityType };
      candidateCount: number;
    };

function normalizedMention(
  mention: ClaimCandidate["entityMentions"][number],
): { name: string; entityType: VnextLinkableEntityType } | null {
  const name = mention.name.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!name || !isVnextLinkableEntityType(mention.entityType)) return null;
  return { name, entityType: mention.entityType };
}

/**
 * Resolve each mention to one explicit outcome. Only an unambiguous exact
 * canonical name or active alias may become a link; unresolved and ambiguous
 * mentions remain visible diagnostics and fail closed.
 */
export async function resolveVnextEntityMentions(
  mentions: ClaimCandidate["entityMentions"],
): Promise<VnextEntityResolution[]> {
  if (mentions.length === 0) return [];
  const outcomes: VnextEntityResolution[] = [];

  for (const rawMention of mentions) {
    const mention = normalizedMention(rawMention);
    if (!mention) continue;
    try {
      if (mention.entityType === "person") {
        const { peopleStorage } = await import("../people-storage");
        const results = await peopleStorage.searchPeople(mention.name);
        const mentionLower = mention.name.toLowerCase();
        const firstNameMatches = results.filter((result) =>
          result.name.toLowerCase().split(/\s+/)[0] === mentionLower,
        );
        const startsWithMatches = firstNameMatches.length > 0
          ? firstNameMatches
          : results.filter((result) => result.name.toLowerCase().startsWith(mentionLower));
        const candidates = startsWithMatches.length > 0 ? startsWithMatches : results;
        if (candidates.length === 1) {
          outcomes.push({
            status: "resolved",
            mention,
            entityId: candidates[0].id,
            matchedBy: "unique_name",
            matchedValue: candidates[0].name,
          });
        } else if (candidates.length > 1) {
          outcomes.push({ status: "ambiguous", mention, candidateCount: candidates.length });
        } else {
          outcomes.push({ status: "unresolved", mention });
        }
        continue;
      }

      if (mention.entityType === "company") {
        const { companyStorage } = await import("../company-storage");
        const resolution = await companyStorage.resolveIdentity(mention.name);
        if (resolution.status === "resolved") {
          outcomes.push({
            status: "resolved",
            mention,
            entityId: resolution.company.id,
            matchedBy: resolution.matchedBy,
            matchedValue: resolution.matchedValue,
          });
        } else if (resolution.status === "ambiguous") {
          outcomes.push({
            status: "ambiguous",
            mention,
            candidateCount: resolution.candidateCompanyIds.length,
          });
        } else {
          outcomes.push({ status: "unresolved", mention });
        }
        continue;
      }

      if (mention.entityType === "project") {
        const { fileProjectStorage } = await import("../file-storage/projects");
        const projects = await fileProjectStorage.getProjects();
        const candidates = projects.filter(
          (project) => project.title.toLowerCase() === mention.name.toLowerCase(),
        );
        if (candidates.length === 1) {
          outcomes.push({
            status: "resolved",
            mention,
            entityId: String(candidates[0].id),
            matchedBy: "canonical_name",
            matchedValue: candidates[0].title,
          });
        } else if (candidates.length > 1) {
          outcomes.push({ status: "ambiguous", mention, candidateCount: candidates.length });
        } else {
          outcomes.push({ status: "unresolved", mention });
        }
        continue;
      }

      const { goalStorage } = await import("../goal-storage");
      const goals = await goalStorage.listGoals({ search: mention.name, includeDormant: true });
      const candidates = goals.filter(
        (goal) => goal.shortName.toLowerCase() === mention.name.toLowerCase(),
      );
      if (candidates.length === 1) {
        outcomes.push({
          status: "resolved",
          mention,
          entityId: candidates[0].id,
          matchedBy: "canonical_name",
          matchedValue: candidates[0].shortName,
        });
      } else if (candidates.length > 1) {
        outcomes.push({ status: "ambiguous", mention, candidateCount: candidates.length });
      } else {
        outcomes.push({ status: "unresolved", mention });
      }
    } catch (err: unknown) {
      outcomes.push({ status: "unresolved", mention });
      log.warn(JSON.stringify({
        event: "memory.vnext.entity_resolution_failed",
        mention: mention.name,
        entityType: mention.entityType,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  return outcomes;
}
