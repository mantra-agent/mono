/**
 * BlockingGraphService — Core-owned specialization of address_links for the
 * single blocked_by prerequisite predicate.
 *
 * Domain objects remain authoritative in their own stores. This service owns
 * only the deliberate edge, its lifecycle, principal scoping, cycle rejection,
 * and relationship-level idempotency. Generic address_links supplies endpoint
 * visibility, idempotency keys, advisory locks, and retirement.
 *
 * The partial unique index uk_address_links_active_relationship is the
 * concurrency backstop for one active (owner, account, source, predicate,
 * target) tuple. Fresh idempotency keys allow retire-then-readd.
 */
import { randomBytes } from "crypto";
import type { AddressLink, AddressReplayPage } from "@shared/life-addressing";
import { normalizeProtocolAddress } from "@shared/life-addressing";
import {
  acquireAdvisoryTransactionLock,
  ADVISORY_LOCK_NS,
  db,
  runWithDatabaseTransaction,
} from "./db";
import {
  createAddressLink,
  listAddressLinks,
  retireAddressLink,
} from "./life-addressing-storage";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { requireCurrentUserPrincipal } from "./principal-context";

export const BLOCKED_BY_PREDICATE = "blocked_by" as const;

const MAX_LINK_PAGES = 20;
const MAX_CYCLE_NODES = 500;
const PROJECTION_CAP = 2_000;

const log = createLogger("BlockingGraph");

export type BlockingEdge = AddressLink & { predicate: typeof BLOCKED_BY_PREDICATE };

export interface CreateBlockedByInput {
  sourceAddress: string;
  targetAddress: string;
  idempotencyKey: string;
  provenanceAddress?: string;
}

export interface ListBlockedByInput {
  sourceAddress?: string;
  targetAddress?: string;
  lifecycle?: "active" | "retired";
  cursor?: string;
  limit?: number;
}

function requireAddress(value: string, label: string): string {
  const normalized = normalizeProtocolAddress(value);
  if (normalized.outcome !== "valid") {
    throw Object.assign(new Error(`${label} must be a syntactically valid canonical address`), { status: 400 });
  }
  return normalized.address;
}

function asEdge(link: AddressLink): BlockingEdge {
  if (link.predicate !== BLOCKED_BY_PREDICATE) {
    throw new Error("Blocking graph link produced an unexpected predicate");
  }
  return link as BlockingEdge;
}

function uniqueViolation(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "23505" || /uk_address_links_active_relationship|duplicate key value/i.test(message);
}

