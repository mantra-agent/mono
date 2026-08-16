import { createHash } from "crypto";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import type { Principal } from "./principal";
import {
  addressLinks,
  referenceOccurrences,
  referenceOccurrenceSources,
  type AddressLinkRow,
  type ReferenceOccurrenceRow,
} from "@shared/schema";
import {
  ADDRESS_LINK_BATCH_LIMIT,
  boundedReplayLimit,
  normalizeProtocolAddress,
  REFERENCE_OCCURRENCE_INSERT_BATCH_LIMIT,
  REFERENCE_OCCURRENCE_SOURCE_LIMIT,
  type AddressLink,
  type AddressReplayPage,
  type OccurrenceReplaceResult,
  type ReferenceLocation,
} from "@shared/life-addressing";
import { resolveAddressBatch } from "./address-resolver";
import {
  acquireAdvisoryTransactionLock,
  ADVISORY_LOCK_NS,
  db,
  getAmbientDatabaseTransaction,
  runWithDatabaseTransaction,
} from "./db";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";
import { createLogger } from "./log";

const log = createLogger("LifeAddressing");
const sourceScope = {
  scope: referenceOccurrenceSources.scope,
  ownerUserId: referenceOccurrenceSources.ownerUserId,
  accountId: referenceOccurrenceSources.accountId,
};
const occurrenceScope = {
  scope: referenceOccurrences.scope,
  ownerUserId: referenceOccurrences.ownerUserId,
  accountId: referenceOccurrences.accountId,
};
const linkScope = {
  scope: addressLinks.scope,
  ownerUserId: addressLinks.ownerUserId,
  accountId: addressLinks.accountId,
};

const PREDICATE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

export interface ReferenceOccurrenceInput {
  targetAddress: string;
  location?: ReferenceLocation;
}

export interface ReplaceReferenceOccurrencesInput {
  sourceAddress: string;
  sourceRevision: string;
  observedAt: Date;
  occurrences: readonly ReferenceOccurrenceInput[];
}

export interface CreateAddressLinkInput {
  sourceAddress: string;
  predicate: string;
  targetAddress: string;
  provenanceAddress?: string;
  createdBy: string;
  idempotencyKey: string;
}

export interface ListOccurrenceInput {
  sourceAddress?: string;
  targetAddress?: string;
  cursor?: string;
  limit?: number;
}

export interface ListAddressLinkInput {
  sourceAddress?: string;
  targetAddress?: string;
  /** Restrict to these predicates (validated lowercase snake_case). Enables bounded predicate-scoped scans. */
  predicates?: readonly string[];
  lifecycle?: "active" | "retired";
  cursor?: string;
  limit?: number;
}

function requireUserPrincipal(principal: Principal): asserts principal is Principal & { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw Object.assign(new Error("Life Addressing storage requires an authenticated user principal"), { status: 401 });
  }
}

function boundedText(value: string, max: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw Object.assign(new Error(`${label} must be 1-${max} characters`), { status: 400 });
  return normalized;
}

function normalizeAddress(value: string, label: string): string {
  const normalized = normalizeProtocolAddress(value);
  if (normalized.outcome !== "valid") throw Object.assign(new Error(`${label} must be a syntactically valid canonical address`), { status: 400 });
  return normalized.address;
}

function normalizeLocation(location: ReferenceLocation | undefined): ReferenceLocation | undefined {
  if (!location) return undefined;
  const blockId = location.blockId?.trim();
  if (blockId && blockId.length > 200) throw Object.assign(new Error("Reference blockId exceeds 200 characters"), { status: 400 });
  for (const [label, value] of [["start", location.start], ["end", location.end]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw Object.assign(new Error(`Reference ${label} must be a non-negative integer`), { status: 400 });
  }
  if (location.start !== undefined && location.end !== undefined && location.end < location.start) {
    throw Object.assign(new Error("Reference end must be greater than or equal to start"), { status: 400 });
  }
  return {
    ...(blockId ? { blockId } : {}),
    ...(location.start !== undefined ? { start: location.start } : {}),
    ...(location.end !== undefined ? { end: location.end } : {}),
  };
}

function projectionHash(sourceRevision: string, targets: readonly { targetAddress: string; location?: ReferenceLocation }[]): string {
  return createHash("sha256").update(JSON.stringify({ sourceRevision, targets })).digest("hex");
}

function parseCursor(cursor: string | undefined): { observedAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
    const observedAt = new Date(String(parsed.at ?? ""));
    if (typeof parsed.id !== "string" || !parsed.id || Number.isNaN(observedAt.getTime())) throw new Error("invalid");
    return { observedAt, id: parsed.id };
  } catch {
    throw Object.assign(new Error("Invalid replay cursor"), { status: 400 });
  }
}

