import { createLogger } from "../log";

const log = createLogger("MemoryLinkScheduling");

export async function scheduleMemoryLinks(entryId: number): Promise<void> {
  const { memoryStorage } = await import("./memory-storage");

  const candidates = await memoryStorage.findSimilarEntries(entryId, 5, {
    layers: ["long", "mid"],
    excludeIds: new Set([entryId]),
  });

  const eligibleCandidates = candidates.filter(
    (candidate) => ((candidate as { similarity?: number }).similarity ?? 0) >= 0.88,
  );

  if (eligibleCandidates.length === 0) {
    log.debug(`No high-confidence semantic link targets for memory #${entryId}`);
    return;
  }

  for (const candidate of eligibleCandidates) {
    await memoryStorage.createLink(
      entryId,
      candidate.entry.id,
      "high_confidence_semantic_neighbor",
      (candidate as { similarity?: number }).similarity ?? 0.88,
      "related",
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`scheduleMemoryLinks insert failed: ${message}`);
    });
  }
}
