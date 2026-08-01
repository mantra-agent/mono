import { inArray } from "drizzle-orm";
import type {
  GraphAdapterResult,
  GraphEdge,
  GraphNode,
  PersonalGraphAdapter,
} from "@shared/life-addressing";
import { extractPositionedReferences } from "@shared/reference-parser";
import { opportunityInteractions, opportunityArtifacts } from "@shared/schema";
import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { createLogger } from "../log";
import { db } from "../db";
import { combineWithVisibleScope } from "../scoped-storage";
import { peopleStorage, type Person } from "../people-storage";
import { opportunityStorage } from "../opportunity-storage";

const log = createLogger("RelationshipGraphAdapter");

const PEOPLE_LIMIT = 1_000;
const OPPORTUNITY_LIMIT = 500;
const INTERACTIONS_PER_PERSON = 25;
const AUTHORED_REF_SOURCE_LIMIT = 50;
const RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/** People/Companies/Interactions/Opportunities topology is domain-owned; set
 *  to "false" to roll back just this projection without a redeploy. */
export function relationshipGraphAdapterEnabled(): boolean {
  return process.env.RELATIONSHIP_GRAPH_ADAPTER_ENABLED !== "false";
}

function boundedLimit(requested: number, ceiling: number): number {
  if (!Number.isInteger(requested) || requested < 1) return ceiling;
  return Math.min(requested, ceiling);
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
  return { id, from, to, predicate, sourceClass, weight, ...(updatedAt ? { updatedAt } : {}) };
}

function interactionAddress(personId: string, interactionId: string): string {
  return `@interaction:${encodeURIComponent(personId)}~${encodeURIComponent(interactionId)}`;
}