function encodeCursor(observedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: observedAt.toISOString(), id }), "utf8").toString("base64url");
}

function publicLink(row: AddressLinkRow): AddressLink {
  return {
    id: row.id,
    sourceAddress: row.sourceAddress,
    predicate: row.predicate,
    targetAddress: row.targetAddress,
    ...(row.provenanceAddress ? { provenanceAddress: row.provenanceAddress } : {}),
    createdBy: row.createdBy,
    lifecycle: row.lifecycle,
    createdAt: row.createdAt.toISOString(),
    ...(row.retiredAt ? { retiredAt: row.retiredAt.toISOString() } : {}),
  };
}

async function assertKnownVisibleEndpoints(principal: Principal, addresses: readonly string[]): Promise<string[]> {
  const unique = [...new Set(addresses)];
  const known = unique.filter(address => {
    const parsed = normalizeProtocolAddress(address);
    return parsed.outcome === "valid" && parsed.knownType;
  });
  if (known.length === 0) return [...addresses];
  const results = await resolveAddressBatch(principal, known);
  const canonical = new Map<string, string>();
  for (const result of results) {
    if (result.outcome !== "resolved" && result.outcome !== "redirected") {
      throw Object.assign(new Error("Address link endpoint is not visible"), { status: 404 });
    }
    canonical.set(result.requestedAddress, result.resolution?.address ?? result.redirectAddress ?? result.requestedAddress);
  }
  return addresses.map(address => canonical.get(address) ?? address);
}

