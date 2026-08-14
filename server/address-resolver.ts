import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Principal } from "./principal";
import {
  createReferenceRef,
  getReferenceTypeDefinition,
  isKnownReferenceType,
  isValidReferenceIdentifier,
  REFERENCE_TYPES,
  normalizeReferenceType,
  serializeReference,
  type KnownReferenceType,
  type ReferenceRef,
} from "@shared/references";
import {
  accounts,
  agentInstances,
  businessPlans,
  companies,
  emailDrafts,
  meetingDrafts,
  emailMessages,
  documentArtifacts,
  driveResources,
  inferencePayloadCaptures,
  jobRoles,
  milestones,
  planExecutions,
  planStepAttempts,
  environmentPromotionReleases,
  platformDeploymentObservations,
  platformProductEnvironments,
  productPlatformAssociations,
  products,
  platforms,
  principleRevisions,
  principles,
  projects,
  skills,
  strategies,
  strategyMoveInstances,
  strategyAssumptions,
  strategyEndConditions,
  strategyStates,
  tasks,
  timers,
  users,
  workflowRuns,
  workflowGates,
} from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import { systemHooks } from "@shared/models/events";
import { memoryVnextClaims } from "@shared/models/memory";
import { opportunities } from "@shared/models/opportunities";
import { signalItems } from "@shared/models/signal";
import { wellnessActivities } from "@shared/models/health";
import { db } from "./db";
import { combineWithVisibleScope } from "./scoped-storage";
import { combineWithAuthorizedScope, liveObjectGrantPredicate, liveVaultGatePredicate, objectGrantIdentity } from "./authorize";
import { combineWithProjectAccess, combineWithProjectDerivedWorkAccess, combineWithTaskAccess } from "./project-vault-access";
import { libraryPageIsLive } from "./library-trash";
import { visiblePlatform } from "./platforms/platform-access";
import { principalHasPermission } from "./permissions";
import { goalsService } from "./goals-service";
import { peopleStorage } from "./people-storage";
import { chatFileStorage } from "./chat-file-storage";
import { normalizeQuestionPrompt } from "@shared/question-prompt";
import { decisionsStorage } from "./decisions-storage";
import { fileIssueStorage } from "./file-storage";
import { tagService } from "./tag-service";
import { formatBuildDeploymentLabel } from "./mods/build-deployment-home";

import { getEvent, listAllEvents } from "./google-calendar";
import { objectStorageService } from "./object_storage/objectStorage";
import { ObjectPermission } from "./object_storage/objectAcl";
import { createLogger } from "./log";
import { eventBus } from "./event-bus";

const log = createLogger("AddressResolver");

export const ADDRESS_RESOLUTION_BATCH_LIMIT = 50;

export type AddressResolutionOutcome = "resolved" | "redirected" | "missing" | "unauthorized" | "unknown_type" | "invalid" | "error";

export interface AddressResolution {
  address: string;
  type: string;
  label: string;
  summary?: string;
  route?: string;
  updatedAt?: string;
  capabilities?: string[];
}

export interface AddressResolutionResult {
  requestedAddress: string;
  outcome: AddressResolutionOutcome;
  resolution?: AddressResolution;
  redirectAddress?: string;
}

export interface AddressResolverAdapter {
  type: KnownReferenceType;
  resolve(principal: Principal, refs: readonly ReferenceRef[]): Promise<Map<string, AddressResolutionResult>>;
}

interface ResolutionFields {
  label: string;
  summary?: string | null;
  route?: string;
  updatedAt?: Date | string | null;
  capabilities?: readonly string[];
  canonicalId?: string;
}

const pageScope = { scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, vaultId: libraryPages.vaultId };
const pageOwnedColumns = {
  objectId: libraryPages.id,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};
const buildObservationScope = {
  scope: platformDeploymentObservations.scope,
  ownerUserId: platformDeploymentObservations.ownerUserId,
  accountId: platformDeploymentObservations.accountId,
};
const companyScope = { scope: companies.scope, ownerUserId: companies.ownerUserId, accountId: companies.accountId };
const principleScope = { scope: principles.scope, ownerUserId: principles.ownerUserId, accountId: principles.accountId };
const roleScope = { scope: jobRoles.scope, ownerUserId: jobRoles.ownerUserId, accountId: jobRoles.accountId };
const strategyScope = { scope: strategies.scope, ownerUserId: strategies.ownerUserId, accountId: strategies.accountId };
const opportunityScope = { scope: opportunities.scope, ownerUserId: opportunities.ownerUserId, accountId: opportunities.accountId, vaultId: opportunities.vaultId };
const skillScope = { scope: skills.scope, ownerUserId: skills.ownerUserId, accountId: skills.accountId, vaultId: skills.vaultId };
const claimScope = { scope: memoryVnextClaims.scope, ownerUserId: memoryVnextClaims.ownerUserId, accountId: memoryVnextClaims.accountId };
const wellnessScope = { ownerUserId: wellnessActivities.ownerUserId, accountId: wellnessActivities.principalAccountId };
const inferenceScope = { scope: inferencePayloadCaptures.scope, ownerUserId: inferencePayloadCaptures.ownerUserId, accountId: inferencePayloadCaptures.accountId };
const planScope = { ownerUserId: planExecutions.ownerUserId, accountId: planExecutions.accountId };
const planAttemptScope = { ownerUserId: planStepAttempts.ownerUserId, accountId: planStepAttempts.accountId };
const workflowScope = { scope: workflowRuns.scope, ownerUserId: workflowRuns.ownerUserId, accountId: workflowRuns.accountId };
const workflowGateScope = { scope: workflowGates.scope, ownerUserId: workflowGates.ownerUserId, accountId: workflowGates.accountId };
const timerScope = { scope: timers.scope, ownerUserId: timers.ownerUserId, accountId: timers.accountId };
const hookScope = { scope: systemHooks.scope, ownerUserId: systemHooks.ownerUserId, accountId: systemHooks.accountId };
const emailScope = { ownerUserId: emailMessages.ownerUserId, accountId: emailMessages.principalAccountId };
const emailDraftScope = { scope: emailDrafts.scope, ownerUserId: emailDrafts.ownerUserId, accountId: emailDrafts.accountId };
const signalScope = { scope: signalItems.scope, ownerUserId: signalItems.ownerUserId, accountId: signalItems.accountId, vaultId: signalItems.vaultId };
const taskScope = { objectId: tasks.id, projectId: tasks.projectId, scope: tasks.scope, ownerUserId: tasks.ownerUserId, accountId: tasks.accountId };
const milestoneScope = { objectId: milestones.id, projectId: milestones.projectId, scope: milestones.scope, ownerUserId: milestones.ownerUserId, accountId: milestones.accountId };

