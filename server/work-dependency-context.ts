/**
 * Work dependency-context resolver — Core read-only projection over blocked_by.
 *
 * Single canonical API for planning/selection/sequencing/scheduling/capacity/
 * autonomy consumers. Reads address_links through principal-scoped list helpers,
 * resolves endpoints through address-resolver, and never mutates the graph or
 * invents edges from titles/status.
 *
 * Contract: shared/work-dependency-context.ts
 * Mutation boundary: BlockingGraphService / shared/blocked-by-protocol.ts
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { BLOCKED_BY_PREDICATE, isBlockedByEndpointType } from "@shared/blocked-by-protocol";
import { normalizeProtocolAddress } from "@shared/life-addressing";
import {
  WORK_DEPENDENCY_CONTEXT_BOUNDS,
  WORK_DEPENDENCY_SATISFIED_STATUSES,
  isWorkDependencyContextPurpose,
  type WorkDependencyBlocker,
  type WorkDependencyBlockerSatisfaction,
  type WorkDependencyContextRequest,
  type WorkDependencyContextResult,
  type WorkDependencyContextPurpose,
  type WorkDependencyState,
  type WorkDependencyUnavailable,
} from "@shared/work-dependency-context";
import { milestones, projects, tasks } from "@shared/schema";
import {
  resolveAddressBatch,
  type AddressResolutionResult,
} from "./address-resolver";
import { db } from "./db";
import { featureStorage } from "./feature-storage";
import { goalStorage } from "./goal-storage";
import { listAddressLinks } from "./life-addressing-storage";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { requireCurrentUserPrincipal } from "./principal-context";
import {
  combineWithProjectAccess,
  combineWithProjectDerivedWorkAccess,
  combineWithTaskAccess,
} from "./project-vault-access";

const log = createLogger("WorkDependencyContext");

const taskScope = {
  objectId: tasks.id,
  projectId: tasks.projectId,
  scope: tasks.scope,
  ownerUserId: tasks.ownerUserId,
  accountId: tasks.accountId,
};
const milestoneScope = {
  objectId: milestones.id,
  projectId: milestones.projectId,
  scope: milestones.scope,
  ownerUserId: milestones.ownerUserId,
  accountId: milestones.accountId,
};

interface DomainSnapshot {
  status?: string;
  owner?: string;
  label?: string;
}

interface EdgeRecord {
  id: string;
  sourceAddress: string;
  targetAddress: string;
  provenanceAddress?: string | null;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeRequestedAddress(raw: string): { ok: true; address: string } | { ok: false; address: string } {
  const trimmed = raw?.trim() ?? "";
  const normalized = normalizeProtocolAddress(trimmed);
  if (normalized.outcome !== "valid") {
    return { ok: false, address: trimmed || raw };
  }
  return { ok: true, address: normalized.address };
}

function parseWorkRef(address: string): { type: string; id: string } | null {
  const match = /^@([a-z_]+):(.+)$/i.exec(address);
  if (!match) return null;
  return { type: match[1].toLowerCase(), id: match[2] };
}

function satisfactionFor(
  type: string | undefined,
  status: string | undefined,
  resolution: AddressResolutionResult | undefined,
): WorkDependencyBlockerSatisfaction {
  if (!resolution) return "unknown";
  if (resolution.outcome === "unauthorized") return "inaccessible";
  if (resolution.outcome === "invalid" || resolution.outcome === "unknown_type") return "unknown";
  if (resolution.outcome === "missing" || resolution.outcome === "error") return "unknown";
  if (!type || !isBlockedByEndpointType(type)) return "unknown";
  if (!status) return "unresolved";
  const satisfied = WORK_DEPENDENCY_SATISFIED_STATUSES[type];
  return satisfied.has(status) ? "satisfied" : "unresolved";
}

async function loadDomainSnapshots(
  principal: Principal,
  addresses: readonly string[],
): Promise<Map<string, DomainSnapshot>> {
  const out = new Map<string, DomainSnapshot>();
  const taskIds: number[] = [];
  const projectIds: number[] = [];
  const milestoneKeys: Array<{ projectId: number; milestoneId: number; address: string }> = [];
  const featureIds: string[] = [];
  const goalIds: string[] = [];

  for (const address of addresses) {
    const ref = parseWorkRef(address);
    if (!ref) continue;
    if (ref.type === "task") {
      const id = Number(ref.id);
      if (Number.isInteger(id)) taskIds.push(id);
    } else if (ref.type === "project") {
      const id = Number(ref.id);
      if (Number.isInteger(id)) projectIds.push(id);
    } else if (ref.type === "milestone") {
      const [projectId, milestoneId] = ref.id.split("~").map(Number);
      if (Number.isInteger(projectId) && Number.isInteger(milestoneId)) {
        milestoneKeys.push({ projectId, milestoneId, address });
      }
    } else if (ref.type === "feature") {
      featureIds.push(ref.id);
    } else if (ref.type === "goal") {
      goalIds.push(ref.id);
    }
  }

  await Promise.all([
    taskIds.length
      ? db
          .select({
            id: tasks.id,
            title: tasks.title,
            status: tasks.status,
            ownerPersonId: tasks.ownerPersonId,
          })
          .from(tasks)
          .where(combineWithTaskAccess(principal, taskScope, "read", inArray(tasks.id, taskIds)))
          .then((rows) => {
            for (const row of rows) {
              out.set(`@task:${row.id}`, {
                label: row.title,
                status: row.status,
                owner: row.ownerPersonId ? `@person:${row.ownerPersonId}` : undefined,
              });
            }
          })
      : Promise.resolve(),
    projectIds.length
      ? db
          .select({
            id: projects.id,
            title: projects.title,
            status: projects.status,
            ownerPersonId: projects.ownerPersonId,
          })
          .from(projects)
          .where(combineWithProjectAccess(principal, "read", inArray(projects.id, projectIds)))
          .then((rows) => {
            for (const row of rows) {
              out.set(`@project:${row.id}`, {
                label: row.title,
                status: row.status,
                owner: row.ownerPersonId ? `@person:${row.ownerPersonId}` : undefined,
              });
            }
          })
      : Promise.resolve(),
    milestoneKeys.length
      ? db
          .select({
            id: milestones.id,
            projectId: milestones.projectId,
            name: milestones.name,
            status: milestones.status,
          })
          .from(milestones)
          .where(
            combineWithProjectDerivedWorkAccess(
              principal,
              milestoneScope,
              "milestone",
              "read",
              or(
                ...milestoneKeys.map((key) =>
                  and(eq(milestones.projectId, key.projectId), eq(milestones.id, key.milestoneId)),
                ),
              ),
            ),
          )
          .then((rows) => {
            for (const row of rows) {
              out.set(`@milestone:${row.projectId}~${row.id}`, {
                label: row.name,
                status: row.status,
              });
            }
          })
      : Promise.resolve(),
    featureIds.length
      ? Promise.all(
          featureIds.map(async (id) => {
            const row = await featureStorage.get(id) as
              | { id?: string; summary?: string; stage?: string; owner_person_id?: string }
              | undefined;
            if (!row?.id) return;
            out.set(`@feature:${row.id}`, {
              label: row.summary,
              status: row.stage,
              owner: row.owner_person_id,
            });
          }),
        )
      : Promise.resolve(),
    goalIds.length
      ? Promise.all(
          goalIds.map(async (id) => {
            const goal = await goalStorage.getGoal(id);
            if (!goal) return;
            out.set(`@goal:${goal.id}`, {
              label: goal.shortName,
              status: goal.status,
              owner: goal.owner,
            });
          }),
        )
      : Promise.resolve(),
  ]);

  return out;
}

async function listActiveBlockersForSource(
  principal: Principal,
  sourceAddress: string,
  maxFanout: number,
  maxPages: number,
): Promise<{ edges: EdgeRecord[]; truncated: boolean }> {
  const edges: EdgeRecord[] = [];
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const result = await listAddressLinks(principal, {
      sourceAddress,
      predicates: [BLOCKED_BY_PREDICATE],
      lifecycle: "active",
      cursor,
      limit: Math.min(maxFanout, WORK_DEPENDENCY_CONTEXT_BOUNDS.maxFanout),
    });
    for (const link of result.items) {
      edges.push({
        id: link.id,
        sourceAddress: link.sourceAddress,
        targetAddress: link.targetAddress,
        provenanceAddress: link.provenanceAddress,
      });
      if (edges.length >= maxFanout) {
        truncated = truncated || Boolean(result.nextCursor) || result.items.length > edges.length;
        return { edges: edges.slice(0, maxFanout), truncated: true };
      }
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
    if (page === maxPages - 1) truncated = true;
  }

  return { edges, truncated };
}

function unavailable(
  address: string,
  reason: WorkDependencyUnavailable["reason"],
  blockers: WorkDependencyBlocker[] = [],
): WorkDependencyUnavailable {
  return {
    address,
    state: "unavailable",
    reason,
    blockers,
  };
}

function buildBlocker(
  edge: EdgeRecord,
  resolution: AddressResolutionResult | undefined,
  domain: DomainSnapshot | undefined,
  transitive: boolean,
): WorkDependencyBlocker {
  const ref = parseWorkRef(edge.targetAddress);
  const status = domain?.status;
  const owner = domain?.owner;
  const label = domain?.label ?? resolution?.resolution?.label;
  const satisfaction = satisfactionFor(ref?.type, status, resolution);

  return {
    edgeId: edge.id,
    sourceAddress: edge.sourceAddress,
    targetAddress: edge.targetAddress,
    predicate: BLOCKED_BY_PREDICATE,
    ...(edge.provenanceAddress ? { provenanceAddress: edge.provenanceAddress } : {}),
    ...(label ? { label } : {}),
    ...(status ? { status } : {}),
    ...(owner ? { owner } : {}),
    satisfaction,
    ...(transitive ? { transitive: true } : {}),
  };
}

function classifyItem(
  address: string,
  blockers: WorkDependencyBlocker[],
  truncated: boolean,
): WorkDependencyState {
  if (blockers.length === 0) {
    return {
      address,
      state: "ready",
      blockers: [],
      ...(truncated ? { truncated: true } : {}),
    };
  }

  const hasUnresolved = blockers.some((b) => b.satisfaction === "unresolved");
  if (hasUnresolved) {
    return {
      address,
      state: "blocked",
      blockers,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  const staleReasons = new Set<WorkDependencyStaleReason>();
  for (const blocker of blockers) {
    if (blocker.satisfaction === "satisfied") staleReasons.add("satisfied_edge");
    if (blocker.satisfaction === "inaccessible") staleReasons.add("inaccessible_target");
    if (blocker.satisfaction === "unknown") staleReasons.add("invalid_target");
  }

  return {
    address,
    state: "stale",
    blockers,
    staleReasons: [...staleReasons],
    ...(truncated ? { truncated: true } : {}),
  };
}

type WorkDependencyStaleReason = "satisfied_edge" | "inaccessible_target" | "invalid_target";

/**
 * Resolve bounded dependency context for the given addresses.
 * Requires an authenticated user principal (ALS or explicit).
 */
