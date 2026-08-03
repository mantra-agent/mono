/**
 * GoalRelationshipService — canonical wrapper over the generic address_links
 * ledger for explicit Goal↔Person and Goal↔Meeting relationships.
 *
 * Goals, People, and Meetings remain authoritative in their own domains. This
 * service owns only the durable, first-class assertion that a goal is connected
 * to a person or meeting. The address_links layer provides idempotency, advisory
 * locking, principal scoping, and canonical endpoint resolution for free;
 * migration 0121 provides the structural "one active link per endpoint tuple +
 * predicate" invariant.
 *
 * Adds use a FRESH idempotency key so a relationship can be retired and later
 * re-created — a deterministic key would resurrect a retired link on re-add.
 * Idempotent re-add is expressed at the relationship level instead: an existing
 * active link is returned rather than inserting a duplicate, and the DB partial-
 * unique index is the structural backstop under concurrency.
 */
import { randomBytes } from "crypto";
import type { AddressLink } from "@shared/life-addressing";
import { requireCurrentUserPrincipal } from "./principal-context";
import { createAddressLink, listAddressLinks, retireAddressLink } from "./life-addressing-storage";
import { createLogger } from "./log";

const log = createLogger("GoalRelationshipService");

export type GoalRelationshipTargetType = "person" | "meeting";

export const GOAL_PERSON_PREDICATE = "involves_person";
export const GOAL_MEETING_PREDICATE = "references_meeting";

const PREDICATE_BY_TARGET: Record<GoalRelationshipTargetType, string> = {
  person: GOAL_PERSON_PREDICATE,
  meeting: GOAL_MEETING_PREDICATE,
};

const GOAL_RELATIONSHIP_PREDICATES = new Set<string>([GOAL_PERSON_PREDICATE, GOAL_MEETING_PREDICATE]);
const GOAL_RELATIONSHIP_PREDICATE_LIST: readonly string[] = [GOAL_PERSON_PREDICATE, GOAL_MEETING_PREDICATE];

/** Bounded page walk; a single goal or target realistically has far fewer links. */
const MAX_LINK_PAGES = 20;
/** Hard cap on relationships materialized for a single graph projection pass. */
const PROJECTION_RELATIONSHIP_CAP = 2_000;

function goalAddress(goalId: string): string {
  return `@goal:${goalId}`;
}

function targetAddressFor(type: GoalRelationshipTargetType, id: string): string {
  return `@${type}:${id}`;
}

function stripAddress(address: string): string {
  return address.replace(/^@/, "");
}

function targetTypeOf(link: AddressLink): GoalRelationshipTargetType | null {
  if (link.predicate === GOAL_PERSON_PREDICATE) return "person";
  if (link.predicate === GOAL_MEETING_PREDICATE) return "meeting";
  return null;
}

export interface GoalRelationship {
  linkId: string;
  goalId: string;
  targetType: GoalRelationshipTargetType;
  targetId: string;
  targetAddress: string;
  createdAt: string;
}

export interface ResolvedGoalRelationship extends GoalRelationship {
  label: string;
  route?: string;
}

function toRelationship(link: AddressLink): GoalRelationship | null {
  const targetType = targetTypeOf(link);
  if (!targetType) return null;
  const goalId = stripAddress(link.sourceAddress).replace(/^goal:/, "");
  const targetId = stripAddress(link.targetAddress).replace(new RegExp(`^${targetType}:`), "");
  return {
    linkId: link.id,
    goalId,
    targetType,
    targetId,
    targetAddress: link.targetAddress,
    createdAt: link.createdAt,
  };
}

