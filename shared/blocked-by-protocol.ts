/**
 * Universal blocked_by protocol — Core work-dependency contract.
 *
 * Single source of truth for the relationship semantic used by planning,
 * work mutation convenience paths, and BlockingGraphService. Durable edges
 * live only in address_links via the blocking_graph mutation boundary.
 * Read model: shared/work-dependency-context.ts + server/work-dependency-context.ts.
 * Do not invent a second graph, task.dependencies array, or plan-local
 * dependency store.
 *
 * Behavioral law for agents lives in root PLANNING.md § Universal blocked_by
 * protocol. Server boundary detail lives in server/AGENTS.md under Canonical
 * life-address resolution.
 */

/** Sole prerequisite predicate. No parallel dependency predicates. */
export const BLOCKED_BY_PREDICATE = "blocked_by" as const;

export type BlockedByPredicate = typeof BLOCKED_BY_PREDICATE;

/**
 * Closed work-noun set for blocked_by endpoints. Source and target must both
 * be in this set. Provenance may be any supporting address.
 */
export const BLOCKED_BY_ENDPOINT_TYPES = [
  "task",
  "milestone",
  "project",
  "feature",
  "goal",
] as const;

export type BlockedByEndpointType = (typeof BLOCKED_BY_ENDPOINT_TYPES)[number];

const BLOCKED_BY_ENDPOINT_TYPE_SET = new Set<string>(BLOCKED_BY_ENDPOINT_TYPES);

export function isBlockedByEndpointType(type: string): type is BlockedByEndpointType {
  return BLOCKED_BY_ENDPOINT_TYPE_SET.has(type);
}

/**
 * Edge direction (durable graph):
 *   sourceAddress  — the blocked work item (cannot proceed)
 *   targetAddress  — the prerequisite that must clear first
 *   predicate      — always blocked_by
 *
 * Reading "source blocked_by target" means source waits on target.
 */
export interface BlockedByEdgeShape {
  sourceAddress: string;
  targetAddress: string;
  predicate: BlockedByPredicate;
  provenanceAddress?: string;
}

/**
 * Mutation surface names. HTTP and the blocking_graph tool are adapters over
 * BlockingGraphService; they must not define alternate predicates or stores.
 */
export const BLOCKED_BY_MUTATION_BOUNDARY = {
  service: "BlockingGraphService",
  tool: "blocking_graph",
  httpCreate: "POST /api/blocking-graph/blocked-by",
  httpRetire: "DELETE /api/blocking-graph/blocked-by/:linkId",
  workConvenience: "blockedBy[] on work/task/project/milestone create|update",
} as const;

/**
 * Structural invariants enforced at the storage/service boundary. Callers must
 * not bypass them with domain JSON fields or free-text dependency lists.
 */
export const BLOCKED_BY_INVARIANTS = [
  "typed_canonical_addresses",
  "single_predicate_blocked_by",
  "no_self_edges",
  "no_directed_cycles",
  "principal_scoped_address_links",
  "idempotent_active_relationship",
  "optional_provenance_address",
  "retire_not_delete",
  "no_duplicate_dependency_fields",
  "goal_manager_separate",
  "closed_endpoint_types",
] as const;

export type BlockedByInvariant = (typeof BLOCKED_BY_INVARIANTS)[number];