function safeSummary(value: string | null | undefined): string | undefined {
  const compact = value?.trim().replace(/\s+/g, " ");
  return compact ? compact.slice(0, 280) : undefined;
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function requestedAddress(ref: ReferenceRef): string {
  return serializeReference({ type: ref.type, id: ref.id });
}

function resolved(ref: ReferenceRef, fields: ResolutionFields): AddressResolutionResult {
  const type = normalizeReferenceType(ref.type);
  const canonicalId = fields.canonicalId ?? ref.id;
  const entry = getReferenceTypeDefinition(type);
  const address = serializeReference({ type, id: canonicalId });
  const resolution: AddressResolution = {
    address,
    type,
    label: fields.label,
    ...(safeSummary(fields.summary) ? { summary: safeSummary(fields.summary) } : {}),
    ...(fields.route ?? entry?.route?.(canonicalId) ? { route: fields.route ?? entry?.route?.(canonicalId) } : {}),
    ...(iso(fields.updatedAt) ? { updatedAt: iso(fields.updatedAt) } : {}),
    capabilities: [...(fields.capabilities ?? entry?.capabilities ?? [])],
  };
  return fields.canonicalId && fields.canonicalId !== ref.id
    ? { requestedAddress: requestedAddress(ref), outcome: "redirected", resolution, redirectAddress: address }
    : { requestedAddress: requestedAddress(ref), outcome: "resolved", resolution };
}

function resultMap(refs: readonly ReferenceRef[], outcome: AddressResolutionOutcome): Map<string, AddressResolutionResult> {
  return new Map(refs.map(ref => [requestedAddress(ref), { requestedAddress: requestedAddress(ref), outcome }]));
}

function numbers(refs: readonly ReferenceRef[]): number[] {
  return refs.map(ref => Number(ref.id)).filter(Number.isInteger);
}

function simpleAdapter(
  type: KnownReferenceType,
  resolver: AddressResolverAdapter["resolve"],
): AddressResolverAdapter {
  return { type, resolve: resolver };
}

const adapters: AddressResolverAdapter[] = [
  simpleAdapter("tag", async (principal, refs) => {
    const entries = await Promise.all(refs.map(async ref => {
      const tag = await tagService.getTag(ref.id, principal);
      if (!tag) return null;
      return [requestedAddress(ref), resolved(ref, {
        label: tag.label,
        summary: `${tag.usages.length} ${tag.usages.length === 1 ? "usage" : "usages"}`,
        route: `/tags/${encodeURIComponent(tag.slug)}`,
        updatedAt: tag.updatedAt,
        canonicalId: tag.slug,
      })] as const;
    }));
    return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
  }),
  simpleAdapter("page", async (principal, refs) => {
    const ids = refs.map(ref => ref.id);
    // Owned/visible scope OR live library_page grant OR live vault grant — same path as library reads.
    const rows = await db.select({ id: libraryPages.id, slug: libraryPages.slug, title: libraryPages.title, summary: libraryPages.summary, oneLiner: libraryPages.oneLiner, updatedAt: libraryPages.updatedAt })
      .from(libraryPages)
      .where(
        combineWithAuthorizedScope(
          principal,
          combineWithVisibleScope(principal, pageScope),
          "library_page",
          pageOwnedColumns,
          "read",
          and(or(inArray(libraryPages.id, ids), inArray(libraryPages.slug, ids)), libraryPageIsLive()),
        ),
      );
    const byId = new Map(rows.flatMap(row => [[row.id, row], [row.slug, row]] as const));
    return new Map(refs.flatMap(ref => {
      const row = byId.get(ref.id);
      return row ? [[requestedAddress(ref), resolved(ref, { canonicalId: row.id, label: row.title, summary: row.summary ?? row.oneLiner, updatedAt: row.updatedAt })]] : [];
    }));
  }),
  simpleAdapter("person", async (_principal, refs) => {
    const people = await peopleStorage.getPeopleByIds(refs.map(ref => ref.id));
    return new Map(refs.flatMap((ref, index) => {
      const person = people[index];
      return person ? [[requestedAddress(ref), resolved(ref, { canonicalId: person.id, label: person.name, summary: person.quickSummary ?? person.aiSummary, updatedAt: person.updatedAt })]] : [];
    }));
  }),
  simpleAdapter("interaction", async (_principal, refs) => {
    const parsed = refs.map(ref => ({ ref, parts: ref.id.split("~").map(decodeURIComponent) })).filter(item => item.parts.length === 2);
    const people = await peopleStorage.getPeopleByIds(parsed.map(item => item.parts[0]));
    const byId = new Map(people.map(person => [person.id, person]));
    return new Map(parsed.flatMap(({ ref, parts: [personId, interactionId] }) => {
      const person = byId.get(personId);
      const interaction = person?.interactions.find(item => item.id === interactionId);
      return person && interaction ? [[requestedAddress(ref), resolved(ref, { canonicalId: `${encodeURIComponent(person.id)}~${encodeURIComponent(interaction.id)}`, label: `${person.name}: ${interaction.summary}`, updatedAt: interaction.date })]] : [];
    }));
  }),
  simpleAdapter("company", async (principal, refs) => {
    const rows = await db.select({ id: companies.id, name: companies.name, description: companies.description, updatedAt: companies.updatedAt }).from(companies)
      .where(combineWithVisibleScope(principal, companyScope, inArray(companies.id, refs.map(ref => ref.id))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.name, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("goal", async (_principal, refs) => {
    const goals = await goalsService.listAll({ includeDormant: true });
    const wanted = new Set(refs.map(ref => ref.id));
    const byId = new Map(goals.filter(goal => wanted.has(goal.id)).map(goal => [goal.id, goal]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.shortName })]] : []));
  }),
  simpleAdapter("task", async (principal, refs) => {
    const rows = await db.select({ id: tasks.id, title: tasks.title, description: tasks.description, updatedAt: tasks.updatedAt }).from(tasks)
      .where(combineWithTaskAccess(principal, taskScope, "read", inArray(tasks.id, numbers(refs))));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("project", async (principal, refs) => {
    const rows = await db.select({ id: projects.id, title: projects.title, description: projects.description, updatedAt: projects.updatedAt }).from(projects)
      .where(combineWithProjectAccess(principal, "read", inArray(projects.id, numbers(refs))));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("business_plan", async (principal, refs) => {
    const rows = await db.select({
      id: businessPlans.id,
      name: businessPlans.name,
      vaultId: businessPlans.vaultId,
      updatedAt: businessPlans.updatedAt,
    }).from(businessPlans).where(and(
      inArray(businessPlans.id, refs.map(ref => ref.id)),
      combineWithVisibleScope(principal, { vaultId: businessPlans.vaultId }),
    ));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, {
      label: byId.get(ref.id)!.name,
      href: `/business/plan?plan=${encodeURIComponent(ref.id)}`,
      updatedAt: byId.get(ref.id)!.updatedAt,
    })]] : []));
  }),
  simpleAdapter("milestone", async (principal, refs) => {
    const parsed = refs.map(ref => ({ ref, parts: ref.id.split("~").map(Number) })).filter(item => item.parts.length === 2 && item.parts.every(Number.isInteger));
    const rows = await db.select({ id: milestones.id, projectId: milestones.projectId, name: milestones.name, updatedAt: milestones.updatedAt }).from(milestones)
      .where(combineWithProjectDerivedWorkAccess(principal, milestoneScope, "milestone", "read", or(...parsed.map(item => and(eq(milestones.projectId, item.parts[0]), eq(milestones.id, item.parts[1]))))));
    const byId = new Map(rows.map(row => [`${row.projectId}~${row.id}`, row]));
    return new Map(parsed.flatMap(({ ref }) => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.name, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("principle", async (principal, refs) => {
    const requestedIds = refs.map(ref => ref.id);
    const rows = await db.select({
      principleId: principles.id,
      revisionId: principleRevisions.id,
      title: principleRevisions.title,
      layer1: principleRevisions.layer1,
      updatedAt: principles.updatedAt,
    })
      .from(principles)
      .innerJoin(principleRevisions, and(eq(principleRevisions.id, principles.currentRevisionId), eq(principleRevisions.principleId, principles.id)))
      .where(combineWithVisibleScope(principal, principleScope, or(inArray(principles.id, requestedIds), inArray(principleRevisions.id, requestedIds))));
    const byId = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      byId.set(row.principleId, row);
      byId.set(row.revisionId, row);
    }
    return new Map(refs.flatMap(ref => {
      const row = byId.get(ref.id);
      return row ? [[requestedAddress(ref), resolved(ref, {
        label: row.title,
        summary: row.layer1,
        updatedAt: row.updatedAt,
        canonicalId: ref.id,
      })]] : [];
    }));
  }),
  simpleAdapter("role", async (principal, refs) => {
    if (!principalHasPermission(principal, "system:read")) return resultMap(refs, "unauthorized");
    const rows = await db.select({ id: jobRoles.id, title: jobRoles.title, description: jobRoles.description, updatedAt: jobRoles.updatedAt }).from(jobRoles)
      .where(combineWithVisibleScope(principal, roleScope, inArray(jobRoles.id, refs.map(ref => ref.id))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("meeting", async (_principal, refs) => {
    const sessions = await chatFileStorage.getSessions(refs.map(ref => ref.id));
    const byId = new Map(sessions.filter(session => session.type === "meeting").map(session => [session.id, session]));
    const map = new Map(refs.flatMap(ref => {
      const session = byId.get(ref.id);
      return session ? [[requestedAddress(ref), resolved(ref, { label: session.meeting?.title || session.title || "Meeting" })]] : [];
    }));
    const unresolved = refs.filter(ref => !map.has(requestedAddress(ref)));
    const coordinateRefs = unresolved.filter(ref => ref.id.split("~").length === 3);
    await Promise.all(coordinateRefs.map(async ref => {
      const [accountId, calendarId, eventId] = ref.id.split("~").map(decodeURIComponent);
      const event = await getEvent(accountId, calendarId, eventId);
      if (event) map.set(requestedAddress(ref), resolved(ref, { label: event.summary || "Calendar event" }));
    }));
    const bareRefs = unresolved.filter(ref => !map.has(requestedAddress(ref)) && ref.id.split("~").length !== 3);
    if (bareRefs.length > 0) {
      const { events } = await listAllEvents({ timeMin: new Date(Date.now() - 7 * 86400000).toISOString(), timeMax: new Date(Date.now() + 370 * 86400000).toISOString(), maxResults: 250 });
      const byEventId = new Map(events.map(event => [event.id, event]));
      for (const ref of bareRefs) {
        const event = byEventId.get(ref.id);
        if (event) map.set(requestedAddress(ref), resolved(ref, { label: event.summary || "Calendar event" }));
      }
    }
    return map;
  }),
  simpleAdapter("session", async (_principal, refs) => {
    const sessions = await chatFileStorage.getSessions(refs.map(ref => ref.id));
    const byId = new Map(sessions.map(session => [session.id, session]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title || "Untitled session" })]] : []));
  }),
  simpleAdapter("question", async (_principal, refs) => {
    const resolvedQuestions = new Map<string, AddressResolutionResult>();
    const bySession = new Map<string, ReferenceRef[]>();
    for (const ref of refs) {
      const separator = ref.id.indexOf("~");
      if (separator <= 0) continue;
      const sessionId = ref.id.slice(0, separator);
      const grouped = bySession.get(sessionId) ?? [];
      grouped.push(ref);
      bySession.set(sessionId, grouped);
    }
    for (const [sessionId, sessionRefs] of bySession) {
      // getSession returns session metadata only (no messages array); the
      // question tool call lives in the message log, so read the snapshot.
      const snapshot = await chatFileStorage.getSessionSnapshot(sessionId);
      if (!snapshot) continue;
      for (const ref of sessionRefs) {
        const toolCallId = ref.id.slice(sessionId.length + 1);
        for (const message of snapshot.messages) {
          if (!Array.isArray(message.toolCalls)) continue;
          const call = message.toolCalls.find((candidate) => {
            if (!candidate || typeof candidate !== "object") return false;
            const record = candidate as Record<string, unknown>;
            return record.toolName === "question" && record.toolCallId === toolCallId;
          }) as Record<string, unknown> | undefined;
          if (!call) continue;
          const prompt = normalizeQuestionPrompt(call.arguments);
          if (!prompt.ok) continue;
          resolvedQuestions.set(requestedAddress(ref), resolved(ref, {
            label: prompt.value.question,
            summary: prompt.value.options.map(option => option.label).join(" · "),
            updatedAt: message.createdAt,
          }));
          break;
        }
      }
    }
    return resolvedQuestions;
  }),
  simpleAdapter("inference_context", async (principal, refs) => {
    const rows = await db.select({ id: inferencePayloadCaptures.id, capturedAt: inferencePayloadCaptures.capturedAt, model: inferencePayloadCaptures.model }).from(inferencePayloadCaptures)
      .where(combineWithVisibleScope(principal, inferenceScope, and(inArray(inferencePayloadCaptures.id, refs.map(ref => ref.id)), eq(inferencePayloadCaptures.ownerUserId, principal.userId || ""), eq(inferencePayloadCaptures.accountId, principal.accountId || ""))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: `Context · ${byId.get(ref.id)!.model}`, updatedAt: byId.get(ref.id)!.capturedAt })]] : []));
  }),
  simpleAdapter("plan", async (principal, refs) => {
    const ids = refs.map(ref => ref.id);
    const rows = await db.select({ id: planExecutions.id, pageId: planExecutions.pageId, pageTitle: libraryPages.title, updatedAt: planExecutions.updatedAt }).from(planExecutions)
      .leftJoin(libraryPages, eq(planExecutions.pageId, libraryPages.id))
      .where(combineWithVisibleScope(principal, planScope, or(inArray(planExecutions.id, ids), inArray(planExecutions.pageId, ids))));
    const byId = new Map(rows.flatMap(row => [[row.id, row], ...(row.pageId ? [[row.pageId, row] as const] : [])]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) && byId.get(ref.id)!.pageTitle ? [[requestedAddress(ref), resolved(ref, { canonicalId: byId.get(ref.id)!.id, label: byId.get(ref.id)!.pageTitle!.replace(/^Plan:\s*/, ""), updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("plan_attempt", async (principal, refs) => {
    const rows = await db.select({ id: planStepAttempts.id, planId: planStepAttempts.planId, stepId: planStepAttempts.stepId, attemptNumber: planStepAttempts.attemptNumber, status: planStepAttempts.status, updatedAt: planStepAttempts.updatedAt })
      .from(planStepAttempts)
      .innerJoin(planExecutions, eq(planStepAttempts.planId, planExecutions.id))
      .where(and(
        combineWithVisibleScope(principal, planAttemptScope, inArray(planStepAttempts.id, numbers(refs))),
        combineWithVisibleScope(principal, planScope),
      ));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: `Plan attempt ${byId.get(ref.id)!.attemptNumber}`, summary: `${byId.get(ref.id)!.stepId} · ${byId.get(ref.id)!.status}`, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("workflow", async (principal, refs) => {
    const rows = await db.select({ id: workflowRuns.id, title: workflowRuns.title, updatedAt: workflowRuns.updatedAt }).from(workflowRuns)
      .where(combineWithVisibleScope(principal, workflowScope, inArray(workflowRuns.id, refs.map(ref => ref.id))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("workflow_gate", async (principal, refs) => {
    const rows = await db.select({ id: workflowGates.id, workflowRunId: workflowGates.workflowRunId, gateType: workflowGates.gateType, status: workflowGates.status, openedAt: workflowGates.openedAt })
      .from(workflowGates)
      .innerJoin(workflowRuns, eq(workflowGates.workflowRunId, workflowRuns.id))
      .where(and(
        combineWithVisibleScope(principal, workflowGateScope, inArray(workflowGates.id, numbers(refs))),
        combineWithVisibleScope(principal, workflowScope),
      ));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: `${byId.get(ref.id)!.gateType} gate`, summary: byId.get(ref.id)!.status, updatedAt: byId.get(ref.id)!.openedAt })]] : []));
  }),
  simpleAdapter("intention", async (_principal, refs) => resultMap(refs, "missing")),
  simpleAdapter("timer", async (principal, refs) => {
    const rows = await db.select({ id: timers.id, name: timers.name, description: timers.description, updatedAt: timers.updatedAt }).from(timers)
      .where(combineWithVisibleScope(principal, timerScope, inArray(timers.id, refs.map(ref => ref.id))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.name, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("hook", async (principal, refs) => {
    const rows = await db.select({ id: systemHooks.id, name: systemHooks.name, description: systemHooks.description, updatedAt: systemHooks.updatedAt }).from(systemHooks)
      .where(combineWithVisibleScope(principal, hookScope, inArray(systemHooks.id, numbers(refs))));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.name, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("decision", async (_principal, refs) => {
    const decisions = await decisionsStorage.listDecisions({});
    const wanted = new Set(refs.map(ref => ref.id));
    const byId = new Map(decisions.filter(decision => wanted.has(decision.id)).map(decision => [decision.id, decision]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title, summary: byId.get(ref.id)!.description })]] : []));
  }),
  simpleAdapter("strategy", async (principal, refs) => {
    const rows = await db.select({ id: strategies.id, title: strategies.title, description: strategies.description, updatedAt: strategies.updatedAt }).from(strategies)
      .where(combineWithVisibleScope(principal, strategyScope, inArray(strategies.id, refs.map(ref => ref.id))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("strategy_move", async (principal, refs) => {
    const rows = await db.select({ id: strategyMoveInstances.id, title: strategyMoveInstances.title, description: strategyMoveInstances.description, createdAt: strategyMoveInstances.createdAt })
      .from(strategyMoveInstances).innerJoin(strategies, eq(strategyMoveInstances.goalId, strategies.id))
      .where(and(inArray(strategyMoveInstances.id, refs.map(ref => ref.id)), combineWithVisibleScope(principal, strategyScope)));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title || `Move ${ref.id}`, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.createdAt })]] : []));
  }),
  simpleAdapter("strategy_assumption", async (principal, refs) => {
    const rows = await db.select({ id: strategyAssumptions.id, title: strategyAssumptions.title, description: strategyAssumptions.description, createdAt: strategyAssumptions.createdAt })
      .from(strategyAssumptions).innerJoin(strategies, eq(strategyAssumptions.goalId, strategies.id))
      .where(and(inArray(strategyAssumptions.id, refs.map(ref => ref.id)), combineWithVisibleScope(principal, strategyScope)));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.createdAt })]] : []));
  }),
  simpleAdapter("strategy_end_condition", async (principal, refs) => {
    const rows = await db.select({ id: strategyEndConditions.id, description: strategyEndConditions.description })
      .from(strategyEndConditions).innerJoin(strategies, eq(strategyEndConditions.goalId, strategies.id))
      .where(and(inArray(strategyEndConditions.id, refs.map(ref => ref.id)), combineWithVisibleScope(principal, strategyScope)));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: safeSummary(byId.get(ref.id)!.description) || `End condition ${ref.id}`, summary: byId.get(ref.id)!.description })]] : []));
  }),
  simpleAdapter("strategy_state", async (principal, refs) => {
    const rows = await db.select({ id: strategyStates.id, name: strategyStates.name, description: strategyStates.description, createdAt: strategyStates.createdAt })
      .from(strategyStates).innerJoin(strategies, eq(strategyStates.goalId, strategies.id))
      .where(and(inArray(strategyStates.id, refs.map(ref => ref.id)), combineWithVisibleScope(principal, strategyScope)));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.name, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.createdAt })]] : []));
  }),
  simpleAdapter("opportunity", async (principal, refs) => {
    const rows = await db.select({ id: opportunities.id, title: opportunities.title, description: opportunities.description, updatedAt: opportunities.updatedAt }).from(opportunities)
      .where(combineWithVisibleScope(principal, opportunityScope, inArray(opportunities.id, numbers(refs))));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("platform", async (principal, refs) => {
    if (!principalHasPermission(principal, "build:read")) return resultMap(refs, "unauthorized");
    const rows = await db.select({ id: platforms.id, name: platforms.name, description: platforms.description, updatedAt: platforms.updatedAt }).from(platforms)
      .where(and(inArray(platforms.id, numbers(refs)), visiblePlatform()));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.name, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("product", async (principal, refs) => {
    if (!principalHasPermission(principal, "build:read")) return resultMap(refs, "unauthorized");
    const rows = await db.select({ id: products.id, name: products.name, description: products.description, updatedAt: products.updatedAt }).from(products)
      .innerJoin(productPlatformAssociations, eq(productPlatformAssociations.productId, products.id))
      .innerJoin(platforms, eq(productPlatformAssociations.platformId, platforms.id))
      .where(and(inArray(products.id, numbers(refs)), visiblePlatform()));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.name, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("environment", async (principal, refs) => {
    if (!principalHasPermission(principal, "build:read")) return resultMap(refs, "unauthorized");
    const rows = await db.select({ id: platformProductEnvironments.id, name: platformProductEnvironments.name, productName: products.name, platformName: platforms.name, updatedAt: platformProductEnvironments.updatedAt }).from(platformProductEnvironments)
      .innerJoin(products, eq(platformProductEnvironments.productId, products.id))
      .innerJoin(platforms, eq(platformProductEnvironments.platformId, platforms.id))
      .where(and(inArray(platformProductEnvironments.id, numbers(refs)), visiblePlatform()));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: `${byId.get(ref.id)!.platformName} / ${byId.get(ref.id)!.productName} / ${byId.get(ref.id)!.name}`, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("build", async (principal, refs) => {
    if (!principalHasPermission(principal, "build:read")) return resultMap(refs, "unauthorized");
    const rows = await db.select({
      id: platformDeploymentObservations.id,
      platformEnvironmentId: platformDeploymentObservations.platformEnvironmentId,
      platformName: platformDeploymentObservations.platformName,
      productName: platformDeploymentObservations.productName,
      environmentName: platformDeploymentObservations.environmentName,
      deployedAt: platformDeploymentObservations.deployedAt,
      commitSha: platformDeploymentObservations.commitSha,
    })
      .from(platformDeploymentObservations)
      .where(combineWithVisibleScope(
        principal,
        buildObservationScope,
        inArray(platformDeploymentObservations.id, refs.map(ref => ref.id)),
      ));
    const versionByEnv = new Map<number, string>();
    const envIds = [...new Set(rows.map((row) => row.platformEnvironmentId))];
    if (envIds.length > 0) {
      const releases = await db
        .select({
          environmentId: environmentPromotionReleases.environmentId,
          version: environmentPromotionReleases.version,
        })
        .from(environmentPromotionReleases)
        .where(inArray(environmentPromotionReleases.environmentId, envIds))
        .orderBy(desc(environmentPromotionReleases.promotedAt));
      for (const release of releases) {
        if (!versionByEnv.has(release.environmentId) && release.version?.trim()) {
          versionByEnv.set(release.environmentId, release.version.trim());
        }
      }
    }
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => {
      const row = byId.get(ref.id);
      if (!row) return [];
      const version = versionByEnv.get(row.platformEnvironmentId) ?? null;
      const label = formatBuildDeploymentLabel({
        platformName: row.platformName,
        productName: row.productName,
        environmentName: row.environmentName,
        version,
        commitSha: row.commitSha,
      });
      const identity = version
        ? `v${version.replace(/^v/i, "")}`
        : row.commitSha
          ? `#${row.commitSha.slice(0, 7)}`
          : null;
      return [[requestedAddress(ref), resolved(ref, {
        label,
        summary: identity
          ? `Successful Railway deployment ${identity}`
          : "Successful Railway deployment",
        route: `/platform-environments/${encodeURIComponent(row.platformEnvironmentId)}`,
        updatedAt: row.deployedAt,
        capabilities: ["read"],
      })]];
    }));
  }),
  simpleAdapter("skill", async (principal, refs) => {
    const rows = await db.select({ id: skills.id, name: skills.name, description: skills.description, updatedAt: skills.updatedAt }).from(skills)
      .where(combineWithVisibleScope(principal, skillScope, inArray(skills.id, refs.map(ref => ref.id))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.name, summary: byId.get(ref.id)!.description, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("claim", async (principal, refs) => {
    const rows = await db.select({ id: memoryVnextClaims.id, title: memoryVnextClaims.title, content: memoryVnextClaims.content, updatedAt: memoryVnextClaims.updatedAt }).from(memoryVnextClaims)
      .where(combineWithVisibleScope(principal, claimScope, inArray(memoryVnextClaims.id, numbers(refs))));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title || safeSummary(byId.get(ref.id)!.content) || `Claim ${ref.id}`, summary: byId.get(ref.id)!.content, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("wellness_activity", async (principal, refs) => {
    const rows = await db.select({ id: wellnessActivities.id, name: wellnessActivities.name, benefit: wellnessActivities.benefit, updatedAt: wellnessActivities.updatedAt }).from(wellnessActivities)
      .where(combineWithVisibleScope(principal, wellnessScope, inArray(wellnessActivities.id, numbers(refs))));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.name, summary: byId.get(ref.id)!.benefit, updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("priority", async (_principal, refs) => {
    const goals = await goalsService.listAll({ includeDormant: true });
    const byId = new Map(goals.map(goal => [goal.id, goalsService.goalToPriority(goal)]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.title })]] : []));
  }),
  simpleAdapter("file", async (principal, refs) => {
    const durableRefs = refs.filter((ref) => !ref.id.startsWith("/objects/"));
    const legacyRefs = refs.filter((ref) => ref.id.startsWith("/objects/"));
    const map = new Map<string, AddressResolutionResult>();
    if (durableRefs.length > 0 && principal.accountId) {
      const identity = objectGrantIdentity("drive_resource", {
        objectId: driveResources.id,
        ownerUserId: driveResources.addedByUserId,
        accountId: driveResources.accountId,
        vaultId: driveResources.vaultId,
      });
      const rows = await db.select({
        id: driveResources.id,
        name: driveResources.name,
        mimeType: driveResources.mimeType,
        createdAt: driveResources.createdAt,
      }).from(driveResources).where(and(
        inArray(driveResources.id, durableRefs.map((ref) => ref.id)),
        eq(driveResources.resourceType, "file"),
        or(
          eq(driveResources.accountId, principal.accountId),
          liveObjectGrantPredicate(principal, identity, "read"),
          liveVaultGatePredicate(principal, driveResources.vaultId, "read"),
        ),
      ));
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const ref of durableRefs) {
        const row = byId.get(ref.id);
        if (row) map.set(requestedAddress(ref), resolved(ref, { label: row.name, summary: row.mimeType, updatedAt: row.createdAt }));
      }
    }
    const legacyEntries = await Promise.all(legacyRefs.map(async ref => {
      try {
        const objectFile = await objectStorageService.getObjectEntityFile(ref.id, principal);
        const allowed = await objectStorageService.canAccessObjectEntity({ principal, objectFile, requestedPermission: ObjectPermission.READ });
        if (!allowed) return null;
        const name = decodeURIComponent(ref.id.split("/").pop() || ref.id);
        return [requestedAddress(ref), resolved(ref, { label: name, route: ref.id })] as const;
      } catch {
        return null;
      }
    }));
    for (const entry of legacyEntries) if (entry) map.set(entry[0], entry[1]);
    return map;
  }),
  simpleAdapter("document", async (principal, refs) => {
    const rows = await db.select({
      id: documentArtifacts.id,
      title: documentArtifacts.title,
      mimeType: documentArtifacts.mimeType,
      byteSize: documentArtifacts.byteSize,
      updatedAt: documentArtifacts.updatedAt,
    }).from(documentArtifacts).where(combineWithVisibleScope(principal, {
      ownerUserId: documentArtifacts.ownerUserId,
      accountId: documentArtifacts.accountId,
      vaultId: documentArtifacts.vaultId,
    }, inArray(documentArtifacts.id, refs.map(ref => ref.id))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => {
      const row = byId.get(ref.id);
      return row ? [[requestedAddress(ref), resolved(ref, {
        label: row.title,
        summary: row.mimeType,
        updatedAt: row.updatedAt,
        canonicalId: row.id,
      })]] : [];
    }));
  }),
  simpleAdapter("news", async (principal, refs) => {
    const rows = await db.select({ id: signalItems.id, title: signalItems.title, curatedTitle: signalItems.curatedTitle, snippet: signalItems.snippet, curatedReason: signalItems.curatedReason, url: signalItems.url, createdAt: signalItems.createdAt }).from(signalItems)
      .where(combineWithVisibleScope(principal, signalScope, inArray(signalItems.id, refs.map(ref => ref.id))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.curatedTitle || byId.get(ref.id)!.title, summary: byId.get(ref.id)!.curatedReason || byId.get(ref.id)!.snippet, route: byId.get(ref.id)!.url, updatedAt: byId.get(ref.id)!.createdAt })]] : []));
  }),
  ...(["web_article", "x_item", "reddit_post", "rss_item"] as const).map(type => simpleAdapter(type, async (_principal, refs) => new Map(refs.map(ref => [requestedAddress(ref), resolved(ref, { label: ref.id, route: ref.id })])))),
  simpleAdapter("pr", async (_principal, refs) => new Map(refs.map(ref => [requestedAddress(ref), resolved(ref, { label: ref.id })]))),
  simpleAdapter("issue", async (principal, refs) => {
    const canTriageReported = principalHasPermission(principal, "system:read");
    const entries = await Promise.all(refs.map(async ref => {
      const id = Number(ref.id);
      if (!Number.isSafeInteger(id)) return null;
      // Own Issues resolve under ordinary scope; Build triage may also resolve
      // cross-owner kind=reported Issues via the admin owner-restore boundary.
      const issue = canTriageReported
        ? await fileIssueStorage.getIssueForAdmin(principal, id)
        : await fileIssueStorage.getIssue(id);
      return issue
        ? [requestedAddress(ref), resolved(ref, { label: issue.title || `Issue ${ref.id}`, summary: `Status: ${issue.status}`, updatedAt: issue.createdAt })] as const
        : null;
    }));
    return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
  }),
  simpleAdapter("email_thread", async (principal, refs) => {
    const parsed = refs.map(ref => ({ ref, colon: ref.id.indexOf(":") })).filter(item => item.colon > 0);
    const map = new Map<string, AddressResolutionResult>();
    for (const { ref, colon } of parsed) {
      const accountId = ref.id.slice(0, colon);
      const providerThreadId = ref.id.slice(colon + 1);
      const rows = await db.select({ subject: emailMessages.subject, fromAddress: emailMessages.fromAddress, date: emailMessages.date }).from(emailMessages)
        .where(combineWithVisibleScope(principal, emailScope, and(eq(emailMessages.accountId, accountId), eq(emailMessages.providerThreadId, providerThreadId))))
        .orderBy(desc(emailMessages.date)).limit(1);
      if (rows[0]) map.set(requestedAddress(ref), resolved(ref, { label: rows[0].subject || rows[0].fromAddress || "Email thread", updatedAt: rows[0].date }));
    }
    return map;
  }),
  simpleAdapter("email_message", async (principal, refs) => {
    const rows = await db.select({ id: emailMessages.id, subject: emailMessages.subject, fromAddress: emailMessages.fromAddress, date: emailMessages.date }).from(emailMessages)
      .where(combineWithVisibleScope(principal, emailScope, inArray(emailMessages.id, numbers(refs))));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.subject || byId.get(ref.id)!.fromAddress || "Email message", updatedAt: byId.get(ref.id)!.date })]] : []));
  }),
  simpleAdapter("email_draft", async (principal, refs) => {
    const rows = await db.select({ id: emailDrafts.id, subject: emailDrafts.subject, updatedAt: emailDrafts.updatedAt }).from(emailDrafts)
      .where(combineWithVisibleScope(principal, emailDraftScope, inArray(emailDrafts.id, refs.map(ref => ref.id))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.subject || "Email draft", updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  simpleAdapter("meeting_draft", async (principal, refs) => {
    const scope = { scope: meetingDrafts.scope, ownerUserId: meetingDrafts.ownerUserId, accountId: meetingDrafts.accountId };
    const rows = await db.select({ id: meetingDrafts.id, summary: meetingDrafts.summary, updatedAt: meetingDrafts.updatedAt }).from(meetingDrafts)
      .where(combineWithVisibleScope(principal, scope, inArray(meetingDrafts.id, refs.map(ref => ref.id))));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => byId.has(ref.id) ? [[requestedAddress(ref), resolved(ref, { label: byId.get(ref.id)!.summary || "Meeting draft", updatedAt: byId.get(ref.id)!.updatedAt })]] : []));
  }),
  // Super-admin identity nouns — users:read is the gate; not ordinary user-owned scope.
  simpleAdapter("account", async (principal, refs) => {
    if (!principalHasPermission(principal, "users:read")) return resultMap(refs, "unauthorized");
    const rows = await db.select({
      id: accounts.id,
      name: accounts.name,
      kind: accounts.kind,
      updatedAt: accounts.updatedAt,
    }).from(accounts).where(inArray(accounts.id, refs.map(ref => ref.id)));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => {
      const row = byId.get(ref.id);
      return row
        ? [[requestedAddress(ref), resolved(ref, {
          label: row.name,
          summary: row.kind,
          updatedAt: row.updatedAt,
        })]]
        : [];
    }));
  }),
  simpleAdapter("user", async (principal, refs) => {
    if (!principalHasPermission(principal, "users:read")) return resultMap(refs, "unauthorized");
    const rows = await db.select({
      id: users.id,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    }).from(users).where(inArray(users.id, refs.map(ref => ref.id)));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => {
      const row = byId.get(ref.id);
      return row
        ? [[requestedAddress(ref), resolved(ref, {
          label: row.email,
          summary: row.role,
          updatedAt: row.createdAt,
        })]]
        : [];
    }));
  }),
  simpleAdapter("agent_instance", async (principal, refs) => {
    if (!principalHasPermission(principal, "users:read")) return resultMap(refs, "unauthorized");
    const rows = await db.select({
      id: agentInstances.id,
      name: agentInstances.name,
      status: agentInstances.status,
      updatedAt: agentInstances.updatedAt,
    }).from(agentInstances).where(inArray(agentInstances.id, refs.map(ref => ref.id)));
    const byId = new Map(rows.map(row => [row.id, row]));
    return new Map(refs.flatMap(ref => {
      const row = byId.get(ref.id);
      return row
        ? [[requestedAddress(ref), resolved(ref, {
          label: row.name,
          summary: row.status,
          updatedAt: row.updatedAt,
        })]]
        : [];
    }));
  }),
];

