/**
 * Work dependency-context contract — read-only projection over blocked_by.
 *
 * Durable edges remain only in address_links via BlockingGraphService.
 * This module defines the single discriminated read model consumers use for
 * planning, selection, sequencing, scheduling, capacity, and autonomy.
 * Do not duplicate edges into task JSON or invent a second graph.
 *
 * Mutation law: shared/blocked-by-protocol.ts + PLANNING.md.
 * Server implementation: server/work-dependency-context.ts.
 */

import type { BlockedByEndpointType, BlockedByPredicate } from "./blocked-by-protocol";
import { BLOCKED_BY_PREDICATE } from "./blocked-by-protocol";

/** Purposes that may load dependency context. All other contexts stay dark. */
export const WORK_DEPENDENCY_CONTEXT_PURPOSES = [
  "planning",
  "selection",
  "sequencing",
  "scheduling",
  "capacity",
  "autonomy",
  "work",
  "dependency",
] as const;

export type WorkDependencyContextPurpose =
  (typeof WORK_DEPENDENCY_CONTEXT_PURPOSES)[number];

export function isWorkDependencyContextPurpose(
  value: string,
): value is WorkDependencyContextPurpose {
  return (WORK_DEPENDENCY_CONTEXT_PURPOSES as readonly string[]).includes(value);
}

/**
 * Hard bounds for one resolver call. Callers may narrow but never exceed.
 * Depth 1 = direct blockers only; depth 2 walks one prerequisite hop.
 */
export const WORK_DEPENDENCY_CONTEXT_BOUNDS = {
  maxAddresses: 25,
  maxDepth: 2,
  defaultDepth: 1,
  maxFanout: 20,
  maxEdges: 200,
  maxPagesPerAddress: 3,
} as const;

export type WorkDependencyStateKind =
  | "ready"
  | "blocked"
  | "stale"
  | "unavailable";

/**
 * How a single prerequisite edge contributes to the source item's state.
 * Graph edges are prerequisite truth; domain status is separate evidence.
 */
export type WorkDependencyBlockerSatisfaction =
  | "unresolved"
  | "satisfied"
  | "unknown"
  | "inaccessible";

export interface WorkDependencyBlocker {
  edgeId: string;
  sourceAddress: string;
  targetAddress: string;
  predicate: BlockedByPredicate;
  provenanceAddress?: string;
  /** Compact label when the target is visible to the principal. */
  label?: string;
  /** Domain status when authorized and known (task/project/milestone/goal, or Feature stage). */
  status?: string;
  /** Execution owner when authorized and known (task/project). */
  owner?: string;
  satisfaction: WorkDependencyBlockerSatisfaction;
  /** True when this edge was discovered beyond depth 1 (prerequisite-of-blocker). */
  transitive?: boolean;
}

interface WorkDependencyStateBase {
  address: string;
  state: WorkDependencyStateKind;
  /** Direct + bounded transitive blockers examined for this address. */
  blockers: WorkDependencyBlocker[];
  truncated?: boolean;
}

export interface WorkDependencyReady extends WorkDependencyStateBase {
  state: "ready";
  blockers: [];
}

export interface WorkDependencyBlocked extends WorkDependencyStateBase {
  state: "blocked";
  blockers: WorkDependencyBlocker[];
}

export interface WorkDependencyStale extends WorkDependencyStateBase {
  state: "stale";
  blockers: WorkDependencyBlocker[];
  /** Why the graph is not actionable as a clean block. */
  staleReasons: Array<"satisfied_edge" | "inaccessible_target" | "invalid_target">;
}

export interface WorkDependencyUnavailable extends WorkDependencyStateBase {
  state: "unavailable";
  blockers: WorkDependencyBlocker[];
  reason:
    | "invalid_address"
    | "unauthorized"
    | "resolution_error"
    | "bound_exceeded"
    | "principal_required";
}

export type WorkDependencyState =
  | WorkDependencyReady
  | WorkDependencyBlocked
  | WorkDependencyStale
  | WorkDependencyUnavailable;

export interface WorkDependencyContextRequest {
  addresses: readonly string[];
  purpose: WorkDependencyContextPurpose;
  /** 1 = direct blockers only (default). 2 = one hop through blockers. */
  maxDepth?: number;
  /** Max active blocker edges retained per source address. */
  maxFanout?: number;
}

export interface WorkDependencyContextResult {
  purpose: WorkDependencyContextPurpose;
  predicate: typeof BLOCKED_BY_PREDICATE;
  bounds: {
    maxAddresses: number;
    maxDepth: number;
    maxFanout: number;
    maxEdges: number;
  };
  /** One discriminated state per requested address, same order as input. */
  items: WorkDependencyState[];
  /** True when any item hit fanout/edge/page bounds. */
  truncated: boolean;
  resolvedAt: string;
}

/**
 * Domain statuses that clear a work prerequisite without retiring the edge.
 * Feature uses pipeline stage, not Feature status. `deprecate` is not done.
 */
export const WORK_DEPENDENCY_SATISFIED_STATUSES: Record<
  BlockedByEndpointType,
  ReadonlySet<string>
> = {
  task: new Set(["done"]),
  project: new Set(["completed"]),
  milestone: new Set(["completed"]),
  goal: new Set(["achieved"]),
  feature: new Set(["maintain"]),
};
