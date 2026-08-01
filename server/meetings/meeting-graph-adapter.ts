import type {
  GraphAdapterResult,
  GraphEdge,
  GraphNode,
  PersonalGraphAdapter,
} from "@shared/life-addressing";
import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { listMeetingGraphRecords, type MeetingIndexRecord } from "./meeting-index";

const MEETING_GRAPH_LIMIT = 500;
const RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/** Meeting topology can be rolled back independently while the shared graph remains canonical. */
export function meetingGraphAdapterEnabled(): boolean {
  return process.env.MEETING_GRAPH_ADAPTER_ENABLED !== "false";
}

function boundedLimit(requested: number): number {
  if (!Number.isInteger(requested) || requested < 1) return MEETING_GRAPH_LIMIT;
  return Math.min(requested, MEETING_GRAPH_LIMIT);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function recency(value: string | null): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / MS_PER_DAY);
  return Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);
}

function meetingNode(meeting: MeetingIndexRecord): GraphNode {
  const address = `@meeting:${meeting.id}`;
  const updatedAt = meeting.endedAt ?? meeting.startedAt ?? undefined;
  return {
    id: address,
    type: "meeting",
    label: meeting.title,
    ...(meeting.summary ? { summary: meeting.summary } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    recency: recency(updatedAt ?? null),
    layoutSeed: stableHash(address),
  };
}

function edge(
  meeting: MeetingIndexRecord,
  targetAddress: string,
  predicate: string,
  suffix: string,
  weight: number,
): GraphEdge {
  const sourceAddress = `@meeting:${meeting.id}`;
  return {
    id: `meeting:${meeting.id}:${predicate}:${suffix}`,
    from: sourceAddress,
    to: targetAddress,
    predicate,
    sourceClass: "domain",
    weight,
    ...(meeting.endedAt ?? meeting.startedAt
      ? { updatedAt: meeting.endedAt ?? meeting.startedAt ?? undefined }
      : {}),
  };
}

function meetingEdges(meeting: MeetingIndexRecord): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seenPeople = new Set<string>();
  for (const participant of meeting.participants) {
    if (!participant.personId || seenPeople.has(participant.personId)) continue;
    seenPeople.add(participant.personId);
    const predicate = participant.role === "organizer"
      ? "has_organizer"
      : participant.role === "speaker" ? "has_speaker" : "has_attendee";
    edges.push(edge(meeting, `@person:${participant.personId}`, predicate, participant.personId, 1));
  }

  const seenPages = new Set<string>();
  for (const artifact of meeting.artifacts) {
    if (seenPages.has(artifact.pageId)) continue;
    seenPages.add(artifact.pageId);
    const predicate = artifact.artifactKind === "agenda"
      ? "has_agenda"
      : artifact.artifactKind === "recap" ? "has_recap" : "has_artifact";
    edges.push(edge(meeting, `@page:${artifact.pageId}`, predicate, artifact.pageId, 0.9));
  }

  const seenDrafts = new Set<string>();
  for (const draftId of meeting.recapDraftIds) {
    if (seenDrafts.has(draftId)) continue;
    seenDrafts.add(draftId);
    edges.push(edge(meeting, `@email_draft:${draftId}`, "distributes_recap", draftId, 0.8));
  }
  return edges;
}

/**
 * Domain-owned Meeting projection. Session and Calendar tables remain the source
 * of truth; this adapter emits canonical candidates only. The graph assembler
 * independently authorizes target endpoints before exposing any edge.
 */
export const meetingGraphAdapter: PersonalGraphAdapter<Principal> = {
  id: "meetings-calendar",
  sourceClass: "domain",
  async project(principal, input): Promise<GraphAdapterResult> {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw Object.assign(new Error("Meeting graph projection requires an authenticated user principal"), { status: 401 });
    }
    if (!meetingGraphAdapterEnabled()) return { nodes: [], edges: [] };
    const records = await runWithPrincipal(principal, () => listMeetingGraphRecords());
    const meetings = records.slice(0, boundedLimit(input.limit));
    return {
      nodes: meetings.map(meetingNode),
      edges: meetings.flatMap(meetingEdges),
    };
  },
};