export async function resolveWorkDependencyContext(
  request: WorkDependencyContextRequest,
  principalInput?: Principal,
): Promise<WorkDependencyContextResult> {
  const principal = principalInput ?? requireCurrentUserPrincipal();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw Object.assign(new Error("Work dependency context requires an authenticated user principal"), {
      status: 401,
    });
  }

  if (!isWorkDependencyContextPurpose(request.purpose)) {
    throw Object.assign(
      new Error(
        `purpose must be one of: ${[
          "planning",
          "selection",
          "sequencing",
          "scheduling",
          "capacity",
          "autonomy",
          "work",
          "dependency",
        ].join(", ")}`,
      ),
      { status: 400 },
    );
  }

  const purpose: WorkDependencyContextPurpose = request.purpose;
  const maxDepth = clampInt(
    request.maxDepth,
    1,
    WORK_DEPENDENCY_CONTEXT_BOUNDS.maxDepth,
    WORK_DEPENDENCY_CONTEXT_BOUNDS.defaultDepth,
  );
  const maxFanout = clampInt(
    request.maxFanout,
    1,
    WORK_DEPENDENCY_CONTEXT_BOUNDS.maxFanout,
    WORK_DEPENDENCY_CONTEXT_BOUNDS.maxFanout,
  );
  const maxAddresses = WORK_DEPENDENCY_CONTEXT_BOUNDS.maxAddresses;
  const maxEdges = WORK_DEPENDENCY_CONTEXT_BOUNDS.maxEdges;
  const maxPages = WORK_DEPENDENCY_CONTEXT_BOUNDS.maxPagesPerAddress;

  const rawAddresses = request.addresses ?? [];
  const items: WorkDependencyState[] = [];
  let globalTruncated = false;
  let edgeBudget = maxEdges;

  if (rawAddresses.length > maxAddresses) {
    globalTruncated = true;
  }

  const limited = rawAddresses.slice(0, maxAddresses);
  const overflow = rawAddresses.slice(maxAddresses);

  // Preserve input order for in-budget addresses.
  const normalizedInputs = limited.map((raw) => normalizeRequestedAddress(raw));

  // Collect direct edges first (depth 1).
  const directBySource = new Map<
    string,
    { edges: EdgeRecord[]; truncated: boolean; error?: true }
  >();
  const allTargetAddresses = new Set<string>();

  for (const entry of normalizedInputs) {
    if (!entry.ok) continue;
    if (edgeBudget <= 0) {
      directBySource.set(entry.address, { edges: [], truncated: true });
      globalTruncated = true;
      continue;
    }
    try {
      const page = await listActiveBlockersForSource(
        principal,
        entry.address,
        Math.min(maxFanout, edgeBudget),
        maxPages,
      );
      edgeBudget -= page.edges.length;
      if (page.truncated || edgeBudget <= 0) {
        globalTruncated = true;
        page.truncated = true;
      }
      directBySource.set(entry.address, page);
      for (const edge of page.edges) allTargetAddresses.add(edge.targetAddress);
    } catch (error) {
      log.warn("list blockers failed", {
        address: entry.address,
        error: error instanceof Error ? error.message : String(error),
      });
      directBySource.set(entry.address, { edges: [], truncated: false, error: true });
    }
  }

  // Optional depth-2: blockers of direct targets (not re-expanded as sources in output).
  const transitiveByTarget = new Map<string, EdgeRecord[]>();
  if (maxDepth >= 2) {
    const depth2Sources = [...allTargetAddresses].slice(0, maxAddresses);
    for (const target of depth2Sources) {
      if (edgeBudget <= 0) {
        globalTruncated = true;
        break;
      }
      try {
        const page = await listActiveBlockersForSource(
          principal,
          target,
          Math.min(maxFanout, edgeBudget),
          maxPages,
        );
        edgeBudget -= page.edges.length;
        if (page.truncated || edgeBudget <= 0) globalTruncated = true;
        transitiveByTarget.set(target, page.edges);
        for (const edge of page.edges) allTargetAddresses.add(edge.targetAddress);
      } catch {
        // Fail soft on transitive hop — direct blockers still classify.
      }
    }
  }

  const addressesToResolve = new Set<string>();
  for (const entry of normalizedInputs) {
    if (entry.ok) addressesToResolve.add(entry.address);
  }
  for (const address of allTargetAddresses) addressesToResolve.add(address);

  const resolveList = [...addressesToResolve];
  const resolutionByAddress = new Map<string, AddressResolutionResult>();
  for (let offset = 0; offset < resolveList.length; offset += 50) {
    const batch = resolveList.slice(offset, offset + 50);
    try {
      const results = await resolveAddressBatch(principal, batch);
      results.forEach((result, index) => {
        resolutionByAddress.set(batch[index], result);
      });
    } catch (error) {
      log.warn("address batch resolve failed", {
        batchSize: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const address of batch) {
        resolutionByAddress.set(address, {
          requestedAddress: address,
          outcome: "error",
        });
      }
    }
  }

  const domainSnapshots = await loadDomainSnapshots(principal, resolveList);

  for (const entry of normalizedInputs) {
    if (!entry.ok) {
      items.push(unavailable(entry.address, "invalid_address"));
      continue;
    }

    const sourceResolution = resolutionByAddress.get(entry.address);
    if (sourceResolution?.outcome === "unauthorized") {
      items.push(unavailable(entry.address, "unauthorized"));
      continue;
    }
    if (sourceResolution?.outcome === "error") {
      items.push(unavailable(entry.address, "resolution_error"));
      continue;
    }

    const direct = directBySource.get(entry.address);
    if (direct?.error) {
      items.push(unavailable(entry.address, "resolution_error"));
      continue;
    }

    const blockers: WorkDependencyBlocker[] = [];
    let itemTruncated = Boolean(direct?.truncated);

    for (const edge of direct?.edges ?? []) {
      const targetResolution = resolutionByAddress.get(edge.targetAddress);
      const domain = domainSnapshots.get(edge.targetAddress);
      blockers.push(buildBlocker(edge, targetResolution, domain, false));

      if (maxDepth >= 2) {
        const nested = transitiveByTarget.get(edge.targetAddress) ?? [];
        for (const nestedEdge of nested) {
          if (blockers.length >= maxFanout) {
            itemTruncated = true;
            break;
          }
          const nestedResolution = resolutionByAddress.get(nestedEdge.targetAddress);
          const nestedDomain = domainSnapshots.get(nestedEdge.targetAddress);
          blockers.push(buildBlocker(nestedEdge, nestedResolution, nestedDomain, true));
        }
      }

      if (blockers.length >= maxFanout) {
        itemTruncated = true;
        break;
      }
    }

    if (itemTruncated) globalTruncated = true;
    items.push(classifyItem(entry.address, blockers.slice(0, maxFanout), itemTruncated));
  }

  for (const raw of overflow) {
    const normalized = normalizeRequestedAddress(raw);
    items.push(unavailable(normalized.address, "bound_exceeded"));
  }

  const result: WorkDependencyContextResult = {
    purpose,
    predicate: BLOCKED_BY_PREDICATE,
    bounds: {
      maxAddresses,
      maxDepth,
      maxFanout,
      maxEdges,
    },
    items,
    truncated: globalTruncated,
    resolvedAt: new Date().toISOString(),
  };

  log.debug("resolved work dependency context", {
    purpose,
    requested: rawAddresses.length,
    items: items.length,
    truncated: globalTruncated,
    blocked: items.filter((item) => item.state === "blocked").length,
    ready: items.filter((item) => item.state === "ready").length,
    stale: items.filter((item) => item.state === "stale").length,
    unavailable: items.filter((item) => item.state === "unavailable").length,
  });

  return result;
}

