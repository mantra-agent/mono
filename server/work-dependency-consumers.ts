/**
 * Work dependency consumers — deterministic first-call-site wiring over
 * resolveWorkDependencyContext for Streamline (capacity), Autonomy (execution
 * gating), and Plan execution (external durable blockers vs step order).
 *
 * Durable edges remain only in address_links via BlockingGraphService.
 * This module never mutates the graph and never invents a second dependency store.
 *
 * Contract: shared/work-dependency-context.ts
 * Resolver: server/work-dependency-context.ts
 */
import { isBlockedByEndpointType } from "@shared/blocked-by-protocol";
import { extractPositionedReferences } from "@shared/reference-parser";
import {
  WORK_DEPENDENCY_CONTEXT_BOUNDS,
  type WorkDependencyContextPurpose,
  type WorkDependencyContextResult,
  type WorkDependencyState,
} from "@shared/work-dependency-context";
import { fileProjectStorage, fileTaskStorage } from "./file-storage";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import {
  formatWorkDependencyContextMarkdown,
  resolveWorkDependencyContext,
} from "./work-dependency-context";

const log = createLogger("WorkDependencyConsumers");

const WORK_ENDPOINT_TYPES = new Set(["task", "milestone", "project", "feature", "goal"]);

export interface ExecutablePartition {
  ready: WorkDependencyState[];
  blocked: WorkDependencyState[];
  stale: WorkDependencyState[];
  unavailable: WorkDependencyState[];
}

/** Partition resolver items by discriminant for capacity / execution gates. */
export function partitionWorkDependencyStates(
  result: WorkDependencyContextResult,
): ExecutablePartition {
  const ready: WorkDependencyState[] = [];
  const blocked: WorkDependencyState[] = [];
  const stale: WorkDependencyState[] = [];
  const unavailable: WorkDependencyState[] = [];
  for (const item of result.items) {
    switch (item.state) {
      case "ready":
        ready.push(item);
        break;
      case "blocked":
        blocked.push(item);
        break;
      case "stale":
        stale.push(item);
        break;
      case "unavailable":
        unavailable.push(item);
        break;
    }
  }
  return { ready, blocked, stale, unavailable };
}

/**
 * Collect bounded ready/active task + active/planning project addresses for
 * capacity and autonomy selection. Same inventory shape as context-builder.
 */
export async function collectActiveWorkAddresses(
  limit: number = WORK_DEPENDENCY_CONTEXT_BOUNDS.maxAddresses,
): Promise<string[]> {
  const max = Math.max(1, Math.min(limit, WORK_DEPENDENCY_CONTEXT_BOUNDS.maxAddresses));
  const [allTodo, allProjects] = await Promise.all([
    fileTaskStorage.getTodoTasks(),
    fileProjectStorage.getProjects({}),
  ]);
  const addresses: string[] = [];
  for (const task of allTodo) {
    if (task.status === "active" || task.status === "ready") {
      addresses.push(`@task:${task.id}`);
    }
    if (addresses.length >= max) return addresses;
  }
  for (const project of allProjects) {
    if (project.status === "active" || project.status === "planning") {
      addresses.push(`@project:${project.id}`);
    }
    if (addresses.length >= max) break;
  }
  return addresses;
}

/** Extract blocked_by endpoint addresses from free text (plan step instructions, etc.). */
export function extractWorkEndpointAddresses(
  ...texts: Array<string | null | undefined>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    if (!text?.trim()) continue;
    for (const hit of extractPositionedReferences(text)) {
      const type = hit.ref.type.toLowerCase();
      if (!WORK_ENDPOINT_TYPES.has(type) || !isBlockedByEndpointType(type)) continue;
      const address = `@${type}:${hit.ref.id}`;
      if (seen.has(address)) continue;
      seen.add(address);
      out.push(address);
      if (out.length >= WORK_DEPENDENCY_CONTEXT_BOUNDS.maxAddresses) return out;
    }
  }
  return out;
}

function formatConsumerDigest(
  result: WorkDependencyContextResult,
  opts: { headline: string; executableGuidance: string },
): string {
  const partition = partitionWorkDependencyStates(result);
  const lines: string[] = [
    `### ${opts.headline}`,
    "Deterministic read of `blocked_by` via `resolveWorkDependencyContext`. Do not invent edges; mutate only via `blocking_graph`.",
    opts.executableGuidance,
  ];

  if (partition.blocked.length > 0) {
    lines.push("");
    lines.push("**Not executable (unresolved active blockers):**");
    for (const item of partition.blocked.slice(0, 15)) {
      const waits = item.blockers
        .filter((b) => b.satisfaction === "unresolved" || !b.transitive)
        .slice(0, 4)
        .map((b) => {
          const label = b.label ? ` ${b.label}` : "";
          const status = b.status ? ` [${b.status}]` : "";
          return `${b.targetAddress}${label}${status}`;
        });
      lines.push(
        waits.length > 0
          ? `- ${item.address} waits on ${waits.join("; ")}`
          : `- ${item.address}`,
      );
    }
  }

  if (partition.stale.length > 0) {
    lines.push("");
    lines.push("**Stale edges (review/retire, do not treat as hard blocks):**");
    for (const item of partition.stale.slice(0, 8)) {
      const reasons =
        item.state === "stale" ? item.staleReasons.join(", ") : "stale";
      lines.push(`- ${item.address} (${reasons})`);
    }
  }

  if (partition.unavailable.length > 0) {
    lines.push("");
    lines.push("**Unavailable (fail soft — do not invent readiness):**");
    for (const item of partition.unavailable.slice(0, 8)) {
      const reason = item.state === "unavailable" ? item.reason : "unavailable";
      lines.push(`- ${item.address} (${reason})`);
    }
  }

  const readyCount = partition.ready.length;
  if (readyCount > 0 && partition.blocked.length === 0 && partition.stale.length === 0) {
    lines.push("");
    lines.push(`**Executable:** ${readyCount} in-scope address(es) are ready (no active blockers).`);
  } else if (readyCount > 0) {
    lines.push("");
    lines.push(
      `**Executable:** ${readyCount} in-scope address(es) are ready. Prefer those over blocked work; when a target is blocked, prefer its ready prerequisites.`,
    );
  }

  if (result.truncated) {
    lines.push("");
    lines.push("_Projection truncated by address/depth/fanout bounds._");
  }

  // Keep the compact projection available for detail without duplicating mutation law.
  const compact = formatWorkDependencyContextMarkdown(result);
  if (compact && (partition.blocked.length > 0 || partition.stale.length > 0 || partition.unavailable.length > 0)) {
    lines.push("");
    lines.push(compact);
  }

  return lines.join("\n");
}

