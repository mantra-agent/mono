import { eq, inArray } from "drizzle-orm";
import {
  memoryVnextClaims,
  memoryVnextExposures,
  memoryVnextStrengthEvents,
  type MemoryVnextStrengthEvent,
  type MemoryVnextStrengthEventType,
} from "@shared/schema";
import { db } from "../db";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";

const log = createLogger("MemoryVnextSignals");

const MAX_SIGNAL_CLAIMS = 50;
const MAX_EVENT_KEY_LENGTH = 160;
const MAX_SOURCE_ID_LENGTH = 300;
const MAX_METADATA_BYTES = 4_096;

const claimScopeColumns = {
  scope: memoryVnextClaims.scope,
  ownerUserId: memoryVnextClaims.ownerUserId,
  accountId: memoryVnextClaims.accountId,
};

const exposureScopeColumns = {
  scope: memoryVnextExposures.scope,
  ownerUserId: memoryVnextExposures.ownerUserId,
  accountId: memoryVnextExposures.accountId,
};

const strengthEventScopeColumns = {
  scope: memoryVnextStrengthEvents.scope,
  ownerUserId: memoryVnextStrengthEvents.ownerUserId,
  accountId: memoryVnextStrengthEvents.accountId,
};

export const VNEXT_STRENGTH_EVENT_WEIGHTS: Readonly<Record<MemoryVnextStrengthEventType, number>> = {
  explicit_confirmation: 0.25,
  decision_use: 0.2,
  goal_relevance: 0.15,
  confirmed_recurrence: 0.15,
  contextual_importance: 0.1,
  correction: -0.2,
};

export interface RecordVnextStrengthEventInput {
  claimId: number;
  eventType: MemoryVnextStrengthEventType;
  eventKey: string;
  sourceType: string;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface RecordVnextStrengthEventResult {
  outcome: "recorded" | "replayed";
  event: MemoryVnextStrengthEvent | null;
  weight: number;
}

function requireUserPrincipal() {
  const principal = getCurrentPrincipalOrSystem();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("vNext signal mutation requires an owning user principal");
  }
  return principal;
}

function normalizeIdentifier(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return normalized;
}

function boundedClaimIds(ids: number[]): number[] {
  const normalized = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  if (normalized.length > MAX_SIGNAL_CLAIMS) {
    throw new Error(`vNext signal mutation exceeds ${MAX_SIGNAL_CLAIMS} claims`);
  }
  return normalized;
}

export class MemoryVnextSignalStorage {
  async recordContextExposure(
    claimIds: number[],
    contextBuildId: string,
    source: "fresh" | "cache",
  ): Promise<{ requested: number; eligible: number; recorded: number; replayed: number }> {
    const principal = requireUserPrincipal();
    const ids = boundedClaimIds(claimIds);
    if (ids.length === 0) return { requested: 0, eligible: 0, recorded: 0, replayed: 0 };
    const buildId = normalizeIdentifier(contextBuildId, "contextBuildId", MAX_EVENT_KEY_LENGTH);

    const writableClaims = await db
      .select({ id: memoryVnextClaims.id })
      .from(memoryVnextClaims)
      .where(combineWithWritableScope(principal, claimScopeColumns, inArray(memoryVnextClaims.id, ids)));

    const inserted = writableClaims.length === 0
      ? []
      : await db
          .insert(memoryVnextExposures)
          .values(writableClaims.map(({ id }) => ({
            claimId: id,
            contextBuildId: buildId,
            source,
            ...ownedInsertValues(principal, exposureScopeColumns),
            createdByUserId: principal.userId,
          })))
          .onConflictDoNothing()
          .returning({ claimId: memoryVnextExposures.claimId });

    const outcome = {
      requested: ids.length,
      eligible: writableClaims.length,
      recorded: inserted.length,
      replayed: writableClaims.length - inserted.length,
    };
    log.debug(JSON.stringify({
      event: "memory.vnext.context_exposure_settled",
      contextBuildId: buildId,
      source,
      ...outcome,
      strengthDelta: 0,
      certaintyDelta: 0,
    }));
    return outcome;
  }

  async recordStrengthEvent(input: RecordVnextStrengthEventInput): Promise<RecordVnextStrengthEventResult> {
    const principal = requireUserPrincipal();
    if (!Number.isInteger(input.claimId) || input.claimId <= 0) throw new Error("claimId must be a positive integer");
    const rawEventKey = normalizeIdentifier(input.eventKey, "eventKey", MAX_EVENT_KEY_LENGTH);
    const eventKey = `claim:${input.claimId}:${rawEventKey}`;
    const sourceType = normalizeIdentifier(input.sourceType, "sourceType", 80);
    const sourceId = input.sourceId == null
      ? null
      : normalizeIdentifier(input.sourceId, "sourceId", MAX_SOURCE_ID_LENGTH);
    const weight = VNEXT_STRENGTH_EVENT_WEIGHTS[input.eventType];
    if (weight === undefined) throw new Error(`Unsupported vNext strength event type: ${input.eventType}`);
    const metadata = input.metadata ?? {};
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) {
      throw new Error(`vNext strength event metadata exceeds ${MAX_METADATA_BYTES} bytes`);
    }

    const [claim] = await db
      .select({ id: memoryVnextClaims.id })
      .from(memoryVnextClaims)
      .where(combineWithWritableScope(principal, claimScopeColumns, eq(memoryVnextClaims.id, input.claimId)))
      .limit(1);
    if (!claim) throw new Error(`vNext claim ${input.claimId} not found or not writable`);

    const [event] = await db
      .insert(memoryVnextStrengthEvents)
      .values({
        claimId: input.claimId,
        eventType: input.eventType,
        eventKey,
        weight,
        sourceType,
        sourceId,
        metadata,
        ...ownedInsertValues(principal, strengthEventScopeColumns),
        createdByUserId: principal.userId,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .onConflictDoNothing()
      .returning();

    const outcome = event ? "recorded" : "replayed";
    log[event ? "info" : "debug"](JSON.stringify({
      event: `memory.vnext.strength_event_${outcome}`,
      claimId: input.claimId,
      eventType: input.eventType,
      eventKey,
      sourceType,
      sourceId,
      weight,
    }));
    return { outcome, event: event ?? null, weight };
  }
}

export const memoryVnextSignalStorage = new MemoryVnextSignalStorage();