async function listBlockedByPage(
  principal: Principal,
  input: ListBlockedByInput,
): Promise<AddressReplayPage<BlockingEdge>> {
  const page = await listAddressLinks(principal, {
    sourceAddress: input.sourceAddress,
    targetAddress: input.targetAddress,
    predicates: [BLOCKED_BY_PREDICATE],
    lifecycle: input.lifecycle,
    cursor: input.cursor,
    limit: input.limit,
  });
  return {
    items: page.items.map(asEdge),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

async function findActiveEdge(
  principal: Principal,
  sourceAddress: string,
  targetAddress: string,
): Promise<BlockingEdge | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LINK_PAGES; page++) {
    const result = await listBlockedByPage(principal, {
      sourceAddress,
      lifecycle: "active",
      cursor,
    });
    const found = result.items.find((edge) => edge.targetAddress === targetAddress);
    if (found) return found;
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return undefined;
}

/**
 * Walk active blockers starting at `start`. Reject when `sought` is reachable,
 * which would close a directed cycle after inserting start <- sought.
 */
async function wouldCreateCycle(
  principal: Principal,
  start: string,
  sought: string,
): Promise<boolean> {
  const queue = [start];
  const seen = new Set<string>();

  while (queue.length > 0) {
    if (seen.size >= MAX_CYCLE_NODES) {
      throw Object.assign(new Error("Blocking graph traversal exceeded its safety bound"), { status: 409 });
    }
    const current = queue.shift()!;
    if (current === sought) return true;
    if (seen.has(current)) continue;
    seen.add(current);

    let cursor: string | undefined;
    for (let page = 0; page < MAX_LINK_PAGES; page++) {
      const result = await listBlockedByPage(principal, {
        sourceAddress: current,
        lifecycle: "active",
        cursor,
      });
      for (const edge of result.items) {
        if (!seen.has(edge.targetAddress)) queue.push(edge.targetAddress);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
  }

  return false;
}

export class BlockingGraphService {
  async createBlockedBy(input: CreateBlockedByInput): Promise<BlockingEdge> {
    const principal = requireCurrentUserPrincipal();
    const sourceAddress = requireAddress(input.sourceAddress, "sourceAddress");
    const targetAddress = requireAddress(input.targetAddress, "targetAddress");
    const provenanceAddress = input.provenanceAddress
      ? requireAddress(input.provenanceAddress, "provenanceAddress")
      : undefined;
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey) {
      throw Object.assign(new Error("idempotencyKey is required"), { status: 400 });
    }

    const existing = await findActiveEdge(principal, sourceAddress, targetAddress);
    if (existing) return existing;

    try {
      return await db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
        await acquireAdvisoryTransactionLock(
          tx,
          ADVISORY_LOCK_NS.ADDRESS_LINK,
          `${principal.accountId}:blocked_by:${sourceAddress}:${targetAddress}`,
        );

        const lockedExisting = await findActiveEdge(principal, sourceAddress, targetAddress);
        if (lockedExisting) return lockedExisting;

        if (await wouldCreateCycle(principal, targetAddress, sourceAddress)) {
          throw Object.assign(new Error("Blocking edge would introduce a cycle"), { status: 409 });
        }

        const created = await createAddressLink(principal, {
          sourceAddress,
          predicate: BLOCKED_BY_PREDICATE,
          targetAddress,
          ...(provenanceAddress ? { provenanceAddress } : {}),
          createdBy: "blocking_graph",
          idempotencyKey,
        });
        const edge = asEdge(created);
        log.info(JSON.stringify({
          event: "blocking_graph.created",
          linkId: edge.id,
          sourceAddress,
          targetAddress,
        }));
        return edge;
      }));
    } catch (error) {
      if (uniqueViolation(error)) {
        const raced = await findActiveEdge(principal, sourceAddress, targetAddress);
        if (raced) return raced;
      }
      throw error;
    }
  }

  async listBlockers(input: { sourceAddress: string; lifecycle?: "active" | "retired"; cursor?: string; limit?: number }): Promise<AddressReplayPage<BlockingEdge>> {
    const principal = requireCurrentUserPrincipal();
    const sourceAddress = requireAddress(input.sourceAddress, "sourceAddress");
    return listBlockedByPage(principal, {
      sourceAddress,
      lifecycle: input.lifecycle ?? "active",
      cursor: input.cursor,
      limit: input.limit,
    });
  }

  async listBlockedItems(input: { targetAddress: string; lifecycle?: "active" | "retired"; cursor?: string; limit?: number }): Promise<AddressReplayPage<BlockingEdge>> {
    const principal = requireCurrentUserPrincipal();
    const targetAddress = requireAddress(input.targetAddress, "targetAddress");
    return listBlockedByPage(principal, {
      targetAddress,
      lifecycle: input.lifecycle ?? "active",
      cursor: input.cursor,
      limit: input.limit,
    });
  }

  async retireBlockedBy(input: { sourceAddress: string; linkId: string }): Promise<BlockingEdge> {
    const principal = requireCurrentUserPrincipal();
    const sourceAddress = requireAddress(input.sourceAddress, "sourceAddress");
    const linkId = input.linkId?.trim();
    if (!linkId) throw Object.assign(new Error("linkId is required"), { status: 400 });

    let cursor: string | undefined;
    let owned: BlockingEdge | undefined;
    for (let page = 0; page < MAX_LINK_PAGES; page++) {
      const result = await listBlockedByPage(principal, {
        sourceAddress,
        lifecycle: "active",
        cursor,
      });
      owned = result.items.find((edge) => edge.id === linkId);
      if (owned) break;
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    if (!owned) {
      throw Object.assign(new Error("Blocking link not found for source"), { status: 404 });
    }

    const retired = asEdge(await retireAddressLink(principal, linkId));
    log.info(JSON.stringify({
      event: "blocking_graph.retired",
      linkId,
      sourceAddress,
    }));
    return retired;
  }

  /**
   * Bounded scan of active blocked_by edges for graph projection. Predicate-
   * filtered at the DB layer and hard-capped so a large ledger cannot unbound
   * a foreground graph read.
   */
  async listActiveForProjection(cap = PROJECTION_CAP): Promise<BlockingEdge[]> {
    const principal = requireCurrentUserPrincipal();
    const collected: BlockingEdge[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LINK_PAGES; page++) {
      const result = await listBlockedByPage(principal, {
        lifecycle: "active",
        cursor,
      });
      for (const edge of result.items) {
        collected.push(edge);
        if (collected.length >= cap) return collected;
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return collected;
  }
}

export const blockingGraphService = new BlockingGraphService();

/** Fresh key helper for callers that intentionally create a new assertion. */
export function newBlockingIdempotencyKey(): string {
  return `blocked_by:${randomBytes(12).toString("hex")}`;
}