export const ADDRESS_RESOLVER_ADAPTERS: ReadonlyMap<KnownReferenceType, AddressResolverAdapter> = new Map(adapters.map(adapter => [adapter.type, adapter]));

export function getMissingAddressResolverTypes(): KnownReferenceType[] {
  return REFERENCE_TYPES.filter(type => !ADDRESS_RESOLVER_ADAPTERS.has(type));
}

function parseInput(input: string | Pick<ReferenceRef, "type" | "id">): ReferenceRef | null {
  if (typeof input !== "string") return createReferenceRef({ type: input.type, id: input.id });
  const raw = input.trim().replace(/^@/, "");
  const colon = raw.indexOf(":");
  return colon > 0 ? createReferenceRef({ type: raw.slice(0, colon), id: raw.slice(colon + 1) }) : null;
}

export async function resolveAddressBatch(
  principal: Principal,
  inputs: readonly (string | Pick<ReferenceRef, "type" | "id">)[],
): Promise<AddressResolutionResult[]> {
  const startedAt = Date.now();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw Object.assign(new Error("Address resolution requires an authenticated user principal"), { status: 401 });
  }
  if (inputs.length > ADDRESS_RESOLUTION_BATCH_LIMIT) {
    throw Object.assign(new Error(`Too many refs (max ${ADDRESS_RESOLUTION_BATCH_LIMIT})`), { status: 400 });
  }

  const parsed = inputs.map(parseInput);
  const unique = new Map<string, ReferenceRef>();
  const immediate = new Map<string, AddressResolutionResult>();
  parsed.forEach((ref, index) => {
    const fallback = typeof inputs[index] === "string" ? String(inputs[index]) : serializeReference(inputs[index]);
    if (!ref) {
      immediate.set(fallback, { requestedAddress: fallback, outcome: "invalid" });
      return;
    }
    const type = normalizeReferenceType(ref.type);
    const address = requestedAddress(ref);
    if (!isKnownReferenceType(type)) {
      immediate.set(address, { requestedAddress: address, outcome: "unknown_type" });
      return;
    }
    if (!isValidReferenceIdentifier(type, ref.id)) {
      immediate.set(address, { requestedAddress: address, outcome: "invalid" });
      return;
    }
    unique.set(address, ref);
  });

  const byType = new Map<KnownReferenceType, ReferenceRef[]>();
  for (const ref of unique.values()) {
    const type = normalizeReferenceType(ref.type) as KnownReferenceType;
    const list = byType.get(type) ?? [];
    list.push(ref);
    byType.set(type, list);
  }

  const resolvedByAddress = new Map(immediate);
  await Promise.all([...byType].map(async ([type, refs]) => {
    const adapter = ADDRESS_RESOLVER_ADAPTERS.get(type);
    if (!adapter) {
      refs.forEach(ref => resolvedByAddress.set(requestedAddress(ref), { requestedAddress: requestedAddress(ref), outcome: "unknown_type" }));
      return;
    }
    try {
      const found = await adapter.resolve(principal, refs);
      refs.forEach(ref => resolvedByAddress.set(requestedAddress(ref), found.get(requestedAddress(ref)) ?? { requestedAddress: requestedAddress(ref), outcome: "missing" }));
    } catch {
      refs.forEach(ref => resolvedByAddress.set(requestedAddress(ref), { requestedAddress: requestedAddress(ref), outcome: "error" }));
    }
  }));

  const results = parsed.map((ref, index) => {
    const fallback = typeof inputs[index] === "string" ? String(inputs[index]) : serializeReference(inputs[index]);
    return ref ? resolvedByAddress.get(requestedAddress(ref)) ?? { requestedAddress: requestedAddress(ref), outcome: "missing" } : immediate.get(fallback)!;
  });
  const outcomeCounts = results.reduce<Record<AddressResolutionOutcome, number>>((counts, result) => {
    counts[result.outcome] += 1;
    return counts;
  }, { resolved: 0, redirected: 0, missing: 0, unauthorized: 0, unknown_type: 0, invalid: 0, error: 0 });
  const latencyMs = Date.now() - startedAt;
  log.debug("Address resolution batch", { requestedCount: inputs.length, uniqueCount: unique.size, adapterCount: byType.size, latencyMs, outcomeCounts });
  eventBus.publish({
    category: "life_addressing",
    event: "address_resolution_batch",
    payload: { requestedCount: inputs.length, uniqueCount: unique.size, adapterCount: byType.size, latencyMs, outcomeCounts },
  });
  return results;
}