export class GoalRelationshipService {
  /** Active goal-relationship links whose source is this goal. */
  private async activeLinksForGoal(goalId: string): Promise<AddressLink[]> {
    const principal = requireCurrentUserPrincipal();
    const source = goalAddress(goalId);
    const collected: AddressLink[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LINK_PAGES; page++) {
      const { items, nextCursor } = await listAddressLinks(principal, { sourceAddress: source, predicates: GOAL_RELATIONSHIP_PREDICATE_LIST, lifecycle: "active", cursor });
      collected.push(...items);
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return collected.filter((link) => GOAL_RELATIONSHIP_PREDICATES.has(link.predicate));
  }

  async listForGoal(goalId: string): Promise<GoalRelationship[]> {
    const links = await this.activeLinksForGoal(goalId);
    return links.map(toRelationship).filter((rel): rel is GoalRelationship => rel !== null);
  }

  async add(goalId: string, targetType: GoalRelationshipTargetType, targetId: string): Promise<GoalRelationship> {
    const principal = requireCurrentUserPrincipal();
    const predicate = PREDICATE_BY_TARGET[targetType];
    const target = targetAddressFor(targetType, targetId);

    // Relationship-level idempotency: return an existing active link if present.
    const existing = (await this.activeLinksForGoal(goalId)).find(
      (link) => link.predicate === predicate && stripAddress(link.targetAddress) === stripAddress(target),
    );
    if (existing) {
      const rel = toRelationship(existing);
      if (rel) return rel;
    }

    const link = await createAddressLink(principal, {
      sourceAddress: goalAddress(goalId),
      predicate,
      targetAddress: target,
      createdBy: `goal:relationship:${targetType}`,
      idempotencyKey: `goal_rel:${randomBytes(12).toString("hex")}`,
    });
    const rel = toRelationship(link);
    if (!rel) throw new Error("Goal relationship link produced an unexpected predicate");
    log.info(JSON.stringify({ event: "goal_relationship.added", goalId, targetType, targetId, linkId: link.id }));
    return rel;
  }

  async remove(goalId: string, linkId: string): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    const owned = (await this.activeLinksForGoal(goalId)).find((link) => link.id === linkId);
    if (!owned) throw Object.assign(new Error("Relationship not found for goal"), { status: 404 });
    await retireAddressLink(principal, linkId);
    log.info(JSON.stringify({ event: "goal_relationship.removed", goalId, linkId }));
  }

  /** Retire every active goal-relationship link for a goal (delete cascade). */
  async retireAllForGoal(goalId: string): Promise<number> {
    const principal = requireCurrentUserPrincipal();
    const links = await this.activeLinksForGoal(goalId);
    let retired = 0;
    for (const link of links) {
      try {
        await retireAddressLink(principal, link.id);
        retired++;
      } catch (error) {
        log.warn(`Failed to retire goal relationship ${link.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return retired;
  }

  /** Inverse query: active goals linked to a given person or meeting. */
  async listGoalsForTarget(targetType: GoalRelationshipTargetType, targetId: string): Promise<GoalRelationship[]> {
    const principal = requireCurrentUserPrincipal();
    const predicate = PREDICATE_BY_TARGET[targetType];
    const target = targetAddressFor(targetType, targetId);
    const collected: AddressLink[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LINK_PAGES; page++) {
      const { items, nextCursor } = await listAddressLinks(principal, { targetAddress: target, predicates: [predicate], lifecycle: "active", cursor });
      collected.push(...items);
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return collected
      .filter((link) => link.predicate === predicate)
      .map(toRelationship)
      .filter((rel): rel is GoalRelationship => rel !== null);
  }

  /**
   * Bounded scan of every active goal-relationship link for the principal.
   * Used by the graph projection to emit explicit goal↔person/meeting edges in
   * a single pass. Predicate-filtered at the DB layer and hard-capped so a large
   * ledger can never unbound the foreground graph read.
   */
  async listActiveForProjection(cap = PROJECTION_RELATIONSHIP_CAP): Promise<GoalRelationship[]> {
    const principal = requireCurrentUserPrincipal();
    const collected: GoalRelationship[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LINK_PAGES; page++) {
      const { items, nextCursor } = await listAddressLinks(principal, { predicates: GOAL_RELATIONSHIP_PREDICATE_LIST, lifecycle: "active", cursor });
      for (const link of items) {
        const rel = toRelationship(link);
        if (rel) collected.push(rel);
        if (collected.length >= cap) return collected;
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return collected;
  }
}

export const goalRelationshipService = new GoalRelationshipService();
