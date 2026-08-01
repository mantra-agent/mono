import type {
  GraphAdapterResult,
  GraphEdge,
  GraphNode,
  PersonalGraphAdapter,
} from "@shared/life-addressing";
import { extractPositionedReferences } from "@shared/reference-parser";
import type { GoalIndexEntry } from "@shared/models/goals";
import type { Project, Task } from "@shared/models/work";
import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { createLogger } from "../log";
import { goalsService } from "../goals-service";
import { fileProjectStorage } from "../file-storage/projects";
import { fileTaskStorage } from "../file-storage/tasks";

const log = createLogger("WorkGraphAdapter");

const WORK_GRAPH_LIMIT = 1_000;
const RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 86_400_000;
/** Authored-reference edges parsed per structured text field (never page bodies). */
const AUTHORED_REF_SOURCE_LIMIT = 50;

/** Work topology is domain-owned; set to "false" to roll back just this projection without a redeploy. */
export function workGraphAdapterEnabled(): boolean {
  return process.env.WORK_GRAPH_ADAPTER_ENABLED !== "false";
}

function boundedLimit(requested: number): number {
  if (!Number.isInteger(requested) || requested < 1) return WORK_GRAPH_LIMIT;
  return Math.min(requested, WORK_GRAPH_LIMIT);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function recency(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / MS_PER_DAY);
  return Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);
}

