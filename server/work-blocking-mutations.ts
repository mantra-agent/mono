/**
 * Work-mutation convenience for the universal blocked_by protocol
 * (`shared/blocked-by-protocol.ts`, PLANNING.md). Projects additive
 * prerequisites into the Core blocking graph only — never a domain-row
 * dependency array.
 */
import { blockingGraphService } from "./blocking-graph-service";

export type BlockingMutationInput = {
  blockedBy?: string[];
};

/** Additive graph projection for a work mutation. Domain rows remain the source of truth. */
export async function addBlockedByReferences(
  sourceAddress: string,
  input: BlockingMutationInput | undefined,
): Promise<void> {
  if (!input?.blockedBy || input.blockedBy.length === 0) return;
  for (const targetAddress of input.blockedBy) {
    const normalized = targetAddress.trim();
    if (!normalized) continue;
    await blockingGraphService.createBlockedBy({
      sourceAddress,
      targetAddress: normalized,
      idempotencyKey: `work-blocked-by:${sourceAddress}:${normalized}`,
    });
  }
}