export async function replaceReferenceOccurrences(
  principal: Principal,
  input: ReplaceReferenceOccurrencesInput,
): Promise<OccurrenceReplaceResult> {
  requireUserPrincipal(principal);
  const sourceAddress = normalizeAddress(input.sourceAddress, "sourceAddress");
  const sourceRevision = boundedText(input.sourceRevision, 200, "sourceRevision");
  if (!(input.observedAt instanceof Date) || Number.isNaN(input.observedAt.getTime())) throw Object.assign(new Error("observedAt must be a valid Date"), { status: 400 });
  if (input.occurrences.length > REFERENCE_OCCURRENCE_SOURCE_LIMIT) throw Object.assign(new Error(`Too many occurrences (max ${REFERENCE_OCCURRENCE_SOURCE_LIMIT})`), { status: 400 });

  const normalized = input.occurrences.map(item => ({
    targetAddress: normalizeAddress(item.targetAddress, "targetAddress"),
    location: normalizeLocation(item.location),
  }));
  const hash = projectionHash(sourceRevision, normalized);

  return db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.REFERENCE_OCCURRENCES, `${principal.accountId}:${sourceAddress}`);
    const [existing] = await tx.select().from(referenceOccurrenceSources)
      .where(combineWithWritableScope(principal, sourceScope, eq(referenceOccurrenceSources.sourceAddress, sourceAddress)))
      .limit(1);
    if (existing?.sourceRevision === sourceRevision) {
      if (existing.projectionHash !== hash) {
        throw Object.assign(new Error("A source revision cannot name conflicting projection content"), { status: 409 });
      }
      if (input.observedAt.getTime() > existing.sourceObservedAt.getTime()) {
        await tx.update(referenceOccurrenceSources).set({
          sourceObservedAt: input.observedAt,
          indexedAt: new Date(),
          updatedByUserId: principal.userId,
        }).where(combineWithWritableScope(principal, sourceScope, eq(referenceOccurrenceSources.id, existing.id)));
      }
      return { outcome: "unchanged", sourceAddress, sourceRevision, occurrenceCount: existing.occurrenceCount };
    }
    if (existing && existing.sourceObservedAt.getTime() > input.observedAt.getTime()) {
      return { outcome: "stale", sourceAddress, sourceRevision: existing.sourceRevision, occurrenceCount: existing.occurrenceCount };
    }
    if (existing && existing.sourceObservedAt.getTime() === input.observedAt.getTime()) {
      throw Object.assign(new Error("Equal source observation time names conflicting projection content"), { status: 409 });
    }

    const ownership = ownedInsertValues(principal, sourceScope);
    const [source] = await tx.insert(referenceOccurrenceSources).values({
      sourceAddress,
      sourceRevision,
      sourceObservedAt: input.observedAt,
      projectionHash: hash,
      occurrenceCount: normalized.length,
      indexedAt: new Date(),
      ...ownership,
      createdByUserId: principal.userId,
      updatedByUserId: principal.userId,
    }).onConflictDoUpdate({
      target: [referenceOccurrenceSources.ownerUserId, referenceOccurrenceSources.accountId, referenceOccurrenceSources.sourceAddress],
      set: {
        sourceRevision,
        sourceObservedAt: input.observedAt,
        projectionHash: hash,
        occurrenceCount: normalized.length,
        indexedAt: new Date(),
        updatedByUserId: principal.userId,
      },
    }).returning();
    if (!source) throw new Error("Reference occurrence source upsert failed");

    await tx.delete(referenceOccurrences).where(combineWithWritableScope(
      principal,
      occurrenceScope,
      eq(referenceOccurrences.sourceProjectionId, source.id),
    ));
    if (normalized.length > 0) {
      const occurrenceOwnership = ownedInsertValues(principal, occurrenceScope);
      for (let ordinalOffset = 0; ordinalOffset < normalized.length; ordinalOffset += REFERENCE_OCCURRENCE_INSERT_BATCH_LIMIT) {
        const batch = normalized.slice(ordinalOffset, ordinalOffset + REFERENCE_OCCURRENCE_INSERT_BATCH_LIMIT);
        await tx.insert(referenceOccurrences).values(batch.map((item, batchOrdinal) => ({
          sourceProjectionId: source.id,
          sourceAddress,
          sourceRevision,
          occurrenceOrdinal: ordinalOffset + batchOrdinal,
          targetAddress: item.targetAddress,
          locationBlockId: item.location?.blockId ?? null,
          locationStart: item.location?.start ?? null,
          locationEnd: item.location?.end ?? null,
          origin: "embedded" as const,
          observedAt: input.observedAt,
          ...occurrenceOwnership,
          createdByUserId: principal.userId,
        })));
      }
    }
    return { outcome: "replaced", sourceAddress, sourceRevision, occurrenceCount: normalized.length };
  }));
}

export async function listReferenceOccurrences(
  principal: Principal,
  input: ListOccurrenceInput = {},
): Promise<AddressReplayPage<ReferenceOccurrenceRow>> {
  requireUserPrincipal(principal);
  const limit = boundedReplayLimit(input.limit);
  const cursor = parseCursor(input.cursor);
  const filters = [
    input.sourceAddress ? eq(referenceOccurrences.sourceAddress, normalizeAddress(input.sourceAddress, "sourceAddress")) : undefined,
    input.targetAddress ? eq(referenceOccurrences.targetAddress, normalizeAddress(input.targetAddress, "targetAddress")) : undefined,
    cursor ? or(gt(referenceOccurrences.observedAt, cursor.observedAt), and(eq(referenceOccurrences.observedAt, cursor.observedAt), gt(referenceOccurrences.id, cursor.id))) : undefined,
  ].filter(Boolean);
  const rows = await db.select().from(referenceOccurrences)
    .where(combineWithVisibleScope(principal, occurrenceScope, filters.length ? and(...filters) : undefined))
    .orderBy(asc(referenceOccurrences.observedAt), asc(referenceOccurrences.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.observedAt, last.id) } : {}),
  };
}