/**
 * Streamline / Autonomy capacity-and-selection digest over the active work set.
 * Fail-soft: returns empty string when nothing to say or resolution fails.
 */
export async function resolveCapacityDependencyDigest(
  purpose: Extract<WorkDependencyContextPurpose, "capacity" | "autonomy">,
  principal?: Principal,
): Promise<string> {
  try {
    const addresses = await collectActiveWorkAddresses();
    if (addresses.length === 0) return "";
    const result = await resolveWorkDependencyContext(
      { addresses, purpose, maxDepth: 1 },
      principal,
    );
    return formatConsumerDigest(result, {
      headline:
        purpose === "capacity"
          ? "Capacity Dependency Gate"
          : "Autonomy Dependency Gate",
      executableGuidance:
        purpose === "capacity"
          ? "Exclude every **blocked** address from executable capacity / available bandwidth. Task status is separate evidence; this graph is prerequisite truth."
          : "Do not start or advance any **blocked** address. Prefer executable prerequisites when a target is blocked. Mutate dependencies only via `blocking_graph`.",
    });
  } catch (error) {
    log.warn("capacity/autonomy dependency digest failed", {
      purpose,
      error: error instanceof Error ? error.message : String(error),
    });
    return "### Work Dependency Gate\nDependency context temporarily unavailable — do not invent blockers or readiness; fail soft and avoid starting ambiguous work.";
  }
}

export interface PlanStepDependencyInput {
  projectId?: number | null;
  goalId?: string | null;
  instructions?: string | null;
  title?: string | null;
  principal?: Principal;
}

/**
 * Plan-step digest: linked plan project/goal plus work endpoints referenced in
 * the step title/instructions. Distinguishes external durable blockers from
 * internal step order. Fail-soft.
 */
export async function resolvePlanStepDependencyDigest(
  input: PlanStepDependencyInput,
): Promise<string> {
  try {
    const addresses: string[] = [];
    const seen = new Set<string>();
    const push = (address: string) => {
      if (seen.has(address) || addresses.length >= WORK_DEPENDENCY_CONTEXT_BOUNDS.maxAddresses) return;
      seen.add(address);
      addresses.push(address);
    };

    if (input.projectId != null && Number.isFinite(Number(input.projectId))) {
      push(`@project:${Number(input.projectId)}`);
    }
    if (input.goalId?.trim()) {
      push(`@goal:${input.goalId.trim()}`);
    }
    for (const address of extractWorkEndpointAddresses(input.title, input.instructions)) {
      push(address);
    }

    if (addresses.length === 0) {
      return [
        "### Plan Work Dependencies",
        "No linked project/goal or `@task`/`@project`/`@milestone`/`@feature`/`@goal` references were found on this step.",
        "Internal plan step order is not a durable prerequisite. If this mission targets work items, inspect them with `blocking_graph.list_blockers` before treating them as executable.",
      ].join("\n");
    }

    const result = await resolveWorkDependencyContext(
      { addresses, purpose: "sequencing", maxDepth: 1 },
      input.principal,
    );
    const partition = partitionWorkDependencyStates(result);
    const guidance =
      partition.blocked.length > 0
        ? "At least one linked or referenced work item has an unresolved active blocker. That is an **external durable blocker**, not plan step order. Do not present blocked work as executable; report plan step `blocked` with the blocking address when the mission cannot proceed without it."
        : "Linked/referenced work has no unresolved active blockers in scope. Plan step N-of-M remains internal execution order only — not a substitute for `blocked_by`.";

    return formatConsumerDigest(result, {
      headline: "Plan Work Dependencies",
      executableGuidance: guidance,
    });
  } catch (error) {
    log.warn("plan step dependency digest failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "### Plan Work Dependencies\nDependency context temporarily unavailable — do not invent blockers; inspect linked work with `blocking_graph.list_blockers` before executing against a work item.";
  }
}

/** True when the skill name is a first-wave capacity/autonomy consumer. */
export function isWorkDependencySkillConsumer(skillName: string | undefined | null): boolean {
  if (!skillName) return false;
  const name = skillName.trim().toLowerCase();
  return name === "streamline" || name === "autonomy";
}

/**
 * Purpose for skill consumers. Streamline = capacity; Autonomy = autonomy.
 */
export function skillDependencyPurpose(
  skillName: string,
): Extract<WorkDependencyContextPurpose, "capacity" | "autonomy"> {
  return skillName.trim().toLowerCase() === "streamline" ? "capacity" : "autonomy";
}
