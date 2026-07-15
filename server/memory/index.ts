export { documentStorage, DocumentStorage } from "./document-storage";
export type { WorkspaceDocCompat } from "./document-storage";
export { memoryStorage, computeContentHash, isSummaryStale, MemoryStorage } from "./memory-storage";
export { generateEmbedding, generateEmbeddings, isEmbeddingsAvailable, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embedding";
export { evaluateLinks, parseLinkResults } from "./graph-discovery";
export type { EvaluatedLink } from "./graph-discovery";
export { cosineSimilarity, walkGraph } from "./graph-walker";
export type { RankedEntry, WalkGraphOptions } from "./graph-walker";
export { searchVnextMemory } from "./vnext-search";
export type { VnextSearchOptions, VnextSearchResult, VnextSearchResponse } from "./vnext-search";
export { registerMemoryListener } from "./memory-listener";
export { registerMemoryRoutes } from "./memory-routes";
export { registerMigrationRoutes } from "./migration-routes";
export { MEMORY_THRESHOLDS, checkThresholds, tryMergeWithExistingMid } from "./memory-transitions";
export {
  getMyelinationStatus,
  startMyelinationBackground,
  generateTitleSummaryTags,
  runMemoryEnrichment,
} from "./memory-enrichment";
export type { MyelinationProgress, MyelinationResult } from "./memory-enrichment";
export {
  estimateShortTermTokens,
  getThresholds,
  setThresholds,
  isConsolidating,
  notifyNewEntry,
  getConsolidationStatus,
  runConsolidation,
  runAgeBasedConsolidation,
  runStageOneAdvancementSweep,
  estimateMidTermTokens,
  getIntegrationThresholds,
  setIntegrationThresholds,
  isIntegrating,
  notifyNewMidEntry,
  getIntegrationStatus,
  promoteEntryToLong,
  checkMidThreshold,
  runIntegration,
  getGraphMyelinationStatus,
  runGraphEnrichment,
} from "./consolidation";
export type { ConsolidationThresholds, ConsolidationStatus, IntegrationThresholds, IntegrationStatus, GraphMyelinationStatus } from "./consolidation";
