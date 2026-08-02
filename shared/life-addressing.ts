import {
  createReferenceRef,
  getReferenceTypeDefinition,
  isValidReferenceIdentifier,
  normalizeReferenceType,
  serializeReference,
} from "./references";

export const REFERENCE_OCCURRENCE_BATCH_LIMIT = 500;
export const REFERENCE_OCCURRENCE_SOURCE_LIMIT = 5_000;
export const REFERENCE_OCCURRENCE_INSERT_BATCH_LIMIT = 250;
export const ADDRESS_LINK_BATCH_LIMIT = 500;
export const ADDRESS_REPLAY_BATCH_LIMIT = 100;

export interface ReferenceLocation {
  blockId?: string;
  start?: number;
  end?: number;
}

export interface ReferenceOccurrence {
  sourceAddress: string;
  sourceRevision: string;
  targetAddress: string;
  location?: ReferenceLocation;
  origin: "embedded";
  observedAt: string;
}

export interface AddressLink {
  id: string;
  sourceAddress: string;
  predicate: string;
  targetAddress: string;
  provenanceAddress?: string;
  createdBy: string;
  lifecycle: "active" | "retired";
  createdAt: string;
  retiredAt?: string;
}

export type GraphSourceClass = "authored" | "explicit" | "domain" | "semantic";

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  summary?: string;
  updatedAt?: string;
  recency: number;
  vaultId?: string;
  layoutSeed: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  predicate: string;
  sourceClass: GraphSourceClass;
  weight: number;
  occurrenceCount?: number;
  updatedAt?: string;
}

export interface GraphAdapterResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nextCursor?: string;
}

/**
 * Domain adapters emit compact candidates only. The graph assembler remains
 * responsible for independently resolving both endpoints before exposure.
 */
export interface PersonalGraphAdapter<Context = unknown> {
  readonly id: string;
  readonly sourceClass: GraphSourceClass;
  project(context: Context, input: { cursor?: string; limit: number; selectedAddresses?: readonly string[] }): Promise<GraphAdapterResult>;
}

export interface AddressReplayPage<T> {
  items: T[];
  nextCursor?: string;
}

export type OccurrenceReplaceOutcome = "replaced" | "unchanged" | "stale";

export interface OccurrenceReplaceResult {
  outcome: OccurrenceReplaceOutcome;
  sourceAddress: string;
  sourceRevision: string;
  occurrenceCount: number;
}

const PROTOCOL_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const UNKNOWN_IDENTIFIER = /^[^\s\]<>]{1,2000}$/;

export type ProtocolAddressNormalization =
  | { outcome: "valid"; address: string; type: string; id: string; knownType: boolean }
  | { outcome: "invalid" };

/**
 * Normalize the envelope without requiring a registered resolver. This is the
 * narrow parser used by authored-occurrence indexing so a valid future address
 * survives until its domain adapter ships.
 */
export function normalizeProtocolAddress(input: string): ProtocolAddressNormalization {
  const trimmed = input.trim();
  if (!trimmed.startsWith("@")) return { outcome: "invalid" };
  const colon = trimmed.indexOf(":", 1);
  if (colon <= 1) return { outcome: "invalid" };
  const rawType = trimmed.slice(1, colon).toLowerCase();
  const id = trimmed.slice(colon + 1).trim();
  if (!PROTOCOL_TYPE.test(rawType) || !UNKNOWN_IDENTIFIER.test(id)) return { outcome: "invalid" };

  const type = normalizeReferenceType(rawType);
  const definition = getReferenceTypeDefinition(type);
  if (definition && !isValidReferenceIdentifier(type, id)) return { outcome: "invalid" };
  const ref = createReferenceRef({ type, id });
  return {
    outcome: "valid",
    address: serializeReference(ref),
    type,
    id,
    knownType: !!definition,
  };
}

export function boundedReplayLimit(requested: number | undefined): number {
  if (requested === undefined) return ADDRESS_REPLAY_BATCH_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) throw new Error("Replay limit must be a positive integer");
  return Math.min(requested, ADDRESS_REPLAY_BATCH_LIMIT);
}