export async function createAddressLink(principal: Principal, input: CreateAddressLinkInput): Promise<AddressLink> {
  requireUserPrincipal(principal);
  const sourceAddress = normalizeAddress(input.sourceAddress, "sourceAddress");
  const targetAddress = normalizeAddress(input.targetAddress, "targetAddress");
  const provenanceAddress = input.provenanceAddress ? normalizeAddress(input.provenanceAddress, "provenanceAddress") : undefined;
  const predicate = boundedText(input.predicate, 80, "predicate").toLowerCase();
  if (!PREDICATE_PATTERN.test(predicate)) throw Object.assign(new Error("predicate must be lowercase snake_case"), { status: 400 });
  const createdBy = boundedText(input.createdBy, 200, "createdBy");
  const idempotencyKey = boundedText(input.idempotencyKey, 200, "idempotencyKey");
  const visible = await assertKnownVisibleEndpoints(principal, [sourceAddress, targetAddress, ...(provenanceAddress ? [provenanceAddress] : [])]);
  const [canonicalSource, canonicalTarget, canonicalProvenance] = visible;
  if (canonicalSource === canonicalTarget) throw Object.assign(new Error("Address link cannot target itself"), { status: 400 });

  const writeLink = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    // Serialize both key-replay and active-relationship uniqueness under one
    // account-scoped lock order so concurrent producers with different
    // idempotency keys cannot insert duplicate active edges.
    const relationshipLockKey = `${principal.accountId}:${canonicalSource}:${predicate}:${canonicalTarget}`;
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.ADDRESS_LINK, relationshipLockKey);
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.ADDRESS_LINK, `${principal.accountId}:${idempotencyKey}`);

    const [existingByKey] = await tx.select().from(addressLinks)
      .where(combineWithWritableScope(principal, linkScope, eq(addressLinks.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existingByKey) {
      const same = existingByKey.sourceAddress === canonicalSource
        && existingByKey.targetAddress === canonicalTarget
        && existingByKey.predicate === predicate
        && (existingByKey.provenanceAddress ?? undefined) === canonicalProvenance
        && existingByKey.createdBy === createdBy;
      if (!same) throw Object.assign(new Error("idempotencyKey already names a different address link"), { status: 409 });
      return publicLink(existingByKey);
    }

    const [existingActive] = await tx.select().from(addressLinks)
      .where(combineWithWritableScope(
        principal,
        linkScope,
        and(
          eq(addressLinks.sourceAddress, canonicalSource),
          eq(addressLinks.predicate, predicate),
          eq(addressLinks.targetAddress, canonicalTarget),
          eq(addressLinks.lifecycle, "active"),
        ),
      ))
      .orderBy(asc(addressLinks.createdAt), asc(addressLinks.id))
      .limit(1);
    if (existingActive) {
      log.info(JSON.stringify({
        event: "life_addressing.address_link_reused_active_relationship",
        linkId: existingActive.id,
        predicate,
        idempotencyKey,
      }));
      return publicLink(existingActive);
    }

    try {
      const [created] = await tx.insert(addressLinks).values({
        sourceAddress: canonicalSource,
        predicate,
        targetAddress: canonicalTarget,
        provenanceAddress: canonicalProvenance ?? null,
        createdBy,
        idempotencyKey,
        lifecycle: "active",
        ...ownedInsertValues(principal, linkScope),
        createdByUserId: principal.userId,
        updatedByUserId: principal.userId,
      }).returning();
      if (!created) throw new Error("Address link creation failed");
      log.info(JSON.stringify({ event: "life_addressing.address_link_created", linkId: created.id, predicate }));
      return publicLink(created);
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
      const message = error instanceof Error ? error.message : String(error);
      const isActiveRelationshipDuplicate = code === "23505"
        && /uk_address_links_active_relationship|duplicate key value/i.test(message);
      if (!isActiveRelationshipDuplicate) throw error;
      const [raced] = await tx.select().from(addressLinks)
        .where(combineWithWritableScope(
          principal,
          linkScope,
          and(
            eq(addressLinks.sourceAddress, canonicalSource),
            eq(addressLinks.predicate, predicate),
            eq(addressLinks.targetAddress, canonicalTarget),
            eq(addressLinks.lifecycle, "active"),
          ),
        ))
        .orderBy(asc(addressLinks.createdAt), asc(addressLinks.id))
        .limit(1);
      if (!raced) throw error;
      log.info(JSON.stringify({
        event: "life_addressing.address_link_race_reused_active_relationship",
        linkId: raced.id,
        predicate,
        idempotencyKey,
      }));
      return publicLink(raced);
    }
  };

  // Reuse ambient business transaction (e.g. recordJudgment) instead of nesting db.transaction.
  const ambient = getAmbientDatabaseTransaction();
  if (ambient) return writeLink(ambient);
  return db.transaction(async tx => runWithDatabaseTransaction(tx, async () => writeLink(tx)));
}