/**
 * Emit authored-reference candidate edges from compact structured domain text
 * (interaction summaries, opportunity descriptions). These are small fields,
 * never page or corpus bodies, so parsing them in the foreground read does not
 * violate the no-body-parsing invariant.
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
        `rel:${sourceAddress}:references:${targetAddress}`,
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

interface RelationshipCounts {
  people: number;
  companyEdges: number;
  introducedByEdges: number;
  interactionNodes: number;
  interactionEdges: number;
  interactionAuthored: number;
  opportunities: number;
  opportunityCompanyEdges: number;
  opportunityPersonEdges: number;
  opportunityInteractionEdges: number;
  opportunityArtifactEdges: number;
  opportunityAuthored: number;
}

async function projectPeople(
  people: Person[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  counts: RelationshipCounts,
): Promise<void> {
  // Resolve every introducedBy value through the principal-visible alias graph
  // in one batch so absorbed introducer IDs redirect to the survivor, and free
  // text names (not Person IDs) simply drop without fabricating a relationship.
  const introducerRaw = [...new Set(
    people.map(person => person.introducedBy?.trim()).filter((value): value is string => !!value),
  )];
  // Resolve each distinct value individually so a raw absorbed Person ID maps
  // to its surviving canonical Person ID; the alias graph is TTL-cached, and the
  // distinct-introducer set is far smaller than the visible-people set.
  const introducerCanonical = new Map<string, string>();
  for (const raw of introducerRaw) {
    const [match] = await peopleStorage.getPeopleByIds([raw]);
    if (match) introducerCanonical.set(raw, match.id);
  }

  for (const person of people) {
    const personAddress = `@person:${person.id}`;
    const personSummary = [person.role, person.company, person.relation].filter(Boolean).join(" · ") || undefined;
    nodes.push(node(personAddress, "person", person.name, personSummary, person.updatedAt));
    counts.people += 1;

    if (person.companyId) {
      edges.push(edge(`rel:person:${person.id}:affiliated_with`, personAddress, `@company:${person.companyId}`, "affiliated_with", 0.9, "domain", person.updatedAt));
      counts.companyEdges += 1;
    }

    const introducerId = person.introducedBy ? introducerCanonical.get(person.introducedBy.trim()) : undefined;
    if (introducerId && introducerId !== person.id) {
      edges.push(edge(`rel:person:${person.id}:introduced_by`, personAddress, `@person:${introducerId}`, "introduced_by", 0.8, "domain"));
      counts.introducedByEdges += 1;
    }

    let interactionCount = 0;
    for (const interaction of person.interactions) {
      if (interactionCount >= INTERACTIONS_PER_PERSON) break;
      interactionCount += 1;
      const address = interactionAddress(person.id, interaction.id);
      const label = `${person.name}: ${interaction.summary}`.slice(0, 120);
      nodes.push(node(address, "interaction", label, interaction.context || undefined, interaction.date));
      edges.push(edge(`rel:person:${person.id}:has_interaction:${interaction.id}`, personAddress, address, "has_interaction", 0.7, "domain", interaction.date));
      counts.interactionNodes += 1;
      counts.interactionEdges += 1;
      const authored = authoredEdges(address, [interaction.summary, interaction.context]);
      edges.push(...authored);
      counts.interactionAuthored += authored.length;
    }
  }
}

async function projectOpportunities(
  principal: Principal,
  limit: number,
  nodes: GraphNode[],
  edges: GraphEdge[],
  counts: RelationshipCounts,
): Promise<void> {
  const opportunities = (await opportunityStorage.list(principal)).slice(0, limit);
  if (opportunities.length === 0) return;
  const opportunityIds = opportunities.map(opportunity => opportunity.id);

  const interactionLinkScope = {
    scope: opportunityInteractions.scope,
    ownerUserId: opportunityInteractions.ownerUserId,
    accountId: opportunityInteractions.accountId,
  };
  const [interactionLinks, artifactRows] = await Promise.all([
    db.select({
      opportunityId: opportunityInteractions.opportunityId,
      personId: opportunityInteractions.personId,
      interactionId: opportunityInteractions.interactionId,
    }).from(opportunityInteractions).where(
      combineWithVisibleScope(principal, interactionLinkScope, inArray(opportunityInteractions.opportunityId, opportunityIds)),
    ),
    // opportunity_artifacts has no independent scope columns; it is scoped by
    // the already principal-visible opportunity IDs. Endpoint (Page/Session)
    // visibility is still independently authorized by the assembler.
    db.select({
      opportunityId: opportunityArtifacts.opportunityId,
      libraryPageId: opportunityArtifacts.libraryPageId,
      sessionId: opportunityArtifacts.sessionId,
      updatedAt: opportunityArtifacts.updatedAt,
    }).from(opportunityArtifacts).where(inArray(opportunityArtifacts.opportunityId, opportunityIds)),
  ]);

  for (const opportunity of opportunities) {
    const opportunityAddress = `@opportunity:${opportunity.id}`;
    const updatedAt = opportunity.updatedAt instanceof Date ? opportunity.updatedAt.toISOString() : (opportunity.updatedAt as string | null);
    nodes.push(node(opportunityAddress, "opportunity", opportunity.title, opportunity.description || `${opportunity.type} · ${opportunity.status}`, updatedAt));
    counts.opportunities += 1;

    if (opportunity.companyId) {
      edges.push(edge(`rel:opportunity:${opportunity.id}:at_company`, opportunityAddress, `@company:${opportunity.companyId}`, "at_company", 0.9, "domain", updatedAt));
      counts.opportunityCompanyEdges += 1;
    }
    if (opportunity.contactPersonId) {
      edges.push(edge(`rel:opportunity:${opportunity.id}:has_contact`, opportunityAddress, `@person:${opportunity.contactPersonId}`, "has_contact", 0.8, "domain", updatedAt));
      counts.opportunityPersonEdges += 1;
    }
    if (opportunity.championPersonId) {
      edges.push(edge(`rel:opportunity:${opportunity.id}:has_champion`, opportunityAddress, `@person:${opportunity.championPersonId}`, "has_champion", 0.85, "domain", updatedAt));
      counts.opportunityPersonEdges += 1;
    }

    const authored = authoredEdges(opportunityAddress, [opportunity.description, opportunity.nextSteps, opportunity.followUpNote]);
    edges.push(...authored);
    counts.opportunityAuthored += authored.length;
  }

  const seenInteraction = new Set<string>();
  for (const link of interactionLinks) {
    const key = `${link.opportunityId}:${link.personId}:${link.interactionId}`;
    if (seenInteraction.has(key)) continue;
    seenInteraction.add(key);
    edges.push(edge(
      `rel:opportunity:${link.opportunityId}:has_activity:${link.personId}~${link.interactionId}`,
      `@opportunity:${link.opportunityId}`,
      interactionAddress(link.personId, link.interactionId),
      "has_activity",
      0.7,
      "domain",
    ));
    counts.opportunityInteractionEdges += 1;
  }

  for (const artifact of artifactRows) {
    const updatedAt = artifact.updatedAt instanceof Date ? artifact.updatedAt.toISOString() : (artifact.updatedAt as string | null);
    edges.push(edge(
      `rel:opportunity:${artifact.opportunityId}:has_artifact:${artifact.libraryPageId}`,
      `@opportunity:${artifact.opportunityId}`,
      `@page:${artifact.libraryPageId}`,
      "has_artifact",
      0.7,
      "domain",
      updatedAt,
    ));
    counts.opportunityArtifactEdges += 1;
    if (artifact.sessionId) {
      edges.push(edge(
        `rel:opportunity:${artifact.opportunityId}:produced_by_session:${artifact.sessionId}`,
        `@opportunity:${artifact.opportunityId}`,
        `@session:${artifact.sessionId}`,
        "produced_by_session",
        0.6,
        "domain",
        updatedAt,
      ));
      counts.opportunityArtifactEdges += 1;
    }
  }
}

/**
 * Domain-owned People + Companies + Interactions + Opportunities projection.
 * `persons`, `person.companyId`, embedded interactions, and the Opportunity
 * relationship tables remain the authority; this adapter emits canonical
 * candidates only. The graph assembler independently resolves and authorizes
 * every endpoint before exposing an edge, so a projected affiliation,
 * introduction, activity, or artifact can never grant visibility. Person
 * merges are honored because both the People resolver and the assembler
 * redirect absorbed Person addresses to the surviving Person.
 */