function node(address: string, type: string, label: string, summary: string | undefined, updatedAt: string | null | undefined): GraphNode {
  return {
    id: address,
    type,
    label: label || address,
    ...(summary ? { summary } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    recency: recency(updatedAt),
    layoutSeed: stableHash(address),
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  predicate: string,
  weight: number,
  sourceClass: GraphEdge["sourceClass"],
  updatedAt?: string | null,
): GraphEdge {
  return {
    id,
    from,
    to,
    predicate,
    sourceClass,
    weight,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * Emit authored-reference candidate edges from a compact structured domain field.
 * These are small task/project fields, never page or corpus bodies, so parsing
 * them in the foreground read does not violate the no-body-parsing invariant.
 */
function authoredEdges(sourceAddress: string, texts: Array<string | null | undefined>): GraphEdge[] {
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const { ref } of extractPositionedReferences(text)) {
      const targetAddress = ref.canonical;
      if (!targetAddress || targetAddress === sourceAddress || seen.has(targetAddress)) continue;
      seen.add(targetAddress);
      edges.push(edge(
        `work:${sourceAddress}:references:${targetAddress}`,
        sourceAddress,
        targetAddress,
        ref.type === "page" ? "references" : `references_${ref.type}`,
        0.5,
        "authored",
      ));
      if (edges.length >= AUTHORED_REF_SOURCE_LIMIT) return edges;
    }
  }
  return edges;
}

interface WorkProjectionCounts {
  goals: number;
  projects: number;
  milestones: number;
  tasks: number;
  goalHierarchyEdges: number;
  projectGoalEdges: number;
  milestoneEdges: number;
  taskEdges: number;
  participantEdges: number;
  pageArtifactEdges: number;
  fileArtifactEdges: number;
  authoredEdges: number;
}

function buildProjection(goals: GoalIndexEntry[], projects: Project[], tasks: Task[]): { nodes: GraphNode[]; edges: GraphEdge[]; counts: WorkProjectionCounts } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // In-play scope: shelved/finished work stays domain truth but is not projected as base topology.
  const inPlayGoals = goals.filter((goal) => goal.status !== "achieved");
  const inPlayProjects = projects.filter((project) => project.status !== "completed");
  const inPlayTasks = tasks.filter((task) => task.status !== "done");

  const goalIds = new Set(inPlayGoals.map((goal) => goal.id));
  const counts: WorkProjectionCounts = {
    goals: inPlayGoals.length,
    projects: inPlayProjects.length,
    milestones: 0,
    tasks: inPlayTasks.length,
    goalHierarchyEdges: 0,
    projectGoalEdges: 0,
    milestoneEdges: 0,
    taskEdges: 0,
    participantEdges: 0,
    pageArtifactEdges: 0,
    fileArtifactEdges: 0,
    authoredEdges: 0,
  };

  // --- Goals + hierarchy ---
  for (const goal of inPlayGoals) {
    const address = `@goal:${goal.id}`;
    nodes.push(node(address, "goal", goal.shortName, `${goal.horizon} goal · ${goal.status}`, goal.completedAt ?? goal.targetDate ?? null));
    if (goal.parentId && goalIds.has(goal.parentId)) {
      edges.push(edge(`work:goal:${goal.id}:child_of`, address, `@goal:${goal.parentId}`, "child_of", 1, "domain"));
      counts.goalHierarchyEdges++;
    }
  }

  // --- Projects, milestones, participants, artifacts, authored references ---
  for (const project of inPlayProjects) {
    const projectAddress = `@project:${project.id}`;
    nodes.push(node(projectAddress, "project", project.title, project.description || `${project.status} project`, project.updatedAt));

    if (project.goalId) {
      edges.push(edge(`work:project:${project.id}:pursues_goal`, projectAddress, `@goal:${project.goalId}`, "pursues_goal", 1, "domain", project.updatedAt));
      counts.projectGoalEdges++;
    }

    for (const milestone of project.milestones) {
      if (milestone.status === "completed") continue;
      const milestoneAddress = `@milestone:${project.id}~${milestone.id}`;
      nodes.push(node(milestoneAddress, "milestone", milestone.name, `milestone · ${milestone.status}`, milestone.dueDate));
      edges.push(edge(`work:milestone:${project.id}~${milestone.id}:milestone_of`, milestoneAddress, projectAddress, "milestone_of", 1, "domain"));
      counts.milestones++;
      counts.milestoneEdges++;
    }

    // Weak Project people JSON projected as canonical participant relationships.
    const seenPeople = new Set<string>();
    for (const personId of project.people) {
      const trimmed = personId?.trim();
      if (!trimmed || seenPeople.has(trimmed)) continue;
      seenPeople.add(trimmed);
      edges.push(edge(`work:project:${project.id}:has_participant:${trimmed}`, projectAddress, `@person:${trimmed}`, "has_participant", 0.8, "domain"));
      counts.participantEdges++;
    }

    // Weak Project pages JSON projected as canonical Page artifacts.
    const seenPages = new Set<string>();
    for (const page of project.pages) {
      if (!page.id || seenPages.has(page.id)) continue;
      seenPages.add(page.id);
      edges.push(edge(`work:project:${project.id}:has_artifact:${page.id}`, projectAddress, `@page:${page.id}`, "has_artifact", 0.7, "domain", page.addedAt));
      counts.pageArtifactEdges++;
    }

    // Weak Project files JSON projected as canonical File artifacts.
    const seenFiles = new Set<string>();
    for (const file of project.files) {
      if (!file.objectKey || seenFiles.has(file.objectKey)) continue;
      seenFiles.add(file.objectKey);
      edges.push(edge(`work:project:${project.id}:has_file:${file.objectKey}`, projectAddress, `@file:${file.objectKey}`, "has_artifact", 0.6, "domain", file.uploadedAt));
      counts.fileArtifactEdges++;
    }

    const projectAuthored = authoredEdges(projectAddress, [project.description, project.spec]);
    edges.push(...projectAuthored);
    counts.authoredEdges += projectAuthored.length;
  }

  // --- Tasks ---
  for (const task of inPlayTasks) {
    const taskAddress = `@task:${task.id}`;
    nodes.push(node(taskAddress, "task", task.title, task.description || `${task.status} task`, task.updatedAt));

    if (task.projectId != null) {
      edges.push(edge(`work:task:${task.id}:task_of`, taskAddress, `@project:${task.projectId}`, "task_of", 0.9, "domain", task.updatedAt));
      counts.taskEdges++;
      if (task.milestoneId != null) {
        edges.push(edge(`work:task:${task.id}:in_milestone`, taskAddress, `@milestone:${task.projectId}~${task.milestoneId}`, "in_milestone", 0.9, "domain", task.updatedAt));
        counts.taskEdges++;
      }
    }

    const taskAuthored = authoredEdges(taskAddress, [task.description, task.output]);
    edges.push(...taskAuthored);
    counts.authoredEdges += taskAuthored.length;
  }

  return { nodes, edges, counts };
}

/**
 * Domain-owned Work projection. Goal, Project, Milestone, and Task tables remain
 * the authority; this adapter emits canonical candidates only. The graph assembler
 * independently resolves and authorizes every target endpoint before exposing an
 * edge, so a projected participant/artifact/reference can never grant visibility.
 */
export const workGraphAdapter: PersonalGraphAdapter<Principal> = {
  id: "work",
  sourceClass: "domain",
  async project(principal, input): Promise<GraphAdapterResult> {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw Object.assign(new Error("Work graph projection requires an authenticated user principal"), { status: 401 });
    }
    if (!workGraphAdapterEnabled()) {
      return { nodes: [], edges: [] };
    }

    const limit = boundedLimit(input.limit);
    const [goals, projects, tasks] = await runWithPrincipal(principal, () =>
      Promise.all([
        goalsService.listAll() as Promise<GoalIndexEntry[]>,
        fileProjectStorage.getProjects() as Promise<Project[]>,
        fileTaskStorage.getTasks() as Promise<Task[]>,
      ]),
    );

    const { nodes, edges, counts } = buildProjection(
      goals.slice(0, limit),
      projects.slice(0, limit),
      tasks.slice(0, limit),
    );

    log.info(
      `[work-graph] goals=${counts.goals} projects=${counts.projects} milestones=${counts.milestones} tasks=${counts.tasks} ` +
        `goalHierarchy=${counts.goalHierarchyEdges} projectGoal=${counts.projectGoalEdges} milestoneEdges=${counts.milestoneEdges} ` +
        `taskEdges=${counts.taskEdges} participants=${counts.participantEdges} pageArtifacts=${counts.pageArtifactEdges} ` +
        `fileArtifacts=${counts.fileArtifactEdges} authored=${counts.authoredEdges}`,
    );

    return { nodes, edges };
  },
};