export async function retireAddressLink(principal: Principal, id: string): Promise<AddressLink> {
  requireUserPrincipal(principal);
  const linkId = boundedText(id, 100, "linkId");
  return db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.ADDRESS_LINK, `${principal.accountId}:${linkId}`);
    const [existing] = await tx.select().from(addressLinks)
      .where(combineWithWritableScope(principal, linkScope, eq(addressLinks.id, linkId)))
      .limit(1);
    if (!existing) throw Object.assign(new Error("Address link not found"), { status: 404 });
    if (existing.lifecycle === "retired") return publicLink(existing);
    const retiredAt = new Date();
    const [retired] = await tx.update(addressLinks).set({
      lifecycle: "retired",
      retiredAt,
      updatedByUserId: principal.userId,
    }).where(combineWithWritableScope(principal, linkScope, and(eq(addressLinks.id, linkId), eq(addressLinks.lifecycle, "active"))))
      .returning();
    if (!retired) throw Object.assign(new Error("Address link changed concurrently"), { status: 409 });
    log.info(JSON.stringify({ event: "life_addressing.address_link_retired", linkId }));
    return publicLink(retired);
  }));
}

export async function listAddressLinks(
  principal: Principal,
  input: ListAddressLinkInput = {},
): Promise<AddressReplayPage<AddressLink>> {
  requireUserPrincipal(principal);
  const limit = Math.min(boundedReplayLimit(input.limit), ADDRESS_LINK_BATCH_LIMIT);
  const cursor = parseCursor(input.cursor);
  const predicateFilter = input.predicates
    ? input.predicates.map((value) => value.toLowerCase()).filter((value) => PREDICATE_PATTERN.test(value))
    : undefined;
  const filters = [
    input.sourceAddress ? eq(addressLinks.sourceAddress, normalizeAddress(input.sourceAddress, "sourceAddress")) : undefined,
    input.targetAddress ? eq(addressLinks.targetAddress, normalizeAddress(input.targetAddress, "targetAddress")) : undefined,
    predicateFilter ? inArray(addressLinks.predicate, predicateFilter) : undefined,
    input.lifecycle ? eq(addressLinks.lifecycle, input.lifecycle) : undefined,
    cursor ? or(gt(addressLinks.createdAt, cursor.observedAt), and(eq(addressLinks.createdAt, cursor.observedAt), gt(addressLinks.id, cursor.id))) : undefined,
  ].filter(Boolean);
  const rows = await db.select().from(addressLinks)
    .where(combineWithVisibleScope(principal, linkScope, filters.length ? and(...filters) : undefined))
    .orderBy(asc(addressLinks.createdAt), asc(addressLinks.id))
    .limit(limit + 1);
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(publicLink),
    ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.createdAt, last.id) } : {}),
  };
}

export async function listReferenceSourceReplayPage(
  principal: Principal,
  input: { cursor?: string; limit?: number } = {},
): Promise<AddressReplayPage<{ sourceAddress: string; sourceRevision: string; sourceObservedAt: string }>> {
  requireUserPrincipal(principal);
  const limit = boundedReplayLimit(input.limit);
  const cursor = parseCursor(input.cursor);
  const rows = await db.select({
    id: referenceOccurrenceSources.id,
    sourceAddress: referenceOccurrenceSources.sourceAddress,
    sourceRevision: referenceOccurrenceSources.sourceRevision,
    sourceObservedAt: referenceOccurrenceSources.sourceObservedAt,
  }).from(referenceOccurrenceSources)
    .where(combineWithVisibleScope(principal, sourceScope, cursor
      ? or(gt(referenceOccurrenceSources.sourceObservedAt, cursor.observedAt), and(eq(referenceOccurrenceSources.sourceObservedAt, cursor.observedAt), gt(referenceOccurrenceSources.id, cursor.id)))
      : undefined))
    .orderBy(asc(referenceOccurrenceSources.sourceObservedAt), asc(referenceOccurrenceSources.id))
    .limit(limit + 1);
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(row => ({ ...row, sourceObservedAt: row.sourceObservedAt.toISOString() })),
    ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.sourceObservedAt, last.id) } : {}),
  };
}