/**
 * Compact markdown for context assembly. Empty when nothing is blocked/stale.
 */
export function formatWorkDependencyContextMarkdown(
  result: WorkDependencyContextResult,
): string {
  const actionable = result.items.filter(
    (item) => item.state === "blocked" || item.state === "stale" || item.state === "unavailable",
  );
  if (actionable.length === 0) {
    if (result.items.length === 0) return "";
    return "### Work Dependencies\nAll in-scope addresses are ready (no active blockers).";
  }

  const lines: string[] = [
    "### Work Dependencies",
    "Read-only projection of `blocked_by` edges. Do not invent edges from titles; mutate only via `blocking_graph`.",
  ];

  for (const item of actionable) {
    if (item.state === "blocked") {
      const blockerLines = item.blockers
        .filter((b) => b.satisfaction === "unresolved" || !b.transitive)
        .slice(0, 8)
        .map((b) => {
          const label = b.label ? ` ${b.label}` : "";
          const status = b.status ? ` [${b.status}]` : "";
          const owner = b.owner ? ` owner=${b.owner}` : "";
          const prov = b.provenanceAddress ? ` via ${b.provenanceAddress}` : "";
          return `  - waits on ${b.targetAddress}${label}${status}${owner}${prov}`;
        });
      lines.push(`- **blocked** ${item.address}`);
      lines.push(...blockerLines);
    } else if (item.state === "stale") {
      lines.push(
        `- **stale** ${item.address} (${item.staleReasons.join(", ")}) — review edges; satisfied or inaccessible targets remain linked`,
      );
    } else {
      lines.push(`- **unavailable** ${item.address} (${item.reason})`);
    }
  }

  if (result.truncated) {
    lines.push("- _Projection truncated by address/depth/fanout bounds._");
  }

  return lines.join("\n");
}