export const relationshipGraphAdapter: PersonalGraphAdapter<Principal> = {
  id: "relationships",
  sourceClass: "domain",
  async project(principal, input): Promise<GraphAdapterResult> {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw Object.assign(new Error("Relationship graph projection requires an authenticated user principal"), { status: 401 });
    }
    if (!relationshipGraphAdapterEnabled()) {
      return { nodes: [], edges: [] };
    }

    const peopleLimit = boundedLimit(input.limit, PEOPLE_LIMIT);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const counts: RelationshipCounts = {
      people: 0, companyEdges: 0, introducedByEdges: 0, interactionNodes: 0, interactionEdges: 0,
      interactionAuthored: 0, opportunities: 0, opportunityCompanyEdges: 0, opportunityPersonEdges: 0,
      opportunityInteractionEdges: 0, opportunityArtifactEdges: 0, opportunityAuthored: 0,
    };

    await runWithPrincipal(principal, async () => {
      const index = await peopleStorage.listPeople();
      const ids = index.slice(0, peopleLimit).map(entry => entry.id);
      const people = await peopleStorage.getPeopleByIds(ids);
      await projectPeople(people, nodes, edges, counts);
      await projectOpportunities(principal, OPPORTUNITY_LIMIT, nodes, edges, counts);
    });

    log.info(
      `[relationship-graph] people=${counts.people} companyEdges=${counts.companyEdges} introducedBy=${counts.introducedByEdges} ` +
        `interactionNodes=${counts.interactionNodes} interactionEdges=${counts.interactionEdges} interactionAuthored=${counts.interactionAuthored} ` +
        `opportunities=${counts.opportunities} oppCompany=${counts.opportunityCompanyEdges} oppPerson=${counts.opportunityPersonEdges} ` +
        `oppActivity=${counts.opportunityInteractionEdges} oppArtifact=${counts.opportunityArtifactEdges} oppAuthored=${counts.opportunityAuthored}`,
    );

    return { nodes, edges };
  },
};
